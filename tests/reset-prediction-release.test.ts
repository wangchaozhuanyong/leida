import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseResetWatchResponse,createResetWatchReader,safeResetWatchFailure,publicWatchForClient} from '../src/server/reset-watch';
import {validResetWatch,activeResetSchedule} from '../src/lib/reset-watch';
import {statusTimelineModel,statusTimelineRevision,currentStatusModel,statusPosterSnapshot} from '../src/lib/status-timeline';
import {InstrumentDial} from '../src/components/public/InstrumentDial';
import {StatusTimeline} from '../src/components/public/StatusTimeline';
import {assertStatusPosterRound,currentStatusPosterSvg} from '../src/server/status-poster';
import {referenceForecast,type ForecastPublicData} from '../src/lib/forecast';
import type {PublicData,Publication} from '../src/lib/types';
const require=createRequire(import.meta.url);
const native=require('../miniprogram/utils/status-timeline.js');
const nativeModel=require('../miniprogram/utils/model.js');
const nativePoster=require('../miniprogram/utils/status-poster.js');
const now='2026-10-17T04:00:00.000Z';
const source={type:'x_post',author:'thsottiaux',url:'https://x.com/thsottiaux/status/2111176111111111111'};
function response():any {return {meta:{api_version:'v1',generated_at:now},data:{latest_reset:{reset_type:'regular',announced_at:'2026-10-15T06:28:13Z'},scheduled_reset:null,active_watch:{level:'elevated',reset_chance_percent:73,forecast_window:'within 10 hours',observed_at:'2026-10-16T19:00:00Z',expires_at:'2026-10-17T05:00:00Z',text:'A possible reset, not a commitment.',source}}};}
function data(input=response()):PublicData {return {serverTime:now,site:{name:'模钥重置雷达',description:'隔离测试',autoPublish:false,version:1},events:[],articles:[],publications:[],evidence:[],notices:[],activities:[],sources:[],forecasts:{status:'ready',generatedAt:now,ruleVersion:'test',modelVersion:'test',cases:[],reference:referenceForecast(),watch:parseResetWatchResponse(input,now)}};}
function schedule(input=response()):any {input.data.scheduled_reset={id:'pending-bank-1',status:'scheduled',reset_type:'banked',announced_at:'2026-10-17T03:00:00Z',scheduled_for:'2026-10-17T05:00:00Z',text:'Banked reset remains scheduled.',source};return input;}
function addCompletion(value:PublicData){
  const pub:Publication={id:'completed-pub',eventId:'completed-event',articleId:'completed-article',publishedAt:'2026-10-17T03:30:00Z',cutoffAt:'2026-10-17T03:30:00Z',reason:'隔离测试',mode:'state_change',event:{id:'completed-event',title:'普通重置已完成',version:1,status:'published',publicationId:'completed-pub',evidenceIds:[],updatedAt:now,actions:[{id:'complete-1',kind:'automatic_reset',scope:'public',stage:'claimed_complete',statementAt:'2026-10-17T03:30:00Z',eligibility:'公开用户',evidenceIds:[]}]},article:{id:'completed-article',eventId:'completed-event',publicationId:'completed-pub',title:'普通重置已完成',summary:'公开完成声明',translation:'',category:'reset',version:1,status:'published',evidenceIds:[],publishedAt:'2026-10-17T03:30:00Z',updatedAt:now}};
  value.publications=[pub];value.events=[structuredClone(pub.event)];value.articles=[structuredClone(pub.article)];return value;
}
test('发卡与普通重置交错，以及同类不同轮次完成，都不能清除上游仍返回的待执行预告',()=>{
  for(const kind of ['regular','banked']){
    const input=schedule();input.data.latest_reset={reset_type:kind,announced_at:'2026-10-17T03:30:00Z'};
    const value=data(input),watch=value.forecasts!.watch!;
    assert.ok(activeResetSchedule(watch,now));
    addCompletion(value);
    const view=currentStatusModel(value);
    assert.equal(view.title,'01:00');assert.equal(view.kind,'banked_reset');assert.equal(view.completed,false);
    assert.deepEqual(native.statusTimelineModel(nativeModel.resetOutlookModel(value),now,null,value.forecasts),view);
    assert.equal(currentStatusModel({...value,serverTime:'2026-10-17T05:00:00Z'}).title,'等待确认');
  }
});
test('较新的明确预告接替旧安排；检查时钟和倒计时不改变同一轮海报版本',()=>{
  const value=data(schedule()),outlook={status:'scheduled' as const,active:{actionId:'old-action',eventId:'old-event',publicationId:'old-pub',kind:'automatic_reset' as const,stage:'promised' as const,statementAt:'2026-10-17T02:00:00Z',expectedAt:'2026-10-17T06:00:00Z'}};
  const view=statusTimelineModel(outlook,now,null,value.forecasts);
  assert.equal(view.kind,'banked_reset');assert.equal(view.title,'01:00');
  assert.equal(statusTimelineRevision(view),statusTimelineRevision(statusTimelineModel(outlook,'2026-10-17T04:30:00Z',null,value.forecasts)));
});
test('九小时前的窗口明确归属信号发布时间，不重新变成从现在起未来十小时',()=>{
  const value=data(),view=currentStatusModel(value);
  assert.equal(view.forecastWindow,'10小时内');assert.equal(view.observedLabel,'信号时间 2026-10-17 03:00');
  assert.equal(view.note,'观察有效至 2026-10-17 13:00');
  const html=renderToStaticMarkup(createElement(StatusTimeline,{outlook:{status:'monitoring'},serverTime:now,forecasts:value.forecasts}));
  assert.match(html,/信号发布时预计：10小时内/);assert.match(html,/信号时间 2026-10-17 03:00/);assert.doesNotMatch(html,/未来10小时/);
});
test('观察来源允许无链接并始终署名，旧推文响应兼容；两端同时拒绝危险链接',()=>{
  for(const scheduled of [false,true])for(const url of [undefined,'https://codex-resets.com/']){
    const input=scheduled?schedule():response();const entry=scheduled?input.data.scheduled_reset:input.data.active_watch;
    entry.source={type:'observed',...(url?{url}:{})};const value=data(input),watch=value.forecasts!.watch!;
    assert.ok(validResetWatch(watch));assert.ok(nativeModel.validateResetWatch(watch));
    const view=currentStatusModel(value);assert.equal(view.sourceType,'observed');assert.equal(view.sourceCredit,true);assert.equal(view.sourceUrl,url??'');
    assert.deepEqual(native.statusTimelineModel({status:'monitoring'},now,null,value.forecasts),view);
    const html=renderToStaticMarkup(createElement(StatusTimeline,{outlook:{status:'monitoring'},serverTime:now,forecasts:value.forecasts}));
    assert.match(html,/数据来自 Codex Resets/);assert.doesNotMatch(html,/href=""/);
  }
  const legacy=parseResetWatchResponse(response(),now);assert.ok(validResetWatch(legacy));assert.ok(nativeModel.validateResetWatch(legacy));
  for(const url of ['javascript:alert(1)','https://user:password@example.com',' https://example.com','http://example.com']){
    const input=response();input.data.active_watch.source={type:'observed',url};assert.throws(()=>parseResetWatchResponse(input,now));
    const watch={...legacy,signal:{...legacy.signal,sourceType:'observed',sourceUrl:url}};assert.equal(validResetWatch(watch),false);assert.equal(nativeModel.validateResetWatch(watch),false);
  }
});
test('两款网页/小程序海报跟随同一状态，旧完成不遮盖新预告和观察，状态变更拒绝旧图',()=>{
  const empty=response();empty.data.active_watch=null;
  for(const value of [data(empty),data(),data(schedule()),addCompletion(data(empty)),addCompletion(data(schedule()))]){
    const web=statusPosterSnapshot(value),mini=nativePoster.statusPosterInput(value);
    for(const key of ['round','publicationId','generatedAt','title','label','value','unit','statementAt','statementLabel','nextNote','sourceLabel','validUntil'] as const)assert.equal(mini[key],web[key],key);
    assert.ok(nativePoster.statusPosterAvailable(mini,value));
    for(const style of ['precision','editorial'] as const){
      const svg=currentStatusPosterSvg(value,now,web.round,style);assert.ok(svg.includes(web.title));assert.ok(svg.includes(web.value));
      const layout=nativePoster.createStatusPosterLayout(mini,(t:string,size:number)=>t.length*size,style);assert.ok(layout.commands.filter((c:any)=>c.type==='text').map((c:any)=>c.value).join('').includes(mini.title));
    }
    const changed=data();changed.forecasts!.watch={status:'none',checkedAt:now};
    if(web.round!==statusPosterSnapshot(changed).round){assert.throws(()=>assertStatusPosterRound(changed,web.round),/已变化/);assert.equal(nativePoster.statusPosterAvailable(mini,changed),false);}
  }
  const value=data(),snap=statusPosterSnapshot(value);assert.equal(snap.publicationId,'');
  assert.throws(()=>currentStatusPosterSvg({...value,serverTime:'2026-10-17T05:00:00Z'},now,snap.round),/已变化/);
});
test('原生海报在信号到期时主动清除预览和缓存，不能切换风格或继续保存旧图',()=>{
  let definition:any,clock=Date.parse(now);const timers:any[]=[];
  const value=data(),state={data:value,receivedAt:clock};
  class ClockDate extends Date {static now(){return clock;}}
  new Script(readFileSync('miniprogram/pages/poster/index.js','utf8')).runInNewContext({Date:ClockDate,Page(d:any){definition=d;},wx:{},getApp:()=>({client:{getState:()=>state}}),setTimeout(fn:()=>void,delay:number){const timer={fn,delay,unref(){}};timers.push(timer);return timer;},clearTimeout(){},require(path:string){if(path.endsWith('/page'))return {createPage:(_build:unknown,extra:any)=>({...extra,...extra.methods})};if(path.endsWith('/status-poster'))return nativePoster;if(path.endsWith('/poster'))return {};return {privacyRequired:async()=>false};}});
  const page={...definition,data:{...definition.data},_active:true,_artifacts:{precision:{artifact:{tempFilePath:'old.png'}}},setData(patch:any){Object.assign(this.data,patch);},generate(){}};
  page.afterRender();assert.ok(page._snapshot);assert.ok(timers.some(t=>t.delay===3600020));
  page.data.preview='old.png';clock+=3600020;timers.find(t=>t.delay===3600020).fn();
  assert.equal(page.data.preview,'');assert.match(page.data.blocked,/状态已变化/);assert.equal(Object.keys(page._artifacts).length,0);
  assert.equal(page.onShareAppMessage().path,'/pages/home/index');
});
test('信号读取失败只有固定安全分类，并发与失败缓存不重复记录敏感错误正文',async()=>{
  const scenarios:[typeof fetch,string][]=[
    [async()=>new Response('',{status:429}),'HTTP_4XX'],
    [async()=>new Response('',{status:503}),'HTTP_5XX'],
    [async()=>new Response('<html>secret</html>'),'CONTENT_TYPE'],
    [async()=>new Response('invalid-secret',{headers:{'content-type':'application/json'}}),'JSON_INVALID'],
    [async()=>{throw new Error('secret-token',{cause:{code:'ENOTFOUND'}});},'NETWORK_DNS'],
    [async()=>{throw new Error('secret-token',{cause:{code:'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'}});},'NETWORK_TLS'],
    [async()=>{const input=response();input.meta.generated_at='2026-10-17T03:00:00Z';return Response.json(input);},'RESPONSE_STALE'],
  ];
  for(const [fetcher,code]of scenarios){const errors:string[]=[];const read=createResetWatchReader({fetcher,now:()=>Date.parse(now),onFailure:reason=>errors.push(reason)});assert.equal((await read()).status,'unavailable');await read();assert.deepEqual(errors,[code]);assert.doesNotMatch(JSON.stringify(errors),/secret/);}
  assert.equal(safeResetWatchFailure(new Error('unknown secret')),'NETWORK');
});

