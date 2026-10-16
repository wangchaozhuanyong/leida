import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResetCadenceForecast} from '../src/lib/reset-cadence';
import {createCadencePublicProjection,parseCadencePublicProjection} from '../src/server/cadence-public-projection';
import {evaluateCadence,type StoredCadenceForecast} from '../src/server/reset-cadence-runtime';
import {createCloudbasePublicReader} from '../src/server/cloudbase/public-read';
import {CloudbaseRpc} from '../src/server/cloudbase/rpc';
import type {CadenceHorizonOutcome} from '../src/lib/forecast';
import {setTimeout as delay} from 'node:timers/promises';

const at='2026-10-16T00:00:00.000Z',time=Date.parse(at),when=(hours:number)=>new Date(time+hours*3600_000).toISOString();
function fixture(){
 const source={id:'tibo-public',name:'公开测试来源',kind:'timeline',url:'https://api.fxtwitter.com/2/profile/thsottiaux/statuses',enabled:true,validated:true,status:'healthy',intervalMinutes:10,lastSuccessAt:at,version:1};
 const snapshot=(target:'automatic_reset'|'banked_reset',character:string,generatedAt=at):StoredCadenceForecast=>({...buildResetCadenceForecast({target,generatedAt,inputFingerprint:character.repeat(64),observations:Array.from({length:14},(_,i)=>{const at=new Date(Date.parse(generatedAt)-(12+(13-i)*48)*3600_000).toISOString();return {id:`${target}-${i}`,evidenceIds:[`proof-${i}`],at,firstKnownAt:at,timePrecision:'exact' as const,url:`https://x.com/thsottiaux/status/${21000000000000000n+BigInt(i)}`,kind:target};})}),id:'forecast_cadence_'+character.repeat(64),recordType:'reset_cadence',sourceIds:[source.id]});
 const automatic=snapshot('automatic_reset','a'),banked=snapshot('banked_reset','b'),historical=snapshot('automatic_reset','d',when(-60));
 const horizon:CadenceHorizonOutcome={id:'forecast_cadence_horizon_'+'e'.repeat(64),recordType:'reset_cadence_horizon_outcome',snapshotId:historical.id,modelVersion:historical.modelVersion,target:'automatic_reset',horizonHours:48,windowStart:historical.generatedAt,windowEnd:when(-12),observedAt:when(-11),result:'unknown',scorable:false,evidenceIds:[],reason:'窗口已结束，覆盖未核验，未知'};
 const evaluation={automatic_reset:evaluateCadence([],[],'automatic_reset',at),banked_reset:evaluateCadence([],[],'banked_reset',at)};
 const runtime={id:'forecast_runtime',status:'ready',checkedAt:at,cadenceSnapshotId:automatic.id,cadenceSnapshotIds:{automatic_reset:automatic.id,banked_reset:banked.id},cadenceEvaluationByKind:evaluation,cadencePublicProjection:createCadencePublicProjection([automatic,banked,historical],[horizon])};
 const version={digests:Array(5).fill('0'.repeat(32)),sources:[source],settings:[{id:'site',name:'测试',version:1},{id:'forecast_runtime',status:'ready',cadenceSnapshotId:automatic.id}],deadlines:[],cases:[],snapshots:[{id:automatic.id,until:automatic.validUntil,generated:automatic.generatedAt}],outcomeDigest:'f'.repeat(32)};
 const bundle={versionData:version,site:{name:'测试',description:'',autoPublish:false,version:1},events:[],articles:[],publications:[],evidence:[],activities:[],notices:[],page:null,forecastRecords:{cases:[],outcomes:[],snapshots:[createCadencePublicProjection([automatic],[]).snapshots[0]],runtime:{status:'ready',cadenceSnapshotId:automatic.id}}};
 let reads=0;const calls:{operation:string;params:Record<string,unknown>}[]=[];
 const transport:typeof fetch=async(input,init)=>{
  const operation=String(input).split('/').at(-1)!,params=JSON.parse(String(init?.body??'{}'));calls.push({operation,params});
  if(operation==='radar_cb_public_version')return Response.json(version);
  if(operation==='radar_cb_public_bundle')return Response.json(bundle);
  if(operation==='radar_cb_store_read'){assert.deepEqual(params,{p_table:'settings',p_after:null,p_id:'forecast_runtime'});reads++;return Response.json({fingerprint:'1'.repeat(32),rows:[{id:'forecast_runtime',createdAt:at,payload:runtime}],more:false,after:null});}
  if(operation==='radar_cb_forecast_snapshot')return Response.json([automatic,banked,historical].find(s=>s.id===params.p_id)??null);
  throw new Error('Unexpected operation: '+operation);
 };
 const rpc=new CloudbaseRpc('local-cadence-qa','synthetic-transport-only',transport);
 return {automatic,banked,historical,horizon,evaluation,runtime,version,bundle,calls,rpc,transport,snapshot,get reads(){return reads;}};
}
async function fullStorage<T>(fn:()=>Promise<T>){const prior=process.env.RADAR_STORAGE_BACKEND;process.env.RADAR_STORAGE_BACKEND='cloudbase';try{return await fn();}finally{if(prior===undefined)delete process.env.RADAR_STORAGE_BACKEND;else process.env.RADAR_STORAGE_BACKEND=prior;}}

