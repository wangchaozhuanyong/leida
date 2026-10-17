import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicClock, PublicSession } from '../src/components/public/public-session';
import type { PublicReadEnvelope } from '../src/lib/public-read';
import type { PublicData } from '../src/lib/types';

const news = '/api/v1/bootstrap?view=news&filter=all';
const reset = '/api/v1/bootstrap?view=news&filter=reset';
const home = '/api/v1/bootstrap?view=home';
const version = '/api/v1/version?light=1';
const state = '/api/v1/bootstrap?view=state';
const envelope = (ids: string[], contentVersion = 'c1', nextCursor: string | null = null, revision = contentVersion): PublicReadEnvelope => ({
  data: { events: [], articles: ids.map(id => ({ id, title: id })), publications: [], evidence: [], notices: [], activities: [], sources: [], site: { name: '测试' }, serverTime: '2026-10-14T00:00:00.000Z' } as unknown as PublicData,
  version: revision, contentVersion, page: { ids, nextCursor, total: 12 },
});
const json = (value: unknown) => Response.json(value);
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('并发首次读取复用在途结果；分类和固定版本使用独立完整 endpoint 缓存', async () => {
  const requests: string[] = [], first = deferred<Response>();
  const session = new PublicSession({ fetch: (async url => {
    requests.push(String(url));
    return url === news ? first.promise : json(envelope(['reset']));
  }) as typeof fetch });
  const jobs = [session.ensure(news), session.ensure(news), session.ensure(reset)];
  await settle();
  assert.deepEqual(requests, [news, reset]);
  assert.equal(session.snapshot(news).initialLoading, true);
  assert.deepEqual(session.snapshot(reset).page?.ids, ['reset']);
  first.resolve(json(envelope(['all'])));
  await Promise.all(jobs);
  assert.deepEqual(session.snapshot(news).page?.ids, ['all']);
  assert.deepEqual(session.snapshot(reset).page?.ids, ['reset']);
  await session.ensure(news);
  assert.equal(requests.length, 2);
  await session.ensure('/api/v1/bootstrap?view=detail&id=one&version=fixed-one');
  await session.ensure('/api/v1/bootstrap?view=detail&id=one&version=fixed-two');
  assert.equal(requests.length, 4);
});

test('返回缓存且版本 304 不读取正文，不重复检查微信入口', async () => {
  const requests: Array<{ url: string; headers?: HeadersInit }> = [];
  const session = new PublicSession({ fetch: (async (url, init) => {
    requests.push({ url: String(url), headers: init?.headers });
    return url === version ? new Response(null, { status: 304 }) : json(envelope(['a']));
  }) as typeof fetch });
  await session.ensure(news);
  const leave = session.activate(news);
  await session.checkVersion();
  leave();
  const leaveAgain = session.activate(news);
  await session.ensure(news);
  leaveAgain();
  assert.deepEqual(requests.map(request => request.url), [news, version]);
  assert.deepEqual(requests[1].headers, { 'If-None-Match': '"c1"', 'X-Radar-Watch-Contract':'2' });
});

test('后台正文更新重取原三页且原子替换，撤回条目不重新合并回来', async () => {
  let generation = 'c1';
  const third = deferred<Response>(), requests: string[] = [];
  const session = new PublicSession({ fetch: (async url => {
    const path = String(url); requests.push(path);
    if (path === version) return json({ data: { version: generation, contentVersion: generation } });
    if (generation === 'c2' && path.endsWith('cursor=second')) return third.promise;
    if (path.endsWith('cursor=second')) return json(envelope(['old-c'], generation));
    if (path.endsWith('cursor=first')) return json(envelope([generation === 'c1' ? 'old-b' : 'corrected'], generation, 'second'));
    return json(envelope([generation === 'c1' ? 'withdrawn' : 'added'], generation, 'first'));
  }) as typeof fetch });
  await session.ensure(news); await session.more(news); await session.more(news);
  const leave = session.activate(news);
  generation = 'c2';
  const refresh = session.checkVersion();
  await settle();
  assert.equal(session.snapshot(news).refreshing, true);
  assert.deepEqual(session.snapshot(news).page?.ids, ['withdrawn', 'old-b', 'old-c']);
  third.resolve(json(envelope(['new-c'], 'c2')));
  await refresh;
  assert.deepEqual(session.snapshot(news).page?.ids, ['added', 'corrected', 'new-c']);
  assert.deepEqual(session.snapshot(news).data?.articles.map(article => article.id), ['added', 'corrected', 'new-c']);
  assert.equal(session.snapshot(news).refreshing, false);
  assert.equal(requests.filter(url => url.includes('cursor=')).length, 4);
  leave();
});