test('旧小程序仍可浏览基本资料，新版能力声明才接收无推文URL的观察记录',()=>{
  const input=response();input.data.active_watch.source={type:'observed'};
  const value=data(input),old=publicWatchForClient(value,false),modern=publicWatchForClient(value,true);
  assert.equal(modern,value);assert.equal(modern.forecasts!.watch!.signal!.sourceType,'observed');
  assert.equal(old.forecasts!.watch!.status,'unavailable');assert.equal(old.forecasts!.watch!.signal,undefined);
  assert.equal(old.events,value.events);assert.equal(old.publications,value.publications);assert.ok(nativeModel.validateForecastPublicData(old.forecasts));
  assert.ok(publicWatchForClient(data(),false).forecasts!.watch!.signal);
});

test('桌面表盘与手机状态共用信号发布时间表达，无链接观察仍有来源署名',()=>{
  const input=response();input.data.active_watch.source={type:'observed'};const value=data(input);
  const html=renderToStaticMarkup(createElement(InstrumentDial,{outlook:{status:'monitoring'},serverTime:now,forecasts:value.forecasts}));
  assert.match(html,/信号发布时预计：10小时内/);assert.match(html,/信号时间 2026-10-17 03:00/);assert.match(html,/数据来自 Codex Resets/);assert.doesNotMatch(html,/未来10小时|href=""/);
  const scheduled=data(schedule());const chart=renderToStaticMarkup(createElement(InstrumentDial,{outlook:{status:'monitoring'},serverTime:now,forecasts:scheduled.forecasts}));
  assert.match(chart,/is-scheduled/);assert.match(chart,/01:00/);
});
test('接受协议允许的微秒和时区日期，并规范成旧客户端也可读取的UTC毫秒',()=>{
  const input=response();input.meta.generated_at='2026-10-17T12:00:00.000000+08:00';input.data.active_watch.observed_at='2026-10-17T03:00:00.000000+08:00';input.data.active_watch.expires_at='2026-10-17T13:00:00.000000+08:00';
  const result=parseResetWatchResponse(input,now);assert.equal(result.signal!.observedAt,'2026-10-16T19:00:00.000Z');assert.equal(result.signal!.expiresAt,'2026-10-17T05:00:00.000Z');assert.ok(nativeModel.validateResetWatch(result));
  input.data.active_watch.observed_at='2026-02-30T03:00:00.000000+08:00';assert.throws(()=>parseResetWatchResponse(input,now));
});