test('有合法摘要签名也不能接受未来cutoff、窗口外发生时间或未来结局',()=>{
 const f=fixture();
 assert.throws(()=>createCadencePublicProjection([{...f.automatic,cutoffAt:when(1)}],[]),/validity/);
 const occurred={...f.horizon,result:'occurred' as const,scorable:true,evidenceIds:['public-proof'],actualAt:when(-13)};
 assert.equal(parseCadencePublicProjection(createCadencePublicProjection([f.historical],[occurred]),at).horizonOutcomes[0].actualAt,when(-13));
 for(const actualAt of [f.historical.generatedAt,when(-11),when(1)])assert.throws(()=>createCadencePublicProjection([f.historical],[{...occurred,actualAt}]),/horizon/);
 const future={...occurred,windowStart:at,windowEnd:when(48),observedAt:when(49),actualAt:when(1)};
 const signedFuture=createCadencePublicProjection([f.automatic],[future]);
 assert.throws(()=>parseCadencePublicProjection(signedFuture,at),/stale/,'未来结局即使重新计算合法digest也不得进入当前公开页面');
});

test('旧SQL：固定runtime只读补齐双目标/评估/冻结结局，最多3额外RPC且合并并发，不泄露私有字段',()=>fullStorage(async()=>{
 const f=fixture(),canary='private-canary-must-never-leave-runtime';
 Object.assign(f.runtime,{privateCredential:canary});Object.assign(f.runtime.cadencePublicProjection.snapshots[1],{privateCredential:canary});Object.assign(f.runtime.cadenceEvaluationByKind.banked_reset,{privateCredential:canary});
 const reader=createCloudbasePublicReader(f.rpc,()=>at),responses=await Promise.all(Array.from({length:20},()=>reader.read({view:'home'})));
 assert.equal(f.calls.length,4);assert.equal(f.reads,2);
 const home=responses[0].data.forecasts!;assert.equal(home.cadence?.id,f.automatic.id);assert.equal(home.cadenceByKind?.banked_reset?.id,f.banked.id);assert.equal(home.cadenceByKind?.banked_reset?.status,'ready');assert.deepEqual(home.cadenceEvaluationByKind?.banked_reset,evaluateCadence([],[],'banked_reset',at));assert.equal(home.cadenceHorizonOutcomes,undefined);
 assert.equal(JSON.stringify(responses).includes(canary),false);
 const method=await reader.read({view:'methodology'});assert.equal(f.calls.length,8);assert.deepEqual(method.data.forecasts?.cadenceHorizonOutcomes?.map(o=>o.id),[f.horizon.id]);
 assert.equal(method.data.forecasts?.cadenceByKind?.banked_reset?.generatedAt,at);assert.equal(method.data.forecasts?.cadenceByKind?.banked_reset?.summaryOnly,true);
 assert.equal(f.calls.some(c=>/commit|lease|auth/.test(c.operation)),false);assert.ok(f.calls.every(c=>!('p_changes' in c.params)));
}));

