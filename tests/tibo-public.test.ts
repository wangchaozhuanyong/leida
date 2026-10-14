import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TIBO_PUBLIC_SOURCE,parseTiboPublicPage,fetchTiboPublicTimeline as fetchTimeline,type TiboPublicDependencies,type TiboRequestEvent} from '../src/server/tibo-public';
import {TiboTimelineError} from '../src/server/tibo-timeline';
import {gatherEvidenceContext,hasCompleteContext} from '../src/server/source-context';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {validateDraft} from '../src/server/domain';
import type {Evidence,Source,TiboTimelineScan} from '../src/lib/types';

const fetchTiboPublicTimeline=(source:Source,dependencies:TiboPublicDependencies={})=>fetchTimeline(source,{sleep:async()=>{},...dependencies});
const at='2026-10-11T08:00:00.000Z',clock=()=>Date.parse(at),userId='1953337039510003712';
const snowflakeTime=(id:string)=>Number((BigInt(id)>>22n)+1288834974657n);
const snowflake=(time:string)=>String((BigInt(Date.parse(time))-1288834974657n)<<22n);
const publicFixture=JSON.parse(readFileSync(new URL('./fixtures/tibo-public-20261011.json',import.meta.url),'utf8'));
const repliesFixture=JSON.parse(readFileSync(new URL('./fixtures/tibo-replies-20261011.json',import.meta.url),'utf8'));
const original=(id:string):Record<string,unknown>=>structuredClone(publicFixture.results.find((row:Record<string,unknown>)=>row.id===id));
const post=(time:string,text='Codex desktop now supports new tools.',extra:Record<string,unknown>={})=>{
 const id=snowflake(time);
 return {type:'status',provider:'twitter',id,url:`https://x.com/thsottiaux/status/${id}`,author:{id:userId,screen_name:'thsottiaux',protected:false},text,raw_text:{text},created_at:new Date(time).toUTCString(),created_timestamp:Math.floor(Date.parse(time)/1000),...extra};
};
const page=(results:unknown[],bottom?:string)=>({code:200,results,cursor:{top:null,bottom:bottom??null}});
const baseline=post('2026-10-11T00:00:00.000Z'),head=post('2026-10-11T07:00:00.000Z'),tail=post('2026-10-11T06:00:00.000Z');
const source=(scan:TiboTimelineScan):Source=>({...TIBO_PUBLIC_SOURCE,timelineScan:scan});
const evidence=(rows:ReturnType<typeof parseTiboPublicPage>['records']):Evidence[]=>rows.map(row=>({...row,id:row.messageId,hash:row.messageId,historical:false}));
const rejectsStructure=(value:unknown)=>assert.throws(()=>parseTiboPublicPage(value,at),(error:unknown)=>error instanceof TiboTimelineError&&error.failureKind==='structure');

test('404 和断连在同次采集内恢复，诊断脱敏、同 URL 重试且保留原始证据',async()=>{
 const events:TiboRequestEvent[]=[],waits:number[]=[],urls:string[]=[];
 const scan={userId,sinceId:baseline.id};let calls=0;
 const result=await fetchTiboPublicTimeline(source(scan),{clock,sleep:async ms=>{waits.push(ms);},onRequestEvent:async event=>{events.push(event);},fetcher:async(input,init)=>{
  urls.push(String(input));assert.equal(new Headers(init?.headers).has('authorization'),false);calls++;
  if(calls===1)return new Response('secret-provider-body',{status:404});
  if(calls===2)throw new TypeError('secret-url-cookie',{cause:{code:'ECONNRESET',detail:'private'}});
  return Response.json(page([head]));
 }});
 assert.equal(calls,3);assert.equal(new Set(urls).size,1);assert.deepEqual(waits,[1000,2500]);
 assert.equal(result.interrupted,undefined);assert.equal(result.scan.sinceId,head.id);
 assert.equal(result.records[0].messageId,head.id);assert.equal(result.records[0].publishedAt,new Date(snowflakeTime(head.id)).toISOString());
 assert.deepEqual(events.map(e=>[e.outcome,e.attempt,e.status,e.transportCode]),[['failed',1,404,undefined],['failed',2,undefined,'ECONNRESET'],['recovered',3,undefined,undefined]]);
 assert.equal(new Set(events.map(e=>e.requestId)).size,1);assert.ok(events.every(e=>e.phase==='head'));
 assert.doesNotMatch(JSON.stringify(events),/secret|private|cookie|https:/);assert.deepEqual(scan,{userId,sinceId:baseline.id});
});

test('所有页共享额外两次请求预算，失败尾页不跳过，下一次仍可恢复',async()=>{
 const scan={userId,sinceId:baseline.id};const events:TiboRequestEvent[]=[];let calls=0;
 const failed=await fetchTiboPublicTimeline(source(scan),{clock,onRequestEvent:async event=>{events.push(event);},fetcher:async input=>{
  calls++;if(calls<=2)return new Response(null,{status:502});
  return new URL(String(input)).searchParams.has('cursor')?new Response(null,{status:503}):Response.json(page([head],'pending-retry-tail'));
 }});
 assert.equal(calls,4,'最多两次正常分页加两次重试，不能每页重复耗尽 worker 租约');
 assert.equal(failed.interrupted?.failureKind,'transient');assert.equal(failed.scan.sinceId,baseline.id);
 assert.equal(failed.scan.nextToken,'pending-retry-tail');assert.deepEqual(failed.records.map(r=>r.messageId),[head.id]);
 assert.equal(events.at(-1)?.phase,'tail');assert.equal(events.at(-1)?.retryInMs,undefined);
 const recovered=await fetchTiboPublicTimeline(source(failed.scan),{clock,fetcher:async()=>Response.json(page([tail]))});
 assert.equal(recovered.interrupted,undefined);assert.equal(recovered.scan.sinceId,head.id);assert.deepEqual(recovered.records.map(r=>r.messageId),[tail.id]);
});

test('重试后的 collectedAt 使用实际成功读取时刻，不把等待期间的新帖提前记成已采集',async()=>{
 let time=clock(),calls=0;
 const result=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock:()=>time,sleep:async ms=>{time+=ms;},fetcher:async()=>{
  if(++calls===1)return new Response(null,{status:404});
  time+=2500;return Response.json(page([head]));
 }});
 assert.equal(result.records[0].collectedAt,new Date(clock()+3500).toISOString());
 assert.equal(result.records[0].publishedAt,new Date(snowflakeTime(head.id)).toISOString());
});

