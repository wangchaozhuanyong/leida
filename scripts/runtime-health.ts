import { pool } from '../src/db';
import {workerRuntimeStatus} from '../src/lib/automation';

const quiet = process.argv.includes('--quiet');
const workerOnly = process.argv.includes('--worker');
try {
  await pool.query('SELECT 1');
  const row = (await pool.query("SELECT payload FROM radar_settings WHERE id='worker_runtime'")).rows[0];
  const forecast = (await pool.query("SELECT payload->>'status' AS status FROM radar_settings WHERE id='forecast_runtime'")).rows[0];
  const heartbeatAt = typeof row?.payload?.heartbeatAt === 'string' ? row.payload.heartbeatAt : undefined;
  const error=forecast?.status==='error'?'预测观察暂时异常，新闻任务继续运行':row?.payload?.error;
  const status = workerRuntimeStatus({heartbeatAt,error});
  const counts = (await pool.query("SELECT payload->>'status' AS status,count(*)::int AS count FROM radar_jobs WHERE payload->>'status' IN ('queued','running') GROUP BY payload->>'status'")).rows;
  const backlog = { queued: 0, running: 0 };
  for (const row of counts) if (row.status === 'queued' || row.status === 'running') backlog[row.status as keyof typeof backlog] = row.count;
  if (!quiet) console.log(JSON.stringify({ database: 'ready', worker: { status, heartbeatAt,...(error?{error:'后台处理暂时异常，正在自动恢复'}:{}) }, backlog, checkedAt: new Date().toISOString() }));
  if (workerOnly && status !== 'healthy') process.exitCode = 1;
} catch {
  // Connection errors can contain credentials. Only emit the fixed operational status.
  if (!quiet) console.log(JSON.stringify({ database: 'unavailable', worker: { status: 'unobserved' }, checkedAt: new Date().toISOString() }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
