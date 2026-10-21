import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.RADAR_STORAGE_BACKEND = 'cloudbase';
process.env.RADAR_PUBLIC_READ_BACKEND = 'cloudbase';
process.env.CLOUDBASE_ENV_ID = 'leida-test-qa';
process.env.CLOUDBASE_API_KEY = randomBytes(32).toString('hex');
process.env.BETTER_AUTH_SECRET = randomBytes(40).toString('hex');
delete process.env.DATABASE_URL;
const { GET } = await import('../src/app/api/v1/[...path]/route');

test('CloudBase 不可用时，显式健康检测可单独报告新库配置且不调用 CloudBase', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('must not call CloudBase'); });
  const response = await GET(new Request('http://127.0.0.1/api/v1/health?probe=native'), { params: Promise.resolve({ path: ['health'] }) });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { data: {
    database: 'unavailable', probe: 'native-connection-only', diagnosticCode: 'NATIVE_DB_NOT_CONFIGURED',
  } });
  assert.equal(calls, 0);
  assert.equal(process.env.RADAR_STORAGE_BACKEND, 'cloudbase');
  assert.equal(process.env.RADAR_PUBLIC_READ_BACKEND, 'cloudbase');
});

test('公开检测不接受自定义目标、SQL、未知模式或重复参数', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('must not connect'); });
  for (const query of ['probe=native&target=http://qa.invalid', 'probe=native&sql=UPDATE',
    'probe=unknown', 'probe=native&probe=native']) {
    const response = await GET(new Request('http://127.0.0.1/api/v1/health?' + query), { params: Promise.resolve({ path: ['health'] }) });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});
