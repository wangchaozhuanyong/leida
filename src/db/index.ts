import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
const globalDb = globalThis as unknown as { radarPool?: pg.Pool };
export const pool = globalDb.radarPool ?? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 });
if (process.env.NODE_ENV !== 'production') globalDb.radarPool = pool;
export const db = drizzle(pool, { schema });
export type Client = Pick<pg.PoolClient, 'query'>;
export type Table = 'evidence' | 'candidates' | 'events' | 'articles' | 'publications' | 'sources' | 'jobs' | 'notices' | 'audits' | 'activities' | 'settings' | 'wechat_readers' | 'wechat_grants' | 'wechat_deliveries' | 'forecast_cases' | 'forecast_snapshots' | 'forecast_outcomes';
export async function list<T>(table: Table, client: Client = pool): Promise<T[]> { return (await client.query(`SELECT payload FROM radar_${table} ORDER BY created_at DESC, id`)).rows.map(r => r.payload as T); }
export async function one<T>(table: Table, id: string, client: Client = pool, lock = false): Promise<T | undefined> { return (await client.query(`SELECT payload FROM radar_${table} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]?.payload as T | undefined; }
export async function insert<T extends {id:string}>(table: Table, value: T, client: Client = pool): Promise<boolean> { const r = await client.query(`INSERT INTO radar_${table}(id,payload) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [value.id, JSON.stringify(value)]); return !!r.rowCount; }
export async function put<T extends {id:string}>(table: Table, value: T, client: Client = pool): Promise<void> { if (['evidence', 'publications', 'audits', 'forecast_snapshots', 'forecast_outcomes'].includes(table)) throw new Error('不可变记录不能覆盖'); await client.query(`INSERT INTO radar_${table}(id,payload) VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`, [value.id, JSON.stringify(value)]); }
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> { const client = await pool.connect(); try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
