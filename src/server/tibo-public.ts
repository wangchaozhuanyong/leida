import type {Evidence,Source,TiboTimelineScan} from '../lib/types';
import {hasStandaloneContext} from './source-context';
import {TiboTimelineError} from './tibo-timeline';
import {randomUUID} from 'node:crypto';

export const TIBO_PUBLIC_SOURCE:Source={id:'tibo-public',name:'Tibo 公开动态（免费）',kind:'timeline',url:'https://api.fxtwitter.com/2/profile/thsottiaux/statuses',enabled:false,validated:false,intervalMinutes:10,collectionPolicy:'adaptive',version:1,status:'unconnected'};
const USER_ID='1953337039510003712',LOOKBACK=24*3600_000,PARENT_RETRY_MS=15*60_000;
type Incoming=Omit<Evidence,'id'|'hash'|'historical'>;
type Obj=Record<string,unknown>;
const obj=(value:unknown):Obj|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Obj:undefined;
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value);
const higher=(a:string|undefined,b:string|undefined)=>!a?b:!b?a:BigInt(a)>BigInt(b)?a:b;
const validToken=(value:unknown):value is string=>typeof value==='string'&&!!value&&value.length<=4096&&!/[\s\x00-\x1f]/.test(value);
const sourceTime=(id:string)=>Number((BigInt(id)>>22n)+1288834974657n);
const ownURL=(url:unknown,id:string)=>typeof url==='string'&&new RegExp(`^https://(?:x|twitter)\\.com/thsottiaux/status/${id}$`).test(url);
export interface TiboPublicBatch {records:Incoming[];scan:TiboTimelineScan;headRead:boolean;interrupted?:TiboTimelineError;}
export interface TiboRequestEvent {
 requestId:string;phase:'head'|'tail'|'parents';attempt:number;outcome:'failed'|'recovered';
 elapsedMs:number;reason?:'http'|'upstream'|'network'|'body'|'format';
 status?:number;transportCode?:string;retryInMs?:number;
}
export interface TiboPublicDependencies {fetcher?:typeof fetch;clock?:()=>number;validationOnly?:boolean;sleep?:(milliseconds:number)=>Promise<void>;onRequestEvent?:(event:TiboRequestEvent)=>Promise<void>;}
interface Page {records:Incoming[];newestId?:string;oldestId?:string;nextToken?:string;}

/** FxEmbed is a public third-party relay. Preserve its attribution; never label
 * this response as the official X API or use its interpretation as reset facts. */
