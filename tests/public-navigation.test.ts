import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureReadingPosition, parsePublicRoute, publicLocationKey, PublicNavigationMemory,
  readingScrollTarget, replacePublicFilter,
} from '../src/components/public/public-navigation';

test('网站筛选直接从 URL 解析且只把正文所需参数传给读取接口', () => {
  const news = parsePublicRoute('/news', new URLSearchParams('category=product&snapshot=one&cadence=two&day=9'));
  assert.equal(news.newsCategory, 'product');
  assert.equal(news.readPath, '/api/v1/bootstrap?view=news&filter=product');
  assert.equal(parsePublicRoute('/news', new URLSearchParams('category=unknown')).newsCategory, 'all');
  assert.equal(parsePublicRoute('/history', new URLSearchParams('target=banked')).readPath, '/api/v1/bootstrap?view=history&filter=banked_reset');
  assert.equal(parsePublicRoute('/history', new URLSearchParams('target=automatic')).historyFilter, 'automatic_reset');
  assert.equal(parsePublicRoute('/settings', new URLSearchParams()).readPath, '/api/v1/bootstrap?view=notices');
  assert.equal(parsePublicRoute('/more', new URLSearchParams()).readPath, null);
  assert.equal(parsePublicRoute('/methodology', new URLSearchParams('snapshot=one&cadence=two')).readPath, parsePublicRoute('/methodology', new URLSearchParams()).readPath);
});

test('固定事件版本与活动发布清单保持独立读取身份', () => {
  assert.equal(parsePublicRoute('/events/evt-1', new URLSearchParams('version=pub-1')).readPath, '/api/v1/bootstrap?view=detail&id=evt-1&entity=events&version=pub-1');
  const fixed = parsePublicRoute('/activities/activity-1', new URLSearchParams('day=2&publication=old-1&publication=old-2'));
  assert.equal(fixed.readPath, '/api/v1/bootstrap?view=activity&id=activity-1&day=2&publication=old-1&publication=old-2');
  assert.notEqual(fixed.readPath, parsePublicRoute('/activities/activity-1', new URLSearchParams('day=2')).readPath);
});

test('切换单一筛选保留其他查询参数和锚点，全部分类省略参数', () => {
  assert.equal(replacePublicFilter('/news?category=product&snapshot=frozen#item', 'category', 'all'), '/news?snapshot=frozen#item');
  assert.equal(replacePublicFilter('/history?target=automatic#row', 'target', 'banked'), '/history?target=banked#row');
  assert.equal(replacePublicFilter('/activities/a?day=1&publication=p1&publication=p2#progress', 'day', '2'), '/activities/a?day=2&publication=p1&publication=p2#progress');
});

test('主导航记住各栏目的筛选；嵌套详情返回实际来源且返回操作不制造循环', () => {
  const memory = new PublicNavigationMemory();
  memory.visit('/news?category=product');
  memory.navigate('/news?category=product', '/articles/a');
  memory.navigate('/articles/a', '/sources/evidence');
  assert.equal(memory.backHref('/sources/evidence'), '/articles/a');
  assert.equal(memory.backHref('/articles/a'), '/news?category=product');
  memory.navigate('/sources/evidence', '/articles/a');
  assert.equal(memory.backHref('/articles/a'), '/news?category=product');
  memory.navigate('/sources/evidence', '/events/nested');
  memory.navigate('/events/nested', '/articles/a');
  assert.equal(memory.backHref('/articles/a'), '/news?category=product');
  memory.visit('/settings');
  assert.equal(memory.navHref('/news'), '/news?category=product');
  assert.equal(memory.backHref('/articles/direct-share'), '/news?category=product');
  assert.equal(memory.backHref('/events/direct-share?version=old'), '/history');
  assert.equal(publicLocationKey('/activities/a?publication=p1&day=2&publication=p2#day'), '/activities/a?day=2&publication=p1&publication=p2');
});

test('阅读锚点可跨新增、尺寸变化和撤回恢复，回退到附近仍存在的条目', () => {
  const old = [
    { id: 'one', top: -300, bottom: -10 },
    { id: 'two', top: 20, bottom: 320 },
    { id: 'three', top: 340, bottom: 640 },
  ];
  const position = captureReadingPosition(old, 1000, 800);
  assert.equal(position.anchorId, 'two');
  const updated = [{ id: 'new', top: -600, bottom: -350 }, ...old.map(item => ({ ...item, top: item.top + 200, bottom: item.bottom + 200 }))];
  assert.equal(readingScrollTarget(position, updated, 1000), 1200);
  assert.equal(readingScrollTarget(position, updated.filter(item => item.id !== 'two'), 1000), 1520);
  assert.equal(readingScrollTarget(position, updated.filter(item => item.id !== 'two' && item.id !== 'three'), 1000), 880);
  assert.equal(readingScrollTarget(position, [], 1000), 1000);
  assert.equal(readingScrollTarget(captureReadingPosition([], 300, 800), [], 5), 300);
});
