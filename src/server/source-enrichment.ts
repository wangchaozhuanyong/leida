import { load } from 'cheerio';
import type { Evidence } from '../lib/types';
import { hasStandaloneContext, isTruncatedText } from './source-context';

const attempts=new Map<string,{checkedAt:number;evidence?:Evidence;retryAt?:number}>();
const quoteLinks=new Map<string,{checkedAt:number;identity?:ReturnType<typeof knownPostIdentity>;retryAt?:number}>();
const ATTEMPT_INTERVAL_MS=15*60_000;
const MAX_OEMBED_BYTES=80_000;
const MAX_QUOTE_LINKS=4;

/** Known public announcement URLs only; never request account pages or arbitrary URLs. */
export function knownPostIdentity(url:string):{account:string;messageId:string;url:string}|undefined {
 try{
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||!['x.com','twitter.com'].includes(parsed.hostname)||parsed.port||parsed.username||parsed.password)return undefined;
  const match=parsed.pathname.match(/^\/thsottiaux\/status\/(\d+)\/?$/i);if(!match)return undefined;
  return {account:'thsottiaux',messageId:match[1],url:`https://x.com/thsottiaux/status/${match[1]}`};
 }catch{return undefined;}
}
export function parseEmbeddedEvidence(data:unknown,evidence:Evidence,collectedAt=new Date().toISOString()):Evidence|undefined {
 const post=knownPostIdentity(evidence.url);
 if(!post||evidence.provenance==='manual'||!data||typeof data!=='object'||!('html'in data)||typeof data.html!=='string'||data.html.length>MAX_OEMBED_BYTES)return undefined;
 if('author_url'in data&&typeof data.author_url==='string'&&!/^https:\/\/(?:x|twitter)\.com\/thsottiaux\/?$/i.test(data.author_url))return undefined;
 const $=load(data.html);const quote=$('blockquote.twitter-tweet').first();if(!quote.length)return undefined;
 const identityLinks=quote.find('a[href]').map((_,element)=>knownPostIdentity($(element).attr('href')??'')).get().filter(Boolean);
 if(!identityLinks.some(identity=>identity.messageId===post.messageId))return undefined;
 const body=quote.find('p').first().clone();body.find('br').replaceWith('\n');body.find('script,style').remove();
 const text=body.text().trim();if(text.length<2||text.length>30_000||isTruncatedText(text))return undefined;
 // It is the known post's text, not proof of a reply relationship or of eligibility inherited from another post.
 const category=evidence.metadata?.category==='product'?'product':'reset';
 const contextComplete=!evidence.parentId&&hasStandaloneContext(text,category);
 if(evidence.textOrigin==='original'&&evidence.text===text&&evidence.contextComplete===contextComplete)return undefined;
 return {...evidence,url:post.url,text,textOrigin:'original',contextComplete,collectedAt};
}
export function allowedEmbedRedirect(location:string,requestURL:URL):URL|undefined {
 try{
  const next=new URL(location,requestURL);
  if(next.protocol!=='https:'||!['publish.twitter.com','publish.x.com'].includes(next.hostname)||next.port||next.username||next.password||next.pathname!=='/oembed'||next.hash)return undefined;
  const normalized=(url:URL)=>JSON.stringify([...url.searchParams.entries()].sort(([a,av],[b,bv])=>a.localeCompare(b)||av.localeCompare(bv)));
  if(normalized(next)!==normalized(requestURL))return undefined;
  return next;
 }catch{return undefined;}
}

