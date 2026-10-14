import { lockTransaction } from '../db';
import {z} from 'zod';
import {one,put,insert,transaction,type Client} from '../db';
import type {Source,TiboSettings,TiboTimelineScan,Evidence} from '../lib/types';
import {DomainError,assertVersion,id,now} from './domain';
import {encryptKey,decryptKey} from './ai';
import {hasStandaloneContext} from './source-context';

export const TIBO_SOURCE:Source={id:'tibo-timeline',name:'Tibo 官方动态直采',kind:'timeline',url:'https://x.com/thsottiaux',enabled:false,validated:false,intervalMinutes:1,version:1,status:'unconnected'};
export const defaultTibo:TiboSettings={hasKey:false,version:1,dailyRequestLimit:0};
type TiboRecord=TiboSettings&{id:'tibo';encryptedKey?:string};
type Incoming=Omit<Evidence,'id'|'hash'|'historical'>;
type ObjectValue=Record<string,unknown>;
const object=(value:unknown):ObjectValue|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:undefined;
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value);
const higher=(a:string|undefined,b:string|undefined):string|undefined=>!a?b:!b?a:BigInt(a)>BigInt(b)?a:b;
export class TiboTimelineError extends DomainError {
 constructor(message:string,public failureKind:'configuration'|'structure'|'transient'|'rate_limit',public retryAt?:string){super(message,failureKind==='rate_limit'?429:400);}
}
function settingsView(value:TiboRecord):TiboSettings{return {hasKey:!!value.encryptedKey,version:value.version,dailyRequestLimit:value.dailyRequestLimit,testedAt:value.testedAt};}
const usageId=(timestamp:number)=>'tibo-usage-'+new Date(timestamp).toISOString().slice(0,10);
export async function adminTibo():Promise<TiboSettings>{
 const value=await one<TiboRecord>('settings','tibo')??{...defaultTibo,id:'tibo' as const};
 const usage=await one<{requests:number}>('settings',usageId(Date.now()));
 return {...settingsView(value),requestsToday:usage?.requests??0};
}
export async function saveTiboSettings(input:Record<string,unknown>,actor:string):Promise<TiboSettings>{
 const parsed=z.object({version:z.number().int().positive(),dailyRequestLimit:z.number().int().min(0).max(5000),key:z.string().max(4096).optional()}).parse(input);
 return transaction(async c=>{
  await lockTransaction(c,'radar_tibo_settings');
  const previous=await one<TiboRecord>('settings','tibo',c,true)??{...defaultTibo,id:'tibo' as const};assertVersion(previous,parsed.version);
  const token=parsed.key?.trim();if(token&&/\s/.test(token))throw new DomainError('请填写不含空格的 Bearer Token');
  const changed=!!token;
  const next:TiboRecord={id:'tibo',version:previous.version+1,dailyRequestLimit:parsed.dailyRequestLimit,encryptedKey:token?encryptKey(token):previous.encryptedKey,hasKey:!!(token||previous.encryptedKey),testedAt:changed?undefined:previous.testedAt};
  await put('settings',next,c);
  const source=await one<Source>('sources',TIBO_SOURCE.id,c,true);
  if(!source)await insert('sources',TIBO_SOURCE,c);
  else if(changed||!next.dailyRequestLimit)await put('sources',{...source,enabled:false,validated:false,publicationPaused:false,pauseReason:undefined,status:'unconnected',error:undefined,version:source.version+1},c);
  await insert('audits',{id:id('audit'),actor,action:'settings.tibo',objectId:TIBO_SOURCE.id,reason:'保存 Tibo 直采凭据与每日请求上限；未发起外部调用',createdAt:now(),after:settingsView(next)},c);
  return settingsView(next);
 });
}
export async function markTiboTested(version:number,client:Client):Promise<void>{
 const current=await one<TiboRecord>('settings','tibo',client,true);assertVersion(current,version);
 await put('settings',{...current!,testedAt:now()},client);
}
function nextUTCDay(clock:number){return new Date(Math.floor(clock/86400_000)*86400_000+86400_000).toISOString();}
async function requestAccess():Promise<{bearerToken:string;version:number;beforeRequest:()=>Promise<void>}>{
 const settings=await one<TiboRecord>('settings','tibo');
 if(!settings?.encryptedKey||!settings.dailyRequestLimit)throw new TiboTimelineError('Tibo 直采未配置有效凭据和每日请求上限','configuration');
 let bearerToken:string;try{bearerToken=decryptKey(settings.encryptedKey);}catch{throw new TiboTimelineError('Tibo 凭据无法解密，请检查服务端配置','configuration');}
 return {bearerToken,version:settings.version,beforeRequest:()=>transaction(async c=>{
  await lockTransaction(c,'radar_tibo_settings');
  const current=await one<TiboRecord>('settings','tibo',c,true);
  if(!current?.encryptedKey||current.version!==settings.version||!current.dailyRequestLimit)throw new TiboTimelineError('Tibo 配置已变化，请重新执行','configuration');
  const clock=Date.now(),key=usageId(clock),usage=await one<{id:string;requests:number}>('settings',key,c,true)??{id:key,requests:0};
  if(usage.requests>=current.dailyRequestLimit)throw new TiboTimelineError('今日 Tibo 请求上限已达，次日 UTC 00:00 后恢复','rate_limit',nextUTCDay(clock));
  // Count failed and timed-out attempts too; never retry outside the saved cap.
  await put('settings',{...usage,requests:usage.requests+1},c);
 })};
}
export interface TiboAccess {bearerToken:string;version:number;beforeRequest:()=>Promise<void>;}
export interface TiboDependencies {fetcher?:typeof fetch;clock?:()=>number;access?:()=>Promise<TiboAccess>;validationOnly?:boolean;}
export interface TiboBatch {records:Incoming[];scan:TiboTimelineScan;settingsVersion:number;headRead:boolean;interrupted?:TiboTimelineError;}
async function readAPI(path:string,params:URLSearchParams,access:TiboAccess,fetcher:typeof fetch,allowReferenceErrors=false):Promise<ObjectValue>{
 // All paths are constructed below from validated IDs; credentials never follow redirects.
 const url=new URL(path,'https://api.x.com');url.search=params.toString();
 await access.beforeRequest();
 let response:Response;try{response=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15_000),headers:{Authorization:`Bearer ${access.bearerToken}`,Accept:'application/json','User-Agent':'MoyaoResetRadar/1.0'}});}catch{throw new TiboTimelineError('X 官方接口暂时连接失败，将按计划重试','transient');}
 if(response.status===429){const header=response.headers.get('retry-after'),seconds=Number(header),reset=Number(response.headers.get('x-rate-limit-reset'))*1000;const ms=header?(Number.isFinite(seconds)?Date.now()+seconds*1000:Date.parse(header)):0;throw new TiboTimelineError('X 官方接口限流，等待服务器允许时间后重试','rate_limit',new Date(Math.max(Date.now()+60_000,Number.isFinite(ms)&&ms<8.64e15?ms:0,Number.isFinite(reset)&&reset<8.64e15?reset:0)).toISOString());}
 if([401,402,403].includes(response.status))throw new TiboTimelineError(response.status===402?'X 读取额度不足，请在开发者控制台检查；采集已停止':'X 凭据无效或缺少读取权限；采集已停止','configuration');
 if(!response.ok)throw new TiboTimelineError(`X 官方接口请求失败（状态 ${response.status}）`,response.status>=500?'transient':'configuration');
 const reader=response.body?.getReader();if(!reader)throw new TiboTimelineError('X 接口响应为空','structure');
 const chunks:Uint8Array[]=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>3_000_000){await reader.cancel();throw new TiboTimelineError('X 接口响应超出上限','structure');}chunks.push(value);}}catch(error){if(error instanceof TiboTimelineError)throw error;throw new TiboTimelineError('X 接口响应读取中断，将按计划重试','transient');}
 let data:unknown;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new TiboTimelineError('X 接口未返回有效 JSON','structure');}
 const result=object(data);if(!result)throw new TiboTimelineError('X 接口返回结构无效','structure');
 if(!allowReferenceErrors&&result.errors!==undefined&&(!Array.isArray(result.errors)||result.errors.length))throw new TiboTimelineError('X 接口返回部分失败，保留原游标等待重试','structure');
 return result;
}
export function parseTiboPage(data:unknown,userId:string,collectedAt:string):{records:Incoming[];nextToken?:string;newestId?:string}{
 if(!validId(userId)||!Number.isFinite(Date.parse(collectedAt)))throw new TiboTimelineError('Tibo 身份或采集时间无效','structure');
 const root=object(data),meta=object(root?.meta),includes=object(root?.includes);
 if(!root||!meta||!Number.isSafeInteger(meta.result_count)||Number(meta.result_count)<0)throw new TiboTimelineError('X 动态列表结构无效或存在部分失败','structure');
 const posts=root.data??[];if(!Array.isArray(posts)||posts.length!==meta.result_count)throw new TiboTimelineError('X 动态数量与返回记录不一致','structure');
 const ownIds=new Set(posts.map(item=>object(item)?.id));
 const references=new Set(posts.flatMap(item=>{const post=object(item),refs=post?.referenced_posts??post?.referenced_tweets;return Array.isArray(refs)?refs.map(ref=>object(ref)?.id):[];}));
 // A deleted/unreadable expansion is a missing context, not a missing timeline
 // post. Only explicitly requested reference failures may keep the primary row.
 if(root.errors!==undefined&&(!Array.isArray(root.errors)||root.errors.some(item=>{const error=object(item);return !error||!validId(error.resource_id)||ownIds.has(error.resource_id)||!references.has(error.resource_id)||!['tweet','post'].includes(String(error.resource_type))||!['https://api.x.com/2/problems/resource-not-found','https://api.twitter.com/2/problems/resource-not-found','https://api.x.com/2/problems/not-authorized-for-resource','https://api.twitter.com/2/problems/not-authorized-for-resource'].includes(String(error.type));})))throw new TiboTimelineError('X 动态存在未确认的部分失败，保留原游标','structure');
 const users=includes?.users;if(posts.length&&(!Array.isArray(users)||!users.some(item=>{const user=object(item);return user?.id===userId&&user.username==='thsottiaux'&&user.protected!==true;})))throw new TiboTimelineError('X 动态作者身份未通过核对','structure');
 const nextToken=meta.next_token;if(nextToken!==undefined&&(typeof nextToken!=='string'||!nextToken||nextToken.length>4096||/[\s\x00-\x1f]/.test(nextToken)))throw new TiboTimelineError('X 分页标识无效','structure');
 const included=includes?.tweets??includes?.posts??[];if(!Array.isArray(included))throw new TiboTimelineError('X 父帖结构无效','structure');
 const records:Incoming[]=[],seen=new Set<string>();let newestId:string|undefined;
 for(const [index,raw] of [...posts,...included].entries()){
  const post=object(raw),primary=index<posts.length;
  if(!post||!validId(post.id))throw new TiboTimelineError('X 帖子编号缺失','structure');
  if(primary&&post.author_id!==userId)throw new TiboTimelineError('X 动态包含其他作者，停止自动处理','structure');
  if(!primary&&post.author_id!==userId)continue;
  if(primary)newestId=higher(newestId,post.id);
  if(seen.has(post.id))continue;seen.add(post.id);
  const note=object(post.note_post??post.note_tweet),text=note?.text??post.text;
  const date=post.created_at;
  if(typeof text!=='string'||!text.trim()||text.length>12000||typeof date!=='string'||!Number.isFinite(Date.parse(date))||Date.parse(date)>Date.parse(collectedAt)+5*60_000||post.withheld)throw new TiboTimelineError('X 原帖正文或时间不完整','structure');
  const refs=post.referenced_posts??post.referenced_tweets??[];
  if(!Array.isArray(refs)||refs.some(ref=>!object(ref)||!validId(object(ref)!.id)||!['retweeted','replied_to','quoted'].includes(String(object(ref)!.type))))throw new TiboTimelineError('X 原帖关联结构无效','structure');
  if(refs.some(ref=>object(ref)!.type==='retweeted'))continue;
  const messageId=post.id,parents=[...new Set(refs.filter(ref=>['replied_to','quoted'].includes(String(object(ref)!.type))).map(ref=>object(ref)!.id as string))];
  // A post referring to several distinct posts cannot choose a referent automatically.
  if(parents.some(parent=>BigInt(parent)>=BigInt(messageId)))throw new TiboTimelineError('X 原帖父关系无效','structure');
  const parentId=parents.length===1?parents[0]:undefined,category=hasStandaloneContext(text,'reset')||/reset|banked|quota|重置|额度/i.test(text)?'reset' as const:'product' as const;
  records.push({sourceId:TIBO_SOURCE.id,messageId,url:`https://x.com/thsottiaux/status/${messageId}`,text:text.trim(),parentId,publishedAt:new Date(date).toISOString(),collectedAt,provenance:'official',textOrigin:'original',contextComplete:hasStandaloneContext(text,category),metadata:{sourceGroup:'x-api:thsottiaux',category}});
 }
 if(meta.newest_id!==undefined&&(!validId(meta.newest_id)||meta.newest_id!==newestId))throw new TiboTimelineError('X 动态最高编号不一致','structure');
 return {records:records.sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt)),nextToken:nextToken as string|undefined,newestId};
}
function postParams(){return new URLSearchParams({'post.fields':'created_at,text,note_post,withheld',expansions:'author_id,referenced_posts','user.fields':'username,protected',max_results:'100',exclude:'retweets'});}
/** Revisit the head while finishing a bounded persisted catch-up scan. Only its
 * original upper bound is committed, so a fresh burst cannot skip an unseen page. */
