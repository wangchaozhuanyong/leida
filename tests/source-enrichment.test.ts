import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichQuotedResetContext} from '../src/server/source-enrichment';
import {gatherEvidenceContext,hasCompleteContext} from '../src/server/source-context';
import type {Evidence} from '../src/lib/types';

const childId='2108040921044639779',parentId='2107800000000000000',otherParentId='2107600000000000000';
const childUrl=`https://x.com/thsottiaux/status/${childId}`,parentUrl=`https://x.com/thsottiaux/status/${parentId}`;
const at='2026-10-11T04:00:00.000Z';
const parentText='We will load a banked reset for all paid accounts.';
const body='Confirmed landed across all accounts. https://t.co/resetParent';
function evidence(extra:Partial<Evidence>={}):Evidence{return {id:'child-evidence',hash:'child-hash',sourceId:'reset-archive',messageId:childId,url:childUrl,text:'已确认落地。',publishedAt:'2026-10-08T03:44:55.000Z',collectedAt:at,contextComplete:false,historical:false,provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'reset',title:'child-only-title',summary:'child-only-summary',benefitKind:'automatic_reset',activityDay:4,status:'child-only-status',versionTag:'child-only-version',scheduledReset:{expectedAt:'2026-10-11T07:00:00.000Z',kind:'automatic_reset',sourceUrl:'https://codex-resets.com/zh-CN'}},...extra};}
function embed(text:string,id:string){return {author_url:'https://twitter.com/thsottiaux',html:`<blockquote class="twitter-tweet"><p>${text}</p>— Tibo <a href="https://twitter.com/thsottiaux/status/${id}">日期</a></blockquote>`};}
function fetcherFor(options:{childText?:string;parentText?:string;location?:string;fail?:'child'|'short'|'parent'}={},calls:string[]=[]):typeof fetch {
 return async(input,init)=>{
  const url=new URL(String(input));calls.push(url.href);assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).has('cookie'),false);
  if(url.hostname==='t.co'){
   if(options.fail==='short')throw new Error('short link failed');
   return new Response('',{status:302,headers:{location:options.location??parentUrl}});
  }
  assert.equal(url.hostname,'publish.twitter.com');assert.equal(url.pathname,'/oembed');
  const post=new URL(url.searchParams.get('url')!);const id=post.pathname.split('/').at(-1)!;
  if(options.fail==='child'&&id===childId||options.fail==='parent'&&id===parentId)throw new Error('oEmbed failed');
  return new Response(JSON.stringify(embed(id===childId?options.childText??body:options.parentText??parentText,id)));
 };
}

test('引用短链只读Location后获取同作者父帖原文，返回明确上下文但不继承child专属metadata',async()=>{
 const input=evidence(),before=structuredClone(input),calls:string[]=[];
 const [parent,child]=await enrichQuotedResetContext(input,[],fetcherFor({},calls));
 assert.equal(calls.length,3);assert.equal(new URL(calls[1]).hostname,'t.co');assert.equal(parent.url,parentUrl);assert.equal(parent.messageId,parentId);assert.equal(parent.sourceId,input.sourceId);assert.equal(parent.text,parentText);assert.equal(parent.textOrigin,'original');assert.equal(parent.provenance,'archive');assert.equal(parent.contextComplete,true);assert.equal(parent.historical,true);
 assert.equal(parent.publishedAt,new Date(Number((BigInt(parentId)>>22n)+1288834974657n)).toISOString());assert.deepEqual(parent.metadata,{sourceGroup:'codex-resets',category:'reset'});assert.equal(parent.parentId,undefined);
 assert.equal(child.text,body);assert.equal(child.parentId,parentId);assert.equal(child.contextComplete,false);assert.equal(child.metadata?.scheduledReset?.expectedAt,input.metadata?.scheduledReset?.expectedAt);assert.deepEqual(input,before);
 assert.equal(hasCompleteContext(child,gatherEvidenceContext(child,[parent,child])),true);
});