test('即使类型和时间相同，新的上游预告ID也使上一轮海报失效',()=>{
  const original=data(schedule()),snapshot=statusPosterSnapshot(original);
  const changed=data(schedule());changed.forecasts!.watch!.scheduledReset!.id='pending-bank-2';
  assert.notEqual(snapshot.round,statusPosterSnapshot(changed).round);assert.throws(()=>assertStatusPosterRound(changed,snapshot.round),/已变化/);
  assert.equal(nativePoster.statusPosterAvailable(nativePoster.statusPosterInput(original),changed),false);
});

test('预告海报圈内标签保留安全宽度，单位独立显示，预计时刻不拆成单个数字',()=>{
  const value=data(schedule()),snapshot=statusPosterSnapshot(value),mini=nativePoster.statusPosterInput(value);
  assert.match(snapshot.nextNote,/\n13:00$/);
  const measure=(text:string,size:number)=>Array.from(text).reduce((n,c)=>n+(/[a-z0-9 :]/i.test(c)?.56:1)*size,0);
  for(const style of ['precision','editorial'] as const){
    const svg=currentStatusPosterSvg(value,now,snapshot.round,style);assert.match(svg,/>13:00<\/text>/);assert.match(svg,/>小时 : 分钟<\/text>/);
    const layout=nativePoster.createStatusPosterLayout(mini,measure,style);
    assert.ok(layout.commands.some((c:any)=>c.value==='13:00'));
    if(style==='precision'){const label=layout.commands.find((c:any)=>c.value===mini.label);assert.ok(measure(label.value,label.size)<=390.01);const unit=layout.commands.find((c:any)=>c.value==='小时 : 分钟');assert.ok(unit.y>label.y);}
  }
});
