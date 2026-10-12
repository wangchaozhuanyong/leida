import {spawn} from 'node:child_process';
import {appendFileSync,existsSync,mkdirSync,openSync,closeSync,readFileSync,realpathSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const minute=60_000;
export const defaultBackupConfig={enabled:false,intervalMinutes:1440,retryMinutes:30,timeoutMinutes:30};
const failureLabels={interrupted:'备份被停止或上次运行中断，等待自动重试',timeout:'备份超过运行时限，等待自动重试',start_failed:'备份命令未能启动，等待自动重试',backup_failed:'数据库备份未通过，等待自动重试',invalid_output:'备份结果未通过文件校验，等待自动重试',configuration:'备份调度配置无效，修正后自动恢复'};
const location=root=>({config:resolve(root,'scripts/backup-config.json'),output:resolve(root,'outputs/implementation-qa'),directory:resolve(root,'backups/database')});
function readJSON(path){try{return JSON.parse(readFileSync(path,'utf8'));}catch{return undefined;}}
function loadConfig(root){
 const path=location(root).config;
 if(!existsSync(path))return {...defaultBackupConfig,configured:false};
 let config;try{config=JSON.parse(readFileSync(path,'utf8'));}catch{throw new Error('configuration');}
 if(!config||typeof config!=='object'||Array.isArray(config)||typeof config.enabled!=='boolean'||Object.keys(config).some(key=>!Object.hasOwn(defaultBackupConfig,key)))throw new Error('configuration');
 const merged={...defaultBackupConfig,...config};
 for(const [key,min,max]of [['intervalMinutes',5,10080],['retryMinutes',1,1440],['timeoutMinutes',1,120]])if(!Number.isInteger(merged[key])||merged[key]<min||merged[key]>max)throw new Error('configuration');
 return {...merged,configured:true};
}
function validBackupFile(root,file){
 try{const directory=realpathSync(location(root).directory),path=realpathSync(file);return path.startsWith(directory+sep)&&/\/radar-[\w-]+\.dump$/.test(path)&&statSync(path).isFile()&&statSync(path).size>0;}catch{return false;}
}
function terminate(child,signal){try{process.kill(-child.pid,signal);}catch{try{child.kill(signal);}catch{}}}

/** Only the existing project backup script is launched; raw child errors never enter status or logs. */
export function runDatabaseBackup(root,timeoutMinutes,signal){
 return new Promise(resolveResult=>{
  const child=spawn('bash',[resolve(root,'scripts/backup-database.sh')],{cwd:root,env:process.env,stdio:['ignore','pipe','ignore'],detached:process.platform!=='win32'});
  let output='',failure,killTimer,done=false;
  const stop=code=>{if(done)return;failure=code;terminate(child,'SIGTERM');killTimer??=setTimeout(()=>terminate(child,'SIGKILL'),5000);};
  const timeout=setTimeout(()=>stop('timeout'),timeoutMinutes*minute);
  const abort=()=>stop('interrupted');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const finish=result=>{if(done)return;done=true;clearTimeout(timeout);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);resolveResult(result);};
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{if(output.length<16_000)output+=chunk.slice(0,16_000-output.length);});
  child.on('error',()=>finish({ok:false,code:'start_failed'}));
  child.on('close',code=>{
   if(failure)return finish({ok:false,code:failure});
   if(code!==0)return finish({ok:false,code:'backup_failed'});
   const file=output.split('\n').find(line=>line.startsWith('BACKUP_FILE='))?.slice('BACKUP_FILE='.length);
   finish(file&&validBackupFile(root,file)?{ok:true,file}:{ok:false,code:'invalid_output'});
  });
 });
}

