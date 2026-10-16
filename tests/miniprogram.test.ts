import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import type { PublicData, Article, Publication, BenefitAction, RadarEvent } from '../src/lib/types';
import * as web from '../src/components/public/model';
import { isHistoricalArticle } from '../src/lib/history';

const require = createRequire(import.meta.url);
const mini = require('../miniprogram/utils/model.js');
const { configurationError, validateBootstrap, createTransport } = require('../miniprogram/utils/transport.js');
const { createClient } = require('../miniprogram/utils/client.js');
const { createPreferences } = require('../miniprogram/utils/preferences.js');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const now = '2026-10-10T08:00:00Z';
const fresh = '2026-10-10T01:00:00Z';
const historic = '2026-07-16T04:14:09Z';
const httpsConfig = { mode: 'https', baseUrl: 'https://public.example.org', cloudEnv: '', serviceName: '', pollMs: 5000, timeoutMs: 10000 };
type ActionInput = Partial<BenefitAction> & Pick<BenefitAction, 'id'|'kind'|'stage'>;

// 全部为隔离的测试输入，不写数据库，不代表网站实际采集记录。
function fixture(): PublicData {
  const data: PublicData = { events: [], publications: [], articles: [], evidence: [], notices: [], activities: [], sources: [{ id: 'fixture-source', name: '测试来源', status: 'healthy', lastSuccessAt: fresh }], site: { name: '模钥重置雷达', description: '', autoPublish: true, version: 1 }, serverTime: now };
  addRound(data, 'done', [
    { id: 'done-reset', kind: 'automatic_reset', stage: 'claimed_complete', statementAt: '2026-10-10T02:00:00Z' },
    { id: 'done-card', kind: 'banked_reset', stage: 'claimed_complete', statementAt: '2026-10-10T02:00:00Z' },
    { id: 'targeted', kind: 'banked_reset', stage: 'claimed_complete', scope: 'targeted' },
    { id: 'private', kind: 'banked_reset', stage: 'claimed_complete', scope: 'private' },
  ]);
  addRound(data, 'promise', [{ id: 'late-promise', kind: 'banked_reset', stage: 'promised', expectedAt: '2026-10-10T02:00:00Z' }]);
  addRound(data, 'split', [
    { id: 'split-reset', kind: 'automatic_reset', stage: 'claimed_complete' },
    { id: 'split-card', kind: 'banked_reset', stage: 'in_progress' },
  ]);
  addRound(data, 'old', [{ id: 'old-promise', kind: 'banked_reset', stage: 'promised', statementAt: historic }], historic);
  data.notices = [
    { id: 'notice-combined', eventId: 'done', publicationId: 'pub-done', title: '测试关键变化', summary: '同一条提醒保留两种分类', categories: ['result', 'activity'], semanticKey: 'test-done', status: 'active', createdAt: fresh },
    { id: 'notice-withdrawn', eventId: 'old', publicationId: 'pub-old', title: '撤回提醒', summary: '', categories: ['result'], semanticKey: 'test-old', status: 'withdrawn', createdAt: fresh },
    { id: 'notice-missing', eventId: 'missing', publicationId: 'pub-missing', title: '尚缺公开版本', summary: '', categories: ['correction'], semanticKey: 'test-missing', status: 'active', createdAt: fresh },
  ];
  data.activities = [{ id: 'fixture-activity', title: '测试两日活动', startsOn: '2026-10-09', timezone: 'Asia/Shanghai', days: 2, rules: '依据测试资料每日记录，不推测未来内容', version: 1, items: [{ day: 2, articleId: 'article-done', eventId: 'done' }] }];
  return data;
}
function addRound(data: PublicData, id: string, input: ActionInput[], sourceTime = fresh): Publication {
  const evidenceId = `evidence-${id}`;
  data.evidence.push({ id: evidenceId, sourceId: 'fixture-source', messageId: id, hash: id, url: `https://example.org/${id}`, text: '测试保存的原文片段', publishedAt: sourceTime, collectedAt: '2026-10-10T01:05:00Z', historical: false, contextComplete: true, provenance: 'archive', textOrigin: 'archive_excerpt', metadata: { title: '测试归档标题', summary: '测试归档描述' } });
  const actions: BenefitAction[] = input.map(item => ({ eligibility: '所有账户', scope: 'public', evidenceIds: [evidenceId], statementAt: sourceTime, ...item }));
  const article: Article = { id: `article-${id}`, eventId: id, title: `测试公告${id}`, summary: '测试摘要', translation: '测试中文正文', category: 'reset', version: 1, status: 'published', publicationId: `pub-${id}`, evidenceIds: [evidenceId], publishedAt: '2026-10-10T03:00:00Z', updatedAt: '2026-10-10T03:00:00Z', sourcePublishedAt: sourceTime, historical: false };
  const event: RadarEvent = { id, title: article.title, version: 1, status: 'published', publicationId: article.publicationId, evidenceIds: [evidenceId], updatedAt: article.updatedAt, actions };
  const publication: Publication = { id: article.publicationId, eventId: id, articleId: article.id, event: structuredClone(event), article: structuredClone(article), publishedAt: article.publishedAt, cutoffAt: '2026-10-10T01:05:00Z', reason: '隔离测试发布版本', mode: 'state_change' };
  data.events.push(event); data.articles.push(article); data.publications.push(publication);
  return publication;
}
function replaceWithNews(data: PublicData, id = 'done') {
  const previous = data.publications.find(item => item.eventId === id)!;
  const publication: Publication = structuredClone(previous);
  publication.id = `news-${id}`; publication.articleId = `news-article-${id}`;
  publication.article = { ...publication.article, id: publication.articleId, publicationId: publication.id, title: '测试来源消息', publicationMode: 'news_only', sourcePublishedAt: '2026-10-10T06:00:00Z' };
  publication.mode = 'news_only'; publication.publishedAt = '2026-10-10T06:05:00Z';
  publication.event.publicationId = publication.id;
  publication.event.actions.push({ ...publication.event.actions[0], id: 'news-poison' });
  data.events.find(item => item.id === id)!.publicationId = publication.id;
  data.publications.push(publication); data.articles.push(structuredClone(publication.article));
  return publication;
}

test('同一已发布输入：福利动作、原文排序、历史预告及日程与网站完全一致', () => {
  const data = fixture(), before = structuredClone(data);
  replaceWithNews(data);
  const withNews = structuredClone(data);
  assert.deepEqual(mini.publicActions(data), web.publicActions(data));
  assert.deepEqual(mini.upcomingActions(data), web.upcomingActions(data));
  assert.deepEqual(mini.sortedPublications(data), web.sortedPublications(data));
  assert.deepEqual(mini.sortedStatePublications(data), web.sortedStatePublications(data));
  assert.deepEqual(mini.sortedArticles(data.articles), web.sortedArticles(data.articles));
  assert.deepEqual(mini.calendarDays(now), web.calendarDays(now));
  for (const publication of data.publications) {
    assert.equal(mini.publicationSourceTime(publication), web.publicationSourceTime(publication));
    assert.equal(mini.publicationWithdrawn(data, publication), web.publicationWithdrawn(data, publication));
    assert.equal(mini.isHistoricalArticle(publication.article, data.evidence), isHistoricalArticle(publication.article, data.evidence));
    for (const action of publication.event.actions) assert.equal(mini.stageText(action, now), web.stageText(action, now));
  }
  assert.deepEqual(data, withNews, '读模型不修改输入快照');
  assert.equal(before.publications.length + 1, data.publications.length);
  assert.equal(mini.publicActions(data).some((item: {action:BenefitAction}) => item.action.id === 'news-poison'), false);
});

