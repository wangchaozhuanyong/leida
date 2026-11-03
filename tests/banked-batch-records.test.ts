import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {Evidence,PublicData,BenefitAction,Publication} from '../src/lib/types';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {gatherEvidenceContext} from '../src/server/source-context';
import {matchingBenefitActions} from '../src/server/benefit-signal';
import {publicActions,publicationSourceTime,publicationActions} from '../src/lib/public-facts';
import {noticeKey} from '../src/server/domain';
import {partitionAutomaticActions} from '../src/server/service';

const require=createRequire(import.meta.url),m=require('../miniprogram/utils/model.js');
const {recordCalendar}=require('../miniprogram/utils/record-calendar.js');
const {selectedHomeStatus}=require('../miniprogram/utils/home-reset-status.js');
const {posterInput,createPosterLayout}=require('../miniprogram/utils/poster.js');
const preview='2026-10-31T05:42:26.000Z',first='2026-11-01T00:43:20.000Z',second='2026-11-01T23:27:20.000Z';
const post=(id:string,text:string,at:string):Evidence=>({id,messageId:id,sourceId:'tibo-public',url:'https://x.com/thsottiaux/status/'+id,text,hash:id,publishedAt:at,collectedAt:at,contextComplete:true,textOrigin:'original',provenance:'archive',historical:false});
function fixture(lateFirst=false):PublicData {
 const evidence=[post('preview','Next two days will be banked resets.',preview),post('first','Banked 1/2',first),post('second','Day 28/ Banked 2/2',second)];
 const publications:Publication[]=[],actions:BenefitAction[]=[];
 for(const index of lateFirst?[0,2,1]:[0,1,2]){
  const p=evidence[index],d=buildAutomaticTemplate(gatherEvidenceContext(p,evidence))!;
  const action={...d.actions[0],id:index===2?'second-batch':'first-batch'};
  if(index===0)actions.push(action);else {const old=actions.findIndex(a=>a.id===action.id);if(old>=0)actions[old]=action;else actions.push(action);}
  const id='pub-'+p.id,event={id:'series',title:d.title,version:publications.length+1,status:'published' as const,publicationId:id,actions:structuredClone(actions),evidenceIds:evidence.map(e=>e.id),updatedAt:p.publishedAt};
  const article={...d,id:'article-'+p.id,eventId:event.id,version:1,status:'published' as const,publicationId:id,publishedAt:p.publishedAt,updatedAt:p.publishedAt,sourcePublishedAt:p.publishedAt};
  publications.push({id,eventId:event.id,articleId:article.id,event,article,cutoffAt:lateFirst?second:p.collectedAt,publishedAt:lateFirst?'2026-11-02T01:00:00.000Z':p.publishedAt,mode:'state_change',reason:'isolated batch fixture'});
 }
 return {events:[publications.at(-1)!.event],articles:publications.map(p=>p.article),publications,evidence,serverTime:'2026-11-02T02:00:00.000Z',sources:[],notices:[],activities:[],site:{name:'隔离测试',description:'',autoPublish:true,version:1}};
}
for(const lateFirst of [false,true])test('two batch records retain their dates and source links, late first='+lateFirst,()=>{
 const data=fixture(lateFirst),before=structuredClone(data);
 assert.deepEqual(publicActions(data).map(f=>[f.action.id,f.publication.id]),m.publicActions(data).map((f:any)=>[f.action.id,f.publication.id]));
 const rows=recordCalendar(data,{kind:'banked_reset'}).recentRecords;
 assert.equal(rows.length,2);assert.deepEqual(rows.map((r:any)=>r.at),[second,first]);
 assert.equal(recordCalendar(data,{date:'2026-11-01',kind:'banked_reset'}).selectedItems.length,1);
 assert.equal(recordCalendar(data,{date:'2026-11-02',kind:'banked_reset'}).selectedItems.length,1);
 for(const [name,time] of [['first',first],['second',second]]){
  const id='pub-'+name,p=data.publications.find(p=>p.id===id)!;
  assert.equal(publicationSourceTime(p),time);assert.equal(m.publicationSourceTime(p),time);
  assert.equal(publicationActions(p).length,1);
  const detail=m.resolveDetail(data,{publicationId:id});assert.equal(detail.isOld,false);assert.equal(detail.actions.length,1);
  assert.equal(detail.actions[0].quote,data.evidence.find(e=>e.id===name)!.text);
  const input=posterInput(data,id);assert.equal(input.actions.length,1);assert.equal(input.actions[0].statementAt,m.displayTime(time));
  for(const theme of ['precision','editorial'])assert.ok(createPosterLayout(input,(s:string)=>s.length*12,{status:'not_configured'},{theme}).height>0);
 }
 const home=selectedHomeStatus(data,'banked_reset');assert.equal(home.state,'completed');assert.equal(home.publicationId,'pub-second');assert.equal(home.timeAt,second);assert.match(home.sharePath,/pub-second/);
 assert.deepEqual(data,before);
});
test('batch identity matches only the same ordinal, preserving an unfulfilled announcement once',()=>{
 const data=fixture(),firstAction=data.events[0].actions[0],secondAction=data.events[0].actions[1];
 assert.equal(matchingBenefitActions(firstAction,[secondAction]).length,0);
 assert.deepEqual(matchingBenefitActions({...firstAction,id:'copy'},[firstAction,secondAction]).map(a=>a.id),[firstAction.id]);
 const promised={...firstAction,id:'promise',stage:'promised' as const,evidenceQuote:'We will grant two banked resets.'};
 assert.deepEqual(matchingBenefitActions(firstAction,[promised]).map(a=>a.id),['promise']);
 assert.notEqual(noticeKey({...data.events[0],actions:[firstAction]}, {...data.events[0],actions:[promised]}),noticeKey(data.events[0],{...data.events[0],actions:[firstAction]}));
 assert.equal(noticeKey(data.events[0],structuredClone(data.events[0])),undefined,'repeated reports of the same batch do not notify again');
});
test('activity days retain both confirmed batches and their own links',()=>{
 const data=fixture();data.activities=[{id:'campaign',title:'活动',timezone:'America/Los_Angeles',startsOn:'2026-10-05',days:28,rules:'公开消息',version:1,items:[]}];
 for(const day of [27,28]){
  const view=m.activityModel(data,'campaign',day);
  assert.ok(view.entries.some((item:any)=>item.types.some((type:any)=>type.kind==='banked_reset'&&type.completed)),JSON.stringify(view));
 }
});
test('explicit deadline is derived from original publication time; a broad announcement invents no hour',()=>{
 const at='2026-11-01T00:00:00.000Z';
 for(const benefit of ['banked resets','usage limits']){
  const text=benefit==='banked resets'?'We will grant banked resets to all paid users within 6 hours.':'We will reset usage limits for all paid users within 6 hours.';
  const p={...post('deadline',text,at),collectedAt:'2026-11-01T03:00:00.000Z'};
  assert.equal(buildAutomaticTemplate([p])!.actions[0].expectedAt,'2026-11-01T06:00:00.000Z');
 }
 const p=post('wide','Next two days will be banked resets.',preview);
 assert.equal(buildAutomaticTemplate([p])!.actions[0].expectedAt,undefined);
 const ongoing=post('ongoing','We are rolling out banked resets to all paid users.',first);
 assert.equal(buildAutomaticTemplate([ongoing])!.actions[0].stage,'in_progress');
});
test('an amended or withdrawn batch article retains fixed-version protection',()=>{
 const data=fixture(),old=data.publications.find(p=>p.id==='pub-first')!;
 const updated={...structuredClone(old),id:'pub-first-amended',publishedAt:data.serverTime,article:{...old.article,publicationId:'pub-first-amended',version:2}};
 data.publications.push(updated);data.articles=data.articles.map(a=>a.id===old.articleId?updated.article:a);
 assert.equal(m.resolveDetail(data,{publicationId:old.id}).isOld,true);
 data.articles=data.articles.map(a=>a.id===old.articleId?{...a,status:'withdrawn'}:a);
 assert.equal(m.resolveDetail(data,{publicationId:updated.id}).withdrawn,true);
 assert.throws(()=>posterInput(data,updated.id),/撤回/);
});

