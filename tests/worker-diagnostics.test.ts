import test from 'node:test';
import assert from 'node:assert/strict';
import {safeWorkerFailure} from '../src/server/worker-timing';
import {CloudbaseRpcError} from '../src/server/cloudbase/rpc';
import {runOne} from '../src/server/worker';
import {timelineError,SourceTransientError,SourceStructureError,SourceConfigurationError,SourceRateLimitError} from '../src/server/ingestion';
import {TiboTimelineError} from '../src/server/tibo-timeline';

test('免费动态404及连接超时保留临时故障分类，限流、结构和配置错误分别处理',()=>{
 for(const message of ['免费动态接口暂不可用（状态 404）','免费动态接口暂时连接失败，将自动重试']){
  const error=timelineError(new TiboTimelineError(message,'transient'));
  assert.ok(error instanceof SourceTransientError);assert.equal(error.message,message);
 }
 assert.ok(timelineError(new TiboTimelineError('结构异常','structure')) instanceof SourceStructureError);
 assert.ok(timelineError(new TiboTimelineError('配置异常','configuration')) instanceof SourceConfigurationError);
 const retryAt='2026-10-19T00:00:00Z',limited=timelineError(new TiboTimelineError('来源限流','rate_limit',retryAt));
 assert.ok(limited instanceof SourceRateLimitError);assert.equal(limited.retryAt,retryAt);
});

test('后台诊断只保留阶段和白名单错误码，不暴露原始错误内容',()=>{
 const raw='fixture-sensitive-message';
 assert.equal(safeWorkerFailure(new CloudbaseRpcError('unknown',504,'REQUEST_TIMEOUT'),'generation_schedule'),'generation_schedule:CB_UNKNOWN_504_REQUEST_TIMEOUT');
 assert.equal(safeWorkerFailure({message:raw,code:raw},'claim'),'claim:UNCLASSIFIED');
 assert.equal(safeWorkerFailure({message:raw,cause:{code:'ECONNRESET',message:raw}},'input_read'),'input_read:ECONNRESET');
 assert.equal(safeWorkerFailure(new CloudbaseRpcError('rejected',403,raw),'source_schedule'),'source_schedule:CB_REJECTED_403_UNCLASSIFIED');
 assert.equal(safeWorkerFailure({name:'TimeoutError',message:raw},'job_collect'),'job_collect:REQUEST_TIMEOUT');
 assert.equal(safeWorkerFailure(new Error(raw),raw as any),'cycle:UNCLASSIFIED');
});

test('领取任务失败保留准确阶段，诊断钩子不替换原始错误或触发任务执行',async()=>{
 const previous=process.env.RADAR_STORAGE_BACKEND,stages:string[]=[];
 process.env.RADAR_STORAGE_BACKEND='isolated-invalid-backend';
 try{
  await assert.rejects(runOne({schedule:false,onStage:phase=>stages.push(phase)}),(error:unknown)=>{
   assert.ok(error instanceof CloudbaseRpcError);assert.equal(safeWorkerFailure(error,stages.at(-1) as any),'claim:CB_CONFIGURATION_0_UNCLASSIFIED');return true;
  });
  assert.deepEqual(stages,['claim']);
 }finally{if(previous===undefined)delete process.env.RADAR_STORAGE_BACKEND;else process.env.RADAR_STORAGE_BACKEND=previous;}
});
