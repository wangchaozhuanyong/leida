import test from 'node:test';
import assert from 'node:assert/strict';
import {forecastSourceAvailable} from '../src/lib/forecast';
import {parseReferenceSignals,parseReferenceHistory,parseReferenceLatest,referenceCollectionHealth,REFERENCE_SIGNAL_SOURCE,REFERENCE_HISTORY_SOURCE} from '../src/server/reference-reset-source';
import {fetchRecords,sourceReadCheckpoint,validateSource,collectSource} from '../src/server/ingestion';
import {sourceForecastConfiguration} from '../src/server/source-collection-policy';
import {sourceCollectionDue} from '../src/server/worker';
import {pool,one,put,list} from '../src/db';
import type {Source,Evidence} from '../src/lib/types';

const checkedAt='2026-10-22T13:20:00.000Z',generatedAt='2026-10-20T06:41:53.619Z';
const messageId='2110951585983631505',source={url:`https://x.com/thsottiaux/status/${messageId}`};
const signals=()=>({schema_version:1,generated_at:generatedAt,signals:[{signal_id:messageId,signal_type:'forecast_source',recorded_at:'2026-10-16T04:30:52.000Z',summary:'公开信号摘要',source}]});
const history=()=>({schema_version:1,generated_at:generatedAt,events:[{event_id:'archived-reset',reset_type:'global',record_status:'recorded',occurred_at:'2026-10-16T04:30:52.000Z',source}]});

test('两天前的公开归档仍可发现原帖；保持原始时间且不生成完成证据',()=>{
 const signal=parseReferenceSignals(signals(),checkedAt)[0],record=parseReferenceHistory(history(),checkedAt)[0];
 for(const row of [signal,record]){
  assert.equal(row.publishedAt,'2026-10-16T04:30:52.339Z');assert.equal(row.collectedAt,checkedAt);
  assert.equal(row.textOrigin,'archive_excerpt');assert.equal(row.contextComplete,false);
  assert.equal(row.metadata?.referenceReset,undefined);
 }
 assert.equal(referenceCollectionHealth({...REFERENCE_HISTORY_SOURCE,enabled:true},checkedAt).status,'healthy');
});

test('读取成功和实时信号可用分开：过期显示延迟，重新检查及304不能洗新',async()=>{
 const row={...REFERENCE_SIGNAL_SOURCE,enabled:true,validated:true,status:'healthy' as const,lastSuccessAt:checkedAt,referenceSnapshotAt:generatedAt};
 const health=referenceCollectionHealth(row,checkedAt);assert.equal(health.status,'delayed');assert.match(health.error!,/快照尚未更新/);
 assert.equal(forecastSourceAvailable(row,checkedAt),false);
 assert.equal(forecastSourceAvailable({...row,referenceSnapshotAt:undefined},checkedAt),false);
 assert.equal(sourceCollectionDue({...row,...health},Date.parse(checkedAt)),true,'延迟来源仍继续定时检查');
 const records=await fetchRecords(row,false,{forceFullRead:true,onRequestEvent:async()=>{},fetcher:async()=>Response.json(signals(),{headers:{etag:'"old-signals"'}})});
 assert.equal(records.length,1);assert.equal(sourceReadCheckpoint(row)?.referenceSnapshotAt,generatedAt);
 const cached={...row,httpCheckpoints:sourceReadCheckpoint(row)!.httpCheckpoints};
 await fetchRecords(cached,false,{onRequestEvent:async()=>{},fetcher:async()=>new Response(null,{status:304})});
 assert.equal(sourceReadCheckpoint(cached)?.referenceSnapshotAt,generatedAt);
 assert.equal(referenceCollectionHealth({...row,referenceSnapshotAt:sourceReadCheckpoint(cached)?.referenceSnapshotAt},checkedAt).status,'delayed');
});

test('新快照恢复信号覆盖；未更新到期时立即停用投影；人工暂停保持关闭',()=>{
 const row={...REFERENCE_SIGNAL_SOURCE,enabled:true,validated:true,status:'healthy' as const,lastSuccessAt:checkedAt,referenceSnapshotAt:checkedAt};
 assert.equal(referenceCollectionHealth(row,checkedAt).status,'healthy');assert.equal(forecastSourceAvailable(row,checkedAt),true);
 const expired='2026-10-24T13:20:00.001Z';assert.equal(forecastSourceAvailable({...row,lastSuccessAt:expired},expired),false);
 assert.notEqual(sourceForecastConfiguration(row),sourceForecastConfiguration({...row,referenceSnapshotAt:generatedAt}));
 const paused={...row,enabled:false};assert.equal(referenceCollectionHealth(paused,checkedAt).status,'paused');assert.equal(sourceCollectionDue(paused),false);
});

