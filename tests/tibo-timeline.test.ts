import test from 'node:test';
import assert from 'node:assert/strict';
import {TIBO_SOURCE,parseTiboPage,fetchTiboTimeline,TiboTimelineError,type TiboDependencies} from '../src/server/tibo-timeline';
import {gatherEvidenceContext,hasCompleteContext} from '../src/server/source-context';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {validateDraft} from '../src/server/domain';
import type {Evidence} from '../src/lib/types';
const at='2026-10-11T08:00:00.000Z',userId='12345';
const post=(id='2109045392684032299',text='Global reset by EOD. May the tokens do good things for you.',extra:Record<string,unknown>={})=>({id,author_id:userId,text,created_at:'2026-10-11T07:00:00.000Z',...extra});
const page=(posts:ReturnType<typeof post>[],extra:Record<string,unknown>={})=>({data:posts,includes:{users:[{id:userId,username:'thsottiaux',protected:false}]},meta:{result_count:posts.length,...(posts.length?{newest_id:posts.reduce((a,b)=>BigInt(a.id)>BigInt(b.id)?a:b).id}:{})},...extra});
const access=async()=>({bearerToken:'synthetic-test-only',version:1,beforeRequest:async()=>{}});
test('直接接收新原帖、相对截止与明确完成父链，不依赖归档',()=>{
 const parent=post('2109045392684032299','We will reset usage for all paid accounts within 2 hours.');
 const child=post('2109132167112782291','Confirmed landed across all accounts.',{created_at:'2026-10-11T07:10:00.000Z',referenced_posts:[{type:'replied_to',id:parent.id}]});
 const result=parseTiboPage(page([child],{includes:{users:[{id:userId,username:'thsottiaux'}],tweets:[parent]}}),userId,at);
 const evidence=result.records.map(row=>({...row,id:row.messageId,hash:row.messageId,historical:false})) as Evidence[];
 assert.equal(evidence[0].provenance,'official');assert.equal(evidence[0].sourceId,'tibo-timeline');assert.equal(evidence[1].parentId,evidence[0].messageId);
 const promised=buildAutomaticTemplate([evidence[0]])!;assert.equal(promised.actions[0].stage,'promised');assert.equal(promised.actions[0].expectedAt,'2026-10-11T09:00:00.000Z');
 const context=gatherEvidenceContext(evidence[1],evidence);assert.equal(hasCompleteContext(evidence[1],context),true);
 const complete=buildAutomaticTemplate(context)!;assert.equal(complete.actions[0].kind,'automatic_reset');assert.equal(complete.actions[0].stage,'claimed_complete');assert.deepEqual(validateDraft(complete,context,true),[]);
});
test('保留不含reset的回复与长帖正文；未保存父帖则不能声称完成',()=>{
 const child=post('2109132167112782291','Confirmed landed across all accounts.',{referenced_tweets:[{type:'replied_to',id:'2109045392684032299'}]});
 const rows=parseTiboPage(page([child,post('2109045392684032299','Truncated…',{note_post:{text:'We will reset usage for all paid accounts within 2 hours.'}})]),userId,at).records;
 assert.equal(rows.find(row=>row.messageId==='2109045392684032299')?.text,'We will reset usage for all paid accounts within 2 hours.');const reply=rows.find(row=>row.messageId===child.id)!;assert.equal(reply.contextComplete,false);
 assert.equal(hasCompleteContext({...reply,id:'child',hash:'h',historical:false},[]),false);
});
test('外部父帖不混作Tibo原文；多引用留原文待核对，不任意挑父帖',()=>{
 const child=post('2109132167112782291','Confirmed landed across all accounts.',{referenced_posts:[{type:'replied_to',id:'2109045392684032299'},{type:'quoted',id:'2108000000000000000'}]});
 const data=page([child],{includes:{users:[{id:userId,username:'thsottiaux'}],tweets:[post('2109045392684032299','We reset all accounts.',{author_id:'555'})]}});
 const rows=parseTiboPage(data,userId,at).records;assert.equal(rows.length,1);assert.equal(rows[0].parentId,undefined);assert.equal(rows[0].contextComplete,false);
});
test('正文关键词不作为发现过滤：产品帖和无福利回复也保存',()=>{
 const rows=parseTiboPage(page([post('2109045392684032299','Codex desktop now supports new tools.'),post('2109132167112782291','Thanks!')]),userId,at).records;
 assert.equal(rows.length,2);assert.equal(rows[1].text,'Thanks!');
});
test('结构缺字段、其他作者、部分失败、父帖未来编号皆拒绝推进',()=>{
 for(const data of [page([post()],{errors:[{detail:'failed'}]}),page([post('2109045392684032299','x',{author_id:'555'})]),page([post()],{includes:{users:[{id:userId,username:'other'}]}}),page([post('2109045392684032299','x',{referenced_posts:[{type:'replied_to',id:'2109132167112782291'}]})]),page([post('2109045392684032299','x',{created_at:undefined})]),page([post()],{meta:{result_count:0}})])assert.throws(()=>parseTiboPage(data,userId,at),TiboTimelineError);
 assert.deepEqual(parseTiboPage({meta:{result_count:0}},userId,at).records,[]);
});
test('初始核对固定作者，保留回复，只读HTTPS，不转发凭据重定向',async()=>{
 const calls:URL[]=[],options:RequestInit[]=[];let reservations=0;
 const result=await fetchTiboTimeline(TIBO_SOURCE,{clock:()=>Date.parse(at),access:async()=>({...(await access()),beforeRequest:async()=>{reservations++;}}),fetcher:async(input,init)=>{const url=new URL(String(input));calls.push(url);options.push(init!);return new Response(JSON.stringify(url.pathname.endsWith('/thsottiaux')?{data:{id:userId,username:'thsottiaux',protected:false}}:page([post()])));}});
 assert.equal(reservations,2);assert.equal(calls[0].href,'https://api.x.com/2/users/by/username/thsottiaux?user.fields=username%2Cprotected');
 assert.equal(calls[1].searchParams.get('exclude'),'retweets');assert.ok(!calls[1].searchParams.get('exclude')!.includes('replies'));assert.ok(calls[1].searchParams.has('post.fields'));assert.equal(calls[1].searchParams.get('expansions'),'author_id,referenced_posts');
 assert.equal(result.scan.sinceId,post().id);assert.equal(result.scan.nextToken,undefined);
 assert.ok(options.every(option=>option.method==='GET'&&option.redirect==='error'&&!new Headers(option.headers).has('cookie')));
});
test('重启恢复分页并回看最新页；当前新突发不提前跨过旧扫描最高编号',async()=>{
 const oldUpper='2109045392684032299',newUpper='2109132167112782291',requests:URL[]=[];
 const source={...TIBO_SOURCE,timelineScan:{userId,sinceId:'2108000000000000000',nextToken:'old-tail',pendingNewestId:oldUpper}};
 const result=await fetchTiboTimeline(source,{access,clock:()=>Date.parse(at),fetcher:async input=>{const url=new URL(String(input));requests.push(url);return new Response(JSON.stringify(url.searchParams.has('pagination_token')?page([post('2109000000000000000')]):page([post(newUpper)],{meta:{result_count:1,newest_id:newUpper,next_token:'new-tail'}})));}});
 assert.equal(requests.length,2);assert.equal(requests[1].searchParams.get('pagination_token'),'old-tail');assert.equal(result.scan.sinceId,oldUpper,'新最高编号只保存证据，不覆盖旧扫描的提交上限');assert.equal(result.scan.nextToken,undefined);
 const next=await fetchTiboTimeline({...source,timelineScan:result.scan},{access,clock:()=>Date.parse(at),fetcher:async input=>{assert.equal(new URL(String(input)).searchParams.get('since_id'),oldUpper);return new Response(JSON.stringify(page([post(newUpper)])));}});
 assert.equal(next.scan.sinceId,newUpper);
});
test('每轮最多两页，未完分页保留原since_id和最高断点',async()=>{
 let count=0;const result=await fetchTiboTimeline({...TIBO_SOURCE,timelineScan:{userId,sinceId:'2108000000000000000'}},{access,clock:()=>Date.parse(at),fetcher:async()=>new Response(JSON.stringify(page([post()],{meta:{result_count:1,newest_id:post().id,next_token:`page-${++count}`}})))});
 assert.equal(count,2);assert.equal(result.scan.sinceId,'2108000000000000000');assert.equal(result.scan.pendingNewestId,post().id);assert.equal(result.scan.nextToken,'page-2');
});
test('限流、凭据权限与额度错误分类明确，不回显服务端正文或凭据',async()=>{
 for(const [status,kind] of [[401,'configuration'],[402,'configuration'],[403,'configuration'],[429,'rate_limit'],[500,'transient']] as const){const result=await fetchTiboTimeline({...TIBO_SOURCE,timelineScan:{userId}},{access,fetcher:async()=>new Response('secret-in-provider-body',{status,headers:{'retry-after':'60','x-rate-limit-reset':String(Math.floor(Date.now()/1000)+120)}})});assert.equal(result.headRead,false);const error=result.interrupted!;assert.ok(error instanceof TiboTimelineError);assert.equal(error.failureKind,kind);assert.ok(!error.message.includes('secret-in-provider-body'));assert.ok(!error.retryAt||Date.parse(error.retryAt)>Date.now());}
 const malformed=await fetchTiboTimeline({...TIBO_SOURCE,timelineScan:{userId}},{access,fetcher:async()=>new Response('',{status:429,headers:{'retry-after':'1e99','x-rate-limit-reset':'1e99'}})});assert.equal(malformed.interrupted?.failureKind,'rate_limit');assert.ok(Number.isFinite(Date.parse(malformed.interrupted!.retryAt!)));
});
test('固定来源拒绝其他域名/账户，无配置或请求预算拒绝时不调用接口',async()=>{
 let calls=0;const fetcher:typeof fetch=async()=>{calls++;throw new Error('must not fetch');};
 await assert.rejects(fetchTiboTimeline({...TIBO_SOURCE,url:'https://x.com/other'},{access,fetcher}),TiboTimelineError);
 await assert.rejects(fetchTiboTimeline(TIBO_SOURCE,{fetcher,access:async()=>{throw new TiboTimelineError('未配置','configuration');}}),TiboTimelineError);
 const dependencies:TiboDependencies={fetcher,access:async()=>({...(await access()),beforeRequest:async()=>{throw new TiboTimelineError('额度已满','rate_limit');}})};
 await assert.rejects(fetchTiboTimeline(TIBO_SOURCE,dependencies),TiboTimelineError);assert.equal(calls,0);
});
test('验证只读一页、保存已核对身份，不把未归档样本跨入游标',async()=>{
 let calls=0;const baseline={userId,startTime:'2026-10-10T08:00:00.000Z'};
 const result=await fetchTiboTimeline({...TIBO_SOURCE,timelineScan:baseline},{access,clock:()=>Date.parse(at),validationOnly:true,fetcher:async()=>{calls++;return Response.json(page([post()],{meta:{result_count:1,newest_id:post().id,next_token:'tail'}}));}});
 assert.equal(calls,1);assert.deepEqual(result.scan,baseline);assert.equal(result.records.length,1);assert.equal(result.interrupted,undefined);
});
test('身份读取后额度用完仍保存身份；次轮不重复花请求查用户',async()=>{
 let remaining=1,calls=0;const budgetAccess=async()=>({...(await access()),beforeRequest:async()=>{if(!remaining)throw new TiboTimelineError('已达上限','rate_limit','2026-10-12T00:00:00.000Z');remaining--;}});
 const fetcher:typeof fetch=async input=>{calls++;return Response.json(new URL(String(input)).pathname.endsWith('/thsottiaux')?{data:{id:userId,username:'thsottiaux',protected:false}}:page([post()]));};
 const first=await fetchTiboTimeline(TIBO_SOURCE,{access:budgetAccess,fetcher,clock:()=>Date.parse(at)});assert.equal(calls,1);assert.equal(first.scan.userId,userId);assert.equal(first.headRead,false);assert.equal(first.interrupted?.failureKind,'rate_limit');
 remaining=1;const next=await fetchTiboTimeline({...TIBO_SOURCE,timelineScan:first.scan},{access:budgetAccess,fetcher,clock:()=>Date.parse(at)});assert.equal(calls,2);assert.equal(next.scan.sinceId,post().id);
});
test('尾页超额保存首页和断点；次轮优先尾页避免低预算永久积压',async()=>{
 let remaining=1;const requests:URL[]=[];const budgetAccess=async()=>({...(await access()),beforeRequest:async()=>{if(!remaining)throw new TiboTimelineError('已达上限','rate_limit','2026-10-12T00:00:00.000Z');remaining--;}});
 const baseline={userId,sinceId:'2108000000000000000'};
 const fetcher:typeof fetch=async input=>{const url=new URL(String(input));requests.push(url);return Response.json(url.searchParams.has('pagination_token')?page([post('2109000000000000000')]):page([post()],{meta:{result_count:1,newest_id:post().id,next_token:'tail'}}));};
 const first=await fetchTiboTimeline({...TIBO_SOURCE,timelineScan:baseline},{access:budgetAccess,fetcher,clock:()=>Date.parse(at)});assert.equal(first.records.length,1);assert.equal(first.scan.sinceId,baseline.sinceId);assert.equal(first.scan.nextToken,'tail');assert.equal(first.scan.preferTail,true);assert.equal(first.interrupted?.failureKind,'rate_limit');
 remaining=1;const second=await fetchTiboTimeline({...TIBO_SOURCE,timelineScan:first.scan},{access:budgetAccess,fetcher,clock:()=>Date.parse(at)});assert.equal(requests.length,2);assert.equal(requests[1].searchParams.get('pagination_token'),'tail');assert.equal(second.records[0].messageId,'2109000000000000000');assert.equal(second.scan.sinceId,post().id);assert.equal(second.scan.nextToken,undefined);
});
test('旧分页失效只清分页，从同一since继续追赶；已读新帖保留',async()=>{
 const sinceId='2108000000000000000';
 const first=await fetchTiboTimeline({...TIBO_SOURCE,timelineScan:{userId,sinceId,nextToken:'expired',pendingNewestId:post().id}},{access,clock:()=>Date.parse(at),fetcher:async input=>new URL(String(input)).searchParams.has('pagination_token')?new Response('raw-provider-body',{status:400}):Response.json(page([post('2109132167112782291')]))});
 assert.equal(first.records[0].messageId,'2109132167112782291');assert.deepEqual(first.scan,{userId,sinceId,startTime:undefined});assert.equal(first.interrupted?.failureKind,'rate_limit');
 const next=await fetchTiboTimeline({...TIBO_SOURCE,timelineScan:first.scan},{access,clock:()=>Date.parse(at),fetcher:async input=>{const url=new URL(String(input));assert.equal(url.searchParams.get('since_id'),sinceId);assert.equal(url.searchParams.has('pagination_token'),false);return Response.json(page([post()]));}});assert.equal(next.scan.sinceId,post().id);
});
test('尾页响应流中断保留成功首页，不回显底层错误或推进游标',async()=>{
 const source={...TIBO_SOURCE,timelineScan:{userId,sinceId:'2108000000000000000'}};
 const result=await fetchTiboTimeline(source,{access,clock:()=>Date.parse(at),fetcher:async input=>new URL(String(input)).searchParams.has('pagination_token')?new Response(new ReadableStream({start(controller){controller.error(new Error('secret-in-stream-error'));}})):Response.json(page([post()],{meta:{result_count:1,newest_id:post().id,next_token:'tail'}}))});
 assert.equal(result.records.length,1);assert.equal(result.interrupted?.failureKind,'transient');assert.ok(!result.interrupted?.message.includes('secret-in-stream-error'));assert.equal(result.scan.sinceId,source.timelineScan.sinceId);assert.equal(result.scan.nextToken,'tail');
});
test('明确缺父帖的部分错误可保存子帖；主帖和未知资源失败仍拒绝',()=>{
 const parent='2109045392684032299',child=post('2109132167112782291','Confirmed landed across all accounts.',{referenced_posts:[{type:'replied_to',id:parent}]});
 const error={resource_id:parent,resource_type:'tweet',type:'https://api.x.com/2/problems/resource-not-found'};
 const result=parseTiboPage(page([child],{errors:[error]}),userId,at);assert.equal(result.records[0].parentId,parent);assert.equal(result.records[0].contextComplete,false);
 for(const unsafe of [{...error,resource_id:child.id},{...error,resource_id:'2107000000000000000'},{...error,resource_type:'user'},{...error,type:'https://api.x.com/2/problems/client-forbidden'}])assert.throws(()=>parseTiboPage(page([child],{errors:[unsafe]}),userId,at),TiboTimelineError);
});
test('Tibo自己已完整声明重置完成时，引用外人也不混用外人正文',()=>{
 const own=post('2109132167112782291','We have completed the global reset for all paid accounts.',{referenced_posts:[{type:'quoted',id:'2109045392684032299'}]});
 const rows=parseTiboPage(page([own],{includes:{users:[{id:userId,username:'thsottiaux'}],tweets:[post('2109045392684032299','Something else',{author_id:'555'})]}}),userId,at).records;assert.equal(rows.length,1);assert.equal(rows[0].contextComplete,true);assert.equal(buildAutomaticTemplate(rows.map(row=>({...row,id:row.messageId,hash:'h',historical:false})))?.actions[0].stage,'claimed_complete');
});
