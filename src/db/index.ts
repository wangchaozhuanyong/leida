import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { configuredStorageRpc } from '../server/cloudbase/storage-config';
import { cloudbaseStore, cloudbaseTransaction } from '../server/cloudbase/store';
import type { Job } from '../lib/types';
const globalDb = globalThis as unknown as { radarPool?: pg.Pool };
export const pool = globalDb.radarPool ?? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 });
if (process.env.NODE_ENV !== 'production') globalDb.radarPool = pool;
export const db = drizzle(pool, { schema });
export type Client = Pick<pg.PoolClient, 'query'>;
export type Table = 'evidence' | 'candidates' | 'events' | 'articles' | 'publications' | 'sources' | 'jobs' | 'notices' | 'audits' | 'activities' | 'settings' | 'wechat_readers' | 'wechat_grants' | 'wechat_deliveries' | 'forecast_cases' | 'forecast_snapshots' | 'forecast_outcomes';
export function isCloudbaseClient(client: Client = pool): boolean { return !!cloudbaseTransaction(client) || client === pool && !!configuredStorageRpc(); }
export async function list<T>(table: Table, client: Client = pool): Promise<T[]> {
  const tx = cloudbaseTransaction(client); if (tx) return tx.list<T>(table);
  const rpc = client === pool ? configuredStorageRpc() : undefined; if (rpc) return cloudbaseStore(rpc).list<T>(table);
  return (await client.query(`SELECT payload FROM radar_${table} ORDER BY created_at DESC, id`)).rows.map(r => r.payload as T);
}
export async function one<T>(table: Table, id: string, client: Client = pool, lock = false): Promise<T | undefined> {
  const tx = cloudbaseTransaction(client); if (tx) return tx.one<T>(table, id);
  const rpc = client === pool ? configuredStorageRpc() : undefined; if (rpc) return cloudbaseStore(rpc).one<T>(table, id);
  return (await client.query(`SELECT payload FROM radar_${table} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]?.payload as T | undefined;
}
export async function insert<T extends {id:string}>(table: Table, value: T, client: Client = pool): Promise<boolean> {
  const tx = cloudbaseTransaction(client); if (tx) return tx.write(table, value, 'insert');
  const rpc = client === pool ? configuredStorageRpc() : undefined; if (rpc) return cloudbaseStore(rpc).transaction(c => insert(table, value, c));
  const r = await client.query(`INSERT INTO radar_${table}(id,payload) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [value.id, JSON.stringify(value)]); return !!r.rowCount;
}
export async function put<T extends {id:string}>(table: Table, value: T, client: Client = pool): Promise<void> {
  if (['evidence', 'publications', 'audits', 'forecast_snapshots', 'forecast_outcomes'].includes(table)) throw new Error('不可变记录不能覆盖');
  const tx = cloudbaseTransaction(client); if (tx) { await tx.write(table, value, 'put'); return; }
  const rpc = client === pool ? configuredStorageRpc() : undefined; if (rpc) return cloudbaseStore(rpc).transaction(c => put(table, value, c));
  await client.query(`INSERT INTO radar_${table}(id,payload) VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`, [value.id, JSON.stringify(value)]);
}
export async function transaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const rpc = configuredStorageRpc(); if (rpc) return cloudbaseStore(rpc).transaction(fn);
  const client = await pool.connect(); try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
/** Cloud transactions serialize their complete read set at commit, including phantoms. */
export async function lockTransaction(client: Client, name: string): Promise<void> {
  const tx = cloudbaseTransaction(client); if (tx) { tx.assertOpen(); return; }
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [name]);
}
export async function repeatableRead(client: Client): Promise<void> {
  const tx = cloudbaseTransaction(client); if (tx) { tx.assertOpen(); return; }
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
}
export async function withAutoPublicationGuard<T>(fn: () => Promise<T>, job: Job): Promise<T> {
  const rpc = configuredStorageRpc(); if (rpc) return cloudbaseStore(rpc).guard('radar_auto_publication', fn, job);
  const guard = await pool.connect(); try { await guard.query("SELECT pg_advisory_lock(hashtext('radar_auto_publication'))"); return await fn(); }
  finally { try { await guard.query("SELECT pg_advisory_unlock(hashtext('radar_auto_publication'))"); } finally { guard.release(); } }
}
