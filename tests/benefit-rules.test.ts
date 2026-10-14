import test from 'node:test';
import assert from 'node:assert/strict';
import type { DraftContent, Evidence } from '../src/lib/types';
import { AUTOMATIC_RULES_VERSION, buildAutomaticTemplate, evidenceFingerprint, normalizedEligibility } from '../src/server/automatic-content';
import { validateDraft } from '../src/server/domain';
import { evidenceBenefitClaims, hasCompleteContext, hasStandaloneContext } from '../src/server/source-context';
import { benefitTime, eligibilityMatches, extractBenefitClaims, extractReplyClaims } from '../src/server/benefit-rules';
const at='2026-10-10T04:00:00.000Z';
const ev=(text:string,extra:Partial<Evidence>={}):Evidence=>({id:'e',sourceId:'reset-archive',messageId:'rule-test',url:'https://x.com/rule_fixture/status/rule-test',text,hash:text,publishedAt:at,collectedAt:at,contextComplete:true,historical:false,provenance:'archive',textOrigin:'original',...extra});

test('辅助归档即使旧标记完整，也只能发布注明来源的中文新闻',()=>{
  const e=ev('已为所有付费账户发放重置卡。',{textOrigin:'archive_excerpt'});
  assert.equal(hasCompleteContext(e,[e]),false);
  const content=buildAutomaticTemplate([e])!;
  assert.equal(content.publicationMode,'news_only');assert.equal(content.actions.length,0);assert.deepEqual(validateDraft(content,[e],true),[]);
});
test('规则版本是可解析指纹前缀，原证据摘要保持稳定',()=>{
  const e=ev('We have added a banked reset to all paid accounts.');
  assert.match(evidenceFingerprint([e]),new RegExp(`^${AUTOMATIC_RULES_VERSION}:[a-f0-9]{64}$`));
  assert.equal(evidenceFingerprint([e]),evidenceFingerprint([{...e,collectedAt:'2026-10-11T04:00:00Z'}]));
});
test('双动作独立相对期限由原帖时间换算，明确旧期限不变完成',()=>{
  const e=ev('We will reset usage for all paid accounts within 2 hours. We will load a banked reset for all free accounts in 3 hours.');
  const content=buildAutomaticTemplate([e])!;
  assert.deepEqual(content.actions.map(a=>a.expectedAt),['2026-10-10T06:00:00.000Z','2026-10-10T07:00:00.000Z']);
  assert.deepEqual(validateDraft(content,[e],true),[]);
  const old=ev('将为所有付费账户发放重置卡，预计2025年1月1日18:00（北京时间）。');
  const draft=buildAutomaticTemplate([old])!;assert.equal(draft.actions[0].expectedAt,'2025-01-01T10:00:00.000Z');assert.equal(draft.actions[0].stage,'promised');assert.deepEqual(validateDraft(draft,[old],true),[]);
});
test('动作声明时间不能提前回填或借另一个引用时间',()=>{
  const e=ev('We have added a banked reset to all paid accounts.');
  const draft=buildAutomaticTemplate([e])!;
  for(const statementAt of ['2026-10-09T04:00:00.000Z','2026-10-11T04:00:00.000Z'])assert.ok(validateDraft({...draft,actions:draft.actions.map(a=>({...a,statementAt}))},[e],true).some(r=>r.includes('声明时间')));
});
test('套餐与产品顺序同义，资格条件和产品范围仍有不同含义',()=>{
  assert.equal(normalizedEligibility('所有 Pro、Plus 套餐账户'),normalizedEligibility('所有 Plus、Pro 套餐用户'));
  assert.equal(normalizedEligibility('所有 Codex 和 ChatGPT Work 用户'),normalizedEligibility('所有 ChatGPT Work 和 Codex 账户'));
  assert.notEqual(normalizedEligibility('所有 Codex 用户'),normalizedEligibility('所有账户'));
  assert.notEqual(normalizedEligibility('尚未获得Astra访问权限的付费账户'),normalizedEligibility('所有付费账户'));
});
test('affected账户的忠实中文资格可核验，不丢弃其他定向限制',()=>{
  for(const text of [
    'Correction: we have reset usage limits only for the affected accounts.',
    'Correction: we have reset usage limits only for affected users.',
  ]) {
    const evidence=ev(text),claim=extractBenefitClaims(text,at)[0];
    assert.equal(claim.scope,'targeted');
    assert.equal(eligibilityMatches(claim.eligibility,'受影响账户'),true,text);
    const draft:DraftContent={title:'用量重置资格更正',summary:'仅受影响账户的用量已重置。',translation:'',category:'reset',evidenceIds:[evidence.id],actions:[{id:'qualified-correction',kind:claim.kind,stage:claim.stage,scope:claim.scope,eligibility:'受影响账户',statementAt:at,evidenceIds:[evidence.id],evidenceQuote:claim.quote}]};
    assert.deepEqual(validateDraft(draft,[evidence],true),[],text);
    assert.ok(validateDraft({...draft,actions:draft.actions.map(action=>({...action,scope:'public'}))},[evidence],true).some(reason=>/定向/.test(reason)),'译文同义不能扩大为普发');
  }
  for(const text of [
    'Correction: we have reset usage limits only for affected Codex accounts.',
    'Correction: we have reset usage limits only for affected Pro accounts.',
    'Correction: we have reset usage limits only for selected affected accounts.',
    'Correction: we have reset usage limits only for affected accounts affected by the outage only.',
  ]) {
    const claim=extractBenefitClaims(text,at)[0];
    assert.ok(claim,text);
    assert.equal(eligibilityMatches(claim.eligibility,'受影响账户'),false,text);
  }
  assert.equal(eligibilityMatches('所有账户（限定范围：affected accounts in China.）','受影响账户'),false,'地区仍须保留');
  const selected=extractBenefitClaims('Correction: we have loaded banked resets for selected Pro accounts affected by the outage only.',at)[0];
  assert.equal(eligibilityMatches(selected.eligibility,'Pro套餐账户'),false,'套餐名称不能替代selected和故障限制');
  assert.equal(eligibilityMatches(selected.eligibility,selected.eligibility),true);
});
test('用户自行添加、未支持排除条件与数额定向不能升级为普发',()=>{
  for(const text of ['All users have added a banked reset to their accounts.','We have added a banked reset to all paid accounts except users in China.','Added a banked reset to 500,000 paid accounts.'])assert.ok(!buildAutomaticTemplate([ev(text)])?.actions.some(a=>a.scope==='public'),text);
});
test('完整原帖没有辅助分类时，明确中文产品动态仍可自动成文且不制造福利',()=>{
  const e=ev('Codex客户端新增中文用量提示功能。',{metadata:{sourceGroup:'synthetic-sourceGroup'}});
  const draft=buildAutomaticTemplate([e])!;
  assert.equal(draft.publicationMode,'news_only');assert.equal(draft.actions.length,0);assert.equal(draft.category,'product');assert.deepEqual(validateDraft(draft,[e],true),[]);
  assert.equal(hasStandaloneContext('公开来源记录了旧产品更新。','product'),false,'没有明确产品主体不能靠完整标记补证');
  assert.equal(hasStandaloneContext('公开来源记录了 Codex 旧产品更新。','product'),true);
});

