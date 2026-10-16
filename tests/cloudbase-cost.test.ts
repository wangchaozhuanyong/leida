import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CloudbaseRpc,type CloudbaseOperation} from '../src/server/cloudbase/rpc';
import {claimJob,runOne,scheduleDue,writeWorkerHeartbeat} from '../src/server/worker';
import {scheduleWechatDeliveries} from '../src/server/wechat';
import {runForecastCycle} from '../src/server/forecast';
import {createWorkerCadence,createWorkerHeartbeat} from '../src/server/worker-timing';

test('真实存储适配器的单 worker 空闲一小时 RPC 对照；不调用生产网络',async t=>{
  const base=Date.parse('2026-10-15T00:00:00Z');
  t.mock.timers.enable({apis:['Date'],now:base});
  for(const [key,value] of Object.entries({RADAR_STORAGE_BACKEND:'cloudbase',RADAR_PUBLIC_READ_BACKEND:'cloudbase',CLOUDBASE_ENV_ID:'leida-cost-fixture',CLOUDBASE_API_KEY:'fixture-not-a-real-key'})){
    const previous=process.env[key];process.env[key]=value;
    t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
  }
  type Row={id:string;payload:{id:string;[key:string]:unknown};createdAt:string};
  let tables=new Map<string,Map<string,Row>>(),counts:Record<string,number>={};
  const rows=(table:string)=>[...(tables.get(table)?.values()??[])].sort((a,b)=>a.id.localeCompare(b.id));
  const fingerprint=(table:string)=>createHash('md5').update(JSON.stringify(rows(table))).digest('hex');
  const reset=(enabled:boolean)=>{
    tables=new Map();counts={};
    const seed=(table:string,payload:Row['payload'])=>{if(!tables.has(table))tables.set(table,new Map());tables.get(table)!.set(payload.id,{id:payload.id,payload,createdAt:new Date(base).toISOString()});};
    seed('sources',{id:'not-due',enabled:true,validated:true,status:'healthy',kind:'archive',intervalMinutes:5,nextRunAt:'2100-01-01T00:00:00Z'});
    seed('settings',{id:'site',autoPublish:false});seed('settings',{id:'ai',enabled:false});
    seed('settings',{id:'wechat',subscriptionsEnabled:enabled,appId:'wx0123456789abcdef',encryptedSecret:'fixture-not-real',templateId:'fixture-template',templateFields:{title:'thing1',status:'phrase2',time:'time3'},dailyApiLimit:100,dailySendLimit:100,version:1});
    t.mock.timers.setTime(base);
  };
  t.mock.method(CloudbaseRpc.prototype,'call',async function(operation:CloudbaseOperation,params:Record<string,any>={}){
    counts[operation]=(counts[operation]??0)+1;
    if(operation==='radar_cb_claim_job'){
      const row=rows('jobs').find(row=>row.payload.status==='queued'&&Date.parse(String(row.payload.availableAt))<=Date.now());
      if(!row)return null;
      row.payload={...row.payload,status:'running',attempts:Number(row.payload.attempts)+1,leaseUntil:new Date(Date.now()+120000).toISOString()};
      return structuredClone(row.payload);
    }
    if(operation==='radar_cb_store_read'){
      assert.equal(params.p_after,null,'this bounded fixture contains one page');
      return {fingerprint:fingerprint(params.p_table),rows:rows(params.p_table).filter(row=>!params.p_id||row.id===params.p_id),more:false,after:null};
    }
    if(operation==='radar_cb_store_commit'){
      for(const [table,expected] of Object.entries(params.p_expected))assert.equal(fingerprint(table),expected,'read-set checks are retained');
      for(const change of params.p_changes){
        if(!tables.has(change.table))tables.set(change.table,new Map());
        const table=tables.get(change.table)!;
        const previous=table.get(change.value.id);
        if(change.kind==='insert'&&previous)continue;
        table.set(change.value.id,{id:change.value.id,payload:structuredClone(change.value),createdAt:previous?.createdAt??new Date().toISOString()});
      }
      return true;
    }
    assert.fail('unexpected RPC in isolated cost fixture: '+operation);
  });
  // The old loop mirrors 37b6983: scan/forecast/claim every 5s, heartbeat on
  // every turn plus a second 20s heartbeat timer. Domain functions are shared.
  const baseline=async()=>{
    await writeWorkerHeartbeat();
    for(let elapsed=0;elapsed<3600_000;elapsed+=5000){
      t.mock.timers.setTime(base+elapsed);
      if(elapsed>0&&elapsed%20_000===0)await writeWorkerHeartbeat();
      await scheduleDue();await scheduleWechatDeliveries();
      assert.notEqual((await runForecastCycle()).status,'error');
      assert.equal(await claimJob(),undefined);await writeWorkerHeartbeat();
    }
    return structuredClone(counts);
  };
  const optimized=async()=>{
    const cadence=createWorkerCadence(()=>Date.now());
    const heartbeat=createWorkerHeartbeat((error,at)=>writeWorkerHeartbeat(error,at??false),()=>Date.now());
    await heartbeat.flush();
    for(let elapsed=0;elapsed<3600_000;elapsed+=5000){
      t.mock.timers.setTime(base+elapsed);
      if(elapsed%60_000===0)await heartbeat.flush();
      if(elapsed%15_000===0){assert.equal(await runOne({cadence}),false);await heartbeat.flush();}
    }
    return structuredClone(counts);
  };
  const reports=[];
  for(const enabled of [false,true]){
    reset(enabled);const before=await baseline();
    reset(enabled);const after=await optimized();
    const total=(value:Record<string,number>)=>Object.values(value).reduce((sum,n)=>sum+n,0);
    const reduction=1-total(after)/total(before);
    assert.ok(reduction>=0.60,'idle RPC calls must fall by at least 60 percent');
    assert.equal(after.radar_cb_claim_job,240);
    const runtime=tables.get('settings')?.get('forecast_runtime')?.payload;
    assert.equal(runtime?.status,'ready');
    assert.equal(tables.get('jobs')?.size??0,0,'no fabricated work or notifications');
    reports.push({wechatConfigured:enabled,before,after,beforeTotal:total(before),afterTotal:total(after),reductionPercent:Math.round(reduction*10000)/100});
  }
  t.diagnostic('COST_FIXTURE_RESULT '+JSON.stringify({windowSeconds:3600,productionNetwork:false,billingMeasured:false,reports}));
  // Queued work is claimed even inside maintenance windows. An unchanged
  // healthy collection must not wake unrelated full scans or reminder work.
  reset(true);
  const cadence=createWorkerCadence(()=>Date.now());let scans=0;
  for(const name of ['sources','generation','wechat','forecast'] as const)await cadence.run(name,async()=>{scans++;});
  const job={id:'fixture-collect',kind:'collect',sourceId:'not-due',status:'queued',attempts:0,availableAt:new Date().toISOString(),createdAt:new Date().toISOString(),payload:{}};
  tables.set('jobs',new Map([[job.id,{id:job.id,payload:job,createdAt:job.createdAt}]]));
  let collected=0;
  assert.equal(await runOne({cadence,collect:async()=>{collected++;return {seen:1,created:0};}}),true);
  assert.equal(collected,1);assert.equal(tables.get('jobs')?.get(job.id)?.payload.status,'succeeded');
  for(const name of ['sources','generation','wechat','forecast'] as const)await cadence.run(name,async()=>{scans++;});
  assert.equal(scans,4,'unchanged collection does not wake full generation/forecast scans or reminders');
  const changed={...job,id:'fixture-new-evidence'};
  tables.get('jobs')!.set(changed.id,{id:changed.id,payload:changed,createdAt:changed.createdAt});
  assert.equal(await runOne({cadence,collect:async()=>({seen:1,created:1})}),true);
  for(const name of ['sources','generation','wechat','forecast'] as const)await cadence.run(name,async()=>{scans++;});
  assert.equal(scans,6,'new evidence immediately wakes generation and forecast only');
  const send={...job,id:'fixture-send',kind:'wechat_send',sourceId:undefined,status:'queued'};
  tables.get('jobs')!.set(send.id,{id:send.id,payload:send,createdAt:send.createdAt});
  let processed=0;
  assert.equal(await runOne({cadence,wechat:async()=>{processed++;return {state:'cancelled',reason:'isolated fixture'};}}),true);
  assert.equal(processed,1);assert.equal(tables.get('jobs')?.get(send.id)?.payload.status,'succeeded');
  await cadence.run('wechat',async()=>{scans++;});assert.equal(scans,7,'completion wakes the next reminder scheduling turn');
});