for(const ordinal of [1,2])test('confirmed batch '+ordinal+' tolerates only the known legacy template note, preserving occurrence facts',()=>{
 const data=fixture(),incoming=data.events[0].actions[ordinal-1];
 const old={...incoming,timeNote:`发布者报告重置卡发放进度 ${ordinal}/2${ordinal<2?'，后续批次待更新':'，本系列进度已完成'}；个人到账以账户显示为准。`};
 const event={...data.events[0],actions:[old]},draft={...data.publications.at(-1)!.article,actions:[incoming]};
 assert.equal(partitionAutomaticActions(draft,event).current.length,1);
 assert.equal(event.actions[0].timeNote,old.timeNote,'comparison must not rewrite old snapshots');
 for(const change of [{eligibility:'仅限部分账户'},{expectedAt:'2026-11-03T00:00:00.000Z'},{stage:'cancelled' as const},{evidenceQuote:'Banked 1/3'},{timeNote:'卡片将在未来七天内发放'}]){
  assert.throws(()=>partitionAutomaticActions({...draft,actions:[{...incoming,...change}]},event),/相同声明时间/);
 }
 const quota={...incoming,kind:'automatic_reset' as const,evidenceQuote:'Usage limits have been reset for all paid users.'};
 assert.throws(()=>partitionAutomaticActions({...draft,actions:[quota]},{...event,actions:[{...quota,timeNote:'另一时间说明'}]}),/相同声明时间/);
});

