import test from 'node:test';
import assert from 'node:assert/strict';
import {pool,list,one,put} from '../src/db';
import {createEvidence,defaultSite} from '../src/server/service';
import {runOne,scheduleDue} from '../src/server/worker';
import type {Article,Candidate,Evidence,Job,Publication,Source} from '../src/lib/types';

test('隔离库：同正文原文副本丢失父帖不能使已核验文章退级，冲突、暂停和人工保护保持有效',{skip:process.env.RADAR_OMISSION_INTEGRATION!=='1'},async()=>{
 const url=new URL(process.env.DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55489');assert.match(url.pathname,/^\/radar_qa_/);
 const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('隔离发布测试禁止网络和微信发送');};
 const worker={schedule:false,enrich:async()=>undefined,enrichQuoted:async()=>[],collect:async()=>{throw new Error('不得采集');},wechat:async()=>{throw new Error('不得发送');}};
 const drain=async()=>{for(let i=0;i<50;i++){await scheduleDue({skipSources:true,allowEnrichment:false});let n=0;for(;n<20;n++)if(!await runOne(worker))break;if(!n){if(!(await list<Job>('jobs')).some(j=>j.status==='queued'||j.status==='running'))return;await new Promise(resolve=>setTimeout(resolve,25));}}throw new Error('队列未收敛');};
 try{
  await put('settings',{id:'site',...defaultSite});await put('settings',{id:'ai',enabled:false,version:1});
  for(const id of ['direct','copy','excerpt'])await put('sources',{id,name:id,kind:'archive',url:'https://example.invalid/'+id,enabled:true,validated:true,status:'healthy',intervalMinutes:2,version:1,nextRunAt:'2100-01-01T00:00:00Z'} satisfies Source);
  for(const order of ['original-first','copy-first','parent-late']){
   const parentId='2105843926221660585',childId='2106131810921136451',origin='https://x.com/qa_'+order.replaceAll('-','_')+'/status/';
   const base={collectedAt:new Date().toISOString(),historical:true,provenance:'archive' as const,textOrigin:'original' as const,contextComplete:true,metadata:{category:'reset' as const}};
   const parent={...base,sourceId:'direct',messageId:parentId,url:origin+parentId,text:'We will reset usage limits for all paid accounts.',publishedAt:'2026-10-02T02:14:51.000Z'};
   const child={...base,sourceId:'direct',messageId:childId,url:origin+childId,text:'Reset all propagated. Enjoy.',publishedAt:'2026-10-02T21:18:48.000Z',parentId,contextComplete:false};
   const weak={...child,sourceId:'copy',parentId:undefined};
   if(order==='copy-first'){await createEvidence(weak);await drain();}
   if(order==='parent-late'){await createEvidence(child);await drain();}
   await createEvidence(parent);await drain();
   const original=await createEvidence(child);await drain();
   const candidate=original.candidate?(await one<Candidate>('candidates',original.candidate.id))!:(await list<Candidate>('candidates')).find(c=>c.evidenceId===original.evidence.id)!;
   assert.equal(candidate.status,'published',order+' '+JSON.stringify({candidate,jobs:await list('jobs')}));
   const canonical=(await one<Article>('articles',candidate.automation!.articleId!))!;assert.equal(canonical.publicationMode,'state_change');assert.equal(canonical.reviewStatus,undefined);
   const frozen=new Map((await list<Publication>('publications')).map(p=>[p.id,JSON.stringify(p)]));
   await put('articles',{...canonical,manualFields:['summary']});
   const copy=await createEvidence(weak);await drain();
   assert.equal((await one<Article>('articles',canonical.id))!.publicationId,canonical.publicationId,order);
   const processed=copy.candidate?(await one<Candidate>('candidates',copy.candidate.id))!:(await list<Candidate>('candidates')).find(c=>c.evidenceId===copy.evidence.id)!;assert.equal(processed.status,'published',order+' '+JSON.stringify(processed));
   assert.equal((await list<Publication>('publications')).length,frozen.size,'同正文弱副本不新增快照');
   await createEvidence({...weak,sourceId:'excerpt',textOrigin:'archive_excerpt',text:'额度重置已经传播。'});await drain();
   await createEvidence(weak);await drain();
   const retained=(await one<Article>('articles',canonical.id))!;assert.equal(retained.publicationId,canonical.publicationId);assert.deepEqual(retained.manualFields,['summary']);
   for(const p of await list<Publication>('publications'))assert.equal(JSON.stringify(p),frozen.get(p.id),'旧快照不可变');
   const conflict=await createEvidence({...weak,text:'Reset all propagated. More details tomorrow.'});await drain();
   const blocked=(await one<Candidate>('candidates',conflict.candidate!.id))!;assert.ok(blocked.reasons.some(reason=>/冲突/.test(reason)),JSON.stringify(blocked));
   assert.equal((await one<Article>('articles',canonical.id))!.publicationId,canonical.publicationId);
  }
  const source=(await one<Source>('sources','copy'))!;await put('sources',{...source,enabled:false,status:'paused'});
  const count=(await list<Publication>('publications')).length;
  const paused=await createEvidence({sourceId:'copy',messageId:'paused',url:'https://x.com/qa_paused/status/2106131810921136451',text:'Reset all propagated. Enjoy.',publishedAt:'2026-10-02T21:18:48.000Z',collectedAt:new Date().toISOString(),contextComplete:false,historical:true,provenance:'archive',textOrigin:'original'});await drain();
  assert.notEqual((await one<Candidate>('candidates',paused.candidate!.id))!.status,'published');assert.equal((await list<Publication>('publications')).length,count);
  assert.equal((await list('notices')).length,0);assert.equal((await list('wechat_deliveries')).length,0);assert.ok(!(await list<Job>('jobs')).some(j=>j.status==='failed'));
 }finally{globalThis.fetch=savedFetch;await pool.end();}
});
