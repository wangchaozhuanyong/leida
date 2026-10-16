import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,realpath,lstat} from 'node:fs/promises';
import {basename,dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Evidence} from '../src/lib/types';
import {RESET_HISTORY_DISCOVERY_URL,RESET_HISTORY_DISCOVERY_REF,prepareResetHistoryCandidates,publicHistoryEvidence,refreshHistoryOriginalContext,historyTimestamp,historyPostIdentity,type HistoryCacheOriginCorrection} from '../src/lib/reset-history-candidates';
import {enrichKnownEvidence} from '../src/server/source-enrichment';
import {evidenceBenefitClaims,gatherEvidenceContext,hasCompleteContext,hasStandaloneContext,isTruncatedText} from '../src/server/source-context';

const root=resolve(fileURLToPath(new URL('../',import.meta.url))),args=process.argv.slice(2);
if(args.length===1&&args[0]==='--help'){
 console.log('只读历史核验：--input <项目内JSON绝对路径> 或 --input-url <固定发现清单URL>；--output <当前工作树outputs/forecast-upgrade-20261016/history下绝对目录>；可重复 --cache <项目内公开原文JSON绝对路径>；可选 --verify-originals、--cutoff <ISO时间>。不会写数据库、发布或发送提醒。');
 console.log(`固定发现清单：${RESET_HISTORY_DISCOVERY_URL}`);process.exit(0);
}
const projectRoot=basename(dirname(root))==='.codex-worktrees'?resolve(root,'../..'):root;
const value=(flag:string)=>{const index=args.indexOf(flag);return index<0?undefined:args[index+1];};
const caches=args.flatMap((item,index)=>item==='--cache'?[args[index+1]]:[]);
const allowed=new Set(['--input','--input-url','--output','--cache','--verify-originals','--cutoff']);
for(let index=0;index<args.length;index++){if(!allowed.has(args[index]))throw new Error('存在不支持的参数');if(args[index]!=='--verify-originals'){if(!args[index+1]||args[index+1].startsWith('--'))throw new Error('参数缺少值');index++;}}
const inputPath=value('--input'),inputURL=value('--input-url'),output=value('--output');
if(Boolean(inputPath)===Boolean(inputURL)||!output||!isAbsolute(output)||inputPath&&!isAbsolute(inputPath)||caches.some(path=>!path||!isAbsolute(path)))throw new Error('必须显式填写一个绝对输入路径或固定清单URL、绝对输出路径和缓存绝对路径');
for(const path of [...(inputPath?[inputPath]:[]),...caches]){const actual=await realpath(path);if(!actual.startsWith(projectRoot+sep)||!actual.endsWith('.json'))throw new Error('只读输入与公共原文缓存必须为所属项目内的JSON文件');}
if(inputURL&&inputURL!==RESET_HISTORY_DISCOVERY_URL)throw new Error('只允许固定提交的公开发现清单');
const outputRoot=resolve(root,'outputs/forecast-upgrade-20261016/history'),target=resolve(output);
if(target!==outputRoot&&!target.startsWith(outputRoot+sep))throw new Error('输出必须属于当前工作树 outputs/forecast-upgrade-20261016/history');
// Refuse existing symlinks before creating or exporting any artifact.
let current=root;for(const part of relative(root,target).split(sep)){current=resolve(current,part);try{if((await lstat(current)).isSymbolicLink())throw new Error('输出路径不得经过软链接');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
await mkdir(target,{recursive:true});if(!((await realpath(target))===target))throw new Error('输出真实路径不符');
const startedAt=new Date().toISOString(),cutoffAt=value('--cutoff')??startedAt;
if(!Number.isFinite(historyTimestamp(cutoffAt))||historyTimestamp(cutoffAt)>Date.now())throw new Error('截止时间无效或在未来');
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const save=async(name:string,value:unknown)=>writeFile(resolve(target,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
let text:string;
if(inputPath)text=await readFile(inputPath,'utf8');
else{
 const response=await fetch(inputURL!,{signal:AbortSignal.timeout(20000),redirect:'error',headers:{Accept:'application/vnd.github+json','User-Agent':'MoyaoResetRadar-HistoryReview/1.0'}});
 if(!response.ok)throw new Error(`公开发现清单读取失败：HTTP ${response.status}`);
 const envelope=await response.json() as {content?:unknown;encoding?:unknown};
 if(envelope.encoding!=='base64'||typeof envelope.content!=='string'||envelope.content.length>2_000_000)throw new Error('GitHub公开清单编码或大小无效');
 text=Buffer.from(envelope.content,'base64').toString('utf8');
}
if(text.length>1_000_000)throw new Error('历史清单超过大小上限');
const discovery=prepareResetHistoryCandidates(JSON.parse(text),cutoffAt);
await save('upstream-discovery.json',{schema_version:1,generated_at:discovery.sourceGeneratedAt,events:discovery.candidates.flatMap(candidate=>candidate.sourceClaims.map(claim=>({event_id:claim.eventId,reset_type:claim.kind==='automatic_reset'?'global':claim.kind==='banked_reset'?'banked':'unknown',record_status:'recorded',occurred_at:claim.occurredAt,source:{url:candidate.url}})))});
await save('source-provenance.json',{input:inputPath??inputURL,repository:'gdutxiaoxu/codex-reset-radar',ref:RESET_HISTORY_DISCOVERY_REF,sha256:digest(text),readAt:startedAt,cutoffAt,sourceGeneratedAt:discovery.sourceGeneratedAt,note:'第三方清单仅发现候选，recorded不等于原文或训练资格已核验。'});
const evidence:Evidence[]=[],cacheStats:{path:string;publicRows:number}[]=[];
const originCorrections:HistoryCacheOriginCorrection[]=[];
const contextRefreshes:{id:string;url:string;sourceId:string}[]=[];
for(const path of caches){const rows=publicHistoryEvidence(JSON.parse(await readFile(path,'utf8')),cutoffAt,correction=>originCorrections.push(correction)),refreshed=refreshHistoryOriginalContext(rows,text=>hasStandaloneContext(text,'reset'));for(let index=0;index<rows.length;index++)if(refreshed[index].contextComplete!==rows[index].contextComplete)contextRefreshes.push({id:rows[index].id,url:rows[index].url,sourceId:rows[index].sourceId});evidence.push(...refreshed);cacheStats.push({path,publicRows:rows.length});}
await save('cache-provenance-corrections.json',{mode:'local_review_only',corrections:originCorrections,contextRefreshes,sourceIdentitiesChanged:0,bodiesChanged:0,note:'仅撤销不可信的原文标记，并按当前明确正文重算旧完整性标记；不改历史包、来源身份或数据库。'});
const verification=new Map<string,{status:'cached_original'|'fetched_original'|'unavailable'|'not_checked';reason?:string;checkedAt:string;httpStatuses?:number[]}>();
const existing=(url:string)=>evidence.filter(row=>row.url===url&&row.textOrigin==='original'&&!isTruncatedText(row.text)).sort((a,b)=>b.collectedAt.localeCompare(a.collectedAt))[0];
for(const candidate of discovery.candidates)if(existing(candidate.url))verification.set(candidate.url,{status:'cached_original',checkedAt:startedAt});
let requests=0,networkFailures=0;
const requestStatuses=new Map<string,number[]>(),networkErrors=new Set<string>();
const verify=args.includes('--verify-originals'),queue=discovery.candidates.filter(candidate=>!verification.has(candidate.url)).slice(0,55);
if(verify){
 const fetcher:typeof fetch=async(url,init)=>{
  const request=new URL(String(url));
  if(request.protocol!=='https:'||!['publish.twitter.com','publish.x.com'].includes(request.hostname)||request.pathname!=='/oembed'||!historyPostIdentity(request.searchParams.get('url')))throw new Error('只允许已知原帖oEmbed');
  requests++;
  const postURL=historyPostIdentity(request.searchParams.get('url'))!.url;
  try{const response=await fetch(request,{...init,signal:AbortSignal.any([AbortSignal.timeout(10000),...(init?.signal?[init.signal]:[])])});requestStatuses.set(postURL,[...(requestStatuses.get(postURL)??[]),response.status]);return response;}catch(error){networkFailures++;networkErrors.add(postURL);throw error;}
 };
 let next=0,checked=0;
 await Promise.all(Array.from({length:2},async()=>{
  while(next<queue.length){
   const candidate=queue[next++],prototype:Evidence={id:`history-review:${candidate.messageId}`,sourceId:'reset-history-review',messageId:candidate.messageId,url:candidate.url,text:'',publishedAt:candidate.originalPublishedAt,collectedAt:startedAt,hash:'',contextComplete:false,historical:true,provenance:'archive',textOrigin:'archive_excerpt',metadata:{category:'reset',sourceGroup:'history-oembed:thsottiaux'}};
   const original=await enrichKnownEvidence(prototype,fetcher);
   const checkedAt=new Date().toISOString();
   const httpStatuses=requestStatuses.get(candidate.url)??[];
   if(original){evidence.push(original);verification.set(candidate.url,{status:'fetched_original',checkedAt,httpStatuses});}
   else verification.set(candidate.url,{status:'unavailable',checkedAt,httpStatuses,reason:networkErrors.has(candidate.url)?'oEmbed网络连接失败或超时，未取得原文。':httpStatuses.some(status=>status>=400)?`oEmbed返回HTTP ${httpStatuses.filter(status=>status>=400).join('/')}，无法取得原文。`:'oEmbed响应未满足原帖身份、完整正文或结构要求，仍待核对。'});
   process.stdout.write(JSON.stringify({checked:++checked,total:queue.length,status:verification.get(candidate.url)!.status})+'\n');
  }
 }));
}
// Fresh reads cannot be replayed as if known before the verification completed.
const finalCutoff=new Date(Math.max(historyTimestamp(cutoffAt),...evidence.map(row=>historyTimestamp(row.collectedAt)))).toISOString();
const safe=publicHistoryEvidence(evidence,finalCutoff);
const reviewed=discovery.candidates.map(candidate=>{
 const original=existing(candidate.url),context=original?gatherEvidenceContext(original,safe):[];
 const complete=!!original&&hasCompleteContext(original,context)&&!context.some(row=>row.parentId&&!context.some(parent=>parent.messageId===row.parentId));
 const claims=original&&complete?evidenceBenefitClaims(original,context).filter(claim=>claim.scope==='public'&&['in_progress','claimed_complete'].includes(claim.stage)&&!/[（(](?:资格原文|地区原文|限定范围)[:：]/u.test(claim.eligibility)):[];
 const kinds=[...new Set(claims.map(claim=>claim.kind))],suggestedKind=kinds.length===1?kinds[0]:undefined;
 const conflict=candidate.typeConflict||!!suggestedKind&&candidate.listedKind!=='unspecified'&&suggestedKind!==candidate.listedKind;
 const reasons:string[]=[];
 if(candidate.typeConflict)reasons.push('第三方同原帖类型冲突');
 if(!original)reasons.push('缺少可核验完整原文');
 if(original&&!complete)reasons.push('完整父链或语境未核实');
 if(original&&complete&&!suggestedKind)reasons.push('原文动作、阶段或普发资格仍不明确');
 if(suggestedKind&&candidate.listedKind!=='unspecified'&&suggestedKind!==candidate.listedKind)reasons.push('第三方类型与原文解析冲突');
 if(candidate.sourceClaims.some(claim=>claim.timePrecision==='date'))reasons.push('第三方条目只有日期；精确时间仅来自已验证原帖身份');
 if(candidate.sourceClaims.some(claim=>claim.occurredAt.slice(0,10)!==candidate.originalPublishedAt.slice(0,10)))reasons.push('第三方日期与原帖日期不同，需复核');
 return {...candidate,verification:verification.get(candidate.url)??{status:'not_checked',checkedAt:startedAt},suggestedKind,contextEvidenceIds:context.map(row=>row.id),reviewReadiness:conflict?'conflict':original&&complete&&suggestedKind?'ready_for_review':'pending',reasons,...(original?{originalEvidence:original}:{})};
});
await save('history-candidates.json',{...discovery,candidates:reviewed,originalVerificationCutoffAt:finalCutoff});
await save('public-original-cache.json',{schemaVersion:1,evidence:safe});
await save('evidence-candidates.json',{schemaVersion:1,mode:'review_only_not_imported',historical:true,autoPublish:false,notifyReaders:false,trainingEligible:false,records:reviewed.filter(row=>row.originalEvidence).map(row=>row.originalEvidence),requirements:['按现有真实证据与候选流程重新校验来源、父链和资格。','本文件不执行入库、发布、微信发送或预测训练。']});
const summary={preparedAt:new Date().toISOString(),cutoffAt,originalVerificationCutoffAt:finalCutoff,uniqueCandidates:reviewed.length,duplicates:reviewed.reduce((sum,row)=>sum+row.duplicateCount,0),rejected:discovery.rejected.length,listedKinds:{automatic_reset:reviewed.filter(row=>row.listedKind==='automatic_reset').length,banked_reset:reviewed.filter(row=>row.listedKind==='banked_reset').length,unspecified:reviewed.filter(row=>row.listedKind==='unspecified').length},originals:{cached:reviewed.filter(row=>row.verification.status==='cached_original').length,fetched:reviewed.filter(row=>row.verification.status==='fetched_original').length,unavailable:reviewed.filter(row=>row.verification.status==='unavailable').length,notChecked:reviewed.filter(row=>row.verification.status==='not_checked').length},readyForReview:reviewed.filter(row=>row.reviewReadiness==='ready_for_review').length,pending:reviewed.filter(row=>row.reviewReadiness==='pending').length,conflicts:reviewed.filter(row=>row.reviewReadiness==='conflict').length,requests,networkFailures,cacheStats,databaseWrites:0,publications:0,wechatSends:0,trainingImports:0};
await save('summary.json',summary);
const markdown=['# 历史重置候选核对','',`整理 ${summary.uniqueCandidates} 个原帖：缓存原文 ${summary.originals.cached} 个，新补原文 ${summary.originals.fetched} 个，网络或原文不可核验 ${summary.originals.unavailable} 个，未重新联网核验 ${summary.originals.notChecked} 个。`,`原文动作与类型明确 ${summary.readyForReview} 个，待补依据 ${summary.pending} 个，冲突 ${summary.conflicts} 个。`,'','候选的 pending 是准备导入前的数据状态，不要求用户逐条审批；满足原文、来源与资格规则后可以进入既有资格核验流程。本次未入库、未发布、未发送微信、未导入训练。精确原帖时间是消息发布时间，不自动代表实际发放完成时间。','','| 原帖 | 第三方类型 | 原文核验 | 数据状态 | 待核对事项 |','|---|---|---|---|---|',...reviewed.map(row=>`| [${row.messageId}](${row.url}) | ${row.listedKind} | ${row.verification.status} | ${row.reviewReadiness} | ${[...row.reasons,...(row.verification.reason?[row.verification.reason]:[])].join('；')||'可以进入既有来源、资格及去重核验流程'} |`)];
await writeFile(resolve(target,'待核对历史清单.md'),markdown.join('\n')+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify(summary,null,2)+'\n');
