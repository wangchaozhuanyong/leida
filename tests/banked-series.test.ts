import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {Evidence,RadarEvent} from '../src/lib/types';
import {hash,validateDraft} from '../src/server/domain';
import {gatherEvidenceContext,evidenceBenefitClaims} from '../src/server/source-context';
import {bankedProgress,bankedSeriesContext} from '../src/server/benefit-signal';
import {buildAutomaticTemplate,evidenceFingerprint,needsSemanticReview} from '../src/server/automatic-content';
import {actionIdentityEvidence,resolveLinkedEvents} from '../src/server/worker';
import {automaticNewsContextUpgrade} from '../src/server/service';

const previewText='Day 26/ You can now easily switch between multiple accounts on mobile, and coming soon to desktop too. Next two days will be resets… banked… do with this what you may 👀.\n\nhttps://t.co/iQxsqbuk0f';
const post=(text:string,id='2116405414921384099',at='2026-10-31T05:42:26.000Z',patch:Partial<Evidence>={}):Evidence=>({id:'e-'+id,messageId:id,sourceId:'tibo-public',url:'https://x.com/thsottiaux/status/'+id,text,hash:hash(text),publishedAt:at,collectedAt:at,contextComplete:true,textOrigin:'original',provenance:'archive',historical:false,metadata:{sourceGroup:'fxembed:thsottiaux'},...patch});
const preview=post(previewText),first=post('Banked 1/2','2116692529970311254','2026-11-01T00:43:20.000Z');
// Actual captured completion; Day 28 is a source label, not a third counter.
const second=post('Day 28/ Banked 2/2','2117035794678546764','2026-11-01T23:27:20.000Z');
const template=(p:Evidence,all:Evidence[])=>buildAutomaticTemplate(gatherEvidenceContext(p,all));

test('real preview becomes a qualified announcement without tomorrow posts or a fabricated deadline',()=>{
 const draft=template(preview,[preview])!;
 assert.equal(draft.publicationMode,'state_change');assert.equal(draft.actions.length,1);
 assert.equal(draft.actions[0].kind,'banked_reset');assert.equal(draft.actions[0].stage,'promised');
 assert.equal(draft.actions[0].eligibility,'适用范围未说明');assert.equal(draft.actions[0].expectedAt,undefined);
 assert.match(draft.actions[0].timeNote!,/next two days/i);assert.deepEqual(validateDraft(draft,[preview],true),[]);
 assert.ok(validateDraft({...draft,actions:[{...draft.actions[0],eligibility:'所有付费账户'}]},[preview],true).length);
});

test('1/2 advances the same announcement, 2/2 completes it; identities and citations agree without fake parents',()=>{
 for(const [p,all,stage] of [[first,[preview,first],'in_progress'],[second,[preview,first,second],'claimed_complete']] as const){
  const context=gatherEvidenceContext(p,[...all]),draft=buildAutomaticTemplate(context)!;
  assert.equal(draft.actions[0]?.stage,stage);assert.match(draft.actions[0].timeNote!,p===first?/1\/2/:/2\/2/);
  assert.equal(actionIdentityEvidence(p,context).id,preview.id);assert.equal(p.parentId,undefined);
  assert.deepEqual(validateDraft(draft,[...all],true),[]);
  const event:RadarEvent={id:'series',title:'预告',version:1,status:'published',actions:template(preview,[preview])!.actions,evidenceIds:[preview.id],publicationId:'pub',updatedAt:preview.publishedAt};
  assert.deepEqual(resolveLinkedEvents(p,context,[event],[...all]).map(e=>e.id),['series']);
 }
 assert.equal(template(first,[first])?.actions.length??0,0);
 assert.ok(validateDraft({...template(first,[preview,first])!,actions:[{...template(first,[preview,first])!.actions[0],stage:'claimed_complete'}]},[preview,first],true).length);
});

