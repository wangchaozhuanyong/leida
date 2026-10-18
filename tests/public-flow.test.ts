import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import type { Activity, BenefitAction, Publication, PublicData } from '../src/lib/types';
import { Home, EventPage } from '../src/components/public/PublicApp';
import { publicResetOutlook } from '../src/lib/reset-outlook';

// This suite exercises the real GET route against a read-only memory store.
// It never loads local credentials, opens a database connection or calls WeChat.
process.env.DOTENV_CONFIG_PATH = fileURLToPath(new URL('./.public-flow-no-env', import.meta.url));
// Install the source stub before importing a reader that captures fetch at creation.
// Otherwise the test can accidentally start a real upstream read and reach Next after()
// without a request scope under a slow network or concurrent test load.
const originalFetch = globalThis.fetch;
let externalRequests = 0;
globalThis.fetch = async input => {
  if (String(input) === 'https://codex-resets.com/api/v1/status') return Response.json({
    meta:{api_version:'v1',generated_at:new Date().toISOString()},
    data:{latest_reset:null,scheduled_reset:null,active_watch:null}
  });
  externalRequests++;throw new Error('External network calls are forbidden in this suite');
};
const { pool } = await import('../src/db');
const { GET } = await import('../src/app/api/v1/[...path]/route');
const originalQuery = pool.query, originalConnect = pool.connect;
let tables: Record<string, unknown[]> = {};
const clone = <T>(value: T): T => structuredClone(value);
const query = async (sql: string, values: unknown[] = []) => {
  if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SET TRANSACTION')) return { rows: [], rowCount: 0 };
  if (sql.startsWith("SELECT to_regclass('radar_forecast_cases')")) return { rows: [{ cases: null, snapshots: null, outcomes: null }], rowCount: 1 };
  const select = sql.match(/^SELECT payload FROM radar_(\w+)/);
  if (!select) throw new Error('Only controlled read operations are allowed in this suite');
  const records = tables[select[1]] ?? [];
  const matches = sql.includes('WHERE id =') ? records.filter(record => (record as { id: string }).id === values[0]) : records;
  return { rows: matches.map(payload => ({ payload: clone(payload) })), rowCount: matches.length };
};
pool.query = query as typeof pool.query;
pool.connect = (async () => ({ query, release() {} })) as typeof pool.connect;
after(async () => { pool.query = originalQuery; pool.connect = originalConnect; globalThis.fetch = originalFetch; await pool.end(); assert.equal(externalRequests, 0, 'Public regression fixtures must not attempt external requests'); });

const now = new Date().toISOString();
const before = (hours: number) => new Date(Date.parse(now) - hours * 3600_000).toISOString();
const assertHas = (value: string, expected: RegExp) => assert.ok(expected.test(value), `Rendered output must include ${expected}`);
const assertLacks = (value: string, forbidden: RegExp) => assert.ok(!forbidden.test(value), `Rendered output must exclude ${forbidden}`);
function publication(id: string, action: BenefitAction): Publication {
  const eventId = `event-${id}`, articleId = `article-${id}`;
  return { id, eventId, articleId, mode: 'state_change', cutoffAt: action.statementAt, publishedAt: action.statementAt, reason: '测试原文快照',
    event: { id: eventId, title: '公开重置记录', version: 1, status: 'published', actions: [action], evidenceIds: [], publicationId: id, updatedAt: action.statementAt },
    article: { id: articleId, eventId, publicationId: id, title: '公开重置记录', summary: '原文状态', translation: '', category: 'reset', version: 1, status: 'published', evidenceIds: [], historical: false, publishedAt: action.statementAt, updatedAt: action.statementAt, publicationMode: 'state_change' } };
}
const action = (patch: Partial<BenefitAction> = {}): BenefitAction => ({ id: 'completed', kind: 'automatic_reset', stage: 'claimed_complete', scope: 'public', eligibility: '公开用户', statementAt: before(1), evidenceIds: [], ...patch });
function fixture(publications = [publication('completion', action())]): PublicData {
  return { events: publications.map(p => clone(p.event)), articles: publications.map(p => clone(p.article)), publications, evidence: [], notices: [], activities: [], sources: [], site: { name: '模钥重置雷达', description: '', autoPublish: true, version: 1 }, serverTime: now };
}
function install(data: PublicData) {
  tables = { events: data.events, articles: data.articles, publications: data.publications, evidence: data.evidence, notices: data.notices, activities: data.activities, sources: [], settings: [{ id: 'site', ...data.site }] };
}
async function posterResponse(data: PublicData, id = 'completion', status = true) {
  install(data);
  const path = ['posters', id];
  return GET(new Request(`http://127.0.0.1:5190/api/v1/posters/${id}${status ? '?layout=status&action=completed' : ''}`), { params: Promise.resolve({ path }) });
}

