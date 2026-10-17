import test from 'node:test';
import assert from 'node:assert/strict';
import {activeResetWatch,validResetWatch,resetWatchRevision,type ResetWatch} from '../src/lib/reset-watch';
import {createResetWatchReader,parseResetWatchResponse,resetWatchVersion,withResetWatchEnvelope,withResetWatchData,RESET_WATCH_ENDPOINT} from '../src/server/reset-watch';
import type {PublicData} from '../src/lib/types';
import {referenceForecast} from '../src/lib/forecast';

const now = '2026-10-17T04:00:00.000Z';
function response() {
 return {data:{latest_reset:{announced_at:'2026-10-15T06:28:13.000Z'},scheduled_reset:null,active_watch:{level:'elevated',reset_chance_percent:73,forecast_window:'within 10 hours',observed_at:'2026-10-16T19:00:00.000Z',expires_at:'2026-10-17T05:00:00.000Z',text:"Let's break the cycle.",source:{type:'x_post',author:'thsottiaux',url:'https://x.com/thsottiaux/status/2111176111111111111'}}},meta:{api_version:'v1',generated_at:now}};
}
const watch=()=>parseResetWatchResponse(response(),now);
const stub=(fn:(url:RequestInfo|URL,init?:RequestInit)=>Promise<Response>)=>fn as typeof fetch;

