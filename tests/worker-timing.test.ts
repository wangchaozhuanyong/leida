import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerCadence,createWorkerHeartbeat,workerRetryDelay} from '../src/server/worker-timing';

test('空闲调度降频，单项失败十五秒后恢复；新任务唤醒不会被扫描窗口挡住',async()=>{
  let now=0,sources=0,wechat=0,forecast=0;
  const cadence=createWorkerCadence(()=>now);
  const scan=()=>Promise.all([
    cadence.run('sources',async()=>{sources++;}),
    cadence.run('wechat',async()=>{wechat++;}),
    cadence.run('forecast',async()=>{forecast++;}),
  ]);
  for(now=0;now<60_000;now+=5000)await scan();
  assert.deepEqual([sources,wechat,forecast],[1,2,1]);
  cadence.nudge('sources','wechat','forecast');await scan();
  assert.deepEqual([sources,wechat,forecast],[2,3,2]);
  now=61_000;cadence.nudge('sources');
  await assert.rejects(cadence.run('sources',async()=>{throw new Error('fixture unavailable');}));
  now=75_999;await cadence.run('sources',async()=>{sources++;});assert.equal(sources,2);
  now=76_000;await cadence.run('sources',async()=>{sources++;});assert.equal(sources,3);
  assert.deepEqual([1,2,3,100].map(workerRetryDelay),[15_000,30_000,60_000,60_000]);
});

test('并发扫描复用在途工作，进行中收到唤醒后下一轮仍检查；重启重新读取',async()=>{
  let now=0,calls=0,release!:()=>void;
  const cadence=createWorkerCadence(()=>now);
  const first=cadence.run('sources',()=>{calls++;return new Promise<void>(resolve=>{release=resolve;});});
  const second=cadence.run('sources',async()=>{calls++;});
  assert.equal(first,second);await Promise.resolve();assert.equal(calls,1);
  cadence.nudge('sources');release();await first;
  await cadence.run('sources',async()=>{calls++;});assert.equal(calls,2);
  await createWorkerCadence(()=>now).run('sources',async()=>{calls++;});assert.equal(calls,3);
});

test('空闲生成扫描与来源检查分开，新消息可立即唤醒生成且不改变微信频率',async()=>{
 let now=0,sources=0,generation=0,wechat=0;
 const cadence=createWorkerCadence(()=>now);
 for(now=0;now<300_000;now+=15_000){
  await cadence.run('sources',async()=>{sources++;});
  await cadence.run('generation',async()=>{generation++;});
  await cadence.run('wechat',async()=>{wechat++;});
 }
 assert.deepEqual([sources,generation,wechat],[5,1,10]);
 cadence.nudge('generation');await cadence.run('generation',async()=>{generation++;});
 assert.equal(generation,2);
});

test('已提交的输入revision跨入口立即唤醒一次生成，同revision不绕过空闲或失败退避',async()=>{
 let now=0,calls=0;
 const cadence=createWorkerCadence(()=>now);
 const scan=()=>cadence.run('generation',async()=>{calls++;});
 cadence.observe('generation','first');await scan();assert.equal(calls,1);
 now=25;cadence.observe('generation','first');await scan();assert.equal(calls,1);
 cadence.observe('generation','new-service-evidence');await scan();assert.equal(calls,2);
 now=50;cadence.observe('generation','new-service-evidence');await scan();assert.equal(calls,2);
 cadence.observe('generation','retry-evidence');
 await assert.rejects(cadence.run('generation',async()=>{throw Error('isolated scan failure');}));
 now=51;cadence.observe('generation','retry-evidence');await scan();assert.equal(calls,2);
 now=15_050;cadence.observe('generation','retry-evidence');await scan();assert.equal(calls,3);
});

test('心跳单路每分钟写入，保留实际任务完成时间；故障和恢复立即记录',async()=>{
  let now=0;
  const rows:Array<{error?:string;processedAt?:string}>=[];
  const heartbeat=createWorkerHeartbeat(async(error,processedAt)=>{rows.push({error,processedAt});},()=>now);
  await Promise.all([heartbeat.flush(),heartbeat.flush()]);assert.equal(rows.length,1);
  now=15_000;heartbeat.processed();await heartbeat.flush();assert.equal(rows.length,1);
  now=60_000;await heartbeat.flush();assert.equal(rows[1].processedAt,new Date(15_000).toISOString());
  now=61_000;heartbeat.setError('暂时异常');await heartbeat.flush();assert.equal(rows.at(-1)?.error,'暂时异常');
  now=62_000;heartbeat.setError(undefined);await heartbeat.flush();assert.equal(rows.at(-1)?.error,undefined);
  assert.equal(rows.length,4);
});

test('长任务期间的心跳不会并行覆盖错误，失败不循环空打且不丢完成时间',async()=>{
  let now=0,busy=0,maxBusy=0,calls=0,release!:()=>void;
  const rows:Array<{error?:string;processedAt?:string}>=[];
  const heartbeat=createWorkerHeartbeat(async(error,processedAt)=>{
    calls++;busy++;maxBusy=Math.max(maxBusy,busy);
    try {if(calls===1)await new Promise<void>(resolve=>{release=resolve;});if(calls===2)throw new Error('fixture');rows.push({error,processedAt});}
    finally{busy--;}
  },()=>now);
  const first=heartbeat.flush();await Promise.resolve();
  now=1000;heartbeat.processed();heartbeat.setError('错误状态');const changed=heartbeat.flush();
  release();await Promise.all([first,changed]);assert.equal(calls,2);assert.equal(maxBusy,1);
  now=2000;await heartbeat.flush();assert.equal(calls,2);
  now=61_000;await heartbeat.flush();assert.equal(calls,3);
  assert.deepEqual(rows.at(-1),{error:'错误状态',processedAt:new Date(1000).toISOString()});
});
