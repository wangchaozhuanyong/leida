import 'dotenv/config';
import pg from 'pg';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {openSync,closeSync,writeFileSync,mkdirSync} from 'node:fs';
const database=`radar_qa_${Date.now()}_${randomBytes(3).toString('hex')}`;
const url=new URL(process.env.DATABASE_URL!);if(url.hostname!=='127.0.0.1'||url.port!=='55489')throw new Error('集成测试只允许本项目本机数据库');
const admin=new pg.Pool({connectionString:url.href});await admin.query(`CREATE DATABASE "${database}"`);await admin.end();url.pathname='/'+database;
const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:url.href,BETTER_AUTH_URL:'http://127.0.0.1:5191',RADAR_INTEGRATION:'1',RADAR_TEST_URL:'http://127.0.0.1:5191',NODE_ENV:'production'};
mkdirSync('outputs/implementation-qa',{recursive:true});
for(const s of ['scripts/migrate.ts','scripts/auth-migrate.ts','scripts/migrations/wechat.ts','scripts/seed.ts']){const r=spawnSync('pnpm',['exec','tsx',s,...(s.endsWith('/wechat.ts')?['--apply']:[])],{env,stdio:'pipe'});if(r.status!==0){process.stderr.write(`测试库初始化失败：${s}\n${r.stderr}`);process.exit(1)}}
const log=openSync('outputs/implementation-qa/integration-server.log','a');
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','5191'],{env,stdio:['ignore',log,log]});
let code=1;
try{let ready=false;for(let i=0;i<60;i++){try{const r=await fetch(env.RADAR_TEST_URL+'/api/setup');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,500));}if(!ready)throw new Error('测试服务未启动');let results='';code=0;for(const testFile of ['tests/integration.test.ts','tests/recovery.test.ts','tests/automation.test.ts','tests/daily-publication.test.ts','tests/admin-audit.test.ts','tests/wechat-api.test.ts','tests/wechat-integration.test.ts']){const r=spawnSync('pnpm',['exec','tsx','--test','--test-concurrency=1',testFile],{env,encoding:'utf8'});results+=(r.stdout||'')+(r.stderr||'');process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.status!==0){code=r.status??1;break;}}writeFileSync('outputs/implementation-qa/integration-results.txt',results);}finally{server.kill('SIGTERM');closeSync(log);writeFileSync('outputs/implementation-qa/test-database.json',JSON.stringify({database,retained:true,contains:'isolated generated QA fixtures only'},null,2));}process.exit(code);