const scheduledAt = '2026-10-11T07:00:00.000Z';
const announcementAt = '2026-10-10T22:16:00.000Z';
const globalAnnouncement = 'Global reset by EOD. May the tokens do good things for you.';
const scheduledEvidence = (extra: Partial<Evidence> = {}): Evidence => ev(globalAnnouncement, {
  messageId: '2106000000000000000', url: 'https://x.com/thsottiaux/status/2106000000000000000',
  publishedAt: announcementAt, collectedAt: '2026-10-10T22:20:00.000Z',
  metadata: { sourceGroup: 'codex-resets', scheduledReset: { expectedAt: scheduledAt, kind: 'automatic_reset', sourceUrl: 'https://codex-resets.com/zh-CN' } },
  ...extra,
});

test('真实全局日终短句可生成预告，不臆造套餐或无时区截止', () => {
  const evidence = scheduledEvidence({ metadata: { sourceGroup: 'codex-resets' } });
  const draft = buildAutomaticTemplate([evidence])!;
  assert.equal(draft.publicationMode, 'state_change');
  assert.equal(draft.actions.length, 1);
  assert.equal(draft.actions[0].kind, 'automatic_reset');
  assert.equal(draft.actions[0].stage, 'promised');
  assert.equal(draft.actions[0].eligibility, '全局范围（原帖未列明具体套餐）');
  assert.equal(draft.actions[0].expectedAt, undefined);
  assert.match(draft.actions[0].timeNote!, /未生成精确截止/);
  assert.deepEqual(validateDraft(draft, [evidence], true), []);
  const forced = { ...draft, actions: draft.actions.map(action => ({ ...action, expectedAt: scheduledAt })) };
  assert.ok(validateDraft(forced, [evidence], true).some(reason => reason.includes('预计时间')));
  const chinese = extractBenefitClaims('今日结束前将进行全局重置。愿这些代币能为你所用。', announcementAt);
  assert.equal(chinese[0].stage, 'promised');
  assert.equal(chinese[0].expectedAt, undefined);
  assert.match(chinese[0].timeNote!, /原文预计时间/);
});

