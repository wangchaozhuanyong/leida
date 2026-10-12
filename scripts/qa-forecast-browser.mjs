import {createRequire} from 'node:module';
import 'dotenv/config';
import {readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),output=resolve(root,'outputs/implementation-qa');
const report=JSON.parse(readFileSync(resolve(output,'forecast-http-qa-20261010-final.json'),'utf8'));
if(report.root!==root||!report.database.startsWith('radar_qa_forecast_http_')||report.origin!=='http://127.0.0.1:5191')throw new Error('必须验收独立模拟服务');
const require=createRequire(import.meta.url),{chromium}=require(resolve(process.argv[2],'playwright'));
const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='127.0.0.1'||url.port!=='55489')throw new Error('只允许本项目本机验收数据库');url.pathname='/'+report.database;
const log=openSync(resolve(output,'forecast-browser-server-20261010.log'),'a',0o600);
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','5191'],{cwd:root,env:{...process.env,DATABASE_URL:url.href,DOTENV_CONFIG_PATH:'/dev/null',DOTENV_CONFIG_OVERRIDE:undefined,NODE_ENV:'production',BETTER_AUTH_URL:report.origin},stdio:['ignore',log,log]});closeSync(log);
const browser=await chromium.launch({headless:true}),results=[];
try {
 let ready=false;for(let i=0;i<40;i++){try{if((await fetch(report.origin+'/api/v1/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}if(!ready)throw new Error('隔离浏览器服务未启动');
 if(process.argv.includes('--save-only')){
  for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
   const page=await browser.newPage({viewport,acceptDownloads:true});await page.goto(`${report.origin}/methodology?snapshot=${report.usageSnapshotId}`);
   await page.getByRole('button',{name:'生成实验海报',exact:true}).click();await page.locator('dialog img').waitFor({timeout:20000});
   const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'保存海报',exact:true}).click()]);
   const filename=resolve(output,`forecast-download-${viewport.width}-20261010.png`);await download.saveAs(filename);const bytes=readFileSync(filename);
   results.push({viewport,downloadError:await download.failure(),pngSignature:bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),bytes:bytes.length,filename});await page.close();
  }
  const pass=results.every(r=>!r.downloadError&&r.pngSignature&&r.bytes>1000);writeFileSync(resolve(output,'forecast-download-qa-20261010.json'),JSON.stringify({pass,results},null,2),{flag:'wx'});console.log(JSON.stringify({pass,savedImages:results.length}));if(!pass)process.exitCode=1;
 }else{
 for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
  const page=await browser.newPage({viewport,deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(report.origin);await page.getByText('实验预测 · 用量重置公告',{exact:true}).waitFor();
  const home={probability24:await page.getByText(/24小时30% · 48小时80%/).isVisible(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)};
  await page.screenshot({path:resolve(output,`forecast-home-${viewport.width}-20261010.png`),fullPage:true});
  await page.getByRole('link',{name:/实验预测 · 用量重置公告/}).click();
  await page.getByRole('heading',{name:'固定预测记录',exact:true}).waitFor();await page.getByRole('heading',{name:'用量重置实验快照',exact:true}).waitFor();
  const fixed={sameId:new URL(page.url()).searchParams.get('snapshot')===report.usageSnapshotId,hasOutcome:await page.getByRole('heading',{name:'后续结局',exact:true}).isVisible(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)};
  await page.screenshot({path:resolve(output,`forecast-fixed-${viewport.width}-20261010.png`),fullPage:true});
  await page.getByRole('button',{name:'生成实验海报',exact:true}).click();
  await page.getByRole('button',{name:'保存海报',exact:true}).waitFor({state:'visible',timeout:20000});await page.locator('dialog img').waitFor({timeout:20000});
  const poster=await page.locator('dialog').evaluate(dialog=>({width:dialog.getBoundingClientRect().width,overflow:dialog.scrollWidth>dialog.clientWidth,image:!!dialog.querySelector('img')?.complete}));
  await page.screenshot({path:resolve(output,`forecast-poster-${viewport.width}-20261010.png`)});
  await page.getByRole('button',{name:'关闭海报',exact:true}).click();
  await page.goto(`${report.origin}/methodology?snapshot=missing-fixed-snapshot`);
  await page.getByRole('heading',{name:'预测快照暂时不可用',exact:true}).waitFor();
  await page.getByRole('button',{name:'重新读取',exact:true}).click();await page.getByRole('heading',{name:'预测快照暂时不可用',exact:true}).waitFor();
  const missing={noFallback:await page.getByRole('heading',{name:'用量重置实验快照',exact:true}).count()===0,retryVisible:await page.getByRole('button',{name:'重新读取',exact:true}).isVisible()};
  results.push({viewport,home,fixed,poster,missing,errors});await page.close();
 }
 const pass=results.every(r=>r.home.probability24&&!r.home.overflow&&r.fixed.sameId&&r.fixed.hasOutcome&&!r.fixed.overflow&&r.poster.image&&!r.poster.overflow&&r.missing.noFallback&&r.missing.retryVisible&&!r.errors.length);
 writeFileSync(resolve(output,'forecast-browser-qa-20261010.json'),JSON.stringify({pass,scope:'Synthetic isolated browser QA; native WeChat not exercised',results},null,2),{flag:'wx'});console.log(JSON.stringify({pass,viewports:results.length}));if(!pass)process.exitCode=1;
 }
}finally{await browser.close();server.kill('SIGTERM');}
