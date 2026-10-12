import { pool } from '../src/db';
import { runOne, writeWorkerHeartbeat } from '../src/server/worker';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// A startup receipt binds the active worker to its collector sources. It contains
// only hashes and process identity, never configuration or provider credentials.
const sourcePaths=['scripts/worker.ts','src/server/worker.ts','src/server/ingestion.ts','src/server/tibo-public.ts'];
const hashes=Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(resolve(root,path))).digest('hex')])));
const proof=resolve(root,'outputs/implementation-qa/worker-source-proof.json');
if(!process.argv.includes('--once')){
await mkdir(dirname(proof),{recursive:true});
await writeFile(proof+`.${process.pid}.tmp`,JSON.stringify({pid:process.pid,root,startedAt:new Date().toISOString(),collectorVersion:'free-source-bounded-retry-v2',hashes},null,2),{mode:0o600});
await rename(proof+`.${process.pid}.tmp`,proof);
}
let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
const pause=()=>new Promise(resolve=>setTimeout(resolve,5000));
let heartbeatTimer:ReturnType<typeof setInterval>|undefined;
let heartbeatError:string|undefined;
let heartbeatBusy=false;
const heartbeat=async()=>{
  if(heartbeatBusy)return;
  heartbeatBusy=true;
  try {await writeWorkerHeartbeat(heartbeatError);} catch { /* Heartbeat resumes with the database. */ }
  finally {heartbeatBusy=false;}
};
try {
  if(process.argv.includes('--once')) {
    const did=await runOne();await writeWorkerHeartbeat(undefined,did);
    console.log(did?'已处理一个后台任务':'当前没有待处理任务');
  } else {
    console.log('后台任务服务已启动');
    await heartbeat();
    heartbeatTimer=setInterval(()=>{void heartbeat();},20_000);
    while(!stopping) {
      try {
        const did=await runOne();
        heartbeatError=undefined;
        await writeWorkerHeartbeat(undefined,did);
        if(!did)await pause();
      } catch {
        // Do not print raw provider/database errors: those may contain endpoints or credentials.
        console.error('后台任务暂时异常，将自动重试');
        heartbeatError='任务服务暂时异常，正在自动恢复';
        await heartbeat();
        await pause();
      }
    }
  }
} finally {
  if(heartbeatTimer)clearInterval(heartbeatTimer);
  // A claimed task retains its lease on shutdown and is resumed after expiry.
  await pool.end();
}
