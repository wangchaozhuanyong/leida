import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { createNativeDatabaseHealthCheck, nativeDatabaseHealth, type NativeDatabaseHealth } from '../src/server/native-database-health';

const connection = 'postgresql://qa_only:qa_only@127.0.0.1:5432/qa_only';

test('缺失或无效连接配置不会尝试默认数据库或改变后端', async () => {
  let attempts = 0;
  const factory = () => { attempts++; throw new Error('must not connect'); };
  const backend = process.env.RADAR_STORAGE_BACKEND;
  assert.equal((await nativeDatabaseHealth(undefined, factory)).diagnosticCode, 'NATIVE_DB_NOT_CONFIGURED');
  for (const value of ['invalid', 'https://qa_only:qa_only@127.0.0.1/qa_only',
    'postgresql://127.0.0.1/qa_only', 'postgresql://qa_only:qa_only@127.0.0.1/']) {
    assert.equal((await nativeDatabaseHealth(value, factory)).diagnosticCode, 'NATIVE_DB_CONFIG_INVALID');
  }
  assert.equal(attempts, 0);
  assert.equal(process.env.RADAR_STORAGE_BACKEND, backend);
});

test('检测仅执行常量 SELECT，完成后释放连接且不返回凭据或业务行', async () => {
  const canary = randomBytes(24).toString('hex');
  const sql: string[] = [];
  let ended = 0;
  const result = await nativeDatabaseHealth(connection, () => ({
    async connect() {}, async query(text) { sql.push(text); return { rows: [{ ready: 1, private: canary }] }; },
    async end() { ended++; },
  }));
  assert.deepEqual(result, { database: 'ready', probe: 'native-connection-only' });
  assert.deepEqual(sql, ['SELECT 1 AS ready']);
  assert.equal(ended, 1);
  assert.ok(!JSON.stringify(result).includes(canary));
  assert.ok(!JSON.stringify(result).includes(connection));
});

test('连接及查询失败只给出允许的诊断码，不重试、不泄露异常内容', async () => {
  const canary = randomBytes(24).toString('hex');
  const expected = new Map([
    ['28P01', 'NATIVE_DB_AUTH_FAILED'], ['28000', 'NATIVE_DB_ACCESS_DENIED'],
    ['42501', 'NATIVE_DB_ACCESS_DENIED'], ['3D000', 'NATIVE_DB_DATABASE_MISSING'],
    ['53300', 'NATIVE_DB_CONNECTION_LIMIT'], ['ECONNREFUSED', 'NATIVE_DB_UNREACHABLE'],
    ['ETIMEDOUT', 'NATIVE_DB_UNREACHABLE'], [canary, 'NATIVE_DB_CONNECTION_FAILED'],
  ]);
  for (const phase of ['connect', 'query']) for (const [code, diagnostic] of expected) {
    let attempts = 0, ended = 0;
    const fail = () => { throw Object.assign(new Error(connection + canary), { code, detail: canary }); };
    const result = await nativeDatabaseHealth(connection, () => ({
      async connect() { attempts++; if (phase === 'connect') fail(); },
      async query() { fail(); return { rows: [] }; }, async end() { ended++; },
    }));
    assert.equal(result.diagnosticCode, diagnostic);
    assert.equal(attempts, 1);
    assert.equal(ended, 1);
    assert.ok(!JSON.stringify(result).includes(canary));
    assert.ok(!JSON.stringify(result).includes(connection));
  }
});

test('无效查询响应和清理异常不暴露原始连接信息', async () => {
  const result = await nativeDatabaseHealth(connection, () => ({
    async connect() {}, async query() { return { rows: [] }; },
    async end() { throw new Error(connection); },
  }));
  assert.equal(result.diagnosticCode, 'NATIVE_DB_INVALID_RESPONSE');
  assert.ok(!JSON.stringify(result).includes(connection));
});

test('真实 TCP 接受连接但不回应 PostgreSQL 握手时，检测会限时结束', { timeout: 10000 }, async () => {
  const sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const started = Date.now();
  try {
    const result = await nativeDatabaseHealth(`postgresql://qa_only:qa_only@127.0.0.1:${address.port}/qa_only`);
    assert.equal(result.database, 'unavailable');
    assert.ok(Date.now() - started < 9000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('并发检测合并连接，短期复用结果，配置改变时不复用旧目标结果', async () => {
  let now = 0, attempts = 0;
  let finish!: (result: NativeDatabaseHealth) => void;
  const check = createNativeDatabaseHealthCheck(async () => {
    attempts++;
    return new Promise<NativeDatabaseHealth>(resolve => { finish = resolve; });
  }, () => now);
  const ready: NativeDatabaseHealth = { database: 'ready', probe: 'native-connection-only' };
  const first = check(connection), second = check(connection);
  assert.equal(attempts, 1);
  finish(ready);
  assert.deepEqual(await first, ready);
  assert.deepEqual(await second, ready);
  assert.deepEqual(await check(connection), ready);
  assert.equal(attempts, 1);
  now = 10_000;
  const expired = check(connection);
  assert.equal(attempts, 2);
  finish(ready);
  await expired;
  const changed = check(undefined);
  assert.equal(attempts, 3);
  finish({ database: 'unavailable', probe: 'native-connection-only', diagnosticCode: 'NATIVE_DB_NOT_CONFIGURED' });
  assert.equal((await changed).database, 'unavailable');
});
