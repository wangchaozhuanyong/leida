import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const containerRuntime = args.includes('--container');
const mode = args.find(arg => arg !== '--container') || 'app';
const environment = { ...process.env };
const storageMode=environment.RADAR_STORAGE_BACKEND||'native';
if(!['native','cloudbase'].includes(storageMode)){console.error('数据库模式无效。');process.exit(1);}
if (containerRuntime && storageMode === 'native') {
  try {
    // Preserve URL-encoded credentials. This conversion is only enabled by the Docker entrypoint.
    const database = new URL(environment.DATABASE_URL || '');
    if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('Unsupported database');
    database.hostname = 'database';
    database.port = '5432';
    environment.DATABASE_URL = database.href;
  } catch {
    console.error('运行配置不完整，请检查数据库设置。');
    process.exit(1);
  }
}

if (mode === 'health-app') {
  try {
    const port = environment.PORT || '5190';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) process.exit(1);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/version?light=1`, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) process.exit(1);
    const payload = await response.json();
    process.exit(typeof payload?.data?.version === 'string' && payload.data.version.trim() ? 0 : 1);
  } catch { process.exit(1); }
}

const commands = {
  app: ['.next/standalone/server.js'],
  worker: ['--import', 'tsx', 'scripts/worker.ts'],
  'health-worker': ['--import', 'tsx', 'scripts/runtime-health.ts', '--worker', '--quiet'],
};
if (!Object.hasOwn(commands, mode)) {
  console.error('未知运行模式。');
  process.exit(1);
}
const child = spawn(process.execPath, commands[mode], { env: environment, stdio: 'inherit' });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping = true;
  child.kill(signal);
});
child.on('error', () => {
  console.error('运行进程未能启动。');
  process.exit(1);
});
child.on('exit', (code, signal) => { process.exit(code ?? (stopping && signal ? 0 : 1)); });
