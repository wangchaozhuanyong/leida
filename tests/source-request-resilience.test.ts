import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchRecords,fetchReleasePages,sourceDefinitions,SourceRateLimitError,SourceStructureError,SourceTransientError,type SourceRequestEvent} from '../src/server/ingestion';

const source=(id:string)=>({...sourceDefinitions.find(s=>s.id===id)!,enabled:true,validated:true});
const status=source('official-status'),releases=source('official-releases'),activity=source('activity-archive');
const good=()=>new Response('{"incidents":[]}');
const network=()=>Object.assign(new Error('credentials and private URL must not be logged'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});

test('免费来源在同一地址有限重试网络与503，诊断只含安全字段',async()=>{
 const urls:string[]=[],delays:number[]=[],events:SourceRequestEvent[]=[];
 const records=await fetchRecords(status,false,{fetcher:async url=>{urls.push(String(url));if(urls.length===1)throw network();return urls.length===2?new Response('private response',{status:503}):good();},sleep:async ms=>{delays.push(ms);},onRequestEvent:async e=>{events.push(e);}});
 assert.deepEqual(records,[]);assert.deepEqual(urls,[status.url,status.url,status.url]);assert.deepEqual(delays,[1000,2500]);
 assert.deepEqual(events.map(e=>e.outcome),['failed','failed','recovered']);assert.equal(events[0].transportCode,'UND_ERR_CONNECT_TIMEOUT');assert.equal(events[1].status,503);
 assert.equal(new Set(events.map(e=>e.requestId)).size,1);assert.ok(!JSON.stringify(events).includes('private'));assert.ok(!JSON.stringify(events).includes('credentials'));
});
test('额外重试预算在官方版本所有分页之间共享，失败不修改已有断点',async()=>{
 const pages:number[]=[],counts=new Map<number,number>(),events:SourceRequestEvent[]=[];
 const original={...releases,cursor:'2026-10-12T00:00:00Z',releaseScan:{nextPage:2,baseline:'2026-10-12T00:00:00Z'}},before=JSON.stringify(original);
 await assert.rejects(fetchReleasePages(original,async url=>{const page=Number(new URL(String(url)).searchParams.get('page'));pages.push(page);const n=(counts.get(page)??0)+1;counts.set(page,n);if(n===1)throw network();return new Response(JSON.stringify(Array.from({length:5},()=>({draft:true,prerelease:false,published_at:new Date().toISOString()}))));},{sleep:async()=>{},onRequestEvent:async e=>{events.push(e);}}),SourceTransientError);
 assert.deepEqual(pages,[1,1,2,2,3]);assert.equal(JSON.stringify(original),before);assert.equal(events.at(-1)?.retryInMs,undefined);
});
test('持续断线最多请求三次，整轮仍然失败',async()=>{
 let count=0;const events:SourceRequestEvent[]=[];
 await assert.rejects(fetchRecords(status,false,{fetcher:async()=>{count++;throw network();},sleep:async()=>{},onRequestEvent:async e=>{events.push(e);}}),SourceTransientError);
 assert.equal(count,3);assert.equal(events.length,3);assert.ok(events.every(e=>e.outcome==='failed'));assert.equal(events[2].retryInMs,undefined);
});
test('429与未来Retry-After按服务器允许时间等待，不快速重试',async()=>{
 for(const code of [429,503]){
  let count=0,sleeps=0;const events:SourceRequestEvent[]=[];const start=Date.now();
  await assert.rejects(fetchRecords(status,false,{fetcher:async()=>{count++;return new Response('limited',{status:code,headers:{'retry-after':'3600'}});},sleep:async()=>{sleeps++;},onRequestEvent:async e=>{events.push(e);}}),(e:unknown)=>e instanceof SourceRateLimitError&&Date.parse(e.retryAt)>=start+3599_000);
  assert.equal(count,1);assert.equal(sleeps,0);assert.equal(events[0].status,code);
 }
});
test('无效结构与超长响应不重试，也不当作零记录成功',async()=>{
 for(const response of [()=>new Response('not JSON'),()=>new Response('x',{headers:{'content-length':'3000001'}})]){
  let count=0;
  await assert.rejects(fetchRecords(status,false,{fetcher:async()=>{count++;return response();},sleep:async()=>{throw Error('must not retry');},onRequestEvent:async()=>{}}),SourceStructureError);
  assert.equal(count,1);
 }
});
test('响应读取断开也有限重试，保存白名单错误码',async()=>{
 let count=0;const events:SourceRequestEvent[]=[];
 const result=await fetchRecords(status,false,{fetcher:async()=>{count++;return count===1?new Response(new ReadableStream({start(controller){controller.error(Object.assign(new Error('sensitive'),{code:'ECONNRESET'}));}})):good();},sleep:async()=>{},onRequestEvent:async e=>{events.push(e);}});
 assert.deepEqual(result,[]);assert.equal(count,2);assert.equal(events[0].reason,'body');assert.equal(events[0].transportCode,'ECONNRESET');
});
const challenge='<h1 id="challenge-title">28天更新活动</h1><aside data-challenge-clock data-start="2026-10-05" data-days="28"></aside><figure class="challenge-promise"><blockquote>每天发布一项产品改进，或为符合资格的用户重置用量。</blockquote></figure><script src="/challenge-clock.js"></script><article class="challenge-entry"><h3 class="challenge-entry-title"><a href="https://x.com/thsottiaux/status/2108040921044639779">公开活动进展</a></h3><p>已确认在所有账户落地。</p></article>';
test('活动原有404路径回退保留，时区脚本同样可恢复网络故障',async()=>{
 const urls:string[]=[],events:SourceRequestEvent[]=[];let clockCount=0;
 const result=await fetchRecords(activity,false,{fetcher:async url=>{urls.push(String(url));if(String(url).endsWith('/zh-CN/tibo-28'))return new Response('',{status:404});if(String(url).endsWith('/challenge-clock.js')){if(++clockCount===1)throw network();return new Response('const zone = "America/Los_Angeles";');}return new Response(challenge);},sleep:async()=>{},onRequestEvent:async e=>{events.push(e);}});
 assert.equal(urls.length,4);assert.equal(clockCount,2);assert.equal(result[0].metadata?.activity?.timezone,'America/Los_Angeles');assert.ok(events.some(e=>e.phase==='clock'&&e.outcome==='recovered'));
});
test('辅助时区脚本限流或诊断保存失败不能吞掉并伪报健康',async()=>{
 for(const auditDown of [false,true]){
  let count=0;
  await assert.rejects(fetchRecords(activity,false,{fetcher:async url=>{count++;if(String(url).endsWith('/challenge-clock.js')){if(auditDown)throw network();return new Response('',{status:429});}return new Response(challenge);},sleep:async()=>{},onRequestEvent:async()=>{if(auditDown)throw new Error('database secret');}}),(e:unknown)=>auditDown?e instanceof Error&&e.message==='采集诊断记录暂不可用，停止本轮采集':e instanceof SourceRateLimitError);
  assert.equal(count,2);
 }
});
test('恢复诊断保存失败也不返回成功结果',async()=>{
 let count=0;
 await assert.rejects(fetchRecords(status,false,{fetcher:async()=>{if(++count===1)throw network();return good();},sleep:async()=>{},onRequestEvent:async e=>{if(e.outcome==='recovered')throw new Error('sensitive database error');}}),/采集诊断记录暂不可用/);
 assert.equal(count,2);
});
