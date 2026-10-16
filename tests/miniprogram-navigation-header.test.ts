import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';

const require = createRequire(import.meta.url);
const { navigationMetrics, returnFromPage } = require('../miniprogram/utils/navigation-header.js');
const component = new URL('../miniprogram/components/navigation-header/index.js', import.meta.url);

test('Notched iPhone header keeps the title below status bar and clear of the native capsule', () => {
  const result = navigationMetrics({
    getWindowInfo: () => ({ windowWidth: 430, statusBarHeight: 59 }),
    getMenuButtonBoundingClientRect: () => ({ top: 65, left: 333, height: 32 })
  });
  assert.deepEqual(result, { statusBarHeight: 59, barHeight: 44, totalHeight: 103, rightInset: 109 });
  assert.equal(430 - result.rightInset, 321, 'title ends 12 px before the capsule');
});

test('Android and a narrow device retain the capsule gap and valid compact height', () => {
  const result = navigationMetrics({
    getWindowInfo: () => ({ windowWidth: 320, statusBarHeight: 24 }),
    getMenuButtonBoundingClientRect: () => ({ top: 32, left: 223, height: 32 })
  });
  assert.equal(result.totalHeight, 72);
  assert.equal(result.rightInset, 109);
  assert.ok(320 - result.rightInset - 20 >= 180);
});

test('A zero capsule measurement or unavailable modern API uses a safe fallback', () => {
  const oldClient = navigationMetrics({
    getWindowInfo() { throw new Error('unavailable'); },
    getSystemInfoSync: () => ({ statusBarHeight: 47, windowWidth: 390 }),
    getMenuButtonBoundingClientRect: () => ({ top: 0, left: 0, height: 0 })
  });
  assert.equal(oldClient.totalHeight, 91);
  assert.equal(oldClient.rightInset, 108);
  assert.deepEqual(navigationMetrics({}), { statusBarHeight: 20, barHeight: 44, totalHeight: 64, rightInset: 108 });
  assert.equal(navigationMetrics({ getWindowInfo: () => undefined }).totalHeight, 64);
});

test('Detail returns one page while a direct shared-link entry returns to the home tab', () => {
  const calls: string[] = [];
  const api = {
    navigateBack(options: { delta: number; success(): void }) { calls.push(`back:${options.delta}`); options.success(); },
    switchTab(options: { url: string; complete(): void }) { calls.push(options.url); options.complete(); }
  };
  let completed = 0;
  returnFromPage(api, [{}, {}], () => { completed++; });
  returnFromPage(api, [{}], () => { completed++; });
  assert.deepEqual(calls, ['back:1', '/pages/home/index']);
  assert.equal(completed, 2);
});

test('If a stale page stack cannot navigate back, the return button still opens home', () => {
  let home = '';
  let completed = 0;
  returnFromPage({
    navigateBack(options: { fail(): void }) { options.fail(); },
    switchTab(options: { url: string; complete(): void }) { home = options.url; options.complete(); }
  }, [{}, {}], () => { completed++; });
  assert.equal(home, '/pages/home/index');
  assert.equal(completed, 1);
});

test('Retained tab header does not patch unchanged measurements or add a show-time animation', () => {
  let definition: any;
  let width = 390;
  const wx = {
    getWindowInfo: () => ({ windowWidth: width, statusBarHeight: 47 }),
    getMenuButtonBoundingClientRect: () => ({ top: 53, left: width - 97, height: 32 })
  };
  new Script(readFileSync(component, 'utf8')).runInNewContext({ Component(value: any) { definition = value; }, wx, require: createRequire(component) });
  const patches: unknown[] = [];
  const instance: any = { data: { ...definition.data }, ...definition.methods, setData(patch: object) { patches.push(patch); Object.assign(this.data, patch); } };
  definition.lifetimes.attached.call(instance);
  definition.pageLifetimes.resize.call(instance);
  assert.equal(patches.length, 0);
  assert.equal(definition.pageLifetimes.show, undefined);
  width = 430;
  definition.pageLifetimes.resize.call(instance);
  assert.equal(patches.length, 0, 'a width change with the same right inset does not force a redraw');
});

test('Every configured page retains a header outside its loading branch, with back controls only on secondary pages', () => {
  const app = require('../miniprogram/app.json');
  assert.equal(app.window.navigationStyle, 'custom');
  assert.equal(app.usingComponents['navigation-header'], '/components/navigation-header/index');
  assert.equal(app.tabBar.list.length, 4);
  const tabs = new Set(app.tabBar.list.map((item: { pagePath: string }) => item.pagePath));
  for (const page of app.pages) {
    const template = readFileSync(new URL(`../miniprogram/${page}.wxml`, import.meta.url), 'utf8');
    const header = template.match(/<navigation-header\b[^>]*\/>/)?.[0];
    assert.ok(header, `${page} has a custom header`);
    assert.equal(header.includes('back="{{true}}"'), !tabs.has(page));
    if (template.includes('<page-loader')) assert.ok(template.indexOf(header) < template.indexOf('<page-loader'));
    if (tabs.has(page)) assert.ok(template.indexOf('<page-meta') < template.indexOf(header));
  }
});
