import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {hash,validateDraft} from '../src/server/domain';
import {extractBenefitClaims,benefitTime} from '../src/server/benefit-rules';
import {analyzeBenefitEvidence} from '../src/server/benefit-analysis';
import {buildAutomaticTemplate,needsSemanticReview} from '../src/server/automatic-content';
import {isMissingDeadlineConflict} from '../src/server/service';
import {gatherEvidenceContext} from '../src/server/source-context';
import type {Evidence,PublicData,ActionKind,ActionStage,Publication,Candidate,RadarEvent,Article} from '../src/lib/types';
const require=createRequire(import.meta.url);
const {selectedHomeStatus}=require('../miniprogram/utils/home-reset-status');
const {statusPosterInput,statusPosterAvailable}=require('../miniprogram/packages/poster/status-poster');
const at='2026-11-01T00:00:00.000Z',day=86400000;
function post(text:string):Evidence{return{id:'proof',messageId:'2117000000000000000',sourceId:'tibo-public',url:'https://x.com/thsottiaux/status/2117000000000000000',text,hash:hash(text),publishedAt:at,collectedAt:at,contextComplete:true,historical:false,provenance:'archive',textOrigin:'original',metadata:{sourceGroup:'fxembed:thsottiaux'}};}
test('separate a real delivery deadline from synthetic validity metadata without inventing card policy',()=>{
 for(const text of ['We will grant a banked reset to all paid users within 6 hours, valid for 7 days.','We will reset usage limits for all paid users within 6 hours, and this promotion is valid for 7 days.']){
  const p=post(text),context=gatherEvidenceContext(p,[p]),draft=buildAutomaticTemplate(context)!;
  assert.equal(draft.actions[0]?.expectedAt,'2026-11-01T06:00:00.000Z');
  assert.deepEqual(validateDraft(draft,[p],true),[]);
  assert.equal(analyzeBenefitEvidence(p,context).unresolved.length,0);
 }
 assert.equal(benefitTime('A banked reset is valid for 7 days.',at).expectedAt,undefined);
});
test('a neutral inventory location does not erase an explicit grant; use, purchase, negation and private balances stay excluded',()=>{
 const p=post('We have granted a banked reset to all paid users, available in their inventory.');
 const draft=buildAutomaticTemplate([p])!;assert.equal(draft?.actions[0]?.stage,'claimed_complete');assert.deepEqual(validateDraft(draft,[p],true),[]);
 for(const text of ['You can purchase a banked reset in the store.','We have not granted a banked reset to all paid users, available in their inventory.','My account has a banked reset in inventory.','We will grant a banked reset if you purchase it.'])assert.equal(extractBenefitClaims(text,at).length,0,text);
});
test('ambiguous delivery time and unseen original wording remain pending instead of silently fully processed',()=>{
 const p=post('We will reset usage limits for all paid users before next festival.');
 const draft=buildAutomaticTemplate([p]);assert.equal(draft?.actions[0]?.expectedAt,undefined);
 assert.ok(analyzeBenefitEvidence(p,[p]).unresolved.length);assert.equal(needsSemanticReview(draft,[p]),true);
 const unknown=post('A surprise is on its way for our subscribers.');assert.equal(needsSemanticReview(undefined,[unknown]),true);
});
function fixture(kind:ActionKind='automatic_reset',now=at):PublicData {
 const data:PublicData={serverTime:now,events:[],articles:[],publications:[],evidence:[],sources:[],activities:[],notices:[],site:{name:'隔离测试',description:'',version:1,autoPublish:false}};
 add(data,'first',kind,'claimed_complete',at);return data;
}
function add(data:PublicData,id:string,kind:ActionKind,stage:ActionStage,time:string,expectedAt?:string){
 const action={id:'action-'+id,kind,stage,statementAt:time,expectedAt,scope:'public' as const,eligibility:'所有付费账户',evidenceIds:[]};
 const article={id:'article-'+id,eventId:'event-'+id,publicationId:'pub-'+id,title:id,summary:'事实',translation:'',category:'reset' as const,status:'published' as const,version:1,evidenceIds:[],publishedAt:time,updatedAt:time};
 const event={id:article.eventId,publicationId:article.publicationId,title:id,status:'published' as const,version:1,updatedAt:time,evidenceIds:[],actions:[action]};
 const p:Publication={id:article.publicationId,eventId:event.id,articleId:article.id,article,event,publishedAt:time,cutoffAt:time,reason:'隔离',mode:'state_change'};
 data.events.push(event);data.articles.push(article);data.publications.push(p);
}
const time=(n:number)=>new Date(Date.parse(at)+n*day).toISOString();
test('24h boundary, seven-day boundary and reopening derive from the same real reset without emitting completion',()=>{
 const d=fixture();const current=(n:number)=>selectedHomeStatus(d,'automatic_reset',time(n));
 assert.equal(current(1-1/86400).state,'completed');assert.equal(current(0).validUntil,time(1));
 assert.equal(current(1).state,'cycle');assert.equal(current(1).expectedAt,time(7));assert.equal(current(1).clockAt,at);
 assert.equal(current(6.99).state,'cycle');assert.equal(current(7).state,'cycle_due');assert.equal(current(9).state,'cycle_due');assert.equal(current(9).expectedAt,time(7));
 assert.equal(current(7).completedDisplay,false);assert.equal(current(7).evidenceType,'cycle');assert.equal(d.events.length,1);assert.equal(d.notices.length,0);
 d.serverTime=time(1);const old=statusPosterInput(d);assert.match(old.sourceLabel,/周期推算/);assert.equal(old.codePublicationId,'');assert.match(old.sharePath,/pages\/home/);
 d.serverTime=time(7);assert.equal(statusPosterAvailable(old,d),false);assert.match(statusPosterInput(d).title,/周期时间已到/);
});
test('new announcement replaces elapsed/cycle immediately; only new quota completion moves quota anchor',()=>{
 for(const n of [.1,3]){
  const d=fixture('automatic_reset',time(n));add(d,'next','automatic_reset','promised',time(n),time(n+1));
  const c=selectedHomeStatus(d,'automatic_reset');assert.equal(c.state,'scheduled');assert.equal(c.expectedAt,time(n+1));
 }
 const d=fixture('automatic_reset',time(3));add(d,'card','banked_reset','claimed_complete',time(2.5));assert.equal(selectedHomeStatus(d,'automatic_reset').expectedAt,time(7));
 add(d,'next','automatic_reset','claimed_complete',time(2));const c=selectedHomeStatus(d,'automatic_reset');assert.equal(c.state,'cycle');assert.equal(c.expectedAt,time(9));assert.equal(c.clockAt,time(2));
});
test('banked grants retain last-message date after 24h but never invent a seven-day distribution',()=>{
 const d=fixture('banked_reset',time(1));const c=selectedHomeStatus(d,'banked_reset');assert.equal(c.state,'waiting');assert.equal(c.expectedAt,'');assert.equal(c.timeAt,at);assert.equal(c.previousCompletion.publicationId,'pub-first');
 assert.equal(c.lastMessage.publicationId,'pub-first');assert.equal(statusPosterInput(d,'banked_reset').codePublicationId,'');
 add(d,'next','banked_reset','promised',time(1),time(1.25));assert.equal(selectedHomeStatus(d,'banked_reset').state,'scheduled');
});