async function boundedJSON(response:Response):Promise<unknown> {
 const length=Number(response.headers.get('content-length')??0);if(length>MAX_OEMBED_BYTES)return undefined;
 const reader=response.body?.getReader();if(!reader)return undefined;const chunks:Uint8Array[]=[];let total=0;
 while(true){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>MAX_OEMBED_BYTES){await reader.cancel();return undefined;}chunks.push(value);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return undefined;}
}
/** Pure fetch enrichment: the worker saves returned evidence through createEvidence. */
export async function enrichKnownEvidence(evidence:Evidence,fetcher:typeof fetch=fetch):Promise<Evidence|undefined> {
 const post=knownPostIdentity(evidence.url);if(!post||evidence.provenance==='manual')return undefined;
 const currentTime=Date.now(),cached=fetcher===fetch?attempts.get(post.url):undefined;
 if(cached&&currentTime<Math.max(cached.checkedAt+ATTEMPT_INTERVAL_MS,cached.retryAt??0)) {
  const enriched=cached.evidence;
  return enriched&&evidence.textOrigin!=='original'?{...enriched,id:evidence.id,hash:evidence.hash,sourceId:evidence.sourceId,messageId:evidence.messageId,historical:evidence.historical,metadata:evidence.metadata,parentId:evidence.parentId,contextComplete:!evidence.parentId&&hasStandaloneContext(enriched.text,evidence.metadata?.category==='product'?'product':'reset')}:undefined;
 }
 if(fetcher===fetch&&!attempts.has(post.url)&&attempts.size>=500)attempts.delete(attempts.keys().next().value!);
 const requestURL=new URL('https://publish.twitter.com/oembed');requestURL.searchParams.set('url',post.url);requestURL.searchParams.set('omit_script','true');requestURL.searchParams.set('dnt','true');
 try{
  const init:RequestInit={signal:AbortSignal.timeout(10_000),redirect:'manual',headers:{Accept:'application/json','User-Agent':'MoyaoResetRadar/1.0'}};
  let response=await fetcher(requestURL,init);
  if([301,302,303,307,308].includes(response.status)){
   const redirected=allowedEmbedRedirect(response.headers.get('location')??'',requestURL);if(!redirected)return undefined;
   response=await fetcher(redirected,init);
  }
  if(response.status===429){const retry=Number(response.headers.get('retry-after'));if(fetcher===fetch)attempts.set(post.url,{checkedAt:currentTime,retryAt:currentTime+(Number.isFinite(retry)?Math.max(retry,900)*1000:3600_000)});return undefined;}
  const enriched=response.ok?parseEmbeddedEvidence(await boundedJSON(response),evidence):undefined;
  if(fetcher===fetch)attempts.set(post.url,{checkedAt:currentTime,evidence:enriched});
  return enriched;
 }catch{if(fetcher===fetch)attempts.set(post.url,{checkedAt:currentTime});return undefined;}
}

function explicitShortLinks(text:string):string[] {
 const result=new Set<string>();
 for(const match of text.matchAll(/https:\/\/t\.co\/[^\s<>"'`]+/g)){
  try{
   const url=new URL(match[0].replace(/[.,;:!?\)\]\}，。；：！？）】》]+$/u,''));
   if(url.protocol!=='https:'||url.hostname!=='t.co'||url.port||url.username||url.password||url.search||url.hash||!/^\/[A-Za-z0-9]{1,64}$/.test(url.pathname))continue;
   result.add(url.href);
  }catch { /* Only literal, exact HTTPS short links in the original body qualify. */ }
 }
 return [...result];
}
function snowflakeTime(messageId:string):string|undefined {
 if(!/^\d{1,20}$/.test(messageId))return;
 try{
  const id=BigInt(messageId);if(id<=0n||id>0xffffffffffffffffn)return;
  const time=Number((id>>22n)+1288834974657n);
  return Number.isSafeInteger(time)?new Date(time).toISOString():undefined;
 }catch {return;}
}
async function quotedIdentity(url:string,fetcher:typeof fetch):Promise<ReturnType<typeof knownPostIdentity>> {
 const currentTime=Date.now(),cached=fetcher===fetch?quoteLinks.get(url):undefined;
 if(cached&&currentTime<Math.max(cached.checkedAt+ATTEMPT_INTERVAL_MS,cached.retryAt??0))return cached.identity;
 if(fetcher===fetch&&!quoteLinks.has(url)&&quoteLinks.size>=500)quoteLinks.delete(quoteLinks.keys().next().value!);
 let identity:ReturnType<typeof knownPostIdentity>,retryAt:number|undefined;
 try{
  const response=await fetcher(url,{signal:AbortSignal.timeout(10_000),redirect:'manual',headers:{Accept:'text/html','User-Agent':'MoyaoResetRadar/1.0'}});
  if([301,302,303,307,308].includes(response.status))identity=knownPostIdentity(response.headers.get('location')??'');
  if(response.status===429){const seconds=Number(response.headers.get('retry-after'));retryAt=currentTime+(Number.isFinite(seconds)?Math.max(seconds,900)*1000:3600_000);}
  await response.body?.cancel();
 }catch { /* Never follow a short link's unvalidated target or synthesize context. */ }
 if(fetcher===fetch)quoteLinks.set(url,{checkedAt:currentTime,identity,retryAt});
 return identity;
}