test('旧SQL：只有banked快照变化也更新公开版本，读取时钟不伪造变化',()=>fullStorage(async()=>{
 const f=fixture(),realNow=Date.now;let cacheTime=realNow();Date.now=()=>cacheTime;
 try{const reader=createCloudbasePublicReader(f.rpc,()=>at),first=await reader.version();assert.equal(f.calls.length,4);assert.deepEqual(await reader.version(),first);assert.equal(f.calls.length,4);
  const newer=f.snapshot('banked_reset','c');f.runtime.cadenceSnapshotIds.banked_reset=newer.id;f.runtime.cadencePublicProjection=createCadencePublicProjection([f.automatic,newer,f.historical],[f.horizon]);cacheTime+=10001;
  const changed=await reader.version();assert.notEqual(changed.contentVersion,first.contentVersion);assert.notEqual(changed.version,first.version);assert.equal(f.calls.length,8);
 }finally{Date.now=realNow;}
}));

test('新SQL完整投影零额外RPC，未启用完整存储也不越权读取settings',async()=>{
 const f=fixture();Object.assign(f.version.settings[1],{cadenceSnapshotIds:f.runtime.cadenceSnapshotIds,cadenceEvaluationByKind:f.evaluation});Object.assign(f.bundle.forecastRecords.runtime,f.runtime);f.bundle.forecastRecords.snapshots=[f.automatic,f.banked];
 await fullStorage(async()=>{const reader=createCloudbasePublicReader(f.rpc,()=>at);assert.equal((await reader.read({view:'home'})).data.forecasts?.cadenceByKind?.banked_reset?.id,f.banked.id);assert.equal(f.calls.length,1);});
 const old=fixture(),prior=process.env.RADAR_STORAGE_BACKEND;process.env.RADAR_STORAGE_BACKEND='native';try{await createCloudbasePublicReader(old.rpc,()=>at).read({view:'home'});assert.equal(old.calls.length,1);}finally{if(prior===undefined)delete process.env.RADAR_STORAGE_BACKEND;else process.env.RADAR_STORAGE_BACKEND=prior;}
});

for(const failure of ['runtime-race','public-version-race','future','future-cutoff','future-actual','actual-before-window','actual-after-window','invalid-probability','missing-projection','denied-fixed-read'] as const)test(`旧SQL ${failure}明确不可用，保留公开事实且不增加重试或写入`,()=>fullStorage(async()=>{
 const f=fixture();let runtimeCalls=0,versionCalls=0;
 if(failure==='future')f.runtime.checkedAt=when(1);
 if(failure==='future-cutoff')f.runtime.cadencePublicProjection.snapshots[1].cutoffAt=when(1);
 if(failure==='future-actual'||failure==='actual-before-window'||failure==='actual-after-window'){
  const actualAt=failure==='future-actual'?when(1):failure==='actual-before-window'?f.historical.generatedAt:when(-11);
  Object.assign(f.runtime.cadencePublicProjection.horizonOutcomes[0],{result:'occurred',actualAt,evidenceIds:['public-proof'],scorable:true});
 }
 if(failure==='invalid-probability')f.runtime.cadencePublicProjection.snapshots[1].p48=2;
 if(failure==='missing-projection')delete (f.runtime as Partial<typeof f.runtime>).cadencePublicProjection;
 const rpc=new CloudbaseRpc('local-cadence-qa','synthetic-transport-only',async(input,init)=>{
  const op=String(input).split('/').at(-1);
  if(op==='radar_cb_store_read'){runtimeCalls++;if(failure==='denied-fixed-read')return Response.json({code:'42501',message:'private body'},{status:403});const response=await f.transport(input,init);if(failure==='runtime-race'&&runtimeCalls===2){const body=await response.json();body.fingerprint='2'.repeat(32);return Response.json(body);}return response;}
  if(op==='radar_cb_public_version'){versionCalls++;if(failure==='public-version-race')return Response.json({...f.version,outcomeDigest:'3'.repeat(32)});}
  return f.transport(input,init);
 });
 const reader=createCloudbasePublicReader(rpc,()=>at),value=await reader.read({view:'home'});assert.equal(value.data.forecasts?.status,'unavailable');assert.equal(value.data.forecasts?.cadenceByKind,undefined);assert.equal(value.data.site.name,'测试');assert.ok(runtimeCalls<=2);assert.ok(versionCalls<=1);assert.equal(JSON.stringify(value).includes('private body'),false);
}));

