import test from 'node:test';
import assert from 'node:assert/strict';
import {workerRuntimeStatus} from '../src/lib/automation';

const time=Date.parse('2026-10-12T00:00:00Z');
test('任务健康不能用新鲜心跳掩盖已报告故障',()=>{
 const heartbeatAt=new Date(time-20_000).toISOString();
 assert.equal(workerRuntimeStatus({heartbeatAt},time),'healthy');
 assert.equal(workerRuntimeStatus({heartbeatAt,error:'预测观察暂时异常'},time),'failed');
 assert.equal(workerRuntimeStatus({heartbeatAt,error:undefined},time),'healthy');
});
test('缺失、非法、未来及过期心跳均不能显示健康',()=>{
 assert.equal(workerRuntimeStatus(undefined,time),'unobserved');
 assert.equal(workerRuntimeStatus({},time),'unobserved');
 for(const heartbeatAt of ['invalid',new Date(time+1).toISOString(),new Date(time-180_000).toISOString()]){
  assert.equal(workerRuntimeStatus({heartbeatAt},time),'stale');
 }
 assert.equal(workerRuntimeStatus({heartbeatAt:new Date(time-179_999).toISOString()},time),'healthy');
});
test('预测计算故障暂停当前实验展示，公告状态和固定历史记录仍可读取',async()=>{
 const {getPublicForecast}=await import('../src/server/forecast');
 let status='error';
 const client={async query(sql:string){
  if(sql.includes('to_regclass'))return {rows:[{cases:true,snapshots:true,outcomes:true}]};
  if(sql.includes('FROM radar_settings'))return {rows:[{payload:{id:'forecast_runtime',status,checkedAt:new Date(time).toISOString()}}]};
  if(sql.startsWith('SELECT payload FROM radar_'))return {rows:[]};
  throw new Error('Unexpected forecast QA query');
 }};
 const facts={events:[],articles:[],publications:[],evidence:[],serverTime:new Date(time).toISOString()};
 const failed=await getPublicForecast(client as never,facts.serverTime,facts);
 assert.equal(failed.status,'unavailable');
 assert.match(failed.reason||'',/处理失败/);
 assert.equal(failed.outlook?.status,'monitoring');
 assert.deepEqual(failed.cadenceHistory,[]);
 status='ready';
 assert.equal((await getPublicForecast(client as never,facts.serverTime,facts)).status,'ready');
});