test('持续网络失败保留三次诊断和原断点，超时、DNS、流中断只保留白名单原因',async()=>{
 for(const [error,code] of [[new DOMException('secret','TimeoutError'),'TIMEOUT'],[new Error('secret',{cause:{code:'ENOTFOUND'}}),'ENOTFOUND'],[new Error('secret',{cause:{code:'secret-token'}}),'UNKNOWN']] as const){
  const events:TiboRequestEvent[]=[];let calls=0;const scan={userId,sinceId:baseline.id};
  const failed=await fetchTiboPublicTimeline(source(scan),{clock,onRequestEvent:async event=>{events.push(event);},fetcher:async()=>{calls++;throw error;}});
  assert.equal(calls,3);assert.equal(failed.interrupted?.failureKind,'transient');assert.deepEqual(failed.scan,scan);
  assert.deepEqual(events.map(e=>e.transportCode),[code,code,code]);assert.equal(events.at(-1)?.retryInMs,undefined);assert.doesNotMatch(JSON.stringify(events),/secret/);
 }
 let calls=0;const events:TiboRequestEvent[]=[];
 const recovered=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,onRequestEvent:async event=>{events.push(event);},fetcher:async()=>++calls===1?new Response(new ReadableStream({start(controller){controller.error(new Error('secret',{cause:{code:'UND_ERR_SOCKET'}}));}})):Response.json(page([head]))});
 assert.equal(recovered.interrupted,undefined);assert.equal(events[0].reason,'body');assert.equal(events[0].transportCode,'UND_ERR_SOCKET');
});

test('限流、权限和结构异常不快速重试，诊断保存失败也不能伪装采集成功',async()=>{
 for(const response of [()=>new Response(null,{status:429,headers:{'retry-after':'300'}}),()=>new Response(null,{status:503,headers:{'retry-after':'3600'}}),()=>Response.json({code:429}),()=>new Response(null,{status:403}),()=>new Response('not-json')]){
  let calls=0;const failed=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async()=>{calls++;return response();},sleep:async()=>{assert.fail('限流或不可重试错误不能立即请求');}});
  assert.equal(calls,1);assert.ok(failed.interrupted);assert.equal(failed.headRead,false);
  if(failed.interrupted.retryAt)assert.ok(Date.parse(failed.interrupted.retryAt)>Date.now());
 }
 await assert.rejects(fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async()=>new Response(null,{status:404}),onRequestEvent:async()=>{throw new Error('diagnostic-storage-unavailable');}}),/diagnostic-storage-unavailable/);
});

test('免费公开真实格式：原帖时间与 snowflake 一致，第三方归档不冒充官方 API',()=>{
 const parsed=parseTiboPublicPage(publicFixture,at);
 assert.equal(parsed.newestId,'2109152716954222849');
 assert.equal(parsed.oldestId,'2107676072871600470');
 assert.equal(new Set(parsed.records.map(row=>row.messageId)).size,parsed.records.length);
 assert.ok(parsed.records.some(row=>row.messageId==='2109152716954222849'&&row.text==='Pro users, would you rather have'));
 for(const row of parsed.records){
  assert.equal(row.sourceId,'tibo-public');assert.equal(row.provenance,'archive');assert.equal(row.textOrigin,'original');
  assert.equal(row.metadata?.sourceGroup,'fxembed:thsottiaux');
  assert.equal(row.url,`https://x.com/thsottiaux/status/${row.messageId}`);
  assert.ok(Math.abs(Date.parse(row.publishedAt)-snowflakeTime(row.messageId))<=1000);
 }
 assert.equal(parsed.records.find(row=>row.messageId==='2109045392684032299')?.publishedAt,'2026-10-10T22:16:20.000Z');
 assert.equal(parsed.records.find(row=>row.messageId==='2109132167112782291')?.publishedAt,'2026-10-11T04:01:09.000Z');
});

test('含回复的真实流可夹带其他会话参与者，只保存核对过的 Tibo 原文',()=>{
 const foreign=repliesFixture.results.filter((row:{author:{screen_name:string}})=>row.author.screen_name!=='thsottiaux');
 assert.ok(foreign.length>0,'真实回复样本必须覆盖外部参与者');
 const parsed=parseTiboPublicPage(repliesFixture,at);
 assert.ok(parsed.records.some(row=>row.messageId==='2109132167112782291'));
 assert.ok(parsed.records.some(row=>row.messageId==='2109045392684032299'));
 assert.ok(parsed.records.every(row=>!foreign.some((post:{id:string})=>post.id===row.messageId)));
 assert.equal(parsed.newestId,'2109152716954222849');
});

test('真实预告与完成引用同一父链；EOD 不凭空换算成精确截止时刻',()=>{
 const rows=evidence(parseTiboPublicPage(publicFixture,at).records);
 const announcement=rows.find(row=>row.messageId==='2109045392684032299')!;
 const completion=rows.find(row=>row.messageId==='2109132167112782291')!;
 assert.equal(announcement.parentId,'2109045220411351517');assert.equal(completion.parentId,announcement.messageId);
 const promised=buildAutomaticTemplate(gatherEvidenceContext(announcement,rows))!;
 assert.equal(promised.actions[0].kind,'automatic_reset');assert.equal(promised.actions[0].stage,'promised');
 assert.equal(promised.actions[0].expectedAt,undefined);
 const context=gatherEvidenceContext(completion,rows);
 assert.deepEqual(context.map(row=>row.messageId),[completion.messageId,announcement.messageId,'2109045220411351517']);
 assert.equal(hasCompleteContext(completion,context),true);
 const completed=buildAutomaticTemplate(context)!;
 assert.equal(completed.actions[0].kind,'automatic_reset');assert.equal(completed.actions[0].stage,'claimed_complete');
 assert.deepEqual(validateDraft(completed,context,true),[]);
});

test('嵌入引用省略回复时保留主帖真实父关系，输入顺序不影响父链',()=>{
 const ids=['2109132167112782291','2109045392684032299','2109045220411351517'];
 for(const order of [ids,[...ids].reverse()]){
  const rows=parseTiboPublicPage(page(order.map(original)),at).records;
  assert.equal(rows.length,3);
  assert.equal(rows.find(row=>row.messageId===ids[1])?.parentId,ids[2]);
  assert.equal(rows.find(row=>row.messageId===ids[0])?.parentId,ids[1]);
 }
});

test('同页重复主帖省略 parent 时保留已知显式父关系',()=>{
 const withParent={...head,replying_to:{screen_name:'thsottiaux',status:tail.id,url:tail.url}};
 const withoutParent={...head};
 for(const order of [[withParent,withoutParent],[withoutParent,withParent]]){
  const rows=parseTiboPublicPage(page(order),at).records;
  assert.equal(rows.length,1);assert.equal(rows[0].messageId,head.id);
  assert.equal(rows[0].parentId,tail.id);assert.equal(rows[0].text,head.text);
 }
});

