import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { CloudbaseRpc, CloudbaseRpcError } from '../src/server/cloudbase/rpc';
import { cloudbaseAIUsage } from '../src/server/cloudbase/ai-usage';
import { one, put } from '../src/db';
import { accountCompletionResponse, publicAI, defaultAI, AIServiceError } from '../src/server/ai';
import { createAuth, hasOwner } from '../src/server/auth';

type Pass = (name: string, detail: string) => void;
export async function testCloudbaseComplete(pool: pg.Pool, rpc: CloudbaseRpc, anonymous: CloudbaseRpc, pass: Pass, transport: typeof fetch, token: string) {
  await pool.query(await readFile(new URL('./migrations/cloudbase-accounting.sql', import.meta.url), 'utf8'));
  const previous = { mode: process.env.RADAR_STORAGE_BACKEND, public: process.env.RADAR_PUBLIC_READ_BACKEND, env: process.env.CLOUDBASE_ENV_ID, key: process.env.CLOUDBASE_API_KEY, fetch: globalThis.fetch };
  globalThis.fetch = ((input, init) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).hostname.endsWith('.api.tcloudbasegateway.com') ? transport(input, init) : previous.fetch(input, init)) as typeof fetch;
  Object.assign(process.env, { RADAR_STORAGE_BACKEND: 'cloudbase', RADAR_PUBLIC_READ_BACKEND: 'cloudbase', CLOUDBASE_ENV_ID: 'leida-test-qa', CLOUDBASE_API_KEY: token });
  const beforeAI = await one('settings', 'ai');
  try {
    const permissions = (await pool.query("SELECT has_table_privilege('service_role','public.radar_ai_usage','INSERT,UPDATE,DELETE,TRUNCATE') AS writes,has_table_privilege('anon','public.radar_ai_usage','SELECT,INSERT,UPDATE,DELETE') AS anon,has_table_privilege('authenticated','public.radar_ai_usage','SELECT,INSERT,UPDATE,DELETE') AS client")).rows[0];
    assert.deepEqual(permissions, { writes: false, anon: false, client: false });
    for (const operation of ['radar_cb_owner_exists', 'radar_cb_ai_summary', 'radar_cb_ai_reserve', 'radar_cb_ai_finish'] as const) await assert.rejects(anonymous.call(operation), error => error instanceof CloudbaseRpcError && error.status === 403);
    assert.equal(await hasOwner(), true);
    const ownerCount = (await pool.query('SELECT count(*)::int AS count FROM public."user"')).rows[0].count;
    await assert.rejects(createAuth(true).api.signUpEmail({ body: { email: 'blocked-second-owner@radar.invalid', name: 'QA blocked', password: randomBytes(24).toString('base64url') } }));
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM public."user"')).rows[0].count, ownerCount);
    pass('cloud_global_auth_owner_and_closed_bootstrap', 'default createAuth/hasOwner use cloud RPC; guarded bootstrap rejects another administrator; accounting table/direct frontend access denied');

    const ledger = cloudbaseAIUsage(rpc);
    const config = { ...defaultAI, enabled: false, model: 'accounting-fixture-no-provider', version: 910, dailyCallLimit: 3, dailyBudget: 1, inputPrice: 1, outputPrice: 1 };
    await put('settings', config);
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => ledger.reserve(`usage-qa-${index}`, config.version, 10000)));
    const reserved = results.flatMap((result, index) => result === 'reserved' ? [`usage-qa-${index}`] : []);
    assert.equal(reserved.length, 3); assert.equal(results.filter(result => result === 'budget').length, 27);
    const summary = await ledger.summary(); assert.equal(summary.calls, 3); assert.ok(Math.abs(summary.cost - 3 * 0.0118) < 1e-12);
    pass('cloud_ai_cross_worker_budget', '30 simultaneous reservations respect the existing daily limit: exactly 3 accepted and 27 blocked, no provider request');
    await put('settings', { ...config, version: 911, dailyCallLimit: 100, inputPrice: 99, outputPrice: 99 });
    assert.equal(await ledger.reserve('usage-stale-version', config.version, 1), 'configuration');
    await assert.rejects(accountCompletionResponse({ choices: [{ finish_reason: 'length', message: { content: '{}' } }], usage: { prompt_tokens: 130, completion_tokens: 10 } }, reserved[0], config, 10000), AIServiceError);
    const row = (await pool.query('SELECT status,cost::float AS cost,input_tokens,output_tokens FROM public.radar_ai_usage WHERE id=$1', [reserved[0]])).rows[0];
    assert.deepEqual(row, { status: 'succeeded', cost: 0.00014, input_tokens: 130, output_tokens: 10 });
    await ledger.finish(reserved[0], 'failed'); await ledger.finish(reserved[0], 'succeeded', 999, 999);
    assert.deepEqual((await pool.query('SELECT status,cost::float AS cost,input_tokens,output_tokens FROM public.radar_ai_usage WHERE id=$1', [reserved[0]])).rows[0], row);
    pass('cloud_ai_prices_and_billed_invalid_response', 'reservation-time prices retained after configuration changes; truncated output accounted before rejection; duplicate/failure completion cannot overwrite settled accounting');

    assert.equal(await accountCompletionResponse({ choices: [{ message: { content: '{"ok":true}' } }] }, reserved[1], config, 10000), '{"ok":true}');
    await ledger.finish(reserved[2], 'failed');
    const states = (await pool.query('SELECT status,cost::float AS cost FROM public.radar_ai_usage ORDER BY id')).rows;
    assert.ok(states.some(row => row.status === 'estimated' && row.cost === 0.0118)); assert.ok(states.some(row => row.status === 'failed' && row.cost === 0.0118));
    await assert.rejects(ledger.finish('missing-usage', 'failed'), CloudbaseRpcError);
    const publicSettings = await publicAI(); assert.equal(publicSettings.callsToday, 3); assert.ok(Math.abs(publicSettings.estimatedCostToday! - 0.02374) < 1e-12);
    pass('cloud_ai_estimate_failure_and_admin_summary', 'missing token usage stays estimated; failed request keeps conservative reserved cost; admin totals read cloud ledger and missing record rejects');

    await pool.query("UPDATE public.radar_ai_usage SET created_at=(date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')-interval '1 second' WHERE id=$1", [reserved[2]]);
    assert.equal((await ledger.summary()).calls, 2);
    const tight = { ...config, version: 912, dailyCallLimit: 100, dailyBudget: 0.001 }; await put('settings', tight);
    assert.equal(await ledger.reserve('usage-budget-blocked', tight.version, 100), 'budget');
    const zero = { ...tight, version: 913, dailyBudget: 0 }; await put('settings', zero); assert.equal(await ledger.reserve('usage-disabled-limits', zero.version, 100), 'configuration');
    pass('cloud_ai_beijing_day_and_money_limit', 'previous Beijing day excluded from current totals; money limit and disabled ceilings block new reservations');

    const unknownConfig = { ...config, version: 914, dailyCallLimit: 100 }; await put('settings', unknownConfig);
    let reservations = 0; const unknownRPC = new CloudbaseRpc('leida-test-qa', token, async (input, init) => { const response = await transport(input, init); if (String(input).endsWith('/radar_cb_ai_reserve')) { reservations++; throw new Error('intentional lost reservation acknowledgement'); } return response; });
    await assert.rejects(cloudbaseAIUsage(unknownRPC).reserve('usage-unknown-ack', unknownConfig.version, 1000), error => error instanceof CloudbaseRpcError && error.kind === 'unknown');
    assert.equal(reservations, 1); assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.radar_ai_usage WHERE id='usage-unknown-ack'")).rows[0].count, 1);
    pass('cloud_ai_unknown_reservation_not_retried', 'lost acknowledgement after commit yields unknown, exactly one reservation persists and no provider is called');
  } finally {
    if (beforeAI) await put('settings', beforeAI as { id: string });
    for (const [name, value] of Object.entries({ RADAR_STORAGE_BACKEND: previous.mode, RADAR_PUBLIC_READ_BACKEND: previous.public, CLOUDBASE_ENV_ID: previous.env, CLOUDBASE_API_KEY: previous.key })) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    globalThis.fetch = previous.fetch;
  }
}