test('已有可信完整original父帖可复用，不重新请求父oEmbed，仍核child原文和短链',async()=>{
 const parent=evidence({id:'trusted-parent',hash:'parent-hash',sourceId:'reset-archive',messageId:parentId,url:parentUrl,text:parentText,textOrigin:'original',contextComplete:true,historical:false,publishedAt:'2026-10-07T11:47:33.000Z',metadata:{sourceGroup:'codex-resets',category:'activity',title:'parent-only-title',summary:parentText,activityDay:6,benefitKind:'banked_reset',scheduledReset:{expectedAt:'2026-10-08T07:00:00.000Z',kind:'banked_reset',sourceUrl:'https://codex-resets.com/zh-CN'}}}),before=structuredClone(parent),calls:string[]=[];
 const result=await enrichQuotedResetContext(evidence({text:body,textOrigin:'original'}),[parent],fetcherFor({},calls));
 assert.equal(calls.length,2);assert.deepEqual(result[0],before);assert.deepEqual(parent,before);assert.equal(result[0].historical,false);assert.equal(result[0].sourceId,'reset-archive');assert.equal(result[0].metadata?.scheduledReset?.kind,'banked_reset');assert.equal(result[1].parentId,parentId);
});

test('无明确t.co正文引用不推断上下文、不读取任意URL',async()=>{
 for(const text of ['Confirmed landed across all accounts.','Confirmed landed. https://x.com/thsottiaux/status/2107800000000000000','Confirmed landed. https://t.co.evil.invalid/resetParent','Confirmed landed. http://t.co/resetParent','Confirmed landed. https://t.co/resetParent?private=1']){
  const calls:string[]=[];assert.deepEqual(await enrichQuotedResetContext(evidence(),[],fetcherFor({childText:text},calls)),[]);assert.equal(calls.length,1,text);
 }
 assert.deepEqual(await enrichQuotedResetContext(evidence({provenance:'manual'}),[],async()=>{throw new Error('must not fetch manual');}),[]);
 assert.deepEqual(await enrichQuotedResetContext(evidence({url:'https://evil.invalid/post'}),[],async()=>{throw new Error('must not fetch arbitrary child');}),[]);
});

test('不跟随私有地址、跨作者、同帖、未来帖或short-link再跳转',async()=>{
 for(const location of ['http://127.0.0.1:5190/private','https://10.0.0.1/private',`https://x.com/other/status/${parentId}`,childUrl,'https://x.com/thsottiaux/status/2109000000000000000','https://t.co/anotherHop',`https://x.com.evil.invalid/thsottiaux/status/${parentId}`,`https://x.com:444/thsottiaux/status/${parentId}`]){
  const calls:string[]=[];assert.deepEqual(await enrichQuotedResetContext(evidence(),[],fetcherFor({location},calls)),[]);assert.equal(calls.length,2,location);assert.equal(new URL(calls[1]).hostname,'t.co');
 }
});

test('多个不同引用父帖冲突安全返回空，同一目标重复短链可归一化',async()=>{
 const text='Confirmed landed. https://t.co/firstParent https://t.co/secondParent';
 let calls=0;
 const ambiguous:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(init?.redirect,'manual');calls++;
  if(url.hostname==='t.co')return new Response('',{status:302,headers:{location:`https://x.com/thsottiaux/status/${url.pathname.includes('first')?parentId:otherParentId}`}});
  return new Response(JSON.stringify(embed(text,childId)));
 };
 assert.deepEqual(await enrichQuotedResetContext(evidence(),[],ambiguous),[]);assert.equal(calls,3);
 const sameCalls:string[]=[];const same=await enrichQuotedResetContext(evidence(),[],fetcherFor({childText:text},sameCalls));assert.equal(same.length,2);assert.equal(same[1].parentId,parentId);assert.equal(sameCalls.length,4);
});

test('已有不同parentId不覆盖，网络失败或父原文不匹配不产生关系',async()=>{
 const calls:string[]=[];assert.deepEqual(await enrichQuotedResetContext(evidence({parentId:otherParentId}),[],fetcherFor({},calls)),[]);assert.equal(calls.length,2);
 for(const fail of ['child','short','parent'] as const)assert.deepEqual(await enrichQuotedResetContext(evidence(),[],fetcherFor({fail})),[]);
 const wrong:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(init?.redirect,'manual');
  if(url.hostname==='t.co')return new Response('',{status:302,headers:{location:parentUrl}});
  const child=url.searchParams.get('url')===childUrl;
  return new Response(JSON.stringify(embed(child?body:parentText,child?childId:otherParentId)));
 };
 assert.deepEqual(await enrichQuotedResetContext(evidence(),[],wrong),[]);
});

