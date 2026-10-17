import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StatusTimeline, statusTimelineModel} from '../src/components/public/StatusTimeline';
import type {ResetOutlook} from '../src/lib/reset-outlook';
import {referenceForecast,type ForecastPublicData} from '../src/lib/forecast';
import {buildResetCadenceForecast} from '../src/lib/reset-cadence';

const require = createRequire(import.meta.url);
const native = require('../miniprogram/utils/status-timeline.js');
const now = '2026-10-15T04:00:00Z';
const active = {actionId: 'test', eventId: 'test', publicationId: 'test', kind: 'automatic_reset' as const, stage: 'promised' as const, statementAt: '2026-10-15T01:00:00Z', expectedAt: '2026-10-15T07:20:00Z', timeNote: '原文预计时刻'};
const completed = {...active, stage: 'claimed_complete' as const, statementAt: '2026-10-15T02:00:00Z'};

test('网页与小程序时间轴在等待、预告、进行、逾期、完成和取消时使用相同公开状态', () => {
  const cases: ResetOutlook[] = [
    {status: 'monitoring'}, {status: 'cancelled'}, {status: 'completed'},
    {status: 'scheduled', active},
    {status: 'announced', active: {...active, expectedAt: undefined}},
    {status: 'in_progress', active: {...active, stage: 'in_progress', expectedAt: undefined}},
    {status: 'overdue', active: {...active, expectedAt: now}},
    {status: 'completed', latestCompletion: completed},
    {status: 'completed', latestCompletion: {...completed, kind: 'banked_reset'}},
    {status: 'completed', latestCompletion: {...completed, statementAt: '2026-10-14T04:00:00Z'}},
    {status: 'scheduled', active: {...active, expectedAt: '2026-10-20T04:00:00Z'}},
    {status: 'scheduled', active, latestCompletion: completed},
  ];
  for (const outlook of cases) assert.deepEqual(native.statusTimelineModel(outlook, now), statusTimelineModel(outlook, now));
});

test('计时到点只转等待确认，不高亮完成，也不把阶段线当历史证明', () => {
  const upcoming = statusTimelineModel({status: 'scheduled', active}, now);
  assert.equal(upcoming.title, '3小时20分钟'); assert.equal(upcoming.currentStage, 0);
  assert.match(upcoming.note, /15:20/);
  for (const stage of ['promised', 'in_progress'] as const) {
    const outlook: ResetOutlook = {status: 'scheduled', active: {...active, stage}};
    const expired = statusTimelineModel(outlook, active.expectedAt);
    assert.equal(expired.title, '等待确认'); assert.equal(expired.currentStage, -1);
    const html = renderToStaticMarkup(createElement(StatusTimeline, {outlook, serverTime: active.expectedAt}));
    assert.doesNotMatch(html, /aria-current="step"|00:00/);
  }
  const html = renderToStaticMarkup(createElement(StatusTimeline, {outlook: {status: 'completed', latestCompletion: completed}, serverTime: now}));
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  assert.match(html, /aria-current="step">完成确认/);
  assert.doesNotMatch(html, /class="current"[^>]*>公开预告/);
});

test('发卡名称独立，旧完成记录不代替新安排；超过24小时继续等待新消息', () => {
  const card = statusTimelineModel({status: 'completed', latestCompletion: {...completed, kind: 'banked_reset'}}, now);
  assert.equal(card.title, '已确认发放重置卡'); assert.equal(card.stages[1], '发卡进行');
  const ongoing = statusTimelineModel({status: 'in_progress', active: {...active, kind: 'banked_reset', stage: 'in_progress', expectedAt: undefined}, latestCompletion: completed}, now);
  assert.equal(ongoing.title, '发卡进行中'); assert.equal(ongoing.currentStage, 1); assert.equal(ongoing.completed, false);
  for (const statementAt of ['2026-10-14T04:00:00Z', '2026-10-15T04:00:01Z', 'invalid']) {
    const model = statusTimelineModel({status: 'completed', latestCompletion: {...completed, statementAt}}, now);
    assert.equal(model.title, '等待下一次 Reset'); assert.equal(model.currentStage, -1);
  }
});

