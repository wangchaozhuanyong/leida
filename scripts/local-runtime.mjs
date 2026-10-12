import {spawn} from 'node:child_process';
import {openSync,closeSync,writeFileSync,readFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'outputs/implementation-qa');
mkdirSync(output,{recursive:true});
const processPath=resolve(output,'local-runtime-process.json'),lockPath=resolve(output,'local-runtime.lock');
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
try{const previous=JSON.parse(readFileSync(processPath,'utf8'));if(previous.root===root&&previous.pid!==process.pid&&alive(previous.pid)){console.error('本项目服务已经启动，请勿重复运行');process.exit(1);}}catch{}
let lock;
try{lock=openSync(lockPath,'wx',0o600);}catch(error){
 if(error.code!=='EEXIST')throw error;
 let previous;try{previous=JSON.parse(readFileSync(lockPath,'utf8'));}catch{}
 if(!previous?.pid||alive(previous.pid)){console.error('本项目运行锁仍在使用，请检查已有服务');process.exit(1);}
 unlinkSync(lockPath);lock=openSync(lockPath,'wx',0o600);
}
writeFileSync(lock,JSON.stringify({pid:process.pid,root}));closeSync(lock);
process.on('exit',()=>{try{if(JSON.parse(readFileSync(lockPath,'utf8')).pid===process.pid)unlinkSync(lockPath);}catch{};writeFileSync(processPath,JSON.stringify({pid:process.pid,root,stoppedAt:new Date().toISOString(),status:'stopped'}));});
const services={app:['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','5190'],worker:['--import','tsx','scripts/worker.ts'],backup:['scripts/backup-scheduler.mjs'],observer:['--import','tsx','scripts/observe-automation.ts']};
const children=new Map(),timers=new Set();let stopping=false;
writeFileSync(processPath,JSON.stringify({pid:process.pid,root,startedAt:new Date().toISOString(),status:'running'}));
function start(name,attempt=0){
 if(stopping)return;
 const log=openSync(resolve(output,`${name}.log`),'a',0o600);
 const child=spawn(process.execPath,services[name],{cwd:root,env:{...process.env,NODE_ENV:'production'},stdio:['ignore',log,log]});
 closeSync(log);
 children.set(name,child);
 writeFileSync(resolve(output,`${name}-process.json`),JSON.stringify({pid:child.pid,supervisorPid:process.pid,...(name==='app'?{port:5190}:{})}));
 let exited=false;
 const restart=()=>{if(exited)return;exited=true;children.delete(name);if(stopping){if(!children.size)process.exit(0);return;}
  const timer=setTimeout(()=>{timers.delete(timer);start(name,Math.min(attempt+1,4));},Math.min(60_000,3000*2**attempt));timers.add(timer);
 };
 child.on('error',restart);child.on('exit',restart);
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(stopping)return;stopping=true;for(const timer of timers)clearTimeout(timer);for(const child of children.values())child.kill(signal);if(!children.size)process.exit(0);setTimeout(()=>{for(const child of children.values())child.kill('SIGKILL');process.exit(0);},30_000).unref();});
for(const name of Object.keys(services))start(name);
