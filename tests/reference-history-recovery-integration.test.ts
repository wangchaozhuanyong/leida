import test from 'node:test';
import assert from 'node:assert/strict';
import {pool,list,one,put} from '../src/db';
import {createEvidence,defaultSite} from '../src/server/service';
import {runOne,scheduleDue} from '../src/server/worker';
import {parseReferenceHistory,parseReferenceHistoricalLatest,REFERENCE_HISTORY_SOURCE} from '../src/server/reference-reset-source';
import {parseReferenceOriginal,enrichKnownEvidence} from '../src/server/source-enrichment';
import {evidenceFingerprint} from '../src/server/automatic-content';
import type {Article,Candidate,Evidence,Job,Notice,Publication,RadarEvent} from '../src/lib/types';

test('隔离库：10月18日旧Done候选补证后只计一条记录，保留旧证据且不发历史提醒',{skip:process.env.RADAR_REFERENCE_HISTORY_INTEGRATION!=='1'},async()=>{
 const address=new URL(process.env.DATABASE_URL!);
 assert.equal(address.hostname,'127.0.0.1');assert.equal(address.port,'55489');
 assert.match(address.pathname,/^\/radar_qa_reference_history_\d+$/);assert.equal(process.env.RADAR_STORAGE_BACKEND,'native');
 const messageId='2111566005684289735',url=`https://x.com/thsottiaux/status/${messageId}`,sha='1ccf5ec6f08d1b17e79c5234918e270ccaf53de7';
 const publishedAt='2026-10-17T21:12:21.000Z',snapshotAt='2026-10-17T21:41:52.431Z',collectedAt=new Date().toISOString();
 const snapshot={schema_version:1,generated_at:snapshotAt,last_global_reset:{event_id:'57205f59-83a4-43e2-99bc-07916b1046d0',reset_type:'global',record_status:'recorded',occurred_at:publishedAt,source:{url}},latest_signal:{signal_id:messageId,recorded_at:publishedAt,summary:'Done',source:{url}}};
 const incoming=parseReferenceHistory({schema_version:1,generated_at:snapshotAt,events:[snapshot.last_global_reset]},collectedAt)[0];
 const original=parseReferenceOriginal({code:200,tweet:{id:messageId,text:'Done',created_at:'Sat Oct 17 21:12:21 +0000 2026',author:{screen_name:'thsottiaux',id:'1953337039510003712'}}},{...incoming,id:'fixture',hash:'fixture',historical:true},collectedAt)!;
 const offlineFetch:typeof fetch=async input=>Response.json(String(input).startsWith('https://api.github.com/')?[{sha,commit:{committer:{date:'2026-10-17T21:41:56Z'}}}]:snapshot);
 const liveFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('隔离测试禁止外网、AI及微信发送');};
 try {
  assert.equal((await list<Evidence>('evidence')).length,0,'只在新建隔离库运行');
  await put('sources',{...REFERENCE_HISTORY_SOURCE,enabled:true,validated:true,publicationPaused:false,status:'healthy',nextRunAt:'2100-01-01T00:00:00Z'});
  await put('settings',{id:'site',...defaultSite,autoPublish:true});await put('settings',{id:'ai',enabled:false,version:1});
  const {id:_id,hash:_hash,...input}=original;
  const initial=await createEvidence(input),oldEvidence=await one<Evidence>('evidence',initial.evidence.id);
  const drain=async(recover:boolean,unavailable=false)=>{
   for(let cycle=0;cycle<12;cycle++){
    await scheduleDue({skipSources:true,allowEnrichment:recover});
    let ran=0;for(;ran<10;ran++)if(!await runOne({schedule:false,allowTemplates:true,enrich:recover&&!unavailable?e=>enrichKnownEvidence(e,offlineFetch):async()=>undefined,enrichQuoted:async()=>[],wechat:async()=>{throw new Error('不能发送历史通知');}}))break;
    if(!ran){
     if(!(await list<Job>('jobs')).some(j=>['queued','running'].includes(j.status)))return;
     // The database and host clocks may differ by a few milliseconds.
     await new Promise(resolve=>setTimeout(resolve,100));
    }
   }
   throw new Error('隔离队列未收敛');
  };
  await drain(false);
  const oldPublications=new Map((await list<Publication>('publications')).map(p=>[p.id,structuredClone(p)]));
  assert.equal((await list<Article>('articles')).filter(a=>a.publicationMode==='state_change').length,0,'裸Done不能直接发布重置完成');
  const pending=(await one<Candidate>('candidates',initial.candidate!.id))!;
  await put('candidates',{...pending,automation:{state:'deferred',reasonCodes:['rule_unsupported'],dependencyIds:[],inputFingerprint:evidenceFingerprint([initial.evidence]).replace(/^[^:]+:/,'older-rules:'),resumeAt:'2026-10-01T00:00:00Z'}});
  await drain(true,true);
  const waiting=(await one<Candidate>('candidates',pending.id))!;
  assert.ok(Date.parse(waiting.automation!.resumeAt!)>Date.now(),'归档不可用时保持冷却，不连续重试');
  const cooledJobs=(await list<Job>('jobs')).length;
  await scheduleDue({skipSources:true,allowEnrichment:true});
  assert.equal((await list<Job>('jobs')).length,cooledJobs);
  await put('candidates',{...waiting,automation:{...waiting.automation!,resumeAt:'2026-10-01T00:00:00Z'}});
  await drain(true);
  const articles=(await list<Article>('articles')).filter(a=>a.status==='published'&&a.publicationMode==='state_change');
  assert.equal(articles.length,1,'旧候选应经真实worker发布一条完成公告');
  const publication=(await one<Publication>('publications',articles[0].publicationId!))!;
  assert.equal(publication.event.actions[0].kind,'automatic_reset');assert.equal(publication.event.actions[0].stage,'claimed_complete');
  assert.equal(publication.event.actions[0].statementAt,original.publishedAt);assert.equal(publication.article.historical,true);
  assert.deepEqual(await one<Evidence>('evidence',initial.evidence.id),oldEvidence);
  for(const [id,snapshot] of oldPublications)assert.deepEqual(await one<Publication>('publications',id),snapshot);
  const recovered=(await list<Evidence>('evidence')).find(e=>e.metadata?.referenceReset?.referenceUrl.includes(sha))!;assert.ok(recovered);
  const {id:__id,hash:__hash,...repeatInput}=recovered;
  assert.equal((await createEvidence({...repeatInput,collectedAt:new Date().toISOString()})).created,false);
  const beforeReplay=await list<Publication>('publications');
  // New provenance may append an immutable revision, but must not create a second reset.
  const oldSnapshot=parseReferenceHistoricalLatest(snapshot,sha,new Date().toISOString())[0];
  await createEvidence({...oldSnapshot,sourceId:REFERENCE_HISTORY_SOURCE.id,historical:true});
  await drain(true);
  const afterReplay=await list<Publication>('publications');
  assert.equal((await list<Article>('articles')).length,1);
  assert.equal((await list<RadarEvent>('events')).length,1);
  assert.equal(new Set(afterReplay.map(p=>p.eventId)).size,1);
  for(const saved of beforeReplay)assert.deepEqual(await one<Publication>('publications',saved.id),saved);
  assert.equal((await list<Notice>('notices')).length,0);
  const jobs=await list<Job>('jobs');assert.equal(jobs.filter(j=>j.kind==='wechat_send').length,0);
  assert.equal(jobs.filter(j=>j.status==='failed').length,0);
 }finally{globalThis.fetch=liveFetch;await pool.end();}
});
