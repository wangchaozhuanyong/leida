// Explicit opt-in migration. Never run implicitly from a request or worker.
import { pool } from '../../src/db';
export const WECHAT_MIGRATION_SQL=[
  ...['readers','grants','deliveries'].map(table=>`CREATE TABLE IF NOT EXISTS radar_wechat_${table} (id text PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`),
  `CREATE UNIQUE INDEX IF NOT EXISTS radar_wechat_reader_identity ON radar_wechat_readers ((payload->>'appId'),(payload->>'openidHash'))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS radar_wechat_grant_identity ON radar_wechat_grants ((payload->>'readerId'),(payload->>'templateId'))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS radar_wechat_delivery_identity ON radar_wechat_deliveries ((payload->>'noticeId'),(payload->>'readerId'),(payload->>'templateId'))`,
  `CREATE INDEX IF NOT EXISTS radar_wechat_delivery_status ON radar_wechat_deliveries ((payload->>'status'))`
];
if(process.argv.includes('--apply')) {
  const client=await pool.connect();
  try {await client.query('BEGIN');for(const sql of WECHAT_MIGRATION_SQL)await client.query(sql);await client.query('COMMIT');console.log('微信订阅数据结构迁移完成');}
  catch(error){await client.query('ROLLBACK');throw error;}
  finally {client.release();await pool.end();}
} else console.log('未应用微信迁移；经授权后使用 --apply 明确执行。');
