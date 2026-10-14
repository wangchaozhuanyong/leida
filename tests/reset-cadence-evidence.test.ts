import test from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence, Source } from '../src/lib/types';
import { extractCadenceObservations } from '../src/server/reset-cadence-evidence';

const source: Source = { id: 'reset-archive', name: 'Reset archive', kind: 'archive', url: 'https://codex-resets.com/zh-CN', enabled: true, validated: true, intervalMinutes: 5, version: 1, status: 'healthy' };
const official: Source = { ...source, id: 'official-status', kind: 'status', url: 'https://status.openai.com/api/v2/incidents.json' };
const at = '2026-10-02T21:18:48Z', collectedAt = '2026-10-10T00:00:00Z', cutoff = '2026-10-11T03:00:00Z';
const evidence = (text: string, overrides: Partial<Evidence> = {}): Evidence => ({ id: 'e1', sourceId: source.id, messageId: '2106131810921136451', url: 'https://x.com/thsottiaux/status/2106131810921136451', text, publishedAt: at, collectedAt, hash: text, contextComplete: false, historical: true, provenance: 'archive', textOrigin: 'original', ...overrides });
const observations = (items: Evidence[], sources: Source[] = [source], atCutoff = cutoff) => extractCadenceObservations(items, sources, atCutoff);

test('免费动态仅固定适配器与原文来源身份进入观察，不借免费字样信任其他地址',()=>{
 const free:Source={...source,id:'tibo-public',kind:'timeline',url:'https://api.fxtwitter.com/2/profile/thsottiaux/statuses'};
 const item=evidence('We have reset usage limits for all paid Codex users.',{sourceId:free.id,metadata:{sourceGroup:'fxembed:thsottiaux'}});
 assert.equal(observations([item],[free]).length,1);
 for(const bad of [{...item,textOrigin:'archive_excerpt' as const},{...item,metadata:{sourceGroup:'unknown'}},{...item,provenance:'manual' as const}])assert.equal(observations([bad],[free]).length,0);
 assert.equal(observations([item],[{...free,url:'https://example.com/statuses'}]).length,0);
 assert.equal(observations([item],[{...free,enabled:false}]).length,0);
});

test('明确完整原帖可修复旧完整性标记过窄造成的历史漏样本', () => {
  const [result] = observations([evidence('We have reset usage limits for all paid Codex users. Enjoy!')]);
  assert.equal(result.kind, 'automatic_reset'); assert.equal(result.at, '2026-10-02T21:18:48.000Z');
  assert.deepEqual(result.evidenceIds, ['e1']);
});

test('备用卡按原文分类；不采用辅助日历的regular标签', () => {
  const [result] = observations([evidence("We have added a banked reset to everyone's account. You can apply the reset to replenish weekly usage.", { metadata: { benefitKind: 'automatic_reset' } })]);
  assert.equal(result.kind, 'banked_reset');
  const [mixed] = observations([evidence('We have reset usage limits for all paid accounts. We have added a banked reset to all paid accounts.')]);
  assert.equal(mixed.kind, 'unspecified');
});

test('公开传播短句只记录未分类公共动态，不假装个人已到账', () => {
  for (const text of ['Reset all propagated. Enjoy.', 'Resets all propagated. Sweet dreams.', 'All reset for everyone. Enjoy the week.']) {
    assert.equal(observations([evidence(text)])[0]?.kind, 'unspecified', text);
  }
});

test('预告与不明主体回复不纳入已经开始的历史序列', () => {
  for (const text of ['Global reset by EOD. May the tokens do good things for you.', 'We will reset usage limits for all users in 3 hours.', 'Confirmed landed across all accounts.', 'It is done.', 'Ah yeah, forgot to say', 'Reset button pressed, should see it in a bit.', 'Rate limit reset incoming.']) {
    assert.equal(observations([evidence(text)]).length, 0, text);
  }
});

test('当前发放中的明确公共声明能作为动态，但不借预告推断完成', () => {
  assert.equal(observations([evidence('We are giving all Codex users a usage reset on the house. Should be showing in your accounts in the next few hours.')])[0]?.kind, 'automatic_reset');
  assert.equal(observations([evidence('我们正在重置所有 Codex 和 ChatGPT Work 付费用户的用量。', { textOrigin: 'archive_excerpt', contextComplete: true })])[0]?.kind, 'automatic_reset');
});

