#!/usr/bin/env node
// SIMULATION ONLY. A loopback fixture proxy; never imports the application server,
// reads .env files, connects to a database, starts a worker or calls remote APIs.
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'outputs/public-navigation-qa');
const controlFile = resolve(output, 'control.json');
const statsFile = resolve(output, 'requests.json');
const baseTime = Date.parse('2026-10-14T14:00:00Z');
const startedAt = Date.now();
const iso = n => new Date(n).toISOString();
const defaults = { contentRevision: 1, stateRevision: 1, delayMs: 0, delay: {}, fail: {}, removed: [], withdrawn: [], corrected: [], additions: 0, sourceStatus: 'healthy', wechatReady: false };
const clone = value => structuredClone(value);
let stats = { simulation: true, startedAt: iso(startedAt), counts: {}, requests: [] };
let control = clone(defaults);

function validateControl(patch) {
  const allowed = new Set(Object.keys(defaults));
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !allowed.has(key))) throw new Error('Unknown control field');
  for (const key of ['contentRevision', 'stateRevision', 'additions', 'delayMs']) if (key in patch && (!Number.isSafeInteger(patch[key]) || patch[key] < (key.endsWith('Revision') ? 1 : 0) || patch[key] > (key === 'additions' ? 20 : key === 'delayMs' ? 30000 : 100000))) throw new Error(`Invalid ${key}`);
  for (const key of ['removed', 'withdrawn', 'corrected']) if (key in patch && (!Array.isArray(patch[key]) || patch[key].some(id => typeof id !== 'string' || !/^qa-(article|event|publication)-[A-Za-z0-9-]+$/.test(id)))) throw new Error(`Invalid ${key}`);
  for (const key of ['delay', 'fail']) if (key in patch) {
    const values = patch[key];
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Invalid ${key}`);
    for (const [matcher, value] of Object.entries(values)) if (matcher.length > 150 || !Number.isSafeInteger(value) || (key === 'delay' ? value < 0 || value > 30000 : value !== 0 && (value < 400 || value > 599))) throw new Error(`Invalid ${key} rule`);
  }
  if ('sourceStatus' in patch && !['unconnected', 'healthy', 'delayed', 'failed', 'paused'].includes(patch.sourceStatus)) throw new Error('Invalid sourceStatus');
  if ('wechatReady' in patch && typeof patch.wechatReady !== 'boolean') throw new Error('Invalid wechatReady');
  return patch;
}
function readControl() {
  if (existsSync(controlFile)) control = { ...clone(defaults), ...validateControl(JSON.parse(readFileSync(controlFile, 'utf8'))) };
  return clone(control);
}
function versions(state) { return { version: `simulation-content-${state.contentRevision}-state-${state.stateRevision}`, contentVersion: `simulation-content-${state.contentRevision}` }; }
function matches(ids, publication) { return ids.some(id => [publication.id, publication.articleId, publication.eventId].includes(id)); }

function record(number, addition = false) {
  const suffix = addition ? `new-${String(number).padStart(3, '0')}` : String(number).padStart(3, '0');
  const id = `qa-publication-${suffix}`, articleId = `qa-article-${suffix}`, eventId = `qa-event-${suffix}`, evidenceId = `qa-evidence-${suffix}`;
  const category = ['reset', 'activity', 'product'][(number - 1) % 3];
  const at = iso(baseTime - (addition ? 60_000 + number * 1000 : number * 3600_000));
  const title = `模拟资料 ${suffix} · ${{ reset: '重置公开记录', activity: '活动每日进展', product: '产品功能更新' }[category]}`;
  const action = { id: `qa-action-${suffix}`, kind: number % 2 ? 'automatic_reset' : 'banked_reset', stage: number === 1 && !addition ? 'promised' : 'claimed_complete', scope: 'public', eligibility: '模拟公开用户，仅用于本地交互验收', evidenceIds: [evidenceId], statementAt: at, ...(number === 1 && !addition ? { expectedAt: iso(baseTime + 24 * 3600_000), timeNote: '模拟预计时刻，非真实业务公告' } : {}) };
  const event = { id: eventId, title, version: 1, status: 'published', actions: category === 'reset' ? [action] : [], evidenceIds: [evidenceId], publicationId: id, updatedAt: at };
  const article = { id: articleId, eventId, title, summary: `这是第 ${suffix} 条本地模拟资料，用于验收导航、分类、分页和阅读位置。切换栏目后应保持已经浏览的内容。`, translation: `模拟完整内容 ${suffix}。\n\n这些数据不代表真实公告、发放、预测或线上业务结果。\n\n这一段用于详情阅读、来源展开及返回位置验证。`, category, version: 1, status: 'published', publicationId: id, evidenceIds: [evidenceId], sourcePublishedAt: at, publishedAt: at, updatedAt: at, publicationMode: category === 'reset' ? 'state_change' : 'news_only', historical: false };
  const evidence = { id: evidenceId, sourceId: 'qa-source', messageId: `qa-message-${suffix}`, url: `http://127.0.0.1:5198/sources/${evidenceId}`, text: `SIMULATION ONLY. Deterministic fixture source ${suffix}. No real publication or delivery is asserted.`, publishedAt: at, collectedAt: at, hash: `simulation-${suffix}`, contextComplete: true, historical: false, provenance: 'manual', textOrigin: 'original' };
  return { publication: { id, articleId, eventId, event, article, cutoffAt: at, publishedAt: at, reason: '本地模拟发布快照，非真实公告', mode: article.publicationMode }, evidence };
}

