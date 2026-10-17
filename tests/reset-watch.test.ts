import test from 'node:test';
import assert from 'node:assert/strict';
import {activeResetWatch,validResetWatch,resetWatchRevision,type ResetWatch} from '../src/lib/reset-watch';
import {createResetWatchReader,parseResetWatchResponse,resetWatchVersion,withResetWatchEnvelope,withResetWatchData,publicWatchForClient,RESET_WATCH_ENDPOINT} from '../src/server/reset-watch';
import type {PublicData} from '../src/lib/types';
import {referenceForecast} from '../src/lib/forecast';
import {createRequire} from 'node:module';
import {statusTimelineModel} from '../src/components/public/StatusTimeline';
import {buildResetCadenceForecast} from '../src/lib/reset-cadence';
const native=createRequire(import.meta.url)('../miniprogram/utils/status-timeline.js');
const nativeModel=createRequire(import.meta.url)('../miniprogram/utils/model.js');
const nativeCadence=createRequire(import.meta.url)('../miniprogram/utils/cadence.js');

const now = '2026-10-17T04:00:00.000Z';
function response() {
 return {data:{latest_reset:{announced_at:'2026-10-15T06:28:13.000Z'},scheduled_reset:null,active_watch:{level:'elevated',reset_chance_percent:73,forecast_window:'within 10 hours',observed_at:'2026-10-16T19:00:00.000Z',expires_at:'2026-10-17T05:00:00.000Z',text:"Let's break the cycle.",source:{type:'x_post',author:'thsottiaux',url:'https://x.com/thsottiaux/status/2111176111111111111'}}},meta:{api_version:'v1',generated_at:now}};
}
const watch=()=>parseResetWatchResponse(response(),now);
const stub=(fn:(url:RequestInfo|URL,init?:RequestInit)=>Promise<Response>)=>fn as typeof fetch;

test('上游信号概率和预测窗口原样归属上游，不从历史间隔另造日期或概率',()=>{
 const read=watch(),forecasts={status:'ready' as const,generatedAt:now,ruleVersion:'test',modelVersion:'test',cases:[],reference:referenceForecast(),watch:read};
 const view=statusTimelineModel({status:'monitoring'},now,null,forecasts);
 assert.equal(view.forecastWindow,'10小时内');assert.equal(view.chanceLabel,'上游信号概率 73%');assert.equal(view.scheduled,false);
 assert.deepEqual(native.statusTimelineModel({status:'monitoring'},now,null,forecasts),view);
 const input=response();input.data.active_watch.reset_chance_percent=null as any;
 assert.equal(statusTimelineModel({status:'monitoring'},now,null,{...forecasts,watch:parseResetWatchResponse(input,now)}).chanceLabel,'');
});

test('公开安排优先于模糊信号，支持未知时间；过点只等待确认，不计作完成',()=>{
 const input=response();
 input.data.scheduled_reset={id:'scheduled-1',status:'scheduled',reset_type:'banked',announced_at:'2026-10-17T03:00:00Z',scheduled_for:'2026-10-17T05:00:00Z',text:'Banked reset coming within two hours.',source:input.data.active_watch.source} as any;
 const parsed=parseResetWatchResponse(input,now);
 assert.equal(parsed.status,'none');assert.equal(parsed.signal,undefined);assert.equal(parsed.scheduledReset?.kind,'banked_reset');
 const forecasts={status:'ready' as const,generatedAt:now,ruleVersion:'test',modelVersion:'test',cases:[],reference:referenceForecast(),watch:parsed};
 assert.notEqual(resetWatchVersion('base',parsed,now),resetWatchVersion('base',parsed,'2026-10-17T05:00:00Z'),'预告过点改变公开版本，已有缓存也会重新读取');
 for(const at of [now,'2026-10-17T05:00:00Z']){
   const view=statusTimelineModel({status:'monitoring'},at,null,forecasts);
   assert.deepEqual(native.statusTimelineModel({status:'monitoring'},at,null,forecasts),view);
   assert.equal(view.completed,false);assert.equal(view.watching,false);assert.equal(view.chanceLabel,'');assert.equal(view.sourceUrl,input.data.active_watch.source.url);
   assert.equal(view.title,at===now?'1小时0分钟':'等待确认');
 }
 (input.data.scheduled_reset as any).scheduled_for=null;
 const unknown=statusTimelineModel({status:'monitoring'},now,null,{...forecasts,watch:parseResetWatchResponse(input,now)});
 assert.equal(unknown.title,'时间待明确');assert.equal(unknown.scheduled,false);
 const stale=structuredClone(input);stale.data.latest_reset.announced_at='2026-10-17T03:30:00Z';
 assert.ok(parseResetWatchResponse(stale,now).scheduledReset,'来源仍标记待执行的预告，不能靠另一条完成消息的时间推断结束');
});