test('只依据快照、不采用未发布的事件动作；相同动作不重复计数，定向及私人不入普发', () => {
  const data = fixture();
  data.events[0].actions = [{ ...data.events[0].actions[0], id: 'unpublished', stage: 'cancelled' }];
  addRound(data, 'duplicate', [{ ...data.publications[0].event.actions[0] }]);
  const actions = mini.publicActions(data);
  assert.deepEqual(actions, web.publicActions(data));
  assert.equal(actions.filter((item: {action:BenefitAction}) => item.action.id === 'done-reset').length, 1);
  assert.equal(actions.some((item: {action:BenefitAction}) => ['unpublished', 'targeted', 'private'].includes(item.action.id)), false);
  assert.equal(mini.calendarModel(data).completedCount, 3);
  const split = actions.filter((item: {event:RadarEvent}) => item.event.id === 'split');
  assert.deepEqual(split.map((item: {action:BenefitAction}) => item.action.stage), ['claimed_complete', 'in_progress']);
});

test('到期不变成完成，历史旧预告不挤入当前安排，有明确未来期限才恢复展示', () => {
  const data = fixture();
  assert.match(mini.stageText(data.publications[1].event.actions[0], now), /等待确认/);
  assert.equal(data.publications[1].event.actions[0].stage, 'promised');
  assert.equal(mini.upcomingActions(data).some((item: {action:BenefitAction}) => item.action.id === 'old-promise'), false);
  data.publications[3].event.actions[0].expectedAt = '2026-10-11T00:00:00Z';
  assert.deepEqual(mini.upcomingActions(data), web.upcomingActions(data));
  assert.equal(mini.upcomingActions(data).some((item: {action:BenefitAction}) => item.action.id === 'old-promise'), true);
});

test('撤回兼容与网站一致：当前文章、固定文章快照、当前事件及事件快照均不供当前状态使用', () => {
  for (const target of ['article', 'snapshotArticle', 'event', 'snapshotEvent'] as const) {
    const data = fixture(); replaceWithNews(data);
    if (target === 'article') data.articles[0].status = 'withdrawn';
    if (target === 'snapshotArticle') data.publications[0].article.status = 'withdrawn';
    if (target === 'event') data.events[0].status = 'withdrawn';
    if (target === 'snapshotEvent') data.publications[0].event.status = 'withdrawn';
    assert.deepEqual(mini.publicActions(data), web.publicActions(data));
    assert.equal(mini.publicActions(data).some((item: {event:RadarEvent}) => item.event.id === 'done'), false, target);
    assert.equal(mini.resolveDetail(data, { publicationId: 'pub-done' }).withdrawn, true);
    assert.equal(mini.resolveDetail(data, { publicationId: 'pub-done' }).canShare, false);
  }
});

test('补录、措辞修改与时区边界不会把旧来源排到新福利之前', () => {
  const data = fixture();
  data.publications[3].publishedAt = '2026-10-11T01:00:00Z';
  data.publications[3].article.publishedAt = data.publications[3].publishedAt;
  data.publications[0].article.title = '仅测试措辞修改';
  assert.deepEqual(mini.sortedStatePublications(data), web.sortedStatePublications(data));
  assert.equal(mini.sortedStatePublications(data).at(-1).id, 'pub-old');
  for (const time of ['2026-10-09T15:59:59Z', '2026-10-09T16:00:00Z', '2026-01-01T00:00:00Z']) assert.equal(mini.dateKey(time), web.dateKey(time));
  assert.equal(mini.displayTime('broken'), '暂无记录');
});

test('历史读时兼容：迟采、迟发布、缺证和明确历史与网站判断一致', () => {
  const data = fixture(), article = data.publications[0].article;
  const cases = [
    { ...article, historical: true },
    { ...article, evidenceIds: ['evidence-old'] },
    { ...article, evidenceIds: ['evidence-old', 'missing'] },
    { ...article, evidenceIds: [], sourcePublishedAt: historic },
    { ...article, publishedAt: '2026-10-12T00:00:00Z' },
  ];
  for (const value of cases) assert.equal(mini.isHistoricalArticle(value, data.evidence), isHistoricalArticle(value, data.evidence));
});

test('详情和朋友分享固定发布版本，新消息不能悄悄替换旧标题、正文及动作', () => {
  const data = fixture(), pub = data.publications[0]; replaceWithNews(data);
  data.articles[0].title = '当前记录另一个标题';
  const result = mini.resolveDetail(data, { publicationId: 'pub-done' });
  assert.equal(result.title, pub.article.title); assert.equal(result.body, pub.article.translation);
  assert.equal(result.actions.length, pub.event.actions.length);
  assert.equal(result.isOld, true); assert.equal(result.latestPath, '/pages/detail/index?publicationId=news-done');
  assert.equal(mini.sharePath(pub), '/pages/detail/index?publicationId=pub-done');
  assert.equal(result.evidence[0].text, data.evidence[0].text);
  assert.equal(result.evidence[0].label, '第三方收录');
  assert.equal(result.evidence[0].title, undefined);
  assert.equal(result.evidence[0].description, undefined);
  assert.match(result.evidence[0].origin, /片段/);
  const news = mini.resolveDetail(data, { publicationId: 'news-done' });
  assert.equal(news.newsOnly, true); assert.equal(news.actions.length, 0);
});

test('公告仅在正文包含额外内容时提供全文，空白差异不重复，两端规则一致', () => {
  const input = fixture(), publication = input.publications[0];
  for (const [summary, translation, extra] of [
    ['用量重置已完成。', '', false],
    ['用量重置已完成。', '用量重置已完成。', false],
    ['用量重置 已完成。', '\n用量重置\n已完成。\u200b ', false],
    ['', '只有这一份正文。', false],
    [' ', ' ', false],
    ['预计 13:00 完成。', '预计 15:00 完成。', true],
    ['公告称已完成。', '公告称已完成。适用于活动中的用户。', true],
  ] as const) {
    Object.assign(publication.article, { summary, translation });
    const detail = mini.resolveDetail(input, { publicationId: publication.id });
    assert.equal(detail.hasAdditionalContent, extra, `${summary} / ${translation}`);
    assert.deepEqual(mini.publicArticleContent(publication.article), web.publicArticleContent(publication.article));
    if (!summary.trim()) assert.equal(detail.summary, translation.trim());
  }
  Object.assign(publication.article, {contentOrigin:'template', summary:'根据公开原文，用量重置已完成。', translation:'根据公开原文，用量重置已完成。'});
  assert.equal(mini.resolveDetail(input, {publicationId:publication.id}).hasAdditionalContent, false);
  assert.deepEqual(mini.publicArticleContent(publication.article), web.publicArticleContent(publication.article));
  const template = readFileSync(resolve(root,'miniprogram/pages/detail/index.wxml'),'utf8');
  assert.match(template, /wx:if="{{detail.hasAdditionalContent}}"/);
  assert.doesNotMatch(template, /辅助归档|附加标题|附加摘要|本站采集|完整内容/);
});

