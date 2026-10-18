import test from 'node:test';
import assert from 'node:assert/strict';
import {pool,put,list,transaction} from '../src/db';
import type {Candidate,Evidence,Job,Notice,Publication,Source} from '../src/lib/types';
import {createEvidence,defaultSite,getPublicData,publishHistoricalDraft,queueJob} from '../src/server/service';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {parseReferenceLatest,REFERENCE_RESET_SOURCE} from '../src/server/reference-reset-source';
import {parseReferenceOriginal} from '../src/server/source-enrichment';
import {generationCandidateOrder,runOne,scheduleDue} from '../src/server/worker';
import {publicResetOutlook} from '../src/lib/reset-outlook';

test('新消息优先、最新完成线索其次；普通历史仍按原文顺序且不改写事实',()=>{
 const at='2026-10-18T09:00:00.000Z';
 const item=(id:string,publishedAt:string,historical=true):Evidence=>({id,sourceId:'reset-archive',messageId:id,url:'https://example.invalid/'+id,text:'待核对',hash:id,publishedAt,collectedAt:at,contextComplete:false,historical,provenance:'archive',textOrigin:'archive_excerpt'});
 const lead=(e:Evidence):Evidence=>({...e,sourceId:REFERENCE_RESET_SOURCE.id,metadata:{sourceGroup:'aiplanwatch',benefitKind:'automatic_reset',referenceReset:{eventId:e.id,snapshotAt:at,occurredAt:e.publishedAt,referenceUrl:REFERENCE_RESET_SOURCE.url,summary:'Done'}}});
 const older=item('older','2026-10-01T01:00:00Z'),newer=item('newer','2026-10-02T01:00:00Z');
 const oldLead=lead(item('old-lead','2026-10-15T01:00:00Z')),latestLead=lead(item('latest-lead','2026-10-17T21:12:21Z'));
 const fresh=item('fresh','2026-10-18T08:30:00Z',false),rows=[older,newer,oldLead,latestLead,fresh];
 const candidates=rows.map((e):Candidate=>({id:'c-'+e.id,evidenceId:e.id,version:1,status:'pending',humanEdited:false,reasons:[],createdAt:at,updatedAt:at,content:{title:'待核对',summary:'',translation:'',category:'reset',actions:[],evidenceIds:[e.id]}}));
 const before=structuredClone({rows,candidates});
 assert.deepEqual(generationCandidateOrder(candidates,rows,Date.parse(at)).map(c=>c.evidenceId),['fresh','latest-lead','older','newer','old-lead']);
 assert.deepEqual({rows,candidates},before);
 for(const invalid of [{...latestLead,sourceId:'aiplanwatch-history'},{...latestLead,parentId:'another-round'},{...latestLead,metadata:{...latestLead.metadata,benefitKind:'banked_reset' as const}},{...latestLead,publishedAt:'2026-10-19T00:00:00Z'}]){
  const facts=[newer,invalid,older],selected=candidates.filter(c=>facts.some(e=>e.id===c.evidenceId));
  assert.deepEqual(generationCandidateOrder(selected,facts,Date.parse(at)).map(c=>c.evidenceId),['older','newer','latest-lead'],'未知历史、其他福利、不同父链或未来记录不能提权');
 }
});