test('完整原帖与固定归档关联日终安排共同生成注明来源的最晚预计时间', () => {
  const evidence = scheduledEvidence();
  const draft = buildAutomaticTemplate([evidence])!;
  assert.equal(draft.actions[0].expectedAt, scheduledAt);
  assert.match(draft.actions[0].timeNote!, /Codex Resets 归档/);
  assert.match(draft.actions[0].timeNote!, /仅供参考.*待实际重置确认/);
  assert.equal(draft.actions[0].evidenceQuote, 'Global reset by EOD.');
  assert.deepEqual(validateDraft(draft, [evidence], true), []);
});

test('日终按明确数值或PST/PDT字面时区换算并披露，未知时区不猜作者所在地', () => {
  assert.equal(benefitTime('Global reset by EOD UTC-7.', announcementAt).expectedAt, scheduledAt);
  assert.equal(benefitTime('Global reset before end of today UTC-7.', announcementAt).expectedAt, scheduledAt);
  assert.equal(benefitTime('明天结束前将进行全局重置（北京时间）。', announcementAt).expectedAt, '2026-10-12T16:00:00.000Z');
  assert.equal(benefitTime('Global reset by EOD.', announcementAt).expectedAt, undefined);
  assert.equal(benefitTime('Global reset by EOD PDT.', announcementAt).expectedAt, scheduledAt);
  assert.equal(benefitTime('Global reset by EOD PST.', announcementAt).expectedAt, '2026-10-11T08:00:00.000Z');
  assert.match(benefitTime('Global reset by EOD PST.', announcementAt).timeNote!, /PST.*UTC-8.*未自行改用当地夏令时/);
  const evidence = scheduledEvidence({ text: 'Global reset by EOD UTC+8.' });
  assert.equal(evidenceBenefitClaims(evidence, [evidence])[0].expectedAt, '2026-10-11T16:00:00.000Z', '明确原文时间不能被辅助归档覆盖');
});

test('辅助日终安排不能补完整原文、假设、否定、私人或定向重置', () => {
  for (const evidence of [
    scheduledEvidence({ textOrigin: 'archive_excerpt' }),
    scheduledEvidence({ contextComplete: false }),
    scheduledEvidence({ text: 'Global reset by EOD…' }),
  ]) {
    assert.equal(evidenceBenefitClaims(evidence, [evidence]).length, 0);
    assert.ok(!buildAutomaticTemplate([evidence])?.actions.length);
  }
  for (const text of [
    'No global reset by EOD.', 'Global reset will not happen by EOD.',
    'We might perform a global reset by EOD.', 'Rumor of a global reset by EOD.',
    'Global reset may happen by EOD.', 'Someone requested a global reset by EOD.',
    'Global reset by EOD for my account.', 'Global reset by EOD only for you.',
    'If we do a global reset by EOD, it might help.',
  ]) assert.equal(extractBenefitClaims(text, announcementAt).length, 0, text);
  const targeted = scheduledEvidence({ text: 'Global reset for selected users by EOD.' });
  assert.ok(!buildAutomaticTemplate([targeted])?.actions.some(action => action.scope === 'public'));
  assert.equal(evidenceBenefitClaims(targeted, [targeted])[0].expectedAt, undefined);
});

test('伪造来源、错类型或无效/不合理日期不能授权辅助精确截止', () => {
  const baseline = scheduledEvidence();
  const metadata = baseline.metadata!;
  const scheduledReset = metadata.scheduledReset!;
  const cases: Evidence[] = [
    scheduledEvidence({ sourceId: 'activity-archive' }), scheduledEvidence({ provenance: 'official' }),
    scheduledEvidence({ metadata: { ...metadata, sourceGroup: 'other-archive' } }),
    scheduledEvidence({ url: 'https://x.com/thsottiaux/status/2106000000000000001' }),
    scheduledEvidence({ url: 'https://x.com/other_account/status/2106000000000000000' }),
    ...[
      { sourceUrl: 'https://example.com/zh-CN' }, { sourceUrl: 'https://codex-resets.com/zh-CN?fake=1' },
      { kind: 'banked_reset' as const }, { expectedAt: 'invalid' }, { expectedAt: '2026-10-11' },
      { expectedAt: announcementAt }, { expectedAt: '2026-10-10T20:00:00.000Z' },
      { expectedAt: '2026-10-13T07:00:00.000Z' },
    ].map(change => scheduledEvidence({ metadata: { ...metadata, scheduledReset: { ...scheduledReset, ...change } } })),
    scheduledEvidence({ publishedAt: '2026-02-28T22:16:00.000Z', metadata: { ...metadata, scheduledReset: { ...scheduledReset, expectedAt: '2026-02-30T07:00:00.000Z' } } }),
  ];
  for (const evidence of cases) {
    const draft = buildAutomaticTemplate([evidence])!;
    assert.equal(draft.actions[0].expectedAt, undefined, JSON.stringify(evidence.metadata));
    const forced = { ...draft, actions: draft.actions.map(action => ({ ...action, expectedAt: scheduledAt })) };
    assert.ok(validateDraft(forced, [evidence], true).some(reason => reason.includes('预计时间')));
  }
});