function forecast(now) {
  const estimate = { p24: 0.3, p48: 0.7, interval24: [0.05, 0.7], interval48: [0.2, 0.95], counts: [1, 2, 0], prior: [0.5, 0.5, 1], sampleCount: 3 };
  const signalAt = iso(baseTime - 2 * 3600_000), windows = { 24: iso(baseTime + 22 * 3600_000), 48: iso(baseTime + 46 * 3600_000) };
  const coverage = { status: 'unverified', sourceIds: ['qa-source'], reason: 'SIMULATION ONLY' };
  const snapshot = { ...estimate, id: 'qa-forecast-fixed', caseId: 'qa-forecast-case', title: '模拟固定预测快照', url: 'http://127.0.0.1:5198/sources/qa-evidence-001', sourceId: 'qa-source', target: 'automatic_reset', signature: 'simulation-fixed', signalAt, collectedAt: signalAt, generatedAt: iso(baseTime), evidenceCutoffAt: iso(baseTime), windows, ruleVersion: 'simulation-20261014-1', modelVersion: 'simulation-20261014-1', trainingSampleIds: [], referenceSampleIds: ['simulation-a', 'simulation-b', 'simulation-c'], basis: 'experimental_seed', coverage, late: false, lateWindows: { 24: false, 48: false }, explanation: '本地模拟快照；只验证固定版本身份与界面，不代表任何真实预测。', trainingApplied: false, calibrated: false };
  const cadence = { status: 'insufficient', id: 'qa-cadence-fixed', modelVersion: 'simulation-cadence-1', inputFingerprint: 'simulation', generatedAt: iso(baseTime), cutoffAt: iso(baseTime), validUntil: iso(baseTime + 6 * 3600_000), anchorAt: null, sampleCount: 0, lookbackIntervals: 20, eligibleCount: 0, p24: null, p48: null, predictedAt: null, windowStart: null, windowEnd: null, observations: [], trainingObservationIds: [], trainingIntervals: [], historicalIntervals: [], rejectedCount: 0, mergedCount: 0, method: '本地模拟间隔记录', backtest: { tests: 0, hits: 0, hitRate: null, medianAbsoluteErrorHours: null, mode: 'retrospective', entries: [], recent: { tests: 0, hits: 0, hitRate: null, medianAbsoluteErrorHours: null }, explanation: 'SIMULATION ONLY' }, explanation: '本地验收样例，样本不足。', calibrated: false };
  return { snapshot, cadence, data: { status: 'ready', ruleVersion: snapshot.ruleVersion, modelVersion: snapshot.modelVersion, generatedAt: now, cases: [{ id: snapshot.caseId, identity: 'simulation-case', title: snapshot.title, url: snapshot.url, sourceId: 'qa-source', signalEvidenceIds: ['qa-evidence-001'], target: snapshot.target, signalAt, collectedAt: signalAt, windows, status: 'watching', coverage, late: false, snapshotId: snapshot.id, createdAt: signalAt, updatedAt: signalAt, snapshot, outcomes: [] }], reference: { ...estimate, sampleIds: snapshot.referenceSampleIds, coverage: 'unverified', method: '本地模拟', note: 'SIMULATION ONLY：仅验证界面。', calibrated: false }, cadence, cadenceHistory: [cadence], cadenceOutcomes: [] } };
}

