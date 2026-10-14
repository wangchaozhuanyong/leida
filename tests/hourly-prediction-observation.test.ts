import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateHourlyPredictions,HOURLY_OBSERVATION_VERSION,type HourlyPredictionObservation} from '../src/lib/hourly-prediction-observation';
import type {Publication,Evidence} from '../src/lib/types';
const start='2026-10-12T00:00:00.000Z';
const stamp=(minutes:number)=>new Date(Date.parse(start)+minutes*60_000).toISOString();
function fixture(stage:'promised'|'claimed_complete'|'cancelled',minutes:number,expected=120,kind:'automatic_reset'|'banked_reset'='automatic_reset'){
 const e:Evidence={id:`ev-${stage}-${minutes}-${kind}`,hash:'h',sourceId:'tibo-public',messageId:`m-${minutes}`,url:`https://x.com/thsottiaux/status/${minutes}`,text:'原文',publishedAt:stamp(minutes),collectedAt:stamp(minutes+1),contextComplete:true,historical:false,provenance:'official',textOrigin:'original'};
 const p:Publication={id:`pub-${e.id}`,eventId:'event',articleId:'article',publishedAt:stamp(minutes+2),cutoffAt:stamp(minutes+1),reason:'worker',contentOrigin:'template',mode:'state_change',event:{id:'event',title:'原文状态',version:1,status:'published',publicationId:`pub-${e.id}`,updatedAt:stamp(minutes+2),evidenceIds:[e.id],actions:[{id:'action',kind,stage,scope:'public',eligibility:'付费账户',statementAt:e.publishedAt,evidenceIds:[e.id],expectedAt:stamp(expected),timeNote:'原文预计时刻：并非最晚截止；已换算',evidenceQuote:'Will reset in 2 hours.'}]},article:{id:'article',eventId:'event',title:'原文状态',summary:'原文',translation:'',category:'reset',status:'published',version:1,publicationId:`pub-${e.id}`,evidenceIds:[e.id],publishedAt:stamp(minutes+2),updatedAt:stamp(minutes+2),sourcePublishedAt:e.publishedAt,historical:false}};
 return {e,p};
}
const initial=():HourlyPredictionObservation=>({version:HOURLY_OBSERVATION_VERSION,startedAt:start,cases:[]});
function run(state:HourlyPredictionObservation,fixtures:ReturnType<typeof fixture>[],time=300){return evaluateHourlyPredictions(state,{time:stamp(time),publications:fixtures.map(f=>f.p),evidence:fixtures.map(f=>f.e),automaticPublicationIds:new Set(fixtures.map(f=>f.p.id))});}
test('按不可变发布时间冻结首条预告，即使下一次检查已见完成，也不能选择后改时间',()=>{
 const first=fixture('promised',10),revision=fixture('promised',40,180),done=fixture('claimed_complete',190);
 const result=run(initial(),[done,revision,first]);
 assert.equal(result.state.cases.length,1);assert.equal(result.state.cases[0].expectedAt,stamp(120));assert.equal(result.state.cases[0].absoluteErrorHours,70/60);assert.equal(result.summary.pointWithinOneHour,0);
 assert.deepEqual(run(result.state,[first,revision,done]).state.cases,result.state.cases);
});
test('过期和没有同轮完成的预告记未知，不自动算命中、失败或到账',()=>{
 const first=fixture('promised',10),otherKind=fixture('claimed_complete',190,120,'banked_reset');
 const result=run(initial(),[first,otherKind]);assert.equal(result.summary.unknownRounds,1);assert.equal(result.summary.pointCases,0);assert.equal(result.summary.accountDeliveryMeasured,false);
});
test('截止与点误差独立，取消不能算完成',()=>{
 const first=fixture('promised',10),done=fixture('claimed_complete',110);
 first.p.event.actions[0].timeNote='最晚期限已换算';first.p.event.actions[0].evidenceQuote='We will reset within 2 hours.';
 const result=run(initial(),[first,done]);assert.equal(result.summary.deadlineCases,1);assert.equal(result.summary.withinDeadline,1);assert.equal(result.summary.pointCases,0);
 assert.equal(run(initial(),[fixture('promised',10),fixture('cancelled',50)]).summary.cancelledRounds,1);
});
test('晚发现、历史、定向、人工、未来和无原文引用不能伪装成前瞻预测',()=>{
 for(const variant of ['late','historical','targeted','manual','future','missing'] as const){
  const first=fixture('promised',10);
  if(variant==='late')first.p.publishedAt=stamp(130);
  if(variant==='historical')first.e.historical=true;
  if(variant==='targeted')first.p.event.actions[0].scope='targeted';
  if(variant==='manual')first.e.provenance='manual';
  if(variant==='future')first.p.publishedAt=stamp(301);
  if(variant==='missing')first.p.event.actions[0].evidenceIds=['missing'];
  assert.equal(run(initial(),[first]).summary.firstTimedRounds,0,variant);
 }
 const old=fixture('promised',10);assert.equal(run({...initial(),startedAt:stamp(20)},[old]).summary.firstTimedRounds,0);
});
test('未来完成时间、异轮事件和截断观察状态不能污染已冻结样本',()=>{
 const first=fixture('promised',10),done=fixture('claimed_complete',310);
 assert.equal(run(initial(),[first,done]).summary.unknownRounds,1);
 done.p.eventId='other';done.p.event.actions[0].statementAt=stamp(190);done.e.publishedAt=stamp(190);done.e.collectedAt=stamp(191);done.p.publishedAt=stamp(192);done.p.cutoffAt=stamp(191);
 assert.equal(run(initial(),[first,done]).summary.unknownRounds,1);
 const state=run(initial(),[first]).state;assert.throws(()=>run({...state,cases:[...state.cases,...state.cases]},[first]),/无效/);
 assert.throws(()=>run(state,[first],200),/窗口无效/);
});