test('fractional archive timestamps of one original do not archive an equivalent state',()=>{
 const exact=post('2070653282440405046','We are giving all Codex users a usage reset.',first);
 const copy={...exact,id:'fractional-copy',sourceId:'reset-archive',publishedAt:first.replace('.000Z','.068Z')};
 const incoming:BenefitAction={id:'same-action',kind:'automatic_reset',stage:'in_progress',scope:'public',eligibility:'Codex用户',statementAt:exact.publishedAt,evidenceQuote:exact.text,evidenceIds:[exact.id]};
 const old={...incoming,statementAt:copy.publishedAt,evidenceIds:[copy.id]},data=fixture();
 const event={...data.events[0],actions:[old]},draft={...data.publications[0].article,actions:[incoming]},saved=structuredClone(event);
 assert.equal(partitionAutomaticActions(draft,event,[exact,copy]).current.length,1);
 assert.deepEqual(event,saved);
 assert.equal(partitionAutomaticActions(draft,event).stale.length,1,'source identity proof is required');
 assert.equal(partitionAutomaticActions(draft,event,[exact,{...copy,messageId:'different',url:'https://x.com/thsottiaux/status/different'}]).stale.length,1);
 assert.equal(partitionAutomaticActions({...draft,actions:[{...incoming,eligibility:'部分账户'}]},event,[exact,copy]).stale.length,1);
 assert.equal(partitionAutomaticActions(draft,{...event,actions:[{...old,statementAt:old.statementAt.replace('.068Z','.000Z').replace('00:43:20','00:43:22')}]},[exact,copy]).stale.length,1);
});

for(const kind of ['automatic_reset','banked_reset'] as const)test('same-kind occurrence source identity stays local to each record: '+kind,()=>{
 const data=fixture();
 for(const p of data.publications)for(const a of p.event.actions)a.kind=kind;
 for(const e of data.events)for(const a of e.actions)a.kind=kind;
 const pairs=publicActions(data).map(x=>[x.action.statementAt,x.publication.id]).sort();
 assert.deepEqual(pairs,[[first,'pub-first'],[second,'pub-second']].sort());
 assert.deepEqual(m.publicActions(data).map((x:any)=>[x.action.statementAt,x.publication.id]).sort(),pairs);
 for(const id of ['pub-first','pub-second']){assert.equal(m.resolveDetail(data,{publicationId:id}).isOld,false);assert.equal(publicationActions(data.publications.find(p=>p.id===id)!).length,1);}
});