export function buildFixture(state = defaults, now = iso(baseTime)) {
  const rows = [...Array.from({ length: state.additions }, (_, i) => record(i + 1, true)), ...Array.from({ length: 75 }, (_, i) => record(i + 1))];
  const historical = [];
  for (const row of rows) {
    const p = row.publication;
    if (matches(state.corrected, p)) {
      historical.push(clone(p));
      p.id += '-v2'; p.article.publicationId = p.event.publicationId = p.id;
      p.article.version = p.event.version = 2; p.article.title += '（已更正）'; p.event.title = p.article.title;
      p.article.summary += ' 本条模拟更正保留原发布版本。'; p.reason = '模拟更正，原版本可固定访问';
    }
    if (matches(state.withdrawn, p) || matches(state.removed, p)) p.article.status = p.event.status = 'withdrawn';
  }
  const publications = rows.map(row => row.publication);
  const activity = { id: 'qa-activity', title: '模拟两天产品活动', timezone: 'Asia/Shanghai', startsOn: '2026-10-13', days: 2, rules: '仅用于本地验收。切换日期时标题、规则和日期导航应保留。', version: 1, showOnHome: true, items: publications.filter(p => p.article.category === 'activity').slice(0, 4).map((p, i) => ({ day: i < 2 ? 1 : 2, eventId: p.eventId, articleId: p.articleId })) };
  const forecasts = forecast(now);
  const data = { events: publications.map(p => p.event), articles: publications.map(p => p.article), publications: [...publications, ...historical], evidence: rows.map(row => row.evidence), notices: publications.slice(0, 3).map((p, i) => ({ id: `qa-notice-${i + 1}`, eventId: p.eventId, publicationId: p.id, semanticKey: `qa-notice-${i}`, title: p.article.title, summary: p.article.summary, categories: ['announcement'], status: 'active', createdAt: p.publishedAt })), activities: [activity], sources: [{ id: 'qa-source', name: '本地模拟来源', status: state.sourceStatus, lastSuccessAt: now }], site: { name: '模钥重置雷达', description: 'SIMULATION ONLY — 本地导航验收', autoPublish: false, version: 1 }, serverTime: now, forecasts: forecasts.data };
  return { data, current: publications, forecasts };
}