test('页链正文版本变化时保留原多页，后续版本成功不清除正文刷新错误', async () => {
  let mode: 'initial' | 'inconsistent' | 'unchanged' | 'recovered' = 'initial';
  const session = new PublicSession({ fetch: (async url => {
    if (url === version) return mode === 'unchanged' ? new Response(null, { status: 304 }) : json({ data: { version: 'c2', contentVersion: 'c2' } });
    if (String(url).includes('cursor=')) return json(envelope([mode === 'initial' ? 'old-b' : 'new-b'], mode === 'inconsistent' || mode === 'unchanged' ? 'c3' : mode === 'initial' ? 'c1' : 'c2'));
    return json(envelope([mode === 'initial' ? 'old-a' : 'new-a'], mode === 'initial' ? 'c1' : 'c2', 'next'));
  }) as typeof fetch });
  await session.ensure(news); await session.more(news);
  const leave = session.activate(news);
  mode = 'inconsistent'; await session.checkVersion();
  const failed = session.snapshot(news);
  assert.deepEqual(failed.page?.ids, ['old-a', 'old-b']);
  assert.match(failed.error, /资料正在更新/);
  mode = 'unchanged'; await session.checkVersion();
  assert.equal(session.snapshot(news).error, failed.error);
  mode = 'recovered'; await session.refresh(news);
  assert.equal(session.snapshot(news).error, '');
  assert.deepEqual(session.snapshot(news).page?.ids, ['new-a', 'new-b']);
  leave();
});

test('来源状态变化只共享读取一次 state；保留分页、正文和已有错误', async () => {
  const requests: string[] = [];
  let failNews = false;
  const session = new PublicSession({ fetch: (async url => {
    requests.push(String(url));
    if (url === news && failNews) throw new Error('正文刷新失败');
    if (url === version) return json({ data: { version: 'source-v2', contentVersion: 'c1' } });
    const result = envelope(url === news ? ['news'] : ['home'], 'c1', null, url === state ? 'source-v2' : 'c1');
    if (url === state) result.data.sources = [{ id: 'official', name: '公开来源', status: 'healthy' }];
    return json(result);
  }) as typeof fetch });
  await session.ensure(news); await session.ensure(home);
  const leaveNews = session.activate(news), leaveHome = session.activate(home);
  failNews = true; await session.refresh(news);
  const originalError = session.snapshot(news).error;
  await Promise.all([session.checkVersion(), session.checkVersion()]);
  assert.deepEqual(requests, [news, home, news, version, state]);
  assert.deepEqual(session.snapshot(news).page?.ids, ['news']);
  assert.deepEqual(session.snapshot(home).page?.ids, ['home']);
  assert.equal(session.snapshot(news).data?.sources[0].id, 'official');
  assert.equal(session.snapshot(home).data?.sources[0].id, 'official');
  assert.equal(session.snapshot(news).error, originalError);
  leaveNews(); leaveHome();
});

test('后台版本更新后返回旧分类会重新验证；未访问分类不会提前下载', async () => {
  let generation = 'c1';
  const requests: string[] = [];
  const session = new PublicSession({ fetch: (async url => {
    requests.push(String(url));
    return url === version ? json({ data: { version: generation, contentVersion: generation } }) : json(envelope([generation], generation));
  }) as typeof fetch });
  await session.ensure(news); await session.ensure(reset);
  const leave = session.activate(reset);
  generation = 'c2'; await session.checkVersion();
  assert.equal(session.snapshot(news).data?.articles[0].id, 'c1');
  assert.equal(requests.filter(url => url === news).length, 1);
  await session.ensure(news);
  assert.equal(session.snapshot(news).data?.articles[0].id, 'c2');
  assert.equal(requests.filter(url => url === news).length, 2);
  assert.equal(requests.includes(home), false);
  leave();
});