test('辅助安排只适用于日终预告，不改进行中、完成、取消或其他期限', () => {
  for (const [text, stage] of [
    ['Global reset has completed by EOD.', 'claimed_complete'],
    ['Global reset is in progress by EOD.', 'in_progress'],
    ['Global reset by EOD is cancelled.', 'cancelled'],
    ['We will reset usage for all Codex accounts soon.', 'promised'],
  ] as const) {
    const evidence = scheduledEvidence({ text });
    const claims = evidenceBenefitClaims(evidence, [evidence]);
    assert.equal(claims[0].stage, stage, text);
    assert.equal(claims[0].expectedAt, undefined, text);
  }
});

test('no 否定重置卡与用量福利不能生成预告、完成或取消，也不能被模型候选绕过', () => {
  for (const text of [
    'No banked resets will be added to all paid accounts.',
    'No banked resets have been loaded for all paid accounts.',
    'No additional banked resets will be added to all paid accounts.',
    'No usage reset has completed for all Codex accounts.',
    'No usage limits have been reset for all Codex accounts.',
    'No banked resets will be cancelled for all paid accounts.',
    'We have not cancelled banked resets for all paid accounts.',
    '并未为所有付费账户发放重置卡。',
    '没有为所有Codex账户完成用量重置。',
    '并未取消为所有付费账户发放重置卡。',
  ]) {
    const evidence = ev(text);
    assert.equal(extractBenefitClaims(text, at).length, 0, text);
    assert.ok(!buildAutomaticTemplate([evidence])?.actions.length, text);
    const kind = /usage|用量/.test(text) ? 'automatic_reset' : 'banked_reset';
    const incorrect = {
      title: '公开重置公告', summary: '公开来源记录重置相关安排。', translation: '', category: 'reset' as const,
      publicationMode: 'state_change' as const, evidenceIds: [evidence.id], actions: [{
        id: 'unsupported', kind: kind as 'automatic_reset' | 'banked_reset', stage: 'claimed_complete' as const,
        scope: 'public' as const, eligibility: kind === 'automatic_reset' ? '所有Codex账户' : '付费账户',
        evidenceIds: [evidence.id], evidenceQuote: text, statementAt: at,
      }],
    };
    assert.ok(validateDraft(incorrect, [evidence], true).some(reason => reason.includes('完成声明')), text);
  }
});

test('正常取消及与福利无关的 no delays 不受否定阻断影响', () => {
  for (const text of [
    'We have cancelled banked resets for all paid accounts.',
    '取消为所有付费账户发放重置卡。',
  ]) {
    const evidence = ev(text), draft = buildAutomaticTemplate([evidence])!;
    assert.equal(draft.actions[0]?.stage, 'cancelled', text);
    assert.deepEqual(validateDraft(draft, [evidence], true), [], text);
  }
  const evidence = ev('No delays, we have loaded a banked reset for all paid accounts.');
  const draft = buildAutomaticTemplate([evidence])!;
  assert.equal(draft.actions[0]?.stage, 'claimed_complete');
  assert.deepEqual(validateDraft(draft, [evidence], true), []);
});

