import {REFERENCE_RESET_SOURCE,REFERENCE_SOURCES,REFERENCE_SIGNAL_SOURCE,REFERENCE_HISTORY_SOURCE,parseReferenceSignals,parseReferenceHistory,parseReferenceLatest,referenceContentsURL} from './reference-reset-source';
import { load } from 'cheerio';
import { list, one, put, transaction } from '../db';
import type { Activity, ActivityDefinition, Evidence, Source, SourceHttpCheckpoint } from '../lib/types';
import { DomainError, hash, now } from './domain';
import { audit, createEvidence } from './service';
import { gatherEvidenceContext, hasStandaloneContext } from './source-context';
import { evidenceFingerprint } from './automatic-content';
import {TiboTimelineError} from './tibo-timeline';
import {TIBO_PUBLIC_SOURCE,fetchTiboPublicTimeline,safeSourceTransportCode,type TiboPublicBatch} from './tibo-public';
import {randomUUID} from 'node:crypto';
import {markForecastInputsChanged} from './reset-cadence-runtime';
import {sourceCollectionSchedule,sourceNextCollectionAt,sourceForecastConfiguration} from './source-collection-policy';

export class SourceStructureError extends DomainError {}
export class SourceRateLimitError extends DomainError {
 constructor(public retryAt:string,message='来源要求降低采集频率，将按服务器允许时间重试') { super(message,429); }
}
export class SourceConfigurationError extends DomainError {}
export class SourceTransientError extends DomainError {}
class SourceDiagnosticError extends DomainError {}
class SourceUnchanged extends Error {}
export interface SourceRequestEvent {
 requestId:string;phase:'source'|'releases'|'clock';attempt:number;outcome:'failed'|'recovered';elapsedMs:number;
 reason?:'http'|'network'|'body'|'format';status?:number;transportCode?:string;retryInMs?:number;
}
export interface SourceReadDependencies {fetcher?:typeof fetch;sleep?:(milliseconds:number)=>Promise<void>;onRequestEvent?:(event:SourceRequestEvent)=>Promise<void>;forceFullRead?:boolean;}
interface SourceReadContext extends SourceReadDependencies {retriesRemaining:number;source?:Source;checkpoints:Record<string,SourceHttpCheckpoint>;allowUnchanged:boolean;}
const readContext=(dependencies:SourceReadDependencies={},source?:Source):SourceReadContext=>({...dependencies,retriesRemaining:2,source,checkpoints:{...source?.httpCheckpoints},allowUnchanged:!!source&&!dependencies.forceFullRead&&source.validated&&!source.publicationPaused&&!(source.kind==='releases'&&(source.releaseScan?.nextPage??1)>1)});
export const sourceDefinitions:Source[]=[
 {id:'official-status',name:'官方服务状态',kind:'status',url:'https://status.openai.com/api/v2/incidents.json',enabled:false,validated:false,intervalMinutes:30,collectionPolicy:'adaptive',version:1,status:'unconnected'},
 {id:'reset-archive',name:'重置公开归档（辅助来源）',kind:'archive',url:'https://codex-resets.com/zh-CN',enabled:false,validated:false,intervalMinutes:30,collectionPolicy:'adaptive',version:1,status:'unconnected'},
 {id:'activity-archive',name:'活动公开归档（辅助来源）',kind:'activity',url:'https://codex-resets.com/tibo-28',enabled:false,validated:false,intervalMinutes:30,collectionPolicy:'adaptive',version:1,status:'unconnected'},
 {id:'manual',name:'人工补充原文',kind:'manual',url:'https://codex-resets.com/zh-CN',enabled:false,validated:true,intervalMinutes:15,version:1,status:'paused'},
 {id:'official-releases',name:'Codex 官方稳定版本',kind:'releases',url:'https://api.github.com/repos/openai/codex/releases',enabled:false,validated:false,intervalMinutes:360,collectionPolicy:'adaptive',version:1,status:'unconnected'},
 TIBO_PUBLIC_SOURCE, ...REFERENCE_SOURCES
];
export type Incoming=Omit<Evidence,'id'|'hash'|'historical'> & {activityDay?:number};
const responseCache = new Map<string,{etag?:string;lastModified?:string;body:string}>();
const releaseCheckpoints = new Map<string,Source['releaseScan']>();
const timelineCheckpoints = new WeakMap<Source,TiboPublicBatch>();
const sourceReadCheckpoints=new WeakMap<Source,{httpCheckpoints:Record<string,SourceHttpCheckpoint>;unchanged:boolean}>();
const safeValidator=(value:string|null)=>value&&value.length<=1024&&!/[\r\n]/.test(value)?value:undefined;
export function sourceReadCheckpoint(source:Source){return sourceReadCheckpoints.get(source);}
export function incomingFingerprint(records:Incoming[]):string {
 return hash(JSON.stringify(records.map(({collectedAt:_,...record})=>{const proof=record.metadata?.referenceReset;if(record.sourceId===REFERENCE_RESET_SOURCE.id&&proof){const {snapshotAt:__,...stable}=proof;return {...record,metadata:{...record.metadata,referenceReset:stable}};}return record;}).sort((a,b)=>a.messageId.localeCompare(b.messageId)||a.sourceId.localeCompare(b.sourceId))));
}
export function hasOpenCodexIncident(records:Incoming[]):boolean {
 const latest=new Map<string,Incoming>();
 for(const record of records){
  if(record.provenance!=='official'||!/\bcodex\b/i.test(record.metadata?.title??'')||!record.metadata?.status)continue;
  const key=record.parentId??record.messageId,previous=latest.get(key);
  if(!previous||Date.parse(record.publishedAt)>Date.parse(previous.publishedAt))latest.set(key,record);
 }
 return [...latest.values()].some(record=>!['resolved','postmortem','completed'].includes(record.metadata!.status!));
}
function timelineError(error:TiboTimelineError):DomainError {
 if(error.failureKind==='structure')return new SourceStructureError(error.message);
 if(error.failureKind==='rate_limit'&&error.retryAt)return new SourceRateLimitError(error.retryAt,error.message);
 if(error.failureKind==='configuration')return new SourceConfigurationError(error.message);
 return error;
}
export const RELEASE_PAGE_SIZE=5;
export const MAX_RELEASE_PAGES=3;
const RELEASE_LOOKBACK_MS=7*24*3600_000;
const ARCHIVE_ORIGIN='https://codex-resets.com';

