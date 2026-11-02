import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extractBenefitClaims,benefitTime} from '../src/server/benefit-rules';
import {hash,validateDraft} from '../src/server/domain';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {analyzeBenefitEvidence} from '../src/server/benefit-analysis';
import {gatherEvidenceContext} from '../src/server/source-context';
import type {Evidence} from '../src/lib/types';
const rows=JSON.parse(readFileSync(new URL('./fixtures/half-year-benefit-wording.json',import.meta.url),'utf8'));
const post=(id:string):Evidence=>{const r=rows.find((r:any)=>r.id===id);return {id:'replay-'+id,sourceId:'tibo-public',messageId:id,text:r.text,hash:hash(r.text),url:'https://x.com/thsottiaux/status/'+id,publishedAt:r.at,collectedAt:r.at,parentId:r.parent,contextComplete:true,textOrigin:'original',provenance:'archive',historical:false,metadata:{sourceGroup:'fxembed:thsottiaux'}};};
test('historical direct deadline: give us 24 hours is a promise, not a completion',()=>{
 const p=post('2066956441173323943'),claims=extractBenefitClaims(p.text,p.publishedAt);
 assert.equal(claims[0]?.kind,'automatic_reset');assert.equal(claims[0]?.stage,'promised');assert.equal(claims[0]?.expectedAt,'2026-06-17T18:49:52.000Z');
});
test('historical rollout verbs retain a prospective deadline without confirming delivery',()=>{
 for(const [id,at] of [['2075330198887940337','2026-07-09T22:24:11.000Z'],['2075820987833274448','2026-07-11T06:24:25.000Z'],['2076365965915467978','2026-07-12T18:59:57.000Z']]){
  const p=post(id),claims=extractBenefitClaims(p.text,p.publishedAt),c=claims.find(c=>c.kind==='automatic_reset');assert.ok(c,id);assert.notEqual(c.stage,'claimed_complete');assert.equal(c.expectedAt,at,id);
 }
});
test('historical full reset across named products and over-next timing remain a promise',()=>{
 const p=post('2075452680760443190'),claims=extractBenefitClaims(p.text,p.publishedAt);
 assert.equal(claims[0]?.stage,'promised');assert.equal(claims[0]?.expectedAt,'2026-07-11T05:30:53.000Z');
 assert.ok(!claims.some(c=>c.stage==='claimed_complete'));
});
test('historical same original retains completed action and explicitly distinct next promise',()=>{
 const p=post('2075641131002700120'),claims=extractBenefitClaims(p.text,p.publishedAt);
 assert.ok(claims.some(c=>c.kind==='automatic_reset'&&c.stage==='claimed_complete'));
 assert.ok(claims.some(c=>c.kind==='automatic_reset'&&c.stage==='promised'&&/another one will come/.test(c.quote)));
 const d=buildAutomaticTemplate(gatherEvidenceContext(p,[p]));assert.equal(d?.actions.length,2);assert.deepEqual(validateDraft(d!,[p],true),[]);
});
test('historical full original keeps public tomorrow grant beside targeted past grant',()=>{
 const p=post('2076418567143408112'),claims=extractBenefitClaims(p.text,p.publishedAt);
 assert.ok(claims.some(c=>c.kind==='banked_reset'&&c.stage==='promised'&&c.scope==='public'));
 assert.ok(!claims.some(c=>c.kind==='banked_reset'&&c.stage==='claimed_complete'&&c.scope==='public'));
});
test('historical for-all progress can inherit only its own named product audience',()=>{
 const p=post('2077114635308986427'),claims=extractBenefitClaims(p.text,p.publishedAt);
 assert.equal(claims[0]?.stage,'in_progress');assert.match(claims[0]?.eligibility??'',/Codex/);
});
test('unknown reset rollout phrasing remains unresolved when no typed fact can be derived',()=>{
 for(const id of ['2077607697487188198','2087706104814023111']){
  const p=post(id),context=gatherEvidenceContext(p,[p]),a=analyzeBenefitEvidence(p,context);
  assert.ok(a.claims.length||a.unresolved.length,id);
 }
});
test('range, negation, reporting, validity and membership are not delivery deadlines',()=>{
 const at='2026-11-02T00:00:00Z';
 for(const text of ['Give us 2 to 4 hours to reset usage for all users.','The banked reset is valid for 24 hours.','Accounts created within 24 hours are eligible.'])assert.equal(benefitTime(text,at).expectedAt,undefined,text);
 for(const text of ['We will not reset usage limits for all users in 24 hours.','Someone said: We will reset usage limits for all users in 24 hours.','Maybe we could reset usage limits for everyone.'])assert.equal(extractBenefitClaims(text,at).length,0,text);
});

