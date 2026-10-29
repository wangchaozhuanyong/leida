import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Script } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Activity, AdminData, BenefitAction, PublicData, Publication } from '../src/lib/types';
import { activityDayNumber, activityHomeVisible } from '../src/lib/activity-display';
import { publicResetOutlook } from '../src/lib/reset-outlook';
import { announcementCountdown } from '../src/components/public/model';
import { Dashboard, DashboardPrediction } from '../src/components/admin/AdminApp';
import { previewData } from '../src/components/admin/fixtures';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const mini = require('../miniprogram/utils/model.js');
const { createWechatReader } = require('../miniprogram/utils/wechat.js');
const now = '2026-10-12T00:00:00Z';
function fixture(serverTime = now): PublicData {
  return { serverTime, site: { name: '隔离测试', description: '', autoPublish: false, version: 1 }, events: [], articles: [], publications: [], evidence: [], activities: [], notices: [], sources: [] };
}
function activity(patch: Partial<Activity> = {}): Activity {
  return { id: 'isolated-activity', title: '28 天测试活动', rules: '隔离输入，不写真实数据', startsOn: '2026-10-07', days: 28, timezone: 'Asia/Shanghai', version: 1, items: [], ...patch };
}
function round(data: PublicData, id: string, stage: BenefitAction['stage'], statementAt: string, expectedAt?: string): void {
  const publication: Publication = { id: `pub-${id}`, eventId: id, articleId: `article-${id}`, publishedAt: statementAt, cutoffAt: statementAt, reason: '隔离测试', mode: 'state_change',
    event: { id, title: id, status: 'published', version: 1, publicationId: `pub-${id}`, evidenceIds: [], updatedAt: statementAt, actions: [{ id: `action-${id}`, kind: 'automatic_reset', stage, statementAt, expectedAt, scope: 'public', eligibility: '原文所指账户', evidenceIds: [] }] },
    article: { id: `article-${id}`, eventId: id, status: 'published', title: id, summary: '隔离测试', translation: '', category: 'reset', version: 1, publicationId: `pub-${id}`, evidenceIds: [], publishedAt: statementAt, updatedAt: statementAt, sourcePublishedAt: statementAt, historical: false } };
  data.events.push(structuredClone(publication.event)); data.articles.push(structuredClone(publication.article)); data.publications.push(publication);
}
type NativePage = Record<string, any> & { data: Record<string, any>; setData(patch: Record<string, unknown>): void };
function home(data: PublicData, name = 'home'): NativePage {
  let definition: any;
  const wechatCalls = { privacy: 0, login: 0, request: 0, authorize: 0 };
  const wxApi = {
    getPrivacySetting(options: { success(result: { needAuthorization: boolean }): void }) { wechatCalls.privacy++; options.success({ needAuthorization: true }); },
    login() { wechatCalls.login++; throw new Error('Privacy has not been accepted'); },
    request() { wechatCalls.request++; throw new Error('Privacy has not been accepted'); },
    requestSubscribeMessage() { wechatCalls.authorize++; throw new Error('An explicit subscription choice is required'); },
  };
  const app = { wechat: createWechatReader({ wxApi, config: { mode: 'https', baseUrl: 'https://public.example.org', timeoutMs: 10000 } }), preferences: { snapshot() { return { preferences: mini.preferenceDefaults, read: [], error: '' }; } }, client: { getState() { return { data, receivedAt: Date.now(), error: '', loading: false }; }, subscribe(fn: (state: any) => void) { fn(this.getState()); return () => {}; } } };
  const cache = new Map<string, { exports: any }>();
  function load(filename: string): any {
    if (cache.has(filename)) return cache.get(filename)!.exports;
    const module = { exports: {} }; cache.set(filename, module);
    new Script(readFileSync(filename, 'utf8'), { filename }).runInNewContext({ module, exports: module.exports, Page(value: any) { definition = value; }, getApp() { return app; }, wx: wxApi, Date, Intl, setInterval() { return 1; }, clearInterval() {}, setTimeout, clearTimeout, require(path: string) { const target = resolve(dirname(filename), path.endsWith('.js') ? path : `${path}.js`); assert.ok(target.startsWith(resolve(root, 'miniprogram') + '/')); return load(target); } });
    return module.exports;
  }
  load(resolve(root, `miniprogram/pages/${name}/index.js`));
  const page = { ...definition, data: structuredClone(definition.data), wechatCalls, setData(patch: Record<string, unknown>) { for(const [key,value] of Object.entries(patch)){const path=key.split('.');let target:any=this.data;for(const part of path.slice(0,-1)){target[part]??={};target=target[part];}target[path.at(-1)!]=value;} } } as NativePage;
  page.onLoad({}); page.onShow(); return page;
}

test('小程序近似、点估计和截止倒计时与网站语义一致，逾期只等待确认', () => {
  for (const timeNote of ['原文近似时间：约3小时，并非最晚截止。', '原文预计时刻：10am PST，仅为安排。', '原文截止：日终前，按PST换算。', undefined]) {
    const action = { stage: 'promised', expectedAt: '2026-10-12T03:00:00Z', timeNote };
    assert.equal(mini.announcementCountdown(action, now).label, announcementCountdown(action, now).label, timeNote);
    assert.equal(mini.announcementCountdown(action, action.expectedAt).label, '已过预计时间 · 等待确认');
  }
});