test('详情精简来源不冒充官方，不重复同一原文，不改变后台保存的资料', () => {
  const data=fixture(), publication=data.publications[0], original=data.evidence.find(e=>publication.event.evidenceIds.includes(e.id))!;
  const copy={...original,id:'official-copy',provenance:'official' as const,textOrigin:'original' as const};
  data.evidence.push(copy);publication.event.evidenceIds.push(copy.id);
  const before=structuredClone(data.evidence), detail=mini.resolveDetail(data,{publicationId:publication.id});
  assert.equal(detail.evidence.filter((e:{text:string})=>e.text===original.text).length,1);
  assert.equal(detail.evidence[0].label,'官方原文');assert.equal(detail.evidence[0].url,original.url);
  assert.deepEqual(data.evidence,before);
});

test('最新仅新闻版本按当前文章判断；事件保留旧事实指针不会把新文章误标历史', () => {
  const data = fixture(), news = replaceWithNews(data);
  data.events[0].publicationId = 'pub-done';
  news.article.version = 3; news.event.version = 11;
  const detail = mini.resolveDetail(data, { publicationId: news.id });
  assert.equal(detail.isOld, false); assert.equal(detail.latestPath, ''); assert.equal(detail.version, 3);
  const next = structuredClone(news); next.id = 'news-next'; next.article.publicationId = next.id; next.article.version = 4;
  data.publications.push(next); data.articles.find(item => item.id === news.articleId)!.publicationId = next.id;
  const old = mini.resolveDetail(data, { publicationId: news.id });
  assert.equal(old.isOld, true); assert.equal(old.latestPath, '/pages/detail/index?publicationId=news-next'); assert.equal(old.version, 3);
});

test('福利详情显示事件版本；历史预告使用当时截止时间，当前预告到期仍等待确认', () => {
  const data = fixture(), pub = data.publications[1];
  pub.event.version = 7; pub.article.version = 2;
  const current = mini.resolveDetail(data, { publicationId: pub.id });
  assert.equal(current.version, 7); assert.equal(current.actions[0].stage, web.stageText(pub.event.actions[0], now));
  replaceWithNews(data, 'promise');
  const historicalVersion = mini.resolveDetail(data, { publicationId: pub.id });
  assert.equal(historicalVersion.isOld, true);
  assert.equal(historicalVersion.actions[0].stage, web.stageText(pub.event.actions[0], pub.cutoffAt));
  assert.equal(historicalVersion.actions[0].stage, '发放预告');
  assert.equal(pub.event.actions[0].stage, 'promised');
});

test('合并和缺失保留明确说明；撤回版本不能分享或作为当前发放依据', () => {
  const data = fixture();
  data.events[0].status = 'merged'; data.events[0].mergedInto = 'split';
  const result = mini.resolveDetail(data, { publicationId: 'pub-done' });
  assert.equal(result.merged, true); assert.equal(result.canShare, false);
  assert.equal(result.mergePath, '/pages/detail/index?publicationId=pub-split');
  assert.equal(result.title, data.publications[0].article.title);
  assert.equal(mini.resolveDetail(data, { publicationId: 'missing' }).missing, true);
  data.articles = data.articles.filter(item => item.id !== 'article-done');
  assert.equal(mini.resolveDetail(data, { publicationId: 'pub-done' }).missing, true);
});

test('活动按来源日期和时区选日，空记录不伪造每日进展，超范围选择限制在真实天数', () => {
  const data = fixture();
  const current = mini.activityModel(data, 'fixture-activity');
  assert.equal(current.selected, 2); assert.equal(current.entries.length, 1); assert.equal(current.recordedDays, 1);
  assert.equal(current.entries[0].path, '/pages/detail/index?publicationId=pub-done');
  const empty = mini.activityModel(data, 'fixture-activity', 1);
  assert.equal(empty.entries.length, 0); assert.match(empty.emptyText, /暂无已收录/);
  assert.equal(mini.activityModel(data, 'fixture-activity', 100).selected, 2);
  data.activities[0].timezone = 'Unknown/Zone';
  assert.match(mini.activityModel(data, 'fixture-activity').phase, /手动/);
  assert.equal(mini.activityModel(data, 'missing').missing, true);
});

test('首页近7天预览不包含尚未到来的周末，完整日程仍保留未来格子的禁用标记', () => {
  const calendar = mini.calendarModel(fixture());
  assert.equal(calendar.recentDays.length, 7);
  assert.equal(calendar.recentDays.at(-1).date, web.dateKey(now));
  assert.equal(calendar.recentDays.some((item:{future:boolean}) => item.future), false);
  assert.equal(calendar.weeks.flatMap((item:{days:{future:boolean}[]}) => item.days).some((item:{future:boolean}) => item.future), true);
});

test('多分类提醒只显示一次；已撤回提醒不显示，缺失版本保留说明', () => {
  const data = fixture();
  const notices = mini.noticeModel(data, { announcement: true, result: true, activity: true, correction: true }, ['notice-combined']);
  assert.equal(notices.length, 2); assert.equal(notices[0].read, true);
  assert.equal(notices[1].missing, true); assert.equal(notices[1].path, '');
  assert.equal(mini.noticeModel(data, { announcement: false, result: false, activity: false, correction: false }, []).length, 2);
});

test('正式配置连接现有云托管，空白示例仍拒绝联网、本机地址和空云环境', () => {
  const deployed = require('../miniprogram/config.js');
  assert.equal(configurationError(deployed), '');
  assert.equal(deployed.mode, 'cloud');
  assert.equal(deployed.baseUrl, '');
  assert.equal(deployed.cloudEnv, 'prod-d5gatkqvs39259932');
  assert.equal(deployed.serviceName, 'express-l98p');
  assert.deepEqual(Object.keys(deployed).sort(), ['baseUrl','cloudEnv','mode','pollMs','serviceName','timeoutMs'].sort());
  const config = require('../miniprogram/config.example.js');
  assert.deepEqual([config.mode, config.baseUrl, config.cloudEnv, config.serviceName], ['', '', '', '']);
  assert.match(configurationError(config), /尚未连接/);
  for (const baseUrl of ['http://example.org', 'https://127.0.0.1', 'https://localhost', 'https://example.org/api/v1']) assert.ok(configurationError({ ...httpsConfig, baseUrl }));
  assert.equal(configurationError(httpsConfig), '');
  assert.ok(configurationError({ mode: 'cloud', cloudEnv: ' ', serviceName: '' }));
  assert.equal(configurationError({ mode: 'cloud', cloudEnv: 'fixture-env', serviceName: 'fixture-public' }), '');
});

