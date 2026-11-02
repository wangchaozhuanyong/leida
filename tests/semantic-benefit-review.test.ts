import test from 'node:test';
import assert from 'node:assert/strict';
import type {Evidence,DraftContent} from '../src/lib/types';
import {hash,validateDraft} from '../src/server/domain';
import {semanticReviewClaims,acceptSemanticReview,validSemanticProof} from '../src/server/semantic-benefit-review';
const at='2026-10-31T05:42:26.000Z';
const post=(text:string):Evidence=>({id:'novel',messageId:'2116405414921384099',url:'https://x.com/thsottiaux/status/2116405414921384099',sourceId:'tibo-public',metadata:{sourceGroup:'fxembed:thsottiaux'},text,hash:hash(text),textOrigin:'original',contextComplete:true,provenance:'archive',publishedAt:at,collectedAt:at,historical:false});
const draft=(e:Evidence):DraftContent=>({title:'额度恢复消息',summary:'原作者说明已使用的额度恢复至原来上限，适用付费账户。',translation:'',publicationMode:'state_change',contentOrigin:'generated',category:'reset',evidenceIds:[e.id],actions:[{id:'draft-id',kind:'automatic_reset',stage:'claimed_complete',eligibility:'付费Codex账户',scope:'public',statementAt:at,evidenceIds:[e.id],evidenceQuote:e.text}]});
const response=(d:DraftContent)=>({supported:true,actions:d.actions.map(a=>({supported:true,evidenceId:a.evidenceIds[0],evidenceQuote:a.evidenceQuote,kind:a.kind,stage:a.stage}))});
test('separate reviewed novel wording can pass without removing quote/audience/clock checks',()=>{
 const e=post('We have restored the spent Codex budget to its original maximum for all paid users.'),d=draft(e);
 assert.ok(validateDraft(d,[e],true).length,'old deterministic path does not claim understanding');
 const proof=acceptSemanticReview([e],d,response(d),3)!;
 assert.ok(proof);assert.equal(validSemanticProof(proof,[e],d),true);assert.deepEqual(validateDraft(d,[e],true,proof),[]);
 assert.ok(validateDraft({...d,actions:[{...d.actions[0],eligibility:'所有账户'}]},[e],true,proof).length);
 assert.equal(validSemanticProof(proof,[{...e,text:'A revised statement',hash:'revised'}],d),false);
 assert.equal(validSemanticProof(proof,[e],{...d,summary:'全部免费账户已恢复'}),false);
 assert.equal(validSemanticProof(proof,[e],{...d,actions:[{...d.actions[0],id:'server-assigned'}]}),true);
 const reorder=(value:any):any=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(k=>[k,reorder(value[k])])):value;
 assert.equal(validSemanticProof(reorder(proof),[reorder(e)],reorder(d)),true,'JSONB key ordering must not invalidate an otherwise identical review');
});
test('review is not a permit for quotation, negation, bonus, future completion or fake spans',()=>{
 for(const text of ['Someone said: We have reset usage limits for all paid users.','We have not refilled usage limits for all paid users.','No stored resets are available for all users.','We have added 50% extra Codex quota to all paid users.','We will reset usage limits for all paid users tomorrow.']){
  const e=post(text),d=draft(e);assert.equal(acceptSemanticReview([e],d,response(d),1),undefined,text);
 }
 const e=post('We have restored the spent Codex budget to its original maximum for all paid users.'),d=draft(e);
 assert.equal(acceptSemanticReview([e],d,{...response(d),supported:false},1),undefined);
 assert.equal(acceptSemanticReview([e],d,{...response(d),actions:[]},1),undefined);
 assert.equal(semanticReviewClaims([e],{...d,actions:[{...d.actions[0],evidenceQuote:'made up'}]}),undefined);
 const timed=post('We will refresh Codex usage limits for all paid users in 2 hours.');
 assert.equal(semanticReviewClaims([timed],{...draft(timed),actions:[{...draft(timed).actions[0],stage:'promised'}]}),undefined);
});
test('new banked wording and a known quota action can coexist after independent review',()=>{
 const card='We have delivered a reset voucher for all paid users.';
 for(const mixed of [false,true]){
  const quota='We have reset usage limits for all paid users.',e=post(mixed?quota+' '+card:card);
  const banked={...draft(e).actions[0],kind:'banked_reset' as const,eligibility:'付费账户',evidenceQuote:card};
  const d:DraftContent={...draft(e),title:'额度及重置卡消息',summary:'原作者说明付费账户的重置卡发放情况。',actions:[...(mixed?[{...banked,id:'quota',kind:'automatic_reset' as const,evidenceQuote:quota}]:[]),banked]};
  assert.ok(validateDraft(d,[e],true).length);
  const proof=acceptSemanticReview([e],d,response(d),1);assert.ok(proof);assert.deepEqual(validateDraft(d,[e],true,proof),[]);
 }
});