test('an in-progress statement with an explicit deadline still counts down for both benefit kinds',()=>{
 for(const kind of ['automatic_reset','banked_reset'] as ActionKind[]){
  const d=fixture(kind,time(.1));add(d,'next',kind,'in_progress',time(.1),time(.2));
  const c=selectedHomeStatus(d,kind);assert.equal(c.state,'progress');assert.equal(c.hero.label,'距离预计完成时间');assert.ok(c.hero.parts.length);assert.equal(c.hero.metric,c.metric);
  const late=selectedHomeStatus(d,kind,time(.3));assert.equal(late.state,'overdue');assert.match(late.hero.description,/已宣布开始/);
 }
});

test('only a missing machine deadline conflict reopens; a changed deadline, manual edit or withdrawal stays protected',()=>{
 const p=post('We will reset usage limits for all paid users within 6 hours, and this promotion is valid for 7 days.'),template=buildAutomaticTemplate([p])!;
 const action={...template.actions[0],id:'existing',expectedAt:undefined,timeNote:'旧规则遗漏'};
 const event:RadarEvent={id:'event',publicationId:'old',title:'旧文章',status:'published',version:1,updatedAt:at,evidenceIds:[p.id],actions:[action]};
 const article:Article={...template,id:'article',eventId:event.id,publicationId:'old',status:'published',version:1,publishedAt:at,updatedAt:at};
 const c:Candidate={id:'candidate',evidenceId:p.id,version:1,status:'published',humanEdited:false,createdAt:at,updatedAt:at,reasons:['同一动作在相同声明时间出现不同事实，存在事实冲突'],content:template,automation:{state:'conflict',reasonCodes:[],dependencyIds:[]}};
 const check=(candidate=c,e=event,a=article)=>isMissingDeadlineConflict(candidate,template,e,a,p,[p]);
 assert.equal(check(),true);assert.equal(check({...c,humanEdited:true}),false);
 assert.equal(check(c,{...event,actions:[{...action,expectedAt:'2026-11-01T05:00:00Z'}]}),false);
 assert.equal(check(c,event,{...article,manualFields:['title']}),false);assert.equal(check(c,{...event,status:'withdrawn'}),false);
 assert.equal(check({...c,reasons:['其他真实事实冲突']}),false);
});