test('加载更多具有独立状态和重试错误，错误不会清空列表', async () => {
  let fail = true;
  const pending = deferred<Response>();
  const session = new PublicSession({ fetch: (async url => {
    if (String(url).includes('cursor=')) return fail ? pending.promise : json(envelope(['b']));
    return json(envelope(['a'], 'c1', 'next'));
  }) as typeof fetch });
  await session.ensure(news);
  const more = session.more(news);
  assert.equal(session.snapshot(news).loadingMore, true);
  assert.equal(session.snapshot(news).initialLoading, false);
  pending.reject(new Error('网络暂时中断'));
  await more;
  assert.deepEqual(session.snapshot(news).page?.ids, ['a']);
  assert.equal(session.snapshot(news).error, '');
  assert.match(session.snapshot(news).moreError, /网络暂时中断/);
  fail = false; await session.more(news);
  assert.deepEqual(session.snapshot(news).page?.ids, ['a', 'b']);
  assert.equal(session.snapshot(news).moreError, '');
});

test('追加页版本不同不会混合历史；显式刷新后可以继续加载', async () => {
  let generation = 'c1';
  const session = new PublicSession({ fetch: (async url => json(envelope([String(url).includes('cursor=') ? 'b' : 'a'], generation, String(url).includes('cursor=') ? null : 'next'))) as typeof fetch });
  await session.ensure(news);
  generation = 'c2'; await session.more(news);
  assert.deepEqual(session.snapshot(news).page?.ids, ['a']);
  assert.match(session.snapshot(news).moreError, /先刷新/);
  await session.refresh(news); await session.more(news);
  assert.deepEqual(session.snapshot(news).page?.ids, ['a', 'b']);
});

test('微信能力在一分钟内复用及并发去重，显式重试绕过 TTL', async () => {
  let now = 0, calls = 0;
  const session = new PublicSession({ now: () => now, fetch: (async () => { calls++; return json({ data: { available: true, codeAvailable: true } }); }) as typeof fetch });
  await Promise.all([session.ensureAvailability(), session.ensureAvailability()]);
  assert.equal(calls, 1);
  assert.deepEqual(session.getAvailability(), { status: 'ready', codeAvailable: true });
  now = 59999; await session.ensureAvailability(); assert.equal(calls, 1);
  await session.ensureAvailability(true); assert.equal(calls, 2);
  now += 60000; await session.ensureAvailability(); assert.equal(calls, 3);
});

test('微信失败保留失败状态，重复进入不重试风暴，手动重试能恢复', async () => {
  let calls = 0;
  const session = new PublicSession({ fetch: (async () => { if (++calls === 1) throw new Error('offline'); return json({ data: { available: false, codeAvailable: false } }); }) as typeof fetch });
  await session.ensureAvailability();
  assert.equal(session.getAvailability().status, 'error');
  await session.ensureAvailability(); assert.equal(calls, 1);
  await session.ensureAvailability(true);
  assert.equal(session.getAvailability().status, 'unavailable');
});

test('共享服务器时钟跨组件卸载继续前进，旧缓存与晚到响应不能让时钟倒退', () => {
  let now = 0;
  const clock = new PublicClock(() => now), timestamp = '2026-10-14T00:00:00.000Z';
  clock.receive(timestamp);
  now = 60000; assert.equal(clock.current(timestamp), '2026-10-14T00:01:00.000Z');
  clock.receive(timestamp);
  now = 120000; assert.equal(clock.current(timestamp), '2026-10-14T00:02:00.000Z');
  clock.receive('2026-10-14T00:03:00.000Z');
  now += 1000; assert.equal(clock.current(timestamp), '2026-10-14T00:03:01.000Z');
  clock.receive('invalid'); assert.equal(clock.current(timestamp), '2026-10-14T00:03:01.000Z');
});

