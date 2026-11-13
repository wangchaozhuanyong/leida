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
test('超过预计时间继续累计，跨天保持固定时分秒三列',()=>{
  const overdue=homeOrbitPresentation(card('overdue'),now);
  assert.equal(overdue.label,'原预计时间已过');assert.equal(overdue.badge,'公开预告');assert.deepEqual(overdue.timeParts,[{unit:'小时',value:'01'},{unit:'分钟',value:'12'},{unit:'秒',value:'00'}]);assert.deepEqual(overdue.calendarParts,[]);
  assert.match(overdue.description,/暂无重置结果记录/);assert.equal(overdue.title,'');
  const days=homeOrbitPresentation(card('overdue','automatic_reset',{timeAt:'2026-10-22T06:48:00Z'}),now);
  assert.deepEqual(days.calendarParts,[{unit:'天',value:'2'}]);assert.deepEqual(days.timeParts,overdue.timeParts);
  assert.deepEqual(homeOrbitPresentation(card('overdue','automatic_reset',{timeAt:'2026-01-01T00:00:00Z'}),now).calendarParts,[{unit:'个月',value:'9'},{unit:'天',value:'23'}]);
});
test('到点不足一分钟及异常时间不产生负数NaN或完成状态',()=>{
  assert.equal(homeOrbitPresentation(card('overdue','automatic_reset',{timeAt:now}),now).metric,'0小时0分钟0秒');
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
  assert.equal(revised.label,'距离预计最晚时间');assert.equal(revised.metric,'0小时0分钟23秒');assert.equal(revised.badge,'时间已更新');
});

test('计时从最后一秒越过零点后正向累计，满一分钟及满一天转换单位',()=>{
  const at=Date.parse(now), shift=(ms:number)=>new Date(at+ms).toISOString();
  for(const [offset, expected] of [[-60_000,'0小时1分钟0秒'],[-59_900,'0小时1分钟0秒'],[-15_000,'0小时0分钟15秒'],[-1,'0小时0分钟1秒'],[0,'0小时0分钟0秒'],[28_000,'0小时0分钟28秒'],[59_999,'0小时0分钟59秒'],[60_000,'0小时1分钟0秒'],[86_400_000,'1天0小时0分钟0秒']] as const){
    assert.equal(homeClock(now,shift(offset),offset<0).metric,expected);
  }
});

test('两类完成主标题直接解释经过时长，观测括号不冒充公开声明',()=>{
  for(const kind of ['automatic_reset','banked_reset']){
    const subject=kind==='banked_reset'?'发卡':'重置';
    const observed=homeOrbitPresentation(card('observed',kind),now),completed=homeOrbitPresentation(card('completed',kind),now);
    assert.equal(observed.title,'距离上次'+subject+'（观测）');assert.equal(completed.title,'距离上次'+subject);
    assert.equal(observed.label,'已经过去');assert.deepEqual(observed.parts,completed.parts);assert.equal(observed.metric,'1小时12分钟0秒');
    assert.equal(observed.timeLabel,'来源观测时间');assert.equal(completed.timeLabel,'完成消息时间');
    assert.notEqual(observed.badge,completed.badge);
  }
});

// Month/year decomposition must follow the calendar, including leap days and short months.
test('北京自然年月分解不使用固定30天或365天，截止与累计使用同一格式',()=>{
 const cases=[
  ['2026-01-31T06:00:00Z','2026-02-28T06:00:00Z','1个月0天0小时0分钟0秒'],
  ['2024-01-31T06:00:00Z','2024-02-29T06:00:00Z','1个月0天0小时0分钟0秒'],
  ['2024-02-29T06:00:00Z','2025-02-28T06:00:00Z','1年0个月0天0小时0分钟0秒'],
  ['2025-08-01T16:00:00Z','2026-10-13T17:02:03Z','1年2个月12天1小时2分钟3秒'],
  ['2026-10-31T16:00:00Z','2026-11-30T15:59:59Z','29天23小时59分钟59秒'],
  ['2026-10-31T16:00:00Z','2026-11-30T16:00:00Z','1个月0天0小时0分钟0秒'],
 ];
 for(const [from,to,expected] of cases){
  const up=homeClock(from,to),down=homeClock(to,from,true);
  assert.equal(up.metric,expected);assert.deepEqual(up,down);
  assert.deepEqual(up.timeParts.map((p:{unit:string})=>p.unit),['小时','分钟','秒']);
 }
});
