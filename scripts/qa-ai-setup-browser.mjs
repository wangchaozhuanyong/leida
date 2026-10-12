// Isolated browser QA. No real provider key, collector, worker, or WeChat request.
import 'dotenv/config';
import pg from 'pg';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {openSync,closeSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..'),output=resolve(root,'outputs/implementation-qa');
const origin='http://127.0.0.1:5191';
try{await fetch(origin+'/api/setup',{signal:AbortSignal.timeout(1000)});throw new Error('验收端口已占用');}catch(error){if(error.message==='验收端口已占用')throw error;}
const url=new URL(process.env.DATABASE_URL);
if(url.hostname!=='127.0.0.1'||url.port!=='55489'||url.pathname!=='/radar')throw new Error('只允许本项目本机配置创建独立验收库');
const database=`radar_qa_ai_setup_${Date.now()}_${randomBytes(3).toString('hex')}`;
const admin=new pg.Pool({connectionString:url.href});await admin.query(`CREATE DATABASE "${database}"`);await admin.end();url.pathname='/'+database;
const env={...process.env,DATABASE_URL:url.href,DOTENV_CONFIG_PATH:'/dev/null',DOTENV_CONFIG_OVERRIDE:undefined,BETTER_AUTH_URL:origin,NODE_ENV:'production'};
const qa=new pg.Pool({connectionString:url.href});
if((await qa.query('SELECT current_database() AS name')).rows[0]?.name!==database)throw new Error('独立验收库校验失败');
writeFileSync(resolve(output,`ai-setup-${database}.json`),JSON.stringify({database,root,retained:true,scope:'Isolated fixtures only; credentials never written to report'},null,2),{flag:'wx',mode:0o600});
for(const script of ['scripts/migrate.ts','scripts/auth-migrate.ts','scripts/migrations/wechat.ts','scripts/migrations/forecast.ts']){
  const result=spawnSync(process.execPath,['--import','tsx',script,...(script.includes('/migrations/')?['--apply']:[])],{cwd:root,env,stdio:'pipe'});
  if(result.status!==0)throw new Error('隔离验收初始化失败：'+script);
}
const log=openSync(resolve(output,'ai-setup-browser-server-20261010.log'),'a',0o600);
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','5191'],{cwd:root,env,stdio:['ignore',log,log]});closeSync(log);
const require=createRequire(import.meta.url),{chromium}=require(resolve(process.argv[2],'playwright'));
let browser;const results=[];
const empty={id:'ai',enabled:false,baseUrl:'',model:'',hasKey:false,dailyCallLimit:0,dailyBudget:0,inputPrice:0,outputPrice:0,currency:'CNY',version:1};
async function savedAI(){return (await qa.query("SELECT payload FROM radar_settings WHERE id='ai'")).rows[0]?.payload;}
async function setAI(value){await qa.query("INSERT INTO radar_settings(id,payload) VALUES ('ai',$1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",[value]);}
try{
  let ready=false;for(let i=0;i<60;i++){if(server.exitCode!==null)throw new Error('隔离服务未启动');try{if((await fetch(origin+'/api/setup')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}if(!ready)throw new Error('隔离服务未就绪');
  browser=await chromium.launch({headless:true});
  const auth=await browser.newContext();
  // Fresh, disposable QA account. The generated password stays in memory.
  const password=randomBytes(24).toString('base64url'),email='setup-browser@example.invalid';
  if((await auth.request.post(origin+'/api/setup',{headers:{Origin:origin},data:{email,password,name:'隔离验收站长'}})).status()!==200)throw new Error('隔离账号初始化失败');
  if((await auth.request.post(origin+'/api/auth/sign-in/email',{headers:{Origin:origin},data:{email,password}})).status()!==200)throw new Error('隔离账号登录失败');
  const storageState=await auth.storageState();await auth.close();
  for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
    await setAI({...empty,version:viewport.width});
    const context=await browser.newContext({viewport,storageState}),page=await context.newPage();
    const errors=[];page.on('pageerror',()=>errors.push('页面脚本错误'));
    await page.goto(origin+'/admin/settings/ai');await page.getByRole('button',{name:'填入推荐配置',exact:true}).waitFor();
    await page.getByRole('button',{name:'填入推荐配置',exact:true}).click();
    const checks={prefilled:(await page.getByLabel('接口地址').inputValue())==='https://dashscope.aliyuncs.com/compatible-mode/v1',disabledUntilTest:await page.getByLabel('启用自动智能处理').isDisabled()};
    await page.getByRole('button',{name:'刷新数据',exact:true}).click();
    checks.refreshPreservesEdit=await page.getByText('配置尚未保存，请先保存后再刷新。',{exact:true}).isVisible()&&(await page.getByLabel('模型名称').inputValue())==='qwen3.7-flash-2026-07-15';
    await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByText('操作已完成，数据已更新。',{exact:true}).waitFor();
    const saved=await savedAI();checks.savedWithoutCalls=!saved.enabled&&!saved.encryptedKey&&saved.dailyCallLimit===100&&saved.dailyBudget===1;
    checks.missingKeyCannotTest=await page.getByRole('button',{name:'测试已保存配置',exact:true}).isDisabled();
    // This fixture simulates an already tested connection only to exercise the UI and save gate.
    // It is not a valid provider credential and never leaves this isolated database.
    await setAI({...saved,encryptedKey:'synthetic-not-a-provider-credential',hasKey:true,testedAt:new Date().toISOString(),version:saved.version+1});
    await page.getByRole('button',{name:'刷新数据',exact:true}).click();await page.getByText('待启用',{exact:true}).waitFor();
    checks.connectionSuccessIsNotEnabled=!(await page.getByLabel('启用自动智能处理').isChecked());
    await page.getByLabel('启用自动智能处理').check();await page.getByRole('button',{name:'保存配置',exact:true}).click();
    await page.getByText('已启用',{exact:true}).waitFor();checks.enableSave=(await savedAI()).enabled===true;
    await page.getByLabel('模型名称').fill('changed-model-for-qa');
    checks.changedModelDisables=!(await page.getByLabel('启用自动智能处理').isChecked())&&await page.getByLabel('启用自动智能处理').isDisabled();
    await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByText('待测试连接',{exact:true}).waitFor();
    checks.changedModelRequiresRetest=!(await savedAI()).enabled&&!(await savedAI()).testedAt;
    // A concurrent server version cannot silently replace local unsaved form input.
    await page.getByLabel('模型名称').fill('unsaved-edit-for-qa');
    const concurrent=await savedAI();await setAI({...concurrent,model:'external-qa-update',version:concurrent.version+1});
    await page.getByRole('button',{name:'刷新数据',exact:true}).click();
    checks.concurrentRefreshPreservesEdit=(await page.getByLabel('模型名称').inputValue())==='unsaved-edit-for-qa';
    await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByText('这条内容已被更新。你的编辑已保留，请另开详情核对最新版本后再修改。',{exact:true}).waitFor();
    checks.conflictPreservesEdit=(await page.getByLabel('模型名称').inputValue())==='unsaved-edit-for-qa';
    checks.noOverflow=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
    checks.noScriptErrors=errors.length===0;
    await page.screenshot({path:resolve(output,`ai-setup-${viewport.width}-20261010.png`),fullPage:true});
    results.push({viewport,checks});await context.close();
  }
  const calls=(await qa.query('SELECT count(*)::int AS count FROM radar_ai_usage')).rows[0].count;
  const pass=results.every(result=>Object.values(result.checks).every(Boolean))&&calls===0;
  writeFileSync(resolve(output,'ai-setup-browser-qa-20261010.json'),JSON.stringify({pass,database,root,results,actualModelCalls:calls,actualWechatCalls:0,connectionTest:'SIMULATED_STATE_ONLY',scope:'Isolated auth, real configuration save and browser flow; no real AI connection test'},null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({pass,viewports:results.length,checks:results.reduce((sum,result)=>sum+Object.keys(result.checks).length,0),actualModelCalls:calls}));if(!pass)process.exitCode=1;
}finally{if(browser)await browser.close();server.kill('SIGTERM');await qa.end();}