test('ISO 发放截止验证真实日历日期、闰年和数值时区，非法日期不能滚到另一日', () => {
  for (const iso of [
    '2026-02-30T18:00:00Z', '2026-02-29T18:00:00Z', '2026-04-31T18:00:00Z',
    '2026-13-01T18:00:00Z', '2026-10-11T24:00:00Z', '2026-10-11T18:60:00Z',
    '2026-10-11T18:00:60Z', '2026-10-11T18:00:00+14:01', '2026-10-11T18:00:00+15:00',
  ]) {
    const evidence = ev(`We will load a banked reset for all paid accounts at ${iso}.`);
    const draft = buildAutomaticTemplate([evidence])!;
    assert.equal(draft.actions[0]?.stage, 'promised', iso);
    assert.equal(draft.actions[0]?.expectedAt, undefined, iso);
    assert.deepEqual(validateDraft(draft, [evidence], true), [], iso);
    const forced = { ...draft, actions: draft.actions.map(action => ({ ...action, expectedAt: '2026-03-02T18:00:00.000Z' })) };
    assert.ok(validateDraft(forced, [evidence], true).some(reason => reason.includes('预计时间')), iso);
  }
  for (const [iso, expected] of [
    ['2028-02-29T18:00:00Z', '2028-02-29T18:00:00.000Z'],
    ['2026-10-11T18:00:00+08:00', '2026-10-11T10:00:00.000Z'],
    ['2026-10-11T18:00:00-07:00', '2026-10-12T01:00:00.000Z'],
    ['2026-10-11T18:00:00.123+14:00', '2026-10-11T04:00:00.123Z'],
  ]) {
    const evidence = ev(`We will load a banked reset for all paid accounts at ${iso}.`);
    const draft = buildAutomaticTemplate([evidence])!;
    assert.equal(draft.actions[0]?.expectedAt, expected, iso);
    assert.deepEqual(validateDraft(draft, [evidence], true), [], iso);
  }
});

test('明确单父承诺的英文取消或撤回回复停止同一福利预告，否定取消保持无动作', () => {
  const parent = ev('We will load a banked reset for all paid accounts within 2 hours.', {
    id: 'parent', messageId: '2109000000000000000', url: 'https://x.com/thsottiaux/status/2109000000000000000',
    publishedAt: '2026-10-10T03:00:00.000Z',
  });
  const reply = (text: string) => ev(text, {
    messageId: '2109132167112782291', url: 'https://x.com/thsottiaux/status/2109132167112782291',
    parentId: parent.messageId, contextComplete: false,
  });
  for (const text of ['Cancelled.', 'Canceled.', 'Withdrawn.', 'We withdrew it.']) {
    const child = reply(text);
    const draft = buildAutomaticTemplate([child, parent])!;
    assert.equal(draft.actions.length, 1, text);
    assert.equal(draft.actions[0].kind, 'banked_reset', text);
    assert.equal(draft.actions[0].stage, 'cancelled', text);
    assert.equal(draft.actions[0].eligibility, '付费账户', text);
    assert.equal(draft.actions[0].expectedAt, undefined, text);
    assert.deepEqual(validateDraft(draft, [child, parent], true), [], text);
  }
  for (const text of ['Not cancelled.', 'Not withdrawn.', 'We have not cancelled it.', 'Cancelled?']) {
    const child = reply(text);
    assert.equal(evidenceBenefitClaims(child, [child, parent]).length, 0, text);
    assert.ok(!buildAutomaticTemplate([child, parent])?.actions.length, text);
  }
  const missing = ev('Cancelled.', { parentId: 'unknown-parent', contextComplete: false });
  assert.ok(!buildAutomaticTemplate([missing])?.actions.length, '缺实际父帖不能取消任意一轮');
});

test('多父福利或双动作父帖的简短取消仍等待消歧，不取消所有轮次', () => {
  const banked = extractBenefitClaims('We will load a banked reset for all paid accounts.', at);
  const usage = extractBenefitClaims('We will reset usage for all Codex accounts.', at);
  for (const text of ['Cancelled.', 'Withdrawn.']) {
    assert.deepEqual(extractReplyClaims(text, at, [...banked, ...usage]), [], text);
    const parent = ev('We will load a banked reset for all paid accounts. We will reset usage for all Codex accounts.', {
      id: 'dual-parent', messageId: '2109000000000000000', url: 'https://x.com/thsottiaux/status/2109000000000000000',
    });
    const child = ev(text, {
      messageId: '2109132167112782291', url: 'https://x.com/thsottiaux/status/2109132167112782291',
      parentId: parent.messageId, contextComplete: false,
    });
    assert.equal(evidenceBenefitClaims(child, [child, parent]).length, 0, text);
    assert.ok(!buildAutomaticTemplate([child, parent])?.actions.length, text);
  }
});