test('没有已保存父帖的隐含完成回复，不能独立声称完成',()=>{
 const parent=post('2026-10-11T06:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const child=post('2026-10-11T07:00:00.000Z','Confirmed landed across all accounts.',{replying_to:{screen_name:'thsottiaux',status:parent.id,url:parent.url}});
 const rows=evidence(parseTiboPublicPage(page([child]),at).records);
 assert.equal(rows[0].parentId,parent.id);assert.equal(rows[0].contextComplete,false);
 assert.equal(hasCompleteContext(rows[0],rows),false);assert.equal(buildAutomaticTemplate(rows),undefined);
 const saved=evidence(parseTiboPublicPage(page([child,parent]),at).records);
 const complete=buildAutomaticTemplate(gatherEvidenceContext(saved.find(row=>row.messageId===child.id)!,saved))!;
 assert.equal(complete.actions[0].stage,'claimed_complete');assert.equal(complete.actions[0].kind,'automatic_reset');
});

test('长帖采用完整 raw_text；外人引用和转帖不混入 Tibo 原文',()=>{
 const full='We will reset usage for all paid accounts within 2 hours.';
 const long=post('2026-10-11T07:00:00.000Z','Truncated…',{raw_text:{text:full}});
 const foreign=post('2026-10-11T05:00:00.000Z','Unrelated post',{author:{id:'12345',screen_name:'other',protected:false},url:`https://x.com/other/status/${snowflake('2026-10-11T05:00:00.000Z')}`});
 const own=post('2026-10-11T06:00:00.000Z','Thanks!',{quote:foreign});
 const repost={...foreign,reposted_by:{screen_name:'thsottiaux'}};
 const rows=parseTiboPublicPage(page([long,own,repost]),at).records;
 assert.equal(rows.length,2);assert.equal(rows.find(row=>row.messageId===long.id)?.text,full);
 assert.equal(rows.find(row=>row.messageId===own.id)?.parentId,undefined);
 assert.ok(rows.some(row=>row.text==='Thanks!'),'回复不通过 reset 关键词过滤');
});

test('多引用保持待核对，不任意选父帖；未来父帖编号拒绝',()=>{
 const replyParent=post('2026-10-11T05:00:00.000Z'),quotedParent=post('2026-10-11T06:00:00.000Z');
 const child=post('2026-10-11T07:00:00.000Z','Confirmed landed across all accounts.',{replying_to:{screen_name:'thsottiaux',status:replyParent.id,url:replyParent.url},quote:quotedParent});
 const row=parseTiboPublicPage(page([child]),at).records.find(row=>row.messageId===child.id)!;
 assert.equal(row.parentId,undefined);assert.equal(row.contextComplete,false);
 rejectsStructure(page([{...head,replying_to:{screen_name:'thsottiaux',status:snowflake(at),url:`https://x.com/thsottiaux/status/${snowflake(at)}`}}]));
});

test('身份、原帖地址与接口结构不一致时停止，不推进任何记录',()=>{
 const invalid=[
  {...head,author:{id:'12345',screen_name:'thsottiaux',protected:false}},
  {...head,author:{id:userId,screen_name:'other',protected:false}},
  {...head,author:{id:userId,screen_name:'thsottiaux',protected:true}},
  {...head,provider:'other'}, {...head,url:`https://x.com/other/status/${head.id}`},
  {...head,id:'not-a-snowflake'}, {...head,type:'profile'}, {...head,text:'',raw_text:{text:''}}
 ];
 for(const item of invalid)rejectsStructure(page([item]));
 for(const malformed of [{code:200,results:[]},{code:200,results:{},cursor:{}},page([head],'invalid token'),{code:500,results:[],cursor:{}}])rejectsStructure(malformed);
});

test('原帖日期、Unix 秒与 snowflake 必须相互一致；明显未来时间拒绝',()=>{
 for(const item of [
  {...head,created_at:'not-a-date'},
  {...head,created_timestamp:head.created_timestamp+10},
  {...head,created_timestamp:String(head.created_timestamp)},
  {...head,id:tail.id,url:tail.url},
  post('2026-10-11T08:06:00.000Z')
 ])rejectsStructure(page([item]));
 assert.throws(()=>parseTiboPublicPage(page([head]),'invalid-collected-at'),TiboTimelineError);
});

test('免费采集仅请求固定 HTTPS 地址，保留回复，不发送认证或 Cookie',async()=>{
 const requests:{url:URL;init:RequestInit}[]=[];
 const result=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async(input,init)=>{requests.push({url:new URL(String(input)),init:init!});return Response.json(page([head]));}});
 assert.equal(requests.length,1);
 const {url,init}=requests[0];
 assert.equal(`${url.origin}${url.pathname}`,'https://api.fxtwitter.com/2/profile/thsottiaux/statuses');
 assert.equal(url.searchParams.get('count'),'100');assert.equal(url.searchParams.get('with_replies'),'true');
 assert.equal(url.searchParams.get('since'),String(Math.floor(snowflakeTime(baseline.id)/1000)-1));
 assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.body,undefined);
 assert.equal(new Headers(init.headers).get('Accept'),'application/json');
 assert.equal(new Headers(init.headers).has('Authorization'),false);assert.equal(new Headers(init.headers).has('Cookie'),false);
 assert.ok(init.signal);assert.equal(result.scan.sinceId,head.id);assert.equal(result.headRead,true);
});

test('固定来源或保存断点非法时请求数为零',async()=>{
 let requests=0;const fetcher:typeof fetch=async()=>{requests++;throw new Error('Unexpected fetch');};
 for(const changed of [{...TIBO_PUBLIC_SOURCE,id:'tibo-timeline'},{...TIBO_PUBLIC_SOURCE,url:'https://api.fxtwitter.com/2/profile/other/statuses'},{...TIBO_PUBLIC_SOURCE,kind:'archive' as const}]){
  await assert.rejects(fetchTiboPublicTimeline(changed,{clock,fetcher}),(error:unknown)=>error instanceof TiboTimelineError&&error.failureKind==='configuration');
 }
 for(const scan of [{userId:'12345'},{userId,sinceId:'invalid'},{userId,pendingNewestId:'-1'},{userId,startTime:'invalid'},{userId,parentRetryAt:'invalid'},{userId,nextToken:'bad token'},{userId,pendingParentIds:['invalid']},{userId,pendingParentIds:Array.from({length:201},()=>baseline.id)}]){
  await assert.rejects(fetchTiboPublicTimeline(source(scan),{clock,fetcher}),(error:unknown)=>error instanceof TiboTimelineError&&error.failureKind==='structure');
 }
 assert.equal(requests,0);
});