interface Response { statusCode: number; data?: unknown }
interface HttpOptions { url:string; method:string; header:Record<string,string>; timeout:number; success:(response:Response)=>void; fail:(error?:unknown)=>void }
function network(reply?: (options: HttpOptions, index: number) => void) {
  const calls: HttpOptions[] = []; let aborts = 0;
  return { calls, get aborts() { return aborts; }, wx: { request(options: HttpOptions) { calls.push(options); if (reply) queueMicrotask(() => reply(options, calls.length - 1)); return { abort() { aborts += 1; } }; } } };
}
const envelope = (data = fixture(), version = 'fixture-v1'): Response => ({ statusCode: 200, data: { data, version } });
const versionResponse = (version = 'fixture-v1'): Response => ({ statusCode: 200, data: { data: { version } } });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('普通请求只读公开接口，携带版本和限时；私有及任意路径在发请求前拒绝', async () => {
  const mock = network(options => options.success(options.url.endsWith('version') ? { statusCode: 304 } : envelope()));
  const request = createTransport(mock.wx, httpsConfig);
  const result = await request('/api/v1/bootstrap').promise;
  assert.equal(result.version, 'fixture-v1'); assert.equal(mock.calls[0].method, 'GET');
  assert.equal(mock.calls[0].url, 'https://public.example.org/api/v1/bootstrap');
  assert.equal(mock.calls[0].timeout, 10000);
  assert.deepEqual(await request('/api/v1/version', 'fixture-v1').promise, { unchanged: true });
  assert.equal(mock.calls[1].header['If-None-Match'], '"fixture-v1"');
  for (const path of ['/api/admin/bootstrap', '/api/v1/publish', 'https://elsewhere.example.org']) await assert.rejects(request(path).promise, /路径/);
  assert.equal(mock.calls.length, 2);
});

test('结构校验拒绝不完整数据、重复ID和跨事件快照，不把异常返回当空公告', async () => {
  assert.equal(validateBootstrap(fixture()), true);
  const invalid = fixture(); invalid.publications[0].article.eventId = 'another-event';
  assert.equal(validateBootstrap(invalid), false);
  const duplicate = fixture(); duplicate.publications.push(duplicate.publications[0]);
  assert.equal(validateBootstrap(duplicate), false);
  for (const response of [envelope(invalid), { statusCode: 200, data: '<html>错误页</html>' }, { statusCode: 200, data: { data: {} } }, { statusCode: 304 }]) {
    const mock = network(options => options.success(response));
    await assert.rejects(createTransport(mock.wx, httpsConfig)('/api/v1/bootstrap').promise, /资料|格式/);
  }
});

test('HTTP和网络错误显示中文可重试原因，不回显底层请求内容', async () => {
  const failed = network(options => options.success({ statusCode: 503, data: { message: 'internal-private-details' } }));
  await assert.rejects(createTransport(failed.wx, httpsConfig)('/api/v1/bootstrap').promise, /503/);
  const disconnected = network(options => options.fail({ errMsg: 'private-provider-details' }));
  await assert.rejects(createTransport(disconnected.wx, httpsConfig)('/api/v1/bootstrap').promise, error => error instanceof Error && error.message.includes('连接失败') && !error.message.includes('private'));
});

test('云托管使用实际环境和服务标识、只初始化一次，保持与HTTPS相同的公开合同', async () => {
  const calls: Record<string,unknown>[] = [], init: Record<string,unknown>[] = [];
  const wxApi = { cloud: { init(options: Record<string,unknown>) { init.push(options); }, async callContainer(options: Record<string,unknown>) { calls.push(options); return options.path === '/api/v1/bootstrap' ? envelope() : { statusCode: 304 }; } } };
  const request = createTransport(wxApi, { mode: 'cloud', cloudEnv: 'fixture-environment', serviceName: 'fixture-public', timeoutMs: 2000 });
  assert.equal((await request('/api/v1/bootstrap').promise).version, 'fixture-v1');
  assert.deepEqual(await request('/api/v1/version', 'fixture-v1').promise, { unchanged: true });
  assert.deepEqual(init, [{ traceUser: false }]);
  assert.deepEqual(calls[0].config, { env: 'fixture-environment' });
  assert.deepEqual(calls[0].header, { 'X-WX-SERVICE': 'fixture-public' });
  assert.deepEqual(calls[1].header, { 'X-WX-SERVICE': 'fixture-public', 'If-None-Match': '"fixture-v1"' });
  assert.equal(calls[0].method, 'GET');
});

test('无云SDK或云临时故障保持错误状态；恢复后允许再次初始化读取', async () => {
  const config = { mode: 'cloud', cloudEnv: 'fixture-env', serviceName: 'fixture-public' };
  await assert.rejects(createTransport({}, config)('/api/v1/bootstrap').promise, /更新微信/);
  let attempts = 0, init = 0;
  const request = createTransport({ cloud: { init() { init++; }, async callContainer() { attempts++; if (attempts === 1) throw new Error('internal-error'); return envelope(); } } }, config);
  await assert.rejects(request('/api/v1/bootstrap').promise, /连接失败/);
  assert.equal((await request('/api/v1/bootstrap').promise).version, 'fixture-v1');
  assert.equal(init, 2);
});

function timerHarness() {
  const callbacks = new Map<number, () => void>(); let id = 0;
  return { callbacks, timers: { setTimeout(fn: () => void, ms: number) { assert.ok(ms >= 5000); callbacks.set(++id, fn); return id; }, clearTimeout(key: number) { callbacks.delete(key); } }, tick() { const jobs=[...callbacks.values()];callbacks.clear();jobs.forEach(fn=>fn()); } };
}
test('一个前台轮询；相同版本不重取资料，版本改变只重取一次，不产生新提醒', async () => {
  let revision = 'fixture-v1'; const data = fixture();
  const mock = network(options => options.success(options.url.includes('/api/v1/version') ? versionResponse(revision) : envelope(data, revision)));
  const timers = timerHarness(), client = createClient({ wxApi: mock.wx, config: httpsConfig, timers: timers.timers, now: () => 1 });
  await client.start(); await client.start();
  assert.equal(timers.callbacks.size, 1); assert.equal(mock.calls.length, 1);
  timers.tick(); timers.tick(); await settle();
  assert.equal(mock.calls.length, 2, '请求未完成时合并重复检查');
  revision = 'fixture-v2'; timers.tick(); await settle();
  assert.equal(mock.calls.length, 4); assert.equal(client.getState().version, revision);
  assert.equal(client.getState().data.notices.length, data.notices.length);
  assert.equal(client.getState().receivedAt, 1);
  client.stop(); assert.equal(timers.callbacks.size, 0);
  timers.tick(); await settle(); assert.equal(mock.calls.length, 4);
});

test('首次配置为空不轮询、不调用任何网络，重试不制造模拟数据', async () => {
  const mock = network(), timers = timerHarness();
  const client = createClient({ wxApi: mock.wx, config: require('../miniprogram/config.example.js'), timers: timers.timers });
  await client.start(); await client.refresh(false);
  assert.equal(mock.calls.length, 0); assert.equal(timers.callbacks.size, 0);
  assert.equal(client.getState().data, null); assert.equal(client.getState().unconfigured, true);
  assert.match(client.getState().error, /尚未连接/);
  client.stop();
});