export async function fetchTiboTimeline(source:Source,dependencies:TiboDependencies={}):Promise<TiboBatch>{
 // Historical adapter is retained for offline fixtures only. Live paid reads are disabled.
 if(!dependencies.access)throw new TiboTimelineError('收费采集已停用，请使用免费公开动态','configuration');
 if(source.id!==TIBO_SOURCE.id||source.kind!=='timeline'||source.url!==TIBO_SOURCE.url)throw new TiboTimelineError('Tibo 直采只支持已核对的固定用户','configuration');
 const access=await (dependencies.access??requestAccess)(),fetcher=dependencies.fetcher??fetch,clock=(dependencies.clock??Date.now)();
 let scan=source.timelineScan;
 if(scan&&(!validId(scan.userId)||scan.sinceId!==undefined&&!validId(scan.sinceId)||scan.pendingNewestId!==undefined&&!validId(scan.pendingNewestId)||scan.startTime!==undefined&&!Number.isFinite(Date.parse(scan.startTime))||scan.nextToken!==undefined&&(typeof scan.nextToken!=='string'||!scan.nextToken||scan.nextToken.length>4096)))throw new TiboTimelineError('Tibo 保存的分页断点无效','structure');
 if(!scan){const lookup=await readAPI('/2/users/by/username/thsottiaux',new URLSearchParams({'user.fields':'username,protected'}),access,fetcher),user=object(lookup.data);if(!user||!validId(user.id)||user.username!=='thsottiaux'||user.protected!==false)throw new TiboTimelineError('Tibo 公开用户身份核对失败','structure');scan={userId:user.id,startTime:new Date(clock-24*3600_000).toISOString()};}
 const params=postParams();if(scan.sinceId)params.set('since_id',scan.sinceId);else params.set('start_time',scan.startTime??new Date(clock-24*3600_000).toISOString());
 const at=new Date(clock).toISOString();
 // After a limited cycle, spend the next available request on its saved tail.
 // Otherwise a daily cap of one would read the head forever without catching up.
 if(scan.nextToken&&scan.preferTail&&!dependencies.validationOnly){
  const tailParams=new URLSearchParams(params);tailParams.set('pagination_token',scan.nextToken);
  try{const tail=parseTiboPage(await readAPI(`/2/users/${scan.userId}/tweets`,tailParams,access,fetcher,true),scan.userId,at);if(tail.nextToken===scan.nextToken)throw new TiboTimelineError('X 分页标识重复，保留断点','structure');
   const next:TiboTimelineScan=tail.nextToken?{...scan,nextToken:tail.nextToken,preferTail:false}:{userId:scan.userId,sinceId:higher(scan.sinceId,scan.pendingNewestId),...(!higher(scan.sinceId,scan.pendingNewestId)?{startTime:scan.startTime}:{})};
   return {records:tail.records,scan:next,settingsVersion:access.version,headRead:true};
  }catch(error){if(!(error instanceof TiboTimelineError))throw error;const expired=error.failureKind==='configuration'&&error.message==='X 官方接口请求失败（状态 400）';return {records:[],scan:expired?{userId:scan.userId,sinceId:scan.sinceId,startTime:scan.startTime}:scan,settingsVersion:access.version,headRead:false,interrupted:expired?new TiboTimelineError('X 分页断点已失效，重新扫描原范围','rate_limit',new Date(clock+60_000).toISOString()):error};}
 }
 let head:ReturnType<typeof parseTiboPage>;
 try{head=parseTiboPage(await readAPI(`/2/users/${scan.userId}/tweets`,params,access,fetcher,true),scan.userId,at);}catch(error){if(!(error instanceof TiboTimelineError))throw error;return {records:[],scan,settingsVersion:access.version,headRead:false,interrupted:error};}
 if(dependencies.validationOnly)return {records:head.records,scan,settingsVersion:access.version,headRead:true};
 const result=new Map(head.records.map(record=>[record.messageId,record]));
 const pending=scan.nextToken?scan.pendingNewestId:head.newestId;
 let nextToken=scan.nextToken??head.nextToken;
 if(nextToken){
  const tailParams=new URLSearchParams(params);tailParams.set('pagination_token',nextToken);
  try{const tail=parseTiboPage(await readAPI(`/2/users/${scan.userId}/tweets`,tailParams,access,fetcher,true),scan.userId,at);for(const record of tail.records)result.set(record.messageId,record);if(tail.nextToken===nextToken)throw new TiboTimelineError('X 分页标识重复，保留断点','structure');nextToken=tail.nextToken;}
  catch(error){if(!(error instanceof TiboTimelineError))throw error;
   // A successful head must survive a later quota or pagination failure. A
   // token-specific 400 restarts the same baseline; no unseen IDs are skipped.
   const expired=error.failureKind==='configuration'&&error.message==='X 官方接口请求失败（状态 400）';
   const interrupted=expired?new TiboTimelineError('X 分页断点已失效，保留新帖并重新扫描原范围','rate_limit',new Date(clock+60_000).toISOString()):error;
   return {records:[...result.values()],scan:expired?{userId:scan.userId,sinceId:scan.sinceId,startTime:scan.startTime}:{...scan,nextToken,pendingNewestId:pending,preferTail:true},settingsVersion:access.version,headRead:true,interrupted};
  }
 }
 const next:TiboTimelineScan=nextToken?{...scan,nextToken,pendingNewestId:pending}:{userId:scan.userId,sinceId:higher(scan.sinceId,pending),...(!higher(scan.sinceId,pending)?{startTime:scan.startTime}:{})};
 return {records:[...result.values()].sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt)),scan:next,settingsVersion:access.version,headRead:true};
}
