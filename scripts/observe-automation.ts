import {appendFile,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pool} from '../src/db';
import type {Evidence,Publication} from '../src/lib/types';
import {isHistoricalArticle,PUBLIC_HISTORY_RULE_VERSION} from '../src/lib/history';
import {evaluateAutomationObservation,recoverAutomationObservation,OBSERVATION_INTERVAL_MS,type AutomationObservation,type ObservationSource,type CollectionFailureScan} from '../src/lib/automation-observation';
import {acquireObservationFileLock} from './observation-lock.mjs';
import {evaluateCollectionObservation,validateCollectionObservationJournal} from '../src/lib/collection-observation';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const observerStartedAt=new Date(Date.now()-process.uptime()*1000).toISOString();
const output=resolve(root,'outputs/implementation-qa');
await mkdir(output,{recursive:true});
const statusPath=resolve(output,'daily-observation.json'),samplesPath=resolve(output,'daily-observation.jsonl');
const timingsPath=resolve(output,'daily-publication-timings.jsonl');
const collectionWindowPath=resolve(output,'collection-observation-window.json');
const collectionStatusPath=resolve(output,'collection-observation.json'),collectionSamplesPath=resolve(output,'collection-observation.jsonl');
const interval=OBSERVATION_INTERVAL_MS;
// Keep a session-level lock for the observer lifetime; no table or business data is modified.
const guard=await pool.connect().catch(async()=>{await pool.end();console.error('观察数据库暂时不可用，退出后由本机监督进程恢复。');process.exit(1);});let releaseFileLock:undefined|(()=>void);
try{
 const lock=await guard.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',[`radar_automation_observer:${root}`]);
 if(!lock.rows[0]?.acquired)throw new Error('观察进程已经运行');
 releaseFileLock=acquireObservationFileLock(root);
}catch{guard.release();await pool.end();console.error('观察未启动：已有进程或运行锁需要核对。');process.exit(1);}
let state:AutomationObservation;
let newObservation=false;
try{const saved=JSON.parse(await readFile(statusPath,'utf8'));if(!saved||!Number.isFinite(Date.parse(saved.startedAt))||!Number.isInteger(saved.samples)||!Array.isArray(saved.recordedPublicationIds))throw new Error('观察历史结构无效');state={sourceFailureSamples:0,workerFailureSamples:0,failedSamples:0,maxSamplingGapMs:0,realGeneratedPublications:0,recordedPublicationIds:[],blockers:[],...saved};}
catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){releaseFileLock?.();guard.release();await pool.end();console.error('观察历史文件无法读取，已停止；保留现有样本供核对。');process.exit(1);}newObservation=true;state={startedAt:new Date().toISOString(),samples:0,status:'observing',realNewMessages:0,actualModelCalls:0,realGeneratedPublications:0,sourceFailureSamples:0,workerFailureSamples:0,failedSamples:0,maxSamplingGapMs:0,recordedPublicationIds:[],blockers:[]};}
async function readJournal(path:string){try{return await readFile(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;}}
try{
 const samplesRaw=await readJournal(samplesPath),timingsRaw=await readJournal(timingsPath);
 if(newObservation&&(samplesRaw||timingsRaw))throw new Error('已有观察日志但缺少状态锚点');
 state=recoverAutomationObservation(state,samplesRaw,timingsRaw);
}catch{releaseFileLock?.();guard.release();await pool.end();console.error('观察日志存在残缺、冲突或状态缺口，已停止；原文件保持原样。');process.exit(1);}
// This new measurement has its own start anchor; historical imports and older
// automation samples must never be relabelled as prospective discovery data.
let collectionStartedAt:string;
try{
 try{
  const saved=JSON.parse(await readFile(collectionWindowPath,'utf8'));
  if(saved.ruleVersion!=='collection-storage-v1'||typeof saved.startedAt!=='string'||!Number.isFinite(Date.parse(saved.startedAt))||Date.parse(saved.startedAt)>Date.now())throw new Error('采集观察窗口无效');
  collectionStartedAt=saved.startedAt;
 }catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  if(await readJournal(collectionSamplesPath)||await readJournal(collectionStatusPath))throw new Error('采集观察缺少窗口锚点');
  collectionStartedAt=new Date().toISOString();
  await writeFile(collectionWindowPath,JSON.stringify({ruleVersion:'collection-storage-v1',startedAt:collectionStartedAt}),{mode:0o600,flag:'wx'});
 }
 const journal=await readJournal(collectionSamplesPath);
 validateCollectionObservationJournal(journal,collectionStartedAt,new Date().toISOString());
}catch{releaseFileLock?.();guard.release();await pool.end();console.error('采集观察文件无法核对，已停止；保留原文件等待修复。');process.exit(1);}
let stopping=false,wake:undefined|(()=>void);
guard.on('error',()=>{stopping=true;wake?.();console.error('观察运行锁连接中断，退出后由本机监督进程恢复。');});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;wake?.();});
async function save(){const temporary=statusPath+'.tmp';await writeFile(temporary,JSON.stringify(state,null,2),{mode:0o600});await rename(temporary,statusPath);}
class ObservationJournalError extends Error {}
async function appendJournal(path:string,row:unknown){try{await appendFile(path,JSON.stringify(row)+'\n',{mode:0o600});}catch{throw new ObservationJournalError('观察日志写入未完成');}}
async function readPublic(){try{const response=await fetch('http://127.0.0.1:5190/api/v1/bootstrap',{signal:AbortSignal.timeout(10_000)});if(!response.ok)return;const body=await response.json();if(!body.version||!Array.isArray(body.data?.publications)||!Array.isArray(body.data?.articles))return;return {version:String(body.version),ids:new Set<string>(body.data.publications.map((p:Publication)=>p.id)),currentIds:new Set<string>(body.data.articles.filter((a:Publication['article'])=>a.status==='published').map((a:Publication['article'])=>a.publicationId))};}catch{return;}}
async function readRuntimeIdentity(){
 const supervisor=JSON.parse(await readFile(resolve(output,'local-runtime-process.json'),'utf8'));
 if(supervisor.root!==root||supervisor.status!=='running'||!Number.isInteger(supervisor.pid))throw new Error('本机运行监督身份无法核对');
 const identities=[{name:'observer',pid:process.pid,start:observerStartedAt}];
 for(const name of ['supervisor','app','worker']){
  const record=name==='supervisor'?supervisor:JSON.parse(await readFile(resolve(output,`${name}-process.json`),'utf8'));
  if(!Number.isInteger(record.pid)||record.pid<=0||name!=='supervisor'&&record.supervisorPid!==supervisor.pid)throw new Error('本机子进程身份无法核对');
  const start=execFileSync('ps',['-p',String(record.pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'},timeout:3000}).trim();
  const command=execFileSync('ps',['-p',String(record.pid),'-o','command='],{encoding:'utf8',timeout:3000}).trim();
  const cwd=execFileSync('lsof',['-a','-p',String(record.pid),'-d','cwd','-Fn'],{encoding:'utf8',timeout:3000}).split('\n').find(line=>line.startsWith('n'))?.slice(1);
  const parent=Number(execFileSync('ps',['-p',String(record.pid),'-o','ppid='],{encoding:'utf8',timeout:3000}).trim());
  if(!start||cwd!==root||name==='app'&&!command.startsWith('next-server ')||name==='worker'&&!command.includes('scripts/worker.ts')||name==='supervisor'&&!command.includes('scripts/local-runtime.mjs')||name!=='supervisor'&&parent!==supervisor.pid)throw new Error('本机实际进程归属无法核对');
  identities.push({name,pid:record.pid,start});
 }
 const runtimeBuildId=(await readFile(resolve(root,'.next/BUILD_ID'),'utf8')).trim();
 if(!/^[a-z0-9_-]{1,200}$/i.test(runtimeBuildId))throw new Error('本机构建版本无法核对');
 return {runtimeIdentity:createHash('sha256').update(JSON.stringify([identities,runtimeBuildId])).digest('hex'),runtimeBuildId};
}
async function sample(){
 const runtimeBefore=await readRuntimeIdentity();
 const c=await pool.connect();
 let sources,heartbeat,calls,publications,evidence,automatic,ai,failureScan;
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  sources=await c.query("SELECT id,payload->>'status' AS status,payload->>'enabled' AS enabled,payload->>'validated' AS validated,payload->>'lastSuccessAt' AS last_success,(payload->>'intervalMinutes')::int AS interval_minutes,payload->>'publicationPaused' AS publication_paused FROM radar_sources WHERE payload->>'enabled'='true'");
  heartbeat=await c.query("SELECT payload->>'heartbeatAt' AS heartbeat_at,payload->>'error' AS error,(SELECT payload->>'status' FROM radar_settings WHERE id='forecast_runtime') AS forecast_status FROM radar_settings WHERE id='worker_runtime'");
  calls=await c.query("SELECT count(*)::int AS count FROM radar_ai_usage WHERE created_at>$1 AND status IN ('succeeded','estimated')",[state.startedAt]);
  publications=await c.query("SELECT payload FROM radar_publications WHERE (payload->>'publishedAt')::timestamptz>$1",[state.startedAt]);
  evidence=await c.query('SELECT payload,created_at FROM radar_evidence');
  automatic=await c.query("SELECT payload->'after'->>'id' AS publication_id FROM radar_audits WHERE payload->>'actor'='worker' AND payload->>'action' IN ('publication.publish','publication.correct') AND created_at>$1",[state.startedAt]);
  // No incremental timestamp filter or limit: created_at is transaction time,
  // and a failed job can become visible only after its transaction commits.
  // Read minimal failure facts; reasons, source payloads and credentials stay out.
  failureScan=await c.query<{scanned_from:string;read_through:Date;total:number;records:CollectionFailureScan['records']}>(`
   WITH failures AS (
    SELECT a.id,a.payload->>'createdAt' AS failed_at,j.payload->>'sourceId' AS source_id
    FROM radar_audits a LEFT JOIN radar_jobs j ON j.id=a.payload->>'objectId'
    WHERE a.payload->>'actor'='worker' AND a.payload->>'action'='job.failed' AND a.payload->'after'->>'kind'='collect'
   )
   SELECT $1::text AS scanned_from,clock_timestamp() AS read_through,count(*)::int AS total,
    coalesce(jsonb_agg(jsonb_build_object('id',id,'sourceId',source_id,'failedAt',failed_at)),'[]'::jsonb) AS records
   FROM failures`,[state.startedAt]);
  if(failureScan.rows.length!==1)throw new Error('采集失败审计覆盖记录缺失');
  // Select readiness only; credentials never enter observation files.
  ai=await c.query("SELECT (payload->>'enabled'='true' AND length(coalesce(payload->>'encryptedKey',''))>0 AND length(coalesce(payload->>'baseUrl',''))>0 AND length(coalesce(payload->>'model',''))>0 AND length(coalesce(payload->>'testedAt',''))>0 AND (payload->>'dailyCallLimit')::int>0 AND (payload->>'dailyBudget')::numeric>0 AND (payload->>'inputPrice')::numeric>0 AND (payload->>'outputPrice')::numeric>0) AS ready FROM radar_settings WHERE id='ai'");
  await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
 const publicData=await readPublic(),time=new Date().toISOString(),sampleTime=Date.parse(time);
 const runtimeAfter=await readRuntimeIdentity();
 if(runtimeBefore.runtimeIdentity!==runtimeAfter.runtimeIdentity)throw new Error('采样过程中实际运行进程发生变化');
 if(stopping)return;
 const evidenceRows=evidence.rows.map(r=>r.payload as Evidence),automaticIds=new Set(automatic.rows.map(r=>r.publication_id));
 const collection=evaluateCollectionObservation({startedAt:collectionStartedAt,time,rows:evidence.rows.map(row=>({evidence:row.payload as Evidence,storedAt:new Date(row.created_at).toISOString()}))});
 await appendJournal(collectionSamplesPath,collection);
 try{const temporary=collectionStatusPath+'.tmp';await writeFile(temporary,JSON.stringify(collection,null,2),{mode:0o600});await rename(temporary,collectionStatusPath);}
 catch{throw new ObservationJournalError('采集观察状态写入未完成');}
 const records=publications.rows.map(r=>r.payload as Publication);
 const sourceStates:ObservationSource[]=sources.rows.map(row=>({id:row.id,status:row.status,enabled:row.enabled==='true',validated:row.validated==='true',lastSuccessAt:row.last_success,intervalMinutes:row.interval_minutes||5,publicationPaused:row.publication_paused==='true'}));
 const auditScan=failureScan.rows[0];
 const collectionFailures:CollectionFailureScan={scannedFrom:auditScan.scanned_from,readThrough:auditScan.read_through.toISOString(),total:auditScan.total,records:auditScan.records};
 const evaluated=evaluateAutomationObservation(state,{time,sources:sourceStates,heartbeatAt:heartbeat.rows[0]?.heartbeat_at,workerError:heartbeat.rows[0]?.forecast_status==='error'?'预测观察暂时异常':heartbeat.rows[0]?.error,aiReady:!!ai.rows[0]?.ready,modelSuccessfulCalls:calls.rows[0].count,evidence:evidenceRows,publications:records,automaticPublicationIds:automaticIds,publicData,collectionFailures,...runtimeAfter});
 const firstByUrl=new Map<string,string>();for(const e of evidenceRows){const first=firstByUrl.get(e.url);if(!first||Date.parse(e.collectedAt)<Date.parse(first))firstByUrl.set(e.url,e.collectedAt);}
 const seen=new Set(state.recordedPublicationIds);
 for(const p of records){if(seen.has(p.id)||!publicData?.ids.has(p.id))continue;const cited=evidenceRows.filter(e=>p.article.evidenceIds.includes(e.id));const collectedAt=cited.length?new Date(Math.max(...cited.map(e=>Date.parse(e.collectedAt)))).toISOString():undefined;
  const observationDelay=Math.max(0,sampleTime-Date.parse(p.publishedAt));
  await appendJournal(timingsPath,{publicationId:p.id,sourcePublishedAt:p.article.sourcePublishedAt,discoveredAt:'NOT_MEASURED',firstCollectedAt:cited.map(e=>firstByUrl.get(e.url)),inputReadyAt:collectedAt,publishedAt:p.publishedAt,publicApiFirstObservedAt:time,collectionToPublicationMs:collectedAt?Date.parse(p.publishedAt)-Date.parse(collectedAt):null,publicationToApiObservationMs:observationDelay,publicationToApiObservationUpperBoundMs:observationDelay,apiObservationMeasurement:'first_observed_upper_bound',browserVisibleAt:'NOT_MEASURED',historical:isHistoricalArticle(p.article,evidenceRows),historyRuleVersion:PUBLIC_HISTORY_RULE_VERSION,contentOrigin:p.contentOrigin,automatic:automaticIds.has(p.id)});seen.add(p.id);}
 state={...evaluated.state,recordedPublicationIds:[...seen]};
 if(stopping)return;
 await appendJournal(samplesPath,{sampleId:`${state.startedAt}:${state.samples}`,sequence:state.samples,observationState:state,time,sources:sources.rows,workerHealthy:evaluated.workerHealthy,websiteHealthy:!!publicData,aiReady:!!ai.rows[0]?.ready,newMessages:state.realNewMessages,actualModelCalls:state.actualModelCalls,modelSuccessfulCalls:state.actualModelCalls,modelCallAttribution:'successful_or_estimated_provider_calls_includes_connection_tests',publications:records.length,realGeneratedPublications:state.realGeneratedPublications,currentRealGeneratedPublications:state.currentRealGeneratedPublications,realTemplatePublications:state.realTemplatePublications,currentRealTemplatePublications:state.currentRealTemplatePublications,publicVersion:state.publicVersion,blockers:state.blockers,runtimeBlockers:state.runtimeBlockers,runtimeStatus:state.runtimeStatus,templateStatus:state.templateStatus,ruleVersion:state.ruleVersion,ruleActivatedAt:state.ruleActivatedAt,newCollectionFailures:evaluated.newCollectionFailures,collectionFailureEvents:state.collectionFailureEvents,collectionFailureInterrupted:evaluated.collectionFailureInterrupted,collectionFailureReadThrough:state.collectionFailureReadThrough,apiObservationMeasurement:'first_observed_upper_bound',discoveredAt:'NOT_MEASURED',browserVisibleAt:'NOT_MEASURED'});await save();
}
try{do{try{await sample();}catch(error){if(error instanceof ObservationJournalError){console.error('观察日志写入未完成，已停止；保留原文件等待核对。');process.exitCode=1;break;}state={...state,status:'interrupted',runtimeStatus:'interrupted',templateStatus:'interrupted',continuousHealthySince:undefined,requiredUntil:undefined,continuousRuntimeHealthySince:undefined,runtimeRequiredUntil:undefined,continuousTemplateHealthySince:undefined,templateRequiredUntil:undefined,failedSamples:state.failedSamples+1,error:'观察采样暂时失败，下一轮自动重试'};await save();}if(stopping||process.argv.includes('--once'))break;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{wake=undefined;resolve();},interval);wake=()=>{clearTimeout(timer);wake=undefined;resolve();};});}while(!stopping);}finally{try{releaseFileLock?.();}finally{guard.release();await pool.end();}}
