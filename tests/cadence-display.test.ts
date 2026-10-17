import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {buildResetCadenceForecast,type ResetCadenceForecast} from '../src/lib/reset-cadence';
import {cadenceDisplay,cadenceForTarget,type CadenceTarget} from '../src/lib/cadence-display';
import {referenceForecast,type ForecastPublicData} from '../src/lib/forecast';
import {ResetForecastCard} from '../src/components/public/ResetForecastCard';
import {ResetPrediction} from '../src/components/public/ResetPrediction';
const {cadenceModel}=createRequire(import.meta.url)('../miniprogram/utils/cadence.js');
const now='2026-10-16T06:00:00.000Z';
function snapshot(target:CadenceTarget='automatic_reset'):ResetCadenceForecast {
 const start=Date.parse(now)-9*48*3600000;
 const observations=Array.from({length:10},(_,i)=>{const at=new Date(start+i*48*3600000).toISOString();return {id:`${target}-${i}`,url:`https://x.com/thsottiaux/status/${100+i}`,evidenceIds:[`e-${i}`],at,kind:target,timePrecision:'exact' as const,firstKnownAt:at};});
 return buildResetCadenceForecast({observations,generatedAt:now,inputFingerprint:target,target});
}
function publicForecast(a=snapshot(),b=snapshot('banked_reset')):ForecastPublicData{return {status:'ready',ruleVersion:'test',modelVersion:'test',generatedAt:now,cases:[],reference:referenceForecast(),cadence:a,cadenceByKind:{automatic_reset:a,banked_reset:b}};}

test('网页和小程序使用相同类别、样本门槛及固定窗口',()=>{
 const data=publicForecast(),before=structuredClone(data);
 for(const target of ['automatic_reset','banked_reset'] as const){
  const s=cadenceForTarget(data,target),web=cadenceDisplay(s,now,target),mini=cadenceModel(data,now,target);
  assert.equal(web.ready,true);assert.equal(mini.ready,true);assert.equal(web.p24,mini.p24);assert.equal(web.p48,mini.p48);assert.equal(web.state,mini.state);assert.equal(web.rangeLabel,mini.rangeLabel);assert.equal(web.predictedLabel,mini.predictedLabel);
  assert.equal(web.window24,'2026-10-17T06:00:00.000Z');
  const later=cadenceDisplay(s,'2026-10-16T08:00:00Z',target);assert.equal(later.window24,web.window24);
 }
 assert.deepEqual(data,before);
});

test('旧模型、过期、未来、类型错配和非法概率均不显示为当前估算',()=>{
 for(const change of [{target:undefined},{modelVersion:'old-model'},{validUntil:now},{generatedAt:'2026-10-17T06:00:00Z'},{target:'banked_reset'},{p24:NaN},{p48:1.5},{p24:.9,p48:.5},{eligibleCount:4},{sampleCount:7},{windowStart:null},{windowEnd:now},{predictedAt:'invalid'},{windowStart:'2026-10-20T00:00:00Z'}] as Partial<ResetCadenceForecast>[]){
  const s={...snapshot(),...change};const data=publicForecast(s);
  assert.equal(cadenceDisplay(s,now,'automatic_reset').ready,false,JSON.stringify(change));
  assert.equal(cadenceModel(data,now,'automatic_reset').ready,false,JSON.stringify(change));
 }
 assert.equal(cadenceDisplay(undefined,now,'automatic_reset').state,'积累记录中');
 assert.equal(cadenceForTarget({...publicForecast(),status:'unavailable'},'automatic_reset'),undefined);
});

test('缺起点和当前可比不足与总样本不足分别解释，不显示虚构时间',()=>{
 const base=snapshot();
 for(const anchorAt of [null,base.anchorAt]){
  const s={...base,status:'insufficient' as const,sampleCount:14,eligibleCount:0,anchorAt,predictedAt:null,windowStart:null,windowEnd:null,p24:null,p48:null};
  const web=cadenceDisplay(s,now,'automatic_reset'),mini=cadenceModel(publicForecast(s),now);
  assert.equal(web.message,mini.message);assert.equal(web.state,mini.state);assert.equal(web.rangeLabel,'');assert.equal(web.ready,false);
  assert.match(web.message,anchorAt?/当前等待时长下/:/时间依据待核对/);
 }
});

test('明确公告只压过对应类型的历史估算',()=>{
 const data=publicForecast();data.outlook={active:{kind:'automatic_reset'}} as ForecastPublicData['outlook'];
 assert.equal(cadenceModel(data,now,'automatic_reset').announced,true);
 assert.equal(cadenceModel(data,now,'banked_reset').ready,true);
 const html=renderToStaticMarkup(createElement(ResetForecastCard,{data,now}));
 assert.match(html,/已有公开安排/);assert.match(html,/请以上方公告进展和原文为准/);assert.doesNotMatch(html,/pub-forecast-metrics/);
});

test('首页可直接读取当前预测，历史混合模型只在固定复盘中展示原数值',()=>{
 const s=snapshot(),html=renderToStaticMarkup(createElement(ResetForecastCard,{data:publicForecast(s),now}));
 assert.match(html,/下一次重置参考/);assert.match(html,/从本次估算时间起算/);assert.match(html,/查看预测依据/);
 const old={...s,target:undefined,modelVersion:'legacy'};
 const current=renderToStaticMarkup(createElement(ResetPrediction,{forecast:old,now}));
 assert.match(current,/冻结历史模型/);assert.doesNotMatch(current,/pub-prediction-probabilities/);
 const fixed=renderToStaticMarkup(createElement(ResetPrediction,{forecast:old,now,frozen:true}));
 assert.match(fixed,/冻结历史模型/);assert.match(fixed,/pub-prediction-probabilities/);
});

test('原生预测组件保留选择；无变化不重复setData，不触发采集或额外授权',()=>{
 let registration:any;const navigations:string[]=[];
 runInNewContext(readFileSync(new URL('../miniprogram/components/reset-forecast/index.js',import.meta.url),'utf8'),{Component:(value:unknown)=>{registration=value;},require:()=>({cadenceModel}),wx:{navigateTo:({url}:{url:string})=>navigations.push(url)}});
 let writes=0;
 const component:any={data:structuredClone(registration.data),properties:{forecasts:publicForecast(),now,snapshot:null},setData(patch:unknown,done?:()=>void){writes++;Object.assign(this.data,patch);done?.();}};
 Object.assign(component,registration.methods);
 component.refresh();const first=writes;
 for(let i=0;i<20;i++)component.refresh();
 assert.equal(writes,first);assert.equal(component.data.view.ready,true);
 component.selectTarget({currentTarget:{dataset:{target:'banked_reset'}}});
 assert.equal(component.data.target,'banked_reset');assert.equal(component.data.view.target,'banked_reset');
 const switched=writes;component.selectTarget({currentTarget:{dataset:{target:'banked_reset'}}});assert.equal(writes,switched);
 component.openDetails();assert.deepEqual(navigations,['/pages/methodology/index?target=banked_reset']);
});
