import test from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence } from '../src/lib/types';
import { buildAutomaticTemplate } from '../src/server/automatic-content';
import { validateDraft } from '../src/server/domain';
import { benefitTime, extractBenefitClaims } from '../src/server/benefit-rules';
import { evidenceBenefitClaims } from '../src/server/source-context';

const at = '2026-08-13T01:01:37.000Z';
const original = (text: string): Evidence => ({
  id: 'relative-time-original', sourceId: 'tibo-public', messageId: 'relative-time-original',
  url: 'https://x.com/rule_fixture/status/relative-time-original', text, hash: text,
  publishedAt: at, collectedAt: at, contextComplete: true, historical: true,
  provenance: 'archive', textOrigin: 'original',
});

for (const [phrase, minutes, approximate] of [
  ['in the next hour or so', 60, true],
  ['in an hour', 60, false],
  ['in a hour', 60, false],
  ['in the next minute or so', 1, true],
  ['in a minute', 1, false],
  ['in an minute', 1, false],
  ['in 2 hours', 120, false],
  ['in 2 hours or so', 120, true],
  ['in 1.5 hours', 90, false],
  ['in the next 0.5 hours or so', 30, true],
  ['in 2.5 minutes', 2.5, false],
] as const) {
  test(`明确资格后的 ${phrase} 是时间，并保留原文近似程度`, () => {
    const text = `We will give a banked reset to all paid ChatGPT accounts ${phrase}.`;
    const claims = extractBenefitClaims(text, at);
    assert.equal(claims.length, 1, text);
    assert.equal(claims[0].kind, 'banked_reset');
    assert.equal(claims[0].stage, 'promised');
    assert.equal(claims[0].scope, 'public');
    assert.equal(claims[0].eligibility, '付费ChatGPT账户');
    assert.equal(claims[0].expectedAt, new Date(Date.parse(at) + minutes * 60_000).toISOString());
    assert.match(claims[0].timeNote!, approximate ? /近似时间.*并非最晚截止/ : /预计时刻.*并非最晚截止/);
    const evidence = original(text), draft = buildAutomaticTemplate([evidence])!;
    assert.equal(draft.publicationMode, 'state_change');
    assert.equal(draft.actions[0].stage, 'promised', '预计时间不代表已完成');
    assert.equal(draft.actions[0].expectedAt, claims[0].expectedAt);
    assert.deepEqual(validateDraft(draft, [evidence], true), []);
  });
}

test('同一时间语法支持明确用量重置，产品与付费限制不会丢失', () => {
  const text = 'We will reset usage for all paid ChatGPT Work and Codex users in the next hour or so.';
  const claim = extractBenefitClaims(text, at)[0];
  assert.ok(claim);
  assert.equal(claim.kind, 'automatic_reset');
  assert.equal(claim.eligibility, '付费ChatGPT Work和Codex账户');
  assert.equal(claim.expectedAt, '2026-08-13T02:01:37.000Z');
  assert.equal(claim.stage, 'promised');
});

test('时间片段后仍有地区或资格条件时，不按单纯时间放行', () => {
  for (const phrase of [
    'in China', 'in the United States', 'in Europe', 'in EU', 'in UK',
    'in the next hour or so in China',
    'in the next 1.5 hours or so in China',
    'in the next hour or so who created their accounts today',
    'in the next hour or so if you create your account by 8pm PT',
    'in the next hour or so except users in China',
    'in the next hour or so unless you are a Pro user',
  ]) {
    const text = `We will give a banked reset to all paid ChatGPT accounts ${phrase}.`;
    assert.equal(extractBenefitClaims(text, at).length, 0, text);
    assert.ok(!buildAutomaticTemplate([original(text)])?.actions.length, text);
  }
});