test('204 空页视为读取成功，初始范围与既有最高断点不凭空改变',async()=>{
 for(const scan of [{userId,startTime:'2026-10-10T08:00:00.000Z'},{userId,sinceId:baseline.id}]){
  let requests=0;
  const result=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async()=>{requests++;return new Response(null,{status:204});}});
  assert.equal(requests,1);assert.equal(result.headRead,true);assert.equal(result.interrupted,undefined);
  assert.deepEqual(result.records,[]);assert.deepEqual(JSON.parse(JSON.stringify(result.scan)),scan);
 }
});

test('cursor 尾页 204 未证明扫描完成，保留最高待提交编号和尾页断点',async()=>{
 const scan={userId,sinceId:baseline.id};let requests=0;
 const first=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async input=>{requests++;return new URL(String(input)).searchParams.has('cursor')?new Response(null,{status:204}):Response.json(page([head],'pending-tail'));}});
 assert.equal(requests,2);assert.equal(first.headRead,true);assert.equal(first.interrupted?.failureKind,'structure');
 assert.equal(first.scan.sinceId,baseline.id);assert.equal(first.scan.pendingNewestId,head.id);
 assert.equal(first.scan.nextToken,'pending-tail');assert.equal(first.scan.preferTail,true);
 assert.deepEqual(first.records.map(row=>row.messageId),[head.id]);
 const second=await fetchTiboPublicTimeline(source(first.scan),{clock,fetcher:async input=>{requests++;assert.equal(new URL(String(input)).searchParams.get('cursor'),'pending-tail');return new Response(null,{status:204});}});
 assert.equal(requests,3);assert.equal(second.headRead,false);assert.equal(second.interrupted?.failureKind,'structure');
 assert.deepEqual(second.scan,first.scan);assert.deepEqual(second.records,[]);
});

test('验证只读首页，不追尾页或跨过尚未保存的记录',async()=>{
 const scan={userId,sinceId:baseline.id};let requests=0;
 const result=await fetchTiboPublicTimeline(source(scan),{clock,validationOnly:true,fetcher:async()=>{requests++;return Response.json(page([head],'tail-1'));}});
 assert.equal(requests,1);assert.equal(result.headRead,true);assert.deepEqual(result.scan,scan);
 assert.deepEqual(result.records.map(row=>row.messageId),[head.id]);
});

test('每轮最多两页，未完成扫描保留 since 与待提交上限',async()=>{
 const scan={userId,sinceId:baseline.id},requests:URL[]=[];
 const result=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async input=>{const url=new URL(String(input));requests.push(url);return Response.json(url.searchParams.has('cursor')?page([tail],'tail-2'):page([head],'tail-1'));}});
 assert.equal(requests.length,2);assert.equal(requests[1].searchParams.get('cursor'),'tail-1');
 assert.equal(requests[1].searchParams.has('since'),false);
 assert.equal(result.scan.sinceId,baseline.id);assert.equal(result.scan.pendingNewestId,head.id);assert.equal(result.scan.nextToken,'tail-2');
 assert.deepEqual(result.records.map(row=>row.messageId),[tail.id,head.id]);
});

test('重启回看首页并恢复旧尾页，新突发不跨过旧扫描上限',async()=>{
 const newHead=post('2026-10-11T07:30:00.000Z'),requests:URL[]=[];
 const scan={userId,sinceId:baseline.id,nextToken:'old-tail',pendingNewestId:head.id};
 const result=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async input=>{const url=new URL(String(input));requests.push(url);return Response.json(url.searchParams.has('cursor')?page([tail]):page([newHead],'new-tail'));}});
 assert.equal(requests.length,2);assert.equal(requests[1].searchParams.get('cursor'),'old-tail');
 assert.equal(result.scan.sinceId,head.id);assert.equal(result.scan.nextToken,undefined);
 assert.ok(result.records.some(row=>row.messageId===newHead.id));
 const next=await fetchTiboPublicTimeline(source(result.scan),{clock,fetcher:async input=>{assert.equal(new URL(String(input)).searchParams.get('since'),String(Math.floor(snowflakeTime(head.id)/1000)-1));return Response.json(page([newHead]));}});
 assert.equal(next.scan.sinceId,newHead.id);
});

test('恢复旧尾页回指当前首页 cursor 视为分页循环，保持原断点',async()=>{
 const newer=post('2026-10-11T07:30:00.000Z'),requests:URL[]=[];
 const scan={userId,sinceId:baseline.id,nextToken:'old-tail',pendingNewestId:head.id};
 const result=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async input=>{
  const url=new URL(String(input));requests.push(url);
  return Response.json(url.searchParams.has('cursor')?page([tail],'new-head-tail'):page([newer],'new-head-tail'));
 }});
 assert.equal(requests.length,2);assert.equal(requests[1].searchParams.get('cursor'),'old-tail');
 assert.equal(result.interrupted?.failureKind,'structure');assert.equal(result.headRead,true);
 assert.equal(result.scan.sinceId,baseline.id);assert.equal(result.scan.pendingNewestId,head.id);
 assert.equal(result.scan.nextToken,'old-tail');assert.equal(result.scan.preferTail,true);
 assert.deepEqual(result.records.map(row=>row.messageId),[newer.id]);
});

test('尾页失败保存已读首页但不推进断点；下一轮优先补齐尾页',async()=>{
 const requests:URL[]=[],scan={userId,sinceId:baseline.id};
 const first=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async input=>{const url=new URL(String(input));requests.push(url);return url.searchParams.has('cursor')?new Response('provider-private-error-body',{status:503}):Response.json(page([head],'pending-tail'));}});
 assert.equal(first.headRead,true);assert.deepEqual(first.records.map(row=>row.messageId),[head.id]);
 assert.equal(first.interrupted?.failureKind,'transient');assert.ok(!first.interrupted?.message.includes('provider-private-error-body'));
 assert.equal(first.scan.sinceId,baseline.id);assert.equal(first.scan.pendingNewestId,head.id);
 assert.equal(first.scan.nextToken,'pending-tail');assert.equal(first.scan.preferTail,true);
 const second=await fetchTiboPublicTimeline(source(first.scan),{clock,fetcher:async input=>{const url=new URL(String(input));requests.push(url);assert.equal(url.searchParams.get('cursor'),'pending-tail');return Response.json(page([tail]));}});
 assert.equal(requests.length,5);assert.equal(second.scan.sinceId,head.id);assert.equal(second.scan.nextToken,undefined);
 assert.deepEqual(second.records.map(row=>row.messageId),[tail.id]);
});

