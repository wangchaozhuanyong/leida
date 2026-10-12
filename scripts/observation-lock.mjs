import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {closeSync,existsSync,openSync,readFileSync,realpathSync,unlinkSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const script='scripts/observe-automation.ts';
const readJSON=path=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return undefined;}};
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** A reused PID alone does not identify this project's observer. Raw command lines are never saved. */
export function observerProcessIdentity(pid,root){
 if(!Number.isInteger(pid)||pid<=0)return {state:'unknown'};
 try{process.kill(pid,0);}catch(error){return {state:error.code==='ESRCH'?'missing':'unknown'};}
 try{
  const raw=execFileSync('ps',['-p',String(pid),'-o','lstart=','-o','command='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'},timeout:3000}).trim();
  const start=raw.slice(0,24),command=raw.slice(24).trim();
  const cwd=process.platform==='linux'?realpathSync(`/proc/${pid}/cwd`):execFileSync('lsof',['-a','-p',String(pid),'-d','cwd','-Fn'],{encoding:'utf8',timeout:3000}).split('\n').find(line=>line.startsWith('n'))?.slice(1);
  if(!cwd||!start||!command)return {state:'unknown'};
  const isScript=new RegExp(`(?:^|\\s)(?:${escape(resolve(root,script))}|${escape(script)})(?:\\s|$)`).test(command);
  if(realpathSync(cwd)!==realpathSync(root)||!isScript||!/(?:^|\/)node(?:\s|$)/.test(command))return {state:'other'};
  return {state:'observer',identity:createHash('sha256').update(`${start}\n${realpathSync(cwd)}\n${command}`).digest('hex')};
 }catch{return {state:'unknown'};}
}
/** Call only while holding the database observer advisory lock; this serializes stale-lock recovery. */
export function acquireObservationFileLock(root,{probe=observerProcessIdentity,pid=process.pid}={}){
 const output=resolve(root,'outputs/implementation-qa'),path=resolve(output,'daily-observer.lock'),manifestPath=resolve(output,'daily-observer-process.json');
 const previousManifest=readJSON(manifestPath);
 if(previousManifest?.pid&&previousManifest.pid!==pid){
  const live=probe(previousManifest.pid,root);
  if(live.state==='unknown'||live.state==='observer')throw new Error('本项目已有观察进程或进程身份暂时无法核对');
 }
 if(existsSync(path)){
  const old=readJSON(path);
  if(!old||old.root!==root||!Number.isInteger(old.pid))throw new Error('观察运行锁需要核对');
  const live=probe(old.pid,root);
  if(live.state==='unknown'||live.state==='observer')throw new Error('本项目观察进程已经运行');
  unlinkSync(path);
 }
 const identity=probe(pid,root);
 if(identity.state!=='observer')throw new Error('当前观察进程身份未通过核对');
 const token=randomUUID(),startedAt=new Date().toISOString(),owner={pid,root,identity:identity.identity,token,startedAt};
 const descriptor=openSync(path,'wx',0o600);
 try{writeFileSync(descriptor,JSON.stringify(owner));}finally{closeSync(descriptor);}
 try{writeFileSync(manifestPath,JSON.stringify({...owner,status:'running',previousPid:previousManifest?.pid}));}
 catch(error){if(readJSON(path)?.token===token)unlinkSync(path);throw error;}
 return ()=>{
  if(readJSON(path)?.token!==token)return;
  writeFileSync(manifestPath,JSON.stringify({...owner,status:'stopped',stoppedAt:new Date().toISOString()}));unlinkSync(path);
 };
}
