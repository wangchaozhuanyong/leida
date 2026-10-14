import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { BenefitAction, DraftContent, Evidence, RadarEvent } from '../src/lib/types';
import { buildAutomaticTemplate, normalizedEligibility } from '../src/server/automatic-content';
import { mergeActions, noticeKey, validateDraft } from '../src/server/domain';
import { hasCompleteContext, isTruncatedText } from '../src/server/source-context';

// Historical expectations are independently recorded source assessments, not
// current database labels. All examples below the historical section are synthetic.
interface HistorySample {
  key: string;
  label: string;
  evidence: Evidence;
  expected: Pick<BenefitAction, 'kind' | 'stage' | 'scope' | 'eligibility'>[];
}
const history = JSON.parse(readFileSync(new URL('../outputs/implementation-qa/history-evidence-samples-20261010.json', import.meta.url), 'utf8')) as { samples: HistorySample[] };
const at = '2026-10-10T04:00:00.000Z';
function synthetic(text: string, extra: Partial<Evidence> = {}): Evidence {
  return { id: 'synthetic-evidence', sourceId: 'reset-archive', messageId: 'synthetic-message', url: 'https://x.com/repair_fixture/status/synthetic-message', text, hash: text, contextComplete: true, historical: false, publishedAt: at, collectedAt: at, provenance: 'archive', textOrigin: 'original', ...extra };
}
function claimed(evidence: Evidence, extra: Partial<BenefitAction> = {}): DraftContent {
  return { title: '公告称福利已完成', summary: '用于校验错误候选的合成测试，不能作为历史事实。', translation: '', category: 'reset', publicationMode: 'state_change', contentOrigin: 'generated', evidenceIds: [evidence.id], actions: [{ id: 'synthetic-action', kind: 'banked_reset', stage: 'claimed_complete', eligibility: '所有账户', scope: 'public', statementAt: evidence.publishedAt, evidenceIds: [evidence.id], evidenceQuote: evidence.text, ...extra }] };
}
function state(evidence: Evidence): DraftContent {
  const content = buildAutomaticTemplate([evidence]);
  assert.ok(content, '完整明确证据应生成中文事实模板');
  assert.equal(content.publicationMode, 'state_change');
  assert.match(content.title, /[\u3400-\u9fff]/);
  assert.match(content.summary, /[\u3400-\u9fff]/);
  assert.deepEqual(validateDraft(content, [evidence], true), [], '模板事实必须同时通过自动发布校验');
  return content;
}
function noPublicBenefit(evidence: Evidence): void {
  const content = buildAutomaticTemplate([evidence]);
  assert.ok(!content?.actions.some(action => action.scope === 'public'), `不能自动生成普发：${evidence.text}`);
  if (content) assert.deepEqual(validateDraft(content, [evidence], true), [], '模板若生成新闻，应是合法的新闻候选');
}
function radar(action: BenefitAction): RadarEvent {
  return { id: 'synthetic-event', title: '合成事件', version: 1, status: 'published', actions: [action], evidenceIds: action.evidenceIds, publicationId: 'synthetic-publication', updatedAt: at };
}
function canonicalAudience(value: string): string {
  // Independent comparison of the recorded historical truth: ignore product
  // order and display synonyms, but preserve permissions, plan and scope words.
  let text = value.toLowerCase().replace(/\s+/g, '').replace(/[，。,:：、()（）'’的]/g, '');
  const products: string[] = [];
  for (const product of ['chatgptwork', 'codex', 'chatgpt']) {
    if (text.includes(product)) { products.push(product); text = text.replaceAll(product, ''); }
  }
  text = text.replace(/帐号|账号|用户|accounts?|users?/g, '账户').replace(/全部|每个|每位|每一位|每个人|all|everyone(?:s)?/g, '所有').replace(/和|与|以及|and|&/g, '');
  return `${products.sort().join(',')}|${text}`;
}

test('历史真值固定为 15 条样本、4 条明确动作，不能取当前标签作为答案', () => {
  assert.equal(history.samples.length, 15);
  assert.equal(history.samples.filter(sample => sample.expected.length).length, 4);
});
for (const sample of history.samples) {
  test(`真实历史回放：${sample.label}`, () => {
    if (!sample.expected.length) { noPublicBenefit(sample.evidence); return; }
    const content = state(sample.evidence);
    assert.deepEqual(content.actions.map(({ kind, stage, scope }) => ({ kind, stage, scope })), sample.expected.map(({ kind, stage, scope }) => ({ kind, stage, scope })));
    for (const [index, action] of content.actions.entries()) {
      assert.equal(canonicalAudience(action.eligibility), canonicalAudience(sample.expected[index].eligibility), '资格必须与独立历史真值一致，不能省略产品或权限范围');
      assert.ok(action.evidenceQuote && sample.evidence.text.includes(action.evidenceQuote), '动作证据必须逐字存在于正文');
      assert.equal(action.statementAt, sample.evidence.publishedAt, '不得用采集时间伪装公告时间');
      if (sample.key === 'banked-delay-promise-paid') {
        assert.equal(action.expectedAt, '2026-09-04T02:12:09.000Z', '首张卡约3小时的预计点只按该原帖时间加3小时，不代表绝对截止');
        assert.match(action.timeNote!, /^原文近似时间：.*并非最晚截止.*未给出误差范围/);
      } else {
        assert.equal(action.expectedAt, undefined, '其他三条未提供明确预计点，a few hours不能伪造时长');
      }
    }
    if (sample.key === 'banked-delay-promise-paid') {
      assert.match(content.actions[0].eligibility, /Astra/i);
      assert.match(content.actions[0].eligibility, /付费|paid/i);
      assert.match(content.actions[0].eligibility, /尚未|未获|未开通|未拥有|未取得|未具备|没有|无.*权限|don.?t have|without|lack/i);
      assert.notEqual(normalizedEligibility(content.actions[0].eligibility), normalizedEligibility('所有付费账户'), 'Astra 权限条件不能消失');
    }
  });
}

const nonGrants: [string, string][] = [
  ['已有库存', 'We have a banked reset in inventory for all accounts.'],
  ['商店选项', 'We have added a banked reset option to the store for all accounts.'],
  ['主动用卡', 'All accounts can use an existing banked reset to replenish weekly usage.'],
  ['购买额度', 'We have added a banked reset to all accounts that purchased extra credits.'],
  ['邀请奖励', 'We have added a banked reset to all invited accounts as a referral reward.'],
  ['私人结转', 'We have added a banked reset just to your account as a private carryover.'],
  ['否定发卡', "We have not added a banked reset to everyone's account."],
  ['尚未发卡', "We haven't loaded a banked reset for all accounts yet."],
  ['疑问发卡', "Have we added a banked reset to everyone's account?"],
  ['条件假设', "If we have added a banked reset to everyone's account, please let us know."],
  ['账户自行操作', 'Users have added a banked reset to their accounts by buying credits.'],
  ['账户自行操作带时间副词', 'All paid users have already added a banked reset to their own accounts.'],
  ['定向故障补偿', 'We have loaded a banked reset for selected paid accounts affected by the outage.'],
  ['故障中的意外额度变化', 'Some Codex users may be experiencing unexpected usage limit resets.'],
  ['未知资格', 'We have reset Codex usage limits for users.'],
  ['无关所有人的句子', 'All people are welcome. We have reset Codex usage limits for the group.'],
  ['中文已有卡', '所有付费账户可以使用已有的重置卡恢复每周额度。'],
  ['中文购卡', '已为所有购买加量包的账户添加重置卡。'],
  ['中文邀请奖励', '已为所有受邀账户发放邀请奖励重置卡。'],
  ['中文私人结转', '已为你的账户单独存入个人结转重置卡。'],
  ['中文条件假设', '如果已为所有账户发放重置卡，请检查余额。'],
  ['中文疑问', '已为所有付费账户发放重置卡了吗？'],
  ['中文未知资格', '我们已经重置了使用限额。'],
];
for (const [label, text] of nonGrants) {
  test(`合成反例：${label}不能自动普发`, () => noPublicBenefit(synthetic(text)));
}

test('合成错误模型候选：库存、疑问、条件与购买不能绕过校验', () => {
  for (const label of ['已有库存', '商店选项', '购买额度', '邀请奖励', '疑问发卡', '条件假设', '账户自行操作', '账户自行操作带时间副词', '中文条件假设', '中文疑问']) {
    const text = nonGrants.find(item => item[0] === label)![1];
    const evidence = synthetic(text);
    assert.ok(validateDraft(claimed(evidence), [evidence], true).length, `错误模型声明必须被拦截：${label}`);
  }
});

test('合成正例：直引号和弯引号的 everyone’s 都能明确已发卡', () => {
  for (const apostrophe of ["'", '’']) {
    const content = state(synthetic(`We have added a banked reset to everyone${apostrophe}s account.`));
    assert.equal(content.actions.length, 1);
    assert.equal(content.actions[0].kind, 'banked_reset');
    assert.equal(content.actions[0].stage, 'claimed_complete');
  }
});

test('合成正例：缓解措施的完成不能跨句借成额度完成', () => {
  const evidence = synthetic('We have applied mitigations. We are giving all Codex users a usage reset on the house. It should appear in the next few hours.');
  const content = state(evidence);
  assert.equal(content.actions[0].kind, 'automatic_reset');
  assert.equal(content.actions[0].stage, 'in_progress');
  assert.ok(!content.actions[0].evidenceQuote?.includes('applied mitigations'));
  assert.equal(content.actions[0].expectedAt, undefined);
  assert.ok(validateDraft(claimed(evidence, { kind: 'automatic_reset' }), [evidence], true).length, '整段中的措施完成不能授权福利完成');
});

test('合成正例：双动作分别绑定不同阶段和资格', () => {
  const evidence = synthetic('We have reset Codex usage limits for all accounts. We will give one banked reset to all paid ChatGPT accounts.');
  const content = state(evidence);
  assert.equal(content.actions.length, 2);
  const usage = content.actions.find(action => action.kind === 'automatic_reset')!;
  const card = content.actions.find(action => action.kind === 'banked_reset')!;
  assert.equal(usage.stage, 'claimed_complete');
  assert.equal(card.stage, 'promised');
  assert.notEqual(normalizedEligibility(usage.eligibility), normalizedEligibility(card.eligibility));
  assert.match(card.eligibility, /付费|paid/i);
  assert.match(usage.evidenceQuote ?? '', /We have reset Codex usage limits for all accounts/);
  assert.ok(!usage.evidenceQuote?.includes('banked reset'), '额度证据不应借用卡的预告');
  assert.match(card.evidenceQuote ?? '', /We will give one banked reset to all paid ChatGPT accounts/);
  assert.ok(!card.evidenceQuote?.includes('We have reset'), '卡证据不应借用额度的完成');
});

test('合成正例：中文同句双动作不共享完成状态', () => {
  const content = state(synthetic('已为所有账户重置用量，重置卡将于明天为所有付费账户发放。'));
  assert.equal(content.actions.length, 2);
  assert.equal(content.actions.find(action => action.kind === 'automatic_reset')?.stage, 'claimed_complete');
  const card = content.actions.find(action => action.kind === 'banked_reset')!;
  assert.equal(card.stage, 'promised');
  assert.match(card.eligibility, /付费/);
  assert.equal(card.expectedAt, undefined, '发布者时区不明确时不能猜明天绝对时间');
});

test('合成反例：完整标记不能使句尾连接词和未完成列表放行', () => {
  for (const text of [
    '已为所有账户发放重置卡。并非一个核心问题，而是',
    'We have reset Codex usage limits for all accounts, but',
    '我们将为所有付费账户发放重置卡，具体要求如下：',
  ]) {
    const evidence = synthetic(text, { contextComplete: true });
    assert.equal(isTruncatedText(text), true, text);
    assert.equal(hasCompleteContext(evidence, [evidence]), false, 'contextComplete 不能绕过截断检测');
    noPublicBenefit(evidence);
    assert.ok(validateDraft(claimed(evidence), [evidence], true).length);
  }
});

test('合成反例：归档摘要和标题不能补成原帖福利资格', () => {
  const evidence = synthetic('Confirmed landed across all accounts.', { contextComplete: false, metadata: { title: '给所有付费账户重置卡', summary: '已为所有付费账户发放重置卡。', benefitKind: 'banked_reset' } });
  noPublicBenefit(evidence);
});

test('合成正例：资格归一化保留权限、日期和地区条件', () => {
  const pairs = [
    ['尚未获得 Astra 访问权限的付费账户', '所有付费账户'],
    ['2026年10月9日前注册的 Pro 套餐账户', '所有 Pro 套餐账户'],
    ['中国地区 Plus 套餐账户', '所有 Plus 套餐账户'],
    ["paid ChatGPT accounts without access to Astra", 'all paid ChatGPT accounts'],
  ];
  for (const [restricted, unrestricted] of pairs) {
    assert.notEqual(normalizedEligibility(restricted), normalizedEligibility(unrestricted), restricted);
    const action = claimed(synthetic('We have added a banked reset to all paid accounts.')).actions[0];
    const original = radar({ ...action, eligibility: restricted });
    const changed = radar({ ...action, eligibility: unrestricted });
    assert.ok(noticeKey(changed, original), '实质资格变化必须改变提醒含义');
    assert.throws(() => mergeActions(original.actions, changed.actions), /资格|更正/);
  }
  assert.equal(normalizedEligibility('所有付费账户'), normalizedEligibility('全部付费用户'), '纯同义措辞不应制造资格变化');
});

test('合成错误模型候选：不能把有权限条件的付费人群扩大为全部付费账户', () => {
  const evidence = synthetic("We will give one banked reset to all paid accounts that do not have access to Astra.");
  const widened = claimed(evidence, { stage: 'promised', eligibility: '所有付费账户' });
  assert.ok(validateDraft(widened, [evidence], true).length);
});

test('合成错误模型候选：缺少资格不能通过完整标记兜底成所有账户', () => {
  const evidence = synthetic('We have reset Codex usage limits for users.', { contextComplete: true });
  assert.ok(validateDraft(claimed(evidence, { kind: 'automatic_reset' }), [evidence], true).length);
});

test('合成正例：PST按字面UTC-8给出带说明的日终预计，未知PT时区仍留空', () => {
  const evidence = synthetic('We will load a banked reset for all paid accounts by EOD PST.');
  const content = state(evidence);
  assert.equal(content.actions[0].stage, 'promised');
  assert.equal(content.actions[0].expectedAt, '2026-10-10T08:00:00.000Z', '源PST日期仍为10月9日，日终换算为次日08:00Z');
  assert.match(content.actions[0].timeNote!, /原文承诺日终前完成.*按原文PST字面UTC-8换算.*未自行改用当地夏令时.*仍待实际确认/);
  const wrong = { ...content, actions: content.actions.map(action => ({ ...action, expectedAt: '2026-10-11T07:00:00.000Z' })) };
  assert.ok(validateDraft(wrong, [evidence], true).length, '不能暗改成PDT或自行顺延原帖的日终日期');
  for (const text of ['We will load a banked reset for all paid accounts by EOD PT.', 'We will load a banked reset for all paid accounts by EOD.']) {
    const unclear = synthetic(text), draft = state(unclear);
    assert.equal(draft.actions[0].stage, 'promised');
    assert.equal(draft.actions[0].expectedAt, undefined);
    assert.match(draft.actions[0].timeNote!, /日期、精度或时区尚不明确，未生成精确截止/);
    const guessed = { ...draft, actions: draft.actions.map(action => ({ ...action, expectedAt: '2026-10-10T08:00:00.000Z' })) };
    assert.ok(validateDraft(guessed, [unclear], true).length, '无明确时区的注记不能配上猜出的UTC时刻');
  }
});

test('合成反例：影响新户资格的歧义截止仍待补证', () => {
  noPublicBenefit(synthetic('We will load a banked reset for all Plus and Pro accounts created before 8 PM Pacific time today.'));
  noPublicBenefit(synthetic('将为所有在今天太平洋时间晚上8点前注册的 Plus 和 Pro 账户发放重置卡。'));
  noPublicBenefit(synthetic('We will give a banked reset to all paid accounts created before 2026-10-11 20:00.'));
});

test('合成反例：Astra 权限条件不能吞掉同句地区与注册资格', () => {
  const evidence = synthetic('We will give one banked reset to all paid ChatGPT accounts in China created before 2026-10-09 20:00 UTC that do not have access to Astra.');
  const content = buildAutomaticTemplate([evidence]);
  // Unsupported compound conditions may wait for evidence/model processing.
  // If mechanically published, every explicit condition must remain observable.
  for (const action of content?.actions ?? []) {
    assert.match(action.eligibility, /Astra/i);
    assert.match(action.eligibility, /China|中国/i);
    assert.match(action.eligibility, /2026[-年/]10[-月/]0?9|2026-10-09/i);
  }
  const narrowed = claimed(evidence, { stage: 'promised', eligibility: '尚未获得 Astra 访问权限的付费 ChatGPT 账户' });
  assert.ok(validateDraft(narrowed, [evidence], true).length, '模型不能只保留权限条件而抹掉地区与注册截止');
});

test('合成正例：明确绝对发放时间与卡有效期不能互换', () => {
  const evidence = synthetic('We will load a banked reset for all paid accounts by 2026-10-11 10:00 UTC. The banked reset expires at 2026-10-12 10:00 UTC.');
  const content = state(evidence);
  assert.equal(content.actions.length, 1);
  assert.equal(Date.parse(content.actions[0].expectedAt ?? ''), Date.parse('2026-10-11T10:00:00.000Z'));
  assert.equal(content.actions[0].stage, 'promised');
});

const unhandledConditions: [string, string, RegExp][] = [
  ['非白名单地区', 'We have added a banked reset to all paid accounts in Germany.', /德国|Germany/i],
  ['已获得权限', 'We have added a banked reset to all paid accounts with access to Astra.', /Astra/i],
  ['最短订阅时长', 'We have added a banked reset to all paid accounts with at least 30 days of subscription.', /至少.*30|at least 30/i],
  ['中文非白名单地区', '已为德国地区的所有付费账户发放重置卡。', /德国|Germany/i],
  ['中文已获得权限', '已为所有已经获得 Astra 访问权限的付费账户发放重置卡。', /Astra/i],
  ['中文最短订阅时长', '已为所有订阅至少30天的付费账户发放重置卡。', /至少.*30|at least 30/i],
];
for (const [label, text, restriction] of unhandledConditions) {
  test(`合成资格反例：${label}不能被未知语法静默抹掉`, () => {
    const evidence = synthetic(text);
    const content = buildAutomaticTemplate([evidence]);
    // Finite rules may defer unknown grammar. A supported publication must retain
    // the condition; public refers to the announced qualified cohort, not everyone.
    for (const action of content?.actions ?? []) {
      assert.match(action.eligibility, restriction);
      assert.notEqual(normalizedEligibility(action.eligibility), normalizedEligibility('付费账户'));
      if (/已获得权限/.test(label)) assert.doesNotMatch(action.eligibility, /尚未|未获|don't|without/i);
    }
    assert.ok(validateDraft(claimed(evidence, { eligibility: '付费账户' }), [evidence], true).length, '模型不能扩大成无条件付费人群');
  });
}