export function retryAtFromHeaders(headers:Headers,currentTime=Date.now()):string {
 const retryAfter=headers.get('retry-after');
 const retryMs=retryAfter?(Number.isFinite(Number(retryAfter))?currentTime+Number(retryAfter)*1000:Date.parse(retryAfter)):NaN;
 const resetMs=Number(headers.get('x-ratelimit-reset'))*1000;
 return new Date(Math.max(currentTime+5*60_000,Number.isFinite(retryMs)&&retryMs<8.64e15?retryMs:0,Number.isFinite(resetMs)&&resetMs<8.64e15?resetMs:0)).toISOString();
}
function challengePath(url:string):string|undefined {
 try {const parsed=new URL(url);if(parsed.origin!==ARCHIVE_ORIGIN||parsed.username||parsed.password||parsed.hash)return undefined;
  const match=parsed.pathname.match(/^\/(?:zh-CN\/)?((?:tibo|challenge)-[a-z0-9][a-z0-9-]{0,70})\/?$/);
  return match?.[1];
 }catch{return undefined;}
}
function allowedSource(source:Source):boolean {
 if(source.kind==='manual')return false;
 const fixed=sourceDefinitions.find(s=>s.id===source.id);
 if(fixed?.kind===source.kind) {
  if(source.url===fixed.url)return true;
  if(source.kind==='releases'&&source.url==='https://api.github.com/repos/openai/codex/releases/latest')return true;
  if(source.kind==='activity'&&challengePath(source.url)==='tibo-28')return true;
 }
 return source.kind==='activity'&&source.discoveredFrom==='reset-archive'&&source.id===`activity-${hash(challengePath(source.url)??'').slice(0,16)}`&&!!challengePath(source.url);
}
async function fetchAllowedURL(url:string,accept='text/html,application/json',context:SourceReadContext=readContext(),phase:SourceRequestEvent['phase']='source'):Promise<string> {
 const cached=responseCache.get(url);
 const saved=context.checkpoints[url],primary=phase!=='clock';
 const headers:Record<string,string>={'User-Agent':'MoyaoResetRadar/1.0 (+local research collector)','Accept':accept};
 const validator=primary&&context.allowUnchanged?saved:cached;
 if(validator?.etag)headers['If-None-Match']=validator.etag;
 else if(validator?.lastModified)headers['If-Modified-Since']=validator.lastModified;
 const requestId=randomUUID(),sleep=context.sleep??(milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)));
 for(let attempt=1;;attempt++){
  const started=performance.now();let detail:Pick<SourceRequestEvent,'reason'|'status'|'transportCode'>={reason:'network'},body:string;
  try{
   let response:Response;
   try{response=await (context.fetcher??fetch)(url,{signal:AbortSignal.timeout(20_000),redirect:'error',headers});}
   catch(error){detail={reason:'network',transportCode:safeSourceTransportCode(error)};throw new SourceTransientError('来源暂时连接失败，等待自动重试');}
   detail={reason:'http',status:response.status};
   if(response.status===304&&primary&&context.allowUnchanged&&saved){
    if(attempt>1)await context.onRequestEvent?.({requestId,phase,attempt,outcome:'recovered',elapsedMs:Math.round(performance.now()-started)});
    throw new SourceUnchanged();
   }
   if(response.status===304&&cached)body=cached.body;
   else{
    const retryHeader=response.headers.get('retry-after'),seconds=Number(retryHeader),retryMs=retryHeader?(Number.isFinite(seconds)?Date.now()+seconds*1000:Date.parse(retryHeader)):0;
    if(response.status===429||!response.ok&&Number.isFinite(retryMs)&&retryMs>Date.now()||response.status===403&&response.headers.get('x-ratelimit-remaining')==='0'){
     await response.body?.cancel();throw new SourceRateLimitError(retryAtFromHeaders(response.headers));
    }
    if(!response.ok){await response.body?.cancel();throw ([408,425].includes(response.status)||response.status>=500?new SourceTransientError(`来源请求失败（状态 ${response.status}）`):new DomainError(`来源请求失败（状态 ${response.status}）`));}
    const length=Number(response.headers.get('content-length')??0);if(length>3_000_000){await response.body?.cancel();throw new SourceStructureError('来源响应超出结构上限');}
    const reader=response.body?.getReader();if(!reader)throw new SourceStructureError('来源响应为空');const chunks:Uint8Array[]=[];let total=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>3_000_000){await reader.cancel();throw new SourceStructureError('来源响应超出结构上限');}chunks.push(value);}}
    catch(error){if(error instanceof SourceStructureError)throw error;detail={reason:'body',transportCode:safeSourceTransportCode(error)};throw new SourceTransientError('来源响应读取中断，等待自动重试');}
    finally{reader.releaseLock();}
    body=Buffer.concat(chunks).toString('utf8');
    const checkpoint:SourceHttpCheckpoint={bodyHash:hash(body),etag:safeValidator(response.headers.get('etag')),lastModified:safeValidator(response.headers.get('last-modified'))};
    if(primary){context.checkpoints[url]=checkpoint;while(Object.keys(context.checkpoints).length>16)delete context.checkpoints[Object.keys(context.checkpoints)[0]];}
    if(!responseCache.has(url)&&responseCache.size>=16)responseCache.delete(responseCache.keys().next().value!);
    responseCache.set(url,{body,etag:response.headers.get('etag')??undefined,lastModified:response.headers.get('last-modified')??undefined});
    if(primary&&context.allowUnchanged&&saved?.bodyHash===checkpoint.bodyHash){
     if(attempt>1)await context.onRequestEvent?.({requestId,phase,attempt,outcome:'recovered',elapsedMs:Math.round(performance.now()-started)});
     throw new SourceUnchanged();
    }
   }
  }catch(error){
   if(error instanceof SourceUnchanged)throw error;
   const retry=error instanceof SourceTransientError&&context.retriesRemaining>0,retryInMs=retry?(context.retriesRemaining===2?1000:2500):undefined;
   await context.onRequestEvent?.({requestId,phase,attempt,outcome:'failed',elapsedMs:Math.round(performance.now()-started),...(error instanceof SourceStructureError?{reason:'format' as const}:detail),...(retryInMs?{retryInMs}:{})});
   if(!retry)throw error;context.retriesRemaining--;await sleep(retryInMs!);continue;
  }
  if(attempt>1)await context.onRequestEvent?.({requestId,phase,attempt,outcome:'recovered',elapsedMs:Math.round(performance.now()-started)});
  return body;
 }
}
function explicitParentId(attribute:string|undefined,link:string|undefined,ownId:string):string|undefined {
 const parent=attribute??link?.match(/^https:\/\/(?:x|twitter)\.com\/thsottiaux\/status\/(\d+)(?:[?#].*)?$/)?.[1];
 if(!parent)return undefined;
 if(!/^\d+$/.test(parent)||parent===ownId)throw new SourceStructureError('来源父帖编号无效');
 return parent;
}
export function discoverActivityLinks(html:string):string[] {
 const $=load(html);const found=new Set<string>();
 $('a[href]').each((_,element)=>{try{const slug=challengePath(new URL($(element).attr('href')!,ARCHIVE_ORIGIN).toString());if(slug)found.add(`${ARCHIVE_ORIGIN}/zh-CN/${slug}`);}catch{}});
 return [...found].slice(0,10);
}
/** Dates, rule text and time zone must all exist in the page or its known clock asset. */
export function parseActivityDefinition(html:string,url:string,clockScript=''):ActivityDefinition|undefined {
 const slug=challengePath(url);if(!slug)return undefined;
 const $=load(html);if(!$('.challenge-entry').length)return undefined;
 const clock=$('[data-challenge-clock]').first(),title=$('#challenge-title').text().trim(),startsOn=clock.attr('data-start'),days=Number(clock.attr('data-days'));
 const rules=$('.challenge-promise blockquote').first().text().trim();
 const explicitZone=clock.attr('data-timezone')??clock.attr('data-time-zone');
 const scriptZone=clockScript.match(/\b(?:const|let|var)\s+zone\s*=\s*["']([A-Za-z_]+\/[A-Za-z_]+)["']/)?.[1];
 const timezone=explicitZone??scriptZone;
 if(!title||title.length>120||!startsOn||!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)||!Number.isFinite(Date.parse(startsOn))||new Date(startsOn).toISOString().slice(0,10)!==startsOn||!Number.isSafeInteger(days)||days<1||days>366||rules.length<10||rules.length>5000||!timezone)return undefined;
 try{new Intl.DateTimeFormat('zh-CN',{timeZone:timezone});}catch{return undefined;}
 // Preserve the established event link for this campaign; future campaigns use their own stable slug.
 return {id:slug==='tibo-28'?'challenge-28':`challenge-${slug}`,title,timezone,startsOn,days,rules};
}
export function parseArchive(html:string,source:Source,collectedAt=now(),activity?:ActivityDefinition):Incoming[] {
 const $=load(html);const rows:Incoming[]=[];
 if(source.kind==='archive') {
  const scheduledCards=$('[data-role="scheduled-reset"]');
  if(scheduledCards.length>1)throw new SourceStructureError('重置预告结构变化：存在多个安排卡片');
  if(scheduledCards.length){
   const card=scheduledCards.first(),deadline=card.attr('data-scheduled-for');
   let key:unknown;try{key=JSON.parse(card.attr('data-scheduled-key')??'');}catch{throw new SourceStructureError('重置预告标识结构变化');}
   if(source.id!=='reset-archive'||source.url!==`${ARCHIVE_ORIGIN}/zh-CN`||!Array.isArray(key)||key.length!==4||!key.every(value=>typeof value==='string'))throw new SourceStructureError('重置预告来源或字段变化');
   const [messageId,keyDeadline,type,url]=key as string[];
   if(!/^\d{15,20}$/.test(messageId)||!['regular','banked'].includes(type)||url!==`https://x.com/thsottiaux/status/${messageId}`||!card.find('a[href]').toArray().some(link=>$(link).attr('href')===url))throw new SourceStructureError('重置预告原帖身份或类型不一致');
   const iso=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
   if(!deadline||!iso.test(deadline)||!iso.test(keyDeadline)||!Number.isFinite(Date.parse(deadline))||new Date(deadline).toISOString().slice(0,19)!==deadline.slice(0,19)||new Date(keyDeadline).toISOString().slice(0,19)!==keyDeadline.slice(0,19)||Date.parse(deadline)!==Date.parse(keyDeadline))throw new SourceStructureError('重置预告截止时间不一致');
   const publishedMs=Number((BigInt(messageId)>>22n)+1288834974657n),deadlineMs=Date.parse(deadline);
   if(!Number.isSafeInteger(publishedMs)||publishedMs<1288834974657||!Number.isFinite(Date.parse(collectedAt))||publishedMs>Date.parse(collectedAt)+5*60_000||deadlineMs<=publishedMs||deadlineMs-publishedMs>36*3600_000)throw new SourceStructureError('重置预告时间范围异常');
   const expectedAt=new Date(deadlineMs).toISOString(),kind=type==='banked'?'banked_reset' as const:'automatic_reset' as const;
   const text=`公开归档已安排${kind==='banked_reset'?'重置卡发放':'用量重置'}，预计最晚${new Date(expectedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）；原帖内容待核对。`;
   rows.push({sourceId:source.id,messageId,url,text,publishedAt:new Date(publishedMs).toISOString(),collectedAt,contextComplete:false,provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'reset',summary:text,scheduledReset:{expectedAt,kind,sourceUrl:source.url}}});
  }
  const cards=$('.log-item[data-tweet-id]');if(!cards.length&&!rows.length)throw new SourceStructureError('重置归档结构变化：找不到公告条目');
  cards.each((_,el)=>{
   const card=$(el),messageId=card.attr('data-tweet-id'),text=card.find('.log-item-text').text().trim(),publishedAt=card.find('[data-datetime]').first().attr('data-datetime'),url=card.find('a.log-item-link').attr('href');const observed=messageId?.startsWith('observed-');
   if(!messageId||!text||!publishedAt||!url||!/^https:\/\/x\.com\/thsottiaux\/status\/\d+$/.test(url)||(!observed&&!url.endsWith('/'+messageId))||!Number.isFinite(Date.parse(publishedAt)))throw new SourceStructureError('重置归档字段变化，已停止自动处理');
   const parentId=explicitParentId(card.attr('data-parent-id')??card.attr('data-in-reply-to-status-id'),card.find('a[rel="in-reply-to"]').attr('href'),messageId);
   const scheduledIndex=rows.findIndex(row=>row.messageId===messageId),scheduledReset=scheduledIndex>=0?rows[scheduledIndex].metadata?.scheduledReset:undefined;
   const row:Incoming={sourceId:source.id,messageId,parentId,text,url,publishedAt:new Date(publishedAt).toISOString(),collectedAt,contextComplete:!observed&&!parentId&&hasStandaloneContext(text,'reset'),provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'reset',summary:text,...(scheduledReset?{scheduledReset}:{})}};
   if(scheduledIndex>=0)rows[scheduledIndex]=row;else rows.push(row);
  });
 } else {
  const cards=$('.challenge-entry');if(!cards.length)throw new SourceStructureError('活动归档结构变化：找不到活动条目');
  cards.each((_,el)=>{
   const card=$(el),link=card.find('.challenge-entry-title a').first(),url=link.attr('href'),text=card.children('p').text().trim(),title=link.text().trim();if(!url||!text||!title)throw new SourceStructureError('活动归档字段缺失');
   const match=url.match(/^https:\/\/x\.com\/thsottiaux\/status\/(\d+)$/);if(!match)return;
   const messageId=match[1];let publishedAt:string;try{publishedAt=new Date(Number((BigInt(messageId)>>22n)+1288834974657n)).toISOString();}catch{throw new SourceStructureError('活动原帖编号无有效时间');}
   const row=card.closest('.challenge-row'),day=Number(row.find('.challenge-row-date span').first().text().match(/\d+/)?.[0]);
   const dayDate=row.find('.challenge-row-date time[datetime]').first().attr('datetime');
   const validDay=Number.isSafeInteger(day)&&day>0&&(!activity||(day<=activity.days&&dayDate===new Date(Date.parse(activity.startsOn)+(day-1)*86400_000).toISOString().slice(0,10)));
   const parentId=explicitParentId(card.attr('data-parent-id')??card.attr('data-in-reply-to-status-id'),card.find('a[rel="in-reply-to"]').attr('href'),messageId);
   const category=card.hasClass('challenge-entry--improvement')?'product':'reset';
   rows.push({sourceId:source.id,messageId,parentId,url,text,publishedAt,collectedAt,contextComplete:!parentId&&hasStandaloneContext(text,category),provenance:'archive',textOrigin:'archive_excerpt',metadata:{title,summary:text,category,sourceGroup:'codex-resets',...(activity?{activity}:{}),...(validDay?{activityDay:day}:{}),...(/banked|储备|重置卡/i.test(card.closest('.challenge-group').find('.challenge-badge').first().text())?{benefitKind:'banked_reset' as const}:{})},activityDay:validDay?day:undefined});
  });
 }
 if(rows.length<1)throw new SourceStructureError('来源缺少可核对记录');return rows;
}
export function parseStatus(raw:string,source:Source,collectedAt=now()):Incoming[] {
 let data;try{data=JSON.parse(raw);}catch{throw new SourceStructureError('状态页未返回有效结构');}
 if(!Array.isArray(data.incidents))throw new SourceStructureError('状态页缺少事件列表');const rows:Incoming[]=[];
 for(const incident of data.incidents){
  if(!incident.id||!Array.isArray(incident.incident_updates))throw new SourceStructureError('状态页事件结构变化');
  const updates=incident.incident_updates;const relevant=/codex/i.test(`${incident.name} ${updates.map((u:{body?:string})=>u.body).join(' ')}`);if(!relevant)continue;
  for(const update of updates){if(!update.id||typeof update.body!=='string'||!Number.isFinite(Date.parse(update.created_at)))throw new SourceStructureError('状态页进展字段变化');rows.push({sourceId:source.id,messageId:update.id,parentId:incident.id,url:`https://status.openai.com/incidents/${incident.id}`,text:update.body,publishedAt:new Date(update.created_at).toISOString(),collectedAt,contextComplete:true,provenance:'official',textOrigin:'structured',metadata:{title:incident.name,category:'product',sourceGroup:'openai-status',status:typeof update.status==='string'?update.status:undefined}});}
 }
 return rows;
}
export function parseReleases(raw:string,source:Source,collectedAt=now()):Incoming[] {
 let data:unknown;try{data=JSON.parse(raw);}catch{throw new SourceStructureError('官方版本页未返回有效结构');}
 if(!data||typeof data!=='object')throw new SourceStructureError('官方版本页缺少发布记录');
 const records=Array.isArray(data)?data:[data],rows:Incoming[]=[];
 for(const item of records){
  if(!item||typeof item!=='object'||typeof item.draft!=='boolean'||typeof item.prerelease!=='boolean')throw new SourceStructureError('官方版本状态字段变化');
  if(item.draft||item.prerelease)continue;
  if(!Number.isSafeInteger(item.id)||typeof item.tag_name!=='string'||typeof item.html_url!=='string'||!/^https:\/\/github\.com\/openai\/codex\/releases\/tag\/[^/?#]+$/.test(item.html_url)||typeof item.body!=='string'||!Number.isFinite(Date.parse(item.published_at)))throw new SourceStructureError('官方版本发布字段变化');
  if(item.body.length>100_000)throw new SourceStructureError('官方版本说明超出长度上限');
  rows.push({sourceId:source.id,messageId:`release:${item.id}`,url:item.html_url,text:item.body.trim()||`版本标签：${item.tag_name}`,publishedAt:new Date(item.published_at).toISOString(),collectedAt,contextComplete:true,provenance:'official',textOrigin:'structured',metadata:{title:typeof item.name==='string'?item.name:item.tag_name,category:'product',sourceGroup:'openai-codex-releases',versionTag:item.tag_name}});
 }
 return rows;
}
export function isHistoricalRecord(publishedAt:string,historical=false,currentTime=Date.now()):boolean {
 return historical||currentTime-Date.parse(publishedAt)>24*3600_000;
}
/** First page is always revisited; a persisted page checkpoint bounds each catch-up batch. */
export async function fetchReleasePages(source:Source,fetcher:typeof fetch=fetch,dependencies:SourceReadDependencies={}):Promise<{records:Incoming[];scan:NonNullable<Source['releaseScan']>;httpCheckpoints?:Record<string,SourceHttpCheckpoint>;unchanged?:boolean}> {
 const context=readContext({...dependencies,fetcher},source);
 const checkpoint=source.releaseScan,baseline=checkpoint?.baseline??source.cursor;
 const stopBefore=baseline&&Number.isFinite(Date.parse(baseline))?Date.parse(baseline)-RELEASE_LOOKBACK_MS:Date.now()-RELEASE_LOOKBACK_MS;
 const pages=[1];if(checkpoint?.nextPage&&checkpoint.nextPage>1)for(let p=Math.max(2,checkpoint.nextPage-1);pages.length<MAX_RELEASE_PAGES;p++)pages.push(p);
 else for(let p=2;pages.length<MAX_RELEASE_PAGES;p++)pages.push(p);
 const records:Incoming[]=[],seen=new Set<string>();let newestAt=checkpoint?.newestAt??source.cursor,nextPage=1,complete=false;
 for(const page of pages){
  let raw:string;
  try{raw=await fetchAllowedURL(`https://api.github.com/repos/openai/codex/releases?per_page=${RELEASE_PAGE_SIZE}&page=${page}`,'application/vnd.github+json',context,'releases');}
  catch(error){if(!(error instanceof SourceUnchanged)||page!==1)throw error;return {records:[],scan:source.releaseScan??{nextPage:1},httpCheckpoints:context.checkpoints,unchanged:true};}
  let items:unknown;try{items=JSON.parse(raw);}catch{throw new SourceStructureError('官方版本列表未返回有效结构');}
  if(!Array.isArray(items))throw new SourceStructureError('官方版本接口没有返回分页列表');
  for(const row of parseReleases(raw,source)){if(!seen.has(row.messageId)){seen.add(row.messageId);records.push(row);}if(!newestAt||Date.parse(row.publishedAt)>Date.parse(newestAt))newestAt=row.publishedAt;}
  // An unchanged head can end a completed scan; tail pages must still be read.
  context.allowUnchanged=false;
  // Drafts can have no published_at, so use only valid timestamps for cursor termination.
  const times=items.map(item=>item&&typeof item==='object'&&'published_at'in item?Date.parse(String(item.published_at)):NaN).filter(Number.isFinite);
  const reachedBoundary=times.length>0&&Math.max(...times)<stopBefore;
  if(items.length<RELEASE_PAGE_SIZE||reachedBoundary){complete=true;nextPage=1;break;}
  nextPage=page+1;
 }
 return {records,scan:{nextPage,newestAt,baseline:complete?undefined:baseline,completedAt:complete?now():checkpoint?.completedAt},httpCheckpoints:context.checkpoints};
}
export async function fetchRecords(source:Source,validationOnly=false,dependencies:SourceReadDependencies={}):Promise<Incoming[]> {
 sourceReadCheckpoints.delete(source);
 if(source.id==='tibo-timeline')throw new SourceConfigurationError('收费采集已停用，请使用 Tibo 免费公开动态');
 if(!allowedSource(source))throw new DomainError('来源不在固定适配器允许名单');
 if(source.kind==='timeline'){
  timelineCheckpoints.delete(source);
  try{const result=await fetchTiboPublicTimeline(source,{validationOnly,onRequestEvent:async event=>{
   await transaction(c=>audit('worker',`source.request.${event.outcome}`,source.id,event.outcome==='recovered'?'免费来源请求在本次采集内恢复':'免费来源请求异常，保留诊断与重试记录',undefined,event,c));
  }});timelineCheckpoints.set(source,result);return result.records;}
  catch(error){if(error instanceof TiboTimelineError)throw timelineError(error);throw error;}
 }
 const onRequestEvent=async(event:SourceRequestEvent)=>{
  try{if(dependencies.onRequestEvent)await dependencies.onRequestEvent(event);else await transaction(c=>audit('worker',`source.request.${event.outcome}`,source.id,event.outcome==='recovered'?'来源请求在本次采集内恢复':'来源请求异常，保留安全诊断与重试记录',undefined,event,c));}
  catch{throw new SourceDiagnosticError('采集诊断记录暂不可用，停止本轮采集');}
 };
 const context=readContext({...dependencies,onRequestEvent,forceFullRead:validationOnly||dependencies.forceFullRead},source);
 if(source.kind==='releases'){const result=await fetchReleasePages(source,dependencies.fetcher??fetch,{...dependencies,onRequestEvent,forceFullRead:validationOnly||dependencies.forceFullRead});releaseCheckpoints.set(source.id,result.scan);sourceReadCheckpoints.set(source,{httpCheckpoints:result.httpCheckpoints??{},unchanged:result.unchanged===true});return result.records;}
 const referenceURL=referenceContentsURL(source);
 const url=referenceURL??(source.kind==='activity'?`${ARCHIVE_ORIGIN}/zh-CN/${challengePath(source.url)}`:source.url);
 let raw:string;
 try{try{raw=await fetchAllowedURL(url,referenceURL?'application/vnd.github.raw+json':undefined,context);}catch(error){
  if(referenceURL&&error instanceof SourceTransientError){raw=await fetchAllowedURL(source.url,undefined,context);}
  else {if(source.kind!=='activity'||!(error instanceof DomainError)||error.message!=='来源请求失败（状态 404）')throw error;raw=await fetchAllowedURL(`${ARCHIVE_ORIGIN}/${challengePath(source.url)}`,undefined,context);}
 }}
 catch(error){if(!(error instanceof SourceUnchanged)){if(referenceURL)console.warn('REFERENCE_SNAPSHOT_UNAVAILABLE',source.id,error instanceof SourceTransientError?'TRANSPORT':error instanceof SourceRateLimitError?'RATE_LIMIT':error instanceof SourceStructureError?'FORMAT':'REQUEST');throw error;}sourceReadCheckpoints.set(source,{httpCheckpoints:context.checkpoints,unchanged:true});return [];}
 sourceReadCheckpoints.set(source,{httpCheckpoints:context.checkpoints,unchanged:false});
 if(REFERENCE_SOURCES.some(item=>item.id===source.id)){try{const value=JSON.parse(raw),time=now();return source.id===REFERENCE_SIGNAL_SOURCE.id?parseReferenceSignals(value,time):source.id===REFERENCE_HISTORY_SOURCE.id?parseReferenceHistory(value,time):parseReferenceLatest(value,time);}catch{console.warn('REFERENCE_SNAPSHOT_UNAVAILABLE',source.id,'FORMAT');throw new SourceStructureError('REFERENCE_SNAPSHOT_INVALID');}}
 if(source.kind==='status')return parseStatus(raw,source);
 if(source.kind==='activity'){
  const $=load(raw);let clockScript='';
  if($('script[src="/challenge-clock.js"]').length){try{clockScript=await fetchAllowedURL(`${ARCHIVE_ORIGIN}/challenge-clock.js`,'text/javascript',context,'clock');}catch(error){if(error instanceof SourceDiagnosticError||error instanceof SourceRateLimitError)throw error;/* Missing ancillary zone leaves the activity definition incomplete, not fabricated. */}}
  return parseArchive(raw,source,now(),parseActivityDefinition(raw,url,clockScript));
 }
 return parseArchive(raw,source);
}
async function establishActivity(definition:ActivityDefinition):Promise<boolean> {
 return transaction(async c=>{
  const existing=await one<Activity>('activities',definition.id,c,true);
  if(existing){
   const changed=['title','timezone','startsOn','days','rules'].some(key=>existing[key as keyof ActivityDefinition]!==definition[key as keyof ActivityDefinition]);
   // An administrator's rules win; source text can continue arriving without silently changing them.
   if(changed){const manuallyChanged=(await list<{action:string;objectId:string;actor:string}>('audits',c)).some(a=>a.objectId===definition.id&&a.action==='activity.save'&&a.actor!=='worker');if(manuallyChanged)return false;
    await put('activities',{...existing,...definition,version:existing.version+1},c);await audit('worker','activity.discover',definition.id,'活动来源明确规则更新',existing,definition,c);
   }
   return true;
  }
  const created:Activity={...definition,version:1,items:[]};await put('activities',created,c);await audit('worker','activity.discover',definition.id,'允许来源提供了完整活动规则、日期和时区',undefined,definition,c);return true;
 });
}
async function discoverSources(source:Source):Promise<void> {
 if(source.id!=='reset-archive')return;
 const html=responseCache.get(source.url)?.body;if(!html)return;
 const existing=await list<Source>('sources');
 for(const url of discoverActivityLinks(html)){
  const slug=challengePath(url)!;if(existing.some(s=>s.kind==='activity'&&challengePath(s.url)===slug))continue;
  const proposed:Source={id:`activity-${hash(slug).slice(0,16)}`,name:'活动公开归档（辅助来源）',kind:'activity',url,enabled:true,validated:false,intervalMinutes:30,collectionPolicy:'adaptive',version:1,status:'unconnected',discoveredFrom:source.id};
  try{
   const records=await fetchRecords(proposed),definition=records.find(r=>r.metadata?.activity)?.metadata?.activity;
   if(definition)await establishActivity(definition);
   await transaction(async c=>{if(await one<Source>('sources',proposed.id,c,true))return;await put('sources',{...proposed,validated:true,status:'healthy',nextRunAt:now()},c);await audit('worker','source.discover',proposed.id,'允许来源发现了已支持结构的活动页面',undefined,{url,hasCompleteRules:!!definition},c);});
  }catch(error){
   await transaction(async c=>{
    if(await one<Source>('sources',proposed.id,c,true))return;
    const failed:Source={...proposed,publicationPaused:true,pauseReason:'structure',status:'failed',consecutiveFailures:1,nextRunAt:new Date(Date.now()+15*60_000).toISOString(),error:error instanceof DomainError?error.message:'新来源连接暂不可用'};
    await put('sources',failed,c);await audit('worker','source.discovery-deferred',proposed.id,'新活动页面尚未通过接入校验，低频探测并暂停发布',undefined,{url,error:failed.error},c);
   });
  }
 }
}
export async function validateSource(sourceId:string,actor:string) {
 if(sourceId===TIBO_PUBLIC_SOURCE.id)await transaction(async c=>{if(!await one<Source>('sources',sourceId,c,true))await put('sources',TIBO_PUBLIC_SOURCE,c);});
 const before=await one<Source>('sources',sourceId);if(!before)throw new DomainError('来源不存在');if(before.kind==='manual')return {validated:true,count:0};
 try{const records=await fetchRecords(before,true);const timeline=timelineCheckpoints.get(before);if(timeline?.interrupted){await transaction(async c=>{const source=await one<Source>('sources',sourceId,c,true);if(source)await put('sources',{...source,timelineScan:timeline.scan},c);});throw timelineError(timeline.interrupted);}await transaction(async c=>{const source=await one<Source>('sources',sourceId,c,true);if(!source)throw new DomainError('来源不存在');if(source.kind==='timeline'&&!timeline)throw new DomainError('免费动态验证断点缺失');
  // Samples are not saved as evidence, so validation cannot advance the cursor.
  const updated:Source={...source,...(timeline?{timelineScan:timeline.scan}:{}),validated:true,publicationPaused:false,pauseReason:undefined,consecutiveFailures:0,error:undefined,version:source.version+1,status:source.enabled?'healthy':'paused'};await put('sources',updated,c);if(sourceForecastConfiguration(source)!==sourceForecastConfiguration(updated))await markForecastInputsChanged(c);await audit(actor,'source.validate',sourceId,`适配器通过结构校验，取得 ${records.length} 条样本；持续可用性仍待运行`,undefined,{count:records.length},c);});return {validated:true,count:records.length};}
 catch(e){await transaction(async c=>{const s=await one<Source>('sources',sourceId,c,true);if(s){const waiting=e instanceof SourceRateLimitError||e instanceof TiboTimelineError&&e.failureKind==='transient';await put('sources',{...s,validated:waiting?s.validated:false,publicationPaused:waiting?s.publicationPaused:e instanceof SourceStructureError,pauseReason:waiting?s.pauseReason:e instanceof SourceStructureError?'structure':undefined,...(waiting?{nextRunAt:e instanceof SourceRateLimitError?e.retryAt:new Date(Date.now()+60_000).toISOString()}:{}),status:'failed',error:e instanceof DomainError?e.message:'来源连接失败',version:s.version+1},c);}});throw e;}
}
export async function collectSource(sourceId:string,historical=false):Promise<{seen:number;created:number;healthChanged?:boolean}> {
 const source=await one<Source>('sources',sourceId);if(!source||(!source.validated&&!(source.enabled&&source.publicationPaused&&source.pauseReason==='structure')))throw new DomainError('来源未验证');
 if(!source.enabled)throw new DomainError('来源已由管理员暂停');
 const records=await fetchRecords(source,false,{forceFullRead:historical}),timeline=source.kind==='timeline'?timelineCheckpoints.get(source):undefined;
 const read=sourceReadCheckpoints.get(source),fingerprint=incomingFingerprint(records),unchanged=!historical&&(read?.unchanged===true||source.collectionFingerprint===fingerprint);
 let created=0,healthChanged=false;
 for(const raw of unchanged?[]:records){
  const {activityDay,...incoming}=raw;const definition=incoming.metadata?.activity;
  const activityAllowed=definition?await establishActivity(definition):true;
  const result=await createEvidence({...incoming,historical:isHistoricalRecord(incoming.publishedAt,historical)||REFERENCE_SOURCES.some(item=>item.id===source.id)&&!source.lastSuccessAt});
  if(result.created&&result.candidate){
   created++;
   if(definition&&(!activityAllowed||activityDay&&activityDay<=definition.days))await transaction(async c=>{
    const current=await one<typeof result.candidate>('candidates',result.candidate!.id,c,true);if(!current||current.humanEdited||current.status!=='pending')return;
    if(activityAllowed){await put('candidates',{...current,content:{...current.content,category:'activity',activityId:definition.id,activityDay}},c);return;}
    const context=gatherEvidenceContext(result.evidence,await list<Evidence>('evidence',c));
    await put('candidates',{...current,reasons:[...current.reasons,'活动来源规则与人工修改冲突，请核对'],content:{...current.content,activityId:undefined,activityDay:undefined},automation:{state:'conflict',reasonCodes:['activity_rules_conflict'],dependencyIds:[],inputFingerprint:evidenceFingerprint(context),evaluatedAt:now()}},c);
   });
  }
 }
 if(!unchanged)await discoverSources(source);
 const time=now(),scan=releaseCheckpoints.get(source.id);
 await transaction(async c=>{
  const current=await one<Source>('sources',sourceId,c,true);
  if(current){const latest=records.length?records.reduce((a,b)=>Date.parse(a.publishedAt)>Date.parse(b.publishedAt)?a:b).publishedAt:current.cursor;
   const cursor=scan?(scan.nextPage===1?scan.newestAt:current.cursor):(!current.cursor||latest&&Date.parse(latest)>Date.parse(current.cursor)?latest:current.cursor);
   const waiting=timeline&&!timeline.headRead;
   const hasActiveIncident=current.kind==='status'&&!read?.unchanged?hasOpenCodexIncident(records):current.hasActiveIncident;
   const schedule=sourceCollectionSchedule({...current,hasActiveIncident});
   healthChanged=!waiting&&(current.status!==(current.enabled?'healthy':'paused')||!current.validated||current.publicationPaused===true);
   const updated:Source={...current,...schedule,hasActiveIncident,validated:waiting?current.validated:true,publicationPaused:waiting?current.publicationPaused:false,pauseReason:waiting?current.pauseReason:undefined,consecutiveFailures:waiting?current.consecutiveFailures:0,status:current.enabled?'healthy':'paused',error:waiting?current.error:undefined,lastSuccessAt:waiting?current.lastSuccessAt:time,cursor,releaseScan:scan??current.releaseScan,timelineScan:timeline?.scan??current.timelineScan,httpCheckpoints:read?.httpCheckpoints??current.httpCheckpoints,collectionFingerprint:read?.unchanged?current.collectionFingerprint:fingerprint,version:current.version+1};
   await put('sources',{...updated,nextRunAt:sourceNextCollectionAt(updated)},c);
  }
  if(!unchanged||healthChanged)await audit('worker','source.collect',sourceId,`读取 ${records.length} 条，新增 ${created} 条；${timeline?.interrupted?'已保留成功读取的部分，后续读取等待恢复':'保留旧条目回看以发现编辑'}`,undefined,{seen:records.length,created,historical,pipeline:{transportComplete:!timeline?.interrupted,evidenceStored:created,classification:'candidate_queue',publication:'separate_audit',notification:'separate_delivery_records'},releaseScan:scan,partial:!!timeline?.interrupted},c);
 });
 if(timeline?.interrupted)throw timelineError(timeline.interrupted);
 return {seen:records.length,created,healthChanged};
}
