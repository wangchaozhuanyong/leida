import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {BackupScheduler,backupHealth,acquireBackupLock,runDatabaseBackup} from './backup-scheduler.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(project,'outputs/implementation-qa/backup-scheduler-qa-20261010');mkdirSync(output,{recursive:true});
const origin=Date.parse('2026-10-10T00:00:00Z'),minute=60_000;
function fixture(){const root=mkdtempSync(resolve(output,'fixture-'));mkdirSync(resolve(root,'scripts'));return root;}
function configure(root,extra={}){writeFileSync(resolve(root,'scripts/backup-config.json'),JSON.stringify({enabled:true,intervalMinutes:5,retryMinutes:1,timeoutMinutes:1,...extra}));}
function fakeBackup(root,name='radar-stub.dump'){const file=resolve(root,'backups/database',name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'stub data, not a real database backup');return {ok:true,file};}
function installDockerStub(root){
 copyFileSync(resolve(project,'scripts/backup-database.sh'),resolve(root,'scripts/backup-database.sh'));
 const bin=resolve(root,'stub-bin');mkdirSync(bin);
 writeFileSync(resolve(bin,'docker'),`#!/usr/bin/env bash
case "$*" in
 *pg_dump*)
  case "\${BACKUP_STUB_MODE:-success}" in
   failure) echo 'fixture-secret-must-not-leak' >&2; exit 42;;
   empty) exit 0;;
   invalid) printf 'invalid';;
   slow) sleep 2; printf 'PGDMP-fixture';;
   *) printf 'PGDMP-fixture';;
  esac;;
 *pg_restore*) text="$(cat)"; [[ "$text" == PGDMP-fixture ]] || exit 43;;
 *) exit 91;;
esac
`,{mode:0o700});
 return bin;
}

test('未配置不执行；首次启用等待设定间隔，支持热配置',async()=>{
 const root=fixture();let time=origin,calls=0;
 const scheduler=new BackupScheduler({root,clock:()=>time,run:async()=>{calls++;return fakeBackup(root);}});
 assert.equal((await scheduler.tick()).status,'disabled');assert.equal(scheduler.state.configured,false);assert.equal(calls,0);
 configure(root);assert.equal((await scheduler.tick()).nextRunAt,new Date(origin+5*minute).toISOString());assert.equal(calls,0);
 time+=5*minute;await scheduler.tick();assert.equal(calls,1);assert.equal(scheduler.state.lastSuccessAt,new Date(time).toISOString());
 configure(root,{enabled:false});await scheduler.tick();time+=24*60*minute;await scheduler.tick();assert.equal(calls,1);assert.equal(backupHealth(root,time).backup,'disabled');
});

test('重启保留到期时间，长时间停机只补一次，不回放所有错过周期',async()=>{
 const root=fixture();configure(root);let time=origin,calls=0;
 const dependencies={root,clock:()=>time,run:async()=>{calls++;return fakeBackup(root);}};
 await new BackupScheduler(dependencies).tick();time+=30*minute;
 const recovered=new BackupScheduler(dependencies);await recovered.tick();assert.equal(calls,1);assert.equal(recovered.state.nextRunAt,new Date(time+5*minute).toISOString());
 await new BackupScheduler(dependencies).tick();assert.equal(calls,1);
});

test('失败使用固定说明且到冷却时间才重试，成功后保留失败历史',async()=>{
 const root=fixture();configure(root);let time=origin,calls=0;
 const scheduler=new BackupScheduler({root,clock:()=>time,run:async()=>{if(++calls===1)throw new Error('fixture-secret-must-not-leak');return fakeBackup(root);}});
 await scheduler.tick();time+=5*minute;await scheduler.tick();assert.equal(scheduler.state.status,'failed');assert.equal(scheduler.state.consecutiveFailures,1);
 time+=minute-1;await scheduler.tick();assert.equal(calls,1);time++;await scheduler.tick();assert.equal(calls,2);assert.equal(scheduler.state.consecutiveFailures,0);assert.ok(scheduler.state.lastFailureAt);
 assert.doesNotMatch(readFileSync(scheduler.statusPath,'utf8')+readFileSync(scheduler.eventPath,'utf8'),/fixture-secret/);
});

test('重启发现未完成运行，记录中断并等待重试，不冒充成功',async()=>{
 const root=fixture();configure(root);let time=origin,calls=0;
 const scheduler=new BackupScheduler({root,clock:()=>time,run:async()=>{calls++;return fakeBackup(root);}});await scheduler.tick();
 scheduler.state={...scheduler.state,status:'running',lastAttemptAt:scheduler.time()};scheduler.save();time+=minute;
 const resumed=new BackupScheduler({root,clock:()=>time,run:async()=>{calls++;return fakeBackup(root);}});await resumed.tick();
 assert.equal(calls,0);assert.equal(resumed.state.lastFailureCode,'interrupted');assert.equal(resumed.state.lastSuccessAt,undefined);
 time+=minute;await resumed.tick();assert.equal(calls,1);
});