test('UTC/GMT 数值时区最大为正负14整小时，不能把14小时后的分钟生成截止', () => {
  for (const zone of ['UTC+14:01', 'UTC-14:59', 'GMT+14:30', 'UTC+15:00']) {
    for (const text of [
      `Global reset by EOD ${zone}.`,
      `We will load a banked reset for all paid accounts at 2026-10-11 18:00 ${zone}.`,
      `We will load a banked reset for all paid accounts tomorrow at 18:00 ${zone}.`,
    ]) assert.equal(benefitTime(text, at).expectedAt, undefined, text);
  }
  assert.equal(benefitTime('Global reset by EOD UTC+14:00.', at).expectedAt, '2026-10-10T10:00:00.000Z');
  assert.equal(benefitTime('Global reset by EOD GMT-14:00.', at).expectedAt, '2026-10-10T14:00:00.000Z');
  assert.equal(benefitTime('We will load a banked reset for all paid accounts at 2026-10-11 18:00 UTC+14:00.', at).expectedAt, '2026-10-11T04:00:00.000Z');
});

test('真实AM/PM预告按原文明示时区的当地日期换算，tomorrow不按UTC日期猜测', () => {
  for (const [text, sourceAt, expected] of [
    ['The banked reset will be there by 8pm PST. For all paid users of ChatGPT Work and Codex.', '2026-08-21T23:40:34Z', '2026-08-22T04:00:00.000Z'],
    ['Global reset landing tomorrow 10am PST for all paid ChatGPT accounts.', '2026-10-02T02:14:51Z', '2026-10-02T18:00:00.000Z'],
    ['Landing 2:30pm PST', '2026-08-29T20:43:53Z', '2026-08-29T22:30:00.000Z'],
    ['Reset will land at 12am PDT today.', '2026-09-07T19:24:57Z', '2026-09-07T07:00:00.000Z'],
    ['Reset will land at 12pm PDT today.', '2026-09-07T19:24:57Z', '2026-09-07T19:00:00.000Z'],
  ]) {
    const time = benefitTime(text, sourceAt);
    assert.equal(time.expectedAt, expected, text);
    assert.match(time.timeNote!, /按原文P[SD]T字面UTC-[78].*未自行改用当地夏令时/);
  }
  const claims = extractBenefitClaims('The banked reset will be there by 8pm PST. For all paid users of ChatGPT Work and Codex.', '2026-08-21T23:40:34Z');
  assert.equal(claims[0]?.kind, 'banked_reset');
  assert.equal(claims[0]?.stage, 'promised');
  assert.equal(claims[0]?.expectedAt, '2026-08-22T04:00:00.000Z');
  assert.match(claims[0]?.eligibility!, /付费.*ChatGPT Work.*Codex/);
  for (const text of ['Global reset landing tomorrow 14pm PST for all paid accounts.', 'Reset at 0am PST.', 'Reset at 12:60pm PST.', 'Global reset by EOD PT.', 'Reset at 6pm PST PDT.']) {
    assert.equal(benefitTime(text, at).expectedAt, undefined, text);
  }
});

test('近似相对或当地时间保留原文预计点及非截止说明，不发明误差上下界', () => {
  const text = "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today. Team is moving mountains to give access as fast as we can. First one will land in ~ 3 hours.";
  const claims = extractBenefitClaims(text, '2026-09-03T23:12:09Z');
  assert.equal(claims[0]?.expectedAt, '2026-09-04T02:12:09.000Z');
  assert.match(claims[0]?.timeNote!, /^原文近似时间：.*并非最晚截止.*未给出误差范围/);
  assert.match(claims[0]?.eligibility!, /尚未获得Astra访问权限/);
  for (const [text, sourceAt, expected] of [
    ['Lands around 6pm PST today.', '2026-09-07T19:24:57Z', '2026-09-08T02:00:00.000Z'],
    ['Landing in the next hour or so.', '2026-08-13T01:01:37Z', '2026-08-13T02:01:37.000Z'],
    ['预计在约3小时后发放。', at, '2026-10-10T07:00:00.000Z'],
  ]) {
    const time = benefitTime(text, sourceAt);
    assert.equal(time.expectedAt, expected, text);
    assert.match(time.timeNote!, /^原文近似时间：.*并非最晚截止/);
  }
  assert.equal(benefitTime('First one will land in a few hours.', at).expectedAt, undefined);
  const qualified = benefitTime('Accounts created before 8pm PST will get a reset.', at);
  assert.equal(qualified.expectedAt, undefined);
  assert.match(qualified.timeNote!, /账户资格截止/);
  const separate = extractBenefitClaims('We will load banked resets for all paid accounts. We will reset usage for all paid accounts. Lands around 6pm PST.', at);
  assert.equal(separate[0]?.expectedAt, undefined, '后续另一福利的时间不借给第一福利');
  assert.equal(separate[1]?.expectedAt, '2026-10-10T02:00:00.000Z', '未说tomorrow的PST时刻按原帖当地日期换算，过去时刻不自行顺延');
});

