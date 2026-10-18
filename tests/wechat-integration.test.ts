import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Article, Evidence, Job, Notice, Publication, RadarEvent } from '../src/lib/types';
import type { WechatDelivery, WechatGrant, WechatReader } from '../src/lib/wechat';
import type { WechatRecord } from '../src/server/wechat';

// No local environment file or database is loaded by the ordinary test suite.
function isolatedDatabase(): boolean {
  if (process.env.RADAR_INTEGRATION !== '1') return false;
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return url.hostname === '127.0.0.1' && url.port === '55489' && /^\/radar_qa_[a-z0-9_]+$/.test(url.pathname);
  } catch { return false; }
}
let closePool: (() => Promise<void>) | undefined;
after(async () => { await closePool?.(); });

test('真实隔离库：微信身份、一次性授权、任务派发和安全投影', { skip: !isolatedDatabase() }, async t => {
  process.env.DOTENV_CONFIG_PATH = fileURLToPath(new URL('./.wechat-integration-no-env', import.meta.url));
  const { pool, list, one, put, insert, transaction } = await import('../src/db');
  closePool = () => pool.end();
  const actual = await pool.query<{ name: string }>('SELECT current_database() AS name');
  const expectedName = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  assert.match(actual.rows[0].name, /^radar_qa_[a-z0-9_]+$/, '只能在真正隔离的 QA 数据库执行');
  assert.equal(actual.rows[0].name, expectedName, '实际数据库必须与 QA 配置一致');
  const { createWechatService, defaultWechat } = await import('../src/server/wechat');
  const { WechatServiceError } = await import('../src/server/wechat-provider');
  const { runOne } = await import('../src/server/worker');
  const { getPublicData, getAdminData } = await import('../src/server/service');

  const require = createRequire(import.meta.url);
  const sharp = createRequire(require.resolve('next/package.json'))('sharp');
  // A genuine, decodable PNG fixture; this is explicitly not an actual WeChat code.
  const png: Buffer = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  assert.equal((await sharp(png).metadata()).width, 2);
  const tag = randomBytes(8).toString('hex');
  const fixtureSecret = `synthetic-wechat-secret-${tag}`;
  const fixtureToken = `synthetic-provider-token-${tag}`;
  const fixtureSessionKey = `synthetic-session-key-${tag}`;
  const fixtureUnionId = `synthetic-union-id-${tag}`;
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const rawOpenids = new Set<string>();
  const rawSessions = new Set<string>();
  let tokenFailure = false, sendUnknown = false;
  let clock = Date.now(), sequence = 0;
  const at = () => new Date(clock).toISOString();
  const sendCount = () => calls.filter(call => call.path === '/cgi-bin/message/subscribe/send').length;
  const ownedReaders = new Set<string>(), ownedJobs = new Set<string>();
  const ownedSessions = new Map<string,string>();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.weixin.qq.com', '所有请求只交给官方地址的测试替身');
    assert.equal(init?.redirect, 'error');
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path: url.pathname, body });
    if (url.pathname === '/sns/jscode2session') {
      const code = url.searchParams.get('js_code');
      assert.ok(code?.startsWith(`synthetic-login-${tag}-`));
      const openid = `synthetic_${createHash('sha256').update(code!).digest('hex').slice(0,32)}`;
      rawOpenids.add(openid);
      return Response.json({ openid, session_key: fixtureSessionKey, unionid: fixtureUnionId });
    }
    if (url.pathname === '/cgi-bin/stable_token') {
      assert.equal(body?.grant_type, 'client_credential');
      assert.equal(body?.force_refresh, false);
      return tokenFailure ? Response.json({ errcode: 40125, errmsg: 'synthetic-private-provider-error' }) : Response.json({ access_token: fixtureToken, expires_in: 7200 });
    }
    if (url.pathname === '/wxa/getwxacodeunlimit') {
      assert.equal(body?.page, 'pages/detail/index');
      assert.equal(body?.env_version, 'trial');
      assert.equal(body?.check_path, false, '体验版圆码沿用已核验的固定页面策略');
      assert.match(String(body?.scene), /^[a-f0-9]{32}$/);
      return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
    }
    if (url.pathname === '/cgi-bin/message/subscribe/send') {
      assert.equal(body?.template_id, `synthetic-template-${tag}`);
      assert.ok(rawOpenids.has(String(body?.touser)));
      assert.equal(body?.miniprogram_state, 'trial');
      if (sendUnknown) throw new Error('synthetic-private-network-error');
      return Response.json({ errcode: 0, errmsg: 'ok' });
    }
    assert.fail('未预期的微信接口；禁止真实网络调用');
  }) as typeof fetch;
  const service = createWechatService({ fetcher, clock: () => clock, encryptionKey: () => Buffer.alloc(32, 19), preparePublicPage: async () => {} });
  const originalSettings = await one<WechatRecord>('settings', 'wechat');
  const suspendedJobs = (await list<Job>('jobs')).filter(job => ['queued','running'].includes(job.status));
  const configure = async (patch: Record<string, unknown> = {}) => {
    const current = await service.adminWechat();
    return service.saveWechatSettings({ ...current, appId: `wx${tag}`, secret: fixtureSecret, qrEnabled: true, subscriptionsEnabled: true, envVersion: 'trial', templateId: `synthetic-template-${tag}`, templateFields: { title: 'thing1', status: 'phrase2', time: 'time3' }, dailyApiLimit: Math.max(200, (current.callsToday ?? 0) + 100), dailyQrLimit: 200, dailySendLimit: 200, ...patch }, `synthetic-wechat-owner-${tag}`);
  };
  async function identity() {
    clock = Math.max(Date.now(), clock + 1);
    const session = await service.wechatLogin(`synthetic-login-${tag}-${++sequence}`);
    rawSessions.add(session.sessionToken);
    const record = (await list<WechatReader>('wechat_readers')).find(reader => reader.appId === `wx${tag}` && !ownedReaders.has(reader.id));
    assert.ok(record, '测试登录必须持久化独立身份');
    ownedReaders.add(record.id);
    ownedSessions.set(record.id,session.sessionToken);
    return { session, reader: record };
  }
  async function accept(sessionToken: string) {
    const challenge = await service.wechatSubscriptionChallenge(sessionToken);
    assert.ok(challenge.nonce);
    const state = await service.confirmWechatSubscription(sessionToken, { nonce: challenge.nonce, templateId: challenge.templateId, result: 'accept' });
    assert.equal(state.state, 'available');
    return challenge;
  }
  async function publishedFixture(statementAt?:string) {
    const suffix = `${tag}-${++sequence}`, stamp = at(), originalAt = statementAt ?? stamp;
    const evidence: Evidence = { id: `synthetic-wechat-evidence-${suffix}`, sourceId: 'synthetic-wechat-isolated-qa', messageId: suffix, url: `https://example.invalid/synthetic-wechat/${suffix}`, text: '[隔离合成样例] We have reset all usage limits for all accounts.', hash: createHash('sha256').update(suffix).digest('hex'), publishedAt: originalAt, collectedAt: stamp, contextComplete: true, historical: false, provenance: 'official' };
    const publicationId = `synthetic-wechat-publication-${suffix}`;
    const event: RadarEvent = { id: `synthetic-wechat-event-${suffix}`, title: '[隔离合成样例] 公告称完成', version: 1, status: 'published', evidenceIds: [evidence.id], publicationId, updatedAt: stamp, actions: [{ id: `synthetic-action-${suffix}`, kind: 'automatic_reset', stage: 'claimed_complete', scope: 'public', eligibility: '隔离合成样例账户', evidenceIds: [evidence.id], evidenceQuote: evidence.text, statementAt: originalAt }] };
    const article: Article = { id: `synthetic-wechat-article-${suffix}`, eventId: event.id, title: '[隔离合成样例] 公告称完成', summary: '仅用于隔离数据库验收，不是真实发放消息。', translation: '合成样例原文的中文说明。', category: 'reset', version: 1, status: 'published', publicationId, evidenceIds: [evidence.id], publishedAt: stamp, sourcePublishedAt: stamp, updatedAt: stamp, historical: false, publicationMode: 'state_change', contentOrigin: 'template' };
    const publication: Publication = { id: publicationId, eventId: event.id, articleId: article.id, event, article, cutoffAt: stamp, publishedAt: stamp, reason: '隔离合成样例，仅验证持久化' };
    await transaction(async client => { await insert('evidence', evidence, client); await put('events', event, client); await put('articles', article, client); await insert('publications', publication, client); });
    return { evidence, event, article, publication };
  }
  async function queueNotice(readerId: string) {
    // Each scenario owns one active reader. Cancelled deliveries now preserve
    // unused credits, so previous scenarios must explicitly revoke their reader.
    for(const [previousId,sessionToken] of ownedSessions)if(previousId!==readerId)await service.revokeWechatSubscription(sessionToken);
    // This fixture represents a new original announcement after consent. A later
    // notice processing timestamp must not make an earlier statement eligible.
    clock = Math.max(Date.now(), clock + 1);
    const fixture = await publishedFixture();
    clock = Math.max(Date.now(), clock + 1);
    const notice: Notice = { id: `synthetic-wechat-notice-${tag}-${++sequence}`, eventId: fixture.event.id, publicationId: fixture.publication.id, semanticKey: `synthetic-fact-${tag}-${sequence}`, title: '[隔离合成样例] 用量重置结果', summary: '合成公告，不代表真实发放。', categories: ['result'], status: 'active', createdAt: at() };
    await insert('notices', notice);
    await service.scheduleWechatDeliveries();
    const delivery = (await list<WechatDelivery>('wechat_deliveries')).find(item => item.readerId === readerId && item.noticeId === notice.id);
    assert.ok(delivery, '授权后的关键变化应进入持久化队列');
    const job = await one<Job>('jobs', `job_${delivery.id}`);
    assert.ok(job);
    ownedJobs.add(job.id);
    return { ...fixture, notice, delivery, job };
  }
  async function dispatch(job: Job) {
    const wait = Date.parse(job.availableAt) - Date.now();
    assert.ok(wait < 1000, '合成派发任务必须立即到期');
    if (wait >= 0) await new Promise(resolve => setTimeout(resolve, wait + 2));
    assert.equal(await runOne({ schedule: false, wechat: service.processWechatJob }), true);
    const persisted = await one<Job>('jobs', job.id);
    assert.ok(persisted);
    assert.equal(persisted.attempts, job.attempts + 1, '实际 worker 必须领取目标测试任务');
    return persisted;
  }
  function assertPrivateAbsent(value: unknown) {
    const text = JSON.stringify(value);
    const forbidden = [fixtureSecret, fixtureToken, fixtureSessionKey, fixtureUnionId, ...rawOpenids, ...rawSessions, 'encryptedOpenid', 'encryptedSecret', 'encryptedToken', 'openidHash', 'nonceHash', 'confirmedNonceHash', 'synthetic-private-provider-error', 'synthetic-private-network-error'];
    for (const marker of forbidden) assert.ok(!text.includes(marker), '公开或管理员投影不能包含私有身份与凭据');
  }

  try {
    for (const job of suspendedJobs) await put('jobs', { ...job, status: 'queued', leaseUntil: undefined, availableAt: '2100-01-01T00:00:00.000Z' });
    await configure();
    let initial: Awaited<ReturnType<typeof identity>>;
    let first: Awaited<ReturnType<typeof queueNotice>>;
    await t.test('显式迁移的三表存在，数据库身份和会话不保留明文', async () => {
      const tables = await pool.query<{ readers: string | null; grants: string | null; deliveries: string | null }>("SELECT to_regclass('radar_wechat_readers')::text AS readers,to_regclass('radar_wechat_grants')::text AS grants,to_regclass('radar_wechat_deliveries')::text AS deliveries");
      assert.ok(Object.values(tables.rows[0]).every(Boolean));
      initial = await identity();
      assert.equal(initial.reader.sessions.length, 1);
      assert.match(initial.reader.sessions[0].hash, /^[a-f0-9]{64}$/);
      const stored = JSON.stringify(initial.reader);
      for (const marker of [...rawOpenids, ...rawSessions, fixtureSessionKey, fixtureUnionId]) assert.ok(!stored.includes(marker), '微信身份、会话及交换结果不得明文持久化');
      assert.equal(await insert('wechat_readers', { ...initial.reader, id: `synthetic-duplicate-reader-${tag}` }), false, '不同主键的同一微信身份应由数据库唯一索引阻止');
      const fixture = await publishedFixture(), code = await service.generateWechatCode(fixture.publication.id);
      assert.equal(code.contentType, 'image/png');
      assert.equal((await sharp(code.image).metadata()).width, 2, '返回的图片必须真正可解码');
    });
    await t.test('授权前原文在授权后才入库和发布，不补发且不占用次数', async () => {
      const reader = await identity();
      await accept(reader.session.sessionToken);
      const fixture = await publishedFixture(new Date(clock - 60_000).toISOString());
      clock = Math.max(Date.now(), clock + 1);
      const notice:Notice={id:`synthetic-late-notice-${tag}-${++sequence}`,eventId:fixture.event.id,publicationId:fixture.publication.id,semanticKey:`synthetic-late-fact-${tag}-${sequence}`,title:'授权前完成消息的延迟处理',summary:'隔离样例',categories:['result'],status:'active',createdAt:at()};
      await insert('notices',notice);
      const before=sendCount();
      await service.scheduleWechatDeliveries();
      assert.equal((await list<WechatDelivery>('wechat_deliveries')).some(item=>item.readerId===reader.reader.id&&item.noticeId===notice.id),false);
      assert.equal((await service.wechatSubscriptionState(reader.session.sessionToken)).remainingCount,1);
      assert.equal(sendCount(),before);
      await service.revokeWechatSubscription(reader.session.sessionToken);
    });
    await t.test('真实grant→notice→schedule→runOne仅发送一次，并保留固定版本', async () => {
      await accept(initial!.session.sessionToken);
      first = await queueNotice(initial!.reader.id);
      const grant = (await list<WechatGrant>('wechat_grants')).find(item => item.readerId === initial!.reader.id)!;
      assert.equal(grant.status, 'reserved');
      assert.equal(await insert('wechat_grants', { ...grant, id: `synthetic-duplicate-grant-${tag}` }), false, '同读者同模板授权必须唯一');
      assert.equal(await insert('wechat_deliveries', { ...first.delivery, id: `synthetic-duplicate-delivery-${tag}` }), false, '同消息同读者同模板只能有一次派发');
      const before = sendCount(), job = await dispatch(first.job);
      assert.equal(job.status, 'succeeded');
      assert.equal(job.payload.wechatState, 'sent');
      const delivered = await one<WechatDelivery>('wechat_deliveries', first.delivery.id);
      assert.equal(delivered?.status, 'sent');
      assert.equal(delivered?.attempts, 1);
      assert.equal((await one<WechatGrant>('wechat_grants', grant.id))?.status, 'consumed');
      assert.equal(calls.filter(call => call.path === '/cgi-bin/message/subscribe/send').at(-1)?.body?.page, `pages/detail/index?publicationId=${encodeURIComponent(first.publication.id)}`);
      await service.scheduleWechatDeliveries();
      assert.equal((await service.processWechatJob(job)).state, 'sent');
      assert.equal(await runOne({ schedule: false, wechat: service.processWechatJob }), false);
      assert.equal(sendCount(), before + 1, '重复调度和执行不能重复发送');
      assert.equal((await list<WechatDelivery>('wechat_deliveries')).filter(item => item.readerId === initial!.reader.id && item.noticeId === first.notice.id).length, 1);
    });
    await t.test('撤销授权、公告撤回及事件撤回会取消queued，均不调用发送接口', async () => {
      for (const action of ['consent', 'notice', 'event'] as const) {
        const reader = await identity();
        await accept(reader.session.sessionToken);
        const queued = await queueNotice(reader.reader.id), before = sendCount();
        if (action === 'consent') await service.revokeWechatSubscription(reader.session.sessionToken);
        if (action === 'notice') await put('notices', { ...queued.notice, status: 'withdrawn' });
        if (action === 'event') await put('events', { ...queued.event, status: 'withdrawn' });
        await service.scheduleWechatDeliveries();
        const job = await dispatch(queued.job);
        assert.equal(job.status, 'succeeded');
        assert.equal(job.payload.wechatState, 'cancelled');
        assert.equal((await one<WechatDelivery>('wechat_deliveries', queued.delivery.id))?.status, 'cancelled');
        assert.equal(sendCount(), before);
      }
    });
    await t.test('失败凭据外部调用仍持久化计数，预算耗尽不发第三次请求', async () => {
      const baseline = (await service.adminWechat()).callsToday ?? 0;
      await configure({ dailyApiLimit: baseline + 2 });
      tokenFailure = true;
      const fixture = await publishedFixture(), before = calls.length;
      for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(service.generateWechatCode(fixture.publication.id), error => error instanceof WechatServiceError && error.errorCode === 40125);
      await assert.rejects(service.generateWechatCode(fixture.publication.id), error => error instanceof WechatServiceError && error.failureKind === 'budget');
      assert.equal(calls.length, before + 2);
      assert.equal((await service.adminWechat()).callsToday, baseline + 2, '已经发生的外部请求不能随失败事务回滚');
      tokenFailure = false;
      await configure();
    });
    await t.test('token预留已提交后send预算不足仍保留计数及待续跑状态', async () => {
      const reader = await identity();
      await accept(reader.session.sessionToken);
      const queued = await queueNotice(reader.reader.id);
      const baseline = (await service.adminWechat()).callsToday ?? 0, before = sendCount();
      await configure({ dailyApiLimit: baseline + 1 });
      const job = await dispatch(queued.job);
      assert.equal(job.status, 'queued');
      assert.equal(job.payload.wechatState, 'deferred');
      assert.equal((await one<WechatDelivery>('wechat_deliveries', queued.delivery.id))?.status, 'queued');
      assert.equal((await service.wechatSubscriptionState(reader.session.sessionToken)).state, 'reserved');
      assert.equal((await service.adminWechat()).callsToday, baseline + 1);
      assert.equal(sendCount(), before);
      await service.revokeWechatSubscription(reader.session.sessionToken);
      await put('jobs', { ...job, status: 'failed', leaseUntil: undefined, finishedAt: at(), error: '隔离合成样例预算测试结束' });
      await configure();
    });
    await t.test('发送结果不明持久化unknown，重复运行不再发请求', async () => {
      const reader = await identity();
      await accept(reader.session.sessionToken);
      const queued = await queueNotice(reader.reader.id), before = sendCount();
      sendUnknown = true;
      const job = await dispatch(queued.job);
      sendUnknown = false;
      assert.equal(job.status, 'succeeded');
      assert.equal(job.payload.wechatState, 'unknown');
      assert.equal((await one<WechatDelivery>('wechat_deliveries', queued.delivery.id))?.status, 'unknown');
      assert.equal((await service.wechatSubscriptionState(reader.session.sessionToken)).state, 'unknown');
      await service.scheduleWechatDeliveries();
      assert.equal((await service.processWechatJob(job)).state, 'unknown');
      assert.equal(sendCount(), before + 1);
      clock = Math.max(Date.now(),clock+1);
      await accept(reader.session.sessionToken);
      const resumedAt = at();
      clock = Math.max(Date.now(),clock+1);
      const fixture = await publishedFixture();
      const pending: Notice = { ...queued.notice, id:`synthetic-pending-${tag}-${++sequence}`, eventId:fixture.event.id, publicationId:fixture.publication.id, semanticKey:`synthetic-pending-fact-${tag}-${sequence}`, createdAt:at() };
      await insert('notices',pending);
      clock = Math.max(Date.now(),clock+1);
      await accept(reader.session.sessionToken);
      const grant = (await list<WechatGrant>('wechat_grants')).find(item=>item.readerId===reader.reader.id)!;
      assert.equal(grant.resumedAt,resumedAt,'数据库恢复边界不能随增加次数前移');
      await service.scheduleWechatDeliveries();
      const delivery = (await list<WechatDelivery>('wechat_deliveries')).find(item=>item.noticeId===pending.id&&item.readerId===reader.reader.id)!;
      assert.ok(delivery,'恢复后产生、尚未派发的公告仍应入队');
      const nextJob = (await one<Job>('jobs',`job_${delivery.id}`))!;ownedJobs.add(nextJob.id);
      assert.equal((await dispatch(nextJob)).status,'succeeded');
      assert.equal((await one<WechatDelivery>('wechat_deliveries',delivery.id))?.status,'sent');
      assert.equal((await one<WechatDelivery>('wechat_deliveries',queued.delivery.id))?.status,'unknown');
      assert.equal(sendCount(),before+2);
    });
    await t.test('公开和管理员资料只包含公开内容或聚合结果，不包含私有对象', async () => {
      const publicData = await getPublicData(), adminData = await getAdminData();
      assertPrivateAbsent(publicData);
      assertPrivateAbsent(adminData);
      for (const value of [publicData, adminData]) {
        for (const key of ['wechat_readers', 'wechat_grants', 'wechat_deliveries', 'readers', 'grants', 'deliveries']) assert.ok(!(key in value), '私有表不得作为资料集合返回');
      }
      assert.ok(publicData.publications.some(item => item.id === first!.publication.id));
      assert.equal(adminData.wechat?.hasSecret, true);
      assert.ok((adminData.wechat?.deliveries?.sent ?? 0) >= 1);
      assert.ok((adminData.wechat?.deliveries?.unknown ?? 0) >= 1);
    });
  } finally {
    // Retain all synthetic records as QA evidence; only deactivate this test's pending work.
    for (const reader of await list<WechatReader>('wechat_readers')) if (ownedReaders.has(reader.id)) await put('wechat_readers', { ...reader, status: 'disabled' });
    for (const grant of await list<WechatGrant>('wechat_grants')) if (ownedReaders.has(grant.readerId) && ['available','reserved','challenged'].includes(grant.status)) await put('wechat_grants', { ...grant, status: 'revoked', updatedAt: at() });
    for (const delivery of await list<WechatDelivery>('wechat_deliveries')) if (ownedReaders.has(delivery.readerId) && delivery.status === 'queued') await put('wechat_deliveries', { ...delivery, status: 'cancelled', finishedAt: at(), reason: '隔离合成样例验收结束' });
    for (const job of await list<Job>('jobs')) if (ownedJobs.has(job.id) && ['queued','running'].includes(job.status)) await put('jobs', { ...job, status: 'failed', leaseUntil: undefined, finishedAt: at(), error: '隔离合成样例验收结束' });
    await put('settings', originalSettings ?? { ...defaultWechat, version: (await service.adminWechat()).version + 1 });
    for (const job of suspendedJobs) await put('jobs', job);
  }
});