export function parseTiboPublicPage(value:unknown,collectedAt:string):Page {
 const root=obj(value),cursor=obj(root?.cursor),at=Date.parse(collectedAt);
 if(!root||root.code!==200||!Array.isArray(root.results)||root.results.length>200||!Number.isFinite(at)||!cursor)throw new TiboTimelineError('免费动态接口结构变化，暂停发布并等待恢复','structure');
 const next=cursor.bottom;if(next!==undefined&&next!==null&&next!==''&&!validToken(next))throw new TiboTimelineError('免费动态分页标识无效','structure');
 const records=new Map<string,Incoming>();let newestId:string|undefined,oldestId:string|undefined;
 const visit=(raw:unknown,primary:boolean,depth=0):void=>{
  const post=obj(raw),author=obj(post?.author);
  if(!post||post.type!=='status'||!validId(post.id))throw new TiboTimelineError('免费动态原帖编号或结构缺失','structure');
  if(!author||typeof author.screen_name!=='string'||!validId(author.id))throw new TiboTimelineError('免费动态作者身份缺失，停止自动处理','structure');
  // Reply timelines include other participants' conversation context. They are
  // never Tibo evidence. A conflicting handle or user ID still fails closed.
  if(author.screen_name!=='thsottiaux'&&author.id!==USER_ID)return;
  if(author.screen_name!=='thsottiaux'||author.id!==USER_ID||author.protected!==false)throw new TiboTimelineError('免费动态作者身份不一致，停止自动处理','structure');
  if(post.provider!=='twitter'||!ownURL(post.url,post.id))throw new TiboTimelineError('免费动态原帖地址与作者不一致','structure');
  if(post.reposted_by)return;
  const rawText=obj(post.raw_text)?.text,text=rawText??post.text,date=Date.parse(String(post.created_at)),seconds=post.created_timestamp;
  if(typeof text!=='string'||!text.trim()||text.length>12000||!Number.isFinite(date)||typeof seconds!=='number'||!Number.isSafeInteger(seconds)||Math.abs(date-seconds*1000)>1000||Math.abs(date-sourceTime(post.id))>1000||date>at+5*60_000)throw new TiboTimelineError('免费动态正文或原帖时间无法核对','structure');
  if(primary){newestId=higher(newestId,post.id);oldestId=!oldestId||BigInt(post.id)<BigInt(oldestId)?post.id:oldestId;}
  const parentIds=new Set<string>(),reply=obj(post.replying_to),quote=obj(post.quote);
  if(reply?.screen_name==='thsottiaux'){if(!validId(reply.status)||!ownURL(reply.url,reply.status))throw new TiboTimelineError('免费动态回复关系不完整','structure');parentIds.add(reply.status);}
  if(quote?.type==='status'&&obj(quote.author)?.screen_name==='thsottiaux'){if(!validId(quote.id)||!ownURL(quote.url,quote.id))throw new TiboTimelineError('免费动态引用关系不完整','structure');parentIds.add(quote.id);}
  const messageId=post.id;
  if([...parentIds].some(id=>BigInt(id)>=BigInt(messageId)))throw new TiboTimelineError('免费动态父帖关系异常','structure');
  const category=hasStandaloneContext(text,'reset')||/reset|banked|quota|重置|额度/i.test(text)?'reset' as const:'product' as const;
  const parentId:string|undefined=parentIds.size===1?[...parentIds][0]:undefined;
  const record:Incoming={sourceId:TIBO_PUBLIC_SOURCE.id,messageId:post.id,url:`https://x.com/thsottiaux/status/${post.id}`,text:text.trim(),publishedAt:new Date(date).toISOString(),collectedAt,provenance:'archive',textOrigin:'original',contextComplete:hasStandaloneContext(text,category),parentId,metadata:{sourceGroup:'fxembed:thsottiaux',category}};
  const previous=records.get(post.id);
  // Embedded quote snapshots can omit a reply reference. The primary row has
  // the full relation; conflicting explicit parents fail rather than overwrite.
  if(previous&&(previous.text!==record.text||previous.publishedAt!==record.publishedAt||previous.parentId&&parentId&&previous.parentId!==parentId))throw new TiboTimelineError('免费动态同帖内容存在冲突，等待核对','structure');
  records.set(post.id,{...record,parentId:previous?.parentId??parentId});
  if(quote?.type==='status'&&depth<8)visit(quote,false,depth+1);
 };
 for(const raw of root.results)visit(raw,true);
 return {records:[...records.values()].sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt)),newestId,oldestId,nextToken:validToken(next)?next:undefined};
}

class PublicRequestError extends TiboTimelineError {
 constructor(message:string,kind:TiboTimelineError['failureKind'],public detail:Pick<TiboRequestEvent,'reason'|'status'|'transportCode'>,retryAt?:string){super(message,kind,retryAt);}
}
// Whitelist codes only: provider messages, URLs, headers, cursors and bodies must
// never reach diagnostics. Keep unknown network errors explicitly unknown.
function transportCode(error:unknown):string {
 const value=obj(error),cause=obj(value?.cause);
 const known=['ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE'];
 const code=cause?.code??value?.code;
 return typeof code==='string'&&known.includes(code)?code:value?.name==='TimeoutError'?'TIMEOUT':value?.name==='AbortError'?'ABORTED':'UNKNOWN';
}
export {transportCode as safeSourceTransportCode};
async function readPageOnce(url:URL,fetcher:typeof fetch):Promise<unknown|undefined>{
 let response:Response;try{response=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20_000),headers:{Accept:'application/json','User-Agent':'MoyaoResetRadar/1.0 (+public-source-collector)'}});}catch(error){throw new PublicRequestError('免费动态接口暂时连接失败，将自动重试','transient',{reason:'network',transportCode:transportCode(error)});}
 const retry=response.headers.get('retry-after'),seconds=Number(retry),ms=retry?(Number.isFinite(seconds)?Date.now()+seconds*1000:Date.parse(retry)):0;
 const retryAt=Number.isFinite(ms)&&ms<8.64e15?ms:0;
 if(response.status===429||!response.ok&&retryAt>Date.now()){await response.body?.cancel();throw new PublicRequestError('免费动态接口要求等待，按来源允许时间恢复','rate_limit',{reason:'http',status:response.status},new Date(Math.max(Date.now()+120_000,retryAt)).toISOString());}
 if(response.status===204)return undefined;
 if(!response.ok){await response.body?.cancel();throw new PublicRequestError(`免费动态接口暂不可用（状态 ${response.status}）`,[404,408,425].includes(response.status)||response.status>=500?'transient':'configuration',{reason:'http',status:response.status});}
 const reader=response.body?.getReader();if(!reader)throw new TiboTimelineError('免费动态接口响应为空','structure');
 let size=0;const chunks:Uint8Array[]=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>3_000_000){await reader.cancel();throw new TiboTimelineError('免费动态响应超出上限','structure');}chunks.push(value);}}catch(error){if(error instanceof TiboTimelineError)throw error;throw new PublicRequestError('免费动态响应读取中断，将自动重试','transient',{reason:'body',transportCode:transportCode(error)});}finally{reader.releaseLock();}
 let result:unknown;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new TiboTimelineError('免费动态接口未返回有效 JSON','structure');}
 const code=obj(result)?.code;if(code!==200){if(code===429)throw new PublicRequestError('免费动态接口要求降低频率','rate_limit',{reason:'upstream',status:429},new Date(Date.now()+120_000).toISOString());throw new PublicRequestError('免费动态接口上游读取失败，将自动重试',[400,401,402,403].includes(Number(code))?'configuration':'transient',{reason:'upstream',...(typeof code==='number'&&Number.isInteger(code)&&code>=100&&code<=599?{status:code}:{})});}
 return result;
}

