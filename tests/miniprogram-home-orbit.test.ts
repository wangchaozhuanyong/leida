import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {homeClock,homeOrbitPresentation}=require('../miniprogram/utils/home-orbit');
const now='2026-10-24T08:00:00Z';
const card=<T extends object>(state:string,kind='automatic_reset',extra?:T)=>({state,kind,timeAt:'2026-10-24T06:48:00Z',
  timeLabel:state==='observed'?'来源观测时间':state==='completed'?'完成消息时间':'原预计安排',...extra});

test('同一刻度盘渲染两类重置，保留原卡片和事实等级',()=>{
  const states=['waiting','signal','estimated','announced','scheduled','revised','progress','overdue','observed','completed','cancelled'];
  for(const kind of ['automatic_reset','banked_reset'])for(const state of states){
    const input=card(state,kind,{window:'未来1至2天',expectedAt:state==='scheduled'||state==='revised'?'2026-10-24T09:12:00Z':'',metricLabel:'距预计安排'});
    const before=JSON.stringify(input),view=homeOrbitPresentation(input,now);
    assert.equal(JSON.stringify(input),before);assert.ok(view.title||view.metric,state);
    assert.doesNotMatch(JSON.stringify(view),/正在发放|进行中|完成待确认|刚刚|刚到预计时间|不足1分钟/);
    if(!['completed','observed'].includes(state))assert.doesNotMatch(view.title,/已确认|已重置|已发放/,state);
  }
});
test('超过预计时间只显示已过时长，跨天采用天小时分钟三列',()=>{
  const overdue=homeOrbitPresentation(card('overdue'),now);
  assert.equal(overdue.label,'原预计时间已过');assert.equal(overdue.badge,'公开预告');assert.deepEqual(overdue.parts,[{unit:'小时',value:'01'},{unit:'分钟',value:'12'}]);
  assert.match(overdue.description,/暂无重置结果记录/);assert.equal(overdue.title,'');
  const days=homeOrbitPresentation(card('overdue','automatic_reset',{timeAt:'2026-10-22T06:48:00Z'}),now);
  assert.deepEqual(days.parts,[{unit:'天',value:'02'},{unit:'小时',value:'01'},{unit:'分钟',value:'12'}]);
  assert.equal(homeOrbitPresentation(card('overdue','automatic_reset',{timeAt:'2026-01-01T00:00:00Z'}),now).long,true);
});
test('到点不足一分钟及异常时间不产生负数NaN或完成状态',()=>{
  assert.equal(homeOrbitPresentation(card('overdue','automatic_reset',{timeAt:now}),now).metric,'0秒');
  for(const timeAt of ['invalid','2026-10-25T00:00:00Z']){
    const view=homeOrbitPresentation(card('overdue','automatic_reset',{timeAt}),now);
    assert.deepEqual(view.parts,[]);assert.equal(view.metric,'');assert.doesNotMatch(JSON.stringify(view),/NaN/);assert.equal(view.badge,'公开预告');
  }
});
test('来源观测与公开完成声明保持不同证据等级、时间语义，均保留装饰动效',()=>{
  const observed=homeOrbitPresentation(card('observed'),now),completed=homeOrbitPresentation(card('completed','banked_reset'),now);
  assert.equal(observed.title,'距离上次重置（观测）');assert.equal(observed.badge,'第三方报告');assert.equal(observed.timeLabel,'来源观测时间');
  assert.equal(completed.title,'距离上次发卡');assert.equal(completed.badge,'已发放 · 发布者确认');assert.equal(completed.label,'已经过去');
  assert.equal(observed.animated,true);assert.equal(completed.animated,true);
});
test('信号推测保留发布时范围不生成倒计时，独立观测不冒充本轮完成',()=>{
  const input=card('estimated','automatic_reset',{window:'未来1至2天'});
  for(const time of [now,'2026-10-25T00:00:00Z']){
    const view=homeOrbitPresentation(input,time);assert.equal(view.title,'未来1至2天');assert.deepEqual(view.parts,[]);assert.equal(view.metric,'');assert.equal(view.badge,'信号推测');
  }
  const overdue=homeOrbitPresentation(card('overdue','automatic_reset',{observationPublicationId:'independent'}),now);
  assert.equal(overdue.label,'原预计时间已过');assert.equal(overdue.badge,'公开预告');
  const revised=homeOrbitPresentation(card('revised','automatic_reset',{metricLabel:'距离预计最晚时间',timeAt:'2026-10-24T08:00:23Z'}),now);
  assert.equal(revised.label,'距离预计最晚时间');assert.equal(revised.metric,'23秒');assert.equal(revised.badge,'时间已更新');
});

test('计时从最后一秒越过零点后正向累计，满一分钟及满一天转换单位',()=>{
  const at=Date.parse(now), shift=(ms:number)=>new Date(at+ms).toISOString();
  for(const [offset, expected] of [[-60_000,'1分钟'],[-59_900,'59秒'],[-15_000,'15秒'],[-1,'1秒'],[0,'0秒'],[28_000,'28秒'],[59_999,'59秒'],[60_000,'1分钟'],[86_400_000,'1天0小时0分钟']] as const){
    assert.equal(homeClock(now,shift(offset),offset<0).metric,expected);
  }
});

test('两类完成主标题直接解释经过时长，观测括号不冒充公开声明',()=>{
  for(const kind of ['automatic_reset','banked_reset']){
    const subject=kind==='banked_reset'?'发卡':'重置';
    const observed=homeOrbitPresentation(card('observed',kind),now),completed=homeOrbitPresentation(card('completed',kind),now);
    assert.equal(observed.title,'距离上次'+subject+'（观测）');assert.equal(completed.title,'距离上次'+subject);
    assert.equal(observed.label,'已经过去');assert.deepEqual(observed.parts,completed.parts);assert.equal(observed.metric,'1小时12分钟');
    assert.equal(observed.timeLabel,'来源观测时间');assert.equal(completed.timeLabel,'完成消息时间');
    assert.notEqual(observed.badge,completed.badge);
  }
});
