import {completedPublicActions} from '../src/lib/public-facts';
import {parseReferenceLatest,referenceCompletionClaim} from '../src/server/reference-reset-source';
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import type {Evidence,PublicData} from '../src/lib/types';
import {parseKnownRelayOriginal} from '../src/server/source-enrichment';
import {evidenceBenefitClaims,gatherEvidenceContext,hasCompleteContext,isTruncatedText} from '../src/server/source-context';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {validateDraft} from '../src/server/domain';
const root=resolve(fileURLToPath(new URL('../',import.meta.url))),args=process.argv.slice(2),arg=(key:string)=>args[args.indexOf(key)+1];
for(const flag of ['--input','--public-data','--output'])if(!args.includes(flag)||!arg(flag)?.startsWith(root+sep))throw new Error('必须显式指定当前项目内的输入、公开数据和输出绝对路径');
const output=resolve(arg('--output'));if(!output.startsWith(resolve(root,'outputs')+sep))throw new Error('输出仅允许在项目outputs内');
await mkdir(output,{recursive:true});if(await realpath(output)!==output)throw new Error('输出不可为软链接');
const upstream=JSON.parse(await readFile(arg('--input'),'utf8')) as {generated_at:string;events:{event_id:string;reset_type:string;record_status:string;occurred_at:string;source:{url:string}}[]};
const payload=JSON.parse(await readFile(arg('--public-data'),'utf8')),facts=(payload.data??payload) as PublicData;
const cutoff=facts.serverTime,earliest=new Date(cutoff);earliest.setUTCMonth(earliest.getUTCMonth()-6);
const rows=upstream.events.filter(r=>r.record_status==='recorded'&&Date.parse(r.occurred_at)>=earliest.getTime()&&Date.parse(r.occurred_at)<=Date.parse(cutoff)&&/^https:\/\/x\.com\/thsottiaux\/status\/\d{15,20}$/.test(r.source.url));
let cached:Evidence[]=[];try{cached=JSON.parse(await readFile(resolve(output,'verified-originals-cache.json'),'utf8'));}catch{}
const evidence=[...facts.evidence,...cached];const failures:{url:string;code:string}[]=[];let requests=0;
const original=(url:string)=>evidence.filter(e=>e.url===url&&e.textOrigin==='original'&&!isTruncatedText(e.text)).sort((a,b)=>Number(!!referenceCompletionClaim(b))-Number(!!referenceCompletionClaim(a))||b.collectedAt.localeCompare(a.collectedAt))[0];
async function fetchOriginal(url:string):Promise<void>{
 if(original(url)||requests>=70)return;
 const messageId=url.split('/').at(-1)!,publishedAt=new Date(Number((BigInt(messageId)>>22n)+1288834974657n)).toISOString();
 const prototype:Evidence={id:`history:${messageId}`,hash:'public-reconciliation',sourceId:'tibo-public',messageId,url,text:'',publishedAt,collectedAt:new Date().toISOString(),contextComplete:false,historical:true,provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'fxembed:thsottiaux',category:'reset'}};
 requests++;
 try{
  const response=await fetch(`https://api.fxtwitter.com/status/${messageId}`,{signal:AbortSignal.timeout(10000),redirect:'error',headers:{Accept:'application/json'}});
  if(!response.ok){await response.body?.cancel();failures.push({url,code:`HTTP_${response.status}`});return;}
  if(Number(response.headers.get('content-length'))>1000000){await response.body?.cancel();failures.push({url,code:'BODY_TOO_LARGE'});return;}
  const reader=response.body!.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000){await reader.cancel();throw new Error('SIZE');}chunks.push(value);}}finally{reader.releaseLock();}
  const value=parseKnownRelayOriginal(JSON.parse(Buffer.concat(chunks).toString('utf8')),prototype);
  if(value)evidence.push(value);else failures.push({url,code:'ORIGINAL_INVALID'});
 }catch{failures.push({url,code:'READ_FAILED'});}
}
if(args.includes('--verify-originals')){
 let index=0;await Promise.all(Array.from({length:2},async()=>{while(index<rows.length){const row=rows[index++];await fetchOriginal(row.source.url);}}));
 await writeFile(resolve(output,'verified-originals-cache.json'),JSON.stringify(evidence));
 const parents=[...new Set(evidence.flatMap(e=>e.parentId&&/^\d{15,20}$/.test(e.parentId)&&/^https:\/\/x\.com\/thsottiaux\/status\/\d+$/.test(e.url)?[`https://x.com/thsottiaux/status/${e.parentId}`]:[]))];
 let parent=0;await Promise.all(Array.from({length:2},async()=>{while(parent<parents.length)await fetchOriginal(parents[parent++]);}));
}
if(args.includes('--latest')){
 const path=arg('--latest');if(!path.startsWith(root+sep))throw new Error('最新快照必须位于本项目');
 for(const prototype of parseReferenceLatest(JSON.parse(await readFile(path,'utf8')),new Date().toISOString())){
  const raw=original(prototype.url);if(!raw||Math.abs(Date.parse(raw.publishedAt)-Date.parse(prototype.publishedAt))>1000)continue;
  const enriched:Evidence={...prototype,id:`reference-local:${prototype.messageId}`,hash:'verified-public-original',historical:true,text:raw.text,textOrigin:'original',parentId:raw.parentId,contextComplete:false};
  if(referenceCompletionClaim(enriched))evidence.push(enriched);
 }
}
const publicCompletions=completedPublicActions(facts);
const reviewed=rows.map(row=>{
 const primary=original(row.source.url),context=primary?gatherEvidenceContext(primary,evidence):[];
 const claims=primary&&hasCompleteContext(primary,context)?evidenceBenefitClaims(primary,context).filter(c=>c.scope==='public'):[];
 const draft=context.length?buildAutomaticTemplate(context):undefined;
 const errors=draft?validateDraft(draft,context,true):['缺少完整原文或明确事件阶段'];
 const difference=primary?Math.round(Math.abs(Date.parse(primary.publishedAt)-Date.parse(row.occurred_at))/1000):undefined;
 const warnings=difference!==undefined&&difference>60?['参考时刻与原帖发布时间不同；分别保留，不作为精确完成时刻互换']:[];
 const listedKind=row.reset_type==='global'?'automatic_reset':row.reset_type==='banked'?'banked_reset':undefined;
 const completed=claims.filter(c=>c.stage==='claimed_complete');
 const wrongKind=!!listedKind&&completed.length>0&&!completed.some(c=>c.kind===listedKind);
 const originalIds=new Set(evidence.filter(e=>e.url===row.source.url).map(e=>e.id));
 const existingEvents=facts.events.filter(event=>event.evidenceIds.some(id=>originalIds.has(id)));
 const alreadyPublic=!!primary&&publicCompletions.some(({action})=>Math.abs(Date.parse(action.statementAt)-Date.parse(primary.publishedAt))<=1000&&action.evidenceIds.some(id=>originalIds.has(id)));
 const protectedEvents=existingEvents.filter(event=>['merged','withdrawn'].includes(event.status));
 const siteStatus=alreadyPublic?'public_completion':protectedEvents.length?'protected_existing_event':'not_public_completion';
 return {siteStatus,protectedEvents:protectedEvents.map(event=>({id:event.id,status:event.status,mergedInto:event.mergedInto})),postId:row.source.url.split('/').at(-1),url:row.source.url,referenceType:row.reset_type,referenceAt:row.occurred_at,originalAt:primary?.publishedAt,stages:claims.map(c=>({kind:c.kind,stage:c.stage})),warnings,timeDifferenceSeconds:difference,status:wrongKind?'type_conflict':!errors.length&&completed.length?'verified_completion':claims.length?'announcement_or_progress':'needs_context',errors,...(!errors.length&&completed.length&&!wrongKind?{draft,originalEvidence:context.map(e=>({...e,historical:true}))}:{})};
});
const counts=Object.fromEntries(['verified_completion','announcement_or_progress','needs_context','type_conflict'].map(status=>[status,reviewed.filter(r=>r.status===status).length]));
const report={cutoffAt:cutoff,verifiedAt:new Date().toISOString(),referenceGeneratedAt:upstream.generated_at,referenceSha256:createHash('sha256').update(JSON.stringify(upstream)).digest('hex'),sixMonthRows:rows.length,counts,requests,failures,reviewed,databaseWrites:0,publications:0,wechatSends:0};
await writeFile(resolve(output,'history-reconciliation.json'),JSON.stringify(report,null,2));
await writeFile(resolve(output,'verified-history-drafts.json'),JSON.stringify(reviewed.filter(r=>r.status==='verified_completion'),null,2));
await writeFile(resolve(output,'历史对账结果.md'),['# 近半年历史对账','',`核对 ${rows.length} 条参考记录；原文确认完成 ${counts.verified_completion}，预告或进行中 ${counts.announcement_or_progress}，上下文待补 ${counts.needs_context}，类型冲突 ${counts.type_conflict}。`,'','仅生成核验批次；未写数据库、未发布、未发微信。参考条目的 recorded 不等于实际完成。','',...reviewed.map(r=>`- [${r.postId}](${r.url})：${r.status}；${r.stages.map(s=>s.kind+'/'+s.stage).join('、')||r.errors.join('；')} ${r.warnings.join('；')}；站点：${r.siteStatus}${r.protectedEvents.length?'（保留已合并/撤回状态，须核对后处理）':''}`)].join('\n')+'\n');
console.log(JSON.stringify({sixMonthRows:rows.length,counts,requests,failures:failures.length,databaseWrites:0}));