export class BackupScheduler {
 constructor({root,clock=Date.now,run=runDatabaseBackup}){
  this.root=resolve(root);this.clock=clock;this.run=run;this.paths=location(this.root);
  mkdirSync(this.paths.output,{recursive:true});
  this.statusPath=resolve(this.paths.output,'backup-status.json');this.eventPath=resolve(this.paths.output,'backup-events.jsonl');
  const saved=readJSON(this.statusPath);this.state=saved&&saved.version===1?saved:{version:1,status:'unobserved',consecutiveFailures:0};
  this.interrupted=this.state.status==='running';this.busy=false;this.controller=undefined;this.serial=0;
 }
 time(){return new Date(this.clock()).toISOString();}
 save(){
  this.state={...this.state,heartbeatAt:this.time(),pid:process.pid};
  const temporary=this.statusPath+`.tmp-${process.pid}-${++this.serial}`;
  writeFileSync(temporary,JSON.stringify(this.state,null,2),{mode:0o600});renameSync(temporary,this.statusPath);
 }
 event(kind,extra={}){appendFileSync(this.eventPath,JSON.stringify({at:this.time(),kind,...extra})+'\n',{mode:0o600});}
 stop(){this.controller?.abort();}
 async tick({runNow=false}={}){
  if(this.busy){this.save();return this.state;}
  let config;try{config=loadConfig(this.root);}catch{
   if(this.state.status!=='configuration_error')this.event('configuration_error');
   this.state={...this.state,status:'configuration_error',enabled:false,error:failureLabels.configuration,nextRunAt:undefined};this.save();return this.state;
  }
  const policyChanged=this.state.intervalMinutes!==config.intervalMinutes;
  if(this.state.status==='configuration_error')this.state={...this.state,status:'waiting',error:undefined};
  this.state={...this.state,enabled:config.enabled,configured:config.configured,intervalMinutes:config.intervalMinutes,retryMinutes:config.retryMinutes,timeoutMinutes:config.timeoutMinutes};
  if(!config.enabled){
   if(this.state.status!=='disabled')this.event('disabled');
   this.state={...this.state,status:'disabled',nextRunAt:undefined,error:undefined};this.save();return this.state;
  }
  if(this.interrupted){
   this.interrupted=false;this.state={...this.state,status:'failed',lastFailureAt:this.time(),lastFailureCode:'interrupted',error:failureLabels.interrupted,consecutiveFailures:this.state.consecutiveFailures+1,nextRunAt:new Date(this.clock()+config.retryMinutes*minute).toISOString()};this.event('failure',{code:'interrupted'});
  }
  if(!this.state.nextRunAt||policyChanged){
   const first=this.state.lastSuccessAt?Date.parse(this.state.lastSuccessAt):this.clock();
   this.state.nextRunAt=new Date(first+config.intervalMinutes*minute).toISOString();
  }
  if(runNow)this.state.nextRunAt=this.time();
  if(this.clock()<Date.parse(this.state.nextRunAt)){this.state.status=this.state.error?'failed':'waiting';this.save();return this.state;}
  this.busy=true;this.controller=new AbortController();this.state={...this.state,status:'running',lastAttemptAt:this.time(),error:undefined};this.save();this.event('started',{requestedNow:runNow});
  let result;
  try{result=await this.run(this.root,config.timeoutMinutes,this.controller.signal);}catch{result={ok:false,code:'backup_failed'};}
  this.busy=false;this.controller=undefined;
  if(result?.ok&&validBackupFile(this.root,result.file)){
   this.state={...this.state,status:'waiting',lastSuccessAt:this.time(),backupFile:result.file,error:undefined,lastFailureCode:undefined,consecutiveFailures:0,nextRunAt:new Date(this.clock()+config.intervalMinutes*minute).toISOString()};this.event('succeeded',{file:result.file});
  }else{
   const code=Object.hasOwn(failureLabels,result?.code)?result.code:'invalid_output';
   this.state={...this.state,status:'failed',lastFailureAt:this.time(),lastFailureCode:code,error:failureLabels[code],consecutiveFailures:this.state.consecutiveFailures+1,nextRunAt:new Date(this.clock()+config.retryMinutes*minute).toISOString()};this.event('failure',{code});
  }
  this.save();return this.state;
 }
}