test('进入后台取消请求，迟到旧响应不能覆盖重新返回前台后的新数据', async () => {
  const mock = network(), timers = timerHarness();
  const client = createClient({ wxApi: mock.wx, config: httpsConfig, timers: timers.timers });
  const old = client.start(); client.stop();
  const latest = client.start();
  mock.calls[1].success(envelope(fixture(), 'fixture-v2')); await latest;
  mock.calls[0].success(envelope(fixture(), 'fixture-v1')); await old;
  assert.equal(client.getState().version, 'fixture-v2'); assert.equal(client.getState().loading, false);
  assert.ok(mock.aborts >= 1); client.stop();
});

test('前台断网保留最近公开资料并提示重试，恢复不会重复生成消息', async () => {
  let fail = false;
  const mock = network(options => fail ? options.fail() : options.success(envelope()));
  const client = createClient({ wxApi: mock.wx, config: httpsConfig, timers: timerHarness().timers });
  await client.start(); const data = client.getState().data;
  fail = true; await client.refresh(false);
  assert.equal(client.getState().data, data); assert.match(client.getState().error, /连接失败/);
  assert.equal(client.getState().loading, false);
  fail = false; await client.refresh(false);
  assert.equal(client.getState().error, ''); assert.equal(client.getState().data.notices.length, data.notices.length);
  client.stop();
});

test('小程序返回有效缓存不重复查版本，冷页面按需读取且不串入其他页面', async () => {
  const mock = network(), client = createClient({wxApi: mock.wx, config: httpsConfig, timers: timerHarness().timers});
  const first = client.start(); mock.calls[0].success(envelope()); await first;
  const homeData = client.getState().data;
  const news = client.setView({view:'news',filter:'all'});
  assert.equal(client.getState().data,null,'首次打开动态不能先显示首页数据');
  const newsData = fixture(); newsData.site.name = '隔离动态页';
  mock.calls[1].success(envelope(newsData)); await news;
  const back = client.setView({view:'home'});
  assert.equal(client.getState().data,homeData,'返回首页立即呈现原资料');
  await back;assert.equal(mock.calls.length,2);
  assert.equal(client.getState().data,homeData);
  const again = client.setView({view:'news',filter:'all'});
  assert.equal(client.getState().data.site.name,'隔离动态页');
  await again;assert.equal(mock.calls.length,2);
  assert.equal(mock.calls.filter(call=>call.url.includes('/bootstrap')).length,2);
  client.stop();
});

test('页面分类缓存隔离，返回时断网保留原分类，过时在途响应不能覆盖当前首页', async () => {
  let now=0;const mock = network(), client = createClient({wxApi:mock.wx,config:httpsConfig,timers:timerHarness().timers,now:()=>now});
  const home = client.start(); mock.calls[0].success(envelope()); await home;
  const reset = client.setView({view:'news',filter:'reset'});
  const resetData = fixture(); resetData.site.name='隔离重置分类';
  mock.calls[1].success(envelope(resetData)); await reset;
  const product = client.setView({view:'news',filter:'product'});
  assert.equal(client.getState().data,null);
  now=5000;
  const back = client.setView({view:'news',filter:'reset'});
  assert.equal(client.getState().data.site.name,'隔离重置分类');
  mock.calls[3].fail(); await back;
  assert.equal(client.getState().data.site.name,'隔离重置分类');
  assert.match(client.getState().error,/连接失败/);
  const lateData=fixture();lateData.site.name='过时产品分类';
  mock.calls[2].success(envelope(lateData)); await product;
  assert.equal(client.getState().data.site.name,'隔离重置分类');
  const returnHome=client.setView({view:'home'});
  assert.equal(client.getState().data.site.name,'模钥重置雷达');
  assert.equal(client.getState().error,'','别的页面的网络错误不串到首页');
  mock.calls[4].success({statusCode:304}); await returnHome;
  client.stop();
});

test('缓存正文版本变化时先保留内容，再原子替换；撤回记录不由旧缓存合并回来', async () => {
  let now=0;const mock=network(),client=createClient({wxApi:mock.wx,config:httpsConfig,timers:timerHarness().timers,now:()=>now});
  const start=client.start();mock.calls[0].success(envelope());await start;
  const old=client.getState().data;
  const news=client.setView({view:'news',filter:'all'});mock.calls[1].success(envelope());await news;
  now=5000;
  const back=client.setView({view:'home'});
  assert.equal(client.getState().data,old);
  mock.calls[2].success(versionResponse('fixture-v2'));await settle();
  assert.equal(client.getState().data,old,'新正文未返回前保留旧资料');
  const fresh=fixture();fresh.publications=[];fresh.events=[];fresh.articles=[];fresh.site.name='更正后的首页';
  mock.calls[3].success(envelope(fresh,'fixture-v2'));await back;
  assert.equal(client.getState().data.site.name,'更正后的首页');
  assert.equal(client.getState().data.publications.length,0);
  client.stop();
});

test('动态加载更多后切去首页再返回，保留已加载条目和下一页位置',async()=>{
  const mock=network(),client=createClient({wxApi:mock.wx,config:httpsConfig,timers:timerHarness().timers});
  const start=client.start();mock.calls[0].success(envelope());await start;
  const news=client.setView({view:'news',filter:'all'});
  mock.calls[1].success({statusCode:200,data:{...(envelope().data as object),page:{ids:['done','promise','split','old'],nextCursor:'page-two',total:8}}});await news;
  const more=client.more();assert.match(mock.calls[2].url,/cursor=page-two/);
  const next=fixture();addRound(next,'more-news',[{id:'more-reset',kind:'automatic_reset',stage:'promised'}]);
  mock.calls[2].success({statusCode:200,data:{...(envelope(next).data as object),page:{ids:['more-news'],nextCursor:'page-three',total:8}}});await more;
  assert.equal(client.getState().data.publications.length,5);
  const home=client.setView({view:'home'});await home;
  const back=client.setView({view:'news',filter:'all'});
  assert.equal(client.getState().data.publications.length,5);
  assert.equal(client.getState().page.nextCursor,'page-three');
  assert.equal(client.getState().page.ids.length,5);
  await back;assert.equal(mock.calls.length,3);
  client.stop();
});

test('微信前后台入口正确连接启动和停止，不在隐藏时启动额外定时器', () => {
  let definition: { onLaunch:()=>void; onShow:()=>void; onHide:()=>void } | undefined;
  const filename = resolve(root, 'miniprogram/app.js');
  new Script(readFileSync(filename, 'utf8'), { filename }).runInNewContext({ App(value: typeof definition) { definition = value; }, require: createRequire(filename) });
  const calls: string[] = [];
  const context = { client: { start() { calls.push('start'); }, stop() { calls.push('stop'); } } };
  definition!.onShow.call(context); definition!.onHide.call(context);
  assert.deepEqual(calls, ['start', 'stop']);
});

