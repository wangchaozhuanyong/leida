import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {homeOrbitPresentation}=require('../miniprogram/utils/home-orbit');
const now='2026-10-24T08:00:00Z';
const card=(state:string,kind='automatic_reset',extra={})=>({state,kind,timeAt:'2026-10-24T06:48:00Z',timeLabel:'原预计安排',description:'来源公开线索，安排待明确。',...extra});

test('银白首页两类重置覆盖11种状态且不改写原卡片',()=>{
  const states=['waiting','signal','estimated','announced','scheduled','revised','progress','overdue','observed','completed','cancelled'];
  for(const kind of ['automatic_reset','banked_reset'])for(const state of states){
    const input=card(state,kind,{window:'未来1至2天',metric:state==='scheduled'||state==='revised'?'1小时12分钟':'',metricLabel:'距预计安排',clockParts:[{value:'01',unit:'小时'},{value:'12',unit:'分钟'}]});
    const before=JSON.stringify(input),view=homeOrbitPresentation(input,now);
    assert.equal(JSON.stringify(input),before);assert.ok(view.title||view.metric,state);assert.ok(view.badge,state);assert.ok(view.description,state);assert.ok(view.footnote,state);
    if(!['completed','observed'].includes(state))assert.doesNotMatch(view.title,/已确认|已重置|已发放/,state);
  }
});
test('超过预计时间只显示已过时长，跨天采用天小时分钟三列',()=>{
  const overdue=homeOrbitPresentation(card('overdue'),now);
  assert.equal(overdue.label,'原预计时间已过');assert.equal(overdue.badge,'完成消息待确认');assert.deepEqual(overdue.parts,[{unit:'小时',value:'01'},{unit:'分钟',value:'12'}]);
  assert.match(overdue.footnote,/可能已恢复/);assert.equal(overdue.title,'');
  const days=homeOrbitPresentation(card('overdue','automatic_reset',{timeAt:'2026-10-22T06:48:00Z'}),now);
  assert.deepEqual(days.parts,[{unit:'天',value:'02'},{unit:'小时',value:'01'},{unit:'分钟',value:'12'}]);
  assert.equal(homeOrbitPresentation(card('overdue','automatic_reset',{timeAt:'2026-01-01T00:00:00Z'}),now).long,true);
});
test('到点不足一分钟及异常时间不产生负数NaN或完成状态',()=>{
  assert.equal(homeOrbitPresentation(card('overdue','automatic_reset',{timeAt:now}),now).metric,'刚到预计时间');
  for(const timeAt of ['invalid','2026-10-25T00:00:00Z']){
    const view=homeOrbitPresentation(card('overdue','automatic_reset',{timeAt}),now);
    assert.deepEqual(view.parts,[]);assert.equal(view.metric,'时间待核对');assert.doesNotMatch(JSON.stringify(view),/NaN/);assert.equal(view.badge,'完成消息待确认');
  }
});
test('来源观测与公开完成声明保持不同证据等级、时间语义，均保留装饰动效',()=>{
  const observed=homeOrbitPresentation(card('observed'),now),completed=homeOrbitPresentation(card('completed','banked_reset'),now);
  assert.equal(observed.title,'已有重置观测');assert.equal(observed.badge,'第三方报告');assert.equal(observed.timeLabel,'来源观测时间');assert.match(observed.footnote,/不等于官方/);
  assert.equal(completed.title,'重置卡发放已确认');assert.equal(completed.badge,'公开完成声明');assert.equal(completed.label,'距完成声明');
  assert.equal(observed.animated,true);assert.equal(completed.animated,true);
});
test('信号推测保留发布时范围不生成倒计时，独立观测不冒充本轮完成',()=>{
  const input=card('estimated','automatic_reset',{window:'未来1至2天'});
  for(const time of [now,'2026-10-25T00:00:00Z']){
    const view=homeOrbitPresentation(input,time);assert.equal(view.title,'未来1至2天');assert.deepEqual(view.parts,[]);assert.equal(view.metric,'');assert.match(view.badge,/非明确预告/);
  }
  const overdue=homeOrbitPresentation(card('overdue','automatic_reset',{observationPublicationId:'independent'}),now);
  assert.match(overdue.description,/第三方.*本轮.*待核实/);assert.equal(overdue.badge,'完成消息待确认');
  const revised=homeOrbitPresentation(card('revised','automatic_reset',{metricLabel:'距离预计最晚时间',metric:'不足1分钟'}),now);
  assert.equal(revised.label,'距离预计最晚时间');assert.equal(revised.metric,'不足1分钟');assert.equal(revised.badge,'安排已调整');
});
