import test from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence, Source } from '../src/lib/types';
import { buildResetCadenceForecast } from '../src/lib/reset-cadence';
import { extractCadenceObservations } from '../src/server/reset-cadence-evidence';

const cutoff = '2026-01-06T00:00:00Z';
const source: Source = { id: 'tibo-public', name: 'Fixture', kind: 'timeline', url: 'https://api.fxtwitter.com/2/profile/thsottiaux/statuses', enabled: true, validated: true, status: 'healthy', intervalMinutes: 2, version: 1, lastSuccessAt: cutoff };
const item = (id: string, text: string, publishedAt = '2026-01-02T00:00:00Z', parentId?: string): Evidence => ({ id: `e${id}`, sourceId: source.id, messageId: id, url: `https://x.com/thsottiaux/status/${id}`, text, publishedAt, collectedAt: new Date(Date.parse(publishedAt) + 60_000).toISOString(), parentId, hash: text, historical: false, provenance: 'archive', textOrigin: 'original', contextComplete: true, metadata: { sourceGroup: 'fxembed:thsottiaux' } });
const extract = (rows: Evidence[]) => extractCadenceObservations(rows, [source], cutoff);

test('定向和核心未能核实的资格不能由统计回退分支改成普发样本', () => {
  const restricted = [
    'We have reset Codex usage limits for some Pro users.',
    'We have reset Codex usage limits for certain paid accounts.',
    'We have reset Codex usage limits for all users if their accounts were created before today.',
    'We have reset Codex usage limits for all users unless their account is new.',
    'We have reset Codex usage limits for users in China.',
    'We have reset Codex usage limits for all users except accounts in China.',
    'We have reset Codex usage limits for all users who registered before today.',
    'We have reset Codex usage limits for all users registered before 2026-01-01 00:00 UTC.',
    'We have reset Codex usage limits for eligible users.',
    'We have reset Codex usage limits for all users with active invitations.',
    '我们已重置中国地区所有 Codex 用户的使用限制。',
  ];
  for (const [index, text] of restricted.entries()) assert.deepEqual(extract([item(String(20000 + index), text)]), [], text);
});

test('完整普发和未知具体套餐的公开产品完成声明仍可训练，预告不能训练', () => {
  assert.equal(extract([item('20100', 'We have reset usage limits for all paid Codex users.')])[0]?.kind, 'automatic_reset');
  assert.equal(extract([item('20101', 'We are giving a banked reset to all paid Codex accounts. Landing in 90 minutes.')])[0]?.kind, 'banked_reset');
  assert.equal(extract([item('20102', 'Codex outage resolved. We have reset the rate limits. Please report any issues.')])[0]?.kind, 'unspecified');
  assert.equal(extract([item('20103', 'We will reset usage limits for all paid Codex accounts in 90 minutes.')]).length, 0);
});

test('同轮支撑引用截止于最近唯一福利声明，产品祖先不合并相隔72小时的独立轮次', () => {
  const product = item('20200', 'Codex navigation update is live.', '2026-01-01T00:00:00Z');
  const usage = item('20201', 'We will reset usage limits for all paid ChatGPT accounts.', '2026-01-02T00:00:00Z', product.messageId);
  const usageDone = item('20202', 'Put the reset in the bag. All propagated.', '2026-01-02T06:00:00Z', usage.messageId);
  const banked = item('20203', 'We will give a banked reset to all paid ChatGPT accounts.', '2026-01-05T00:00:00Z', product.messageId);
  const bankedDone = item('20204', 'Confirmed landed across all accounts.', '2026-01-05T06:00:00Z', banked.messageId);
  const rows = [product, usage, usageDone, banked, bankedDone];
  const before = structuredClone(rows), observations = extract(rows);
  assert.equal(observations.length, 2);
  assert.deepEqual(observations[0].evidenceIds, [usage.id, usageDone.id]);
  assert.deepEqual(observations[1].evidenceIds, [banked.id, bankedDone.id]);
  const forecast = buildResetCadenceForecast({ observations, generatedAt: cutoff, inputFingerprint: 'separate-rounds' });
  assert.equal(forecast.observations.length, 2); assert.equal(forecast.historicalIntervals[0]?.hours, 72);
  assert.deepEqual(rows, before);
});

test('同类独立轮次也不借共同产品祖先去重，多层同轮进展仍保留必要支撑', () => {
  const product = item('20300', 'Codex navigation update is live.', '2026-01-01T00:00:00Z');
  const first = item('20301', 'We will give a banked reset to all paid ChatGPT accounts.', '2026-01-02T00:00:00Z', product.messageId);
  const firstDone = item('20302', 'Confirmed landed across all accounts.', '2026-01-02T06:00:00Z', first.messageId);
  const second = item('20303', 'We will give a banked reset to all paid ChatGPT accounts.', '2026-01-05T00:00:00Z', product.messageId);
  const middle = item('20304', 'Will be there in a few hours.', '2026-01-05T02:00:00Z', second.messageId);
  const secondDone = item('20305', 'Confirmed landed across all accounts.', '2026-01-05T06:00:00Z', middle.messageId);
  const observations = extract([product, first, firstDone, second, middle, secondDone]);
  assert.deepEqual(observations.at(-1)?.evidenceIds, [second.id, middle.id, secondDone.id]);
  const forecast = buildResetCadenceForecast({ observations, generatedAt: cutoff, inputFingerprint: 'same-kind-rounds' });
  assert.equal(forecast.observations.length, 2); assert.equal(forecast.historicalIntervals[0]?.hours, 72);
});

test('多动作或带限制的近父帖不能跳过后借更老普发主题提供资格', () => {
  const root = item('20400', 'We will give a banked reset to all paid ChatGPT accounts.', '2026-01-01T00:00:00Z');
  const texts = [
    'We will reset usage limits for all paid ChatGPT accounts. We will give a banked reset to all paid ChatGPT accounts.',
    'We will give a banked reset to some Pro users.',
    'We will give a banked reset to all accounts if they registered before today.',
  ];
  for (const [index, text] of texts.entries()) {
    const parent = item(String(20401 + index), text, '2026-01-02T00:00:00Z', root.messageId);
    const reply = item(String(20410 + index), 'Confirmed landed across all accounts.', '2026-01-02T06:00:00Z', parent.messageId);
    assert.equal(extract([root, parent, reply]).some(row => row.url === reply.url), false, text);
  }
});

test('完成回复自身的未知成员条件不能被父帖普发范围盖过', () => {
  const parent = item('20500', 'We will give a banked reset to all paid ChatGPT accounts.');
  for (const [index, text] of ['Confirmed landed across all accounts in China.', 'Confirmed landed across all accounts if they registered before today.', 'Confirmed landed across some Pro accounts.'].entries()) {
    const reply = item(String(20501 + index), text, '2026-01-02T06:00:00Z', parent.messageId);
    assert.equal(extract([parent, reply]).some(row => row.url === reply.url), false, text);
  }
});