test('失效尾页仅清理分页，从原 since 重扫，不丢成功首页',async()=>{
 const scan={userId,sinceId:baseline.id,nextToken:'expired-tail',pendingNewestId:head.id};
 const newer=post('2026-10-11T07:30:00.000Z');
 const result=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async input=>new URL(String(input)).searchParams.has('cursor')?new Response('provider-body',{status:400}):Response.json(page([newer]))});
 assert.equal(result.interrupted?.failureKind,'rate_limit');assert.ok(result.interrupted?.retryAt);
 assert.equal(result.scan.sinceId,baseline.id);assert.equal(result.scan.nextToken,undefined);assert.equal(result.scan.pendingNewestId,undefined);
 assert.deepEqual(result.records.map(row=>row.messageId),[newer.id]);
 await fetchTiboPublicTimeline(source(result.scan),{clock,fetcher:async input=>{const url=new URL(String(input));assert.equal(url.searchParams.has('cursor'),false);assert.equal(url.searchParams.get('since'),String(Math.floor(snowflakeTime(baseline.id)/1000)-1));return new Response(null,{status:204});}});
});

test('失效尾页保留本轮首页首次发现的旧父帖需求，冷却后优先首页再补父链',async()=>{
 const parent=post('2026-10-09T06:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const child=post('2026-10-11T07:00:00.000Z','Confirmed landed across all accounts.',{replying_to:{screen_name:'thsottiaux',status:parent.id,url:parent.url}});
 const newer=post('2026-10-11T08:01:00.000Z','Codex desktop now supports another tool.');
 let requests=0;
 const failed=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async input=>{
  requests++;return new URL(String(input)).searchParams.has('cursor')?new Response(null,{status:400}):Response.json(page([child],'expired-tail'));
 }});
 assert.equal(requests,2);assert.equal(failed.interrupted?.failureKind,'rate_limit');
 assert.deepEqual(failed.records.map(row=>row.messageId),[child.id]);
 assert.equal(failed.scan.sinceId,baseline.id,'失效尾页不能提交本轮最高编号');
 assert.equal(failed.scan.nextToken,undefined);assert.equal(failed.scan.pendingNewestId,undefined);
 assert.deepEqual(failed.scan.pendingParentIds,[parent.id]);
 assert.equal(failed.scan.parentRetryAt,new Date(clock()+15*60_000).toISOString());
 requests=0;
 const cooled=await fetchTiboPublicTimeline(source(structuredClone(failed.scan)),{clock:()=>clock()+2*60_000,fetcher:async input=>{
  requests++;assert.equal(new URL(String(input)).searchParams.has('cursor'),false);return Response.json(page([newer]));
 }});
 assert.equal(requests,1);assert.equal(cooled.scan.sinceId,newer.id);
 assert.deepEqual(cooled.scan.pendingParentIds,[parent.id]);assert.equal(cooled.scan.parentRetryAt,failed.scan.parentRetryAt);
 requests=0;
 const recovered=await fetchTiboPublicTimeline(source(structuredClone(cooled.scan)),{clock:()=>clock()+16*60_000,fetcher:async input=>{
  const url=new URL(String(input));requests++;
  if(requests===1){assert.equal(url.searchParams.get('since'),String(Math.floor(snowflakeTime(newer.id)/1000)-1));return new Response(null,{status:204});}
  assert.equal(url.searchParams.get('since'),String(Math.floor(snowflakeTime(parent.id)/1000)-1));return Response.json(page([parent]));
 }});
 assert.equal(requests,2);assert.equal(recovered.interrupted,undefined);
 assert.deepEqual(recovered.records.map(row=>row.messageId),[parent.id]);assert.equal(recovered.scan.sinceId,newer.id);
 assert.equal(recovered.scan.pendingParentIds,undefined);assert.equal(recovered.scan.parentRetryAt,undefined);
 const saved=evidence([...failed.records,...recovered.records]),primary=saved.find(row=>row.messageId===child.id)!;
 assert.equal(hasCompleteContext(primary,gatherEvidenceContext(primary,saved)),true);
 assert.equal(buildAutomaticTemplate(gatherEvidenceContext(primary,saved))?.actions[0].stage,'claimed_complete');
});

test('尾页结构错误或重复分页标识也不能提交首页最高编号',async()=>{
 for(const badTail of [page([{...tail,author:{id:'wrong',screen_name:'thsottiaux',protected:false}}]),page([tail],'same-tail')]){
  const result=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async input=>Response.json(new URL(String(input)).searchParams.has('cursor')?badTail:page([head],'same-tail'))});
  assert.equal(result.interrupted?.failureKind,'structure');assert.equal(result.scan.sinceId,baseline.id);
  assert.equal(result.scan.pendingNewestId,head.id);assert.equal(result.scan.nextToken,'same-tail');assert.equal(result.scan.preferTail,true);
  assert.deepEqual(result.records.map(row=>row.messageId),[head.id]);
 }
});

test('跨页同帖正文或显式父关系冲突拒绝覆盖成功首页',async()=>{
 const older=post('2026-10-11T05:00:00.000Z');
 const first={...head,replying_to:{screen_name:'thsottiaux',status:tail.id,url:tail.url}};
 const conflicts=[
  {...first,text:'Changed public text',raw_text:{text:'Changed public text'}},
  {...first,replying_to:{screen_name:'thsottiaux',status:older.id,url:older.url}}
 ];
 for(const conflict of conflicts){
  const result=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async input=>Response.json(new URL(String(input)).searchParams.has('cursor')?page([conflict]):page([first],'conflicting-tail'))});
  assert.equal(result.interrupted?.failureKind,'structure');assert.equal(result.headRead,true);
  assert.equal(result.scan.sinceId,baseline.id);assert.equal(result.scan.pendingNewestId,head.id);assert.equal(result.scan.nextToken,'conflicting-tail');
  assert.deepEqual(result.records.map(row=>({id:row.messageId,text:row.text,parentId:row.parentId})),[{id:head.id,text:head.text,parentId:tail.id}]);
 }
 const withoutParent={...head};
 const compatible=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async input=>Response.json(new URL(String(input)).searchParams.has('cursor')?page([withoutParent]):page([first],'compatible-tail'))});
 assert.equal(compatible.interrupted,undefined);assert.equal(compatible.records.length,1);
 assert.equal(compatible.records[0].parentId,tail.id);assert.equal(compatible.scan.sinceId,head.id);
});

test('旧置顶不提前停止分页；新帖明确引用的旧父帖仍补齐',async()=>{
 const parent=post('2026-10-10T22:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const child=post('2026-10-11T07:00:00.000Z','Confirmed landed across all accounts.',{quote:parent});
 const between=post('2026-10-11T03:00:00.000Z');
 let requests=0;
 const result=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async input=>{requests++;const url=new URL(String(input));return Response.json(url.searchParams.has('cursor')?page([between]):page([child,parent,baseline],'still-new-tail'));}});
 assert.equal(requests,2);assert.equal(result.scan.sinceId,child.id);assert.equal(result.scan.nextToken,undefined);
 assert.deepEqual(new Set(result.records.map(row=>row.messageId)),new Set([parent.id,child.id,between.id]));
 const saved=evidence(result.records),context=gatherEvidenceContext(saved.find(row=>row.messageId===child.id)!,saved);
 assert.equal(hasCompleteContext(context[0],context),true);
});

