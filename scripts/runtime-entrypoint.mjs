import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const containerRuntime = args.includes('--container');
const mode = args.find(arg => arg !== '--container') || 'app';
const environment = { ...process.env };
if (containerRuntime) {
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
    const response = await fetch('http://127.0.0.1:5190/api/v1/version', { signal: AbortSignal.timeout(8000) });
    process.exit(response.ok ? 0 : 1);
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
