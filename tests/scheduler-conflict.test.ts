import test from 'node:test';
import assert from 'node:assert/strict';
import {list,insert,put} from '../src/db';
import {cloudbaseStore} from '../src/server/cloudbase/store';
import {CloudbaseRpc,CloudbaseRpcError} from '../src/server/cloudbase/rpc';
import {createWorkerCadence,retrySchedulingConflict} from '../src/server/worker-timing';

const at='2026-10-18T15:00:00.000Z';
const page=(fingerprint:string,rows:unknown[],more=false,after:string|null=null)=>({fingerprint,rows,more,after});
const row=(id:string,version:number)=>({id,payload:{id,version},createdAt:at});

test('调度分页遇到版本冲突后重读完整快照，只提交基于新数据的一份任务',async()=>{
 let sourceReads=0,commits=0,passes=0;
 const committed:Array<{table:string;value:{id:string;version?:number}}>=[];
 const rpc=new CloudbaseRpc('leida-test-qa','qa-only',async(input,init)=>{
  const params=JSON.parse(String(init?.body));
  if(String(input).endsWith('/radar_cb_store_read')){
   if(params.p_table==='sources'){
    sourceReads++;
    return Response.json(sourceReads===1?page('a'.repeat(32),[row('source',1)],true,'next'):page('b'.repeat(32),[row('source',2)]));
   }
   assert.equal(params.p_table,'jobs');return Response.json(page('c'.repeat(32),[]));
  }
  assert.ok(String(input).endsWith('/radar_cb_store_commit'));commits++;
  assert.equal(params.p_expected.sources,'b'.repeat(32));
  committed.push(...params.p_changes);return Response.json(true);
 });
 const store=cloudbaseStore(rpc);
 await retrySchedulingConflict(()=>store.transaction(async client=>{
  passes++;
  const [source]=await list<{id:string;version:number}>('sources',client);
  await put('sources',{...source,version:source.version+1},client);
  await insert('jobs',{id:`job-${source.version}`},client);
 }));
 assert.equal(passes,2);assert.equal(sourceReads,3);assert.equal(commits,1);
 assert.deepEqual(committed.map(change=>[change.table,change.value.id,change.value.version]),[['sources','source',3],['jobs','job-2',undefined]]);
});

test('数据库明确拒绝提交的40001可重建调度事务，成功提交只有一次',async()=>{
 let commits=0,reads=0,persisted=0;
 const rpc=new CloudbaseRpc('leida-test-qa','qa-only',async(input)=>{
  if(String(input).endsWith('/radar_cb_store_read')){reads++;return Response.json(page((reads===1?'a':'b').repeat(32),[]));}
  if(++commits===1)return Response.json({code:'DATABASE_40001'},{status:409});
  persisted++;return Response.json(true);
 });
 const store=cloudbaseStore(rpc);
 await retrySchedulingConflict(()=>store.transaction(async client=>{await insert('jobs',{id:'same-job'},client);}));
 assert.equal(commits,2);assert.equal(reads,2);assert.equal(persisted,1);
});

test('提交后丢失回执属于结果未知，调度不得自动重发产生重复任务',async()=>{
 let commits=0,persisted=0;
 const rpc=new CloudbaseRpc('leida-test-qa','qa-only',async(input)=>{
  if(String(input).endsWith('/radar_cb_store_read'))return Response.json(page('a'.repeat(32),[]));
  commits++;persisted++;throw Object.assign(new Error('isolated network failure'),{code:'ECONNRESET'});
 });
 const store=cloudbaseStore(rpc);
 await assert.rejects(retrySchedulingConflict(()=>store.transaction(async client=>{await insert('jobs',{id:'same-job'},client);})),error=>error instanceof CloudbaseRpcError&&error.kind==='unknown');
 assert.equal(commits,1);assert.equal(persisted,1);
});

test('持续冲突最多重读一次，保留调度十五秒失败退避而非成功扫描窗口',async()=>{
 let now=0,calls=0;
 const cadence=createWorkerCadence(()=>now),failure=new CloudbaseRpcError('conflict');
 const scan=()=>cadence.run('generation',()=>retrySchedulingConflict(async()=>{calls++;throw failure;}));
 await assert.rejects(scan(),error=>error===failure);assert.equal(calls,2);
 now=14999;await scan();assert.equal(calls,2);
 now=15000;await assert.rejects(scan(),error=>error===failure);assert.equal(calls,4);
});

test('配置、权限、未知和响应错误均不进入调度冲突重试',async()=>{
 for(const error of [new CloudbaseRpcError('configuration'),new CloudbaseRpcError('rejected',403,'42501'),new CloudbaseRpcError('unknown'),new CloudbaseRpcError('response'),new Error('fixture')]){
  let calls=0;
  await assert.rejects(retrySchedulingConflict(async()=>{calls++;throw error;}),actual=>actual===error);
  assert.equal(calls,1);
 }
});
