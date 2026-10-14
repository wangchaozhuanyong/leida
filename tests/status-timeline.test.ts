import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StatusTimeline, statusTimelineModel} from '../src/components/public/StatusTimeline';
import type {ResetOutlook} from '../src/lib/reset-outlook';

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
  assert.equal(upcoming.title, '03:20'); assert.equal(upcoming.currentStage, 0);
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

test('发卡名称独立，旧完成记录不代替新安排；超过24小时回到等待预告', () => {
  const card = statusTimelineModel({status: 'completed', latestCompletion: {...completed, kind: 'banked_reset'}}, now);
  assert.equal(card.title, '已确认发放重置卡'); assert.equal(card.stages[1], '发卡进行');
  const ongoing = statusTimelineModel({status: 'in_progress', active: {...active, kind: 'banked_reset', stage: 'in_progress', expectedAt: undefined}, latestCompletion: completed}, now);
  assert.equal(ongoing.title, '发卡进行中'); assert.equal(ongoing.currentStage, 1); assert.equal(ongoing.completed, false);
  for (const statementAt of ['2026-10-14T04:00:00Z', '2026-10-15T04:00:01Z', 'invalid']) {
    const model = statusTimelineModel({status: 'completed', latestCompletion: {...completed, statementAt}}, now);
    assert.equal(model.title, '等待预告'); assert.equal(model.currentStage, -1);
  }
});
