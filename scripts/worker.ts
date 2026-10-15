import { pool } from '../src/db';
import { runOne, writeWorkerHeartbeat } from '../src/server/worker';
import {createWorkerHeartbeat,WORKER_HEARTBEAT_MS,WORKER_IDLE_MS,workerRetryDelay} from '../src/server/worker-timing';
import {setTimeout as sleep} from 'node:timers/promises';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// A startup receipt binds the active worker to its collector sources. It contains
// only hashes and process identity, never configuration or provider credentials.
const sourcePaths=['scripts/worker.ts','src/server/worker.ts','src/server/worker-timing.ts','src/server/ingestion.ts','src/server/tibo-public.ts'];
const hashes=Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(resolve(root,path))).digest('hex')])));
const proof=resolve(root,'outputs/implementation-qa/worker-source-proof.json');
if(!process.argv.includes('--once')){
await mkdir(dirname(proof),{recursive:true});
await writeFile(proof+`.${process.pid}.tmp`,JSON.stringify({pid:process.pid,root,startedAt:new Date().toISOString(),collectorVersion:'free-source-bounded-retry-v2',hashes},null,2),{mode:0o600});
await rename(proof+`.${process.pid}.tmp`,proof);
}
let stopping=false;
const shutdown=new AbortController();
const stop=()=>{stopping=true;shutdown.abort();};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
const pause=async(ms:number)=>{try{await sleep(ms,undefined,{signal:shutdown.signal});}catch(error){if(!shutdown.signal.aborted)throw error;}};
let heartbeatTimer:ReturnType<typeof setInterval>|undefined;
const heartbeat=createWorkerHeartbeat((error,processedAt)=>writeWorkerHeartbeat(error,processedAt??false));
let failures=0;
try {
  if(process.argv.includes('--once')) {
    const did=await runOne();await writeWorkerHeartbeat(undefined,did);
    console.log(did?'已处理一个后台任务':'当前没有待处理任务');
  } else {
    console.log('后台任务服务已启动');
    await heartbeat.flush();
    heartbeatTimer=setInterval(()=>{void heartbeat.flush();},WORKER_HEARTBEAT_MS);
    while(!stopping) {
      try {
        const did=await runOne();
        failures=0;heartbeat.setError(undefined);
        if(did)heartbeat.processed();
        await heartbeat.flush();
        if(!did)await pause(WORKER_IDLE_MS);
      } catch {
        // Do not print raw provider/database errors: those may contain endpoints or credentials.
        console.error('后台任务暂时异常，将自动重试');
        heartbeat.setError('任务服务暂时异常，正在自动恢复');
        await heartbeat.flush();
        await pause(workerRetryDelay(++failures));
      }
    }
  }
} finally {
  if(heartbeatTimer)clearInterval(heartbeatTimer);
  await heartbeat.settled();
  // A claimed task retains its lease on shutdown and is resumed after expiry.
  await pool.end();
}