test('整页 Tibo 主帖都不新于断点时停止，不为旧页追额外 cursor',async()=>{
 let requests=0;
 const older=post('2026-10-10T22:00:00.000Z');
 const result=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async()=>{requests++;return Response.json(page([older,baseline],'unneeded-tail'));}});
 assert.equal(requests,1);assert.equal(result.scan.sinceId,baseline.id);assert.equal(result.scan.nextToken,undefined);
 assert.deepEqual(result.records,[]);assert.equal(result.interrupted,undefined);
});

test('新完成回复跨页引用初始范围之前父帖，只保留明确祖先，不带入无关旧帖',async()=>{
 const parent=post('2026-10-09T07:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const unrelated=post('2026-10-09T06:00:00.000Z','Codex desktop now supports unrelated tools.');
 const child=post('2026-10-11T07:00:00.000Z','Confirmed landed across all accounts.',{replying_to:{screen_name:'thsottiaux',status:parent.id,url:parent.url}});
 const result=await fetchTiboPublicTimeline(source({userId,startTime:'2026-10-10T08:00:00.000Z'}),{clock,fetcher:async input=>Response.json(new URL(String(input)).searchParams.has('cursor')?page([parent,unrelated]):page([child],'old-parent-tail'))});
 assert.deepEqual(result.records.map(row=>row.messageId),[parent.id,child.id]);
 assert.equal(result.scan.sinceId,child.id);assert.equal(result.scan.pendingParentIds,undefined);
 const saved=evidence(result.records),primary=saved.find(row=>row.messageId===child.id)!;
 const context=gatherEvidenceContext(primary,saved);
 assert.equal(hasCompleteContext(primary,context),true);
 assert.equal(buildAutomaticTemplate(context)?.actions[0].stage,'claimed_complete');
});

test('跨轮尾页保存完整显式祖先需求，旧页边界不提前结束，preferTail也续补父链',async()=>{
 const root=post('2026-10-09T05:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const parent=post('2026-10-09T06:00:00.000Z','Still working on it.',{replying_to:{screen_name:'thsottiaux',status:root.id,url:root.url}});
 const child=post('2026-10-11T07:00:00.000Z','Confirmed landed across all accounts.',{replying_to:{screen_name:'thsottiaux',status:parent.id,url:parent.url}});
 const unrelated=post('2026-10-09T07:00:00.000Z','Codex desktop now supports unrelated tools.');
 const first=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async input=>Response.json(new URL(String(input)).searchParams.has('cursor')?page([unrelated],'parent-tail'):page([child],'unrelated-tail'))});
 assert.deepEqual(first.records.map(row=>row.messageId),[child.id]);
 assert.equal(first.scan.sinceId,baseline.id);assert.equal(first.scan.pendingNewestId,child.id);
 assert.equal(first.scan.nextToken,'parent-tail');assert.deepEqual(first.scan.pendingParentIds,[parent.id]);
 const second=await fetchTiboPublicTimeline(source(first.scan),{clock,fetcher:async input=>new URL(String(input)).searchParams.has('cursor')?new Response(null,{status:503}):Response.json(page([child],'unrelated-tail'))});
 assert.equal(second.interrupted?.failureKind,'transient');assert.equal(second.scan.preferTail,true);
 assert.deepEqual(second.scan.pendingParentIds,[parent.id]);
 const third=await fetchTiboPublicTimeline(source(second.scan),{clock,fetcher:async input=>{assert.equal(new URL(String(input)).searchParams.get('cursor'),'parent-tail');return Response.json(page([parent],'root-tail'));}});
 assert.deepEqual(third.records.map(row=>row.messageId),[parent.id]);
 assert.equal(third.scan.sinceId,baseline.id);assert.equal(third.scan.pendingNewestId,child.id);
 assert.equal(third.scan.nextToken,'root-tail');assert.deepEqual(third.scan.pendingParentIds,[root.id]);
 const fourth=await fetchTiboPublicTimeline(source(third.scan),{clock,fetcher:async input=>Response.json(new URL(String(input)).searchParams.has('cursor')?page([root],'unrelated-older-history'):page([child],'unrelated-tail'))});
 assert.ok(fourth.records.some(row=>row.messageId===root.id));
 assert.equal(fourth.scan.sinceId,child.id);assert.equal(fourth.scan.nextToken,undefined);
 assert.equal(fourth.scan.pendingParentIds,undefined);
 const saved=evidence([...first.records,...third.records,...fourth.records]),primary=saved.find(row=>row.messageId===child.id)!;
 assert.equal(hasCompleteContext(primary,gatherEvidenceContext(primary,saved)),true);
});

test('旧首页回放可引用已存中间父帖，新首页引用的全新旧父帖仍追祖先，不遗漏新需求',async()=>{
 const grandparent=post('2026-10-09T05:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const parent=post('2026-10-09T06:00:00.000Z','Still working on it.',{replying_to:{screen_name:'thsottiaux',status:grandparent.id,url:grandparent.url}});
 const newer=post('2026-10-11T07:30:00.000Z','Confirmed landed across all accounts.',{quote:parent});
 const scan={userId,sinceId:baseline.id,nextToken:'saved-tail',pendingNewestId:head.id};
 const result=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async input=>Response.json(new URL(String(input)).searchParams.has('cursor')?page([grandparent],'unrelated-older-history'):page([newer],'new-tail'))});
 assert.equal(result.scan.nextToken,undefined);assert.equal(result.scan.sinceId,head.id);
 const saved=evidence(result.records),primary=saved.find(row=>row.messageId===newer.id)!;
 assert.equal(hasCompleteContext(primary,gatherEvidenceContext(primary,saved)),true);
});

test('旧版未记录祖先需求的续扫断点，在回看首页时恢复缺失父帖需求',async()=>{
 const parent=post('2026-10-09T06:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const child=post('2026-10-11T07:00:00.000Z','Confirmed landed across all accounts.',{replying_to:{screen_name:'thsottiaux',status:parent.id,url:parent.url}});
 const unrelated=post('2026-10-09T07:00:00.000Z','Codex desktop now supports unrelated tools.');
 const result=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id,nextToken:'old-tail',pendingNewestId:child.id}),{clock,fetcher:async input=>Response.json(new URL(String(input)).searchParams.has('cursor')?page([unrelated],'parent-tail'):page([child],'old-tail'))});
 assert.equal(result.scan.nextToken,'parent-tail');assert.equal(result.scan.sinceId,baseline.id);
 assert.deepEqual(result.scan.pendingParentIds,[parent.id]);
});