test('只有一个轮询调度，隐藏页面不请求，失败退避及停止释放定时器', async () => {
  let nextId = 0, visible = true, fail = true, polls = 0, now = 0;
  const timers = new Map<number, { callback: () => unknown; delay: number }>();
  const session = new PublicSession({
    now: () => now,
    isVisible: () => visible,
    setTimeout: ((callback: () => unknown, delay: number) => { timers.set(++nextId, { callback, delay }); return nextId; }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout,
    fetch: (async url => { if (url === version) { polls++; if (fail) throw new Error('offline'); return new Response(null, { status: 304 }); } return json(envelope(['a'])); }) as typeof fetch,
  });
  await session.ensure(news);
  const leave = session.activate(news);
  session.start(); session.start();
  assert.equal(timers.size, 1);
  const run = async () => { const [id, timer] = [...timers][0]; timers.delete(id); await timer.callback(); };
  visible = false; session.resume(); assert.equal(timers.size, 0); assert.equal(polls, 0);
  visible = true; now = 60000; session.resume(); await settle(); assert.equal(polls, 1);
  assert.equal([...timers.values()][0].delay, 600000);
  fail = false; await run();
  assert.equal([...timers.values()][0].delay, 300000);
  assert.equal(session.snapshot(news).error, '');
  session.stop(); leave(); assert.equal(timers.size, 0);
});

test('隐藏页面停止时钟，回前台校准时间，停止会话释放时钟', () => {
  let now=0, visible=true, id=0, ticks=0;
  const timers=new Map<number,()=>unknown>();
  const session=new PublicSession({now:()=>now,isVisible:()=>visible,
    setTimeout:((callback:()=>unknown)=>{timers.set(++id,callback);return id;}) as unknown as typeof setTimeout,
    clearTimeout:((key:number)=>{timers.delete(key);}) as unknown as typeof clearTimeout,
  });
  session.observeClock('2026-10-14T00:00:00.000Z');
  const unsubscribe=session.subscribeClock(()=>ticks++);
  assert.equal(timers.size,1);
  visible=false;session.resume();assert.equal(timers.size,0);
  now=60000;assert.equal(ticks,0);
  visible=true;session.resume();assert.equal(timers.size,1);assert.equal(ticks,1);
  assert.equal(session.getClockSnapshot(),'2026-10-14T00:01:00.000Z');
  session.stop();assert.equal(timers.size,0);unsubscribe();
});

test('正文版本订阅只在 contentVersion 改变时触发', async () => {
  let generation = 'c1', calls = 0;
  const session = new PublicSession({ fetch: (async () => json(envelope(['a'], generation))) as typeof fetch });
  const unsubscribe = session.subscribeContentVersion(() => { calls++; });
  assert.equal(session.getContentVersion(), null);
  await session.ensure(news); assert.equal(calls, 1);
  await session.refresh(news); assert.equal(calls, 1);
  generation = 'c2'; await session.refresh(news); assert.equal(calls, 2);
  assert.equal(session.getContentVersion(), 'c2');
  unsubscribe();
});

test('正文更新失败会反馈退避；后续 304 继续同步已知旧正文并恢复', async () => {
  let generation = 'c1', fail = false, polls = 0, reads = 0;
  const session = new PublicSession({ fetch: (async url => {
    if (url === version) return ++polls === 1 ? json({ data: { version: 'c2', contentVersion: 'c2' } }) : new Response(null, { status: 304 });
    reads++;
    if (fail) throw new Error('正文读取失败');
    return json(envelope([generation], generation));
  }) as typeof fetch });
  await session.ensure(news);
  const leave = session.activate(news);
  generation = 'c2'; fail = true;
  assert.equal(await session.checkVersion(), false);
  assert.equal(session.snapshot(news).data?.articles[0].id, 'c1');
  assert.match(session.snapshot(news).error, /正文读取失败/);
  fail = false;
  assert.equal(await session.checkVersion(), true);
  assert.equal(session.snapshot(news).data?.articles[0].id, 'c2');
  assert.equal(session.snapshot(news).error, '');
  assert.equal(reads, 3);
  await session.checkVersion(); assert.equal(reads, 3);
  leave();
});

test('来源状态更新失败会退避；304 重试来源后恢复且不下载正文', async () => {
  let stateReads = 0, bodyReads = 0, polls = 0;
  const session = new PublicSession({ fetch: (async url => {
    if (url === version) return ++polls === 1 ? json({ data: { version: 's2', contentVersion: 'c1' } }) : new Response(null, { status: 304 });
    if (url === state) { if (++stateReads === 1) throw new Error('state failed'); return json(envelope([], 'c1', null, 's2')); }
    bodyReads++; return json(envelope(['a']));
  }) as typeof fetch });
  await session.ensure(news);
  const leave = session.activate(news);
  assert.equal(await session.checkVersion(), false);
  assert.match(session.snapshot(news).error, /来源状态/);
  assert.equal(await session.checkVersion(), true);
  assert.equal(session.snapshot(news).error, '');
  assert.equal(bodyReads, 1); assert.equal(stateReads, 2);
  leave();
});

test('网络恢复后的 304 只清连接错误，不需要正文请求', async () => {
  let bodyReads = 0;
  const session = new PublicSession({ fetch: (async url => {
    if (url === version) return new Response(null, { status: 304 });
    bodyReads++; return json(envelope(['a']));
  }) as typeof fetch });
  await session.ensure(news);
  const leave = session.activate(news);
  session.offline(); assert.match(session.snapshot(news).error, /网络已断开/);
  await session.checkVersion();
  assert.equal(session.snapshot(news).error, ''); assert.equal(bodyReads, 1);
  leave();
});

test('卸载中止会话请求，StrictMode 再次挂载会恢复首次读取且不残留错误', async () => {
  let calls = 0, aborted = false;
  const session = new PublicSession({ fetch: (async (_url, options) => {
    calls++;
    if (calls === 1) return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
    });
    return json(envelope(['restored']));
  }) as typeof fetch });
  session.start();
  const leave = session.activate(news);
  await settle();
  leave(); session.stop();
  const leaveAgain = session.activate(news);
  session.start();
  await settle(); await session.ensure(news);
  assert.equal(aborted, true);
  assert.equal(calls, 2);
  assert.deepEqual(session.snapshot(news).page?.ids, ['restored']);
  assert.equal(session.snapshot(news).error, '');
  leaveAgain(); session.stop();
});

