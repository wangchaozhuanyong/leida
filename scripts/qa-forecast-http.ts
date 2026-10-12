// All generated records belong to a guarded, retained local QA database.
import 'dotenv/config';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..'),output=resolve(root,'outputs/implementation-qa');
const reportName=process.env.RADAR_FORECAST_HTTP_REPORT??'forecast-http-qa-20261010.json';
if(!/^forecast-http-qa-[\w-]+\.json$/.test(reportName))throw new Error('验收输出名称无效');
const source=new URL(process.env.DATABASE_URL!);
if(source.hostname!=='127.0.0.1'||source.port!=='55489'||source.pathname!=='/radar')throw new Error('只允许从本项目本机业务库配置创建独立验收库');
const database=`radar_qa_forecast_http_${Date.now()}_${randomBytes(3).toString('hex')}`;
const admin=new pg.Pool({connectionString:source.href});await admin.query(`CREATE DATABASE "${database}"`);await admin.end();source.pathname=`/${database}`;
const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:source.href,DOTENV_CONFIG_PATH:'/dev/null',DOTENV_CONFIG_OVERRIDE:undefined,BETTER_AUTH_URL:'http://127.0.0.1:5191',NODE_ENV:'production'};
const guard=new pg.Pool({connectionString:source.href});if((await guard.query('SELECT current_database() AS name')).rows[0]?.name!==database)throw new Error('验收库身份校验失败');await guard.end();
mkdirSync(output,{recursive:true});
writeFileSync(resolve(output,`forecast-http-${database}.json`),JSON.stringify({database,retained:true,contains:'synthetic QA only',root,phase:'initialized'},null,2),{flag:'wx'});
for(const script of ['scripts/migrate.ts','scripts/auth-migrate.ts','scripts/migrations/wechat.ts','scripts/migrations/forecast.ts']){
 const result=spawnSync('pnpm',['exec','tsx',script,...(script.includes('/migrations/')?['--apply']:[])],{cwd:root,env,encoding:'utf8'});
 if(result.status!==0)throw new Error(`隔离初始化失败：${script}`);
}
// The child uses only generated evidence. It does not run collectors, AI, or reader sends.
const fixture=spawnSync('pnpm',['exec','tsx','-e',`
import {pool,put,insert} from './src/db';
import {runForecastCycle} from './src/server/forecast';
(async()=>{
 const database=(await pool.query('SELECT current_database() AS name')).rows[0].name;
 if(!database.startsWith('radar_qa_forecast_http_'))throw new Error('不允许在业务库写入样例');
 const now=new Date().toISOString(),signalAt=new Date(Date.now()-3600000).toISOString();
 await put('settings',{id:'site',name:'模钥重置雷达 · 隔离验收',description:'模拟资料，仅作验收',autoPublish:true,version:1});
 await put('sources',{id:'qa-status',name:'隔离模拟官方来源',kind:'status',url:'https://status.openai.com/api/v2/incidents.json',enabled:true,validated:true,status:'healthy',lastSuccessAt:now,intervalMinutes:5,version:1});
 await insert('evidence',{id:'qa-signal',sourceId:'qa-status',messageId:'qa-update',parentId:'QA123ABC456',url:'https://status.openai.com/incidents/QA123ABC456',text:'We identified an issue causing Codex usage to be consumed faster than expected.',metadata:{title:'Codex Usage',status:'identified',sourceGroup:'openai-status'},publishedAt:signalAt,collectedAt:now,hash:'qa-only',contextComplete:true,historical:false,provenance:'official',textOrigin:'structured'});
 const result=await runForecastCycle(now);if(result.status!=='ready'||result.discovered!==2||result.snapshots!==2)throw new Error('隔离观察未完整生成');await pool.end();
})().catch(()=>{process.exitCode=1;});
`],{cwd:root,env,encoding:'utf8'});
if(fixture.status!==0)throw new Error('隔离样例初始化失败，未写入业务数据');
const logPath=resolve(output,'forecast-http-server-20261010.log'),log=openSync(logPath,'a',0o600);
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','5191'],{cwd:root,env,detached:process.argv.includes('--keep-server'),stdio:['ignore',log,log]});closeSync(log);
const origin='http://127.0.0.1:5191',checks:Record<string,boolean>={};
try {
 let ready=false;for(let i=0;i<60;i++){try{if((await fetch(origin+'/api/v1/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
 if(!ready)throw new Error('独立验收服务未启动');
 const bootstrap=await (await fetch(origin+'/api/v1/bootstrap')).json();
 const forecasts=await (await fetch(origin+'/api/v1/forecasts')).json();
 checks.bootstrapShared=bootstrap.data.forecasts.status==='ready'&&forecasts.data.cases.length===2;
 const usage=forecasts.data.cases.find((c:{target:string})=>c.target==='automatic_reset'),card=forecasts.data.cases.find((c:{target:string})=>c.target==='banked_reset');
 if(!usage?.snapshot||!card?.snapshot)throw new Error('公开接口未返回隔离观察快照');
 checks.experiment=usage.snapshot.p24===.3&&usage.snapshot.p48===.8&&usage.snapshot.trainingApplied===false&&usage.snapshot.calibrated===false;
 checks.cardInsufficient=card.snapshot.p24===null&&card.snapshot.p48===null;
 const fixed=await (await fetch(origin+'/api/v1/forecasts/'+usage.snapshot.id)).json();
 checks.fixedSnapshot=JSON.stringify(fixed.data)===JSON.stringify(usage.snapshot);
 const svg=await (await fetch(origin+'/api/v1/forecast-posters/'+usage.snapshot.id)).text();
 checks.posterSameSnapshot=svg.includes(usage.snapshot.id)&&svg.includes('24小时：30%')&&svg.includes('48小时：80%')&&svg.includes('个人到账未观测');
 checks.unknownSnapshot404=(await fetch(origin+'/api/v1/forecasts/missing-fixed-snapshot')).status===404;
 checks.noWelfare=bootstrap.data.events.length===0&&bootstrap.data.articles.length===0&&bootstrap.data.notices.length===0&&bootstrap.data.publications.length===0;
 const version=await (await fetch(origin+'/api/v1/version')).json();checks.sameRevision=version.data.version===bootstrap.version;
 checks.conditional304=(await fetch(origin+'/api/v1/version',{headers:{'If-None-Match':`"${version.data.version}"`}})).status===304;
 checks.adminProtected=(await fetch(origin+'/api/admin/data')).status===401;
 for(const route of ['/','/methodology','/methodology?snapshot='+usage.snapshot.id])checks[`page:${route}`]=(await fetch(origin+route)).ok;
 const report={database,retained:true,contains:'synthetic QA only',origin,pid:server.pid,root,checks,pass:Object.values(checks).every(Boolean),usageSnapshotId:usage.snapshot.id,cardSnapshotId:card.snapshot.id,checkedAt:new Date().toISOString(),actualAI:0,actualWechat:0,actualCollector:0};
 writeFileSync(resolve(output,reportName),JSON.stringify(report,null,2),{flag:'wx'});
 console.log(JSON.stringify({pass:report.pass,checks:Object.keys(checks).length,serverRetained:process.argv.includes('--keep-server'),snapshotId:usage.snapshot.id}));
 if(!report.pass)throw new Error('有公开接口验收未通过');
 if(process.argv.includes('--keep-server'))server.unref();else server.kill('SIGTERM');
} catch(error){server.kill('SIGTERM');throw error;}
