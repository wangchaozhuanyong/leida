// Public frozen records only; no DB, model, collector or notification calls.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import type {Evidence,Source} from '../src/lib/types';
import {gatherEvidenceContext,evidenceBenefitClaims} from '../src/server/source-context';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {validateDraft} from '../src/server/domain';
import {extractCadenceObservations} from '../src/server/reset-cadence-evidence';
import {buildResetCadenceForecast} from '../src/lib/reset-cadence';
import {TIBO_PUBLIC_SOURCE,parseTiboPublicPage} from '../src/server/tibo-public';
const project=resolve(import.meta.dirname,'../../..'),out=resolve(import.meta.dirname,'../outputs/banked-recognition-20261101');
const baseline=resolve(project,'.codex-worktrees/release-completion-20261030');
const frozen=resolve(project,'.codex-worktrees/reset-state-training-fix-20261025/outputs/half-year-replay-20261025');
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const inputText=readFileSync(resolve(frozen,'input.json'),'utf8'),labelsText=readFileSync(resolve(frozen,'independent-classification.json'),'utf8');
const input=JSON.parse(inputText),labels=JSON.parse(labelsText);
const records:Evidence[]=input.records.map((r:Evidence)=>({...r,id:r.id??digest(r.sourceId+':'+r.messageId+':'+r.text),hash:digest(r.text),historical:true}));
const oldContext=await import(pathToFileURL(resolve(baseline,'src/server/source-context.ts')).href);
const oldTemplate=await import(pathToFileURL(resolve(baseline,'src/server/automatic-content.ts')).href);
const compare=records.map(primary=>{
 const available=records.filter(e=>Date.parse(e.collectedAt)<=Date.parse(primary.collectedAt)&&Date.parse(e.publishedAt)<=Date.parse(primary.collectedAt));
 const before=oldTemplate.buildAutomaticTemplate(oldContext.gatherEvidenceContext(primary,available));
 const context=gatherEvidenceContext(primary,available),after=buildAutomaticTemplate(context);
 const projectDraft=(d:any)=>d?{mode:d.publicationMode,review:d.reviewStatus??null,actions:d.actions.map((a:any)=>({kind:a.kind,stage:a.stage,eligibility:a.eligibility,timeNote:a.timeNote??null}))}:null;
 return {identity:(()=>{const u=new URL(primary.url),m=u.pathname.match(/^\/([^/]+)\/status\/([^/]+)/);return m?`x:${m[1].toLowerCase()}:${primary.messageId}`:`${primary.sourceId}:${primary.messageId}`;})(),textSha256:digest(primary.text),sourceId:primary.sourceId,messageId:primary.messageId,publishedAt:primary.publishedAt,collectedAt:primary.collectedAt,before:projectDraft(before),after:projectDraft(after),changed:JSON.stringify(projectDraft(before))!==JSON.stringify(projectDraft(after)),validation:after?validateDraft(after,context,true):[]};
});
const matchingLabels=labels.rows.map((row:any)=>({identity:row.identity,expected:row.expected,matches:compare.filter(r=>r.identity===row.identity&&r.textSha256===row.preferredTextSha256)}));
const sources:Source[]=[{...TIBO_PUBLIC_SOURCE,enabled:true,validated:true},
 {id:'reset-archive',kind:'archive',name:'冻结归档',url:'https://codex-resets.com/zh-CN',enabled:true,validated:true,status:'healthy',intervalMinutes:60,version:1}];