export function backupHealth(root,timestamp=Date.now()){
 const state=readJSON(resolve(location(root).output,'backup-status.json'));
 let config;try{config=loadConfig(root);}catch{return {scheduler:'unobserved',backup:'configuration_error',error:failureLabels.configuration};}
 const elapsed=state?.heartbeatAt?timestamp-Date.parse(state.heartbeatAt):NaN;
 const scheduler=!state?'unobserved':state.status==='stopped'?'stopped':Number.isFinite(elapsed)&&elapsed>=0&&elapsed<90_000?'healthy':'stale';
 const backup=!config.enabled?'disabled':!state?'not_run':state.error?'failed':!state.lastSuccessAt?'not_run':!validBackupFile(root,state.backupFile)?'missing':timestamp-Date.parse(state.lastSuccessAt)>(config.intervalMinutes+config.timeoutMinutes)*minute?'delayed':'healthy';
 return {scheduler,backup,enabled:config.enabled,configured:config.configured,heartbeatAt:state?.heartbeatAt,lastSuccessAt:state?.lastSuccessAt,lastFailureAt:state?.lastFailureAt,lastFailureCode:state?.lastFailureCode,nextRunAt:state?.nextRunAt,backupFile:state?.backupFile,error:state?.error};
}

export function acquireBackupLock(root){
 const output=location(root).output;mkdirSync(output,{recursive:true});const path=resolve(output,'backup-scheduler.lock');
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
 if(existsSync(path)){const previous=readJSON(path);if(!Number.isInteger(previous?.pid)||previous.pid<=0||alive(previous.pid))throw new Error('备份调度已经运行或运行锁需要核对。');unlinkSync(path);}
 const descriptor=openSync(path,'wx',0o600);
 try{writeFileSync(descriptor,JSON.stringify({pid:process.pid,root}));}catch(error){try{unlinkSync(path);}catch{}throw error;}finally{closeSync(descriptor);}
 return ()=>{if(readJSON(path)?.pid===process.pid)unlinkSync(path);};
}
export async function main(root){
 if(process.argv.includes('--health')){const status=backupHealth(root);console.log(JSON.stringify(status));process.exitCode=status.scheduler==='healthy'&&['disabled','not_run','healthy'].includes(status.backup)?0:1;return;}
 let release;try{release=acquireBackupLock(root);}catch{console.error('备份调度未启动，请检查本项目已有进程与运行锁。');process.exitCode=1;return;}
 const scheduler=new BackupScheduler({root});let stopping=false,wake,runNow=process.argv.includes('--run-now');
 const stop=()=>{stopping=true;scheduler.stop();wake?.();};
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
 const heartbeat=setInterval(()=>{try{scheduler.save();}catch{console.error('备份状态暂时无法保存，请检查目录权限与磁盘空间。');process.exitCode=1;stop();}},20_000);
 try{do{
  try{
   const result=await scheduler.tick({runNow});
   if(runNow){
    if(!result.enabled){console.error('备份配置未启用或无效，未执行立即备份。');process.exitCode=1;break;}
    if(result.error){console.error('立即备份未完成，请查看备份状态和失败记录。');if(process.argv.includes('--once'))process.exitCode=1;}
    else console.log('立即备份完成，已保存校验结果与下次运行时间。');
    runNow=false;
   }
  }catch{console.error('备份调度暂时异常，退出后由运行监督恢复；已有备份保持不变。');process.exitCode=1;break;}
  if(stopping||process.argv.includes('--once'))break;
  await new Promise(resolveWait=>{const timer=setTimeout(()=>{wake=undefined;resolveWait();},30_000);wake=()=>{clearTimeout(timer);wake=undefined;resolveWait();};});
 }while(!stopping);}finally{
  clearInterval(heartbeat);scheduler.state={...scheduler.state,status:'stopped',stoppedAt:scheduler.time()};try{scheduler.save();}catch{console.error('备份停止状态未能保存，请检查目录权限与磁盘空间。');process.exitCode=1;}finally{try{release();}catch{console.error('备份运行锁未能释放，请检查目录权限。');process.exitCode=1;}}
  for(const signal of ['SIGINT','SIGTERM'])process.removeListener(signal,stop);
 }
}
const entryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main(entryRoot);
