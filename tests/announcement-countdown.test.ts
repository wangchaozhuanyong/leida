import test from 'node:test';
import assert from 'node:assert/strict';
import type { BenefitAction, PublicData, Publication } from '../src/lib/types';
import { announcementClock, announcementCountdown, displayTime, stageText, upcomingActions } from '../src/components/public/model';

test('原文近似安排显示约多久后，不表示最晚截止',()=>{
 const expectedAt='2026-10-11T07:00:00Z';
 assert.equal(announcementCountdown({expectedAt,timeNote:'原文近似时间：约3小时，并非最晚截止。'},'2026-10-11T04:00:00Z').label,'约3小时后');
 assert.equal(announcementCountdown({expectedAt,timeNote:'原文预计时刻：10am PST，仅为安排。'},'2026-10-11T04:00:00Z').label,'预计3小时后');
});

const statementAt = '2026-10-10T22:16:00Z';
const deadline = '2026-10-11T07:00:00Z';
const currentTime = '2026-10-11T02:25:00Z';
const action = (extra: Partial<BenefitAction> = {}): BenefitAction => ({
  id: 'reset-announcement', kind: 'automatic_reset', stage: 'promised', scope: 'public', eligibility: '所有账户',
  expectedAt: deadline, statementAt, evidenceIds: ['evidence'], timeNote: '原文为日终前，预计时间采用公开归档换算。', ...extra,
});
const data = (extra: Partial<BenefitAction> = {}, historical = false): PublicData => {
  const publication: Publication = {
    id: 'publication', eventId: 'event', articleId: 'article', cutoffAt: statementAt, publishedAt: statementAt, reason: '公开预告',
    event: { id: 'event', title: '全局重置预告', version: 1, status: 'published', publicationId: 'publication', updatedAt: statementAt, evidenceIds: ['evidence'], actions: [action(extra)] },
    article: { id: 'article', eventId: 'event', title: '全局重置预告', summary: '日终前安排全局重置。', translation: '', category: 'reset', version: 1, status: 'published', publicationId: 'publication', evidenceIds: ['evidence'], publishedAt: statementAt, updatedAt: statementAt, sourcePublishedAt: statementAt, historical },
  };
  return {
    serverTime: currentTime, publications: [publication], events: [publication.event], articles: [publication.article],
    evidence: [], activities: [], notices: [], sources: [], site: { name: '模钥重置雷达', description: '', version: 1, autoPublish: true },
  };
};

test('预告剩余时间是距截止的上界，小时分钟和北京时间可准确展示', () => {
  assert.deepEqual(announcementCountdown(action(), currentTime), { status: 'upcoming', label: '预计4小时35分钟内' });
  assert.equal(announcementCountdown(action(), '2026-10-11T02:00:00Z').label, '预计5小时内');
  assert.equal(announcementCountdown(action(), '2026-10-11T06:59:59.500Z').label, '预计1分钟内');
  assert.equal(announcementCountdown(action(), '2026-10-09T06:00:00Z').label, '预计2天1小时内');
  assert.match(displayTime(deadline), /15:00/);
});

test('截止时及截止后只等待确认，不将预告改为完成', () => {
  const promised = action(), before = structuredClone(promised);
  for (const now of [deadline, '2026-10-11T07:00:00.001Z', '2026-10-12T07:00:00Z']) {
    assert.deepEqual(announcementCountdown(promised, now), { status: 'expired', label: '已过预计时间 · 等待确认' });
    assert.equal(stageText(promised, now), '已过预计时间 · 等待确认');
    assert.equal(stageText(action({ stage: 'in_progress' }), now), '已过预计时间 · 等待确认');
  }
  assert.deepEqual(promised, before);
});

test('缺失或无效预计时间不显示倒计时，不把日终文案猜成精确时间', () => {
  for (const expectedAt of [undefined, '', '时间待明确']) {
    assert.deepEqual(announcementCountdown(action({ expectedAt }), currentTime), { status: 'unknown', label: '时间待明确' });
  }
  assert.deepEqual(announcementCountdown(action(), '无效时间'), { status: 'unknown', label: '时间待明确' });
  assert.equal(stageText(action({ expectedAt: undefined }), currentTime), '发放预告');
});

test('浏览器只按服务器基准及单调流逝更新时间，异常流逝不修改基准', () => {
  assert.equal(announcementClock(currentTime, 60_000), '2026-10-11T02:26:00.000Z');
  for (const invalid of [-1, NaN, Infinity]) assert.equal(announcementClock(currentTime, invalid), '2026-10-11T02:25:00.000Z');
  assert.equal(announcementClock('无效时间', 60_000), '无效时间');
  const atDeadline = announcementClock(currentTime, Date.parse(deadline) - Date.parse(currentTime));
  assert.equal(announcementCountdown(action(), atDeadline).status, 'expired');
});

test('实时预告逾期仍待确认，完成取消撤回排除，历史预告只有未来时间进入首页', () => {
  const live = data(), before = structuredClone(live);
  assert.equal(upcomingActions(live, deadline).length, 1);
  assert.equal(upcomingActions(live, '2026-10-12T07:00:00Z').length, 1);
  assert.equal(upcomingActions(data({ stage: 'in_progress' }), deadline).length, 1);
  for (const stage of ['claimed_complete', 'cancelled'] as const) {
    assert.deepEqual(upcomingActions(data({ stage })), []);
    assert.notEqual(stageText(action({ stage }), deadline), '已过预计时间 · 等待确认');
  }
  assert.equal(upcomingActions(data({}, true)).length, 1);
  assert.deepEqual(upcomingActions(data({}, true), deadline), []);
  assert.equal(upcomingActions(data({ expectedAt: undefined })).length, 1);
  assert.deepEqual(upcomingActions(data({ expectedAt: undefined }, true)), []);
  const withdrawn = data(); withdrawn.events[0].status = 'withdrawn';
  assert.deepEqual(upcomingActions(withdrawn), []);
  assert.deepEqual(live, before);
});