test('尾页读尽仍缺父帖时保持上下文待补证，不独立声称完成',async()=>{
 const absent=post('2026-10-09T07:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const child=post('2026-10-11T07:00:00.000Z','Confirmed landed across all accounts.',{replying_to:{screen_name:'thsottiaux',status:absent.id,url:absent.url}});
 const result=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async input=>Response.json(new URL(String(input)).searchParams.has('cursor')?page([]):page([child],'empty-tail'))});
 const saved=evidence(result.records);assert.equal(saved.length,1);
 assert.equal(hasCompleteContext(saved[0],saved),false);assert.equal(buildAutomaticTemplate(saved),undefined);
 assert.equal(result.scan.nextToken,undefined);assert.deepEqual(result.scan.pendingParentIds,[absent.id]);
 assert.equal(result.scan.parentRetryAt,new Date(clock()+15*60_000).toISOString());
});

test('读尽时保留缺父帖断点，正常新帖优先，十五分钟后限两页补回旧祖先',async()=>{
 const parent=post('2026-10-09T06:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const unrelated=post('2026-10-09T05:00:00.000Z','Codex desktop supports unrelated tools.');
 const child=post('2026-10-11T07:00:00.000Z','Confirmed landed across all accounts.',{replying_to:{screen_name:'thsottiaux',status:parent.id,url:parent.url}});
 const newer=post('2026-10-11T08:01:00.000Z','Codex desktop now supports another tool.');
 const first=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async()=>Response.json(page([child]))});
 assert.equal(first.scan.sinceId,child.id);assert.deepEqual(first.scan.pendingParentIds,[parent.id]);
 const retryAt=first.scan.parentRetryAt;assert.equal(retryAt,new Date(clock()+15*60_000).toISOString());
 const requests:URL[]=[];
 const second=await fetchTiboPublicTimeline(source(structuredClone(first.scan)),{clock:()=>clock()+2*60_000,fetcher:async input=>{requests.push(new URL(String(input)));return Response.json(page([newer]));}});
 assert.equal(requests.length,1,'冷却期只读取新动态，不反复追旧页');
 assert.equal(second.scan.sinceId,newer.id);assert.deepEqual(second.scan.pendingParentIds,[parent.id]);assert.equal(second.scan.parentRetryAt,retryAt);
 requests.length=0;
 const third=await fetchTiboPublicTimeline(source(structuredClone(second.scan)),{clock:()=>clock()+15*60_000,fetcher:async input=>{
  const url=new URL(String(input));requests.push(url);
  if(requests.length===1){assert.equal(url.searchParams.get('since'),String(Math.floor(snowflakeTime(newer.id)/1000)-1));return new Response(null,{status:204});}
  assert.equal(url.searchParams.get('since'),String(Math.floor(snowflakeTime(parent.id)/1000)-1));
  return Response.json(page([parent,unrelated]));
 }});
 assert.equal(requests.length,2);assert.deepEqual(third.records.map(row=>row.messageId),[parent.id]);
 assert.equal(third.scan.sinceId,newer.id);assert.equal(third.scan.pendingParentIds,undefined);assert.equal(third.scan.parentRetryAt,undefined);
 const saved=evidence([...first.records,...third.records]),primary=saved.find(row=>row.messageId===child.id)!;
 assert.equal(hasCompleteContext(primary,gatherEvidenceContext(primary,saved)),true);
 assert.equal(buildAutomaticTemplate(gatherEvidenceContext(primary,saved))?.actions[0].stage,'claimed_complete');
});

test('缺父帖探测仍为空或临时失败时保留需求和冷却，不阻塞正常首页新消息',async()=>{
 const parent=post('2026-10-09T06:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const newer=post('2026-10-11T07:30:00.000Z','Codex desktop now supports another tool.');
 const scan={userId,sinceId:head.id,pendingParentIds:[parent.id],parentRetryAt:at};
 for(const empty of [true,false]){
  let calls=0;
  const result=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async()=>++calls===1?Response.json(page([newer])):empty?new Response(null,{status:204}):new Response(null,{status:503})});
  assert.equal(calls,empty?2:4);assert.deepEqual(result.records.map(row=>row.messageId),[newer.id]);assert.equal(result.headRead,true);
  assert.equal(result.interrupted,undefined,'首页已核对，旧依赖暂缺仍按缺链等待');
  assert.deepEqual(result.scan.pendingParentIds,[parent.id]);assert.equal(result.scan.sinceId,newer.id);
  assert.equal(result.scan.parentRetryAt,new Date(clock()+15*60_000).toISOString());
 }
});

test('低频缺链探测支持跨轮祖先分页，重启恢复且不把无关旧帖保存为新输入',async()=>{
 const root=post('2026-10-09T05:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const parent=post('2026-10-09T06:00:00.000Z','Still working on it.',{replying_to:{screen_name:'thsottiaux',status:root.id,url:root.url}});
 const unrelated=post('2026-10-09T07:00:00.000Z','Unrelated desktop tools.');
 const newer=post('2026-10-11T07:30:00.000Z','Codex desktop now supports another tool.');
 const scan={userId,sinceId:head.id,pendingParentIds:[parent.id],parentRetryAt:at};let calls=0;
 const probing=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async()=>++calls===1?Response.json(page([newer])):Response.json(page([unrelated],'parent-probe-tail'))});
 assert.equal(calls,2);assert.equal(probing.scan.sinceId,newer.id);assert.equal(probing.scan.nextToken,'parent-probe-tail');assert.equal(probing.scan.pendingNewestId,newer.id);
 assert.deepEqual(probing.scan.pendingParentIds,[parent.id]);assert.deepEqual(probing.records.map(row=>row.messageId),[newer.id]);
 const resumed=await fetchTiboPublicTimeline(source(JSON.parse(JSON.stringify(probing.scan))),{clock:()=>clock()+2*60_000,fetcher:async input=>{
  const url=new URL(String(input));return url.searchParams.has('cursor')?Response.json(page([parent],'grandparent-probe-tail')):new Response(null,{status:204});
 }});
 assert.equal(resumed.scan.sinceId,newer.id);assert.deepEqual(resumed.records.map(row=>row.messageId),[parent.id]);assert.deepEqual(resumed.scan.pendingParentIds,[root.id]);
 const done=await fetchTiboPublicTimeline(source(resumed.scan),{clock:()=>clock()+4*60_000,fetcher:async input=>new URL(String(input)).searchParams.has('cursor')?Response.json(page([root])):new Response(null,{status:204})});
 assert.deepEqual(done.records.map(row=>row.messageId),[root.id]);assert.equal(done.scan.sinceId,newer.id);assert.equal(done.scan.nextToken,undefined);
 assert.equal(done.scan.pendingParentIds,undefined);assert.equal(done.scan.parentRetryAt,undefined);
});

