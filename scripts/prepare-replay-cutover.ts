import {config} from 'dotenv';
import pg from 'pg';
import {readFile,writeFile,mkdir,open,chmod} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import type {Evidence,Article,Publication,RadarEvent,Candidate,Activity} from '../src/lib/types';
import type {ReplayRun,ReplayStep} from '../src/lib/historical-replay';

const root=fileURLToPath(new URL('../',import.meta.url)),output=root+'outputs/month-replay-20261016/';
type Package={run:ReplayRun;steps:ReplayStep[];records:{evidence:Evidence[];articles:Article[];events:RadarEvent[];publications:Publication[];candidates:Candidate[];activities:Activity[]}};
const packages=await Promise.all(['replay-package.json','run-02/replay-package.json'].map(file=>readFile(output+file,'utf8').then(text=>JSON.parse(text) as Package)));
assert.ok(packages.every(p=>p.run.status==='complete'));
const selected=packages.at(-1)!,importedAt=new Date().toISOString(),start=Date.parse(selected.run.window.start);
const normalizeArticle=(article:Article):Article=>({...article,historical:true,sourcePublishedAt:article.sourcePublishedAt??article.publishedAt,publishedAt:importedAt,updatedAt:importedAt});
const publications=selected.records.publications.filter(p=>Date.parse(p.publishedAt)>=start).map(p=>({...p,article:normalizeArticle(p.article),event:{...p.event,updatedAt:importedAt},publishedAt:importedAt,cutoffAt:importedAt,reason:'真实历史消息补录；预测过程见独立历史回放，不代表当时本站已经发布'}));
const articleIds=new Set(publications.map(p=>p.articleId)),eventIds=new Set(publications.map(p=>p.eventId));
const articles=selected.records.articles.filter(a=>articleIds.has(a.id)).map(normalizeArticle);
const events=selected.records.events.filter(e=>eventIds.has(e.id)).map(e=>({...e,updatedAt:importedAt}));
const records={
 evidence:selected.records.evidence.map(e=>({...e,collectedAt:importedAt,historical:true})),
 candidates:selected.records.candidates.filter(c=>Date.parse(c.createdAt)>=start).map(c=>({...c,createdAt:importedAt,updatedAt:importedAt})),
 articles,events,publications,
 activities:selected.records.activities.map(activity=>({...activity,items:activity.items.filter(item=>articleIds.has(item.articleId))}))
};
const retainedIds=new Set(records.evidence.map(e=>e.id));
for(const p of publications){assert.ok(articleIds.has(p.articleId)&&eventIds.has(p.eventId));assert.ok(p.article.evidenceIds.every(id=>retainedIds.has(id)));}
const plan={preparedAt:importedAt,status:'ready_for_review_not_applied',window:selected.run.window,counts:Object.fromEntries(Object.entries(records).map(([table,rows])=>[table,rows.length])),replayRuns:packages.map(p=>({runId:p.run.runId,steps:p.steps.length})),replaceTables:['evidence','candidates','events','articles','publications','notices','forecast_cases','forecast_snapshots','forecast_outcomes','jobs'],preserve:['administrator_accounts_and_sessions','system_settings_and_encrypted_keys','source_settings_and_live_cursors','wechat_readers_grants_and_deliveries','audit_history','all_backups'],requirements:['先停止采集任务并取得最新一致备份及恢复核对。','核对截止后新增真实消息，合并增量后再生成最终导入包。','清空、导入和重启须在用户确认具体范围后执行。','历史导入不建立读者通知或微信发送任务。'],productionMutations:false};
Object.assign(plan,{updateTables:{activities:'保留活动定义与配置，仅将条目关联更新为导入后仍存在的文章和事件；未导入的旧内容关联移除。'},productionBackupVerified:false,liveDeltaMerged:false});
await writeFile(output+'cutover-package.json',JSON.stringify({plan,records,runs:packages.map(p=>p.run),steps:packages.flatMap(p=>p.steps)},null,2)+'\n');
await writeFile(output+'cutover-plan.json',JSON.stringify(plan,null,2)+'\n');
console.log(JSON.stringify(plan));
if(!process.argv.includes('--verify-local'))process.exit(0);

