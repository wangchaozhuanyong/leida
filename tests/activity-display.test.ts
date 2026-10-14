import test from 'node:test';
import assert from 'node:assert/strict';
import type { Activity } from '../src/lib/types';
import { activityDayNumber, activityHideDate, activityHomeVisible } from '../src/lib/activity-display';

const activity: Activity = { id: 'display-fixture', title: '测试活动', timezone: 'Asia/Shanghai', startsOn: '2026-07-01', days: 28, rules: '测试规则', version: 1, items: [] };

test('28天活动结束后完整保留3个活动日，在第32天零点隐藏', () => {
  assert.equal(activityHideDate(activity), '2026-08-01');
  assert.equal(activityDayNumber(activity, '2026-07-28T12:00:00+08:00'), 28);
  for (const date of ['2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31']) {
    assert.equal(activityHomeVisible(activity, `${date}T23:59:59+08:00`), true, date);
  }
  assert.equal(activityHomeVisible(activity, '2026-07-31T15:59:59.999Z'), true);
  assert.equal(activityHomeVisible(activity, '2026-07-31T16:00:00.000Z'), false);
  assert.equal(activityDayNumber(activity, '2026-07-31T16:00:00Z'), 32);
});

test('按活动时区计算，与UTC日期及读者所在地无关', () => {
  const west = { ...activity, timezone: 'America/Los_Angeles', startsOn: '2026-10-05' };
  assert.equal(activityHideDate(west), '2026-11-05');
  assert.equal(activityDayNumber(west, '2026-10-10T06:59:59Z'), 5);
  assert.equal(activityDayNumber(west, '2026-10-10T07:00:00Z'), 6);
  assert.equal(activityHomeVisible(west, '2026-11-05T07:59:59.999Z'), true);
  assert.equal(activityHomeVisible(west, '2026-11-05T08:00:00Z'), false);
});

test('夏令时切换仍完整保留3个日历日，不按72小时提前或延后隐藏', () => {
  const spring = { ...activity, startsOn: '2026-03-06', days: 1, timezone: 'America/Los_Angeles' };
  assert.equal(activityHideDate(spring), '2026-03-10');
  assert.equal(activityHomeVisible(spring, '2026-03-10T06:59:59Z'), true);
  assert.equal(activityHomeVisible(spring, '2026-03-10T07:00:00Z'), false);
  const autumn = { ...spring, startsOn: '2026-10-30' };
  assert.equal(activityHideDate(autumn), '2026-11-03');
  assert.equal(activityHomeVisible(autumn, '2026-11-03T07:59:59Z'), true);
  assert.equal(activityHomeVisible(autumn, '2026-11-03T08:00:00Z'), false);
});

test('旧活动默认显示，后台手动关闭立即隐藏，开启不能绕过到期规则', () => {
  const now = '2026-07-06T12:00:00+08:00';
  assert.equal(activityHomeVisible(activity, now), true);
  assert.equal(activityHomeVisible({ ...activity, showOnHome: false }, now), false);
  assert.equal(activityHomeVisible({ ...activity, showOnHome: true }, now), true);
  assert.equal(activityHomeVisible({ ...activity, showOnHome: true }, '2026-08-01T00:00:00+08:00'), false);
});

test('尚未开始的活动可预告；闰日和年末正确计算隐藏日期', () => {
  assert.equal(activityDayNumber(activity, '2026-06-30T12:00:00+08:00'), 0);
  assert.equal(activityHomeVisible(activity, '2026-06-30T12:00:00+08:00'), true);
  assert.equal(activityHideDate({ ...activity, startsOn: '2024-02-28', days: 2 }), '2024-03-04');
  assert.equal(activityHideDate({ ...activity, startsOn: '2026-12-31', days: 1 }), '2027-01-04');
});

test('不完整或非法的活动日期、时区和天数不能误显示', () => {
  for (const patch of [{ startsOn: '2026-02-30' }, { startsOn: '' }, { timezone: 'invalid-zone' }, { days: 0 }, { days: 1.5 }, { days: 367 }]) {
    assert.equal(activityDayNumber({ ...activity, ...patch }, '2026-07-06T00:00:00Z'), undefined);
    assert.equal(activityHomeVisible({ ...activity, ...patch }, '2026-07-06T00:00:00Z'), false);
  }
  assert.equal(activityHomeVisible(activity, 'invalid-time'), false);
});

test('到期只计算入口可见性，不修改活动及历史条目', () => {
  const original = { ...activity, items: [{ day: 1, articleId: 'article-fixture', eventId: 'event-fixture' }] };
  const before = structuredClone(original);
  assert.equal(activityHomeVisible(original, '2026-08-10T00:00:00Z'), false);
  assert.deepEqual(original, before);
});