export function readFixture(params, state = defaults, now = iso(baseTime)) {
  const { data, current } = buildFixture(state, now);
  const view = params.get('view'), filter = params.get('filter') || 'all', entity = params.get('entity'), id = params.get('id');
  if (!['home', 'history', 'news', 'detail', 'activity', 'notices', 'methodology', 'state', 'calendar'].includes(view)) throw Object.assign(new Error('Invalid simulation view'), { status: 400 });
  let selected = [], page;
  if (view === 'news' || view === 'history') {
    let list = current.filter(p => !matches(state.removed, p));
    list = list.filter(p => view === 'news' ? filter === 'all' || p.article.category === filter : p.event.actions.length && (filter === 'all' || p.event.actions.some(a => a.kind === filter)));
    list.sort((a, b) => b.article.sourcePublishedAt.localeCompare(a.article.sourcePublishedAt) || a.id.localeCompare(b.id));
    let cursor;
    if (params.has('cursor')) {
      try { cursor = JSON.parse(Buffer.from(params.get('cursor'), 'base64url').toString()); } catch { throw Object.assign(new Error('Invalid cursor'), { status: 400 }); }
      if (cursor.view !== view || cursor.filter !== filter || typeof cursor.at !== 'string') throw Object.assign(new Error('Cursor does not match view/filter'), { status: 400 });
    }
    const after = cursor ? list.filter(p => p.article.sourcePublishedAt < cursor.at || p.article.sourcePublishedAt === cursor.at && p.id > cursor.id) : list;
    selected = after.slice(0, 20);
    const last = selected.at(-1);
    page = { ids: selected.map(p => p.id), total: list.length, nextCursor: after.length > 20 ? Buffer.from(JSON.stringify({ view, filter, id: last.id, at: last.article.sourcePublishedAt, publishedAt: last.publishedAt })).toString('base64url') : null };
  } else if (view === 'detail') {
    selected = data.publications.filter(p => entity === 'events' ? p.eventId === id : entity === 'articles' ? p.articleId === id : entity === 'publications' ? p.id === id : p.article.evidenceIds.includes(id));
  } else if (view === 'activity') {
    const activity = data.activities.find(item => item.id === id), day = Number(params.get('day') || 2);
    const ids = new Set(activity?.items.filter(item => item.day === day).map(item => item.articleId) || []);
    selected = current.filter(p => ids.has(p.articleId));
    const fixed = new Set(params.getAll('publication'));
    selected.push(...data.publications.filter(p => fixed.has(p.id) && ids.has(p.articleId) && !selected.some(item => item.id === p.id)));
  } else if (view === 'notices') selected = current.slice(0, 3);
  else if (view !== 'state') selected = view === 'calendar' ? current.filter(p => p.event.actions.length) : current.filter(p => [1, 4, 7].some(n => p.articleId === `qa-article-${String(n).padStart(3, '0')}`) || current.indexOf(p) < 6);
  const articleIds = new Set(selected.map(p => p.articleId)), eventIds = new Set(selected.map(p => p.eventId)), evidenceIds = new Set(selected.flatMap(p => p.article.evidenceIds));
  const scoped = { ...data, articles: data.articles.filter(a => articleIds.has(a.id)), events: data.events.filter(e => eventIds.has(e.id)), publications: selected, evidence: data.evidence.filter(e => evidenceIds.has(e.id)), notices: view === 'notices' ? data.notices : [], ...(view === 'state' ? { activities: [] } : {}) };
  return { data: scoped, ...versions(state), ...(page ? { page } : {}) };
}