test('原文预计点与最晚期限分开说明，明确缩写和重置拼写变体仍保留承诺阶段', () => {
  for (const text of ['Global reset landing tomorrow 10am PST for all paid accounts.', 'Reset will land at 12pm PDT today.', 'Landing in 3 hours.']) {
    assert.match(benefitTime(text,at).timeNote!,/^原文预计时刻：.*并非最晚截止/,text);
  }
  for (const text of ['The banked reset will be there by 8pm PST.', 'We will reset usage within 3 hours.', 'Global reset by EOD PST.']) {
    assert.ok(!/^原文预计时刻|^原文近似时间/.test(benefitTime(text,at).timeNote!),text);
  }
  assert.equal(extractBenefitClaims('We are reseting usage for all paid accounts.',at)[0]?.stage,'in_progress');
  assert.equal(extractBenefitClaims('We’ll reset usage limits for all paid users.',at)[0]?.stage,'promised');
  assert.equal(extractBenefitClaims('Maybe we’ll reset usage limits for all paid users.',at).length,0);
});

test('有明确父帖的BANKED完成、All reset及带无关问句的完成回复可核验', () => {
  const parent = ev('We will load a banked reset for all paid accounts.', {id:'parent',messageId:'2000000000000000000',url:'https://x.com/thsottiaux/status/2000000000000000000'});
  const child = (text:string) => ev(text,{id:'child',messageId:'2000000000000000001',url:'https://x.com/thsottiaux/status/2000000000000000001',parentId:parent.messageId,contextComplete:false});
  for (const text of ['The banked reset has landed, I repeat, the banked reset has landed. Have an amazing weekend.', 'Confirmed landed across all accounts. How are we doing so far?', 'All reset for everyone. Enjoy the week with Astra.']) {
    const reply = child(text), claims = evidenceBenefitClaims(reply,[reply,parent]);
    assert.equal(claims[0]?.kind,'banked_reset',text);
    assert.equal(claims[0]?.stage,'claimed_complete',text);
    assert.equal(claims[0]?.eligibility,'付费账户',text);
    const draft = buildAutomaticTemplate([reply,parent])!;
    assert.deepEqual(validateDraft(draft,[reply,parent],true),[],text);
  }
  const usage = ev('We will reset usage for all paid accounts.',{...parent,text:'We will reset usage for all paid accounts.'});
  const wrongKind = child('The banked reset has landed.');
  assert.deepEqual(evidenceBenefitClaims(wrongKind,[wrongKind,usage]),[]);
  for (const text of ['Confirmed landed?', 'Rumor: Confirmed landed.', 'Confirmed landed. Not all accounts got it.', 'Confirmed landed. It will land tomorrow.', 'The banked reset has not landed.']) {
    const reply = child(text);
    assert.deepEqual(evidenceBenefitClaims(reply,[reply,parent]),[],text);
  }
  const missing = child('Confirmed landed across all accounts.');
  assert.deepEqual(evidenceBenefitClaims(missing,[missing]),[]);
});

test('进度父帖的到达时间回复不回退状态，昨日前言不压制完整当前完成声明', () => {
  const parent = extractBenefitClaims('We are loading a banked reset into all paid accounts.', at);
  const update = extractReplyClaims('Will be there by EOD PST.', at,parent);
  assert.equal(update[0]?.stage,'in_progress');
  assert.equal(update[0]?.expectedAt,'2026-10-10T08:00:00.000Z');
  const text = 'What I wanted to say yesterday is that we hit 25M active users and to celebrate we have now reset usage for all paid subscriptions for ChatGPT Work and Codex.';
  assert.equal(hasStandaloneContext(text,'reset'),true);
  const draft = buildAutomaticTemplate([ev(text)])!;
  assert.equal(draft.actions[0]?.kind,'automatic_reset');
  assert.equal(draft.actions[0]?.stage,'claimed_complete');
  assert.equal(draft.actions[0]?.scope,'public');
  assert.match(draft.actions[0]?.eligibility!,/付费.*ChatGPT Work.*Codex/);
  assert.deepEqual(validateDraft(draft,[ev(text)],true),[]);
  assert.equal(hasStandaloneContext('Yesterday we will reset usage for all paid accounts.','reset'),false);
  assert.equal(hasStandaloneContext('I previously promised a reset for every 1M in additional active users. Little surprise tomorrow.','reset'),false);
});

