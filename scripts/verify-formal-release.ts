import {readFile,realpath,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';

// A private, local receipt check, not a new public API or production setting.
// Receipts must come from actual deployment/platform/phone checks. Never fill
// missing phone results from a successful upload or availability response.
const version=z.string().regex(/^\d+\.\d+\.\d+$/);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const commit=z.string().regex(/^[a-f0-9]{40}$/);
const appId=z.string().regex(/^wx[a-f0-9]{16}$/);
const checkedAt=z.string().datetime();
const receipts=z.object({
  server:z.object({version,sourceDigest:digest,main:commit,checkedAt}).strict().optional(),
  wechat:z.object({appId,envVersion:z.enum(['release','trial','develop']),qrEnabled:z.boolean(),subscriptionsEnabled:z.boolean(),checkedAt}).strict().optional(),
  platform:z.object({appId,onlineVersion:version,checkedAt}).strict().optional(),
  phone:z.object({appId,version,envVersion:z.enum(['release','trial','develop']),qr:z.boolean(),share:z.boolean(),reminder:z.boolean(),customerService:z.boolean(),checkedAt}).strict().optional(),
}).strict();
export interface FormalTarget {version:string;sourceDigest:string;main:string;appId:string;}
export type FormalReceipts=z.infer<typeof receipts>;
type Check={id:string;status:'passed'|'pending'|'failed';reason:string};

export function verifyFormalRelease(target:FormalTarget,input:unknown,now=Date.now()) {
  const parsed=receipts.safeParse(input);
  const checks:Check[]=[];
  const add=(id:string,status:Check['status'],reason:string)=>checks.push({id,status,reason});
  if(!parsed.success)add('receipts','failed','回执结构不合法；只接受安全核验字段，不接受凭据或未知字段。');
  else {
    const data=parsed.data;
    const fresh=(value:{checkedAt:string})=>{
      const at=Date.parse(value.checkedAt);return Number.isFinite(now)&&at<=now&&now-at<86400000;
    };
    for(const id of ['server','wechat','platform','phone'] as const){
      const value=data[id];
      if(!value)add(id,'pending','缺少实际核验回执。');
      else if(!fresh(value))add(id,'pending','回执已过期或时间异常，需要重新核对。');
      else if(id==='server'){
        const s=data.server!;
        add(id,s.version===target.version&&s.sourceDigest===target.sourceDigest&&s.main===target.main?'passed':'failed','核对后端版本、源码指纹和部署 main 提交。');
      }else if(id==='wechat'){
        const s=data.wechat!;
        add(id,s.appId===target.appId&&s.envVersion==='release'&&s.qrEnabled&&s.subscriptionsEnabled?'passed':'failed','二维码与提醒必须使用目标 AppID 和 release 环境。');
      }else if(id==='platform'){
        const s=data.platform!;
        add(id,s.appId===target.appId&&s.onlineVersion===target.version?'passed':'failed','核对公众平台线上版本；开发版、体验版、审核通过均不替代发布。');
      }else {
        const s=data.phone!;
        if(s.appId!==target.appId||s.version!==target.version||s.envVersion!=='release')add(id,'failed','手机实际打开的 AppID、包版本或环境与目标不符。');
        else add(id,s.qr&&s.share&&s.reminder&&s.customerService?'passed':'pending','正式版扫码、转发、提醒接收并点击、客服收发须有实际验收。');
      }
    }
    // A phone receipt obtained before the current configuration/platform check
    // cannot establish acceptance of that later formal-release target.
    if(data.phone&&[data.wechat,data.platform,data.server].some(value=>value&&Date.parse(data.phone!.checkedAt)<Date.parse(value.checkedAt)))add('phone-order','pending','手机回执早于当前渠道、部署或线上版本核对，请在最终状态下重新验收。');
  }
  const status=checks.some(c=>c.status==='failed')?'failed':checks.some(c=>c.status==='pending')?'pending':'passed';
  return {checkedAt:new Date(now).toISOString(),mode:'receipt-consistency-only',target,status,checks,productionWrites:0,actualWechatCalls:0};
}

async function main(){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const [inputPath,outputPath]=process.argv.slice(2);
  if(!inputPath||!outputPath)throw new Error('用法：pnpm exec tsx scripts/verify-formal-release.ts <安全回执.json> <项目内报告.json>');
  const output=resolve(outputPath),inside=relative(root,output);
  if(!inside||inside==='..'||inside.startsWith('../')||isAbsolute(inside))throw new Error('报告必须放在当前项目内部。');
  const parent=relative(await realpath(root),await realpath(dirname(output)));
  if(parent==='..'||parent.startsWith('../')||isAbsolute(parent))throw new Error('报告父目录不能通过链接写到项目外。');
  const manifest=JSON.parse(await readFile(resolve(root,'release-manifest.json'),'utf8'));
  const project=JSON.parse(await readFile(resolve(root,'miniprogram/project.config.json'),'utf8'));
  const main=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const report=verifyFormalRelease({version:manifest.version,sourceDigest:manifest.sourceDigest,main,appId:project.appid},JSON.parse(await readFile(resolve(inputPath),'utf8')));
  let remoteMain='';try{remoteMain=execFileSync('git',['rev-parse','refs/remotes/origin/main'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}catch{/* Missing tracking ref is not evidence of a formal main release. */}
  if(remoteMain!==main){report.checks.push({id:'main-target',status:'pending',reason:'当前 HEAD 不是已获取的 origin/main；按发布流程获取并核对最新 main 后再运行。'});if(report.status==='passed')report.status='pending';}
  const dirty=execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:root,encoding:'utf8'}).trim();
  if(dirty){report.checks.push({id:'working-tree',status:'pending',reason:'当前源码有未提交修改，不能作为已确定的正式发布目标。'});if(report.status==='passed')report.status='pending';}
  // Create only a new report. Do not overwrite input, old evidence or source.
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:report.status,checks:report.checks,report:output}));
  if(report.status!=='passed')process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(()=>{console.error('正式发布核验未完成：请检查安全回执、项目路径及尚未存在的报告路径。');process.exitCode=1;});
}