test('旧SQL兼容首阶段忽略signal时也在1.5秒内降级，事实可读且20并发合并，无迟到第二轮RPC',()=>fullStorage(async()=>{
 const f=fixture();let fixedCalls=0,finish!:()=>void;const signals:AbortSignal[]=[];
 const rpc=new CloudbaseRpc('local-cadence-qa','synthetic-transport-only',async(input,init)=>{
  if(String(input).endsWith('/radar_cb_store_read')){fixedCalls++;signals.push(init?.signal as AbortSignal);await new Promise<void>(resolve=>{finish=resolve;});}
  return f.transport(input,init);
 });
 const reader=createCloudbasePublicReader(rpc,()=>at),started=performance.now();
 const values=await Promise.all(Array.from({length:20},()=>reader.read({view:'home'})));
 const elapsed=performance.now()-started;assert.ok(elapsed>=1400&&elapsed<1850,`兼容等待应受1500ms预算限制，实际${elapsed}ms`);
 for(const value of values){assert.equal(value.data.site.name,'测试');assert.equal(value.data.forecasts?.status,'unavailable');}
 assert.equal(fixedCalls,1);assert.equal(signals[0].aborted,true);assert.equal(f.calls.length,1);
 await reader.read({view:'home'});assert.equal(fixedCalls,1,'降级结果也缓存，避免故障请求风暴');
 finish();await delay(30);assert.equal(fixedCalls,1);assert.equal(f.calls.filter(c=>c.operation==='radar_cb_public_version').length,0,'迟到首阶段不能启动第二阶段');
}));

test('旧SQL兼容第二阶段共用剩余预算，中断并行RPC，保留事实且不重试',()=>fullStorage(async()=>{
 const f=fixture();let fixedCalls=0,versionCalls=0;const signals:AbortSignal[]=[],finishes:(()=>void)[]=[];
 const rpc=new CloudbaseRpc('local-cadence-qa','synthetic-transport-only',async(input,init)=>{
  const op=String(input).split('/').at(-1);
  if(op==='radar_cb_store_read')fixedCalls++;
  if(op==='radar_cb_public_version')versionCalls++;
  if(op==='radar_cb_store_read'&&fixedCalls===1)await delay(250);
  if(op==='radar_cb_store_read'&&fixedCalls===2||op==='radar_cb_public_version'){
   signals.push(init?.signal as AbortSignal);await new Promise<void>(resolve=>{finishes.push(resolve);});
  }
  return f.transport(input,init);
 });
 const started=performance.now(),value=await createCloudbasePublicReader(rpc,()=>at).read({view:'home'}),elapsed=performance.now()-started;
 assert.ok(elapsed>=1400&&elapsed<1850,`两阶段共享1500ms，不能逐请求累加：${elapsed}ms`);
 assert.equal(value.data.site.name,'测试');assert.equal(value.data.forecasts?.status,'unavailable');assert.equal(fixedCalls,2);assert.equal(versionCalls,1);assert.equal(signals.length,2);assert.ok(signals.every(signal=>signal.aborted));
 finishes.forEach(finish=>finish());await delay(30);assert.equal(fixedCalls,2);assert.equal(versionCalls,1);
}));