function forecasts():ForecastPublicData {
  return {status:'ready',ruleVersion:'test',modelVersion:'test',generatedAt:now,cases:[],reference:referenceForecast(),watch:{status:'active',checkedAt:now,signal:{sourceUrl:'https://x.com/thsottiaux/status/2110618732666257557',text:'A public reset hint.',level:'elevated',observedAt:'2026-10-15T03:00:00Z',expiresAt:'2026-10-15T05:00:00Z',forecastWindow:'within a few hours'}}};
}
test('信号优先于旧完成，不能标为公开预告；两端显示同一观察截止',()=>{
  const data=forecasts(),outlook:ResetOutlook={status:'completed',latestCompletion:completed};
  const web=statusTimelineModel(outlook,now,completed,data);
  assert.deepEqual(native.statusTimelineModel(outlook,now,completed,data),web);
  assert.equal(web.title,'发现重置信号');assert.equal(web.currentStage,-1);assert.equal(web.completed,false);
  assert.equal(web.note,'观察有效至 2026-10-15 13:00');
  const html=renderToStaticMarkup(createElement(StatusTimeline,{outlook,serverTime:now,forecasts:data}));
  assert.match(html,/AI 信号推测，尚无明确预告/);assert.match(html,/数据来自 Codex Resets/);
  assert.doesNotMatch(html,/aria-current="step"|预计 2026-10-15 13:00/);
});
test('明确预告、后来的完成声明、撤回、到期与无效来源压过旧信号',()=>{
  const data=forecasts();
  assert.equal(statusTimelineModel({status:'scheduled',active},now,null,data).title,'3小时20分钟');
  const newer={...completed,statementAt:'2026-10-15T03:30:00Z'};
  assert.equal(statusTimelineModel({status:'completed',latestCompletion:newer},now,newer,data).watching,false);
  for(const watch of [{status:'none',checkedAt:now},{status:'unavailable',checkedAt:now},{...data.watch,signal:{...data.watch!.signal,sourceUrl:'https://evil.test/'}},{...data.watch,signal:{...data.watch!.signal,expiresAt:now}}]){
    const changed={...data,watch} as ForecastPublicData;
    const web=statusTimelineModel({status:'monitoring'},now,null,changed);
    assert.equal(web.watching,false);assert.deepEqual(native.statusTimelineModel({status:'monitoring'},now,null,changed),web);
  }
  assert.equal(statusTimelineModel({status:'monitoring'},'2026-10-15T05:00:00Z',null,data).watching,false);
});
test('没有有效新信号时，即使历史模型可计算或给出很宽区间也必须等待，不展示日期',()=>{
  const generated=Date.parse(now),observations=Array.from({length:10},(_,i)=>{const at=new Date(generated-(9-i)*48*3600_000).toISOString();return {id:`e${i}`,url:`https://x.com/thsottiaux/status/${100+i}`,evidenceIds:[`e${i}`],kind:'automatic_reset' as const,at,firstKnownAt:at,timePrecision:'exact' as const};});
  const cadence=buildResetCadenceForecast({observations,generatedAt:now,target:'automatic_reset',inputFingerprint:'test'});
  const data={...forecasts(),watch:{status:'none' as const,checkedAt:now},cadence};
  assert.equal(cadence.status,'ready','回归输入确实能产生历史估算，不能依靠样本不足掩盖问题');
  for(const watch of [undefined,{status:'none' as const,checkedAt:now},{status:'unavailable' as const,checkedAt:now},{...forecasts().watch!,signal:{...forecasts().watch!.signal!,expiresAt:now}}]){
    for(const window of [{}, {windowStart:'2026-10-18T14:21:00Z',predictedAt:'2026-10-24T06:42:00Z',windowEnd:'2026-11-05T06:42:00Z'}]){
      const snapshot={...cadence,...window};
      const input={...data,watch,cadence:snapshot,cadenceByKind:{automatic_reset:snapshot}};
      const web=statusTimelineModel({status:'monitoring'},now,null,input);
      assert.equal(web.title,'等待下一次 Reset');assert.equal(web.estimating,false);assert.equal(web.currentStage,-1);
      assert.deepEqual(native.statusTimelineModel({status:'monitoring'},now,null,input),web);
      const html=renderToStaticMarkup(createElement(StatusTimeline,{outlook:{status:'monitoring'},serverTime:now,forecasts:input}));
      assert.match(html,/等待下一次 Reset/);assert.doesNotMatch(html,/预计重置时间|历史间隔估算|10月18|11月05|北京时间/);
    }
  }
});

test('新信号到期即回等待，历史区间不会重新接管；新的公开时间仍可展示',()=>{
  const data=forecasts(),outlook:ResetOutlook={status:'monitoring'};
  const before=structuredClone(data);
  assert.equal(statusTimelineModel(outlook,now,null,data).watching,true);
  const expiry=data.watch!.signal!.expiresAt;
  const waiting=statusTimelineModel(outlook,expiry,null,data);
  assert.equal(waiting.title,'等待下一次 Reset');assert.equal(waiting.watching,false);assert.equal(waiting.estimating,false);
  assert.deepEqual(native.statusTimelineModel(outlook,expiry,null,data),waiting);
  assert.equal(statusTimelineModel({status:'scheduled',active},now,null,data).note,'预计 2026-10-15 15:20');
  assert.deepEqual(data,before,'切换显示状态不能重写信号或延长预测期限');
});


test('倒计时以天小时分钟显示，整点和不足一分钟不产生歧义，过点仍等待确认',()=>{
 for(const [minutes,title] of [[713,'11小时53分钟'],[2205,'1天12小时45分钟'],[60,'1小时0分钟'],[1440,'1天0小时0分钟'],[53,'53分钟'],[0.5,'不足1分钟']] as const){
  const a={...active,expectedAt:new Date(Date.parse(now)+minutes*60000).toISOString()};
  const web=statusTimelineModel({status:'scheduled',active:a},now);
  assert.equal(web.title,title);assert.equal(web.detail,'预计时间仅供参考，以实际发放为主。');
  assert.deepEqual(native.statusTimelineModel({status:'scheduled',active:a},now),web);
 }
});
