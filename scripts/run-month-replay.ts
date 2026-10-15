import {config} from 'dotenv';
import pg from 'pg';
import {createHash} from 'node:crypto';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {REPLAY_VERSION,replayTimeline,scoreReplay,type ReplayInput,type ReplayRun,type ReplayStep} from '../src/lib/historical-replay';
import type {Evidence,Source,Publication,Activity,Job} from '../src/lib/types';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=resolve(process.env.REPLAY_OUTPUT??root+'outputs/month-replay-20261016')+'/';
assert.ok(output.startsWith(root+'outputs/'));
config({path:fileURLToPath(new URL('../../../.env',import.meta.url)),quiet:true});
const original=new URL(process.env.DATABASE_URL??'');
assert.equal(original.hostname,'127.0.0.1');assert.equal(original.port,'55489');assert.equal(original.pathname,'/radar');
assert.equal(process.env.RADAR_STORAGE_BACKEND??'native','native');
const NativeDate=Date;
const inputText=await readFile(output+'input.json','utf8'),input=JSON.parse(inputText) as ReplayInput;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const inputFingerprint=digest(inputText);
const runtimeFiles:string[]=[];
for(const dir of ['src/server','src/lib','src/db'])for(const file of await readdir(root+dir,{recursive:true}))if(String(file).endsWith('.ts'))runtimeFiles.push(dir+'/'+file);
const codeFingerprint=digest((await Promise.all([...runtimeFiles,'scripts/run-month-replay.ts','pnpm-lock.yaml'].sort().map(async file=>file+'\0'+await readFile(root+file,'utf8')))).join('\0'));
const runId='replay_'+digest(inputFingerprint+codeFingerprint).slice(0,24);
const timeline=replayTimeline(input),target=new URL(original);
let database=await readFile(output+'local-database.json','utf8').then(text=>JSON.parse(text) as {database:string;runId:string}).catch(()=>undefined);
if(database&&database.runId!==runId)throw new Error('输入或运行代码已变化；保留旧批次，使用新的输出目录运行');
if(!database){
  database={database:`radar_replay_${NativeDate.now()}`,runId};
  assert.match(database.database,/^radar_replay_\d+$/);
  const admin=new pg.Pool({connectionString:original.href});
  try{await admin.query(`CREATE DATABASE "${database.database}"`);}finally{await admin.end();}
  target.pathname='/'+database.database;
  for(const script of ['scripts/migrate.ts','scripts/migrations/forecast.ts','scripts/migrations/wechat.ts']){
    execFileSync('pnpm',['exec','tsx',script,...(script.includes('/migrations/')?['--apply']:[])],{cwd:root,env:{...process.env,DATABASE_URL:target.href},stdio:'pipe'});
  }
  await writeFile(output+'local-database.json',JSON.stringify(database,null,2)+'\n');
}
target.pathname='/'+database.database;
assert.match(target.pathname,/^\/radar_replay_\d+$/);
process.env.DATABASE_URL=target.href;
let clock=Date.parse(timeline[0]?.at??input.window.start);
// Only this standalone, local-only process gets a virtual clock. The running
// website and its real worker never import or share this override.
globalThis.Date=new Proxy(NativeDate,{construct(target,args){return Reflect.construct(target,args.length?args:[clock]);},apply(){return new NativeDate(clock).toString();},get(target,key,receiver){return key==='now'?()=>clock:Reflect.get(target,key,receiver);}});
const {pool,list,one,put,insert,transaction}=await import('../src/db');
pool.on('connect',client=>{
  const query=client.query.bind(client);
  client.query=((sql:unknown,...args:unknown[])=>{
    if(typeof sql==='string'&&sql.trimStart().startsWith('SELECT id,payload FROM radar_jobs')&&sql.includes('FOR UPDATE SKIP LOCKED LIMIT 1'))return query(sql.replace(/\bnow\(\)/g,'$1::timestamptz'),[new NativeDate(clock).toISOString()]);
    return (query as (...args:unknown[])=>unknown)(sql,...args);
  }) as typeof client.query;
});
const {defaultSite,createEvidence,getPublicData}=await import('../src/server/service');
const {sourceDefinitions}=await import('../src/server/ingestion');
const {runOne,scheduleDue}=await import('../src/server/worker');
const {runForecastCycle}=await import('../src/server/forecast');
const {publicResetOutlook}=await import('../src/lib/reset-outlook');
const {evaluateHourlyPredictions,HOURLY_OBSERVATION_VERSION}=await import('../src/lib/hourly-prediction-observation');
const realFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('隔离回放禁止外部网络、AI或微信调用');};
const manifestId='history_'+runId;
let manifest=await one<ReplayRun>('settings',manifestId);
const stopAfter=Number(process.argv.find(arg=>arg.startsWith('--stop-after='))?.split('=')[1]??Infinity);
try{
  if(!manifest){
    for(const table of ['evidence','candidates','events','articles','publications','sources','jobs','notices','activities','settings','forecast_cases','forecast_snapshots','forecast_outcomes'] as const)assert.equal((await list(table)).length,0,'只允许新建的空回放数据库');
    await put('settings',{id:'site',...defaultSite,name:defaultSite.name+' · 历史回放验证'});
    await put('settings',{id:'ai',enabled:false,version:1});
    for(const source of sourceDefinitions)await put('sources',{...source,enabled:source.kind!=='manual',validated:source.kind!=='manual',status:source.kind==='manual'?'paused':'healthy',lastSuccessAt:new NativeDate(clock).toISOString(),nextRunAt:'2100-01-01T00:00:00.000Z'});
    manifest={id:manifestId,recordType:'historical_replay_run',version:REPLAY_VERSION,runId,status:'running',window:input.window,coverage:input.coverage,inputFingerprint,codeFingerprint,recordedAt:new NativeDate().toISOString(),updatedAt:new NativeDate().toISOString(),completedSteps:0,totalSteps:timeline.length,virtualAt:new NativeDate(clock).toISOString(),messageCount:timeline.filter(row=>row.record&&row.phase==='evaluation').length};
    await put('settings',manifest);
  }
  assert.equal(manifest.inputFingerprint,inputFingerprint);assert.equal(manifest.codeFingerprint,codeFingerprint);
  const frozen=new Map((await list<{id:string}>('forecast_snapshots')).map(row=>[row.id,JSON.stringify(row)]));
  const drain=async()=>{
    for(let round=0;round<150;round++){
      await scheduleDue({allowTemplates:true,allowEnrichment:false});
      let worked=0;
      for(;worked<20;worked++)if(!await runOne({schedule:false,allowTemplates:true,enrich:async()=>undefined,enrichQuoted:async()=>[],collect:async()=>{throw new Error('离线回放不运行网络采集');},wechat:async()=>{throw new Error('离线回放不发送提醒');}}))break;
      if(!worked)return;
    }
    throw new Error('回放队列未收敛');
  };
  let doneThisRun=0;
  for(let index=manifest.completedSteps;index<timeline.length;index++){
    const tick=timeline[index];clock=Date.parse(tick.at);
    const at=new NativeDate(clock).toISOString();
    for(const source of await list<Source>('sources'))if(source.kind!=='manual')await put('sources',{...source,status:'healthy',lastSuccessAt:at,nextRunAt:'2100-01-01T00:00:00.000Z'});
    const previousPubs=new Set((await list<Publication>('publications')).map(p=>p.id));
    let evidenceId:string|undefined;
    if(tick.record){
      const {captureProvenance:_,...record}=tick.record;
      const activity=record.metadata?.activity;
      if(activity&&!await one<Activity>('activities',activity.id))await put('activities',{...activity,items:[]});
      const result=await createEvidence({...record,collectedAt:at,historical:false});evidenceId=result.evidence.id;
    }
    await drain();
    const cycle=await runForecastCycle(at,{force:true});assert.equal(cycle.status,'ready');
    const data=await getPublicData(),evidence=await list<Evidence>('evidence');
    assert.ok(evidence.every(e=>Date.parse(e.publishedAt)<=clock&&Date.parse(e.collectedAt)<=clock),'未来证据进入回放');
    assert.ok(data.publications.every(p=>Date.parse(p.publishedAt)<=clock&&Date.parse(p.cutoffAt)<=clock),'未来发布进入回放');
    for(const row of await list<{id:string;recordType?:string;generatedAt?:string;evidenceCutoffAt?:string;cutoffAt?:string}>('forecast_snapshots')){
      const text=JSON.stringify(row),old=frozen.get(row.id);if(old)assert.equal(text,old,'旧预测被改写');else frozen.set(row.id,text);
      if(row.recordType!=='historical_replay_step')assert.ok(Date.parse(row.generatedAt??'')<=clock&&Date.parse(row.evidenceCutoffAt??row.cutoffAt??'')<=clock,'未来预测进入回放');
    }
    const p=data.forecasts?.cadence;
    const prediction=p?(({id,status,generatedAt,cutoffAt,validUntil,modelVersion,p24,p48,predictedAt,windowStart,windowEnd,sampleCount,trainingObservationIds,explanation})=>({id,status,generatedAt,cutoffAt,validUntil,modelVersion,p24,p48,predictedAt,windowStart,windowEnd,sampleCount,trainingObservationIds,explanation}))(p):undefined;
    const step:ReplayStep={id:`replay_step_${runId}_${index}`,recordType:'historical_replay_step',runId,signature:digest(runId+':'+index),index,kind:tick.record?'message':'timer',phase:tick.phase,virtualAt:at,recordedAt:new NativeDate().toISOString(),evidenceId,message:tick.record,prediction,outlook:publicResetOutlook(data),publications:data.publications.filter(p=>!previousPubs.has(p.id)),inputFingerprint,codeFingerprint};
    manifest={...manifest,completedSteps:index+1,virtualAt:at,updatedAt:new NativeDate().toISOString()};
    await transaction(async client=>{assert.ok(await insert('forecast_snapshots',step,client));await put('settings',manifest!,client);});
    doneThisRun++;
    if((index+1)%25===0)console.log(JSON.stringify({completed:index+1,total:timeline.length,virtualAt:at,publications:data.publications.length}));
    if(doneThisRun>=stopAfter){console.log(JSON.stringify({status:'checkpoint_saved',completedSteps:manifest.completedSteps}));break;}
  }
  if(manifest.completedSteps===timeline.length){
    const steps=(await list<ReplayStep>('forecast_snapshots')).filter(row=>row.recordType==='historical_replay_step'&&row.runId===runId).sort((a,b)=>a.index-b.index);
    assert.equal(steps.length,timeline.length);
    const data=await getPublicData(),evidence=await list<Evidence>('evidence');
    assert.ok(data.forecasts?.cadence,'缺少最终统计观察序列');
    const scores=scoreReplay(steps,data.forecasts.cadence.observations,input.window);
    const announcementResult=evaluateHourlyPredictions({version:HOURLY_OBSERVATION_VERSION,startedAt:input.window.start,cases:[]},{time:input.window.end,publications:data.publications,evidence,automaticPublicationIds:new Set(data.publications.map(p=>p.id))});
    const announcement=announcementResult.summary;
    manifest={...manifest,status:'complete',scores,announcement,announcementCases:announcementResult.state.cases,updatedAt:new NativeDate().toISOString()};
    await put('settings',manifest);
    const records:Record<string,unknown[]>={};
    for(const table of ['evidence','candidates','events','articles','publications','activities'] as const)records[table]=await list(table);
    const failed=(await list<Job>('jobs')).filter(j=>j.status==='failed');
    await writeFile(output+'replay-package.json',JSON.stringify({run:manifest,steps,records},null,2)+'\n');
    await writeFile(output+'replay-result.json',JSON.stringify({run:manifest,counts:Object.fromEntries(Object.entries(records).map(([table,rows])=>[table,rows.length])),failedJobs:failed.map(j=>({kind:j.kind,error:j.error})),checks:{noFutureData:true,immutableSnapshots:true,externalNetworkDisabled:true,realAccountDeliveryMeasured:false,continuousMonthUptimeMeasured:false}},null,2)+'\n');
    assert.equal(failed.length,0,'存在失败任务，应检查并修复');
    console.log(JSON.stringify({status:manifest.status,runId,steps:steps.length,scores,announcement}));
  }
}finally{globalThis.fetch=realFetch;globalThis.Date=NativeDate;await pool.end();}
