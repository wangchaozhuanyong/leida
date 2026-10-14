import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateFlow, automationRows, canAutoRefreshAdmin } from '../src/lib/automation';
import type { AdminData, Candidate, Job } from '../src/lib/types';

const at = '2026-10-09T08:00:00Z';
function fixture(): AdminData {
  const candidate: Candidate = { id: 'c1', evidenceId: 'e1', version: 1, status: 'pending',
    reasons: ['上下文缺失，请核对父帖', '待生成中文内容并核对事实'],
    content: { title: '新收录内容待核对', summary: '', translation: '', category: 'product', actions: [], evidenceIds: ['e1'] },
    createdAt: at, updatedAt: at, humanEdited: false };
  return { candidates: [candidate], evidence: [{ id: 'e1', sourceId: 's1', messageId: 'm1', url: 'https://example.com/post', text: 'A short source message', publishedAt: at, collectedAt: at, hash: 'example', historical: false, contextComplete: false, provenance: 'archive' }],
    sources: [{ id: 's1', name: '来源', kind: 'archive', url: 'https://example.com', enabled: true, validated: true, intervalMinutes: 5, version: 1, status: 'healthy' }],
    ai: { enabled: true, hasKey: true, baseUrl: 'https://example.com/v1', model: 'example', testedAt: at, dailyCallLimit: 50, dailyBudget: 10, inputPrice: 1, outputPrice: 1, currency: 'CNY', version: 1 },
    site: { name: '雷达', description: '', autoPublish: true, version: 1 }, jobs: [], events: [], articles: [], publications: [], notices: [], activities: [], audits: [] };
}
function job(patch: Partial<Job> = {}): Job { return { id: 'j1', candidateId: 'c1', kind: 'generate', status: 'queued', attempts: 1, availableAt: at, createdAt: at, payload: { automatic: true, expectedVersion: 1 }, ...patch }; }
const flow = (data: AdminData) => candidateFlow(data.candidates[0], data);