test('真实状态海报入口不让较新完成之后的旧未明确预告复活', async () => {
  for (const expectedAt of [undefined, before(100)]) {
    const data = fixture([publication('completion', action()), publication('stale-promise', action({ id: 'old-promise', stage: 'promised', statementAt: before(200), expectedAt }))]);
    assert.equal(publicResetOutlook(data).status, 'completed');
    assert.equal(publicResetOutlook(data).active, undefined);
    const response = await posterResponse(data);
    assert.equal(response.status, 200);
    const svg = await response.text();
    assertHas(svg, /暂无可靠的下次重置日期/);
    assertLacks(svg, /已有发放预告/);
  }
});

test('真实状态海报保留跨越最近完成时间的另一轮安排和较新未知时间预告', async () => {
  const expectedAt = new Date(Date.parse(now) + 3600_000).toISOString();
  for (const next of [
    action({ id: 'future-round', stage: 'promised', statementAt: before(.1), expectedAt }),
    action({ id: 'new-announcement', stage: 'promised', statementAt: before(.1) }),
  ]) {
    const data = fixture([publication('completion', action()), publication('next', next)]);
    assert.equal(publicResetOutlook(data).active?.actionId, next.id);
    const response = await posterResponse(data); assert.equal(response.status, 200);
    const svg = await response.text();
    assertHas(svg, next.expectedAt ? /下次重置预告：.*前 · 北京时间/ : /已有发放预告，具体时间等待公开确认/);
    assertLacks(svg, /暂无可靠的下次重置日期/);
  }
});

test('真实状态海报入口区分预计时刻、近似时间和最晚期限', async () => {
  for (const [timeNote, expected, forbidden] of [
    ['原文预计时刻：北京时间', /下次重置预告：.* · 北京时间/, /前 · 北京时间|约.* · 北京时间/],
    ['原文近似时间：约一小时后', /下次重置预告：约.* · 北京时间/, /前 · 北京时间/],
    ['原文最晚时间：北京时间', /下次重置预告：.*前 · 北京时间/, /下次重置预告：约/],
  ] as const) {
    const data = fixture([publication('completion', action()), publication('next', action({ id: 'next', stage: 'promised', statementAt: before(.1), expectedAt: new Date(Date.parse(now) + 3600_000).toISOString(), timeNote }))]);
    const response = await posterResponse(data); assert.equal(response.status, 200);
    const svg = await response.text(); assertHas(svg, expected); assertLacks(svg, forbidden);
  }
});

test('当前文章恢复后，撤回时的固定快照仍不可通过普通海报入口生成', async () => {
  for (const target of ['snapshotArticle', 'snapshotEvent', 'currentArticle', 'currentEvent'] as const) {
    const data = fixture();
    if (target === 'snapshotArticle') data.publications[0].article.status = 'withdrawn';
    if (target === 'snapshotEvent') data.publications[0].event.status = 'withdrawn';
    if (target === 'currentArticle') data.articles[0].status = 'withdrawn';
    if (target === 'currentEvent') data.events[0].status = 'withdrawn';
    data.articles[0].publicationId = 'restored-current';
    const response = await posterResponse(data, 'completion', false);
    assert.equal(response.status, 410, target);
    assert.match((await response.json()).error, /撤回/);
  }
});

test('实际事件详情在当前恢复后仍标注撤回快照并禁用海报', () => {
  const data = fixture();
  data.publications[0].article.status = 'withdrawn';
  data.publications[0].reason = '这份固定版本的撤回原因';
  data.articles[0].publicationId = 'restored-current';
  data.events[0].publicationId = 'restored-current';
  const html = renderToStaticMarkup(createElement(SearchParamsContext.Provider, { value: new URLSearchParams('version=completion') },
    createElement(EventPage, { data, id: data.events[0].id, onPoster() {}, onShare: async () => {} })));
  assertHas(html, /此内容已撤回/);
  assertHas(html, /这份固定版本的撤回原因/);
  assertHas(html, /<button[^>]*disabled=""[^>]*>生成海报/);
});

test('实际首页活动标题右侧显示日数，未开始和保留期显示对应状态', () => {
  const data = fixture();
  const activity: Activity = { id: 'challenge', title: 'Tibo 的 28 天挑战', days: 28, startsOn: '2026-10-05', timezone: 'America/Los_Angeles', rules: '公开活动进展', version: 1, items: [] };
  data.activities = [activity];
  for (const [serverTime, phase] of [['2026-10-10T20:00:00Z', '第6天 / 共28天'], ['2026-10-04T20:00:00Z', '尚未开始'], ['2026-11-03T20:00:00Z', '活动已结束']] as const) {
    data.serverTime = serverTime;
    const html = renderToStaticMarkup(createElement(Home, { data, historical: false, onWechatReminders() {}, onPoster() {}, onShare: async () => {} }));
    assertHas(html, new RegExp(`<h2>Tibo 的 28 天挑战</h2>.*${phase.replace('/', '\\/')}`));
  }
});
