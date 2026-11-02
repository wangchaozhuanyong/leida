import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool,list,one,put} from '../src/db';
import type {Source,Job,Candidate,Evidence,Notice,Publication,Article,Audit,DraftContent} from '../src/lib/types';
import {createEvidence,publishCandidate} from '../src/server/service';
import {scheduleDue,runOne} from '../src/server/worker';
import {defaultAI} from '../src/server/ai';
import {acceptSemanticReview} from '../src/server/semantic-benefit-review';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {gatherEvidenceContext} from '../src/server/source-context';
import {setTimeout as delay} from 'node:timers/promises';

test('isolated closure: cached review, partial recovery, immutable history and no repeated notifications', {skip:process.env.RADAR_INTEGRATION!=='1'},async t=>{
 const url=new URL(process.env.DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55489');assert.match(url.pathname,/^\/radar_qa_/);
 const tag=randomUUID(),at=new Date(Date.now()-2*3600_000).toISOString(),sourceId='closure-qa-'+tag;
 const source:Source={id:sourceId,name:'本地隔离事实闭环',kind:'archive',url:'https://example.invalid/qa',enabled:true,validated:true,intervalMinutes:60,version:1,status:'healthy',nextRunAt:'2100-01-01T00:00:00Z'};
 // Deliberately unusable placeholder. The injected generator/reviewer are the
 // only model seams in this fixture; no credential or network endpoint is used.
 const fixtureAI={...defaultAI,enabled:true,testedAt:at,encryptedKey:'TEST_ONLY_NOT_A_KEY',baseUrl:'https://example.invalid/v1',model:'local-fixture',dailyCallLimit:2,dailyBudget:1,inputPrice:1,outputPrice:1};
 const fixture=(text:string,suffix:string)=>createEvidence({sourceId,messageId:tag+'-'+suffix,url:'https://x.com/thsottiaux/status/'+tag+'-'+suffix,text,publishedAt:at,collectedAt:at,contextComplete:true,textOrigin:'original',provenance:'archive',historical:false});
 const enqueue=()=>scheduleDue({allowTemplates:true,allowEnrichment:false,skipSources:true});
 const generationJobs=async()=> (await list<Job>('jobs')).filter(j=>j.kind==='generate'&&j.status==='queued');
 // The Docker DB and host clocks can differ by a few milliseconds. A newly
 // queued job must become due before claiming; do not assume same-tick clocks.
 const runQueued=async(dependencies:Parameters<typeof runOne>[0])=>{
  for(let attempt=0;attempt<100;attempt++){
   if(await runOne(dependencies))return;
   await delay(20);
  }
  assert.fail('the queued fixture job did not become executable within 2 seconds');
 };
 let generated=0,reviewed=0;
 try{
  await put('sources',source);await put('settings',{id:'site',name:'本地隔离',description:'无外部请求',autoPublish:true,version:1});await put('settings',fixtureAI);
  await t.test('a source pause resumes from persisted proof without a second model request',async()=>{
   const saved=await fixture('We have restored the spent Codex budget to its original maximum for all paid users.','review');
   const original=JSON.stringify(await one<Evidence>('evidence',saved.evidence.id));
   const proposal=(context:Evidence[]):DraftContent=>({title:'额度恢复消息',summary:'发布者说明付费Codex账户已使用的额度恢复至原来上限。',translation:'',category:'reset',publicationMode:'state_change',contentOrigin:'generated',evidenceIds:context.map(e=>e.id),actions:[{id:'fixture',kind:'automatic_reset',stage:'claimed_complete',scope:'public',eligibility:'付费Codex账户',statementAt:context[0].publishedAt,evidenceIds:[context[0].id],evidenceQuote:context[0].text}]});
   const dependencies={schedule:false,allowTemplates:true,enrich:async()=>undefined,enrichQuoted:async()=>[],generate:async(context:Evidence[])=>{generated++;return proposal(context);},review:async(context:Evidence[],d:DraftContent,version:number)=>{
    reviewed++;const proof=acceptSemanticReview(context,d,{supported:true,actions:d.actions.map(a=>({supported:true,evidenceId:a.evidenceIds[0],evidenceQuote:a.evidenceQuote,kind:a.kind,stage:a.stage}))},version);
    assert.ok(proof);await put('sources',{...source,publicationPaused:true});return proof;
   }};
   await enqueue();assert.equal((await generationJobs()).length,1);await runQueued(dependencies);
   let candidate=(await one<Candidate>('candidates',saved.candidate!.id))!;
   assert.equal(candidate.status,'pending');assert.equal(candidate.reasons.length,1);assert.match(candidate.reasons[0],/来源.*暂停/);
   const proofs=(await list<Audit>('audits')).filter(a=>a.objectId===candidate.id&&a.action==='candidate.semantic_review');assert.equal(proofs.length,1);
   assert.equal((await list<Job>('jobs')).find(j=>j.candidateId===candidate.id)?.payload.blockedReason,'source');
   await put('sources',source);
   await put('settings',{...fixtureAI,version:2});
   await assert.rejects(publishCandidate(candidate.id,candidate.version,'worker','synthetic version mismatch',true),/证据|上下文|福利|完成/);
   await put('settings',fixtureAI);
   await enqueue();await runQueued(dependencies);
   candidate=(await one<Candidate>('candidates',candidate.id))!;
   assert.equal(candidate.status,'published');assert.equal(candidate.automation?.state,'ready');
   assert.equal(generated,1);assert.equal(reviewed,1);assert.equal((await list<Audit>('audits')).filter(a=>a.objectId===candidate.id&&a.action==='candidate.semantic_review').length,1);
   assert.equal(JSON.stringify(await one<Evidence>('evidence',saved.evidence.id)),original);
   assert.equal((await list<Article>('articles')).filter(a=>a.evidenceIds[0]===saved.evidence.id).length,1);
   const notices=(await list<Notice>('notices')).length,publications=JSON.stringify(await list<Publication>('publications'));
   await enqueue();assert.equal((await generationJobs()).length,0);assert.equal((await list<Notice>('notices')).length,notices);assert.equal(JSON.stringify(await list<Publication>('publications')),publications);
  });
  await t.test('a partial generated publication remains pending and can retry only on new input',async()=>{
   await put('settings',{...fixtureAI,version:2});
   const saved=await fixture('We have reset usage limits for all paid users. A reset is on the horizon for affected users.','partial');
   const generate=async(context:Evidence[])=>{generated++;return buildAutomaticTemplate(gatherEvidenceContext(context[0],context))!;};
   await scheduleDue({allowTemplates:false,allowEnrichment:false,skipSources:true});await runQueued({schedule:false,allowTemplates:false,generate,enrich:async()=>undefined,enrichQuoted:async()=>[]});
   let candidate=(await one<Candidate>('candidates',saved.candidate!.id))!;
   assert.equal(candidate.status,'published');assert.equal(candidate.automation?.state,'deferred');assert.ok(candidate.automation?.reasonCodes.includes('unparsed_benefit_clause'));assert.equal(candidate.automation?.templatePublished,true);
   const articleId=candidate.automation?.articleId,notices=(await list<Notice>('notices')).length,oldSnapshots=await list<Publication>('publications');
   await enqueue();assert.equal((await generationJobs()).length,0,'an unchanged unresolved clause must not cause an endless model loop');
   await put('settings',{...fixtureAI,version:3});await enqueue();assert.equal((await generationJobs()).length,1);await runQueued({schedule:false,allowTemplates:true,generate,enrich:async()=>undefined,enrichQuoted:async()=>[]});
   candidate=(await one<Candidate>('candidates',candidate.id))!;assert.equal(candidate.status,'published');assert.equal(candidate.automation?.articleId,articleId);assert.equal(candidate.automation?.state,'deferred');
   assert.equal((await list<Notice>('notices')).length,notices);assert.equal((await list<Article>('articles')).filter(a=>a.evidenceIds[0]===saved.evidence.id).length,1);
   for(const snapshot of oldSnapshots)assert.deepEqual(await one<Publication>('publications',snapshot.id),snapshot);
  });
 }finally{await pool.end();}
});