test('credit用户with重置卡是发放对象，用途中的after不能误作账户资格', () => {
  const banked = 'Second of all, this is cause for celebration and during the day we will credit every Codex and ChatGPT Work user with a BANKED reset that you can use at your own leisure.';
  const bankedEvidence = ev(banked), bankedDraft = buildAutomaticTemplate([bankedEvidence])!;
  assert.equal(hasStandaloneContext(banked,'reset'),true);
  assert.equal(bankedDraft.actions[0]?.kind,'banked_reset');
  assert.equal(bankedDraft.actions[0]?.stage,'promised');
  assert.equal(bankedDraft.actions[0]?.eligibility,'所有ChatGPT Work和Codex账户');
  assert.equal(bankedDraft.actions[0]?.expectedAt,undefined,'during the day未给源时区，不能猜日终UTC');
  assert.deepEqual(validateDraft(bankedDraft,[bankedEvidence],true),[]);
  const text = 'We will do a global reset of the usage for all paid subscriptions so that you can keep enjoying Astra after burning through all of it doing fun 3D modeling in blender. The work week is about to start. Lands around 6pm PST today.';
  const parent = ev(text,{id:'global-parent',messageId:'2000000000000000100',publishedAt:'2026-09-07T19:24:57Z',url:'https://x.com/rule_fixture/status/2000000000000000100'});
  assert.equal(hasStandaloneContext(text,'reset'),true);
  const draft = buildAutomaticTemplate([parent])!;
  assert.equal(draft.actions[0]?.kind,'automatic_reset');
  assert.equal(draft.actions[0]?.eligibility,'付费账户');
  assert.equal(draft.actions[0]?.expectedAt,'2026-09-08T02:00:00.000Z');
  assert.match(draft.actions[0]?.timeNote!,/^原文近似时间：.*并非最晚截止/);
  assert.deepEqual(validateDraft(draft,[parent],true),[]);
  const child=ev('All reset for everyone. Enjoy the week with Astra.',{id:'global-child',messageId:'2000000000000000101',publishedAt:'2026-09-08T04:05:53Z',parentId:parent.messageId,contextComplete:false,url:'https://x.com/rule_fixture/status/2000000000000000101'});
  assert.equal(evidenceBenefitClaims(child,[child,parent])[0]?.stage,'claimed_complete');
  assert.equal(evidenceBenefitClaims(child,[child,parent])[0]?.eligibility,'付费账户');
  for (const text of [
    'We will credit all users who registered before 8pm PT with a BANKED reset.',
    'We will reset usage for all accounts with at least 30 days of subscription so that you can keep enjoying Astra.',
    'We will reset usage for all accounts created after 8pm PT so that you can keep enjoying Astra.',
  ]) assert.equal(extractBenefitClaims(text,at).length,0,'仍不能删掉真正的人群资格：'+text);
});

test('产品reset加紧邻消耗usage邀请识别用量预告，不补造付费全套餐或独立个人重置', () => {
  const text='Your Codex and ChatGPT Work reset will land at 6pm PST. I challenge you to burn as much usage as you can and discover the latest awesome features. Time to go /fast';
  const evidence=ev(text,{publishedAt:'2026-08-30T19:24:37Z'}),draft=buildAutomaticTemplate([evidence])!;
  assert.equal(hasStandaloneContext(text,'reset'),true);
  assert.equal(draft.actions[0]?.kind,'automatic_reset');
  assert.equal(draft.actions[0]?.stage,'promised');
  assert.equal(draft.actions[0]?.scope,'public');
  assert.equal(draft.actions[0]?.eligibility,'Codex和ChatGPT Work用户（原帖未列明具体套餐）');
  assert.equal(draft.actions[0]?.expectedAt,'2026-08-31T02:00:00.000Z');
  assert.match(draft.actions[0]?.timeNote!,/^原文预计时刻：.*并非最晚截止/);
  assert.deepEqual(validateDraft(draft,[evidence],true),[]);
  for(const text of [
    'Your Codex and ChatGPT Work reset will land at 6pm PST.',
    'Your Codex and ChatGPT Work reset will land at 6pm PST only for your account. I challenge you to burn as much usage as you can.',
    'Your Codex and ChatGPT Work reset will land at 6pm PST. I challenge you to burn as much usage as you can. Not all accounts will get it.',
    'Enjoy a nice reset everyone. Landing in the next hour or so.',
    'Brand new me and brand new usage for all ChatGPT Work and Codex users.',
    "Some Plus and Business users won't yet get access to Astra today, we've got you covered with a banked reset. Lands by end of day and if you create your account by 8pm PT then you'll get it too.",
  ]) assert.equal(extractBenefitClaims(text,at).length,0,'语义或资格不足时保留等待：'+text);
});
