import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PublicData } from '../src/lib/types';
import { GET, POST } from '../src/app/api/wechat/[...path]/route';

test('次数摘要仍要求读者身份，响应不可缓存',async()=>{
  for(const [handler,path] of [[GET,['subscription']],[POST,['subscription','challenge']]] as const){
    const response=await handler(new Request(`http://127.0.0.1/api/wechat/${path.join('/')}`,{method:handler===GET?'GET':'POST',headers:{'X-Radar-Subscription-View':'summary'}}),{params:Promise.resolve({path:[...path]})});
    assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'no-store');
  }
});

test('微信提醒偏好HTTP接口拒绝未认证与非法格式，不访问数据库',async()=>{
  const context={params:Promise.resolve({path:['subscription','preferences']})};
  const unauthenticated=await POST(new Request('http://127.0.0.1/api/wechat/subscription/preferences',{method:'POST',body:JSON.stringify({announcement:true,result:true,correction:true})}),context);
  assert.equal(unauthenticated.status,401);assert.equal(unauthenticated.headers.get('cache-control'),'no-store');
  for(const value of [{announcement:true,result:true}, {announcement:true,result:'false',correction:true},{announcement:true,result:true,correction:true,readerId:'another-reader'}]){
    const response=await POST(new Request('http://127.0.0.1/api/wechat/subscription/preferences',{method:'POST',headers:{authorization:`Bearer ${'a'.repeat(43)}`,'content-type':'application/json'},body:JSON.stringify(value)}),context);
    assert.equal(response.status,400);assert.equal(response.headers.get('cache-control'),'no-store');
  }
});

// HTTP verification runs only against the runner-created, isolated QA database.
// No successful reader login, settings write or real WeChat call is performed.
test('微信公共与读者接口：未配置保护、固定场景、身份隔离', { skip: process.env.RADAR_INTEGRATION !== '1' }, async t => {
  const base = new URL(process.env.RADAR_TEST_URL || 'http://127.0.0.1:5191');
  const database = new URL(process.env.DATABASE_URL || '');
  assert.equal(base.origin, 'http://127.0.0.1:5191', '只允许项目隔离测试服务');
  assert.equal(database.hostname, '127.0.0.1');
  assert.equal(database.port, '55489');
  assert.match(database.pathname, /^\/radar_qa_[a-zA-Z0-9_]+$/, '拒绝操作本机运行库');
  const sceneOf = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32);
  function assertSafe(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(assertSafe); return; }
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, /^(?:openid|openidHash|encryptedOpenid|secret|encryptedSecret|sessionToken|sessions|nonceHash|confirmedNonceHash)$/i);
      assertSafe(child);
    }
  }
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(new URL(path, base), { method, redirect: 'manual', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assertSafe(value);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { response, value };
  }
  const bootstrap = await request('/api/v1/bootstrap'); assert.equal(bootstrap.response.status, 200);
  const data = bootstrap.value.data as PublicData;
  const publication = data.publications.find(item => item.event.status === 'published' && item.article.status === 'published' && data.events.some(event => event.id === item.eventId && event.status === 'published') && data.articles.some(article => article.id === item.articleId && article.status === 'published'));
  assert.ok(publication, '从隔离库真实已发布资料选择固定版本，不写入模拟消息');

  await t.test('未配置登录返回503，不产生真实微信登录调用', async () => {
    const result = await request('/api/wechat/login', 'POST', { code: 'isolated-unconfigured-login-code' });
    assert.equal(result.response.status, 503); assert.match(result.value.error, /未配置|关闭/);
  });
  await t.test('无bearer不能读取、申请、确认或关闭读者订阅', async () => {
    for (const [path, method, body] of [
      ['/api/wechat/subscription', 'GET', undefined],
      ['/api/wechat/subscription/challenge', 'POST', undefined],
      ['/api/wechat/subscription/confirm', 'POST', { nonce: 'isolated-nonce', templateId: 'isolated-template', result: 'accept' }],
      ['/api/wechat/subscription/preferences', 'POST', { announcement:true,result:true,correction:true }],
      ['/api/wechat/subscription', 'DELETE', undefined],
    ] as const) { const result = await request(path, method, body); assert.equal(result.response.status, 401, `${method} ${path}`); assert.match(result.value.error, /先|会话|连接/); }
  });
  await t.test('场景指向所选固定版本，旧版不会自动跳到最新版本', async () => {
    const selected = await request(`/api/v1/wechat/scene/${sceneOf(publication.id)}`);
    assert.equal(selected.response.status, 200); assert.deepEqual(selected.value.data, { publicationId: publication.id });
  });
  await t.test('非法与不存在的场景分别返回400和404，不猜最新', async () => {
    assert.equal((await request('/api/v1/wechat/scene/invalid-scene')).response.status, 400);
    let absent = sceneOf('isolated-no-existing-publication');
    while (data.publications.some(item => sceneOf(item.id) === absent)) absent = sceneOf(absent);
    assert.equal((await request(`/api/v1/wechat/scene/${absent}`)).response.status, 404);
  });
  await t.test('真实码未配置返回503，没有图像或替代码', async () => {
    const result = await request(`/api/v1/wechat/code/${encodeURIComponent(publication.id)}`);
    assert.equal(result.response.status, 503); assert.match(result.value.error, /未配置|关闭/); assert.equal(result.value.data, undefined);
  });
  await t.test('管理数据与微信设置修改仍要求管理员身份', async () => {
    assert.equal((await request('/api/admin/data')).response.status, 401);
    assert.equal((await request('/api/admin/command', 'POST', { action: 'settings.wechat', input: {} })).response.status, 401);
  });
});
