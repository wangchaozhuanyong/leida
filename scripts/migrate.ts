import { pool } from '../src/db';
const tables = ['evidence','candidates','events','articles','publications','sources','jobs','notices','audits','activities','settings'];
const c = await pool.connect();
try {
  await c.query('BEGIN');
  for (const table of tables) await c.query(`CREATE TABLE IF NOT EXISTS radar_${table} (id text PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS radar_evidence_identity ON radar_evidence ((payload->>'sourceId'),(payload->>'messageId'),(payload->>'hash'))`);
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS radar_notice_semantic ON radar_notices ((payload->>'semanticKey'))`);
  await c.query(`CREATE INDEX IF NOT EXISTS radar_job_status ON radar_jobs ((payload->>'status'),(payload->>'availableAt'))`);
  await c.query(`CREATE INDEX IF NOT EXISTS radar_candidate_status ON radar_candidates ((payload->>'status'))`);
  await c.query(`CREATE TABLE IF NOT EXISTS radar_ai_usage (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), model text NOT NULL, input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0, cost numeric NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'reserved')`);
  await c.query(`CREATE OR REPLACE FUNCTION radar_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable record'; END $$`);
  for (const table of ['evidence','publications','audits']) {
    await c.query(`DROP TRIGGER IF EXISTS radar_immutable_guard ON radar_${table}`);
    await c.query(`CREATE TRIGGER radar_immutable_guard BEFORE UPDATE OR DELETE ON radar_${table} FOR EACH ROW EXECUTE FUNCTION radar_immutable()`);
  }
  await c.query('COMMIT');
  console.log('业务数据库迁移完成');
} catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); await pool.end(); }