function json(response, data, status = 200, headers = {}) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-QA-Simulation': 'true', ...headers }); response.end(JSON.stringify(data)); }
function metric(request, url, key) {
  stats.counts[key] = (stats.counts[key] || 0) + 1;
  const entry = { at: iso(Date.now()), method: request.method, path: url.pathname + url.search, key };
  stats.requests.push(entry); if (stats.requests.length > 3000) stats.requests.shift();
  writeFileSync(statsFile, JSON.stringify(stats, null, 2) + '\n');
  return entry;
}
const local = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);
function safeControlRequest(request) {
  if (!local(request.socket.remoteAddress)) return false;
  const host = request.headers.host;
  if (!['127.0.0.1:5198', 'localhost:5198', '[::1]:5198'].includes(host)) return false;
  const origin = request.headers.origin;
  return !origin || ['http://127.0.0.1:5198', 'http://localhost:5198', 'http://[::1]:5198'].includes(origin);
}
async function body(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 16384) throw new Error('Control body too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
function rule(rules, keys) { for (const key of keys) if (Object.hasOwn(rules, key)) return rules[key]; return undefined; }

async function serve(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1:5198');
  try {
    if (url.pathname.startsWith('/__qa/')) {
      if (!safeControlRequest(request)) return json(response, { error: 'Loopback control access only' }, 403);
      if (url.pathname === '/__qa/stats' && request.method === 'GET') return json(response, stats);
      if (url.pathname === '/__qa/control' && request.method === 'GET') return json(response, { simulation: true, control: readControl(), controlFile });
      if (url.pathname === '/__qa/control' && request.method === 'POST') {
        const previous = readControl(), patch = validateControl(await body(request));
        control = { ...previous, ...patch };
        if (!('contentRevision' in patch) && ['removed', 'withdrawn', 'corrected', 'additions'].some(key => key in patch && JSON.stringify(patch[key]) !== JSON.stringify(previous[key]))) control.contentRevision++;
        if (!('stateRevision' in patch) && 'sourceStatus' in patch && patch.sourceStatus !== previous.sourceStatus) control.stateRevision++;
        writeFileSync(controlFile, JSON.stringify(control, null, 2) + '\n');
        return json(response, { simulation: true, control });
      }
      if (url.pathname === '/__qa/reset' && request.method === 'POST') {
        control = clone(defaults); stats = { simulation: true, startedAt: iso(Date.now()), counts: {}, requests: [] };
        writeFileSync(controlFile, JSON.stringify(control, null, 2) + '\n'); writeFileSync(statsFile, JSON.stringify(stats, null, 2) + '\n');
        return json(response, { simulation: true, control });
      }
      if (url.pathname === '/__qa/reset-stats' && request.method === 'POST') {
        stats = { simulation: true, startedAt: iso(Date.now()), counts: {}, requests: [] }; writeFileSync(statsFile, JSON.stringify(stats, null, 2) + '\n');
        return json(response, stats);
      }
      return json(response, { error: 'Unknown simulation control' }, 404);
    }
    if (url.pathname.startsWith('/api/')) {
      const state = readControl(), view = url.searchParams.get('view') || 'all', filter = url.searchParams.get('filter') || 'all';
      const kind = url.pathname.startsWith('/api/v1/bootstrap') ? `bootstrap:${view}:${filter}${url.searchParams.has('cursor') ? ':more' : ''}` : url.pathname === '/api/v1/version' ? 'version' : url.pathname === '/api/v1/wechat/availability' ? 'wechat' : url.pathname;
      const entry = metric(request, url, kind);
      const keys = [kind, kind.replace(/:more$/, ''), `bootstrap:${view}`, url.pathname, '*'];
      const delay = rule(state.delay, keys) ?? state.delayMs;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (response.destroyed) return;
      const failure = rule(state.fail, keys);
      if (failure) { entry.status = failure; return json(response, { error: '模拟网络失败：原有内容应保留，可重新读取。', simulation: true }, failure); }
      if (request.method !== 'GET') return json(response, { error: 'Fixture proxy forbids API writes' }, 405);
      const now = iso(baseTime + Date.now() - startedAt), fixture = buildFixture(state, now);
      if (url.pathname === '/api/v1/bootstrap' || url.pathname === '/api/v1/status') return json(response, readFixture(url.searchParams, state, now));
      if (url.pathname === '/api/v1/version') {
        const stateVersion = versions(state), etag = `"${stateVersion.version}"`;
        if (request.headers['if-none-match'] === etag) { response.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store', 'X-QA-Simulation': 'true' }); return response.end(); }
        return json(response, { data: stateVersion }, 200, { ETag: etag });
      }
      if (url.pathname === '/api/v1/wechat/availability') return json(response, { data: { available: state.wechatReady, codeAvailable: state.wechatReady } });
      if (url.pathname === '/api/v1/forecasts/qa-forecast-fixed') return json(response, { data: fixture.forecasts.snapshot });
      if (url.pathname === '/api/v1/forecasts/cadence/qa-cadence-fixed') return json(response, { data: fixture.forecasts.cadence });
      if (url.pathname.startsWith('/api/v1/posters/') || url.pathname.startsWith('/api/v1/activity-posters/') || url.pathname.startsWith('/api/v1/forecast-posters/')) {
        response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store', 'X-QA-Simulation': 'true' });
        return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960"><rect width="720" height="960" fill="#10100d"/><text x="60" y="180" fill="#d4b975" font-size="36">SIMULATION ONLY</text><text x="60" y="260" fill="white" font-size="22">Local navigation and cancellation QA</text></svg>');
      }
      return json(response, { error: 'Unsupported simulation API. Real API forwarding is disabled.', simulation: true }, 503);
    }
    // Only the local Next frontend receives these GET/HEAD page/asset requests.
    if (!['GET', 'HEAD'].includes(request.method)) return json(response, { error: 'Frontend proxy is read-only' }, 405);
    const upstream = http.request({ hostname: '127.0.0.1', port: 5197, path: request.url, method: request.method, headers: { ...request.headers, host: '127.0.0.1:5197' } }, nextResponse => {
      response.writeHead(nextResponse.statusCode || 502, nextResponse.headers); nextResponse.pipe(response);
    });
    upstream.on('error', () => json(response, { error: 'Start the isolated Next production server on 127.0.0.1:5197 first.', simulation: true }, 502));
    response.on('close', () => upstream.destroy()); request.pipe(upstream);
  } catch (error) { if (!response.headersSent) json(response, { error: error instanceof Error ? error.message : 'Simulation error', simulation: true }, error.status || 400); }
}

function selfTest() {
  const first = readFixture(new URLSearchParams('view=news'));
  assert.equal(first.page.total, 75); assert.equal(first.page.ids.length, 20);
  const second = readFixture(new URLSearchParams({ view: 'news', cursor: first.page.nextCursor }));
  const third = readFixture(new URLSearchParams({ view: 'news', cursor: second.page.nextCursor }));
  assert.equal(new Set([...first.page.ids, ...second.page.ids, ...third.page.ids]).size, 60);
  assert.equal(readFixture(new URLSearchParams('view=news&filter=product')).page.total, 25);
  assert.equal(readFixture(new URLSearchParams('view=activity&id=qa-activity&day=1')).data.articles.length, 2);
  assert.equal(readFixture(new URLSearchParams('view=activity&id=qa-activity&day=2')).data.articles.length, 2);
  const changed = { ...clone(defaults), contentRevision: 2, additions: 1, removed: ['qa-article-005'], corrected: ['qa-article-007'] };
  const detail = readFixture(new URLSearchParams('view=detail&entity=events&id=qa-event-007&version=qa-publication-007'), changed);
  assert.equal(detail.data.publications.length, 2); assert.equal(detail.data.events[0].publicationId, 'qa-publication-007-v2');
  const removed = readFixture(new URLSearchParams('view=detail&entity=articles&id=qa-article-005'), changed);
  assert.equal(removed.data.articles[0].status, 'withdrawn');
  const all = readFixture(new URLSearchParams('view=news'), changed);
  assert.equal(all.page.total, 75); assert.equal(all.data.articles.some(a => a.id === 'qa-article-005'), false);
  assert.equal(all.data.articles[0].id, 'qa-article-new-001');
  assert.throws(() => validateControl({ delayMs: -1 }));
  assert.throws(() => validateControl({ endpoint: 'https://example.com' }));
  console.log('SIMULATION ONLY: fixture pagination, categories, activities, correction snapshots and withdrawal checks passed.');
}

if (process.argv.includes('--self-test')) selfTest();
else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(output, { recursive: true });
  if (!existsSync(controlFile)) writeFileSync(controlFile, JSON.stringify(defaults, null, 2) + '\n');
  const server = http.createServer(serve);
  server.on('error', error => { console.error(`SIMULATION proxy could not start: ${error.message}`); process.exitCode = 1; });
  server.listen(5198, '127.0.0.1', () => console.log(`SIMULATION ONLY: http://127.0.0.1:5198 → local Next http://127.0.0.1:5197; control and counts: ${output}`));
}
