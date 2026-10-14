import test from 'node:test';
import assert from 'node:assert/strict';
import { FixedSnapshotCache } from '../src/components/public/useFixedSnapshot';

const endpoint = '/api/v1/forecasts/snapshot-one';
const id = 'snapshot-one';
const response = () => Response.json({ data: { id, title: '固定预测' } });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('固定快照复用在途读取和同版本缓存；后台复核不误判为失效', async () => {
  let calls = 0;
  let resolve: (value: Response) => void = () => {};
  const cache = new FixedSnapshotCache((async () => {
    calls++;
    return calls === 1 ? response() : new Promise<Response>(done => { resolve = done; });
  }) as typeof fetch);
  await Promise.all([cache.load(endpoint, id, 'v1'), cache.load(endpoint, id, 'v1')]);
  await cache.load(endpoint, id, 'v1');
  assert.equal(calls, 1);
  const pending = cache.load(endpoint, id, 'v2');
  await settle();
  assert.equal(cache.get(endpoint).value?.id, id);
  assert.equal(cache.get(endpoint).loading, true);
  assert.equal(cache.get(endpoint).unavailable, false);
  resolve(response());
  await pending;
  assert.equal(cache.get(endpoint).loading, false);
  assert.equal(cache.get(endpoint).checkedVersion, 'v2');
});

test('明确 404/410 即使返回非 JSON 也清除固定快照并禁止旧海报继续分享', async () => {
  for (const status of [404, 410]) {
    let calls = 0;
    const cache = new FixedSnapshotCache((async () => ++calls === 1 ? response() : new Response('Unavailable', { status })) as typeof fetch);
    await cache.load(endpoint, id, 'v1');
    await cache.load(endpoint, id, 'v2');
    assert.equal(cache.get(endpoint).value, undefined);
    assert.equal(cache.get(endpoint).unavailable, true);
    assert.match(cache.get(endpoint).error, /不可用/);
    await cache.load(endpoint, id, 'v2');
    assert.equal(calls, 2);
  }
});

test('失效记录显式重试确认恢复后解除禁用，普通网络错误保留原快照', async () => {
  let state: 'ready' | 'gone' | 'offline' = 'ready';
  const cache = new FixedSnapshotCache((async () => {
    if (state === 'offline') throw new Error('offline');
    return state === 'gone' ? new Response(null, { status: 410 }) : response();
  }) as typeof fetch);
  await cache.load(endpoint, id, 'v1');
  state = 'offline';
  await cache.load(endpoint, id, 'v2');
  assert.equal(cache.get(endpoint).value?.id, id);
  assert.equal(cache.get(endpoint).unavailable, false);
  state = 'gone';
  await cache.load(endpoint, id, 'v2', true);
  assert.equal(cache.get(endpoint).unavailable, true);
  state = 'ready';
  await cache.load(endpoint, id, 'v2', true);
  assert.equal(cache.get(endpoint).value?.id, id);
  assert.equal(cache.get(endpoint).unavailable, false);
  assert.equal(cache.get(endpoint).error, '');
});

test('stop 后旧请求即使忽略中止并迟到 404，也不能覆盖重启后成功结果', async () => {
  let calls = 0;
  let resolve: (value: Response) => void = () => {};
  const cache = new FixedSnapshotCache((async () => ++calls === 1
    ? new Promise<Response>(done => { resolve = done; }) : response()) as typeof fetch);
  const old = cache.load(endpoint, id, 'v1');
  await settle();
  cache.stop();
  await cache.load(endpoint, id, 'v2');
  resolve(new Response(null, { status: 404 }));
  await old;
  assert.equal(cache.get(endpoint).value?.id, id);
  assert.equal(cache.get(endpoint).unavailable, false);
  assert.equal(cache.get(endpoint).checkedVersion, 'v2');
});

test('同步请求异常不会遗留已完成的在途锁，后续重试可成功', async () => {
  let calls = 0;
  const cache = new FixedSnapshotCache((() => {
    if (++calls === 1) throw new Error('sync failure');
    return Promise.resolve(response());
  }) as typeof fetch);
  await cache.load(endpoint, id, 'v1');
  assert.notEqual(cache.get(endpoint).error, '');
  await cache.load(endpoint, id, 'v1', true);
  assert.equal(calls, 2);
  assert.equal(cache.get(endpoint).value?.id, id);
});

test('stop 发生在请求微任务之前时不再发出请求', async () => {
  let calls = 0;
  const cache = new FixedSnapshotCache((async () => { calls++; return response(); }) as typeof fetch);
  const pending = cache.load(endpoint, id, 'v1');
  cache.stop();
  await pending;
  assert.equal(calls, 0);
  assert.equal(cache.get(endpoint).loading, false);
});
