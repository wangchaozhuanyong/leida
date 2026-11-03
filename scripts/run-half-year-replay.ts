/** Offline replay only: this entrypoint accepts a loopback test database,
 * never imports application credentials, and forbids all external fetches. */
import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,appendFile,readdir,access,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {scoreReplay,type ReplayInput} from '../src/lib/historical-replay';
import {evaluateHourlyPredictions,HOURLY_OBSERVATION_VERSION,type HourlyPredictionObservation} from '../src/lib/hourly-prediction-observation';
import type {Source,Publication,Evidence,Activity,Job} from '../src/lib/types';
const root=fileURLToPath(new URL('../',import.meta.url));
const arg=(key:string,fallback:string)=>process.argv.find(a=>a.startsWith('--'+key+'='))?.slice(key.length+3)??fallback;
const mode=arg('mode','rules');assert.ok(['rules','known'].includes(mode));
const run=arg('run',mode+'-01');assert.match(run,/^[a-z0-9-]+$/);
const inputPath=resolve(arg('input',root+'outputs/half-year-replay-20261102/'+(mode==='known'?'input-variants.json':'input.json')));
const output=resolve(arg('output',root+'outputs/half-year-replay-20261102'));
assert.ok(inputPath.startsWith(root+'outputs/')&&output.startsWith(root+'outputs/'));
const out=output+'/'+run+'/',resume=process.argv.includes('--resume');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),NativeDate=Date;
const inputText=await readFile(inputPath,'utf8'),input=JSON.parse(inputText) as ReplayInput;
const start=Date.parse(input.window.start),end=Date.parse(input.window.end);assert.ok(Number.isFinite(start)&&end>start);
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>[k,canonical(v[k])])):v;
const fingerprint=(v:unknown)=>JSON.stringify(canonical(v));
const files=['pnpm-lock.yaml','scripts/run-half-year-replay.ts'];
for(const directory of ['src/server','src/lib','src/db','miniprogram'])for(const f of await readdir(root+directory,{recursive:true}))if(/\.(?:ts|js|wxml|wxss)$/.test(String(f)))files.push(directory+'/'+f);
const codeFingerprint=sha((await Promise.all(files.sort().map(async f=>f+'\0'+await readFile(root+f,'utf8')))).join('\0'));
const inputFingerprint=sha(inputText),runId=sha(mode+inputFingerprint+codeFingerprint).slice(0,24);
const original=new URL(process.env.DATABASE_URL??'');assert.equal(original.hostname,'127.0.0.1');assert.equal(original.port,'55489');assert.equal(original.pathname,'/radar');
assert.equal(process.env.RADAR_STORAGE_BACKEND,'native');assert.equal(process.env.RADAR_PUBLIC_READ_BACKEND,'native');
const ticks:any[]=[],keys=new Set<string>();let excludedAfterCutoff=0;
for(const record of input.records){
 const published=Date.parse(record.publishedAt),collected=Date.parse(record.collectedAt),snapshot=Date.parse(record.metadata?.referenceReset?.snapshotAt??'');
 assert.ok(Number.isFinite(published)&&Number.isFinite(collected)&&record.text.trim());
 const at=mode==='known'?Math.max(published,collected,Number.isFinite(snapshot)?snapshot:0):Math.ceil(published/120000)*120000;
 if(published>end||at>end){excludedAfterCutoff++;continue;}
 const key='message:'+sha(fingerprint(record));assert.ok(!keys.has(key));keys.add(key);
 ticks.push({key,at:new NativeDate(at).toISOString(),phase:at<start?'warmup':'evaluation',record});
}
for(let t=start;t<end;t+=6*3600_000)ticks.push({key:'timer:'+t,at:new NativeDate(t).toISOString(),phase:'evaluation'});
ticks.push({key:'timer:'+end,at:new NativeDate(end).toISOString(),phase:'evaluation'});
const sortTicks=()=>ticks.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||Number(!a.record)-Number(!b.record)||(a.record?.sourceId??'').localeCompare(b.record?.sourceId??'')||(a.record?.messageId??'').localeCompare(b.record?.messageId??'',undefined,{numeric:true})||a.key.localeCompare(b.key));
sortTicks();
let metadata:any;
if(resume){
 metadata=JSON.parse(await readFile(out+'database.json','utf8'));assert.equal(metadata.runId,runId);assert.equal(metadata.codeFingerprint,codeFingerprint);
 const active=await access(out+'active-step.json').then(()=>true,()=>false);assert.equal(active,false,'unfinished step requires inspection, not automatic replay');
}else{
 await mkdir(out);const database='radar_half_year_'+NativeDate.now();assert.match(database,/^radar_half_year_\d+$/);
 const adminUrl=new URL(original);adminUrl.pathname='/postgres';
 const admin=new pg.Pool({connectionString:adminUrl.href});try{await admin.query('CREATE DATABASE "'+database+'"');}finally{await admin.end();}
 metadata={database,runId,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),codeFingerprint,inputFingerprint,mode,window:input.window,startedAt:new NativeDate().toISOString()};
 await writeFile(out+'database.json',JSON.stringify(metadata,null,2)+'\n');
 const target=new URL(original);target.pathname='/'+database;
 for(const f of ['scripts/migrate.ts','scripts/migrations/forecast.ts','scripts/migrations/wechat.ts'])execFileSync('pnpm',['exec','tsx',f,...(f.includes('/migrations/')?['--apply']:[])],{cwd:root,env:{...process.env,DATABASE_URL:target.href},stdio:'pipe'});
}
const target=new URL(original);target.pathname='/'+metadata.database;assert.match(target.pathname,/^\/radar_half_year_\d+$/);process.env.DATABASE_URL=target.href;
let time=Date.parse(ticks[0]?.at??input.window.start),blockedNetwork=0,immutableWrites=0;
const realFetch=globalThis.fetch;globalThis.fetch=async()=>{blockedNetwork++;throw Error('OFFLINE_EXTERNAL_REQUEST_FORBIDDEN');};
globalThis.Date=new Proxy(NativeDate,{construct(target,args){return Reflect.construct(target,args.length?args:[time]);},apply(){return new NativeDate(time).toString();},get(target,key,receiver){return key==='now'?()=>time:Reflect.get(target,key,receiver);}});
const {pool,list,one,put}=await import('../src/db');
pool.on('connect',c=>{const query=c.query.bind(c);c.query=((sql:unknown,...args:unknown[])=>{
 if(typeof sql==='string'){
  if(/^\s*(?:UPDATE|DELETE\s+FROM|TRUNCATE)\s+(?:ONLY\s+)?radar_(?:evidence|publications|forecast_snapshots|forecast_outcomes)\b/i.test(sql)){immutableWrites++;throw Error('IMMUTABLE_REPLAY_WRITE_BLOCKED');}
  if(sql.trimStart().startsWith('SELECT id,payload FROM radar_jobs')&&sql.includes('FOR UPDATE SKIP LOCKED LIMIT 1'))return query(sql.replace(/\bnow\(\)/g,'$1::timestamptz'),[new NativeDate(time).toISOString()]);
 }return (query as any)(sql,...args);
}) as typeof c.query;});
const {defaultSite,createEvidence,getPublicData}=await import('../src/server/service');
const {sourceDefinitions}=await import('../src/server/ingestion');
const {runOne,scheduleDue}=await import('../src/server/worker');
const {runForecastCycle}=await import('../src/server/forecast');
const require=createRequire(import.meta.url),{homeResetStatus}=require(root+'miniprogram/utils/home-reset-status.js'),{statusPosterInput}=require(root+'miniprogram/packages/poster/status-poster.js');
const steps:any[]=resume?(await readFile(out+'steps.jsonl','utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[],issues:any[]=[];
const done=new Set(steps.map(s=>s.key)),knownTimers=new Set(ticks.filter(t=>!t.record).map(t=>t.at));
for(const step of steps){for(const at of step.addedTimers??[])if(!knownTimers.has(at)){knownTimers.add(at);ticks.push({key:'timer:'+Date.parse(at),at,phase:'evaluation'});}}
sortTicks();if(steps.length)time=Date.parse(steps.at(-1).virtualAt);
const frozen=new Map<string,string>();
const verifyFrozen=async()=>{for(const row of await list<any>('forecast_snapshots')){const value=fingerprint(row),before=frozen.get(row.id);if(before)assert.equal(value,before,'FROZEN_SNAPSHOT_CHANGED');else frozen.set(row.id,value);assert.ok(Date.parse(row.generatedAt??row.cutoffAt??input.window.start)<=time,'FUTURE_FORECAST');}};
const drain=async()=>{for(let batch=0;batch<100;batch++){await scheduleDue({allowTemplates:true,allowEnrichment:false,skipSources:true});let worked=0;for(;worked<20;worked++)if(!await runOne({schedule:false,allowTemplates:true,enrich:async()=>undefined,enrichQuoted:async()=>[],collect:async()=>{throw Error('OFFLINE_COLLECT_FORBIDDEN');},wechat:async()=>{throw Error('OFFLINE_WECHAT_FORBIDDEN');}}))break;if(!worked)return;}throw Error('REPLAY_QUEUE_NOT_CONVERGED');};
let hourly:HourlyPredictionObservation=resume?JSON.parse(await readFile(out+'hourly.json','utf8')):{version:HOURLY_OBSERVATION_VERSION,startedAt:input.window.start,cases:[]};
try{
 if(!resume){
  for(const t of ['evidence','publications','forecast_snapshots','forecast_outcomes','wechat_readers','wechat_grants','wechat_deliveries'] as const)assert.equal((await list(t)).length,0);
  await put('settings',{id:'site',...defaultSite,name:defaultSite.name+' · 隔离半年回放'});await put('settings',{id:'ai',enabled:false,version:1});
  for(const s of sourceDefinitions)await put('sources',{...s,enabled:s.kind!=='manual',validated:s.kind!=='manual',status:s.kind==='manual'?'paused':'healthy',nextRunAt:'2100-01-01T00:00:00Z'});
 }
 await verifyFrozen();
 for(let index=0;index<ticks.length;index++){
  const tick=ticks[index];if(done.has(tick.key))continue;time=Date.parse(tick.at);const at=new NativeDate(time).toISOString();
  await writeFile(out+'active-step.json',JSON.stringify({key:tick.key,at})+'\n');
  for(const s of await list<Source>('sources'))if(s.kind!=='manual')await put('sources',{...s,status:'healthy',lastSuccessAt:at,nextRunAt:'2100-01-01T00:00:00Z'});
  const before=new Set((await list<Publication>('publications')).map(p=>p.id));let evidenceId:string|undefined;
  if(tick.record){
   const {captureProvenance:_,...record}=structuredClone(tick.record);
   if(mode==='rules'&&record.metadata?.referenceReset)record.metadata.referenceReset.snapshotAt=at;
   const a=record.metadata?.activity;if(a&&!await one<Activity>('activities',a.id))await put('activities',{...a,items:[]});
   try{evidenceId=(await createEvidence({...record,collectedAt:mode==='rules'?at:record.collectedAt,historical:false})).evidence.id;}catch(e){issues.push({key:tick.key,at,kind:'input_rejected',sourceId:record.sourceId,messageId:record.messageId,error:String(e).slice(0,240)});}
  }
  await drain();const cycle=await runForecastCycle(at);assert.equal(cycle.status,'ready');
  const data=await getPublicData();assert.equal(data.serverTime,at);
  assert.ok(data.evidence.every(e=>Date.parse(e.publishedAt)<=time&&Date.parse(e.collectedAt)<=time),'FUTURE_EVIDENCE');
  assert.ok(data.publications.every(p=>Date.parse(p.publishedAt)<=time&&Date.parse(p.cutoffAt)<=time),'FUTURE_PUBLICATION');
  const cards=homeResetStatus(data,at).cards.map((c:any)=>({kind:c.kind,state:c.state,title:c.hero.title,label:c.hero.label,metric:c.hero.metric,clockAt:c.clockAt,timeAt:c.timeAt,expectedAt:c.expectedAt,validUntil:c.validUntil,publicationId:c.publicationId,roundKey:c.roundKey,revision:c.revision,badge:c.hero.badge,evidenceType:c.evidenceType,clockEvidenceType:c.clockEvidenceType,sourceName:c.sourceName,observationSummaryDate:c.observationSummaryDate,sharePath:c.sharePath}));
  const addedTimers:string[]=[];
  const addTimer=(v:string|undefined)=>{if(!v||!Number.isFinite(Date.parse(v))||Date.parse(v)<=time||Date.parse(v)>end)return;const at=new NativeDate(Date.parse(v)).toISOString();if(knownTimers.has(at))return;knownTimers.add(at);addedTimers.push(at);let lo=index+1,hi=ticks.length;while(lo<hi){const mid=(lo+hi)>>1;if(Date.parse(ticks[mid].at)<=Date.parse(at))lo=mid+1;else hi=mid;}ticks.splice(lo,0,{key:'timer:'+Date.parse(at),at,phase:'evaluation'});};
  const posters:any[]=[];
  for(const c of cards){const p=statusPosterInput(data,c.kind);posters.push(p);const expectedId=['cycle','history'].includes(c.evidenceType)?'':c.publicationId;
   if(p.publicationId!==(c.observationSummaryDate?'':expectedId)||p.sharePath!==c.sharePath||p.round!==c.revision||p.value!==(c.metric||c.title))issues.push({key:tick.key,at,kind:'home_poster_mismatch',target:c.kind,home:c,poster:p});
   for(const boundary of [c.expectedAt,c.validUntil]){addTimer(boundary);if(boundary)addTimer(new NativeDate(Date.parse(boundary)+1).toISOString());}if(c.expectedAt)addTimer(new NativeDate(Date.parse(c.expectedAt)+86400000).toISOString());
  }
  for(const f of [data.forecasts?.cadence,...Object.values(data.forecasts?.cadenceByKind??{})])addTimer(f?.validUntil);
  if(time>=start){const measured=evaluateHourlyPredictions(hourly,{time:at,publications:data.publications,evidence:data.evidence,automaticPublicationIds:new Set(data.publications.map(p=>p.id))});hourly=measured.state;}
  const step={key:tick.key,index:steps.length,phase:tick.phase,kind:tick.record?'message':'timer',virtualAt:at,evidenceId,message:tick.record?{sourceId:tick.record.sourceId,messageId:tick.record.messageId,publishedAt:tick.record.publishedAt,collectedAt:tick.record.collectedAt,textHash:sha(tick.record.text),url:tick.record.url}:undefined,display:cards,posters,prediction:data.forecasts?.cadence,predictionsByKind:data.forecasts?.cadenceByKind,publications:data.publications.filter(p=>!before.has(p.id)).map(p=>({id:p.id,eventId:p.eventId,article:p.article,actions:p.event.actions})),addedTimers,inputFingerprint,codeFingerprint};
  steps.push(step);done.add(tick.key);await appendFile(out+'steps.jsonl',JSON.stringify(step)+'\n');await writeFile(out+'hourly.json',JSON.stringify(hourly)+'\n');await writeFile(out+'checkpoint.json',JSON.stringify({completed:steps.length,key:tick.key,virtualAt:at,inputFingerprint,codeFingerprint})+'\n');await unlink(out+'active-step.json');
  if(steps.length%50===0){await verifyFrozen();const progress={completed:steps.length,total:ticks.length,virtualAt:at,messages:steps.filter(s=>s.kind==='message').length,issues:issues.length,publications:data.publications.length,elapsedSeconds:(NativeDate.now()-Date.parse(metadata.startedAt))/1000};await writeFile(out+'progress.json',JSON.stringify(progress)+'\n');console.log(JSON.stringify(progress));}
 }
 await verifyFrozen();assert.equal(blockedNetwork,0);assert.equal(immutableWrites,0);assert.equal((await list('wechat_deliveries')).length,0);
 const data=await getPublicData(),records:any={};for(const table of ['evidence','candidates','events','articles','publications','activities','forecast_snapshots','forecast_outcomes'] as const)records[table]=await list(table);
 const jobs=(await list<Job>('jobs')).filter(j=>j.status==='failed');
 await writeFile(out+'final-records.json',JSON.stringify(records)+'\n',{mode:0o600});
 const result={...metadata,completedAt:new NativeDate().toISOString(),steps:steps.length,messages:steps.filter(s=>s.kind==='message').length,excludedAfterCutoff,counts:Object.fromEntries(Object.entries(records).map(([k,v])=>[k,(v as any[]).length])),issues,failedJobs:jobs.map(j=>({kind:j.kind,error:j.error})),scores:scoreReplay(steps,data.forecasts?.cadence?.observations??[],input.window),hourly:evaluateHourlyPredictions(hourly,{time:input.window.end,publications:data.publications,evidence:data.evidence,automaticPublicationIds:new Set(data.publications.map(p=>p.id))}),checks:{noFutureEvidence:true,noFuturePublications:true,immutableForecasts:true,externalRequests:blockedNetwork,wechatDeliveries:0,productionWrites:0},coverage:input.coverage};
 await writeFile(out+'result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({complete:true,mode,steps:steps.length,issues:issues.length,failedJobs:jobs.length}));
}catch(e){await writeFile(out+'halted.json',JSON.stringify({at:new NativeDate().toISOString(),virtualAt:new NativeDate(time).toISOString(),completedSteps:steps.length,error:String(e)})+'\n');throw e;
}finally{globalThis.Date=NativeDate;globalThis.fetch=realFetch;await pool.end();}