test('享受重置的祝语紧接未来落地安排，不能当作已经开始的历史样本', () => {
  for (const text of [
    'Old news actually from a bunch of days ago, but crossed that 15M. Enjoy a nice reset everyone. Landing in the next hour or so, go /fast.',
    'Enjoy a nice reset everyone. Landing tomorrow.',
    'Enjoy a nice reset everyone. Will land in the next hour.',
    'Enjoy a nice reset everyone. Lands tomorrow.',
    'Enjoy a nice reset everyone, landing in the next hour or so.',
    'Enjoy a nice reset everyone. It will land tomorrow.',
  ]) assert.equal(observations([evidence(text)]).length, 0, text);
  assert.equal(observations([evidence('Enjoy a nice reset everyone.')])[0]?.kind, 'unspecified', '没有未来安排时保留原有公开祝语样本规则');
  assert.equal(observations([evidence('We are giving all Codex users a usage reset on the house. Landing in the next hour.')])[0]?.kind, 'automatic_reset', '明确正在发放的声明不被传播时间排除');
  assert.equal(observations([evidence('We have reset usage limits for all paid Codex users. Enjoy a nice reset everyone. Landing tomorrow.')])[0]?.kind, 'automatic_reset', '独立明确完成声明不借祝语改写');
});

test('额度异常描述和里程碑人数不会替换后方明确普发资格', () => {
  assert.equal(observations([evidence("We don't have evidence of a widespread issue with usage being drained faster but we have reset rate limits for plus & pro subscriptions while we continue investigating.")])[0]?.kind, 'automatic_reset');
  assert.equal(observations([evidence('We hit 25M active users and to celebrate we have now reset usage for all paid subscriptions for Codex.')])[0]?.kind, 'automatic_reset');
  assert.equal(observations([evidence('We have reset the usage limits for everyone in Codex and the team will continue to work on the underlying cause.')])[0]?.kind, 'automatic_reset');
  assert.equal(observations([evidence("For Codex users, to thank you all, our first gift is that we have **reset rate limits and are lifting the usage limits to 2X**. Enjoy.")])[0]?.kind, 'automatic_reset');
});

test('个人操作、定向补偿、撤回、否认和假设不成为公共重置观察', () => {
  for (const text of ['We have reset usage limits for selected users.', 'We have added a banked reset to 500k users.', 'I have reset usage limits for my account.', 'All users have purchased banked resets.', 'We have not reset usage for all accounts.', 'If we have reset usage limits for all users, it could help.', 'Correction: no reset occurred. The previous announcement was withdrawn.']) {
    assert.equal(observations([evidence(text)]).length, 0, text);
  }
});

test('截断译文即使已有完成标记，也不能作为历史样本', () => {
  for (const item of [
    evidence('我们已重置所有用户的使用限制。更多背景如下：', { textOrigin: 'archive_excerpt', contextComplete: true }),
    evidence('我已重置每个人的使用限制。它的意思是', { textOrigin: 'archive_excerpt', contextComplete: true }),
    evidence('We have reset usage limits for all users…', { contextComplete: true }),
    evidence('我们已重置所有用户的使用限制。关于具体范围，后续详情如下：', { textOrigin: 'archive_excerpt', contextComplete: false }),
  ]) assert.equal(observations([item]).length, 0);
  assert.equal(observations([evidence('我们正在向所有 Plus、Pro 和 Business 用户账户加载一次 banked reset。', { textOrigin: 'archive_excerpt', contextComplete: true })])[0]?.kind, 'banked_reset');
});

test('目标是公开重置动态，明确产品声明未列全体资格时保持未分类', () => {
  for (const text of [
    'Codex outage resolved. We have reset the rate limits. Please report any issues.',
    'We rewrote the underlying system to track usage in Codex and we have reset usage limits in the process.',
    'To celebrate efficiency I have reset usage limits for Codex and ChatGPT Work. Enjoy.',
    'Reset has been propagated to accounts and we landed some fixes to usage. Good Sunday.',
  ]) assert.equal(observations([evidence(text)])[0]?.kind, 'unspecified', text);
  for (const text of [
    'We have reset usage limits for your account in Codex.',
    'Enjoy a full reset of your usage limits for ChatGPT Work and Codex. Propagating in the next hour.',
    'I have allowed Codex to reset its own rate limits across all plans.',
    'Brand new me and brand new usage for all Codex users. Feeling reseted.',
    'Codex will reset rate limits in a bit.',
  ]) assert.equal(observations([evidence(text)]).length, 0, text);
});

