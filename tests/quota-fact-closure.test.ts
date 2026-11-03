import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {Evidence,DraftContent} from '../src/lib/types';
import {hash,validateDraft} from '../src/server/domain';
import {analyzeBenefitEvidence} from '../src/server/benefit-analysis';
import {gatherEvidenceContext,evidenceBenefitClaims} from '../src/server/source-context';
import {buildAutomaticTemplate,needsSemanticReview} from '../src/server/automatic-content';
import {bankedSeriesContext} from '../src/server/benefit-signal';
import {extractCadenceObservations} from '../src/server/reset-cadence-evidence';
import {TIBO_PUBLIC_SOURCE} from '../src/server/tibo-public';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/quota-meaning-cases.json',import.meta.url),'utf8'));
let counter=0;const at='2026-10-31T05:42:26.000Z';
const post=(text:string,patch:Partial<Evidence>={}):Evidence=>{const publishedAt=patch.publishedAt??at,id=String(((BigInt(Date.parse(publishedAt))-1288834974657n)<<22n)+BigInt(++counter));return {id:'norm-'+id,messageId:id,sourceId:'tibo-public',url:'https://x.com/thsottiaux/status/'+id,text,hash:hash(text),publishedAt,collectedAt:new Date(Date.parse(publishedAt)+60000).toISOString(),contextComplete:true,historical:false,provenance:'archive',textOrigin:'original',metadata:{sourceGroup:'fxembed:thsottiaux'},...patch};};
const draft=(p:Evidence,all=[p])=>buildAutomaticTemplate(gatherEvidenceContext(p,all));
for(const f of fixtures){test('fact closure: '+f.name,()=>{
 const p=post(f.text),d=draft(p),actions=d?.actions??[];
 if(['promised','claimed_complete','in_progress','claimed_complete_unknown_audience'].includes(f.expectation)){
  assert.equal(actions[0]?.stage,f.expectation.replace('_unknown_audience',''));assert.equal(actions[0].kind,'automatic_reset');assert.deepEqual(validateDraft(d!,[p],true),[]);
 }else if(f.expectation==='two_actions'){
  assert.equal(actions.length,2);assert.deepEqual(new Set(actions.map(a=>a.kind)),new Set(['automatic_reset','banked_reset']));assert.deepEqual(validateDraft(d!,[p],true),[]);
 }else{
  assert.equal(actions.filter(a=>a.scope==='public').length,0);
  const obs=extractCadenceObservations([p],[{...TIBO_PUBLIC_SOURCE,enabled:true,validated:true}],'2026-11-01T04:00:00Z');assert.equal(obs.length,0);
 }
});}
test('coverage rejects dropped actions and deadlines, including generator proposals',()=>{
 for(const text of ['We have reset usage limits for all paid users. We have loaded banked resets for all paid users.','We will reset usage limits for all paid users in 2 hours.']){
  const p=post(text),d=draft(p)!;
  const proposal:DraftContent=d.actions.length===2?{...d,actions:d.actions.slice(0,1)}:{...d,actions:d.actions.map(({expectedAt,...a})=>a)};
  assert.ok(validateDraft(proposal,[p],true).some(r=>/遗漏/.test(r)));
 }
});
test('series version conflicts are limited to relevant identities, counts do not come from days',()=>{
 const anchor=post('Next two days will be banked resets.'),child=post('Banked 1/2',{publishedAt:'2026-11-01T00:43:20Z'});
 const old=post('We shipped a product.',{publishedAt:'2026-04-01T00:00:00Z'}),old2={...old,id:'old-copy',text:'We shipped a better product.'};
 assert.equal(bankedSeriesContext(child,[anchor,child,old,old2])[0]?.id,anchor.id);
 assert.deepEqual(bankedSeriesContext(child,[anchor,child,{...anchor,id:'conflicting',text:'Next three days will be banked resets.'}]),[]);
 const two=post('We will grant two banked resets to all paid users over the next three days.');
 const reply=post('Banked 1/2',{parentId:two.messageId,publishedAt:child.publishedAt});
 assert.equal(evidenceBenefitClaims(reply,gatherEvidenceContext(reply,[two,reply]))[0]?.stage,'claimed_complete');
});
test('unresolved second action is retained as work, not reported as completely processed',()=>{
 const p=post('We have reset usage limits for all paid users. A reset is on the horizon for affected users.');
 const context=gatherEvidenceContext(p,[p]),d=buildAutomaticTemplate(context)!;
 assert.equal(d.actions[0]?.kind,'automatic_reset');assert.ok(analyzeBenefitEvidence(p,context).unresolved.length);assert.equal(needsSemanticReview(d,context),true);
});
test('quoted and denied clauses cannot poison an independent own assertion',()=>{
 const p=post('Rumour: someone said usage limits were reset. We have reset usage limits for all paid users.');
 assert.equal(draft(p)?.actions.length,1);assert.equal(draft(p)?.actions[0].evidenceQuote,'We have reset usage limits for all paid users.');
 const q=post('Someone said: “We have reset usage limits for all paid users. We have loaded banked resets for all paid users.”');
 assert.equal(evidenceBenefitClaims(q,[q]).length,0);
});
test('held-out recovery wording and a real historical promise preserve meaning and timing precision',()=>{
 for(const text of ['Codex usage limits have been fully replenished for all paid users.','We have fully refilled usage limits for everyone.']){
  assert.equal(draft(post(text))?.actions[0]?.stage,'claimed_complete');
 }
 const p=post('Five million users would agree. Resetting the limits tomorrow morning to celebrate.');
 assert.equal(draft(p)?.actions[0]?.stage,'promised');assert.equal(draft(p)?.actions[0]?.expectedAt,undefined);
});
