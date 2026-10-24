import test from 'node:test';
import assert from 'node:assert/strict';
import {pool,list,one,put,insert} from '../src/db';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import type {Candidate,Evidence,Job,Publication,Source} from '../src/lib/types';
import {buildAutomaticTemplate,evidenceFingerprint} from '../src/server/automatic-content';
import {fingerprintChange,runOne,scheduleDue} from '../src/server/worker';
import {createEvidence,defaultSite,providerIdentity} from '../src/server/service';
import {validateDraft} from '../src/server/domain';
import {getPublicRead} from '../src/server/public-read';
import {parseCodexLimitsObservations} from '../src/server/codexlimits-observation-source';
import {REFERENCE_RESET_SOURCE} from '../src/server/reference-reset-source';
import {resetObservations} from '../src/lib/reset-observations';
const require=createRequire(import.meta.url),{selectedHomeStatus}=require('../miniprogram/utils/home-reset-status');
const oldTitle='来源观测：Codex 用量已重置';
function observation():Evidence {
 const now=new Date().toISOString();
 return {id:'isolated-observation',sourceId:'reset-archive',messageId:'observed-2113492502355562875',url:'https://x.com/thsottiaux/status/2113492502355562875',text:'Codex 使用限额已重置。查看你的限额。',publishedAt:'2026-10-23T17:00:00.000Z',collectedAt:now,contextComplete:false,historical:true,hash:'isolated',provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'reset'}};
}
test('严格核验的观测身份独立于借用链接的预告，跨来源同一观测仍归为一条',()=>{
 const e=observation(),original={...e,messageId:'2113492502355562875',sourceId:'tibo-public',textOrigin:'original' as const};
 assert.notEqual(providerIdentity(e),providerIdentity(original));
 const reference={...e,sourceId:'aiplanwatch-reference',metadata:{sourceGroup:'aiplanwatch',benefitKind:'automatic_reset' as const,referenceReset:{eventId:'isolated',occurredAt:e.publishedAt,snapshotAt:e.collectedAt,referenceUrl:'https://raw.githubusercontent.com/gdutxiaoxu/codex-reset-radar/master/data/latest.json',summary:e.text}}};
 assert.equal(providerIdentity(reference),providerIdentity(e));
 assert.notEqual(providerIdentity({...e,publishedAt:'2026-10-23T17:10:00.000Z'}),providerIdentity(e));
 assert.equal(providerIdentity({...e,sourceId:'manual'}),providerIdentity(original),'伪造观测不能绕开原帖身份保护');
});
test('模板修订仅使有效观测指纹升级；中性标题过事实校验，观测不伪造完成动作',()=>{
 const e=observation(),current=evidenceFingerprint([e]),previous=current.replace('-observation-template-2','');
 assert.equal(fingerprintChange(previous,current),'rules');
 const draft=buildAutomaticTemplate([e])!;assert.equal(draft.title,'来源观测：Codex 用量重置记录');assert.deepEqual(validateDraft(draft,[e],true),[]);assert.deepEqual(draft.actions,[]);
 assert.ok(validateDraft({...draft,title:oldTitle},[e],true).includes('标题宣称完成，但动作尚无完成状态'));
 const original={...e,messageId:'2113492502355562875',textOrigin:'original' as const};
 assert.ok(!evidenceFingerprint([original]).includes('observation-template-2'));
 assert.ok(!evidenceFingerprint([{...e,sourceId:'manual'}]).includes('observation-template-2'));
});
test('隔离库：已生成但被校验卡住的旧观测重新生成发布，只恢复一次且保留人工与暂停保护',{skip:process.env.RADAR_RECORD_RECOVERY_INTEGRATION!=='1'},async()=>{
 const url=new URL(process.env.DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55489');assert.match(url.pathname,/^\/radar_qa_record_[a-z0-9_]+$/);
 const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('隔离恢复测试禁止外部请求');};
 const source:Source={id:'reset-archive',name:'隔离观测来源',kind:'archive',url:'https://codex-resets.com/zh-CN',enabled:true,validated:true,status:'healthy',intervalMinutes:30,version:1,nextRunAt:'2100-01-01T00:00:00Z'};
 const worker={schedule:false,enrich:async()=>undefined,enrichQuoted:async()=>[],wechat:async()=>{throw new Error('禁止真实微信通知');}};
 try{
  await put('settings',{id:'site',...defaultSite,autoPublish:true});await put('settings',{id:'ai',enabled:false,version:1});await put('sources',source);
  const {id:_id,hash:_hash,...input}=observation(),created=await createEvidence(input),e=created.evidence;
  const persist=async(p:Publication)=>{await put('events',p.event);await put('articles',p.article);await insert('publications',p);};
  // Production-shaped collision: an observation borrows an already-published
  // forecast post's URL. It is not another version of that original statement.
  const original:Evidence={...e,id:'qa-original-evidence',sourceId:'tibo-public',messageId:'2113492502355562875',text:'We will reset usage limits for all Codex users before 10am PST tomorrow.',publishedAt:'2026-10-23T04:47:34.010Z',collectedAt:'2026-10-23T04:48:00.000Z',hash:'qa-original',textOrigin:'original',contextComplete:true,historical:false,metadata:{sourceGroup:'fxembed:thsottiaux'}};
  await insert('evidence',original);
  const promise:Publication={id:'promise-publication',eventId:'promise-event',articleId:'promise-article',mode:'state_change',publishedAt:original.publishedAt,cutoffAt:original.publishedAt,reason:'isolated original forecast',event:{id:'promise-event',publicationId:'promise-publication',title:'隔离原帖预告',status:'published',version:1,updatedAt:original.publishedAt,evidenceIds:[original.id],actions:[{id:'same-round',kind:'automatic_reset',scope:'public',stage:'promised',statementAt:original.publishedAt,expectedAt:'2026-10-23T18:00:00.000Z',evidenceIds:[original.id],evidenceQuote:original.text,eligibility:'全部Codex用户'}]},article:{id:'promise-article',eventId:'promise-event',publicationId:'promise-publication',title:'隔离原帖预告',summary:'布局隔离来源预告，非真实用户数据。',translation:'',category:'reset',status:'published',version:1,publishedAt:original.publishedAt,sourcePublishedAt:original.publishedAt,updatedAt:original.publishedAt,evidenceIds:[original.id],publicationMode:'state_change',contentOrigin:'template',historical:false}};
  await persist(promise);
  const draft={...buildAutomaticTemplate([e])!,title:oldTitle},fingerprint=evidenceFingerprint([e]).replace('-observation-template-2',''),at=new Date(Date.now()-3600000).toISOString();
  const candidate:Candidate={...created.candidate!,version:2,status:'pending',humanEdited:false,content:draft,reasons:['标题宣称完成，但动作尚无完成状态'],automation:{state:'waiting_evidence',reasonCodes:['validation_pending'],dependencyIds:[],inputFingerprint:fingerprint,evaluatedAt:at,resumeAt:at}};
  await put('candidates',candidate);
  await put('jobs',{id:'old-generated-job',kind:'generate',candidateId:candidate.id,status:'succeeded',attempts:1,createdAt:at,availableAt:at,finishedAt:at,payload:{generated:true,generatedCandidateVersion:2,inputFingerprint:fingerprint}} satisfies Job);
  const human={...candidate,id:'protected-human',humanEdited:true};await put('candidates',human);
  await scheduleDue({skipSources:true});
  const queued=(await list<Job>('jobs')).filter(j=>j.status==='queued'&&j.candidateId===candidate.id);assert.equal(queued.length,1);assert.notEqual(queued[0].payload.contextProbe,true,'规则更新必须进入生成，不能只检查原文');
  for(let i=0;i<40;i++){await runOne(worker);if((await one<Candidate>('candidates',candidate.id))!.status==='published')break;await new Promise(resolve=>setTimeout(resolve,25));}
  const recovered=(await one<Candidate>('candidates',candidate.id))!;assert.equal(recovered.status,'published');assert.equal(recovered.content.title,'来源观测：Codex 用量重置记录');assert.deepEqual(recovered.content.actions,[]);
  const publications=(await list<Publication>('publications')).filter(p=>p.id!==promise.id);assert.equal(publications.length,1);assert.equal(publications[0].mode,'news_only');assert.deepEqual(publications[0].event.actions,[]);assert.notEqual(publications[0].eventId,promise.eventId);assert.deepEqual(await one('publications',promise.id),promise);assert.deepEqual(await one('events',promise.eventId),promise.event);
  assert.equal((await list('notices')).length,0);assert.equal((await list('wechat_deliveries')).length,0);
  await scheduleDue({skipSources:true});assert.equal((await list<Job>('jobs')).filter(j=>j.status==='queued'&&j.candidateId===candidate.id).length,0);assert.equal((await list('publications')).length,2);
  assert.deepEqual(await one<Candidate>('candidates',human.id),human);
  await put('sources',{...REFERENCE_RESET_SOURCE,enabled:true,validated:true,publicationPaused:false,status:'healthy',nextRunAt:'2100-01-01T00:00:00Z'});
  const reference={...input,sourceId:'aiplanwatch-reference',metadata:{sourceGroup:'aiplanwatch',benefitKind:'automatic_reset' as const,referenceReset:{eventId:'qa-cross-source',occurredAt:e.publishedAt,snapshotAt:e.collectedAt,referenceUrl:REFERENCE_RESET_SOURCE.url,summary:e.text}}};
  const repeated=await createEvidence(reference);assert.ok(repeated.candidate);await scheduleDue({skipSources:true});
  for(let i=0;i<40;i++){await runOne(worker);if((await one<Candidate>('candidates',repeated.candidate.id))!.status==='published')break;await new Promise(resolve=>setTimeout(resolve,25));}
  const repeatedResult=(await one<Candidate>('candidates',repeated.candidate.id))!;assert.equal(repeatedResult.status,'published');assert.equal(repeatedResult.content.eventId,recovered.content.eventId,'同一观测跨来源复用观测事件，不复用预告');assert.deepEqual(repeatedResult.content.actions,[]);
  const allObservations=await getPublicRead({view:'calendar'});assert.equal(resetObservations(allObservations.data).length,1,'两个来源同一观测只显示一条');assert.deepEqual(await one('events',promise.eventId),promise.event);
  assert.equal((await list('notices')).length,0);assert.equal((await list('wechat_deliveries')).length,0);
  // The earlier proof must survive the real compact-home SQL even after newer
  // unrelated reset news displaces it from the three-card feed.
  const raw=parseCodexLimitsObservations(readFileSync(new URL('./fixtures/codexlimits-reset-observations.html',import.meta.url),'utf8'),e.collectedAt).find(item=>item.publishedAt==='2026-10-23T17:40:00.000Z')!;
  assert.ok(raw);const later={...raw,id:'later-observation',hash:'later-isolated',historical:true};await insert('evidence',later);
  const p=structuredClone(publications[0]);p.id='later-publication';p.eventId=p.event.id='later-event';p.articleId=p.article.id='later-article';p.event.publicationId=p.article.publicationId=p.id;p.article.eventId=p.eventId;
  Object.assign(p.article,buildAutomaticTemplate([later]));p.event.evidenceIds=p.article.evidenceIds=[later.id];await persist(p);
  for(let i=0;i<4;i++){const noise=structuredClone(p);noise.id='noise-'+i;noise.eventId=noise.event.id='noise-event-'+i;noise.articleId=noise.article.id='noise-article-'+i;noise.event.publicationId=noise.article.publicationId=noise.id;noise.article.eventId=noise.eventId;noise.event.evidenceIds=noise.article.evidenceIds=[];noise.article.sourcePublishedAt=e.collectedAt;await persist(noise);}
  const compact=await getPublicRead({view:'home'});assert.ok(resetObservations(compact.data).some(o=>o.observedAt===e.publishedAt),'精简接口保留较早观测');assert.ok(compact.data.publications.some(p=>p.id==='later-publication'));
  const home=selectedHomeStatus(compact.data,'automatic_reset');assert.equal(home.clockAt,e.publishedAt,JSON.stringify({rounds:compact.data.publications.filter(p=>p.event.actions.length).map(p=>p.event.actions),observations:require('../miniprogram/utils/reset-observations').resetObservations(compact.data),clockAt:home.clockAt,roundKey:home.roundKey}));
  await put('sources',{...source,enabled:false,status:'paused'});await put('candidates',{...candidate,id:'protected-paused'});await scheduleDue({skipSources:true});
  assert.equal((await list<Job>('jobs')).filter(j=>j.candidateId==='protected-paused').length,0);
 }finally{globalThis.fetch=oldFetch;await pool.end();}
});