test('second occurrence never reuses completed identity; an ambiguous reply stays ambiguous',async()=>{
 const {matchingBenefitActions}=await import('../src/server/benefit-signal');
 const base={kind:'automatic_reset' as const,scope:'public' as const,eligibility:'Codex用户',evidenceIds:['original'],statementAt:'2026-07-10T17:59:43Z'};
 const completed={...base,id:'first',stage:'claimed_complete' as const,evidenceQuote:'We have reset usage limits across Codex and ChatGPT Work.'};
 const promised={...base,id:'second',stage:'promised' as const,evidenceQuote:completed.evidenceQuote+' And another one will come later in the day.'};
 assert.deepEqual(matchingBenefitActions(promised,[completed]),[]);
 assert.deepEqual(matchingBenefitActions(promised,[completed,promised]).map(a=>a.id),['second']);
 assert.equal(matchingBenefitActions({...completed,statementAt:'2026-07-11T05:54:25Z',evidenceQuote:'All reset.'},[completed,promised]).length,2);
 assert.deepEqual(matchingBenefitActions({...completed,statementAt:'2026-07-11T05:54:25Z',evidenceQuote:'Another usage reset has landed.'},[completed,promised]).map(a=>a.id),['second']);
});

test('another is not the negative word not; denial still blocks the same completion',()=>{
 const text='Another usage reset has landed for all Codex and ChatGPT Work users.';
 assert.equal(extractBenefitClaims(text,'2026-11-02T00:00:00Z')[0]?.stage,'claimed_complete');
 assert.equal(extractBenefitClaims(text.replace('has landed','has not landed'),'2026-11-02T00:00:00Z').length,0);
});

test('same-parent exact qualified completion restatement links proof; different rounds and wording remain separate',async()=>{
 const {equivalentCompletionOriginal}=await import('../src/server/benefit-signal');
 const {extractCadenceObservations}=await import('../src/server/reset-cadence-evidence');
 const {buildResetCadenceForecast}=await import('../src/lib/reset-cadence');
 const {TIBO_PUBLIC_SOURCE}=await import('../src/server/tibo-public');
 const first:Evidence={id:'first',sourceId:'tibo-public',messageId:'2094251180121854309',url:'https://x.com/thsottiaux/status/2094251180121854309',text:'We have reset usage limits for all paid Codex users. See you see.',hash:'first',parentId:'2093811840258293947',publishedAt:'2026-08-31T02:29:25Z',collectedAt:'2026-08-31T02:30:00Z',textOrigin:'original',provenance:'archive',contextComplete:true,historical:false,metadata:{sourceGroup:'fxembed:thsottiaux'}};
 const second:Evidence={...first,id:'second',messageId:'2094252447271366730',url:'https://x.com/thsottiaux/status/2094252447271366730',text:'We have reset usage limits for all paid Codex users. See you soon.',hash:'second',publishedAt:'2026-08-31T02:34:27Z',collectedAt:'2026-08-31T02:35:00Z'};
 assert.equal(equivalentCompletionOriginal(second,[first,second])?.id,first.id);
 for(const patch of [{parentId:'another-parent'},{text:second.text.replace('have reset','have reset again')},{publishedAt:'2026-08-31T03:34:27Z'},{text:second.text.replace('paid','free')},{provenance:'manual' as const}])assert.equal(equivalentCompletionOriginal({...second,...patch},[first,second]),undefined);
 assert.equal(equivalentCompletionOriginal(first,[first,second]),undefined,'future original never supplies proof');
 const observations=extractCadenceObservations([first,second],[{...TIBO_PUBLIC_SOURCE,enabled:true,validated:true}],'2026-08-31T03:00:00Z');
 assert.equal(observations.length,2,'both public originals stay available');assert.ok(observations.every(o=>o.evidenceIds.includes(first.id)));
 const forecast=buildResetCadenceForecast({observations,generatedAt:'2026-08-31T03:00:00Z',inputFingerprint:'qa'});assert.equal(forecast.observations.length,1);assert.equal(forecast.observations[0].at,'2026-08-31T02:29:25.000Z');
});
