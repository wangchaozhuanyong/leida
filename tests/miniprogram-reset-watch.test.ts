import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {referenceForecast} from '../src/lib/forecast';
import {buildResetCadenceForecast} from '../src/lib/reset-cadence';
import {cadenceDisplay} from '../src/lib/cadence-display';
import {statusTimelineModel as webTimeline} from '../src/components/public/StatusTimeline';

const require=createRequire(import.meta.url);
const m=require('../miniprogram/utils/model.js');
const {statusTimelineModel}=require('../miniprogram/utils/status-timeline.js');
const {cadenceModel}=require('../miniprogram/utils/cadence.js');
const now='2026-10-17T04:00:00.000Z';
const expiry='2026-10-17T05:00:00.000Z';
const signal={sourceUrl:'https://x.com/thsottiaux/status/2110618732666257557',text:"Let's break the cycle.",level:'elevated',observedAt:'2026-10-17T03:00:00.000Z',expiresAt:expiry,forecastWindow:'within 2 hours'};
function forecasts(watch:any={status:'active',checkedAt:now,signal:{...signal}}):any{return {status:'ready',ruleVersion:'test',modelVersion:'test',generatedAt:now,cases:[],reference:referenceForecast(),watch};}
function cadence(target:'automatic_reset'|'banked_reset'='automatic_reset') {
  const start=Date.parse(now)-9*48*3600000;
  const observations=Array.from({length:10},(_,i)=>{const at=new Date(start+i*48*3600000).toISOString();return {id:`${target}-${i}`,url:`https://x.com/thsottiaux/status/${100+i}`,evidenceIds:[`e-${i}`],at,kind:target,timePrecision:'exact' as const,firstKnownAt:at};});
  return buildResetCadenceForecast({observations,target,generatedAt:now,inputFingerprint:target});
}

test('原生首页与网页一致地展示独立信号，不标记预告或承诺发放时刻',()=>{
  const data=forecasts(),outlook={status:'monitoring'} as const;
  const view=statusTimelineModel(outlook,now,undefined,data);
  assert.deepEqual(view,webTimeline(outlook,now,undefined,data));
  assert.equal(view.title,'发现重置信号');assert.equal(view.note,'观察截至 2026-10-17 13:00');
  assert.equal(view.currentStage,-1);assert.equal(view.scheduled,false);assert.equal(view.completed,false);
  assert.equal(view.sourceUrl,signal.sourceUrl);assert.match(view.detail,/尚无明确预告/);
});

test('明确安排、新完成、已过期及已撤回信号均不会被旧观察覆盖',()=>{
  const data=forecasts();
  const action={actionId:'a',eventId:'e',publicationId:'p',kind:'automatic_reset' as const,stage:'promised' as const,statementAt:'2026-10-17T03:30:00Z',expectedAt:'2026-10-17T04:30:00Z'};
  const scheduled=statusTimelineModel({status:'scheduled',active:action},now,undefined,data);
  assert.equal(scheduled.watching,false);assert.equal(scheduled.scheduled,true);
  const complete={...action,stage:'claimed_complete',statementAt:'2026-10-17T03:30:00Z'};
  const done=statusTimelineModel({status:'completed',latestCompletion:complete,lastResolved:{...complete,resolvedAt:complete.statementAt}},now,undefined,data);
  assert.equal(done.watching,false);assert.equal(done.completed,true);
  const earlier={...complete,statementAt:'2026-10-17T02:00:00Z'};
  assert.equal(statusTimelineModel({status:'completed',latestCompletion:earlier},now,undefined,data).watching,true);
  assert.equal(statusTimelineModel({status:'monitoring'},expiry,undefined,data).watching,false);
  assert.equal(statusTimelineModel({status:'monitoring'},now,undefined,forecasts({status:'none',checkedAt:now})).watching,false);
  assert.match(statusTimelineModel({status:'monitoring'},now,undefined,forecasts({status:'unavailable',checkedAt:now})).note,/来源暂不可用/);
});