test('本机偏好只接受布尔值，已读去重，存储不可用时保留当前会话并说明', () => {
  const writes: {key:string;value:unknown}[] = [];
  const preferences = createPreferences({ getStorageSync(key: string) { return key.includes('read') ? ['a', 'a', 7] : { result: false, announcement: 'bad', other: true }; }, setStorageSync(key: string, value: unknown) { writes.push({ key, value }); } });
  assert.equal(preferences.snapshot().preferences.result, false); assert.equal(preferences.snapshot().preferences.announcement, true);
  assert.deepEqual(preferences.snapshot().read, ['a']);
  preferences.set('result', true); preferences.set('unknown', true); preferences.set('__proto__', true); preferences.markRead(['a', 'b']);
  assert.equal(writes.length, 2); assert.deepEqual(preferences.snapshot().read, ['a', 'b']);
  const failed = createPreferences({ getStorageSync() { throw new Error(); }, setStorageSync() { throw new Error(); } });
  assert.match(failed.snapshot().error, /默认偏好/);
  failed.markRead(['notice-combined']); assert.deepEqual(failed.snapshot().read, ['notice-combined']); assert.match(failed.snapshot().error, /本次/);
});

type NativePage = Record<string,any> & { data:Record<string,any>; setData:(patch:Record<string,unknown>)=>void };
function nativeHarness(input = fixture(), options:{accountInfo?:{miniProgram:{envVersion:string;version?:string}};page?:Record<string,unknown>;wxApi?:Record<string,unknown>} = {}) {
  let data = input, refreshes = 0, pullStops = 0;
  const listeners = new Set<(state:Record<string,unknown>)=>void>();
  const ui = { shares: [] as string[], navigations: [] as string[], copies: [] as string[], backgrounds: [] as Record<string,unknown>[], lifecycle: [] as string[] };
  const storage = new Map<string,unknown>();
  const app = {
    client: {
      getState() { return { data, page:options.page, version: 'fixture-v1', receivedAt: Date.now(), loading: false, unconfigured: false, error: '' }; },
      subscribe(fn:(state:Record<string,unknown>)=>void) { ui.lifecycle.push('subscribe'); listeners.add(fn); fn(this.getState()); return () => listeners.delete(fn); },
      async refresh() { refreshes++; },
    },
    preferences: createPreferences({ getStorageSync(key:string) { return storage.get(key); }, setStorageSync(key:string,value:unknown) { storage.set(key,value); } }),
  };
  const wxApi = {
    setBackgroundColor(value:Record<string,unknown>) { ui.lifecycle.push('background'); ui.backgrounds.push(value); },
    getAccountInfoSync() { return options.accountInfo || {}; },
    showShareMenu() { ui.shares.push('show'); }, hideShareMenu() { ui.shares.push('hide'); },
    navigateTo(options:{url:string}) { ui.navigations.push(options.url); },
    switchTab(options:{url:string}) { ui.navigations.push(`tab:${options.url}`); },
    setClipboardData(options:{data:string}) { ui.copies.push(options.data); },
    stopPullDownRefresh() { pullStops++; }, showToast() {},
    ...(options.wxApi||{}),
  };
  function page(name:string, query:Record<string,string> = {}) {
    let definition: Record<string,any> | undefined;
    const cache = new Map<string,{exports:Record<string,any>}>();
    function load(filename:string) {
      const existing = cache.get(filename); if (existing) return existing.exports;
      const module = { exports: {} }; cache.set(filename,module);
      const sandbox = {
        module, exports: module.exports, Page(value:Record<string,any>) { definition = value; },
        wx: wxApi, getApp() { return app; }, setInterval, clearInterval, setTimeout, clearTimeout, Date,
        require(path:string) { const target = resolve(dirname(filename), path.endsWith('.js') ? path : `${path}.js`); assert.ok(target.startsWith(resolve(root,'miniprogram') + '/')); return load(target); },
      };
      new Script(readFileSync(filename,'utf8'), { filename }).runInNewContext(sandbox);
      return module.exports;
    }
    load(resolve(root, `miniprogram/pages/${name}/index.js`));
    assert.ok(definition);
    const instance = { ...definition, data: structuredClone(definition.data || {}), setData(patch:Record<string,unknown>,done?:()=>void) { Object.assign(this.data,patch);done?.(); } } as NativePage;
    instance.onLoad?.(query); instance.onShow?.();
    return instance;
  }
  return { page, app, ui, get refreshes() { return refreshes; }, get pullStops() { return pullStops; }, get subscriptions() { return listeners.size; }, replace(next:PublicData) { data = next; listeners.forEach(fn => fn(app.client.getState())); } };
}

test('原生列表首次呈现就使用当前响应的总数；提醒页区分随包代码版本和微信运行渠道',()=>{
  const h=nativeHarness(fixture(),{page:{ids:[],total:42,nextCursor:'next'},accountInfo:{miniProgram:{envVersion:'trial',version:'1.0.2'}}});
  const news=h.page('news');assert.equal(news.data.count,42);assert.equal(news.data.hasMore,true);assert.equal(news.data.navigationTitle,'动态 · 共42篇');news.onUnload();
  const records=h.page('announcements');assert.equal(records.data.navigationTitle,'重置公告 · 42个事件');records.onUnload();
  const settings=h.page('settings');assert.equal(settings.data.clientVersion,'1.0.15 · 体验版');settings.onUnload();
  const older=nativeHarness(),fallback=older.page('settings');assert.equal(fallback.data.clientVersion,'1.0.15');fallback.onUnload();
  for(const [envVersion,label] of [['release','正式版'],['develop','开发版']]){
    const page=nativeHarness(fixture(),{accountInfo:{miniProgram:{envVersion,version:'99.0.0'}}}).page('settings');
    assert.equal(page.data.clientVersion,`1.0.15 · ${label}`,'微信返回的包号不能覆盖本次随包代码版本');page.onUnload();
  }
  const unavailable=nativeHarness(fixture(),{wxApi:{getAccountInfoSync(){throw new Error('Account information unavailable');}}}).page('settings');
  assert.equal(unavailable.data.clientVersion,'1.0.15');assert.equal(unavailable.data.connected,true);unavailable.onUnload();
});

test('四个原生导航页初始化 iOS 窗口底色，缓存返回和资料刷新不反复触碰窗口外观',()=>{
  for(const name of ['home','news','announcements','settings']) {
    const h=nativeHarness(),page=h.page(name);
    assert.deepEqual(h.ui.lifecycle,['background','subscribe'],name);
    for(const value of h.ui.backgrounds) {
      assert.equal(value.backgroundColor,'#f2f5fb');
      assert.equal(value.backgroundColorTop,'#f2f5fb');
      assert.equal(value.backgroundColorBottom,'#f2f5fb');
    }
    const previous=structuredClone(page.data);
    h.replace(fixture());
    assert.equal(h.ui.backgrounds.length,1,'资料更新不触碰原生窗口外观');
    page.onHide();assert.equal(h.subscriptions,0);
    page.onShow();assert.equal(h.subscriptions,1);
    assert.equal(h.ui.lifecycle.at(-1),'subscribe');
    assert.equal(h.ui.backgrounds.length,1,'返回已保留页面不重新设置原生背景');
    assert.equal(page.data.connected,true);
    assert.deepEqual(JSON.parse(JSON.stringify(page.data)),previous,'恢复窗口底色不清空已有页面内容');
    page.onUnload();
  }
});