test('语法曾未支持但完整的辅助正文可训练；不会成为实际发放状态', () => {
  const [ongoing] = observations([evidence('现在每周有三百万人使用 Codex。为了庆祝，我们正在重置速率限制，而且我们还会再次重置它们。', { textOrigin: 'archive_excerpt', contextComplete: false })]);
  assert.equal(ongoing.kind, 'unspecified');
  const [delivered] = observations([evidence('我们的 Codex 和 ChatGPT Work 用户再次获得一次重置。应该过一会儿就能恢复每周使用额度了', { textOrigin: 'archive_excerpt', contextComplete: false })]);
  assert.equal(delivered.kind, 'unspecified');
});

test('先选截止内同一原帖最新版本，新的更正不会留下旧正例', () => {
  const old = evidence('Reset all propagated.');
  const corrected = evidence('Correction: we did not reset usage limits for all users.', { id: 'e2', collectedAt: '2026-10-10T03:00:00Z' });
  assert.equal(observations([old, corrected]).length, 0);
  assert.equal(observations([old, corrected], [source], '2026-10-10T01:00:00Z').length, 1);
});

test('X别名和observed身份按真实原帖URL合并，错误消息身份拒绝', () => {
  const old = evidence('Reset all propagated.');
  const newest = evidence('Reset all propagated.', { id: 'e2', messageId: 'observed-20261002', url: `${old.url.replace('x.com', 'twitter.com')}?ref=archive`, collectedAt: '2026-10-10T01:00:00Z' });
  const results = observations([old, newest]);
  assert.equal(results.length, 1); assert.equal(results[0].url, old.url); assert.deepEqual(results[0].evidenceIds, ['e2']);
  assert.equal(observations([evidence('Reset all propagated.', { messageId: 'other-post' })]).length, 0);
});

test('当前训练不能使用未来发布时间或未来采集的证据', () => {
  for (const changes of [{ publishedAt: '2026-10-12T00:00:00Z' }, { collectedAt: '2026-10-12T00:00:00Z' }, { collectedAt: 'invalid' }, { publishedAt: 'invalid' }]) assert.equal(observations([evidence('Reset all propagated.', changes)]).length, 0);
  assert.equal(observations([evidence('Reset all propagated.')], [source], 'invalid').length, 0);
});

test('禁用、未验证、手工或冒名来源都不用于自动预测训练', () => {
  for (const src of [{ ...source, enabled: false }, { ...source, validated: false }, { ...source, kind: 'manual' as const }, { ...source, url: 'https://untrusted.example/zh-CN' }]) assert.equal(observations([evidence('Reset all propagated.')], [src]).length, 0);
  assert.equal(observations([evidence('Reset all propagated.', { provenance: 'manual' })]).length, 0);
  assert.equal(observations([evidence('Reset all propagated.', { url: 'https://x.com/impersonator/status/2106131810921136451' })]).length, 0);
  const incident = evidence('We have reset Codex usage limits for all users.', { sourceId: official.id, messageId: 'update1', url: 'https://status.openai.com/incidents/incident123', provenance: 'official', textOrigin: 'structured', contextComplete: true });
  assert.equal(observations([incident], [official])[0]?.kind, 'automatic_reset');
});

test('同一时刻的互相矛盾证据副本不择优造样本', () => {
  assert.equal(observations([evidence('Reset all propagated.'), evidence('No reset occurred.', { id: 'e2' })]).length, 0);
});

const parentPost = (text = "Loading a banked reset in everyone's paid accounts.", overrides: Partial<Evidence> = {}) => evidence(text, { id: 'parent', messageId: '2107913674593644711', url: 'https://x.com/thsottiaux/status/2107913674593644711', publishedAt: '2026-10-07T19:15:00Z', contextComplete: true, ...overrides });
const replyPost = (text = 'Confirmed landed across all accounts. How are we doing so far?', overrides: Partial<Evidence> = {}) => evidence(text, { id: 'reply', messageId: '2108040921044639779', url: 'https://x.com/thsottiaux/status/2108040921044639779', parentId: '2107913674593644711', publishedAt: '2026-10-08T03:44:55Z', ...overrides });

