import test from 'node:test';
import assert from 'node:assert/strict';
import type {Evidence} from '../src/lib/types';
import {extractBenefitClaims, extractReplyClaims} from '../src/server/benefit-rules';
import {evidenceBenefitClaims, gatherEvidenceContext} from '../src/server/source-context';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {validateDraft} from '../src/server/domain';

const parent:Evidence={id:'parent',sourceId:'reset-archive',messageId:'fixture-parent',url:'https://x.com/fixture_author/status/fixture-parent',text:'Global reset landing by EOD PST time. Enjoy',publishedAt:'2026-10-13T01:00:00.000Z',collectedAt:'2026-10-13T01:01:00.000Z',hash:'parent',contextComplete:true,historical:false,provenance:'archive',textOrigin:'original'};
const child=(text:string,extra:Partial<Evidence>={}):Evidence=>({id:'child',sourceId:'reset-archive',messageId:'fixture-child',url:'https://x.com/fixture_author/status/fixture-child',text,publishedAt:'2026-10-13T05:00:00.000Z',collectedAt:'2026-10-13T05:01:00.000Z',hash:text,parentId:parent.messageId,contextComplete:false,historical:false,provenance:'archive',textOrigin:'original',...extra});

test('question foreword plus a short done statement needs the explicit saved parent',()=>{
  const e=child("What would you like with your side of reset? It's done.");
  const claims=evidenceBenefitClaims(e,[e,parent]);
  assert.equal(claims.length,1);
  assert.equal(claims[0].kind,'automatic_reset');
  assert.equal(claims[0].stage,'claimed_complete');
  assert.equal(claims[0].eligibility,'全局范围（原帖未列明具体套餐）');
  assert.equal(claims[0].expectedAt,undefined);
  const template=buildAutomaticTemplate([e,parent])!;
  assert.equal(template.publicationMode,'state_change');
  assert.equal(template.actions.length,1);
  assert.deepEqual(validateDraft(template,[e,parent],true),[]);
});

for(const text of ["It's done.",'It is done.','That is already done.','This is now done!',"What would you like with your side of reset? It’s done.","No delays. It's done."]){
  test(`explicit parent supports completion: ${text}`,()=>{
    const e=child(text);
    assert.equal(evidenceBenefitClaims(e,[e,parent])[0]?.stage,'claimed_complete');
  });
}

for(const text of ['Is it done?',"It's not done.",'It will be done.',"Rumour: it's done.","It's done for Pro accounts.","It's done except for selected users.","It's not done. It's done.","It's done. It hasn't completed.",'The model is done.',"The banked reset has landed. It's done."]){
  test(`ambiguous, negated, qualified or conflicting reply stays unclassified: ${text}`,()=>{
    const e=child(text);
    assert.deepEqual(evidenceBenefitClaims(e,[e,parent]),[]);
  });
}

test('missing parent, different author and manual parent cannot supply the benefit',()=>{
  const e=child("It's done.");
  assert.deepEqual(evidenceBenefitClaims(e,[e]),[]);
  assert.deepEqual(evidenceBenefitClaims(e,[e,{...parent,url:'https://x.com/another_author/status/fixture-parent'}]),[]);
  assert.deepEqual(evidenceBenefitClaims(e,[e,{...parent,provenance:'manual'}]),[]);
  assert.deepEqual(extractBenefitClaims("It's done.",e.publishedAt),[]);
});

test('a reply cannot choose between two different parent benefits',()=>{
  const parents=extractBenefitClaims('We will reset usage limits for all paid accounts. We will add a banked reset to all free accounts.',parent.publishedAt);
  assert.equal(parents.length,2);
  assert.deepEqual(extractReplyClaims("It's done.",child('').publishedAt,parents),[]);
});

test('literal PST deadline interpretation is unchanged in the future candidate',()=>{
  const claim=extractBenefitClaims(parent.text,parent.publishedAt)[0];
  assert.equal(claim.stage,'promised');
  assert.equal(claim.expectedAt,'2026-10-13T08:00:00.000Z');
});