test('卸载不会发起仍在微任务队列中的请求或继续后台写入', async () => {
  let calls = 0;
  const session = new PublicSession({ fetch: (async () => { calls++; return json(envelope(['late'])); }) as typeof fetch });
  session.start();
  const pending = session.ensure(news);
  session.stop();
  await pending;
  assert.equal(calls, 0);
  assert.equal(session.snapshot(news).data, null);
  assert.equal(session.snapshot(news).error, '');
});

test('请求或正文下载超时显示中文重试提示，不泄露浏览器原始中止信息', async () => {
  for (const phase of ['headers', 'body'] as const) {
    let timeout!: () => void;
    const session = new PublicSession({
      setTimeout: ((callback: () => void) => { timeout = callback; return 1; }) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
      fetch: (async (_url, options) => {
        const pending = new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new DOMException('signal is aborted without reason', 'AbortError')));
        });
        return phase === 'headers' ? pending : { ok: true, json: () => pending } as unknown as Response;
      }) as typeof fetch,
    });
    const pending = session.ensure(news);
    await settle(); timeout(); await pending;
    assert.equal(session.snapshot(news).error, '加载超时，请重试');
    assert.equal(session.snapshot(news).initialLoading, false);
  }
});

test('网络错误和非 JSON 响应使用中文提示，业务错误文案保持原样', async () => {
  const cases: Array<{ response: () => Response | Promise<Response>; expected: string }> = [
    { response: () => { throw new TypeError('Failed to fetch'); }, expected: '连接暂时中断，请重试' },
    { response: () => new Response('<html>Bad Gateway</html>'), expected: '资料暂时不可用，请重试' },
    { response: () => { throw new Error('资料正在更新，已保留原内容，请重试'); }, expected: '资料正在更新，已保留原内容，请重试' },
  ];
  for (const { response, expected } of cases) {
    const session = new PublicSession({ fetch: (async () => response()) as typeof fetch });
    await session.ensure(news);
    assert.equal(session.snapshot(news).error, expected);
  }
});

