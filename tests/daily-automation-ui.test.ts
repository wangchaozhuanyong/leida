import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PublicData, Publication, RadarEvent } from '../src/lib/types';
import { articleSourceTime, sortedArticles, isNewsOnly, publicActions, upcomingActions, statePublication } from '../src/components/public/model';

const at = '2026-10-09T08:00:00Z';
const event: RadarEvent = {
  id: 'event-1', title: '重置安排', version: 1, status: 'published', publicationId: 'state-1', updatedAt: at,
  evidenceIds: ['e1'], actions: [{ id: 'action-1', kind: 'banked_reset', stage: 'promised', eligibility: '公开账户',
    scope: 'public', evidenceIds: ['e1'], statementAt: at }],
};
const publication = (id: string, mode: 'state_change' | 'news_only'): Publication => ({
  id, eventId: event.id, articleId: `article-${id}`, event: structuredClone(event), cutoffAt: at, publishedAt: at,
  reason: '来源核验', mode, article: { id: `article-${id}`, eventId: event.id, title: '中文消息', summary: '依据来源记录',
    translation: '', category: 'reset', version: 1, status: 'published', publicationId: id, evidenceIds: ['e1'],
    publishedAt: at, updatedAt: at, publicationMode: mode },
});
const data = (): PublicData => ({ events: [structuredClone(event)], articles: [], publications: [], evidence: [], notices: [],
  activities: [], sources: [], serverTime: at, site: { name: '模钥重置雷达', description: '', autoPublish: true, version: 1 } });

test('仅新闻快照携带既有动作也不能形成新状态和完成次数', () => {
  const value = data(); const news = publication('news-1', 'news_only');
  news.event.actions[0].stage = 'claimed_complete'; value.events[0].publicationId = news.id;
  value.publications = [news]; value.articles = [news.article];
  assert.equal(isNewsOnly(news), true);
  assert.deepEqual(publicActions(value), []);
  assert.equal(statePublication(value, value.events[0]), undefined);
  assert.equal(value.articles.length, 1); // The news remains available independently of benefit statistics.
});
test('旧数据误指向仅新闻版本时保留最近事实快照，不把新新闻当完成', () => {
  const value = data(); const state = publication('state-1', 'state_change'); const news = publication('news-1', 'news_only');
  news.publishedAt = '2026-10-09T09:00:00Z'; news.event.actions[0].stage = 'claimed_complete';
  value.events[0].publicationId = news.id; value.publications = [news, state];
  assert.equal(statePublication(value, value.events[0])?.id, state.id);
  const actions = publicActions(value);
  assert.equal(actions.length, 1); assert.equal(actions[0].action.stage, 'promised');
  assert.equal(actions[0].publication.id, state.id);
});
test('事实快照无新增模式字段时按历史默认兼容，重复动作仍只计一次', () => {
  const value = data(); const state = publication('state-1', 'state_change');
  delete state.mode; delete state.article.publicationMode;
  const copy = structuredClone(state); copy.id = 'state-2'; copy.eventId = 'event-2'; copy.event.id = 'event-2';
  value.events.push({ ...copy.event, publicationId: copy.id }); value.publications = [copy, state];
  assert.equal(publicActions(value).length, 1);
});

test('历史补录按来源时间显示和排序，不因今日入站或丰富成为最新消息', () => {
  const historical = publication('historical', 'news_only').article;
  historical.historical = true; historical.sourcePublishedAt = '2024-06-01T08:00:00Z';
  historical.publishedAt = '2026-10-09T10:00:00Z'; historical.updatedAt = '2026-10-09T11:00:00Z';
  const recent = publication('recent', 'news_only').article;
  recent.sourcePublishedAt = '2026-10-09T08:30:00Z'; recent.publishedAt = '2026-10-09T08:35:00Z';
  assert.equal(articleSourceTime(historical), historical.sourcePublishedAt);
  assert.deepEqual(sortedArticles([historical, recent]).map(article => article.id), [recent.id, historical.id]);
  historical.updatedAt = '2026-10-10T08:00:00Z';
  assert.equal(sortedArticles([historical, recent])[0].id, recent.id);
});
test('旧文章没有来源时间时兼容入站时间，福利统计仍依据动作声明时间', () => {
  const value = data(); const state = publication('state-1', 'state_change');
  assert.equal(articleSourceTime(state.article), state.article.publishedAt);
  state.article.sourcePublishedAt = '2020-01-01T08:00:00Z'; state.article.historical = true;
  value.publications = [state]; value.articles = [state.article];
  assert.equal(publicActions(value)[0].action.statementAt, at);
});
test('历史待发和进行中只有明确未来时间才进入首页下次发放，历史状态不改变', () => {
  const value = data(); const state = publication('state-1', 'state_change');
  state.article.historical = true; value.publications = [state]; value.articles = [state.article];
  const action = state.event.actions[0];
  for (const stage of ['promised', 'in_progress'] as const) {
    action.stage = stage;
    for (const expectedAt of [undefined, '2026-08-01T08:00:00Z', at, 'invalid-date']) {
      action.expectedAt = expectedAt;
      assert.equal(upcomingActions(value).length, 0);
      assert.equal(publicActions(value)[0].action.stage, stage);
    }
    action.expectedAt = '2026-10-10T08:00:00Z';
    assert.equal(upcomingActions(value).length, 1);
  }
  state.article.historical = false; action.expectedAt = undefined;
  assert.equal(upcomingActions(value).length, 1);
});