export async function fetchTiboPublicTimeline(source:Source,dependencies:TiboPublicDependencies={}):Promise<TiboPublicBatch>{
 if(source.id!==TIBO_PUBLIC_SOURCE.id||source.kind!=='timeline'||source.url!==TIBO_PUBLIC_SOURCE.url)throw new TiboTimelineError('免费动态采集只支持已核对的固定公开来源','configuration');
 const clock=(dependencies.clock??Date.now)(),fetcher=dependencies.fetcher??fetch;
 // Two normal pages plus at most two extra requests: <= 80 s of network waits
 // + 3.5 s backoff, below the worker's 120 s lease. Both pages share the budget.
 let retriesRemaining=2;
 const sleep=dependencies.sleep??(milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)));
 const readPage=async(url:URL,phase:TiboRequestEvent['phase'])=>{
  const requestId=randomUUID();
  for(let attempt=1;;attempt++){
   const started=performance.now();let value:unknown;
   try{value=await readPageOnce(url,fetcher);}
   catch(error){
    if(!(error instanceof TiboTimelineError))throw error;
    const retry=error.failureKind==='transient'&&retriesRemaining>0;
    const retryInMs=retry?(retriesRemaining===2?1000:2500):undefined;
    await dependencies.onRequestEvent?.({requestId,phase,attempt,outcome:'failed',elapsedMs:Math.round(performance.now()-started),...(error instanceof PublicRequestError?error.detail:{reason:'format' as const}),...(retryInMs?{retryInMs}:{})});
    if(!retry)throw error;
    retriesRemaining--;await sleep(retryInMs!);continue;
   }
   if(attempt>1)await dependencies.onRequestEvent?.({requestId,phase,attempt,outcome:'recovered',elapsedMs:Math.round(performance.now()-started)});
   return value;
  }
 };
 const scan=source.timelineScan??{userId:USER_ID,startTime:new Date(clock-LOOKBACK).toISOString()};
 if(scan.userId!==USER_ID||scan.sinceId!==undefined&&!validId(scan.sinceId)||scan.pendingNewestId!==undefined&&!validId(scan.pendingNewestId)||scan.startTime!==undefined&&!Number.isFinite(Date.parse(scan.startTime))||scan.parentRetryAt!==undefined&&!Number.isFinite(Date.parse(scan.parentRetryAt))||scan.nextToken!==undefined&&!validToken(scan.nextToken)||scan.pendingParentIds!==undefined&&(!Array.isArray(scan.pendingParentIds)||scan.pendingParentIds.length>200||scan.pendingParentIds.some(id=>!validId(id))))throw new TiboTimelineError('免费动态保存的分页断点无效','structure');
 const baseline=scan.sinceId?sourceTime(scan.sinceId):Date.parse(scan.startTime??new Date(clock-LOOKBACK).toISOString());
 // Historical dependency scans start only after the current range has been
 // committed, so their pending bound equals sinceId. They never take priority
 // over the normal head when a tail read needs another retry.
 const parentContinuation=!!scan.nextToken&&!!scan.parentRetryAt&&scan.pendingNewestId===scan.sinceId;
 const pageURL=(token?:string,parents?:string[])=>{const url=new URL(TIBO_PUBLIC_SOURCE.url);url.searchParams.set('count','100');url.searchParams.set('with_replies','true');if(token)url.searchParams.set('cursor',token);else url.searchParams.set('since',String(Math.max(0,Math.floor((parents?.length?Math.min(...parents.map(sourceTime)):baseline)/1000)-1)));return url;};
 const read=async(token?:string,parents?:string[])=>{const value=await readPage(pageURL(token,parents),token?'tail':parents?.length?'parents':'head');if(value===undefined&&token)throw new TiboTimelineError('免费动态尾页没有返回分页结果，保留断点重试','structure');return value===undefined?{records:[]} as Page:parseTiboPublicPage(value,new Date((dependencies.clock??Date.now)()).toISOString());};
 // Timelines can include older pinned or conversation rows among new posts.
 // One old row cannot prove that an entire remaining page is behind the cursor.
 const boundary=(page:Page,parents:string[])=>!parents.length&&!!page.newestId&&(scan.sinceId?BigInt(page.newestId)<=BigInt(scan.sinceId):sourceTime(page.newestId)<=baseline);
 const neededParents=scan.pendingParentIds??[];
 // Select after combining pages: an explicitly related old parent may be on a
 // later page. Keep only those ancestors, rather than unrelated historical rows.
 const select=(pool:Incoming[],replayedHeadIds=new Set<string>())=>{
  const available=new Map(pool.map(row=>[row.messageId,row]));
  const wanted=new Map(pool.filter(row=>neededParents.includes(row.messageId)||(scan.sinceId?BigInt(row.messageId)>BigInt(scan.sinceId):Date.parse(row.publishedAt)>=baseline)).map(row=>[row.messageId,row]));
  const obligations=[...wanted.values()].filter(row=>!replayedHeadIds.has(row.messageId)||neededParents.includes(row.messageId));
  const missing=new Set(neededParents.filter(id=>!available.has(id)));
  for(const row of wanted.values())if(row.parentId){const parent=available.get(row.parentId);if(parent)wanted.set(parent.messageId,parent);}
  // The pending upper bound's old head was already saved before continuation.
  // Do not recreate fulfilled dependencies when that head is replayed; new
  // messages and newly found ancestors still traverse their entire parent chain.
  const checked=new Set<string>();
  for(const row of obligations){if(checked.has(row.messageId))continue;checked.add(row.messageId);if(row.parentId){const parent=available.get(row.parentId);if(parent)obligations.push(parent);else missing.add(row.parentId);}}
  if(missing.size>200)throw new TiboTimelineError('免费动态待补父帖超出扫描上限，保留断点等待核对','structure');
  return {records:[...wanted.values()].sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt)),parents:[...missing]};
 };
 const withParents=(checkpoint:TiboTimelineScan,parents:string[]):TiboTimelineScan=>{
  const {pendingParentIds:_parents,...rest}=checkpoint;
  // Keep [] during continuation to distinguish tracked scans from older saved
  // checkpoints whose already-read head still needs its dependencies recovered.
  return {...rest,pendingParentIds:parents};
 };
 const finished=(pending:string|undefined,parents:string[],probed=false):TiboTimelineScan=>{
  const sinceId=higher(scan.sinceId,pending);
  return {userId:USER_ID,sinceId,...(!sinceId?{startTime:scan.startTime}:{}),...(parents.length?{pendingParentIds:parents,parentRetryAt:probed||scan.nextToken||!scan.parentRetryAt?new Date(clock+PARENT_RETRY_MS).toISOString():scan.parentRetryAt}:{})};
 };
 const combine=(first:Incoming[],second:Incoming[])=>{const rows=new Map(first.map(row=>[row.messageId,row]));for(const row of second){const previous=rows.get(row.messageId);if(previous&&(previous.text!==row.text||previous.publishedAt!==row.publishedAt||previous.parentId&&row.parentId&&previous.parentId!==row.parentId))throw new TiboTimelineError('免费动态跨页同帖内容存在冲突，保留断点等待核对','structure');rows.set(row.messageId,{...row,parentId:previous?.parentId??row.parentId});}return [...rows.values()];};
 const reset=(error:TiboTimelineError,parents=neededParents):TiboPublicBatch=>{const expired=error.failureKind==='configuration';return {records:[],scan:expired?{userId:USER_ID,sinceId:scan.sinceId,startTime:scan.startTime,...(parents.length?{pendingParentIds:parents,parentRetryAt:new Date(clock+PARENT_RETRY_MS).toISOString()}:{})}:scan,headRead:false,interrupted:expired?new TiboTimelineError('免费动态分页已失效，从原范围重新扫描','rate_limit',new Date(clock+120_000).toISOString()):error};};
 if(scan.nextToken&&scan.preferTail&&!parentContinuation&&!dependencies.validationOnly){try{const tail=await read(scan.nextToken);if(tail.nextToken===scan.nextToken)throw new TiboTimelineError('免费动态分页标识重复','structure');const selected=select(tail.records),next=boundary(tail,selected.parents)?undefined:tail.nextToken,pending=scan.pendingNewestId??tail.newestId;return {records:selected.records,headRead:true,scan:next?withParents({...scan,nextToken:next,pendingNewestId:pending,preferTail:false},selected.parents):finished(pending,selected.parents)};}catch(error){if(!(error instanceof TiboTimelineError))throw error;return reset(error);}}
 let head:Page;try{head=await read();}catch(error){if(!(error instanceof TiboTimelineError))throw error;return {records:[],scan,headRead:false,interrupted:error};}
 const replayedHeadIds=new Set(scan.nextToken&&scan.pendingNewestId&&scan.pendingParentIds!==undefined?head.records.filter(row=>BigInt(row.messageId)<=BigInt(scan.pendingNewestId!)).map(row=>row.messageId):[]);
 let selected=select(head.records,replayedHeadIds);
 if(dependencies.validationOnly)return {records:selected.records,scan,headRead:true};
 if(parentContinuation&&scan.preferTail&&Date.parse(scan.parentRetryAt!)>clock)return {records:selected.records,scan:withParents(scan,selected.parents),headRead:true};
 let pending=scan.nextToken?scan.pendingNewestId:head.newestId,token=scan.nextToken??(boundary(head,selected.parents)?undefined:head.nextToken);
 if(token){try{const tail=await read(token);if(tail.nextToken===token||tail.nextToken&&tail.nextToken===head.nextToken)throw new TiboTimelineError('免费动态分页标识循环，保留断点等待恢复','structure');selected=select(combine(head.records,tail.records),replayedHeadIds);pending??=tail.newestId;token=boundary(tail,selected.parents)?undefined:tail.nextToken;}catch(error){if(!(error instanceof TiboTimelineError))throw error;
  if(parentContinuation&&error.failureKind==='transient')return {records:selected.records,headRead:true,scan:withParents({...scan,preferTail:true,parentRetryAt:new Date(clock+PARENT_RETRY_MS).toISOString()},selected.parents)};
  const failed=reset(error,selected.parents);return {...failed,records:selected.records,headRead:true,scan:error.failureKind==='configuration'?failed.scan:withParents({...scan,nextToken:token,pendingNewestId:pending,preferTail:true},selected.parents)};}}
 else if(selected.parents.length&&scan.pendingParentIds?.length&&(!scan.parentRetryAt||Date.parse(scan.parentRetryAt)<=clock)){
  // A successful current head does not prove absent old ancestors cannot later
  // reappear. Retry only their explicit range at low frequency, after new posts.
  const retryAt=new Date(clock+PARENT_RETRY_MS).toISOString();
  try{
   const parents=await read(undefined,selected.parents);
   selected=select(combine(head.records,parents.records),replayedHeadIds);
   token=boundary(parents,selected.parents)?undefined:parents.nextToken;
   const checkpoint=finished(pending,selected.parents,true);
   return {records:selected.records,headRead:true,scan:token?withParents({...checkpoint,nextToken:token,pendingNewestId:checkpoint.sinceId,parentRetryAt:retryAt},selected.parents):checkpoint};
  }catch(error){
   if(!(error instanceof TiboTimelineError))throw error;
   const checkpoint={...finished(pending,selected.parents,true),parentRetryAt:retryAt};
   // A temporary historical probe failure cannot suppress verified new posts.
   // Rate limits and structural conflicts still use the existing fail-closed path.
   return {records:selected.records,headRead:true,scan:error.failureKind==='transient'?checkpoint:withParents({...scan,parentRetryAt:retryAt},selected.parents),...(error.failureKind==='transient'?{}:{interrupted:error})};
  }
 }
 const next:TiboTimelineScan=token?withParents({...scan,nextToken:token,pendingNewestId:pending},selected.parents):finished(pending,selected.parents);
 return {records:selected.records,scan:next,headRead:true};
}