test('正常前台一小时最多十二次轻量检查，快速回前台合并而手动刷新立即执行',async()=>{
  let now=0,id=0,versions=0,bodies=0;
  const timers=new Map<number,{at:number;callback:()=>unknown}>();
  const session=new PublicSession({now:()=>now,
    setTimeout:((callback:()=>unknown,delay:number)=>{timers.set(++id,{at:now+delay,callback});return id;}) as unknown as typeof setTimeout,
    clearTimeout:((key:number)=>{timers.delete(key);}) as unknown as typeof clearTimeout,
    fetch:(async url=>{if(url===version){versions++;return new Response(null,{status:304});}bodies++;return json(envelope(['a']));}) as typeof fetch,
  });
  const leave=session.activate(news);await session.ensure(news);session.start();
  for(let i=0;i<12;i++){
    const [key,timer]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
    timers.delete(key);now=timer.at;await timer.callback();
  }
  assert.equal(now,3600_000);assert.equal(versions,12);assert.equal(bodies,1);
  session.resume();session.resume();await settle();assert.equal(versions,12);
  await session.refresh(news);assert.equal(bodies,2);
  now+=60000;session.resume();await settle();assert.equal(versions,13);
  session.resume();await settle();assert.equal(versions,13);assert.equal(timers.size,1);
  leave();session.stop();assert.equal(timers.size,0);
});

test('网页缓存过期只检查版本，未过期切页不额外查询',async()=>{
  let now=0,calls=0;
  const session=new PublicSession({now:()=>now,fetch:(async url=>{calls++;return url===version?new Response(null,{status:304}):json(envelope(['a']));}) as typeof fetch});
  await session.ensure(news);await session.ensure(home);await session.ensure(news);assert.equal(calls,2);
  now=300000;await session.ensure(news);assert.equal(calls,3);
});


test('仅新增内容等待用户确认，撤回立即替换，提示版本也参与304验证',async()=>{
  const make=(ids:string[],revision:string)=>{const value=envelope(ids,revision);value.data.publications=ids.map(id=>({id})) as PublicData['publications'];return value;};
  let current=make(['a'],'c1'),bodies=0;
  const session=new PublicSession({fetch:(async url=>{if(url===version)return json({data:{version:current.version,contentVersion:current.contentVersion}});bodies++;return json(current);}) as typeof fetch});
  await session.ensure(news);const leave=session.activate(news);
  current=make(['b','a'],'c2');await session.checkVersion();
  assert.deepEqual(session.snapshot(news).page?.ids,['a']);assert.equal(session.snapshot(news).updateAvailable,true);
  await session.checkVersion();assert.equal(bodies,2,'待确认新版本不反复下载');
  session.applyUpdates(news);assert.deepEqual(session.snapshot(news).page?.ids,['b','a']);assert.equal(session.snapshot(news).updateAvailable,false);
  current=make(['b'],'c3');await session.checkVersion();assert.deepEqual(session.snapshot(news).page?.ids,['b']);assert.equal(session.snapshot(news).updateAvailable,false);
  leave();session.stop();
});

test('会话缓存限制20项，主导航与活跃页保留，详情按最近访问淘汰',async()=>{
  let now=0;const calls:string[]=[];
  const session=new PublicSession({now:()=>now++,fetch:(async url=>{calls.push(String(url));return json(envelope(['a']));}) as typeof fetch});
  await session.ensure(home);
  for(let i=0;i<26;i++){const endpoint=`/api/v1/bootstrap?view=detail&id=${i}`;const leave=session.activate(endpoint);await session.ensure(endpoint);leave();}
  assert.equal((session as any).entries.size,20);
  const count=calls.length;await session.ensure(home);assert.equal(calls.length,count,'主导航不被详情挤掉');
  await session.ensure('/api/v1/bootstrap?view=detail&id=0');assert.equal(calls.length,count+1);
});
