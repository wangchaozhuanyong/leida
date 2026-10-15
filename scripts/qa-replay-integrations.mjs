import {config} from 'dotenv';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import pg from 'pg';
const root=fileURLToPath(new URL('../',import.meta.url)),output=root+'outputs/month-replay-20261016/';
config({path:fileURLToPath(new URL('../../../.env',import.meta.url)),quiet:true});
const target=new URL(process.env.DATABASE_URL);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55489');
const results=[];
for(const file of ['forecast-integration','tibo-public-integration','tibo-evidence-integration','source-request-integration']){
 const prefix=file==='forecast-integration'?'radar_qa_forecast_':file==='tibo-evidence-integration'?'radar_tibo_qa_':'radar_tibo_public_qa_';
 const database=prefix+Date.now();
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});try{await admin.query(`CREATE DATABASE "${database}"`);}finally{await admin.end();}
 target.pathname='/'+database;
 const env={...process.env,DATABASE_URL:target.href,RADAR_INTEGRATION:'1',DOTENV_CONFIG_PATH:'/dev/null'};
 for(const script of ['scripts/migrate.ts','scripts/migrations/wechat.ts']){const init=spawnSync('pnpm',['exec','tsx',script,...(script.includes('/migrations/')?['--apply']:[])],{cwd:root,env,encoding:'utf8',timeout:30000});assert.equal(init.status,0,'隔离数据库初始化失败');}
 const result=spawnSync('pnpm',['exec','tsx','--test','--test-concurrency=1',`tests/${file}.test.ts`],{cwd:root,env,encoding:'utf8',maxBuffer:4*1024*1024,timeout:60000});
 writeFileSync(output+file+'-verified.log',(result.stdout??'')+(result.stderr??''));results.push({file,database,exitCode:result.status});
 if(result.status!==0)process.exitCode=1;
 console.log(JSON.stringify(results.at(-1)));
}
writeFileSync(output+'additional-integrations-verified.json',JSON.stringify({at:new Date().toISOString(),results,productionMutations:false},null,2)+'\n');console.log(JSON.stringify(results));
