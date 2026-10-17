import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {Evidence} from '../src/lib/types';
import {campaignMembership,gatherEvidenceContext,evidenceBenefitClaims,hasCompleteContext,processingObstacles} from '../src/server/source-context';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {validateDraft} from '../src/server/domain';
import {actionIdentityEvidence} from '../src/server/worker';
const all:Evidence[]=JSON.parse(readFileSync(new URL('./fixtures/reset-omission-month.json',import.meta.url),'utf8')).map((r:Evidence,i:number)=>({...r,id:'fixture_'+i,hash:'fixture_'+i,historical:true}));
const find=(id:string)=>all.find(e=>e.messageId===id&&e.sourceId==='tibo-public')!;
const context=(id:string,available=all)=>gatherEvidenceContext(find(id),available);

test('Oct15 explicit chain inherits the verified campaign, calculates its own two-hour deadline and completes once',()=>{
 const root=find('2110595484180214059'),deadline=find('2110595554036400151'),done=find('2110618732666257557');
 for(const e of [root,deadline,done])assert.equal(hasCompleteContext(e,context(e.messageId)),true);
 assert.equal(buildAutomaticTemplate(context(root.messageId))?.reviewStatus,'pending');
 const promise=buildAutomaticTemplate(context(deadline.messageId))!;
 const completion=buildAutomaticTemplate(context(done.messageId))!;
 assert.equal(promise.activityId,'challenge-28');assert.equal(promise.activityDay,10);
 assert.equal(completion.activityId,'challenge-28');assert.equal(completion.activityDay,10);
 assert.equal(promise.actions[0]?.expectedAt,'2026-10-15T06:56:07.000Z');
 assert.equal(completion.actions[0]?.stage,'claimed_complete');
 assert.equal(completion.actions[0]?.statementAt,'2026-10-15T06:28:13.000Z');
 assert.ok(!/所有|全体|付费|Plus|Pro|Business/.test(completion.actions[0].eligibility));
 assert.deepEqual(validateDraft(promise,all,true),[]);
 assert.deepEqual(validateDraft(completion,all,true),[]);
 assert.equal(actionIdentityEvidence(done,context(done.messageId)).messageId,root.messageId);
});

test('processed statement is a campaign completion; an untyped propagated statement stays publicly pending',()=>{
 const completed=buildAutomaticTemplate(context('2107676072871600470'))!;
 assert.equal(completed.actions[0]?.stage,'claimed_complete');
 assert.deepEqual(validateDraft(completed,all,true),[]);
 const pending=buildAutomaticTemplate(context('2103911959544610829'))!;
 assert.equal(pending.reviewStatus,'pending');assert.deepEqual(pending.actions,[]);
 assert.deepEqual(validateDraft(pending,all,true),[]);
});

test('Pro500 report and explicit fixed reply are targeted tracking without public benefit actions',()=>{
 for(const id of ['2106233145163141249','2106239435461579088']){
  const draft=buildAutomaticTemplate(context(id))!;
  assert.equal(draft.reviewStatus,'targeted_update');assert.deepEqual(draft.actions,[]);
  assert.deepEqual(validateDraft(draft,all,true),[]);
 }
});

test('later archive excerpt cannot replace the full original parent; divergent originals block state changes',()=>{
 const root=find('2110595484180214059'),done=find('2110595554036400151');
 const excerpt={...root,id:'new-excerpt',text:'Day10摘要',textOrigin:'archive_excerpt' as const,collectedAt:'2027-01-01T00:00:00Z'};
 assert.equal(gatherEvidenceContext(done,[...all,excerpt])[1].id,root.id);
 const conflict={...root,id:'changed-original',text:'Day 10/ Banked Reset'};
 const ctx=gatherEvidenceContext(done,[...all,conflict]);
 assert.deepEqual(evidenceBenefitClaims(done,ctx),[]);
 assert.ok(processingObstacles(ctx).codes.includes('evidence_conflict'));
});

test('campaign needs original rule, verified day-one calendar, same author and matching day; no nearest-date inference',()=>{
 const root=find('2110595484180214059');
 const rule=find('2106845241357824205');
 for(const available of [all.filter(e=>e.messageId!==rule.messageId),all.filter(e=>e.messageId!=='2107158998495748264'),all.map(e=>e.id===rule.id?{...e,url:e.url.replace('thsottiaux','other_author')}:e)]){
  assert.deepEqual(evidenceBenefitClaims(root,gatherEvidenceContext(root,available)),[]);assert.equal(campaignMembership(root,gatherEvidenceContext(root,available)),undefined);
 }
 const wrongDay={...root,id:'wrongday',text:'Day 20/ Reset'};
 assert.deepEqual(evidenceBenefitClaims(wrongDay,gatherEvidenceContext(wrongDay,[...all,wrongDay])),[]);assert.equal(campaignMembership(wrongDay,gatherEvidenceContext(wrongDay,[...all,wrongDay])),undefined);
});

test('completion cannot borrow across authors, missing parents, different benefits or truncated text',()=>{
 const done=find('2110618732666257557');
 for(const e of [{...done,parentId:'absent'},{...done,publishedAt:'2026-09-01T00:00:00Z'},{...done,url:done.url.replace('thsottiaux','other_author')},{...done,text:'Done and dusted…'},{...done,text:'The banked reset has landed.'},{...done,text:'It is not done.'},{...done,text:'Is it done?'},{...done,text:'Done and dusted for selected users.'}])assert.deepEqual(evidenceBenefitClaims(e,gatherEvidenceContext(e,all)),[]);
});

test('full unsupported original stops network retries; missing parent and truncation remain distinct',()=>{
 const generic=find('2103911959544610829');
 const blocked=processingObstacles([generic]);
 assert.equal(blocked.missing,false);assert.ok(blocked.codes.includes('ambiguous_kind_or_audience'));
 assert.ok(processingObstacles([{...generic,parentId:'absent'}]).codes.includes('missing_parent'));
 assert.ok(processingObstacles([{...generic,text:'The reset has been…'}]).codes.includes('truncated_body'));
});


test('同一日历对应不同活动身份时不选择任意一个活动归属',()=>{
 const root=find('2110595484180214059'),calendar=all.find(e=>e.metadata?.activity)!;
 const other={...calendar,id:'another-calendar',metadata:{...calendar.metadata,activity:{...calendar.metadata!.activity!,id:'other-campaign'}}};
 assert.equal(campaignMembership(root,gatherEvidenceContext(root,[...all,other])),undefined);
});