test('只读信号保留来源与观察期限，第三方概率不成为本站概率',()=>{
 const result=watch();assert.equal(result.status,'active');assert.ok(validResetWatch(result));
 assert.equal(result.signal?.sourceUrl,response().data.active_watch.source.url);
 assert.equal(result.signal?.forecastWindow,'within 10 hours');
 assert.ok(!JSON.stringify(result).includes('73'));assert.ok(!('predictedAt' in result.signal!));
 assert.equal(activeResetWatch(result,now)?.text,"Let's break the cycle.");
 const input=response();input.data.active_watch=null as any;
 assert.deepEqual(parseResetWatchResponse(input,now),{status:'none',checkedAt:now});
});
test('信号到期、未来检查时间、后续完成或安排都会停止展示，不能自动确认完成',()=>{
 const value=watch();assert.equal(activeResetWatch(value,'2026-10-17T05:00:00.000Z'),undefined);
 assert.equal(activeResetWatch(value,'2026-10-17T03:59:59.000Z'),undefined);
 assert.equal(activeResetWatch(value,now,'2026-10-16T19:00:00.000Z'),undefined);
 assert.ok(activeResetWatch(value,now,'2026-10-15T00:00:00.000Z'));
 const expired=response();expired.data.active_watch.expires_at='2026-10-17T04:00:00.000Z';assert.equal(parseResetWatchResponse(expired,now).status,'none');
 const completed=response();completed.data.latest_reset.announced_at='2026-10-17T03:00:00.000Z';assert.equal(parseResetWatchResponse(completed,now).status,'none');
 const scheduled=response();scheduled.data.scheduled_reset={status:'scheduled'} as any;assert.equal(parseResetWatchResponse(scheduled,now).status,'none');
});
test('接口结构、时效、作者、来源和文本长度不可信时拒绝，不伪装无信号',()=>{
 const variants=[
  (v:any)=>{delete v.data.active_watch;},(v:any)=>{delete v.data.scheduled_reset;},
  (v:any)=>{v.meta.api_version='v2';},(v:any)=>{v.meta.generated_at='2026-10-17T03:44:59.000Z';},
  (v:any)=>{v.meta.generated_at='2026-10-17T04:00:01.000Z';},
  (v:any)=>{v.data.active_watch.observed_at='2026-10-17T04:00:01.000Z';},
  (v:any)=>{v.data.active_watch.observed_at='2026-02-30T00:00:00.000Z';},
  (v:any)=>{v.data.active_watch.expires_at=v.data.active_watch.observed_at;},
  (v:any)=>{v.data.active_watch.source.url='https://x.com.evil.test/thsottiaux/status/2111176111111111111';},
  (v:any)=>{v.data.active_watch.source.url+='?redirect=evil';},
  (v:any)=>{v.data.active_watch.source.author='other';},
  (v:any)=>{v.data.active_watch.source.type='unknown';},
  (v:any)=>{v.data.active_watch.text='a'.repeat(4001);},
  (v:any)=>{v.data.active_watch.forecast_window='a'.repeat(201);},
  (v:any)=>{v.data.active_watch.reset_chance_percent=1.1;},
  (v:any)=>{v.data.active_watch.level='official';},
 ];
 for(const change of variants){const value=response();change(value);assert.throws(()=>parseResetWatchResponse(value,now));}
 assert.equal(validResetWatch({...watch(),status:'none'}),false);
});
test('并发合并为一次读取，五分钟缓存不会延长信号原始截止时间',async()=>{
 let clock=Date.parse(now),calls=0;let release!:(r:Response)=>void;
 const read=createResetWatchReader({now:()=>clock,fetcher:stub(async(url,init)=>{
  calls++;assert.equal(url,RESET_WATCH_ENDPOINT);assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');
  return new Promise(resolve=>{release=resolve;});
 })});
 const pending=Array.from({length:30},()=>read());assert.equal(calls,1);
 release(Response.json(response()));assert.equal((await Promise.all(pending)).every(v=>v.status==='active'),true);
 clock+=299999;assert.equal((await read()).checkedAt,now);assert.equal(calls,1);
 clock+=1;const next=read();assert.equal(calls,2);const data=response();data.meta.generated_at=new Date(clock).toISOString();release(Response.json(data));await next;
 clock=Date.parse('2026-10-17T05:00:00.000Z');const last=read();const expired=response();expired.meta.generated_at=new Date(clock).toISOString();release(Response.json(expired));assert.equal((await last).status,'none');
});
test('缓存内也即时过期；失败撤下旧信号且五分钟内不反复请求',async()=>{
 let clock=Date.parse(now),calls=0,fail=false;
 const payload=response();payload.data.active_watch.expires_at='2026-10-17T04:02:00.000Z';
 const read=createResetWatchReader({now:()=>clock,fetcher:stub(async()=>{calls++;if(fail)throw Error('network unavailable');return Response.json(payload);})});
 assert.equal((await read()).status,'active');clock+=120000;assert.equal((await read()).status,'none');assert.equal(calls,1);
 clock+=180000;fail=true;const unavailable=await read();assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.signal,undefined);assert.equal(calls,2);
 await read();await read();assert.equal(calls,2);
});
test('超时和过大响应都有界失败，未收到可验证响应不使用旧数据',async()=>{
 const hanging=createResetWatchReader({now:()=>Date.parse(now),timeoutMs:10,fetcher:stub(async()=>new Promise(()=>{}))});
 assert.equal((await hanging()).status,'unavailable');
 const oversized=createResetWatchReader({now:()=>Date.parse(now),fetcher:stub(async()=>new Response('a'.repeat(65537),{headers:{'content-type':'application/json'}}))});
 assert.equal((await oversized()).status,'unavailable');
 const wrongType=createResetWatchReader({now:()=>Date.parse(now),fetcher:stub(async()=>new Response('<html>gateway</html>',{headers:{'content-type':'text/html'}}))});
 assert.equal((await wrongType()).status,'unavailable');
});
test('检查时刻不改变版本，内容、失效、失联转换会改变版本',()=>{
 const value=watch(),later={...value,checkedAt:'2026-10-17T04:01:00.000Z'};
 assert.equal(resetWatchVersion('base',value,'2026-10-17T04:01:00.000Z'),resetWatchVersion('base',later,'2026-10-17T04:01:00.000Z'));
 assert.notEqual(resetWatchVersion('base',value,now),resetWatchVersion('base',value,'2026-10-17T05:00:00.000Z'));
 assert.notEqual(resetWatchVersion('base',value,now),resetWatchVersion('base',{status:'unavailable',checkedAt:now},now));
 assert.deepEqual(resetWatchRevision(value,'2026-10-17T05:00:00.000Z'),{status:'none'});
 assert.equal(resetWatchVersion('base',{status:'none',checkedAt:now},now),resetWatchVersion('base',{status:'none',checkedAt:'2026-10-17T04:01:00.000Z'},'2026-10-17T04:01:00.000Z'));
});
test('公开读取投影不修改公告或提醒；所有视图版本包含同一信号摘要',()=>{
 const facts={events:[],articles:[],publications:[],evidence:[],notices:[],activities:[],sources:[],site:{name:'test',description:'',version:1,autoPublish:false},serverTime:now} satisfies PublicData;
 assert.equal(withResetWatchData(facts,watch()),facts);
 const data={...facts,forecasts:{status:'ready',ruleVersion:'test',modelVersion:'test',generatedAt:now,cases:[],reference:referenceForecast()}} as PublicData;
 const result=withResetWatchEnvelope({data,version:'base',contentVersion:'base'},watch(),now);
 assert.equal(result.data.forecasts?.watch?.status,'active');assert.equal(data.forecasts?.watch,undefined);
 assert.equal(result.data.notices,data.notices);assert.equal(result.data.events,data.events);
 const state=withResetWatchEnvelope({data:facts,version:'base',contentVersion:'base'},watch(),now);
 assert.equal(state.contentVersion,result.contentVersion);assert.equal(state.data.forecasts,undefined);
});