test('activity-prefixed counters preserve the original quote and require the same independent series proof',()=>{
 for(const [index,text] of ['Day 28/ Banked 2/2','Day 28 /\nBanked 2/2','Day 27/ Banked 1/2'].entries()){
  const p=post(text,'prefixed-'+index,second.publishedAt,{contextComplete:false});
  assert.deepEqual(bankedProgress(text),{index:text.endsWith('1/2')?1:2,total:2});
  assert.equal(template(p,[p])?.actions.length??0,0,'a day label cannot invent its missing announcement');
  const all=[preview,p],draft=template(p,all)!;
  assert.equal(draft.actions[0]?.stage,text.endsWith('1/2')?'in_progress':'claimed_complete');
  assert.equal(draft.actions[0]?.evidenceQuote,text);assert.equal(draft.actions[0]?.statementAt,p.publishedAt);
  assert.deepEqual(validateDraft(draft,all,true),[]);
 }
 for(const text of ['Day 28/ Not Banked 2/2','Day 28/ Maybe Banked 2/2','Day 28/ My Banked 2/2','Day 28/ Banked 2/2 for selected users','Day 28/ Banked 2/2?','Day 28/ Banked 3/2','Day 28/ Banked 2/2; reset cancelled']){
  assert.equal(bankedProgress(text),undefined,text);
  const p=post(text);assert.equal(template(p,[preview,p])?.actions.filter(a=>a.stage==='claimed_complete'&&a.scope==='public').length??0,0,text);
 }
});

test('series proof rejects competing announcements, future evidence, different author, withdrawal and conflicting progress',()=>{
 const cases=[
  [post('Next two days will be banked resets.','competing','2026-10-31T06:00:00Z')],
  [post('We will grant a banked reset to all users.','competing','2026-10-31T06:00:00Z')],
  [post('We cancelled the banked reset.','cancel','2026-10-31T06:00:00Z')],
  [post('Banked 2/2','old-progress','2026-10-31T06:00:00Z')]
 ];
 for(const extra of cases)assert.deepEqual(bankedSeriesContext(first,[preview,first,...extra]),[]);
 for(const altered of [
  {...preview,publishedAt:'2026-11-02T00:00:00Z'},
  {...preview,url:preview.url.replace('thsottiaux','someone_else')},
  {...preview,provenance:'manual' as const},
  {...preview,textOrigin:'archive_excerpt' as const}
 ])assert.deepEqual(bankedSeriesContext(first,[altered,first]),[]);
 assert.deepEqual(bankedSeriesContext({...first,parentId:'another-thread'},[preview,first]),[]);
 assert.equal(template(post('Banked 1/2?'),[preview,post('Banked 1/2?')])?.actions.length??0,0);
 assert.deepEqual(bankedSeriesContext(post('Banked 3/2'),[preview]),[]);
});

test('new grammar is compositional but cannot strip eligibility, negation, hearsay or unrelated banking',()=>{
 for(const text of ['Next three days will be resets — banked.','We will grant a banked reset.','We have granted a banked reset.','Stored resets are now available.','Reserve resets will be delivered.']){
  const p=post(text),draft=template(p,[p])!;assert.equal(draft.actions[0]?.kind,'banked_reset',text);assert.deepEqual(validateDraft(draft,[p],true),[]);
 }
 for(const text of ['No banked reset has been loaded.','Maybe we will grant a banked reset.','Someone says we have loaded a banked reset.','We will grant a banked reset in selected regions.','We have banked profits.','We will reset passwords.']){
  const p=post(text);assert.equal(evidenceBenefitClaims(p,[p]).filter(c=>c.scope==='public').length,0,text);
 }
});

test('support arriving later changes input fingerprint; duplicate arrival does not change facts',()=>{
 const before=evidenceFingerprint(gatherEvidenceContext(first,[first]));
 const after=evidenceFingerprint(gatherEvidenceContext(first,[first,preview]));assert.notEqual(before,after);
 assert.equal(after,evidenceFingerprint(gatherEvidenceContext(first,[preview,first])));
 assert.deepEqual(template(first,[first,preview]),template(first,[preview,first]));
});

