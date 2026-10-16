import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

function fixture(options: { allowed?: boolean; offscreen?: boolean; late?: boolean; observerMissing?: boolean } = {}) {
  let component: any;
  new Script(readFileSync(new URL('../miniprogram/components/signal-arrow/index.js', import.meta.url), 'utf8'))
    .runInNewContext({ Component(value: any) { component = value; } });
  const patches: any[] = [], callbacks: Array<() => void> = [];
  let intersection: (entry: { intersectionRatio: number }) => void = () => {};
  let disconnected = 0;
  const instance: any = { data: { animated: false }, ...component.methods,
    setData(patch: any) { patches.push(patch); Object.assign(this.data, patch); },
    createSelectorQuery() { return { select() { return this; }, boundingClientRect() { return this; }, exec(callback: any) {
      const run = () => callback([{ width: options.allowed === false ? 0 : 1 }]);
      if (options.late) callbacks.push(run); else run();
    } }; }
  };
  if (!options.observerMissing) instance.createIntersectionObserver = () => ({ relativeToViewport() { return this; },
    observe(_selector: string, callback: typeof intersection) { intersection = callback; callback({ intersectionRatio: options.offscreen ? 0 : 1 }); },
    disconnect() { disconnected++; } });
  component.lifetimes.attached.call(instance); component.lifetimes.ready.call(instance);
  return { instance, patches, callbacks, visible(value: boolean) { intersection({ intersectionRatio: value ? 1 : 0 }); },
    hide() { component.pageLifetimes.hide.call(instance); }, show() { component.pageLifetimes.show.call(instance); },
    detach() { component.lifetimes.detached.call(instance); }, disconnected: () => disconnected };
}

test('箭头只提交动效开关，重复可见回调与show不刷新正文', () => {
  const h = fixture(); assert.equal(h.instance.data.animated, true); assert.equal(h.patches.length, 1);
  h.visible(true); h.visible(true); h.show(); assert.equal(h.patches.length, 1);
  assert.deepEqual(Object.keys(h.patches[0]), ['animated']); h.detach();
});
test('离屏和隐藏暂停，显示时仅在可见且允许动效时恢复', () => {
  const h = fixture({ offscreen: true }); assert.equal(h.instance.data.animated, false);
  h.visible(true); assert.equal(h.instance.data.animated, true);
  h.hide(); assert.equal(h.instance.data.animated, false);
  h.visible(true); assert.equal(h.instance.data.animated, false);
  h.show(); assert.equal(h.instance.data.animated, true);
  h.visible(false); assert.equal(h.instance.data.animated, false); h.detach();
});
test('减少动态效果、查询不支持或不可观测时保留静态箭头', () => {
  for (const options of [{ allowed: false }, { observerMissing: true }]) {
    const h = fixture(options); h.hide(); h.show(); assert.equal(h.instance.data.animated, false); assert.equal(h.patches.length, 0); h.detach();
  }
});
test('组件销毁后的迟到查询与可见回调不会写入页面', () => {
  const h = fixture({ late: true }); h.detach(); h.callbacks.forEach(run => run()); h.visible(true);
  assert.equal(h.patches.length, 0); assert.equal(h.disconnected(), 1);
});
