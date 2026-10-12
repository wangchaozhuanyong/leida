import {appendFile,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pool} from '../src/db';
import {AUTOMATIC_RULES_VERSION} from '../src/server/benefit-rules';
import {RESET_CADENCE_MODEL_VERSION} from '../src/lib/reset-cadence';
import {evaluateHourlyPredictions,HOURLY_OBSERVATION_VERSION,type HourlyPredictionObservation} from '../src/lib/hourly-prediction-observation';
import type {Evidence,Publication} from '../src/lib/types';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'outputs/implementation-qa/hourly-continuation-20261012/prediction/live');
const connection=new URL(process.env.DATABASE_URL??'');
if(root!=='/Users/wangchao/Desktop/源码文件夹/重置雷达'||connection.hostname!=='127.0.0.1'||connection.port!=='55489'||connection.pathname!=='/radar')throw new Error('只允许读取本项目本地数据库');
await mkdir(output,{recursive:true});
const client=await pool.connect();
try{
 const acquired=await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',[`radar_hourly_observer:${root}`]);
 if(!acquired.rows[0]?.acquired)throw new Error('小时预测复核已运行');
 const files=['src/server/benefit-rules.ts','src/server/reset-cadence-evidence.ts','src/lib/reset-cadence.ts','src/lib/hourly-prediction-observation.ts'];
 const hashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(resolve(root,file))).digest('hex')])));
 const fingerprint=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
 const windowPath=resolve(output,'window.json'),statePath=resolve(output,'state.json'),journalPath=resolve(output,'samples.jsonl');
 const read=async(path:string)=>{try{return await readFile(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;}};
 const journal=await read(journalPath),saved=await read(statePath),rawWindow=await read(windowPath);
 let window:{startedAt:string;fingerprint:string;hashes:typeof hashes;rulesVersion:string;cadenceVersion:string};
 if(!rawWindow){
  if(journal||saved)throw new Error('小时观察缺少原始锚点，保留现有文件');
  window={startedAt:new Date().toISOString(),fingerprint,hashes,rulesVersion:AUTOMATIC_RULES_VERSION,cadenceVersion:RESET_CADENCE_MODEL_VERSION};
  await writeFile(windowPath,JSON.stringify(window,null,2)+'\n',{flag:'wx',mode:0o600});
 }else window=JSON.parse(rawWindow);
 if(window.fingerprint!==fingerprint||!Number.isFinite(Date.parse(window.startedAt))||Date.parse(window.startedAt)>Date.now())throw new Error('小时观察源码或窗口发生变化，需保留旧窗口并另行复核');
 let state:HourlyPredictionObservation=saved?JSON.parse(saved):{version:HOURLY_OBSERVATION_VERSION,startedAt:window.startedAt,cases:[]};
 if(state.startedAt!==window.startedAt)throw new Error('小时观察状态锚点不匹配');
 if(journal){
  if(!journal.endsWith('\n'))throw new Error('小时观察日志含未完成行');
  let priorAt=Date.parse(window.startedAt);
  for(const line of journal.trimEnd().split('\n')){
   const row=JSON.parse(line);
   if(row.fingerprint!==fingerprint||row.state?.startedAt!==window.startedAt||!Number.isFinite(Date.parse(row.checkedAt))||Date.parse(row.checkedAt)<priorAt||row.state.lastCheckedAt!==row.checkedAt)throw new Error('小时观察日志身份或时间无效');
   evaluateHourlyPredictions(row.state,{time:row.checkedAt,publications:[],evidence:[],automaticPublicationIds:new Set()});
   if(Date.parse(row.checkedAt)>=Date.parse(state.lastCheckedAt??window.startedAt))state=row.state;
   priorAt=Date.parse(row.checkedAt);
  }
 }
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 let publications,evidence,automatic;
 try{
  publications=await client.query('SELECT payload FROM radar_publications');
  evidence=await client.query('SELECT payload FROM radar_evidence');
  automatic=await client.query("SELECT payload->'after'->>'id' AS id FROM radar_audits WHERE payload->>'actor'='worker' AND payload->>'action' IN ('publication.publish','publication.correct') AND created_at>=$1",[window.startedAt]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}
 const checkedAt=new Date().toISOString();
 const result=evaluateHourlyPredictions(state,{time:checkedAt,publications:publications.rows.map(row=>row.payload as Publication),evidence:evidence.rows.map(row=>row.payload as Evidence),automaticPublicationIds:new Set(automatic.rows.map(row=>row.id))});
 const row={checkedAt,fingerprint,rulesVersion:AUTOMATIC_RULES_VERSION,cadenceVersion:RESET_CADENCE_MODEL_VERSION,state:result.state,summary:result.summary,mainBusinessWrites:0,paidRequests:0};
 await appendFile(journalPath,JSON.stringify(row)+'\n',{mode:0o600});
 for(const [path,body] of [[statePath,result.state],[resolve(output,'summary.json'),row]] as const){await writeFile(path+'.tmp',JSON.stringify(body,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);}
 console.log(JSON.stringify({checkedAt,startedAt:window.startedAt,...result.summary,mainBusinessWrites:0,paidRequests:0}));
}finally{client.release();await pool.end();}