test('后台显示公开预计时间及原文时间说明，不把所有点估计包装为最晚', () => {
  const data = structuredClone(previewData);
  data.forecasts = { outlook: { status: 'scheduled', active: { actionId: 'test', eventId: 'test', publicationId: 'test', kind: 'automatic_reset', stage: 'promised', statementAt: now, expectedAt: '2026-10-12T03:00:00Z', timeNote: '原文近似时间：约3小时，并非最晚截止。' } } } as AdminData['forecasts'];
  const html = renderToStaticMarkup(createElement(DashboardPrediction, { data }));
  assert.doesNotMatch(html, /预告预计最晚/); assert.match(html, /预计时间/); assert.match(html, /原文近似时间/);
});

test('小程序活动手动关闭或满28天再保留3天后移出首页，历史详情仍可看', () => {
  for (const [serverTime, item] of [['2026-10-12T00:00:00Z', activity({ showOnHome: false })], ['2026-11-06T15:59:59Z', activity()], ['2026-11-06T16:00:00Z', activity()]] as const) {
    const data = fixture(serverTime); data.activities = [item]; const page = home(data);
    assert.equal(!!page.data.activity, activityHomeVisible(item, serverTime));
    assert.equal(mini.activityModel(data, item.id).missing, false); page.onUnload();
  }
  const data = fixture(); data.activities = [activity({ id: 'disabled', showOnHome: false }), activity({ id: 'enabled' })];
  const page = home(data); assert.match(page.data.activity.path, /id=enabled$/); page.onUnload();
});

test('小程序首页阶段按活动时区计算，标题右侧展示第几天且没有空活动占位', () => {
  const data = fixture(); data.activities = [activity()]; const page = home(data);
  assert.equal(page.data.activity.phase, `第${activityDayNumber(data.activities[0], now)}天 / 共28天`); page.onUnload();
  const template = readFileSync(resolve(root, 'miniprogram/pages/home/index.wxml'), 'utf8');
  assert.match(template, /wx:if="{{activity}}"/); assert.match(template, /activity\.phase/); assert.doesNotMatch(template, /暂无已发布的活动记录/);
  assert.equal(JSON.parse(readFileSync(resolve(root, 'miniprogram/app.json'), 'utf8')).tabBar.list[0].text, '首页');
});

test('小程序活动显示与网站按日历日期一致，夏令时、非法日期和未支持时区不误显示', () => {
  for (const item of [activity(), activity({ timezone: 'UTC' }), activity({ timezone: 'America/Los_Angeles', startsOn: '2026-10-07' }), activity({ startsOn: '2026-02-31' }), activity({ timezone: 'Invalid/Timezone' })]) {
    for (const at of ['2026-11-06T07:59:59Z', '2026-11-06T08:00:00Z', now]) {
      assert.equal(mini.activityHomeVisible(item, at), activityHomeVisible(item, at));
    }
  }
});

test('旧API兼容：新完成声明不被较早逾期预告遮挡，延伸到完成后安排继续等待', () => {
  for (const expectedAt of ['2026-10-10T03:00:00Z', '2026-10-11T03:00:00Z', undefined]) {
    const data = fixture(); round(data, 'old', 'promised', '2026-10-10T00:00:00Z', expectedAt); round(data, 'done', 'claimed_complete', '2026-10-11T00:00:00Z');
    const web = publicResetOutlook(data), view = mini.resetOutlookModel(data);
    assert.equal(view.status, web.status); assert.equal(view.active?.actionId, web.active?.actionId); assert.equal(view.latestCompletion?.actionId, web.latestCompletion?.actionId);
  }
});

test('后台任务有错误时优先显示异常，即使上次心跳新鲜也不叫正常', () => {
  const data = structuredClone(previewData);
  data.runtime = { worker: { status: 'healthy', heartbeatAt: now, error: '隔离测试：预测任务未完成' }, backlog: { queued: 0, running: 0, waitingEvidence: 0, deferred: 0, cooldown: 0, configuration: 0, conflict: 0 } };
  const html = renderToStaticMarkup(createElement(Dashboard, { data, go() {} }));
  assert.match(html, /自动任务暂时异常/); assert.match(html, /隔离测试：预测任务未完成/); assert.doesNotMatch(html, /自动任务运行正常/);
});

test('小程序客户设置优先显示站内信，隐私未同意不登录，运营来源名称和技术操作不进入页面', async () => {
  const data = fixture(); data.sources = [{ id: 'internal-test', name: '人工补充原文（隔离输入）', status: 'healthy', lastSuccessAt: now }];
  data.notices = [{ id: 'isolated-admin-notice', eventId: '', publicationId: '', semanticKey: 'isolated-admin-notice', origin: 'admin', title: '隔离站内信', summary: '提醒页预览', body: '完整站内信正文', categories: ['system'], status: 'active', createdAt: now }];
  const page = home(data, 'settings');
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.data.sources, undefined); assert.equal(page.data.connected, true);
    assert.equal(page.data.notices[0].title, '隔离站内信'); assert.equal(page.data.unread, 1);
    assert.equal(page.data.wechat.privacyNeeded, true); assert.equal(page.data.wechat.safe, null);
    assert.deepEqual(page.wechatCalls, { privacy: 1, login: 0, request: 0, authorize: 0 });
    assert.equal(page._wechatRefreshTimer, undefined, '隐私未同意时不调度后台状态读取');
  } finally { page.onUnload(); }
  assert.equal(page._wechatUnsubscribe, null); assert.equal(page._wechatRefreshTimer, null);
  const template = readFileSync(resolve(root, 'miniprogram/pages/settings/index.wxml'), 'utf8');
  assert.doesNotMatch(template, /wx:for="{{sources}}"|item\.name|item\.status|最近采集/); assert.match(template, /站内信/); assert.match(template, /查看全部站内信/); assert.doesNotMatch(template,/重新读取资料|资料截至|刷新授权状态|活动进展/);
  assert.match(template, /open-type="agreePrivacyAuthorization"/); assert.match(template, /bindtap="openPrivacyContract"/);
});