config({path:fileURLToPath(new URL('../../../.env',import.meta.url)),quiet:true});
const url=new URL(process.env.DATABASE_URL??'');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55489');assert.equal(url.pathname,'/radar');
const database='radar_qa_replay_import_'+Date.now();
const admin=new pg.Pool({connectionString:url.href});try{await admin.query(`CREATE DATABASE "${database}"`);}finally{await admin.end();}
url.pathname='/'+database;process.env.DATABASE_URL=url.href;
for(const file of ['scripts/migrate.ts','scripts/auth-migrate.ts','scripts/migrations/forecast.ts','scripts/migrations/wechat.ts'])execFileSync('pnpm',['exec','tsx',file,...(file.includes('/migrations/')?['--apply']:[])],{cwd:root,env:process.env,stdio:'pipe'});
const {pool,insert,put,transaction}=await import('../src/db');
const {sourceDefinitions}=await import('../src/server/ingestion');
const {defaultSite}=await import('../src/server/service');
try{
 await transaction(async client=>{
  for(const table of ['evidence','candidates','events','articles','publications','activities'] as const)for(const row of records[table])await insert(table,row,client);
  for(const p of packages){await put('settings',p.run,client);for(const step of p.steps)await insert('forecast_snapshots',step,client);}
  await put('settings',{id:'site',...defaultSite,name:defaultSite.name+' · 历史导入验收'},client);
  await put('settings',{id:'ai',enabled:false,version:1},client);
  for(const source of sourceDefinitions)await put('sources',{...source,enabled:source.kind!=='manual',validated:true,status:source.kind==='manual'?'paused':'healthy',lastSuccessAt:importedAt,nextRunAt:'2100-01-01T00:00:00Z'},client);
 });
 const {runForecastCycle}=await import('../src/server/forecast');assert.equal((await runForecastCycle(new Date().toISOString(),{force:true})).status,'ready');
 const log=await open(output+'preview-server.log','a');
 const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:url.href,BETTER_AUTH_URL:'http://127.0.0.1:5196',NODE_ENV:'production'};
 const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','5196'],{cwd:root,env,detached:true,stdio:['ignore',log.fd,log.fd]});server.unref();await log.close();
 await writeFile(output+'preview-runtime.json',JSON.stringify({database,pid:server.pid,baseUrl:'http://127.0.0.1:5196',production:false},null,2)+'\n');
 let ready=false;for(let attempt=0;attempt<50;attempt++){try{if((await fetch('http://127.0.0.1:5196/api/v1/replays')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,400));}assert.ok(ready,'隔离预览服务没有启动');
 const require=createRequire(import.meta.url),{validateBootstrap}=require('../miniprogram/utils/transport.js'),{validateReplay}=require('../miniprogram/utils/replay.js');
 const checks:{name:string;passed:true}[]=[];
 const read=async(path:string)=>{const r=await fetch('http://127.0.0.1:5196'+path);assert.equal(r.status,200,path);return r.json();};
 assert.equal((await read('/api/v1/replays')).data.length,2);checks.push({name:'两次历史批次完整保留',passed:true});
 for(const p of packages)for(const index of [0,Math.floor(p.steps.length/2),p.steps.length-1]){
  const path=`/api/v1/replays/${p.run.runId}?step=${index}`,body=await read(path);assert.ok(validateReplay(path,body.data));
  if(index<p.steps.length-1)assert.equal(body.data.run.scores,undefined);
 }
 checks.push({name:'实际HTTP回放记录通过小程序合同，旧步骤不返回未来成绩',passed:true});
 const bundle=await read('/api/v1/bootstrap');assert.ok(validateBootstrap(bundle.data));
 assert.ok(bundle.data.articles.every((a:Article)=>a.historical));checks.push({name:'导入后的网页和小程序共享资料可读且保留历史标识',passed:true});
 for(const view of ['home','history','news','calendar','state','notices','methodology'])await read('/api/v1/bootstrap?view='+view);
 checks.push({name:'首页动态记录日程提醒及观察接口全部可读',passed:true});
 if(publications.length){await read('/api/v1/bootstrap?view=detail&entity=publications&id='+encodeURIComponent(publications.at(-1)!.id));const poster=await fetch('http://127.0.0.1:5196/api/v1/posters/'+publications.at(-1)!.id);assert.equal(poster.status,200);assert.ok((await poster.text()).includes('<svg'));}
 assert.equal((await fetch('http://127.0.0.1:5196/api/admin/data')).status,401);
 checks.push({name:'固定详情海报可读，管理接口继续要求登录',passed:true});
 await writeFile(output+'local-import-verification.json',JSON.stringify({at:new Date().toISOString(),database,checks,productionMutations:false,realWechatDelivery:false},null,2)+'\n');
 const backup=root+'backups/month-replay-20261016/';await mkdir(backup,{recursive:true});
 const restoreChecks:{runId:string;database:string;tables:number;matched:boolean}[]=[];
 for(const [index,folder] of ['', 'run-02/'].entries()){
  const local=JSON.parse(await readFile(output+folder+'local-database.json','utf8')) as {database:string;runId:string};assert.match(local.database,/^radar_replay_\d+$/);
  const path=backup+local.runId+'.dump';
  await writeFile(path,execFileSync('docker',['exec','moyao-reset-radar-db','pg_dump','-U','radar','-d',local.database,'-Fc'],{maxBuffer:128*1024*1024}),{mode:0o600});await chmod(path,0o600);
  const list=execFileSync('docker',['exec','-i','moyao-reset-radar-db','pg_restore','--list'],{input:await readFile(path),maxBuffer:4*1024*1024}).toString();assert.ok(list.includes('radar_forecast_snapshots'));
  const restored=`radar_qa_replay_restore_${Date.now()}_${index}`;
  await pool.query(`CREATE DATABASE "${restored}"`);
  execFileSync('docker',['exec','-i','moyao-reset-radar-db','pg_restore','-U','radar','-d',restored,'--no-owner'],{input:await readFile(path),maxBuffer:4*1024*1024});
  const fromURL=new URL(url),toURL=new URL(url);fromURL.pathname='/'+local.database;toURL.pathname='/'+restored;
  const from=new pg.Pool({connectionString:fromURL.href}),to=new pg.Pool({connectionString:toURL.href});
  const tables=['evidence','candidates','events','articles','publications','activities','settings','forecast_cases','forecast_snapshots','forecast_outcomes'];
  try{for(const table of tables){const sql=`SELECT count(*)::int AS count,md5(coalesce(string_agg(id || payload::text,',' ORDER BY id),'')) AS digest FROM radar_${table}`;assert.deepEqual((await from.query(sql)).rows,(await to.query(sql)).rows);}}finally{await from.end();await to.end();}
  restoreChecks.push({runId:local.runId,database:restored,tables:tables.length,matched:true});
 }
 await writeFile(output+'backup-restore-verification.json',JSON.stringify({at:new Date().toISOString(),restoreChecks,productionMutations:false},null,2)+'\n');
 console.log(JSON.stringify({status:'local_import_verified',database,checks,restoreChecks}));
}finally{await pool.end();}