test('历史积压不饿死最新完成对账：先核验原帖、结束旧倒计时且不补发历史提醒', {skip:process.env.RADAR_INTEGRATION!=='1'},async()=>{
 const db=new URL(process.env.DATABASE_URL!);
 assert.match(db.pathname,/^\/radar_qa_reference_priority_/,'必须使用独立的新建 QA 库');
 const stamp=Date.now(),time=(delta:number)=>new Date(Math.floor((stamp+delta)/1000)*1000).toISOString();
 const oldAt=time(-3_600_000*12),doneAt=time(-3_600_000),snapshotAt=time(0);
 const postId=((BigInt(Date.parse(doneAt))-1288834974657n)<<22n|1n).toString();
 const backlogSource:Source={id:'reset-archive',name:'隔离归档',kind:'archive',url:'https://codex-resets.com/zh-CN',enabled:true,validated:true,status:'healthy',intervalMinutes:60,version:1};
 try {
  await put('settings',{id:'site',...defaultSite,autoPublish:true});
  await put('settings',{id:'ai',enabled:false,version:1});
  await put('sources',backlogSource);
  await put('sources',{...REFERENCE_RESET_SOURCE,enabled:true,validated:true,publicationPaused:false,status:'healthy'});
  const promise=await createEvidence({sourceId:backlogSource.id,messageId:'promise-fixture',url:'https://x.com/thsottiaux/status/2100000000000000000',text:'We will reset usage for all accounts within 24 hours.',publishedAt:oldAt,collectedAt:oldAt,contextComplete:true,historical:true,provenance:'archive',textOrigin:'original'});
  await transaction(c=>publishHistoricalDraft(buildAutomaticTemplate([promise.evidence])!,c,'隔离历史预告'));
  await put('candidates',{...promise.candidate!,status:'ignored'});
  const backlog:Candidate[]=[];
  for(let i=0;i<12;i++){
   const messageId=(2000000000000000000n+BigInt(i)).toString();
   const record=await createEvidence({sourceId:backlogSource.id,messageId,url:`https://x.com/thsottiaux/status/${messageId}`,text:`待核对历史消息 ${i}`,publishedAt:time(-30*86_400_000+i*1000),collectedAt:snapshotAt,contextComplete:false,historical:true,provenance:'archive',textOrigin:'archive_excerpt'});
   backlog.push(record.candidate!);
  }
  const existingJob=await transaction(c=>queueJob('generate',{candidateId:backlog[0].id,historical:true,automatic:true,contextProbe:true,expectedVersion:1,evidencePublishedAt:time(-30*86_400_000)},c));
  const source={url:`https://x.com/thsottiaux/status/${postId}`};
  const record=parseReferenceLatest({schema_version:1,generated_at:snapshotAt,last_global_reset:{event_id:'priority-fixture',reset_type:'global',record_status:'recorded',occurred_at:doneAt,source},latest_signal:{signal_id:postId,recorded_at:doneAt,summary:'Done',source}},snapshotAt)[0];
  const latest=await createEvidence({...record,historical:true});
  assert.ok(publicResetOutlook(await getPublicData()).active,'修复前公开预告仍存在');
  await scheduleDue({skipSources:true});
  const queued=(await list<Job>('jobs')).filter(job=>job.status==='queued');
  assert.ok(queued.filter(job=>job.payload.historical===true).length<=2,'不提高原有历史任务限额');
  assert.ok(queued.some(job=>job.id===existingJob.id),'保留已经排队的旧任务，不取消或覆盖');
  assert.ok(queued.some(job=>job.candidateId===latest.candidate!.id),'最新完成线索必须在第一轮进入补证，不能排在十二条旧补证之后');
  assert.equal((await list<Publication>('publications')).length,1,'只排队不能把摘要直接当完成发布');
  assert.equal((await list<Evidence>('evidence')).find(e=>e.id===latest.evidence.id)?.textOrigin,'archive_excerpt');
  for(let i=0;i<12;i++){
   await runOne({schedule:false,enrich:async e=>e.sourceId===REFERENCE_RESET_SOURCE.id?parseReferenceOriginal({code:200,tweet:{id:postId,text:'Done',created_at:doneAt,author:{id:'1953337039510003712',screen_name:'thsottiaux'}}},e):undefined,enrichQuoted:async()=>[],collect:async()=>{throw new Error('禁止外部采集');},wechat:async()=>{throw new Error('禁止真实提醒');}});
   await scheduleDue({skipSources:true});
   if(publicResetOutlook(await getPublicData()).latestGlobalCompletionAt===doneAt)break;
  }
  const outlook=publicResetOutlook(await getPublicData());
  assert.equal(outlook.latestGlobalCompletionAt,doneAt);
  assert.equal(outlook.active,undefined);
  assert.equal(outlook.pendingReview?.length,1,'旧预告保留待核验，不伪造同轮完成关系');
  assert.equal((await list<Notice>('notices')).length,0,'历史补录不能补发通知');
  assert.ok((await list<Candidate>('candidates')).some(c=>backlog.some(old=>old.id===c.id)&&c.status==='pending'),'不清空或删除旧积压');
 } finally {await pool.end();}
});