test('父帖正文不完整时只保留明确关系，不伪造资格或递归第二层',async()=>{
 const calls:string[]=[];const result=await enrichQuotedResetContext(evidence(),[],fetcherFor({parentText:'As promised, completed. https://t.co/grandparent'},calls));
 assert.equal(result.length,2);assert.equal(result[0].contextComplete,false);assert.equal(result[1].parentId,parentId);assert.equal(hasCompleteContext(result[1],result),false);assert.equal(calls.length,3);
});

test('归档已明示parentId但正文没有短链时读取同作者父原文，失败后可以重试',async()=>{
 const input=evidence({text:'Confirmed landed across all accounts.',textOrigin:'original',parentId}),before=structuredClone(input),calls:string[]=[];
 assert.deepEqual(await enrichQuotedResetContext(input,[],fetcherFor({childText:input.text,fail:'parent'},calls)),[]);
 const result=await enrichQuotedResetContext(input,[],fetcherFor({childText:input.text},calls));
 assert.equal(result.length,2);assert.equal(result[0].url,parentUrl);assert.equal(result[0].text,parentText);assert.equal(result[1].parentId,parentId);
 assert.equal(hasCompleteContext(result[1],gatherEvidenceContext(result[1],result)),true);assert.deepEqual(input,before);
 assert.equal(calls.some(url=>new URL(url).hostname==='t.co'),false);
});

test('明示父帖编号只能指向更早的有效原帖，不能构造任意地址或未来关系',async()=>{
 for(const invalid of [childId,'2109000000000000000','../private','https://evil.invalid/post','0','9'.repeat(30)]){
  const calls:string[]=[];
  assert.deepEqual(await enrichQuotedResetContext(evidence({text:'Confirmed landed.',textOrigin:'original',parentId:invalid}),[],fetcherFor({childText:'Confirmed landed.'},calls)),[]);
  assert.equal(calls.length,1,invalid);
 }
});

test('不信任人工父帖或旧archive excerpt，必须重新核对父官方原文',async()=>{
 for(const extra of [{provenance:'manual' as const,textOrigin:'original' as const},{provenance:'archive' as const,textOrigin:'archive_excerpt' as const}]){
  const old=evidence({...extra,id:'old-parent',messageId:parentId,url:parentUrl,text:'fake complete parent',contextComplete:true}),calls:string[]=[];
  const result=await enrichQuotedResetContext(evidence(),[old],fetcherFor({},calls));assert.equal(calls.length,3);assert.equal(result[0].text,parentText);assert.notEqual(result[0].id,old.id);
 }
});

test('不跨来源复用父原型，同作者原帖也须重新按child来源核原文',async()=>{
 const parent=evidence({id:'other-source-parent',sourceId:'activity-archive',messageId:parentId,url:parentUrl,text:parentText,textOrigin:'original',contextComplete:true}),before=structuredClone(parent),calls:string[]=[];
 const result=await enrichQuotedResetContext(evidence(),[parent],fetcherFor({},calls));
 assert.equal(calls.length,3);assert.equal(result[0].sourceId,'reset-archive');assert.notEqual(result[0].id,parent.id);assert.equal(result[0].metadata?.scheduledReset,undefined);assert.deepEqual(parent,before);
});

test('真实fetch路径缓存原文及已核短链，未落库重复运行仍可返回父子原型',async()=>{
 const originalFetch=globalThis.fetch,calls:string[]=[],mock=fetcherFor({},calls);
 globalThis.fetch=mock;
 try{
  const first=await enrichQuotedResetContext(evidence(),[]),second=await enrichQuotedResetContext(evidence(),[]);
  assert.equal(first.length,2);assert.equal(second.length,2);assert.equal(calls.length,3);assert.equal(second[0].messageId,parentId);assert.equal(second[0].text,parentText);assert.equal(second[0].textOrigin,'original');assert.equal(second[1].parentId,parentId);
 }finally {globalThis.fetch=originalFetch;}
});