test('原生 transport 校验拒绝非法信号与来源，兼容无watch旧响应',()=>{
  assert.equal(m.validateForecastPublicData(forecasts()),true);
  const legacy=forecasts();delete legacy.watch;assert.equal(m.validateForecastPublicData(legacy),true);
  for(const patch of [{sourceUrl:'https://x.com.evil.invalid/thsottiaux/status/2110618732666257557'},{sourceUrl:'https://x.com/other/status/2110618732666257557'},{expiresAt:signal.observedAt},{observedAt:'2026-02-30T03:00:00Z'},{level:'confirmed'},{text:''},{forecastWindow:'x'.repeat(201)}]){
    assert.equal(m.validateForecastPublicData(forecasts({status:'active',checkedAt:now,signal:{...signal,...patch}})),false,JSON.stringify(patch));
  }
  assert.equal(m.validateForecastPublicData(forecasts({status:'none',checkedAt:now,signal})),false);
  assert.equal(m.activeResetWatch({status:'active',checkedAt:expiry,signal},now),null);
});

test('原生预测日期范围与网页一致，失效或缺锚点时不假报日期',()=>{
  const snapshot=cadence(),data={...forecasts({status:'none',checkedAt:now}),cadence:snapshot,cadenceByKind:{automatic_reset:snapshot,banked_reset:cadence('banked_reset')}};
  for(const target of ['automatic_reset','banked_reset'] as const){
    const mini=cadenceModel(data,now,target),web=cadenceDisplay(data.cadenceByKind[target],now,target);
    assert.equal(mini.ready,true);assert.equal(mini.rangeLabel,web.rangeLabel);assert.equal(mini.predictedLabel,web.predictedLabel);
    assert.match(mini.rangeLabel,/月.*日/);
  }
  assert.deepEqual(statusTimelineModel({status:'monitoring'},now,undefined,data),webTimeline({status:'monitoring'},now,undefined,data));
  for(const patch of [{status:'insufficient',anchorAt:null,eligibleCount:0},{status:'insufficient',eligibleCount:0},{windowEnd:now},{windowStart:null}]){
    const changed={...snapshot,...patch},native=cadenceModel({...data,cadenceByKind:{automatic_reset:changed}},now),web=cadenceDisplay(changed as any,now,'automatic_reset');
    assert.equal(native.ready,false);assert.equal(native.rangeLabel,'');assert.equal(native.state,web.state);assert.equal(native.message,web.message);
  }
  const missing=cadenceModel({...data,cadenceByKind:{automatic_reset:{...snapshot,status:'insufficient',anchorAt:null,eligibleCount:0}}},now);
  assert.equal(missing.state,'时间待核对');
});

test('前台信号只预约一次到期更新，后台取消；无额外轮询或每秒setData',()=>{
  let registration:any,clock=Date.parse(now),nextId=0,intervals=0,writes=0;
  const pending=new Map<number,{callback:()=>void;delay:number}>();
  const state={receivedAt:clock,data:{serverTime:now,forecasts:forecasts(),events:[],articles:[],publications:[],evidence:[],sources:[],activities:[],notices:[],site:{name:'test'}}};
  const RealDate=Date;
  class ClockDate extends RealDate {static now(){return clock;}}
  runInNewContext(readFileSync(new URL('../miniprogram/pages/home/index.js',import.meta.url),'utf8'),{
    Page(value:any){registration=value;},Date:ClockDate,getApp:()=>({client:{getState:()=>state}}),
    require(path:string){return path.endsWith('/page')?{createPage:(_build:unknown,extra:unknown)=>extra}:path.endsWith('/status-timeline')?{statusTimelineModel}:m;},
    setTimeout(callback:()=>void,delay:number){pending.set(++nextId,{callback,delay});return nextId;},clearTimeout(id:number){pending.delete(id);},
    setInterval(){intervals++;return 1;},clearInterval(){},wx:{}
  });
  const page:any={_visible:true,data:{timeline:statusTimelineModel({status:'monitoring'},now,undefined,state.data.forecasts)},setData(patch:unknown){writes++;Object.assign(this.data,patch);},...registration.methods};
  for(let i=0;i<20;i++)registration.afterRender.call(page);
  assert.equal(pending.size,1);assert.equal(intervals,0);assert.equal(writes,0);
  const timer=[...pending.values()][0];assert.equal(timer.delay,3600020);
  clock=Date.parse(expiry)+20;pending.clear();timer.callback();
  assert.equal(writes,1);assert.equal(page.data.timeline.watching,false);assert.equal(page.data.timeline.title,'等待新消息');assert.equal(pending.size,0);
  clock=Date.parse(now);registration.afterRender.call(page);assert.equal(pending.size,1);
  page._visible=false;registration.hide.call(page);assert.equal(pending.size,0);
});