test('并发检查不重复执行，健康区分未备份、过期、停止和缺失文件',async()=>{
 const root=fixture();configure(root);let time=origin,calls=0,finish;
 const scheduler=new BackupScheduler({root,clock:()=>time,run:()=>{calls++;return new Promise(resolveRun=>{finish=resolveRun;});}});await scheduler.tick();
 assert.equal(backupHealth(root,time).backup,'not_run');time+=5*minute;
 const active=scheduler.tick();await scheduler.tick();assert.equal(calls,1);assert.equal(scheduler.state.status,'running');finish(fakeBackup(root));await active;
 assert.equal(backupHealth(root,time).backup,'healthy');assert.equal(backupHealth(root,time+90_000).scheduler,'stale');assert.equal(backupHealth(root,time+7*minute).backup,'delayed');
 scheduler.state={...scheduler.state,status:'stopped'};scheduler.save();assert.equal(backupHealth(root,time).scheduler,'stopped');
 scheduler.state={...scheduler.state,status:'waiting',backupFile:resolve(root,'backups/database/missing.dump')};scheduler.save();assert.equal(backupHealth(root,time).backup,'missing');
});

test('无效配置不执行，配置修正后自动恢复；运行锁拒绝重复启动',async()=>{
 const root=fixture();configure(root,{intervalMinutes:0});let calls=0;
 const scheduler=new BackupScheduler({root,clock:()=>origin,run:async()=>{calls++;return fakeBackup(root);}});
 assert.equal((await scheduler.tick()).status,'configuration_error');assert.equal(calls,0);configure(root);assert.equal((await scheduler.tick()).status,'waiting');assert.equal(scheduler.state.error,undefined);
 const release=acquireBackupLock(root);assert.throws(()=>acquireBackupLock(root));release();const releaseAgain=acquireBackupLock(root);releaseAgain();
});

test('备份脚本只接受非空且目录可读结果，失败不留假成品、不覆盖已有备份',()=>{
 for(const mode of ['success','failure','empty','invalid']){
  const root=fixture(),bin=installDockerStub(root),previous=resolve(root,'backups/database/radar-existing.dump');mkdirSync(dirname(previous),{recursive:true});writeFileSync(previous,'existing backup');
  const result=spawnSync('bash',[resolve(root,'scripts/backup-database.sh')],{cwd:root,env:{...process.env,PATH:bin+':'+process.env.PATH,BACKUP_STUB_MODE:mode},encoding:'utf8'});
  assert.equal(result.status,mode==='success'?0:1);assert.doesNotMatch(result.stdout+result.stderr,/fixture-secret/);assert.equal(readFileSync(previous,'utf8'),'existing backup');
  const files=readdirSync(dirname(previous)),newFiles=files.filter(file=>file!=='radar-existing.dump');
  if(mode==='success'){assert.equal(newFiles.length,1);assert.match(newFiles[0],/^radar-.*\.dump$/);assert.equal(statSync(resolve(dirname(previous),newFiles[0])).mode&0o777,0o600);assert.match(result.stdout,/BACKUP_FILE=/);}
  else{assert.equal(newFiles.length,1);assert.match(newFiles[0],/\.partial$/);assert.doesNotMatch(result.stdout,/BACKUP_FILE=/);}
 }
});

test('运行包装器验证成品，超时与退出信号终止子任务且记录安全错误',async()=>{
 const priorPath=process.env.PATH,priorMode=process.env.BACKUP_STUB_MODE;
 try{
  const root=fixture(),bin=installDockerStub(root);process.env.PATH=bin+':'+priorPath;process.env.BACKUP_STUB_MODE='success';
  const succeeded=await runDatabaseBackup(root,1);assert.equal(succeeded.ok,true);assert.ok(existsSync(succeeded.file));
  process.env.BACKUP_STUB_MODE='slow';assert.deepEqual(await runDatabaseBackup(root,0.001),{ok:false,code:'timeout'});
  const controller=new AbortController(),operation=runDatabaseBackup(root,1,controller.signal);setTimeout(()=>controller.abort(),60);assert.deepEqual(await operation,{ok:false,code:'interrupted'});
 }finally{if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath;if(priorMode===undefined)delete process.env.BACKUP_STUB_MODE;else process.env.BACKUP_STUB_MODE=priorMode;}
});

