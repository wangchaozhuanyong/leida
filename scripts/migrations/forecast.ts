// Preview unless --apply is explicitly supplied. Only adds prediction observations.
import {pathToFileURL} from 'node:url';
import {pool,type Client} from '../../src/db';
export const FORECAST_MIGRATION_SQL=[
 ...['cases','snapshots','outcomes'].map(table=>`CREATE TABLE IF NOT EXISTS radar_forecast_${table} (id text PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`),
 `CREATE UNIQUE INDEX IF NOT EXISTS radar_forecast_case_identity ON radar_forecast_cases ((payload->>'identity'),(payload->>'target'))`,
 `CREATE UNIQUE INDEX IF NOT EXISTS radar_forecast_snapshot_signature ON radar_forecast_snapshots ((payload->>'signature'))`,
 `CREATE UNIQUE INDEX IF NOT EXISTS radar_forecast_outcome_signature ON radar_forecast_outcomes ((payload->>'signature'))`,
 `CREATE INDEX IF NOT EXISTS radar_forecast_case_status ON radar_forecast_cases ((payload->>'status'))`,
 `CREATE OR REPLACE FUNCTION radar_forecast_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable forecast record'; END $$`,
 ...['snapshots','outcomes'].map(table=>`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='radar_forecast_${table}'::regclass AND tgname='radar_forecast_immutable_guard') THEN CREATE TRIGGER radar_forecast_immutable_guard BEFORE UPDATE OR DELETE ON radar_forecast_${table} FOR EACH ROW EXECUTE FUNCTION radar_forecast_immutable(); END IF; END $$`),
];
export async function applyForecastMigration(client:Client):Promise<void> {for(const sql of FORECAST_MIGRATION_SQL)await client.query(sql);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.includes('--apply')){
  const client=await pool.connect();
  try {await client.query('BEGIN');await applyForecastMigration(client);await client.query('COMMIT');console.log('预测观察数据结构迁移完成');}
  catch(error){await client.query('ROLLBACK');throw error;}
  finally {client.release();await pool.end();}
 }else console.log('未应用预测迁移；经授权后使用 --apply 明确执行。');
}