test('背景 API 缺失、抛错或异步失败时，页面加载和原生导航仍可使用',()=>{
  for(const setBackgroundColor of [undefined,()=>{throw new Error('unsupported');},(value:{fail:()=>void})=>value.fail()]) {
    const h=nativeHarness(fixture(),{wxApi:{setBackgroundColor}});
    const page=h.page('news');
    assert.equal(page.data.connected,true);
    page.navigate({currentTarget:{dataset:{path:'/pages/home/index'}}});
    assert.deepEqual(h.ui.navigations,['tab:/pages/home/index']);
    page.onHide();page.onShow();assert.equal(h.subscriptions,1);page.onUnload();
  }
});

test('实际详情页面分享固定版本，收到撤回后隐藏菜单并保留说明，来源复制需要点击', () => {
  const data = fixture(), harness = nativeHarness(data), page = harness.page('detail',{ publicationId:'pub-done' });
  assert.equal(page.data.detail.title, data.publications[0].article.title);
  assert.equal(harness.ui.shares.at(-1), 'show');
  assert.equal(page.onShareAppMessage().path, '/pages/detail/index?publicationId=pub-done');
  assert.equal(harness.ui.copies.length, 0);
  page.copySource({ currentTarget: { dataset: { url:'javascript:alert(1)' } } });
  assert.equal(harness.ui.copies.length, 0);
  page.copySource({ currentTarget: { dataset: { url:'https://example.org/done' } } });
  assert.deepEqual(harness.ui.copies, ['https://example.org/done']);
  const withdrawn = structuredClone(data); withdrawn.articles[0].status = 'withdrawn'; harness.replace(withdrawn);
  assert.equal(page.data.detail.withdrawn, true); assert.equal(harness.ui.shares.at(-1),'hide');
  assert.equal(page.onShareAppMessage().path, '/pages/home/index');
  page.onHide(); assert.equal(harness.subscriptions, 0);
});

test('实际日程、活动及提醒页面可选日期、查看固定版本和本机已读，不发写接口', async () => {
  const harness = nativeHarness(), schedule = harness.page('schedule',{ date:'2026-10-10' });
  assert.equal(schedule.data.selectedItems.length, 4);
  schedule.selectDay({ currentTarget: { dataset: { date:'2026-10-09' } } });
  assert.equal(schedule.data.selected, '2026-10-09'); assert.equal(schedule.data.selectedItems.length, 0);
  const activity = harness.page('activity',{ id:'fixture-activity' });
  activity.selectDay({ currentTarget:{dataset:{day:1}} });
  assert.equal(activity.data.activity.selected,1); assert.equal(activity.data.activity.entries.length,0);
  const notices = harness.page('notices');
  notices.openNotice({ currentTarget:{dataset:{id:'notice-combined'}} });
  assert.deepEqual(harness.ui.navigations, ['/pages/detail/index?publicationId=pub-done']);
  assert.ok(harness.app.preferences.snapshot().read.includes('notice-combined'));
  notices.openNotice({ currentTarget:{dataset:{id:'notice-missing'}} });
  assert.equal(harness.ui.navigations.length,1);
  notices.markAll(); assert.equal(notices.data.unread,0);
  await schedule.onPullDownRefresh(); assert.equal(harness.refreshes,1); assert.equal(harness.pullStops,1);
  schedule.onUnload(); activity.onUnload(); notices.onUnload(); assert.equal(harness.subscriptions,0);
});

test('十个原生页面用同一公共输入执行真实页面构建，无未定义字段导致的崩溃', () => {
  const harness = nativeHarness();
  const pages = ['home','settings','announcements','news','schedule','detail','activity','notices','methodology','privacy'];
  for (const name of pages) {
    const page = harness.page(name,{ publicationId:'pub-done', id:'fixture-activity' });
    assert.ok(page.data);
    if (name === 'home') assert.deepEqual(Array.from(page.data.completions,(item:any)=>item.title).sort(),['公告称已发放重置卡','公告称已重置用量'].sort());
    if (name === 'settings') { assert.equal(page.data.connected,true); assert.equal(page.data.sources,undefined); }
    page.onUnload?.();
  }
  assert.equal(harness.subscriptions,0);
});

test('四个主入口使用switchTab，公告详情保留版本参数，非法路由不跳转',()=>{
  const harness=nativeHarness(),page=harness.page('home');
  for(const path of ['/pages/news/index','/pages/announcements/index','/pages/settings/index','/pages/detail/index?publicationId=pub-done','javascript:alert(1)'])page.navigate({currentTarget:{dataset:{path}}});
  assert.deepEqual(harness.ui.navigations,['tab:/pages/news/index','tab:/pages/announcements/index','tab:/pages/settings/index','/pages/detail/index?publicationId=pub-done']);
  const detail=harness.page('detail',{publicationId:'pub-done'});detail.toggleSection({currentTarget:{dataset:{section:'recordOpen'}}});assert.equal(detail.data.recordOpen,true);
  detail.toggleSection({currentTarget:{dataset:{section:'detail'}}});assert.equal(detail.data.detail.title,fixture().publications[0].article.title);
  page.onUnload();detail.onUnload();assert.equal(harness.subscriptions,0);
});

test('原始来源链接仅允许明确HTTP地址，不执行脚本或复制隐藏控制字符', () => {
  for (const input of ['javascript:alert(1)', 'file:///tmp/test', 'https://', 'https://example.org/\nsecret', 'https://example.org@other.example.org']) assert.equal(mini.safeUrl(input), undefined);
  assert.equal(mini.safeUrl('https://example.org/original?id=1'), 'https://example.org/original?id=1');
});

test('原生项目配置与页面完整，支持游客或真实AppID，正文与触控规格有实物对应', () => {
  const app = JSON.parse(readFileSync(resolve(root, 'miniprogram/app.json'), 'utf8'));
  const project = JSON.parse(readFileSync(resolve(root, 'miniprogram/project.config.json'), 'utf8'));
  assert.equal(app.pages.length, 12);
  assert.ok(app.pages.includes('pages/replay/index'));
  assert.equal(app.window.backgroundColorTop,app.window.backgroundColor);
  assert.equal(app.window.backgroundColorBottom,app.window.backgroundColor);
  assert.equal(app.tabBar.backgroundColor,'#fbfdff'); // Selected silver navigation surface.
  assert.match(project.appid, /^(?:touristappid|wx[0-9a-z]{16})$/i);
  assert.equal(project.compileType, 'miniprogram');
  assert.equal(project.miniprogramRoot, './');
  assert.equal(project.setting.urlCheck, true);
  for (const page of app.pages) for (const extension of ['js', 'json', 'wxml', 'wxss']) assert.equal(existsSync(resolve(root, 'miniprogram', `${page}.${extension}`)), true, `${page}.${extension}`);
  const css = readFileSync(resolve(root, 'miniprogram/app.wxss'), 'utf8');
  assert.match(css, /font-size:\s*16px/); assert.match(css, /min-height:\s*44px/);
  assert.equal(app.tabBar.list[0].text, '首页');
  assert.equal(readFileSync(resolve(root, 'miniprogram/pages/settings/index.wxml'), 'utf8').includes('剩余提醒'), true);
});