/**
 * Fetch at most one layer of an explicitly related same-author reset post.
 * Returns [parent evidence prototype, child original with explicit parentId].
 * The caller persists through createEvidence, which assigns immutable id/hash.
 * No relationship comes from timing/title similarity, and no DB write occurs.
 */
export async function enrichQuotedResetContext(evidence:Evidence,available:Evidence[],fetcher:typeof fetch=fetch):Promise<Evidence[]> {
 const childIdentity=knownPostIdentity(evidence.url);
 if(!childIdentity||evidence.provenance==='manual'||!snowflakeTime(childIdentity.messageId))return [];
 try{
  const enriched=await enrichKnownEvidence(evidence,fetcher);
  const child=enriched??(evidence.textOrigin==='original'&&!isTruncatedText(evidence.text)?evidence:undefined);
  if(!child)return [];
  const links=explicitShortLinks(child.text);
  if(links.length>MAX_QUOTE_LINKS)return [];
  const targets=new Map<string,NonNullable<ReturnType<typeof knownPostIdentity>>>();
  if(!links.length&&evidence.parentId){
   const target=knownPostIdentity(`https://x.com/${childIdentity.account}/status/${evidence.parentId}`);
   if(!target||!snowflakeTime(target.messageId)||BigInt(target.messageId)>=BigInt(childIdentity.messageId))return [];
   targets.set(target.messageId,target);
  }
  for(const link of links){
   const target=await quotedIdentity(link,fetcher);
   if(!target||target.account!==childIdentity.account||!snowflakeTime(target.messageId)||BigInt(target.messageId)>=BigInt(childIdentity.messageId))return [];
   targets.set(target.messageId,target);
  }
  if(targets.size!==1)return [];
  const target=[...targets.values()][0];
  if(evidence.parentId&&evidence.parentId!==target.messageId)return [];
  const publishedAt=snowflakeTime(target.messageId)!;
  const metadata=evidence.metadata?{...(evidence.metadata.sourceGroup?{sourceGroup:evidence.metadata.sourceGroup}:{}),category:'reset' as const}:undefined;
  const prototype:Evidence={id:`${evidence.id}:quoted:${target.messageId}`,hash:'',sourceId:evidence.sourceId,messageId:target.messageId,url:target.url,text:'',publishedAt,collectedAt:new Date().toISOString(),contextComplete:false,historical:true,provenance:evidence.provenance,textOrigin:'archive_excerpt',metadata};
  const existing=available.filter(item=>item.sourceId===evidence.sourceId&&item.provenance!=='manual'&&item.textOrigin==='original'&&item.contextComplete&&item.messageId===target.messageId&&knownPostIdentity(item.url)?.messageId===target.messageId&&hasStandaloneContext(item.text,'reset')).sort((a,b)=>b.collectedAt.localeCompare(a.collectedAt)||b.id.localeCompare(a.id))[0];
  const original=existing??await enrichKnownEvidence(prototype,fetcher);
  if(!original||original.textOrigin!=='original'||isTruncatedText(original.text))return [];
  // A previously verified same-author record retains its own source, clock,
  // eligibility and schedule. Only a newly fetched prototype uses thin metadata.
  const parent:Evidence=existing?{...existing}:{...prototype,text:original.text,textOrigin:'original',contextComplete:hasStandaloneContext(original.text,'reset')};
  return [parent,{...child,parentId:target.messageId,contextComplete:false,collectedAt:new Date().toISOString()}];
 }catch {return [];}
}