const obs=extractCadenceObservations(records,sources,'2026-11-01T04:00:48.551Z');
const cadence=buildResetCadenceForecast({observations:obs,target:'banked_reset',generatedAt:'2026-11-01T04:00:48.551Z',inputFingerprint:digest(inputText)});
const bankedAudit=records.filter(e=>/banked|reset bank|重置卡/i.test(e.text)).map(e=>{
 const context=gatherEvidenceContext(e,records.filter(x=>Date.parse(x.collectedAt)<=Date.parse(e.collectedAt)&&Date.parse(x.publishedAt)<=Date.parse(e.collectedAt)));
 const claims=evidenceBenefitClaims(e,context),observation=obs.find(o=>o.evidenceIds.includes(e.id));
 return {messageId:e.messageId,sourceId:e.sourceId,publishedAt:e.publishedAt,collectedAt:e.collectedAt,claims,observation:observation??null,
  reason:observation?'accepted_as_'+observation.kind:claims.some(c=>c.stage==='promised')?'announcement_not_completed':claims.some(c=>c.eligibility==='适用范围未说明')?'audience_unspecified_not_training_proof':'no_eligible_statement_or_not_latest_version'};
});
const candidateFingerprint=digest(['benefit-rules.ts','benefit-signal.ts','source-context.ts','automatic-content.ts','domain.ts','worker.ts','service.ts','ai.ts','reset-cadence-evidence.ts'].map(file=>file+'\0'+readFileSync(resolve(import.meta.dirname,'../src/server',file),'utf8')).join('\0'));
const realDir=resolve(project,'outputs/banked-reset-replay-20261101');
const realFeed=JSON.parse(readFileSync(resolve(realDir,'tibo-feed.json'),'utf8'));
const capturedAt=JSON.parse(readFileSync(resolve(realDir,'full.json'),'utf8')).data.serverTime;
const normalized=parseTiboPublicPage(realFeed,capturedAt).records;
const realPosts:Evidence[]=['2116405414921384099','2116692529970311254'].map(messageId=>{const record=normalized.find(e=>e.messageId===messageId);if(!record)throw Error('Frozen real post missing');return {...record,id:digest(record.url),hash:digest(record.text),historical:true};});
const realReplay=realPosts.map((primary,index)=>{const available=realPosts.slice(0,index+1),context=gatherEvidenceContext(primary,available),draft=buildAutomaticTemplate(context);return {messageId:primary.messageId,publishedAt:primary.publishedAt,checkedAt:capturedAt,firstProductionCollectionTimeNotInferred:true,parentId:primary.parentId??null,textSha256:digest(primary.text),contextIds:context.map(e=>e.messageId),draft,validation:draft?validateDraft(draft,context,true):null};});
writeFileSync(resolve(out,'real-post-replay.json'),JSON.stringify({candidateFingerprint,realModelCalls:0,productionWrites:0,mode:'frozen text interpretation in publication order, not proof of an advance prediction',results:realReplay},null,2)+'\n');
const report={candidateFingerprint,generatedAt:new Date().toISOString(),mode:'local interpretation comparison using actual recorded collection times; not a live advance-prediction backtest',
 baseline:'8f01c9a21bde1e9528bceb011e3ff846c2ed0fd3',inputSha256:digest(inputText),labelsSha256:digest(labelsText),records:records.length,independentLabels:labels.rows.length,
 changed:compare.filter(r=>r.changed),newValidationFailures:compare.filter(r=>r.changed&&r.validation.length),
 labelCoverage:matchingLabels.map((r:any)=>({identity:r.identity,expected:r.expected,matched:r.matches.length,changed:r.matches.some((x:any)=>x.changed)})),
 cadence,bankedTrainingStatements:obs.filter(o=>o.kind==='banked_reset'),bankedAudit,rows:compare,
 productionWrites:0,modelCalls:0,historicalNotifications:0,note:'This frozen input ends before the new Oct31/Nov1 posts. Unchanged labelled cases do not establish correctness of unrelated historical cases. Public-source first-known times are preserved; no source discovery is backdated.'};
mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'historical-comparison.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({records:report.records,independentLabels:report.independentLabels,changed:report.changed.length,newValidationFailures:report.newValidationFailures.length,matchedLabels:matchingLabels.filter((x:any)=>x.matches.length).length,changedLabels:matchingLabels.filter((x:any)=>x.matches.some((r:any)=>r.changed)).map((x:any)=>({identity:x.identity,expected:x.expected})),bankedTrainingStatements:report.bankedTrainingStatements.length,normalizedBankedObservations:cadence.observations.filter(o=>o.kind==='banked_reset').length,merged:cadence.mergedCount,sampleCount:cadence.sampleCount},null,2));