test('选定套餐与故障账户仍为定向，时间不能扩大为公共发卡', () => {
  for (const audience of [
    'selected Pro ChatGPT accounts',
    'affected Codex accounts',
    'selected Pro accounts affected by the outage only',
  ]) {
    const text = `We will give a banked reset to ${audience} in the next hour or so.`;
    const claim = extractBenefitClaims(text, at)[0];
    assert.ok(claim, text);
    assert.equal(claim.scope, 'targeted', text);
    assert.equal(claim.expectedAt, '2026-08-13T02:01:37.000Z', text);
    assert.match(claim.eligibility, /限定范围/, text);
    if (audience.includes('Pro')) assert.match(claim.eligibility, /Pro套餐/, text);
    if (audience.includes('outage')) assert.match(claim.eligibility, /outage only/, text);
    const evidence = original(text), draft = buildAutomaticTemplate([evidence])!;
    assert.equal(draft.publicationMode, 'news_only', text);
    assert.deepEqual(draft.actions, [], text);
    assert.deepEqual(validateDraft(draft, [evidence], true), [], text);
  }
});

test('未来时间不覆盖否定、假设、私人或取消状态', () => {
  for (const text of [
    'We will not give a banked reset to all paid ChatGPT accounts in the next hour or so.',
    'We might give a banked reset to all paid ChatGPT accounts in the next hour or so.',
    'If we give a banked reset to all paid ChatGPT accounts in the next hour or so, it might help.',
    'We will give a banked reset to your account only in the next hour or so.',
    'We will give a banked reset to selected Pro ChatGPT accounts in the next hour or so?',
  ]) assert.equal(extractBenefitClaims(text, at).length, 0, text);
  const cancelled = extractBenefitClaims('We have cancelled the banked reset for all paid ChatGPT accounts. It was expected in the next hour or so.', at)[0];
  assert.ok(cancelled);
  assert.equal(cancelled.stage, 'cancelled');
  assert.equal(cancelled.expectedAt, undefined, '取消不保留未来发放时间');
});

test('三个历史漏识别样本不因时间修复而被猜成公共重置', () => {
  for (const text of [
    'Old news actually from a bunch of days ago, but crossed that 15M. Enjoy a nice reset everyone. Landing in the next hour or so, go /fast.',
    'Never slept better and feeling reseted. Brand new me and brand new usage for all ChatGPT Work and Codex users. Regaining my youth one button press at a time. Happy Thursday',
    "Some Plus and Business users won't yet get access to Astra today, we've got you covered with a banked reset. Lands by end of day and if you create your account by 8pm PT then you'll get it too.",
  ]) {
    assert.equal(extractBenefitClaims(text, at).length, 0, text);
    assert.ok(!buildAutomaticTemplate([original(text)])?.actions.length, text);
  }
  const approximate = benefitTime('Landing in the next hour or so.', at);
  assert.equal(approximate.expectedAt, '2026-08-13T02:01:37.000Z');
  assert.match(approximate.timeNote!, /近似时间/);
});

test('真实泛称重置父链仍不补造用量或重置卡类型', () => {
  const parent: Evidence = {
    ...original('I previously promised a reset for every 1M in additional active users for Codex, until 10M. We blew past that and have been silent since 10M. Little surprise for you tomorrow.'),
    id: 'historical-parent', messageId: '2087423996115681767',
    url: 'https://x.com/thsottiaux/status/2087423996115681767',
    publishedAt: '2026-08-12T06:20:37.793Z', contextComplete: false,
  };
  const child: Evidence = {
    ...original('Old news actually from a bunch of days ago, but crossed that 15M. Enjoy a nice reset everyone. Landing in the next hour or so, go /fast.'),
    id: 'historical-child', messageId: '2087706104814023111',
    url: 'https://x.com/thsottiaux/status/2087706104814023111',
    parentId: parent.messageId, contextComplete: false,
  };
  assert.deepEqual(evidenceBenefitClaims(child, [child, parent]), []);
  assert.ok(!buildAutomaticTemplate([child, parent])?.actions.length);
});
