import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { Activity, Article, Candidate, Evidence, Job, Notice, Publication, Source } from '../src/lib/types';

// This suite needs its own fresh QA database. The ordinary test command never
// imports the database module, reads the local environment, or connects to SQL.
const active = process.env.RADAR_INTEGRATION === '1' && process.env.RADAR_ACTIVITY_PRODUCT_INTEGRATION === '1';

test('独立隔离库：Day7 旧归档自动恢复为署名活动新闻，不影响重置事实', { skip: !active }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outputRoot = resolve(root, 'outputs/implementation-qa/remaining-verification-20261012/day7');
  const output = resolve(process.env.RADAR_DAY7_OUTPUT ?? '');
  const target = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.port, '55489');
  assert.match(target.pathname, /^\/radar_qa_day7_[a-z0-9_]+$/);
  assert.equal(target.pathname.slice(1), process.env.RADAR_QA_DATABASE, '必须绑定本轮新建的 QA 库');
  assert.match(relative(outputRoot, output), /^run_[a-z0-9_]+$/, '证据只能保存到所属项目的指定运行目录');
  assert.ok(!relative(root, output).startsWith('..'));
  process.env.DOTENV_CONFIG_PATH = resolve(output, 'no-env');
  delete process.env.DOTENV_CONFIG_OVERRIDE;

  const { pool, list, one, put, transaction } = await import('../src/db');
  const originalFetch = globalThis.fetch;
  const calls = { network: 0, collect: 0, ai: 0, enrich: 0, wechat: 0 };
  const checks: Record<string, boolean> = {};
  globalThis.fetch = async () => { calls.network++; throw new Error('Day7 隔离验证禁止外部网络'); };
  try {
    assert.equal((await pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0].name, process.env.RADAR_QA_DATABASE);
    for (const table of ['evidence', 'candidates', 'events', 'articles', 'publications', 'sources', 'jobs', 'notices', 'audits', 'activities', 'settings'] as const) {
      assert.equal((await list(table)).length, 0, '必须使用全新的空 QA 库');
    }
    const { createEvidence, queueJob, getPublicData, defaultSite } = await import('../src/server/service');
    const { runOne, scheduleDue, fingerprintChange } = await import('../src/server/worker');
    const { evidenceFingerprint } = await import('../src/server/automatic-content');
    const { publicActions } = await import('../src/lib/public-facts');
    const { publicResetOutlook } = await import('../src/lib/reset-outlook');
    const at = new Date(Date.now() - 120_000).toISOString();
    const earlier = new Date(Date.parse(at) - 60_000).toISOString();
    const source = (id: string, kind: Source['kind']): Source => ({ id, name: '纯合成 Day7 验收来源', kind, url: 'https://example.org/qa/day7', enabled: true, validated: true, status: 'healthy', intervalMinutes: 5, version: 1, lastSuccessAt: at, nextRunAt: new Date(Date.now() + 3600_000).toISOString() });
    await put('sources', source('reset-archive', 'archive'));
    await put('sources', source('activity-archive', 'activity'));
    await put('settings', { id: 'site', ...defaultSite });
    const definition = { id: 'challenge-28', title: '纯合成 28 天活动', timezone: 'Asia/Shanghai', startsOn: '2026-10-05', days: 28, rules: '仅供隔离测试：产品新闻不代表用量重置。' };
    await put('activities', { ...definition, version: 1, showOnHome: true, items: [] } satisfies Activity);
    const deps = {
      schedule: false, allowTemplates: true,
      generate: async () => { calls.ai++; throw new Error('Day7 验收禁止 AI 调用'); },
      collect: async () => { calls.collect++; throw new Error('Day7 验收禁止真实采集'); },
      enrich: async () => { calls.enrich++; return undefined; },
      enrichQuoted: async () => [],
      wechat: async () => { calls.wechat++; throw new Error('Day7 验收禁止微信发送'); },
    };
    const processJob = async (job: Job, overrides: Parameters<typeof runOne>[0] = {}) => {
      await put('jobs', { ...job, availableAt: '2000-01-01T00:00:00.000Z' });
      for (let attempt = 0; attempt < 80; attempt++) {
        await runOne({ ...deps, ...overrides });
        const current = (await one<Job>('jobs', job.id))!;
        if (current.status === 'succeeded' || current.status === 'failed') return current;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail('本轮指定任务未在有限等待内完成');
    };
    const facts = async () => {
      const data = await getPublicData();
      return { actions: publicActions(data).map(({ action }) => action), outlook: publicResetOutlook(data) };
    };

    const reset = await createEvidence({ sourceId: 'reset-archive', messageId: 'qa-day7-existing-reset', url: 'https://example.org/qa/existing-reset', text: 'We have reset usage for all paid accounts.', textOrigin: 'original', provenance: 'archive', contextComplete: true, historical: false, publishedAt: earlier, collectedAt: earlier, metadata: { category: 'reset', sourceGroup: 'codex-resets' } });
    assert.ok(reset.candidate);
    const resetJob = await transaction(c => queueJob('generate', { candidateId: reset.candidate!.id, automatic: true, expectedVersion: reset.candidate!.version }, c));
    assert.equal((await processJob(resetJob)).status, 'succeeded');
    const baseline = await facts();
    assert.equal(baseline.actions.length, 1);
    assert.equal(baseline.outlook.latestCompletion?.statementAt, earlier);
    const resetCandidate = (await one<Candidate>('candidates', reset.candidate.id))!;
    const resetPublication = (await one<Publication>('publications', (await one<Article>('articles', resetCandidate.automation!.articleId!))!.publicationId))!;

    const excerpt = 'GPT-6.1 Sol 在 Codex 和 Work 中的默认上下文长度已从 272k 提升至 500k，有助于减少上下文压缩，并在长时间任务中保留更多上下文。';
    // IDs and all stored rows are synthetic; the required namespace shape is
    // exercised without ever requesting the URL or copying live account data.
    const input: Omit<Evidence, 'id' | 'hash'> = { sourceId: 'activity-archive', messageId: '2100000000000000007', url: 'https://x.com/thsottiaux/status/2100000000000000007', text: excerpt, textOrigin: 'archive_excerpt', provenance: 'archive', contextComplete: false, historical: false, publishedAt: at, collectedAt: at, metadata: { category: 'product', sourceGroup: 'codex-resets', activityDay: 7, activity: definition } };
    const day7 = await createEvidence(input);
    assert.ok(day7.candidate);
    const storedDay7 = (await one<Evidence>('evidence', day7.evidence.id))!;
    const oldFingerprint = (evidence: Evidence) => `benefit-rules-before-day7:${evidenceFingerprint([evidence]).split(':').at(-1)}`;
    const old = { ...day7.candidate, automation: { ...day7.candidate.automation!, inputFingerprint: oldFingerprint(storedDay7) } };
    assert.equal(fingerprintChange(old.automation.inputFingerprint, evidenceFingerprint([storedDay7])), 'rules');
    await put('candidates', old);
    const human = await createEvidence({ ...input, messageId: '2100000000000000107', url: 'https://x.com/thsottiaux/status/2100000000000000107' });
    assert.ok(human.candidate);
    const protectedCandidate: Candidate = { ...human.candidate, humanEdited: true, content: { ...human.candidate.content, title: '人工保留的第七天记录', summary: '人工核对中的归档资料，保留原内容。' }, automation: { ...human.candidate.automation!, inputFingerprint: oldFingerprint(human.evidence) } };
    await put('candidates', protectedCandidate);

    await t.test('旧规则等待项自动恢复，署名 news_only，原始证据标记不变', async () => {
      await scheduleDue({ allowTemplates: true, allowEnrichment: true });
      const jobs = (await list<Job>('jobs')).filter(job => job.status === 'queued');
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].candidateId, old.id);
      assert.equal((await processJob(jobs[0])).status, 'succeeded');
      const published = (await one<Candidate>('candidates', old.id))!;
      assert.equal(published.status, 'published');
      assert.equal(published.automation?.inputFingerprint, evidenceFingerprint([storedDay7]));
      const article = (await one<Article>('articles', published.automation!.articleId!))!;
      const publication = (await one<Publication>('publications', article.publicationId))!;
      assert.equal(article.publicationMode, 'news_only');
      assert.equal(article.contentOrigin, 'template');
      assert.match(article.summary, /公开归档/);
      assert.match(article.summary, /仅作产品消息记录/);
      assert.deepEqual(publication.event.actions, []);
      assert.equal(publication.mode, 'news_only');
      assert.equal(article.category, 'activity');
      assert.deepEqual((await one<Activity>('activities', definition.id))!.items, [{ day: 7, articleId: article.id, eventId: article.eventId }]);
      assert.deepEqual(await one<Evidence>('evidence', day7.evidence.id), day7.evidence, '产品模板不重写 contextComplete=false 的不可变证据');
      assert.deepEqual(await facts(), baseline, '产品新闻不得更新最近完成时间、轮次、累计公共动作或证据截止');
      assert.deepEqual(await one<Publication>('publications', resetPublication.id), resetPublication);
      assert.ok(calls.enrich > 0, '补原文不可用的替身路径已实际执行');
      checks.oldFingerprintRecovered = checks.attributedNewsOnly = checks.evidenceFlagPreserved = checks.resetFactsUnchanged = true;
    });
    assert.equal(checks.oldFingerprintRecovered, true, '首项集成失败时停止后续夹具链');

    await t.test('普通重试及再次规则重评不重复文章、版本、活动条目和提醒', async () => {
      const counts = async () => ({ articles: (await list<Article>('articles')).length, publications: (await list<Publication>('publications')).length, notices: (await list<Notice>('notices')).length, items: (await one<Activity>('activities', definition.id))!.items });
      const before = await counts();
      await scheduleDue({ allowTemplates: true, allowEnrichment: true });
      for (const job of (await list<Job>('jobs')).filter(job => job.status === 'queued')) assert.equal((await processJob(job)).status, 'succeeded');
      assert.deepEqual(await counts(), before);
      const published = (await one<Candidate>('candidates', old.id))!;
      await put('candidates', { ...published, automation: { ...published.automation!, inputFingerprint: oldFingerprint(storedDay7) } });
      await scheduleDue({ allowTemplates: true, allowEnrichment: true });
      const recheck = (await list<Job>('jobs')).filter(job => job.status === 'queued');
      assert.equal(recheck.length, 1);
      assert.equal(recheck[0].candidateId, old.id);
      assert.equal((await processJob(recheck[0])).status, 'succeeded');
      assert.deepEqual(await counts(), before, '相同署名新闻重评应复用不可变快照');
      assert.deepEqual(await facts(), baseline);
      checks.recheckDoesNotDuplicate = true;
    });

    await t.test('humanEdited 从自动排队中排除，强行旧任务也不覆盖', async () => {
      assert.deepEqual(await one<Candidate>('candidates', protectedCandidate.id), protectedCandidate);
      assert.equal((await list<Job>('jobs')).some(job => job.candidateId === protectedCandidate.id), false);
      const before = { articles: (await list<Article>('articles')).length, publications: (await list<Publication>('publications')).length, notices: (await list<Notice>('notices')).length };
      const staleJob = await transaction(c => queueJob('generate', { candidateId: protectedCandidate.id, automatic: true, expectedVersion: protectedCandidate.version }, c));
      const result = await processJob(staleJob);
      assert.equal(result.status, 'failed');
      assert.match(result.error!, /人工修改.*不会被.*覆盖/);
      assert.deepEqual(await one<Candidate>('candidates', protectedCandidate.id), protectedCandidate);
      assert.deepEqual({ articles: (await list<Article>('articles')).length, publications: (await list<Publication>('publications')).length, notices: (await list<Notice>('notices')).length }, before);
      checks.humanEditProtected = true;
    });

    const original = 'Day 7/\n\nWe have increased default context length for GPT-6.1 Sol to 500k when used through Codex & Work, up from 272k or an ~ 80% increase.';
    const runEnrichment = async (messageId: string, text: string) => {
      const archived = await createEvidence({ ...input, messageId, url: `https://x.com/thsottiaux/status/${messageId}` });
      assert.ok(archived.candidate);
      const stored = (await one<Evidence>('evidence', archived.evidence.id))!;
      await put('candidates', { ...archived.candidate, automation: { ...archived.candidate.automation!, inputFingerprint: oldFingerprint(stored) } });
      const enriched: Evidence = { ...archived.evidence, text, textOrigin: 'original', contextComplete: true, collectedAt: new Date().toISOString(), metadata: { ...archived.evidence.metadata, summary: excerpt } };
      const overrides = { enrich: async (evidence: Evidence) => { calls.enrich++; return evidence.messageId === messageId && evidence.textOrigin === 'archive_excerpt' ? enriched : undefined; } };
      await scheduleDue({ allowTemplates: true, allowEnrichment: true });
      const firstJob = (await list<Job>('jobs')).find(job => job.status === 'queued' && job.candidateId === archived.candidate!.id);
      assert.ok(firstJob);
      assert.equal((await processJob(firstJob, overrides)).status, 'succeeded');
      const saved = (await list<Evidence>('evidence')).find(evidence => evidence.messageId === messageId && evidence.textOrigin === 'original');
      assert.ok(saved, '成功补核必须实际保存单独的原文版本');
      assert.deepEqual(await one<Evidence>('evidence', archived.evidence.id), archived.evidence, '补核不可覆盖旧摘录及其 false 标记');
      assert.equal(saved.text, text);
      assert.equal(saved.metadata?.summary, excerpt);
      assert.equal(saved.contextComplete, true, '保留补核输入标记，模板不能自行改写');
      await scheduleDue({ allowTemplates: true, allowEnrichment: true });
      for (const job of (await list<Job>('jobs')).filter(job => job.status === 'queued')) assert.equal((await processJob(job, overrides)).status, 'succeeded');
      return { archived, saved, candidate: (await list<Candidate>('candidates')).find(candidate => candidate.evidenceId === saved.id)! };
    };

    await t.test('正确原文补核后保留归档署名，新的候选仍自动发布 news_only', async () => {
      const before = { articles: (await list<Article>('articles')).length, publications: (await list<Publication>('publications')).length };
      const enriched = await runEnrichment('2100000000000000207', original);
      assert.ok(enriched.candidate);
      assert.equal(enriched.candidate.status, 'published');
      const article = (await one<Article>('articles', enriched.candidate.automation!.articleId!))!;
      const publication = (await one<Publication>('publications', article.publicationId))!;
      assert.equal(article.publicationMode, 'news_only');
      assert.equal(publication.mode, 'news_only');
      assert.deepEqual(publication.event.actions, []);
      assert.match(article.summary, /公开归档/);
      assert.ok(article.summary.includes(excerpt));
      assert.ok(!article.summary.includes('Day 7/'), '摘要引用中文归档，不冒充完整原文翻译');
      assert.deepEqual({ articles: (await list<Article>('articles')).length, publications: (await list<Publication>('publications')).length }, { articles: before.articles + 1, publications: before.publications + 1 });
      assert.equal((await one<Activity>('activities', definition.id))!.items.filter(item => item.articleId === article.id && item.day === 7).length, 1);
      assert.deepEqual(await facts(), baseline);
      checks.originalEnrichmentPublishesAttributedNews = true;
    });

    await t.test('补核原文数值和模型不匹配，不能借中文摘要自动发产品新闻', async () => {
      for (const [messageId, text] of [['2100000000000000307', original.replace('500k', '600k')], ['2100000000000000407', original.replace('GPT-6.1 Sol', 'GPT-6.1 Astra')]]) {
        const before = { articles: (await list<Article>('articles')).length, publications: (await list<Publication>('publications')).length, notices: (await list<Notice>('notices')).length, items: (await one<Activity>('activities', definition.id))!.items };
        const mismatched = await runEnrichment(messageId, text);
        assert.ok(mismatched.candidate);
        assert.equal(mismatched.candidate.status, 'pending');
        assert.deepEqual(mismatched.candidate.content.actions, []);
        assert.equal(mismatched.candidate.automation?.articleId, undefined);
        assert.equal((await list<Job>('jobs')).some(job => job.candidateId === mismatched.candidate.id), false, '无有限事实模板且未配置 AI 时不自动发文');
        assert.deepEqual({ articles: (await list<Article>('articles')).length, publications: (await list<Publication>('publications')).length, notices: (await list<Notice>('notices')).length, items: (await one<Activity>('activities', definition.id))!.items }, before);
        assert.deepEqual(await facts(), baseline);
      }
      checks.mismatchedOriginalCannotPublish = true;
    });

    assert.equal(calls.network, 0);
    assert.equal(calls.collect, 0);
    assert.equal(calls.ai, 0);
    assert.equal(calls.wechat, 0);
    assert.equal((await list<Job>('jobs')).some(job => job.kind === 'wechat_send'), false);
    assert.equal(Object.keys(checks).length, 8, '全部要求的断言均完成后才可写成功证据');
    writeFileSync(resolve(output, 'result.json'), JSON.stringify({ database: process.env.RADAR_QA_DATABASE, retained: true, checkedAt: new Date().toISOString(), fixtureOnly: true, mainDatabaseWrites: 0, checks, calls, pass: Object.values(checks).every(Boolean) }, null, 2) + '\n', { flag: 'wx' });
  } finally {
    globalThis.fetch = originalFetch;
    await pool.end();
  }
});