test('CLI --run-now --once 在已启用配置下立即执行并记录真实完成时间',()=>{
 const root=fixture(),bin=installDockerStub(root);configure(root,{intervalMinutes:1440});
 copyFileSync(resolve(project,'scripts/backup-scheduler.mjs'),resolve(root,'scripts/backup-scheduler.mjs'));
 const before=Date.now(),result=spawnSync(process.execPath,[resolve(root,'scripts/backup-scheduler.mjs'),'--run-now','--once'],{cwd:root,env:{...process.env,PATH:bin+':'+process.env.PATH,BACKUP_STUB_MODE:'success'},encoding:'utf8'});
 assert.equal(result.status,0);const state=JSON.parse(readFileSync(resolve(root,'outputs/implementation-qa/backup-status.json'),'utf8'));
 assert.equal(state.status,'stopped');assert.ok(Date.parse(state.lastSuccessAt)>=before&&Date.parse(state.lastSuccessAt)<=Date.now());assert.ok(existsSync(state.backupFile));
 assert.equal(Date.parse(state.nextRunAt)-Date.parse(state.lastSuccessAt),1440*minute);assert.match(result.stdout,/立即备份完成/);
 assert.equal(readdirSync(resolve(root,'backups/database')).filter(file=>file.endsWith('.dump')).length,1);
});

test('CLI --run-now --once 不能覆盖人工关闭，既不执行也不伪造成功时间',()=>{
 const root=fixture(),bin=installDockerStub(root);configure(root,{enabled:false});
 copyFileSync(resolve(project,'scripts/backup-scheduler.mjs'),resolve(root,'scripts/backup-scheduler.mjs'));
 const result=spawnSync(process.execPath,[resolve(root,'scripts/backup-scheduler.mjs'),'--run-now','--once'],{cwd:root,env:{...process.env,PATH:bin+':'+process.env.PATH,BACKUP_STUB_MODE:'success'},encoding:'utf8'});
 assert.equal(result.status,1);const state=JSON.parse(readFileSync(resolve(root,'outputs/implementation-qa/backup-status.json'),'utf8'));
 assert.equal(state.enabled,false);assert.equal(state.lastSuccessAt,undefined);assert.equal(state.lastAttemptAt,undefined);assert.equal(existsSync(resolve(root,'backups/database')),false);assert.match(result.stderr,/未执行立即备份/);
 assert.equal(JSON.parse(readFileSync(resolve(root,'scripts/backup-config.json'),'utf8')).enabled,false);
});

test('现有监督托管备份进程并在退出后重启，仅运行隔离假网站和假任务',async()=>{
 const root=fixture();
 copyFileSync(resolve(project,'scripts/local-runtime.mjs'),resolve(root,'scripts/local-runtime.mjs'));
 copyFileSync(resolve(project,'scripts/backup-scheduler.mjs'),resolve(root,'scripts/backup-scheduler.mjs'));
 const app=resolve(root,'node_modules/next/dist/bin/next');mkdirSync(dirname(app),{recursive:true});writeFileSync(app,'setInterval(()=>{},1000);');
 writeFileSync(resolve(root,'scripts/worker.ts'),'setInterval(()=>{},1000);');
 const supervisor=spawn(process.execPath,[resolve(root,'scripts/local-runtime.mjs')],{cwd:root,stdio:'ignore'});
 const stopped=new Promise(resolveExit=>supervisor.on('exit',resolveExit));
 const wait=async predicate=>{for(let attempt=0;attempt<250;attempt++){if(predicate())return;await new Promise(resolveWait=>setTimeout(resolveWait,25));}assert.fail('隔离监督进程未在时限内完成预期行为');};
 const processFile=resolve(root,'outputs/implementation-qa/backup-process.json'),stateFile=resolve(root,'outputs/implementation-qa/backup-status.json');
 const read=path=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return undefined;}};
 try{
  await wait(()=>read(stateFile)?.status==='disabled'&&read(processFile)?.pid);
  const first=read(processFile).pid;assert.equal(read(processFile).supervisorPid,supervisor.pid);
  process.kill(first,'SIGTERM');await wait(()=>read(processFile)?.pid!==first&&read(stateFile)?.status==='disabled');
  assert.notEqual(read(processFile).pid,first);assert.equal(read(stateFile).lastSuccessAt,undefined,'没有创建或执行真实备份');
 }finally{supervisor.kill('SIGTERM');await stopped;}
 assert.equal(read(resolve(root,'outputs/implementation-qa/local-runtime-process.json')).status,'stopped');
});