test('所有原生JS可解析，JSON配置有效；模板无浏览器标签与内嵌脚本', () => {
  function check(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) check(path);
      else if (entry.name.endsWith('.js')) assert.doesNotThrow(() => new Script(readFileSync(path, 'utf8'), { filename: path }));
      else if (entry.name.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')));
      else if (entry.name.endsWith('.wxml')) assert.doesNotMatch(readFileSync(path, 'utf8'), /<(?:script|iframe|img|div)\b/i);
    }
  }
  check(resolve(root, 'miniprogram'));
});


test('独立站内信不依赖公告链接；顶部预览、未读及已读由真实页面状态驱动',()=>{
  const input=fixture();input.notices.push({id:'manual',eventId:'',publicationId:'',semanticKey:'manual',origin:'admin',title:'测试站内信',summary:'测试摘要',body:'完整正文',categories:['system'],status:'active',createdAt:now});
  input.notices.push({...input.notices[0],id:'activity-only',categories:['activity']});
  const h=nativeHarness(input),settings=h.page('settings');assert.equal(settings.data.notices.length,3);assert.equal(settings.data.unread,3);
  const n=settings.data.notices.find((n:any)=>n.id==='manual');assert.equal(n.missing,false);
  settings.openNotice({currentTarget:{dataset:{id:'manual'}}});assert.equal(settings.data.unread,2);assert.equal(h.ui.navigations.at(-1),'/pages/notices/index?id=manual');
  const detail=h.page('notices',{id:'manual'});assert.equal(detail.data.selected.body,'完整正文');assert.equal(detail.data.selected.read,true);
  input.notices.find(n=>n.id==='manual')!.status='withdrawn';h.replace(input);assert.equal(detail.data.selected,null);
  settings.onUnload();detail.onUnload();
});

test('缓存返回、重试和下拉刷新均保持正文；隐藏后迟到请求不操作页面',async()=>{
  const h=nativeHarness(),page=h.page('news');let finish!:()=>void;
  h.app.client.refresh=()=>new Promise<void>(resolve=>{assert.equal(page.data.navigationLoading,false);finish=resolve;});
  const retry=page.retry();assert.equal(page.data.navigationLoading,false);page.onHide();finish();await retry;assert.equal(page.data.navigationLoading,false);
  page.onShow();assert.equal(page.data.navigationLoading,false);
  const refresh=page.onPullDownRefresh();assert.equal(page.data.navigationLoading,false);finish();await refresh;assert.equal(page.data.navigationLoading,false);assert.equal(h.pullStops,1);
  h.replace(fixture());assert.equal(page.data.navigationLoading,false,'后台资料更新不制造前景加载');page.onUnload();
});
test('已加载列表再次显示时没有变化就不向视图层提交数据',()=>{
  const h=nativeHarness(),page=h.page('news');let submissions=0;
  const setData=page.setData;
  page.setData=function(patch){submissions++;return setData.call(this,patch);};
  for(let index=0;index<10;index++){page.onHide();page.onShow();}
  assert.equal(page.data.connected,true);assert.ok(page.data.items.length>0);
  assert.equal(submissions,0,'缓存返回不重复提交已经为false的加载标记');
  page.onUnload();assert.equal(h.subscriptions,0);
});
test('动态更新后恢复仍存在的阅读条目；已撤回锚点选择下一条有效记录',()=>{
  const scrolls:number[]=[];let measurements=0;
  const h=nativeHarness(fixture(),{wxApi:{
    pageScrollTo(options:{scrollTop:number}){scrolls.push(options.scrollTop);},
    createSelectorQuery(){return{in(){return this;},selectAll(){return this;},boundingClientRect(){return this;},selectViewport(){return this;},scrollOffset(){return this;},exec(fn:(v:unknown)=>void){
      measurements++;fn([[{dataset:{readingId:'pub-done'},top:measurements%2?-40:60,bottom:160},{dataset:{readingId:'pub-promise'},top:measurements%2?180:100,bottom:380}],{scrollTop:240}]);
    }};}
  }});
  const page=h.page('news');
  h.replace(structuredClone(fixture()));assert.deepEqual(scrolls,[340]);
  const withdrawn=fixture();withdrawn.articles=withdrawn.articles.filter(a=>a.publicationId!=='pub-done');
  h.replace(withdrawn);assert.deepEqual(scrolls,[340,160]);
  page.onHide();h.replace(fixture());assert.equal(measurements,4,'隐藏页面不再测量或移动阅读位置');page.onUnload();
});

test('观察记录缓存返回不制造遮罩，迟到请求不改变当前页面',async()=>{
  const h=nativeHarness();const finishes:Array<()=>void>=[];
  Object.assign(h.app.client,{setView:()=>new Promise<void>(resolve=>finishes.push(resolve))});
  const page=h.page('methodology');assert.equal(page.data.navigationLoading,false);
  page.onHide();page.onShow();assert.equal(finishes.length,2);
  finishes[0]();await new Promise(resolve=>setImmediate(resolve));assert.equal(page.data.navigationLoading,false);
  finishes[1]();await new Promise(resolve=>setImmediate(resolve));assert.equal(page.data.navigationLoading,false);
  h.replace(fixture());assert.equal(page.data.navigationLoading,false,'后台同步不重复遮住页面');
  page.onUnload();assert.equal(h.subscriptions,0);assert.equal(page.data.navigationLoading,false);
});

test('待确认及定向跟踪在原生列表和详情保留原因，不增加福利次数；损坏标记拒绝载入',()=>{
 for(const reviewStatus of ['pending','targeted_update'] as const){
  const data=fixture(),before=mini.publicActions(data).length;
  const p=addRound(data,'review-'+reviewStatus,[]);
  p.mode='news_only';Object.assign(p.article,{publicationMode:'news_only',reviewStatus,reviewReasons:['资格或轮次等待原文核对']});
  Object.assign(data.articles.find(a=>a.id===p.articleId)!,p.article);
  assert.equal(validateBootstrap(data),true);
  assert.equal(mini.publicationCard(data,p).reviewStatus,reviewStatus);
  const detail=mini.resolveDetail(data,{publicationId:p.id});assert.equal(detail.reviewStatus,reviewStatus);assert.match(detail.reviewReasons,/原文核对/);assert.deepEqual(detail.actions,[]);
  assert.equal(mini.publicActions(data).length,before);
  const broken=structuredClone(data);(broken.articles.find(a=>a.id===p.articleId)! as unknown as {reviewReasons:unknown}).reviewReasons='wrong-shape';assert.equal(validateBootstrap(broken),false);
 }
});