test('已保存明确父帖可为简短完成回复提供主题，训练引用保留父帖证据', () => {
  const result = observations([parentPost(), replyPost()]).find(item => item.url.endsWith('/2108040921044639779'));
  assert.equal(result?.kind, 'banked_reset'); assert.deepEqual(result?.evidenceIds, ['parent', 'reply']);
  assert.equal(result?.at, '2026-10-08T03:44:55.000Z');
  const global = parentPost('Global reset by EOD. May the tokens do good things for you.');
  const [completed] = observations([global, replyPost('Put the reset in the bag. All propagated.')]);
  assert.equal(completed?.kind, 'automatic_reset'); assert.deepEqual(completed?.evidenceIds, ['parent', 'reply']);
});

test('时间相邻或者只有bare completion不能自动继承主题', () => {
  assert.equal(observations([replyPost()]).length, 0);
  const results = observations([parentPost(), replyPost(undefined, { parentId: undefined })]);
  assert.equal(results.some(item => item.url.endsWith('/2108040921044639779')), false);
});

test('明确产品更新父帖的落地回复不能借发布时间转成福利完成', () => {
  const product = parentPost('Codex update is live. We released a navigation fix for all users.', { metadata: { category: 'product' } });
  assert.equal(observations([product, replyPost()]).length, 0);
});

test('父帖未来发布时间、未来采集、未保存、手工来源或不可信来源不能提供资格', () => {
  for (const changes of [
    { publishedAt: '2026-10-12T00:00:00Z' }, { collectedAt: '2026-10-12T00:00:00Z' },
    { publishedAt: '2026-10-09T00:00:00Z' }, { provenance: 'manual' as const }, { sourceId: 'untrusted' },
    { url: 'https://x.com/impersonator/status/2107913674593644711' }, { textOrigin: 'archive_excerpt' as const },
    { contextComplete: false },
  ]) {
    const results = observations([parentPost(undefined, changes), replyPost()]);
    assert.equal(results.some(item => item.url.endsWith('/2108040921044639779')), false, JSON.stringify(changes));
  }
});

test('父帖同一最新时刻互相冲突或者多个福利主题不择优继承', () => {
  const results = observations([parentPost(), parentPost('We have not added any banked resets.', { id: 'denied' }), replyPost()]);
  assert.equal(results.some(item => item.url.endsWith('/2108040921044639779')), false);
  const mixed = parentPost('We will reset usage limits for all paid accounts. We will add a banked reset to all paid accounts.');
  assert.equal(observations([mixed, replyPost()]).some(item => item.url.endsWith('/2108040921044639779')), false);
});

test('最新父帖更正否认后旧正例不能继续为回复提供资格', () => {
  const results = observations([parentPost(), parentPost('Correction: no banked reset will be given.', { id: 'corrected', collectedAt: '2026-10-10T01:00:00Z' }), replyPost()]);
  assert.equal(results.some(item => item.url.endsWith('/2108040921044639779')), false);
});

test('明确多级父链可解析；循环父链和私下完成声明拒绝', () => {
  const middle = replyPost('Will be there in a few hours.', { id: 'middle', publishedAt: '2026-10-08T00:00:00Z', contextComplete: false });
  const leaf = replyPost(undefined, { id: 'leaf', messageId: '2109132167112782291', url: 'https://x.com/thsottiaux/status/2109132167112782291', parentId: middle.messageId, publishedAt: '2026-10-08T03:44:55Z' });
  const final = observations([parentPost(), middle, leaf]).find(item => item.url.endsWith('/2109132167112782291'));
  assert.equal(final?.kind, 'banked_reset'); assert.deepEqual(final?.evidenceIds, ['leaf', 'middle', 'parent']);
  assert.equal(observations([parentPost(undefined, { parentId: middle.messageId }), middle, leaf]).some(item => item.url.endsWith('/2109132167112782291')), false);
  assert.equal(observations([parentPost(), replyPost('Confirmed landed in my account only.')]).some(item => item.url.endsWith('/2108040921044639779')), false);
});