test('归档兼容不接受未来快照、未知版本、原帖身份不一致或无效时间',()=>{
 for(const parse of [parseReferenceSignals,parseReferenceHistory]){
  const value=parse===parseReferenceSignals?signals():history();
  for(const invalid of [{...value,generated_at:'2026-10-23T00:00:00Z'},{...value,generated_at:'bad'},{...value,schema_version:2}])assert.throws(()=>parse(invalid,checkedAt));
  assert.throws(()=>parse(value,'invalid collection time'));
 }
 const invalid=signals();invalid.signals[0].signal_id='2110951585983631506';assert.throws(()=>parseReferenceSignals(invalid,checkedAt));
 assert.throws(()=>parseReferenceLatest({schema_version:1,generated_at:generatedAt,last_global_reset:null,latest_signal:null},checkedAt),/STALE/,'实时概要继续拒绝过期快照');
});

test('辅助来源超限先拒绝集合，不访问条目或放大逐项错误；1000条边界保持可读',()=>{
 for(const [parse,value,key] of [[parseReferenceSignals,signals(),'signals'],[parseReferenceHistory,history(),'events']] as const){
  let reads=0;
  const row=new Proxy({}, {get(){reads++;throw new Error('oversized rows must not be read');}});
  assert.throws(()=>parse({...value,[key]:Array(1001).fill(row)},checkedAt),(error:any)=>{
   assert.deepEqual(error.issues.map((issue:any)=>({code:issue.code,path:issue.path,maximum:issue.maximum})),[{code:'too_big',path:[key],maximum:1000}]);
   return true;
  });
  assert.equal(reads,0);
  const first=key==='signals'?signals().signals[0]:history().events[0];
  assert.equal(parse({...value,[key]:Array(1000).fill(first)},checkedAt).length,1000);
  assert.throws(()=>parse({...value,[key]:[{}]},checkedAt),'限内畸形条目仍按原规则拒绝');
 }
});

test('隔离库：验证保留关闭状态，恢复采集可读历史，304保留过期时间，新快照解除延迟',{skip:process.env.RADAR_REFERENCE_INTEGRATION!=='1'},async()=>{
 assert.match(new URL(process.env.DATABASE_URL!).pathname,/^\/radar_reference_qa_\d+$/);
 const fetchBefore=globalThis.fetch,at=new Date().toISOString(),old=new Date(Date.now()-72*3600_000).toISOString();
 const body=signals();body.generated_at=old;
 const source={...REFERENCE_SIGNAL_SOURCE,enabled:false,publicationPaused:true,pauseReason:'structure' as const,status:'failed' as const};
 let unchanged=false;
 globalThis.fetch=async()=>unchanged?new Response(null,{status:304}):Response.json(body,{headers:{etag:'"reference-integration"'}});
 try{
  await put('sources',source);
  await validateSource(source.id,'isolated-qa');
  const validated=(await one<Source>('sources',source.id))!;
  assert.equal(validated.enabled,false);assert.equal(validated.validated,true);assert.equal(validated.status,'paused');
  assert.equal((await list<Evidence>('evidence')).length,0,'验证不入业务证据');
  await put('sources',{...validated,enabled:true});
  const initial=await collectSource(source.id);assert.equal(initial.created,1);
  let saved=(await one<Source>('sources',source.id))!;
  assert.equal(saved.status,'delayed');assert.equal(saved.referenceSnapshotAt,old);assert.equal(saved.pauseReason,undefined);
  assert.equal(forecastSourceAvailable(saved),false);assert.equal((await list<Evidence>('evidence'))[0].historical,true);
  unchanged=true;await collectSource(source.id);saved=(await one<Source>('sources',source.id))!;
  assert.equal(saved.referenceSnapshotAt,old);assert.equal(saved.status,'delayed');
  unchanged=false;body.generated_at=at;
  const refreshed=await collectSource(source.id);saved=(await one<Source>('sources',source.id))!;
  assert.equal(refreshed.created,0);assert.equal(refreshed.healthChanged,true);assert.equal(saved.status,'healthy');
  assert.equal(saved.referenceSnapshotAt,at);assert.equal(forecastSourceAvailable(saved),true);
  assert.equal((await list('publications')).length,0);assert.equal((await list('wechat_deliveries')).length,0);
 }finally{globalThis.fetch=fetchBefore;await pool.end();}
});
