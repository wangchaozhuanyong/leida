import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CloudbaseRpc, CloudbaseRpcError } from '../src/server/cloudbase/rpc';
import { cloudbaseStore } from '../src/server/cloudbase/store';
import { list, one, put, insert, transaction, type Client } from '../src/db';
import type { Job, Source, Candidate, Publication, Notice } from '../src/lib/types';
import type { WechatDelivery } from '../src/lib/wechat';
import { createEvidence, defaultSite, queueJob } from '../src/server/service';
import { runOne, scheduleDue } from '../src/server/worker';
import { createWechatService } from '../src/server/wechat';
import { runForecastCycle } from '../src/server/forecast';
import {testAI,AIServiceError} from '../src/server/ai';

type Pass = (name: string, detail: string) => void;
const conflict = (error: unknown) => error instanceof CloudbaseRpcError && error.kind === 'conflict';
export async function testCloudbaseWrite(pool: pg.Pool, rpc: CloudbaseRpc, anonymous: CloudbaseRpc, pass: Pass, transport: typeof fetch, token: string) {
  const schema=await readFile(new URL('./migrations/cloudbase-write-schema.sql',import.meta.url),'utf8'),functions=await readFile(new URL('./migrations/cloudbase-write-rpc.sql',import.meta.url),'utf8');
  await pool.query('DO LANGUAGE plpgsql $write_install$ BEGIN EXECUTE $install_schema$'+schema+'$install_schema$; EXECUTE $install_rpc$'+functions+'$install_rpc$; END; $write_install$;');
  const acl = await pool.query("SELECT count(*)::int AS count FROM unnest(ARRAY['radar_candidates','radar_audits','radar_wechat_readers','radar_wechat_grants','radar_wechat_deliveries','radar_cb_leases']) t WHERE has_table_privilege('anon','public.'||t,'SELECT') OR has_table_privilege('service_role','public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE')");
  assert.equal(acl.rows[0].count, 0);
  for (const operation of ['radar_cb_store_read', 'radar_cb_store_commit', 'radar_cb_store_lease'] as const) await assert.rejects(anonymous.call(operation), error => error instanceof CloudbaseRpcError && error.status === 403);
  pass('write_permission_gate', 'five empty business tables and private lease table; three fixed RPCs reject anonymous access; direct table writes denied');

  const previous = { mode: process.env.RADAR_STORAGE_BACKEND, public: process.env.RADAR_PUBLIC_READ_BACKEND, env: process.env.CLOUDBASE_ENV_ID, key: process.env.CLOUDBASE_API_KEY, encryption: process.env.ENCRYPTION_KEY, fetch: globalThis.fetch };
  globalThis.fetch = ((input, init) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).hostname.endsWith('.api.tcloudbasegateway.com') ? transport(input, init) : previous.fetch(input, init)) as typeof fetch;
  Object.assign(process.env, { RADAR_STORAGE_BACKEND: 'cloudbase', RADAR_PUBLIC_READ_BACKEND: 'cloudbase', CLOUDBASE_ENV_ID: 'leida-test-qa', CLOUDBASE_API_KEY: token, ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  try {
    process.env.RADAR_PUBLIC_READ_BACKEND='native';await assert.rejects(one('settings','site'),error=>error instanceof CloudbaseRpcError&&error.kind==='configuration');process.env.RADAR_PUBLIC_READ_BACKEND='cloudbase';
    process.env.RADAR_STORAGE_BACKEND='misspelled';await assert.rejects(list('sources'),error=>error instanceof CloudbaseRpcError&&error.kind==='configuration');process.env.RADAR_STORAGE_BACKEND='cloudbase';
    pass('storage_mode_fail_closed','mixed read/write backends and misspelled storage mode rejected before database access');
    await assert.rejects(testAI(),error=>error instanceof AIServiceError&&error.failureKind==='configuration'&&/未配置|未测试|未启用/.test(error.message));
    pass('cloud_paid_ai_stays_disabled','unconfigured cloud AI rejects before provider request or accounting; free template path remains available');
    const store = cloudbaseStore(rpc);
    const probeId = 'write-cas-probe';
    await put('settings', { id: probeId, count: 0 });
    const before = (await list('audits')).length;
    let escaped: Client | undefined;
    await assert.rejects(transaction(async client => { escaped = client; await put('settings', { id: probeId, count: 99 }, client); await insert('audits', { id: 'write-rollback-audit' }, client); throw new Error('intentional callback rollback'); }));
    assert.equal((await one<{ count: number }>('settings', probeId))?.count, 0);
    assert.equal((await list('audits')).length, before);
    await assert.rejects(put('settings', { id: 'write-leaked-client' }, escaped!));
    let commits=0;const uncertainRpc=new CloudbaseRpc('leida-test-qa',token,async(input,init)=>{const response=await transport(input,init);if(String(input).endsWith('/radar_cb_store_commit')){commits++;throw new Error('intentional lost acknowledgement');}return response;});
    await assert.rejects(cloudbaseStore(uncertainRpc).transaction(client=>put('settings',{id:'write-unknown-commit',count:1},client)),error=>error instanceof CloudbaseRpcError&&error.kind==='unknown');
    assert.equal(commits,1);assert.equal((await one<{count:number}>('settings','write-unknown-commit'))?.count,1);
    pass('write_unknown_ack_no_retry','committed SQL followed by lost HTTP acknowledgement is reported unknown; one attempt only');
    pass('business_callback_rollback', 'callback failure left settings and audit unchanged; escaped transaction client cannot write');

    let loaded = 0; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const concurrent = await Promise.allSettled([1, 2].map(() => store.transaction(async client => { const value = (await one<{ id: string; count: number }>('settings', probeId, client))!; if (++loaded === 2) release(); await barrier; await put('settings', { ...value, count: value.count + 1 }, client); })));
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(concurrent.some(result => result.status === 'rejected' && conflict(result.reason)));
    assert.equal((await one<{ count: number }>('settings', probeId))?.count, 1);
    pass('business_cross_process_cas', 'two simultaneous read-modify-writes produce one winner and one explicit conflict; no lost update');

    await assert.rejects(store.transaction(async client => { await list('candidates', client); await put('settings', { id: 'write-phantom-rollback' }, client); await pool.query("INSERT INTO public.radar_candidates(id,payload) VALUES('write-phantom', '{\"id\":\"write-phantom\"}'::jsonb)"); }), conflict);
    assert.equal(await one('settings', 'write-phantom-rollback'), undefined);
    await assert.rejects(store.transaction(async client => { await one('settings', probeId, client); await pool.query("UPDATE public.radar_settings SET payload=jsonb_set(payload,'{count}','2') WHERE id=$1", [probeId]); await list('settings', client); }), conflict);
    pass('business_phantom_and_mixed_read_guard', 'concurrent insertion rolls back the entire stale transaction; changed table between one/list rejected');

    for (let index = 0; index < 205; index++) await pool.query('INSERT INTO public.radar_audits(id,payload,created_at) VALUES($1,$2,$3)', [`write-page-${index.toString().padStart(3, '0')}`, JSON.stringify({ id: `write-page-${index.toString().padStart(3, '0')}` }), new Date(1791849600000 + index * 1000).toISOString()]);
    const paged = (await list<{ id: string }>('audits')).filter(row => row.id.startsWith('write-page-'));
    assert.equal(paged.length, 205); assert.equal(new Set(paged.map(row => row.id)).size, 205); assert.equal(paged[0].id, 'write-page-204');
    await assert.rejects(put('audits', { id: 'write-page-000' }));
    const snap = await rpc.call<{ fingerprint: string }>('radar_cb_store_read', { p_table: 'audits' });
    await assert.rejects(rpc.call('radar_cb_store_commit', { p_expected: { audits: snap.fingerprint }, p_changes: [{ table: 'audits', kind: 'put', value: { id: 'write-page-000' } }] }));
    const settings = await rpc.call<{ fingerprint: string }>('radar_cb_store_read', { p_table: 'settings' });
    await assert.rejects(rpc.call('radar_cb_store_commit', { p_expected: { settings: settings.fingerprint }, p_changes: [{ table: 'settings', kind: 'put', value: { id: 'write-sql-rollback' } }, { table: 'notices', kind: 'put', value: { id: 'write-missing-readset' } }] }));
    assert.equal(await one('settings', 'write-sql-rollback'), undefined);
    pass('write_pagination_immutable_and_server_rollback', '205 rows paged without loss; audit overwrite blocked in client and SQL; invalid second mutation rolls back first');

    const running: Job = { id: 'write-fenced-job', kind: 'generate', status: 'running', attempts: 1, availableAt: new Date().toISOString(), createdAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 120000).toISOString(), payload: {} };
    await put('jobs', running);
    await store.guard('radar_auto_publication', async () => { await assert.rejects(store.guard('radar_auto_publication', async () => {}, running), conflict); await store.transaction(client=>put('settings', { id: 'write-guarded-success' },client)); }, running);
    assert.ok(await one('settings', 'write-guarded-success'));
    await assert.rejects(store.guard('radar_auto_publication', async () => { await pool.query("UPDATE public.radar_cb_leases SET until=now()-interval '1 second' WHERE name='radar_auto_publication'"); await store.transaction(client=>put('settings', { id: 'write-expired-lease' },client)); }, running), conflict);
    assert.equal(await one('settings', 'write-expired-lease'), undefined);
    await pool.query("UPDATE public.radar_jobs SET payload=jsonb_set(payload,'{leaseUntil}',to_jsonb($2::text)) WHERE id=$1", [running.id, new Date(Date.now() - 1000).toISOString()]);
    await assert.rejects(store.guard('radar_auto_publication', async () => { await store.transaction(client=>put('settings', { id: 'write-expired-job' },client)); }, running), conflict);
    assert.equal(await one('settings', 'write-expired-job'), undefined);
    pass('publication_lease_and_job_fence', 'second holder rejected; expired publication/job leases cannot commit; normal guarded write persists');

    // Only this disposable QA database contains these older synthetic jobs.
    await pool.query("UPDATE public.radar_jobs SET payload=(payload-'leaseUntil')||'{\"status\":\"succeeded\"}'::jsonb");
    const source: Source = { id: 'write-worker-source', name: 'CloudBase QA source', kind: 'status', url: 'https://x.com/write_fixture/status/1', enabled: true, validated: true, intervalMinutes: 2, version: 1, status: 'healthy', nextRunAt: '2100-01-01T00:00:00.000Z' };
    await put('sources', source); const site={ id:'site', ...defaultSite, autoPublish: true };await put('settings',site);
    let candidate: Candidate | undefined;
    const input = { sourceId: source.id, messageId: 'write-completion-001', url: 'https://x.com/write_fixture/status/1790000000000000001', text: 'We have reset all usage limits for all accounts.', publishedAt: new Date().toISOString(), collectedAt: new Date().toISOString(), contextComplete: true, historical: false, provenance: 'official' as const, textOrigin: 'original' as const };
    const collection = await transaction(client => queueJob('collect', { sourceId: source.id }, client));
    assert.equal(await runOne({ schedule: false, collect: async () => { const result = await createEvidence(input); candidate = result.candidate; return {seen:1,created:result.created?1:0}; }, enrich: async () => undefined, enrichQuoted: async () => [] }), true);
    assert.equal((await one<Job>('jobs', collection.id))?.status, 'succeeded'); assert.ok(candidate);
    assert.equal((await createEvidence(input)).created, false);
    await transaction(client => queueJob('generate', { candidateId: candidate!.id, expectedVersion: candidate!.version }, client));
    assert.equal(await runOne({ schedule: false, allowTemplates: true, enrich: async () => undefined, enrichQuoted: async () => [] }), true);
    const completed = await one<Candidate>('candidates', candidate.id); assert.equal(completed?.status, 'published'); assert.equal(completed?.content.contentOrigin, 'template');
    const publication = (await list<Publication>('publications')).find(row => row.article.evidenceIds.includes(candidate!.evidenceId)); assert.ok(publication);
    assert.equal(publication.event.actions[0]?.stage, 'claimed_complete');
    const publishedCount = (await list<Publication>('publications')).length;
    await runOne({ schedule: false, enrich: async () => undefined, enrichQuoted: async () => [] }); assert.equal((await list('publications')).length, publishedCount);
    pass('actual_collection_and_template_publication', 'actual worker/domain functions saved original evidence, deduplicated collection and atomically published template/event/article/publication/notice; no external AI or source calls');

    const failing = await transaction(client => queueJob('collect', { sourceId: source.id }, client));
    await runOne({ schedule: false, collect: async () => { throw new Error('synthetic collection failure with no private data'); } });
    assert.equal((await one<Job>('jobs', failing.id))?.status, 'failed'); assert.equal((await one<Source>('sources', source.id))?.status, 'failed');
    assert.ok((await list<{ action: string; objectId: string }>('audits')).some(row => row.action === 'job.failed' && row.objectId === failing.id));
    const human={...completed!,id:'write-human-protected',status:'pending' as const,humanEdited:true,version:3,content:{...completed!.content,title:'Human retained title'}};await put('candidates',human);
    await transaction(client=>queueJob('generate',{candidateId:human.id,expectedVersion:human.version},client));await runOne({schedule:false,allowTemplates:true,enrich:async()=>undefined,enrichQuoted:async()=>[]});
    assert.deepEqual(await one('candidates',human.id),human);assert.equal((await list('publications')).length,publishedCount);
    pass('cloud_worker_human_edit_protection','actual cloud worker refused automatic overwrite/publication of human-edited candidate');
    pass('persistent_collect_failure_audit', 'actual worker persisted failed collection job, source health and immutable failure audit');

    // Fresh synthetic identity and explicit consent; every WeChat endpoint is mocked.
    let time=Date.now();let sends = 0; let failSend = false; const encryptionKey = randomBytes(32);
    const fetcher: typeof fetch = async input => { const url = new URL(String(input)); assert.equal(url.origin, 'https://api.weixin.qq.com'); if (url.pathname.includes('jscode2session')) return Response.json({ openid: 'cloudbase_qa_openid_123456789', session_key: 'fixture-not-persisted' }); if (url.pathname.includes('stable_token')) return Response.json({ access_token: 'cloudbase_qa_access_token_123456789', expires_in: 7200 }); if (url.pathname.includes('subscribe/send')) { sends++; if (failSend) throw new Error('synthetic unknown send'); return Response.json({ errcode: 0 }); } throw new Error('unexpected mocked endpoint'); };
    const wechat = createWechatService({ fetcher, clock:()=>time,encryptionKey: () => encryptionKey, preparePublicPage: async () => {} });
    const config = await wechat.adminWechat(); await wechat.saveWechatSettings({ ...config, appId: 'wx0123456789abcdef', subscriptionsEnabled: true, envVersion: 'trial', templateId: 'cloudbase-qa-template', templateFields: { title: 'thing1', status: 'phrase2', time: 'time3' }, dailyApiLimit: 100, dailySendLimit: 20, secret: 'fixture-not-real' }, 'qa');
    const login = await wechat.wechatLogin('synthetic-code'); const consent = await wechat.wechatSubscriptionChallenge(login.sessionToken); await wechat.confirmWechatSubscription(login.sessionToken, { nonce: consent.nonce!, templateId: consent.templateId!, result: 'accept' });
    const notice = (await list<Notice>('notices')).find(row => row.publicationId === publication.id); assert.ok(notice);
    await wechat.scheduleWechatDeliveries();assert.equal((await list<Job>('jobs')).filter(job=>job.kind==='wechat_send').length,0,'consent must not deliver old notices');
    time+=1000;await insert('notices',{...notice,id:'write-new-consented-notice',semanticKey:randomUUID(),createdAt:new Date(time).toISOString()});
    await wechat.scheduleWechatDeliveries(); await wechat.scheduleWechatDeliveries();
    const jobs = (await list<Job>('jobs')).filter(job => job.kind === 'wechat_send'); assert.equal(jobs.length, 1);
    const sent = await Promise.allSettled([wechat.processWechatJob(jobs[0]), wechat.processWechatJob(jobs[0])]);
    assert.ok(sent.some(result => result.status === 'fulfilled' && result.value.state === 'sent')); assert.equal(sends, 1);
    assert.equal((await wechat.processWechatJob(jobs[0])).state, 'sent'); assert.equal(sends, 1);
    pass('actual_wechat_consent_queue_and_once_send', 'real service logic with mocked provider: login/consent, repeated scheduling and competing dispatch produced one grant, one task and one mock send');
    time+=31000;const challenge = await wechat.wechatSubscriptionChallenge(login.sessionToken); await wechat.confirmWechatSubscription(login.sessionToken, { nonce: challenge.nonce!, templateId: challenge.templateId!, result: 'accept' });
    time+=1000;await insert('notices', { ...notice, id: 'write-unknown-notice', semanticKey: randomUUID(), createdAt: new Date(time).toISOString() });
    await wechat.scheduleWechatDeliveries(); const unknownJob = (await list<Job>('jobs')).find(job => job.kind === 'wechat_send' && job.id !== jobs[0].id); assert.ok(unknownJob);
    failSend = true; assert.equal((await wechat.processWechatJob(unknownJob)).state, 'unknown'); const count = sends;
    assert.equal((await createWechatService({ fetcher, clock:()=>time,encryptionKey: () => encryptionKey, preparePublicPage: async () => {} }).processWechatJob(unknownJob)).state, 'unknown'); assert.equal(sends, count);
    assert.equal((await list<WechatDelivery>('wechat_deliveries')).filter(row => row.status === 'unknown').length, 1);
    pass('wechat_unknown_send_no_replay', 'mock transport loss persists unknown result; restarted service does not resend or invent delivery');

    const forecastBefore = (await pool.query('SELECT id,md5(payload::text) AS hash FROM public.radar_forecast_snapshots ORDER BY id')).rows;
    const cycle = await runForecastCycle(new Date().toISOString(), { force: true }); assert.equal(cycle.status, 'ready');
    for (const row of forecastBefore) assert.equal((await pool.query('SELECT md5(payload::text) AS hash FROM public.radar_forecast_snapshots WHERE id=$1', [row.id])).rows[0].hash, row.hash);
    pass('actual_forecast_write_immutable', 'actual independent observation commits through domain store; pre-existing frozen forecast payloads remain byte-identical');
    await scheduleDue({ allowTemplates: true, allowEnrichment: false });
    pass('actual_scheduler_cloud_store', 'actual collection/candidate scheduler completes through controlled business transactions');
  } finally {
    for (const [name, value] of Object.entries({ RADAR_STORAGE_BACKEND: previous.mode, RADAR_PUBLIC_READ_BACKEND: previous.public, CLOUDBASE_ENV_ID: previous.env, CLOUDBASE_API_KEY: previous.key, ENCRYPTION_KEY: previous.encryption })) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    globalThis.fetch = previous.fetch;
  }
}
