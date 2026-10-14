import type { BetterAuthOptions } from 'better-auth';
import type { DBAdapter, DBAdapterInstance } from 'better-auth/adapters';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { getAuthTables } from 'better-auth/db';
import { CloudbaseRpc, CloudbaseRpcError } from './rpc';

const models = ['user', 'account', 'session', 'verification'] as const;
type Model = typeof models[number];
type Row = Record<string, unknown> & { id: string };
type State = Record<Model, Row[]>;
interface Snapshot { fingerprint: string; records: State; }
interface Change { model: Model; kind: 'insert' | 'update' | 'delete'; id: string; data?: Row; }
const reads = new Set(['findOne', 'findMany', 'count']);
const writes = new Set(['create', 'update', 'updateMany', 'delete', 'deleteMany', 'consumeOne', 'incrementOne']);
const queues = new WeakMap<CloudbaseRpc, Promise<void>>();
async function exclusive<T>(rpc: CloudbaseRpc, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(rpc) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  queues.set(rpc, current);
  await previous;
  try { return await fn(); } finally { release(); if (queues.get(rpc) === current) queues.delete(rpc); }
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function changes(before: State, after: State): Change[] {
  const result: Change[] = [];
  // Child removals precede parent removals; parent creates precede child creates.
  for (const model of ['session', 'account', 'verification', 'user'] as const) {
    const existing = new Set(after[model].map(row => row.id));
    for (const row of before[model]) if (!existing.has(row.id)) result.push({ model, kind: 'delete', id: row.id });
  }
  for (const model of models) {
    const original = new Map(before[model].map(row => [row.id, row]));
    for (const row of after[model]) {
      const old = original.get(row.id);
      if (!old || canonical(old) !== canonical(row)) result.push({ model, kind: old ? 'update' : 'insert', id: row.id, data: row });
    }
  }
  return result;
}
function validateSnapshot(value: unknown): asserts value is Snapshot {
  if (!value || typeof value !== 'object' || !('fingerprint' in value) || !('records' in value) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{32}$/.test(value.fingerprint) || !value.records || typeof value.records !== 'object') throw new CloudbaseRpcError('response');
  for (const model of models) {
    const rows = (value.records as Record<string, unknown>)[model];
    if (!Array.isArray(rows) || rows.length > 1000 || rows.some(row => !row || typeof row !== 'object' || typeof row.id !== 'string')) throw new CloudbaseRpcError('response');
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new CloudbaseRpcError('response');
  }
}

/**
 * Use BetterAuth's existing query/mapping engine only on a private working copy.
 * Durability and concurrency are provided by PostgreSQL's guarded atomic commit,
 * never by the development adapter's in-memory last-writer-wins merge.
 */
export function cloudbaseAuthAdapter(rpc: CloudbaseRpc, guards: { ownerBootstrap?: boolean } = {}): DBAdapterInstance {
  return (options: BetterAuthOptions): DBAdapter => {
    const schema = getAuthTables(options);
    if (options.advanced?.database?.generateId === 'serial' || Object.keys(schema).some(model => !(models as readonly string[]).includes(model)) || models.some(model => schema[model]?.modelName !== model)) throw new CloudbaseRpcError('configuration');
    const empty: State = { user: [], account: [], session: [], verification: [] };
    const template = memoryAdapter(empty, { debugLogs: false })(options);
    const run = <T>(fn: (adapter: DBAdapter) => Promise<T>, writable: boolean): Promise<T> => exclusive(rpc, async () => {
      const snapshot: unknown = await rpc.call('radar_cb_auth_snapshot');
      validateSnapshot(snapshot);
      const working = structuredClone(snapshot.records);
      const dates = new Map<number, Date>();
      const intern = (value: Date): Date => {
        const time = value.getTime();
        if (!Number.isFinite(time)) throw new CloudbaseRpcError('response');
        const date = dates.get(time) ?? new Date(time); dates.set(time, date); return date;
      };
      // The official query engine compares Date values for expiry and sorting.
      for (const model of models) for (const row of working[model]) for (const [field, attr] of Object.entries(schema[model].fields)) {
        const name = attr.fieldName ?? field;
        if (attr.type === 'date' && row[name] != null) {
          const date = new Date(String(row[name]));
          if (!Number.isFinite(date.getTime())) throw new CloudbaseRpcError('response');
          row[name] = intern(date);
        }
      }
      const before = structuredClone(working);
      const local = memoryAdapter(working, { debugLogs: false })(options);
      // The existing development query engine uses identity for Date equality.
      // Intern timestamps inside this private frame, and detach returned rows.
      const frame: DBAdapter = new Proxy(local, { get(target, key, receiver) {
        if (key === 'transaction') return async <R>(callback: (adapter: DBAdapter) => Promise<R>) => {
          const savepoint = structuredClone(working);
          try { return await callback(frame); } catch (error) { for (const model of models) working[model] = savepoint[model]; throw error; }
        };
        if (typeof key === 'string' && (reads.has(key) || writes.has(key))) return async (input: Record<string, unknown>) => {
          for (const model of models) for (const row of working[model]) for (const [name, attr] of Object.entries(schema[model].fields)) {
            const field = attr.fieldName ?? name;
            if (attr.type === 'date' && row[field] instanceof Date) row[field] = intern(row[field] as Date);
          }
          if(guards.ownerBootstrap&&key==='create'&&input.model==='user'&&working.user.length>0)throw Object.assign(new Error('站长账号已建立，请登录'),{status:409});
          const args = { ...input };
          if (Array.isArray(input.where)) args.where = input.where.map(clause => ({ ...clause, value: clause.value instanceof Date ? intern(clause.value) : clause.value }));
          return structuredClone(await Reflect.apply(Reflect.get(target, key), target, [args]));
        };
        return Reflect.get(target, key, receiver);
      } });
      const result = await fn(frame);
      for (const model of models) {
        if (working[model].some(row => typeof row.id !== 'string' || !row.id) || new Set(working[model].map(row => row.id)).size !== working[model].length) throw new CloudbaseRpcError('conflict');
      }
      const delta = changes(before, working);
      if (delta.length) {
        if (!writable) throw new CloudbaseRpcError('configuration');
        const committed = await rpc.call<unknown>('radar_cb_auth_commit', { p_expected_fingerprint: snapshot.fingerprint, p_changes: delta });
        if (committed !== true) throw new CloudbaseRpcError('response');
      }
      return result;
    });
    return new Proxy(template, {
      get(target, key, receiver) {
        if (key === 'id') return 'radar-cloudbase-postgresql';
        if (key === 'transaction') return <T>(callback: (adapter: DBAdapter) => Promise<T>) => run(callback, true);
        if (typeof key === 'string' && (reads.has(key) || writes.has(key))) return (...args: unknown[]) => run(async adapter => {
          const method = Reflect.get(adapter, key);
          if (typeof method !== 'function') throw new CloudbaseRpcError('configuration');
          return Reflect.apply(method, adapter, args) as unknown;
        }, writes.has(key));
        return Reflect.get(target, key, receiver);
      }
    });
  };
}