test('缺父帖探测限流或结构冲突仍保留原游标，不能提交冲突页面或伪装恢复',async()=>{
 const parent=post('2026-10-09T06:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const newer=post('2026-10-11T07:30:00.000Z','Codex desktop now supports another tool.');
 const scan={userId,sinceId:head.id,pendingParentIds:[parent.id],parentRetryAt:at};
 for(const kind of ['rate_limit','structure'] as const){
  let calls=0;
  const result=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async()=>{
   if(++calls===1)return Response.json(page([newer]));
   return kind==='rate_limit'?new Response(null,{status:429,headers:{'retry-after':'900'}}):Response.json(page([{...newer,raw_text:{text:'Conflicting replacement'}}]));
  }});
  assert.equal(calls,2);assert.equal(result.interrupted?.failureKind,kind);assert.equal(result.scan.sinceId,scan.sinceId);
  assert.deepEqual(result.records.map(row=>row.text),[newer.text]);assert.deepEqual(result.scan.pendingParentIds,[parent.id]);
  assert.equal(result.scan.parentRetryAt,new Date(clock()+15*60_000).toISOString());
 }
});

test('旧依赖尾页暂时失败后低频重试，首页仍先读取，不能借preferTail阻断新帖',async()=>{
 const parent=post('2026-10-09T06:00:00.000Z','We will reset usage for all paid accounts within 2 hours.');
 const newer=post('2026-10-11T07:30:00.000Z','Codex desktop now supports another tool.');
 const scan={userId,sinceId:head.id,pendingNewestId:head.id,nextToken:'dependency-tail',pendingParentIds:[parent.id],parentRetryAt:at};
 let calls=0;
 const failed=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async input=>{
  calls++;return new URL(String(input)).searchParams.has('cursor')?new Response(null,{status:503}):Response.json(page([newer]));
 }});
 assert.equal(calls,4);assert.equal(failed.interrupted,undefined);assert.deepEqual(failed.records.map(row=>row.messageId),[newer.id]);assert.equal(failed.scan.preferTail,true);
 assert.equal(failed.scan.nextToken,'dependency-tail');assert.equal(failed.scan.parentRetryAt,new Date(clock()+15*60_000).toISOString());
 calls=0;
 const cooled=await fetchTiboPublicTimeline(source(failed.scan),{clock:()=>clock()+2*60_000,fetcher:async input=>{calls++;assert.equal(new URL(String(input)).searchParams.has('cursor'),false);return Response.json(page([newer]));}});
 assert.equal(calls,1);assert.deepEqual(cooled.records.map(row=>row.messageId),[newer.id]);assert.deepEqual(cooled.scan,failed.scan);
 calls=0;
 const resumed=await fetchTiboPublicTimeline(source(cooled.scan),{clock:()=>clock()+15*60_000,fetcher:async input=>{calls++;return new URL(String(input)).searchParams.has('cursor')?Response.json(page([parent])):Response.json(page([newer]));}});
 assert.equal(calls,2);assert.equal(resumed.scan.nextToken,undefined);assert.equal(resumed.scan.pendingParentIds,undefined);
 assert.ok(resumed.records.some(row=>row.messageId===parent.id));assert.ok(resumed.records.some(row=>row.messageId===newer.id));
});

test('回复流首页只有外部参与者，尾页首次读到自己的新帖仍推进扫描上限',async()=>{
 const foreign={...head,author:{id:'123456789',screen_name:'another',protected:false},url:`https://x.com/another/status/${head.id}`};
 const result=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async input=>Response.json(new URL(String(input)).searchParams.has('cursor')?page([tail]):page([foreign],'own-tail'))});
 assert.deepEqual(result.records.map(row=>row.messageId),[tail.id]);
 assert.equal(result.scan.sinceId,tail.id);assert.equal(result.scan.nextToken,undefined);
 const unfinished=await fetchTiboPublicTimeline(source({userId,sinceId:baseline.id}),{clock,fetcher:async input=>Response.json(new URL(String(input)).searchParams.has('cursor')?page([tail],'own-tail-2'):page([foreign],'own-tail'))});
 assert.equal(unfinished.scan.sinceId,baseline.id);assert.equal(unfinished.scan.pendingNewestId,tail.id);
 const finished=await fetchTiboPublicTimeline(source({...unfinished.scan,preferTail:true}),{clock,fetcher:async()=>Response.json(page([baseline]))});
 assert.equal(finished.scan.sinceId,tail.id);assert.equal(finished.scan.nextToken,undefined);
});

test('HTTP 与 JSON 限流均等待恢复，异常重试值有限且不回显正文',async()=>{
 const replies=[
  ()=>new Response('provider-private-limit-body',{status:429,headers:{'retry-after':'60'}}),
  ()=>new Response(null,{status:429,headers:{'retry-after':'1e99'}}),
  ()=>new Response(null,{status:429,headers:{'retry-after':new Date(Date.now()+3600_000).toUTCString()}}),
  ()=>Response.json({code:429,detail:'provider-private-limit-body'})
 ];
 for(const reply of replies){
  const before=Date.now(),scan={userId,sinceId:baseline.id};
  const result=await fetchTiboPublicTimeline(source(scan),{clock,fetcher:async()=>reply()});
  assert.equal(result.headRead,false);assert.deepEqual(result.scan,scan);assert.deepEqual(result.records,[]);
  assert.equal(result.interrupted?.failureKind,'rate_limit');assert.ok(!result.interrupted?.message.includes('provider-private-limit-body'));
  const retry=Date.parse(result.interrupted!.retryAt!);assert.ok(Number.isFinite(retry));assert.ok(retry>=before+120_000);
 }
});

test('网络失败、无效 JSON 和响应流中断都保留游标并隐藏底层异常',async()=>{
 const failures:{fetcher:typeof fetch;kind:string}[]=[
  {fetcher:async()=>{throw new Error('provider-private-network-error');},kind:'transient'},
  {fetcher:async()=>new Response('invalid-json'),kind:'structure'},
  {fetcher:async()=>Response.json({code:500}),kind:'transient'},
  {fetcher:async()=>new Response(new ReadableStream({start(controller){controller.error(new Error('provider-private-stream-error'));}})),kind:'transient'}
 ];
 for(const {fetcher,kind} of failures){
  const scan={userId,sinceId:baseline.id},result=await fetchTiboPublicTimeline(source(scan),{clock,fetcher});
  assert.equal(result.headRead,false);assert.deepEqual(result.scan,scan);assert.deepEqual(result.records,[]);
  assert.equal(result.interrupted?.failureKind,kind);assert.ok(!result.interrupted?.message.includes('provider-private'));
 }
});