test('只读信号保留来源与观察期限，第三方概率不成为本站概率',()=>{
 const result=watch();assert.equal(result.status,'active');assert.ok(validResetWatch(result));
 assert.equal(result.signal?.sourceUrl,response().data.active_watch.source.url);
 assert.equal(result.signal?.forecastWindow,'within 10 hours');
 assert.equal(result.signal?.chancePercent,73);assert.ok(!('predictedAt' in result.signal!));
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
 const scheduled=response();scheduled.data.scheduled_reset={status:'scheduled'} as any;assert.throws(()=>parseResetWatchResponse(scheduled,now),/scheduled reset/);
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
test('缓存内也即时过期；读取失败撤下旧信号且冷却期内不反复请求',async()=>{
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

function wideHistoricalForecast(currentWatch:ResetWatch):PublicData {
 const generated=Date.parse(now),observations=Array.from({length:10},(_,i)=>{const at=new Date(generated-(9-i)*48*3600000).toISOString();return {id:`e${i}`,url:`https://x.com/thsottiaux/status/${100+i}`,evidenceIds:[`e${i}`],kind:'automatic_reset' as const,at,firstKnownAt:at,timePrecision:'exact' as const};});
 const estimated=buildResetCadenceForecast({observations,generatedAt:now,target:'automatic_reset',inputFingerprint:'isolated-wide-interval'});
 const cadence={...estimated,windowStart:'2026-10-18T14:21:41.000Z',predictedAt:'2026-10-24T06:42:25.000Z',windowEnd:'2026-11-05T06:42:25.000Z'};
 assert.equal(cadence.status,'ready');
 return {events:[],articles:[],publications:[],evidence:[],notices:[],activities:[],sources:[],site:{name:'test',description:'',version:1,autoPublish:false},serverTime:now,forecasts:{status:'ready',ruleVersion:'test',modelVersion:'test',generatedAt:now,cases:[],reference:referenceForecast(),outlook:{status:'monitoring'},watch:currentWatch,cadence,cadenceByKind:{automatic_reset:cadence},cadenceHistory:[cadence],cadenceOutcomes:[]}};
}

test('普通公开响应不再向新旧客户端提供历史区间，旧首页也不能继续估算10月18日至11月5日',()=>{
 for(const currentWatch of [{status:'none',checkedAt:now},{status:'unavailable',checkedAt:now},watch()] as ResetWatch[]){
  const data=wideHistoricalForecast(currentWatch),before=structuredClone(data);
  assert.equal(nativeCadence.cadenceModel(data.forecasts,now).ready,true,'必须先证明旧消费者会采用输入区间');
  for(const acceptsObserved of [true,false]){
   const projected=publicWatchForClient(data,acceptsObserved);
   for(const key of ['cadence','cadenceByKind','cadenceHistory','cadenceEvaluationByKind','cadenceOutcomes','cadenceHorizonOutcomes'])assert.equal(projected.forecasts?.[key as keyof NonNullable<PublicData['forecasts']>],undefined,key);
   assert.equal(nativeModel.validateForecastPublicData(projected.forecasts),true,'保留旧客户端所需响应合同');
   assert.equal(nativeCadence.cadenceModel(projected.forecasts,now).ready,false);
   assert.equal(nativeCadence.cadenceModel(projected.forecasts,now).rangeLabel,'');
   assert.deepEqual(projected.forecasts?.outlook,data.forecasts?.outlook);
   assert.deepEqual(projected.forecasts?.watch,currentWatch);
   assert.equal(projected.publications,data.publications);assert.equal(projected.notices,data.notices);
  }
  assert.deepEqual(data,before,'不改写数据库或固定实验快照');
 }
});

test('明确打开历史实验视图时仍可读原始快照，观察来源兼容降级不丢失历史记录',()=>{
 const data=wideHistoricalForecast(watch()),before=structuredClone(data);
 const history=publicWatchForClient(data,true,true);
 assert.equal(history.forecasts?.cadence,data.forecasts?.cadence);
 assert.equal(history.forecasts?.cadenceHistory,data.forecasts?.cadenceHistory);
 const observed:PublicData={...data,forecasts:{...data.forecasts!,watch:{status:'active',checkedAt:now,signal:{...watch().signal!,sourceType:'observed',sourceUrl:undefined}}}};
 const legacyHistory=publicWatchForClient(observed,false,true);
 assert.equal(legacyHistory.forecasts?.watch?.status,'unavailable');
 assert.equal(legacyHistory.forecasts?.cadence,observed.forecasts?.cadence);
 assert.deepEqual(data,before);
});


test('慢响应先放行页面，继续共享同一次读取；成功结果补入缓存而非缓存五分钟假失败',async()=>{
 let calls=0;let release!:(r:Response)=>void;const failures:string[]=[];
 const read=createResetWatchReader({now:()=>Date.parse(now),timeoutMs:1000,responseBudgetMs:5,onFailure:code=>failures.push(code),fetcher:stub(async()=>{calls++;return new Promise(resolve=>{release=resolve;});})});
 const first=await read();assert.equal(first.status,'unavailable');assert.equal(read.refreshing(),true);
 assert.equal((await read()).status,'unavailable');assert.equal(calls,1);assert.deepEqual(failures,[]);
 release(Response.json(response()));await read.settle();assert.equal(read.refreshing(),false);
 assert.equal((await read()).status,'active');assert.equal(calls,1);assert.deepEqual(failures,[]);
 await read.settle();assert.equal(calls,1,'settle仅等待已有请求，不启动额外采集');
});

test('实际超时覆盖连接和正文阶段，终止请求后只记录安全分类；一分钟后才允许重试',async()=>{
 for(const phase of ['headers','body'] as const){
  let calls=0,clock=Date.parse(now),aborted=false;const failures:{code:string;phase:string;elapsedMs:number}[]=[];
  const read=createResetWatchReader({now:()=>clock,timeoutMs:20,responseBudgetMs:2,onFailure:(code,details)=>failures.push({code,...details}),fetcher:stub(async(_url,init)=>{
   calls++;init!.signal!.addEventListener('abort',()=>{aborted=true;});
   if(phase==='headers')return new Promise(()=>{});
   return new Response(new ReadableStream({start(controller){init!.signal!.addEventListener('abort',()=>controller.error(new Error('private body discarded')));}}),{headers:{'content-type':'application/json'}});
  })});
  assert.equal((await read()).status,'unavailable');await read.settle();
  assert.equal(aborted,true);assert.equal(read.refreshing(),false);assert.equal(failures.length,1);assert.equal(failures[0].code,'TIMEOUT');assert.equal(failures[0].phase,phase);assert.ok(failures[0].elapsedMs>=0);
  clock+=59999;await read();assert.equal(calls,1);clock+=1;await read();assert.equal(calls,2);await read.settle();assert.equal(failures.length,2);
  assert.doesNotMatch(JSON.stringify(failures),/private|https|token/);
 }
});

test('后台刷新期间可用的旧信号仍按原时间过期，迟到的新结果不会延长旧观察',async()=>{
 let clock=Date.parse(now),calls=0;let release!:(r:Response)=>void;
 const first=response();first.data.active_watch.expires_at='2026-10-17T04:05:01.000Z';
 const read=createResetWatchReader({now:()=>clock,timeoutMs:1000,responseBudgetMs:2,onFailure:()=>assert.fail('不应失败'),fetcher:stub(async()=>{calls++;return calls===1?Response.json(first):new Promise(resolve=>{release=resolve;});})});
 assert.equal((await read()).status,'active');clock+=300000;
 assert.equal((await read()).status,'active');assert.equal(read.refreshing(),true);
 clock+=1000;assert.equal((await read()).status,'none');assert.equal(calls,2);
 const fresh=response();fresh.meta.generated_at=new Date(clock).toISOString();fresh.data.active_watch=null as any;
 release(Response.json(fresh));await read.settle();assert.equal((await read()).status,'none');assert.equal(calls,2);
});
