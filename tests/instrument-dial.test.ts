import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {InstrumentDial} from '../src/components/public/InstrumentDial';
import type {ResetOutlook} from '../src/lib/reset-outlook';

const now='2026-10-12T03:40:00.000Z';
const active={actionId:'test-action',eventId:'test-event',publicationId:'test-publication',kind:'automatic_reset' as const,stage:'promised' as const,statementAt:'2026-10-12T03:00:00.000Z',expectedAt:'2026-10-12T07:00:00.000Z',timeNote:'原文预计时刻'};
const render=(outlook:ResetOutlook)=>renderToStaticMarkup(createElement(InstrumentDial,{outlook,serverTime:now}));
test('表盘用服务器时间显示剩余时长，并明确北京时间目标而不是设备时间',()=>{
 const html=render({status:'scheduled',active});
 assert.match(html,/3小时20分钟/);assert.match(html,/北京时间15:00/);assert.match(html,/预计3小时20分钟后/);
});
test('已完成、取消和无预告时没有虚构数字倒计时',()=>{
 for(const status of ['completed','cancelled','monitoring'] as const){const html=render({status});assert.match(html,/等待预告/);assert.doesNotMatch(html,/03:20|00:00/);}
});
test('过期预告转为等待确认；无准确时间保留待明确',()=>{
 const overdue=render({status:'overdue',active:{...active,expectedAt:'2026-10-12T03:30:00.000Z'}});
 assert.match(overdue,/等待确认/);assert.doesNotMatch(overdue,/00:00/);
 const unknown=render({status:'announced',active:{...active,expectedAt:undefined}});
 assert.match(unknown,/时间待明确/);assert.doesNotMatch(unknown,/3小时20分钟/);
});

const completion={...active,stage:'claimed_complete' as const,statementAt:'2026-10-12T01:25:00.000Z'};
test('最近公开完成显示小时和分钟，发卡保持独立名称',()=>{
 for(const [kind,lead] of [['automatic_reset','距最近一次确认重置'],['banked_reset','距最近一次确认发放重置卡']] as const){
  const html=render({status:'completed',latestCompletion:{...completion,kind}});
  assert.match(html,new RegExp(`${lead}：2小时15分钟前`));
  assert.match(html,/is-completed/);assert.doesNotMatch(html,/等待预告|03:20/);
 }
 const justNow=render({status:'completed',latestCompletion:{...completion,statementAt:now}});
 assert.match(justNow,/距最近一次确认重置：刚刚/);
});
test('24小时边界按原文时间，未来或无效时间不显示完成',()=>{
 const at=(age:number)=>new Date(Date.parse(now)-age).toISOString();
 const html=render({status:'completed',latestCompletion:{...completion,statementAt:at(24*3600_000-1)}});
 assert.match(html,/23小时59分钟前/);
 for(const statementAt of [at(24*3600_000),at(25*3600_000),at(-1),'invalid']){
  assert.match(render({status:'completed',latestCompletion:{...completion,statementAt}}),/等待预告/);
 }
});
test('新预告、逾期未确认和无时间安排优先于最近完成结果',()=>{
 for(const [patch,expected] of [
  [{},/3小时20分钟/],
  [{expectedAt:'2026-10-12T03:00:00.000Z'},/等待确认/],
  [{expectedAt:undefined},/时间待明确/],
 ] as const){
  const html=render({status:'scheduled',active:{...active,...patch},latestCompletion:completion});
  assert.match(html,expected);assert.doesNotMatch(html,/距最近一次确认|is-completed/);
 }
});