test('未生成且缺上下文的原文属于自动队列，不是人工审核', () => {
  const data = fixture(); assert.equal(flow(data).state, 'waiting');
  assert.equal(automationRows(data).filter(row => row.flow.state === 'review').length, 0);
  data.ai.enabled = false; data.ai.hasKey = false;
  assert.equal(flow(data).state, 'configuration'); assert.equal(flow(data).actionPath, 'settings/ai');
});
test('未验证来源和未配置模型分别引导到准确配置入口', () => {
  const data = fixture(); data.sources[0].validated = false;
  assert.equal(flow(data).actionPath, 'sources');
  data.sources[0].validated = true; data.ai.testedAt = undefined;
  assert.equal(flow(data).actionPath, 'settings/ai'); assert.match(flow(data).reason, /连接测试/);
});
test('任务处理中、自动退避与永久失败不会伪装成人工事实审核', () => {
  const data = fixture(); data.jobs = [job({ status: 'running' })]; assert.equal(flow(data).state, 'processing');
  data.jobs = [job({ error: '限流，稍后重试' })]; assert.equal(flow(data).state, 'waiting'); assert.equal(flow(data).resumeAt, at);
  data.jobs[0].status = 'failed'; data.jobs[0].attempts = 3;
  assert.equal(flow(data).state, 'failed'); assert.equal(flow(data).actionPath, 'sources/jobs');
});
test('额度阻塞显示自动等待，来源和配置阻塞不是处理失败', () => {
  const data = fixture(); data.jobs = [job({ status: 'failed', payload: { blockedReason: 'budget', resumeAfter: at } })];
  assert.equal(flow(data).state, 'cooldown'); assert.equal(flow(data).resumeAt, at);
  data.jobs[0].payload.blockedReason = 'source'; assert.equal(flow(data).state, 'configuration'); assert.equal(flow(data).actionPath, 'sources');
});
test('生成后的缺证和原文变化自动等待，人工修改才计人工审核', () => {
  const data = fixture(); data.jobs = [job({ status: 'succeeded', payload: { generated: true } })];
  assert.equal(flow(data).state, 'waiting_evidence');
  data.jobs = [job({ status: 'running' })]; data.candidates[0].humanEdited = true;
  assert.equal(flow(data).state, 'review');
  data.candidates[0].humanEdited = false; data.jobs = []; data.candidates[0].reasons = ['原帖出现新版本，等待重新核验'];
  assert.equal(flow(data).state, 'waiting');
});
test('事实已通过但发布开关关闭时等待配置，终态不被旧任务覆盖', () => {
  const data = fixture(); data.jobs = [job({ status: 'succeeded', payload: { generated: true } })]; data.candidates[0].reasons = []; data.site.autoPublish = false;
  assert.equal(flow(data).state, 'configuration'); assert.equal(flow(data).actionPath, 'settings/publishing');
  data.candidates[0].status = 'published'; data.jobs[0].status = 'failed'; assert.equal(flow(data).state, 'published');
  data.candidates[0].status = 'ignored'; assert.equal(flow(data).state, 'ignored');
});
test('新重试任务优先于旧失败任务', () => {
  const data = fixture(); data.jobs = [job({ status: 'failed' }), job({ id: 'j2', createdAt: '2026-10-09T08:01:00Z' })];
  assert.equal(flow(data).state, 'waiting'); assert.equal(flow(data).job?.id, 'j2');
});
test('原文新版有独立候选接续时旧候选不再无限等待', () => {
  const data = fixture();
  data.evidence.push({ ...data.evidence[0], id: 'e2', hash: 'new-version', collectedAt: '2026-10-09T08:01:00Z' });
  data.candidates.push({ ...data.candidates[0], id: 'c2', evidenceId: 'e2' });
  assert.equal(flow(data).state, 'ignored'); assert.equal(flow(data).actionPath, 'review/c2');
  assert.match(flow(data).reason, /已由新版接续/);
  assert.equal(candidateFlow(data.candidates[1], data).state, 'waiting');
  data.candidates[0].humanEdited = true; assert.equal(flow(data).state, 'review');
  data.candidates[0].humanEdited = false; data.candidates[0].status = 'published'; assert.equal(flow(data).state, 'published');
});
test('同采集时间依照证据新旧顺序，没有新候选或复用当前候选时不误收录', () => {
  const data = fixture(); data.evidence.unshift({ ...data.evidence[0], id: 'e2', hash: 'new-version' });
  assert.equal(flow(data).state, 'waiting');
  data.candidates.push({ ...data.candidates[0], id: 'c2', evidenceId: 'e2' });
  assert.equal(flow(data).state, 'ignored');
  data.candidates.pop(); data.candidates[0].evidenceId = 'e2';
  assert.equal(flow(data).state, 'waiting');
});
test('仅列表可定时刷新，详情、编辑和配置不自动刷新', () => {
  for (const parts of [[], ['review'], ['review','queue'], ['events'], ['events','articles'], ['sources','jobs'], ['activities'], ['settings','logs']]) assert.equal(canAutoRefreshAdmin(parts[0] || '', parts), true);
  for (const parts of [['review','c1'], ['events','e1'], ['events','articles','a1'], ['activities','new'], ['settings'], ['settings','ai'], ['settings','publishing'], ['settings','brand']]) assert.equal(canAutoRefreshAdmin(parts[0], parts), false);
});

// These cases distinguish operational waiting from an actual factual dispute.
test('机器补证、暂缓和冷却状态均不计入人工审核', () => {
  const data = fixture();
  for (const state of ['waiting_evidence', 'deferred', 'cooldown'] as const) {
    data.candidates[0].automation = { state, reasonCodes: ['missing_parent'], dependencyIds: ['parent-1'], resumeAt: at };
    data.jobs = [job({ status: 'succeeded', payload: { generated: true } })];
    assert.equal(flow(data).state, state);
    assert.equal(automationRows(data).filter(row => row.flow.state === 'review').length, 0);
  }
  data.candidates[0].automation!.state = 'conflict';
  assert.equal(flow(data).state, 'review');
});
test('中文模板发布不依赖智能接口，已发模板的丰富任务仍可自动等待', () => {
  const data = fixture(); data.ai.enabled = false; data.ai.hasKey = false;
  data.sources[0].kind = 'status'; data.evidence[0].textOrigin = 'structured';
  assert.equal(flow(data).state, 'waiting');
  data.candidates[0].status = 'published';
  data.candidates[0].automation = { state: 'configuration', reasonCodes: ['ai_unconfigured'], dependencyIds: [], templatePublished: true, articleId: 'article-1' };
  assert.equal(flow(data).state, 'configuration'); assert.match(flow(data).reason, /模板已发布/);
  data.candidates[0].automation.templatePublished = false; data.candidates[0].automation.state = 'ready';
  assert.equal(flow(data).state, 'published');
});
test('机器状态不能掩盖人工来源或人工保护修改', () => {
  const data = fixture(); data.candidates[0].automation = { state: 'waiting_evidence', reasonCodes: [], dependencyIds: [] };
  data.evidence[0].provenance = 'manual'; assert.equal(flow(data).state, 'review');
  data.evidence[0].provenance = 'archive'; data.candidates[0].humanEdited = true; assert.equal(flow(data).state, 'review');
});