test('only unresolved originals enter model review; model version changes retry once without reprocessing supported templates',()=>{
 const p=post('Day 5/ Reset.'),draft=template(p,[p]);
 assert.equal(needsSemanticReview(draft,[p]),true);
 assert.notEqual(evidenceFingerprint([p],1),evidenceFingerprint([p],2));
 assert.equal(evidenceFingerprint([preview],1),evidenceFingerprint([preview],2));
 assert.equal(needsSemanticReview(draft,[{...p,parentId:'missing'}]),false);
 assert.equal(needsSemanticReview(draft,[{...p,textOrigin:'archive_excerpt'}]),false);
});

test('native homepage and both poster inputs share a live series state, not a completed first batch',()=>{
 const require=createRequire(import.meta.url);
 const {selectedHomeStatus}=require('../miniprogram/utils/home-reset-status.js');
 const {posterInput,createPosterLayout}=require('../miniprogram/utils/poster.js');
 const publications:any[]=[],articles:any[]=[];
 for(const [index,p] of [preview,first,second].entries()){
  const draft=template(p,[preview,first,second].slice(0,index+1))!;
  const action={...draft.actions[0],id:'same-series'};
  const event={id:'series',title:draft.title,version:index+1,status:'published',actions:[action],evidenceIds:draft.evidenceIds,publicationId:'pub'+index,updatedAt:p.publishedAt};
  const article={...draft,id:'article'+index,eventId:'series',version:1,status:'published',publicationId:event.publicationId,publishedAt:p.publishedAt,updatedAt:p.publishedAt};
  articles.push(article);publications.push({id:event.publicationId,eventId:'series',articleId:article.id,event,article,cutoffAt:p.collectedAt,publishedAt:p.publishedAt});
  const data={events:[event],articles,publications,evidence:[preview,first,second].slice(0,index+1),notices:[],activities:[],sources:[],site:{name:'隔离',description:'',autoPublish:true,version:1},serverTime:p.publishedAt};
  const card=selectedHomeStatus(data,'banked_reset',p.publishedAt);
  assert.equal(card.state,['announced','progress','completed'][index]);
  assert.equal(card.publicationId,event.publicationId);
  assert.match(card.sharePath,new RegExp(event.publicationId));
  const input=posterInput(data,event.publicationId);
  for(const theme of ['precision','editorial']){
    const layout=createPosterLayout(input,(text:string)=>Array.from(text).length*12,{status:'not_configured'},{theme});
    assert.ok(layout.height>0);assert.equal(input.publicationId,card.publicationId);
    if(index===1)assert.match(JSON.stringify(layout),/1\/2/);
  }
  if(index===1){assert.equal(card.hero.title,'重置卡正在发放');assert.doesNotMatch(card.hero.title,/1\/2/);assert.equal(card.completedDisplay,false);}
 }
});

test('a previously pending counter shell can upgrade into its proven series without overriding reviewed content',()=>{
 const draft=template(first,[preview,first])!;
 const target:RadarEvent={id:'target',title:'预告',version:1,status:'published',actions:template(preview,[preview])!.actions,evidenceIds:[preview.id],publicationId:'target-pub',updatedAt:preview.publishedAt};
 const duplicate:RadarEvent={...target,id:'pending-counter',title:'待核对',actions:[],evidenceIds:[first.id]};
 const article:any={id:'pending-article',eventId:duplicate.id,title:'待核对',version:1,status:'published',contentOrigin:'template',publicationMode:'news_only',evidenceIds:[first.id]};
 assert.equal(automaticNewsContextUpgrade(first,draft,duplicate,target,[preview,first],[article])?.id,article.id);
 assert.equal(automaticNewsContextUpgrade(first,draft,duplicate,{...target,manualFields:['title']},[preview,first],[article]),undefined);
 assert.equal(automaticNewsContextUpgrade(first,draft,duplicate,target,[first],[article]),undefined);
});
