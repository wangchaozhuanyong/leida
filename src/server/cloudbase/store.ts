import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Client, Table } from '../../db';
import type { Job } from '../../lib/types';
import { CloudbaseRpc, CloudbaseRpcError } from './rpc';

const immutable = new Set<Table>(['evidence', 'publications', 'audits', 'forecast_snapshots', 'forecast_outcomes']);
type Row = { id: string; payload: { id: string }; createdAt: string };
type Page = { fingerprint: string; rows: Row[]; more: boolean; after: string | null };
type Change = { table: Table; kind: 'insert' | 'put'; value: { id: string } };
type State = { fingerprint: string; rows: Map<string, Row>; complete: boolean };
type Lease = { name: string; owner: string; until: string; job?: Pick<Job,'id'|'attempts'|'leaseUntil'> };
const clientStates = new WeakMap<Client, CloudbaseTransaction>();
const stores = new WeakMap<CloudbaseRpc, ReturnType<typeof makeStore>>();

/** Private domain working set. No SQL/BEGIN forwarding or simulated pg session. */
class CloudbaseTransaction {
  readonly client: Client = { query: (() => { throw new CloudbaseRpcError('configuration'); }) as Client['query'] };
  readonly states = new Map<Table, State>();
  readonly changes: Change[] = [];
  closed = false;
  constructor(readonly rpc: CloudbaseRpc, readonly lease?: Lease) { clientStates.set(this.client, this); }
  assertOpen() { if (this.closed) throw new CloudbaseRpcError('configuration'); }
  async page(table: Table, after: string | null, id?: string): Promise<Page> {
    this.assertOpen();
    const page = await this.rpc.call<Page>('radar_cb_store_read', { p_table: table, p_after: after, p_id: id ?? null });
    if (!page || !/^[a-f0-9]{32}$/.test(page.fingerprint) || !Array.isArray(page.rows) || typeof page.more !== 'boolean'
      || page.rows.some(row => !row || typeof row.id !== 'string' || row.payload?.id !== row.id || !Number.isFinite(Date.parse(row.createdAt)))
      || (page.more && (typeof page.after !== 'string' || page.after === after))) throw new CloudbaseRpcError('response');
    const previous = this.states.get(table);
    if (previous && previous.fingerprint !== page.fingerprint) throw new CloudbaseRpcError('conflict');
    if (!previous) this.states.set(table, { fingerprint: page.fingerprint, rows: new Map(), complete: false });
    return page;
  }
  async list<T>(table: Table): Promise<T[]> {
    this.assertOpen();
    if (!this.states.get(table)?.complete) {
      const collected: Row[] = []; let after: string | null = null; let bytes = 0;
      do {
        const page = await this.page(table, after);
        collected.push(...page.rows); bytes += Buffer.byteLength(JSON.stringify(page.rows));
        // Explicit capacity guard, never silently drop evidence or frozen outcomes.
        if (collected.length > 20_000 || bytes > 32 * 1024 * 1024) throw new CloudbaseRpcError('configuration');
        after = page.more ? page.after : null;
      } while (after !== null);
      const state = this.states.get(table)!;
      state.rows = new Map(collected.map(row => [row.id, row])); state.complete = true;
      for (const change of this.changes.filter(change => change.table === table)) this.apply(change);
    }
    return [...this.states.get(table)!.rows.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(row => structuredClone(row.payload) as T);
  }
  async one<T>(table: Table, id: string): Promise<T | undefined> {
    this.assertOpen();
    const state = this.states.get(table);
    if (state?.complete || state?.rows.has(id)) return structuredClone(state.rows.get(id)?.payload) as T | undefined;
    const page = await this.page(table, null, id);
    const row = page.rows[0]; if (row) this.states.get(table)!.rows.set(row.id, row);
    return structuredClone(row?.payload) as T | undefined;
  }
  apply(change: Change) {
    const rows = this.states.get(change.table)!.rows;
    rows.set(change.value.id, { id: change.value.id, payload: structuredClone(change.value), createdAt: rows.get(change.value.id)?.createdAt ?? new Date().toISOString() });
  }
  async write(table: Table, value: { id: string }, kind: Change['kind']): Promise<boolean> {
    this.assertOpen();
    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 512) throw new CloudbaseRpcError('configuration');
    if (kind === 'put' && immutable.has(table)) throw new Error('不可变记录不能覆盖');
    const existing = await this.one(table, value.id);
    if (kind === 'insert' && existing) return false;
    if (this.changes.length >= 500) throw new CloudbaseRpcError('configuration');
    const change = { table, kind, value: structuredClone(value) }; this.changes.push(change); this.apply(change); return true;
  }
  async commit() {
    this.assertOpen();
    const expected = Object.fromEntries([...this.states].map(([table, state]) => [table, state.fingerprint]));
    try {
      const result = await this.rpc.call<unknown>('radar_cb_store_commit', { p_expected: expected, p_changes: this.changes, p_lease: this.lease ?? null });
      if (result !== true) throw new CloudbaseRpcError('response');
    } finally { this.closed = true; }
  }
}

export function cloudbaseTransaction(client: Client) { return clientStates.get(client); }
function makeStore(rpc: CloudbaseRpc) {
  const leases = new AsyncLocalStorage<Lease>();
  return {
    async list<T>(table: Table) { const tx = new CloudbaseTransaction(rpc); try { return await tx.list<T>(table); } finally { tx.closed = true; } },
    async one<T>(table: Table, id: string) { const tx = new CloudbaseTransaction(rpc); try { return await tx.one<T>(table, id); } finally { tx.closed = true; } },
    async transaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
      const tx = new CloudbaseTransaction(rpc, leases.getStore());
      try { const result = await fn(tx.client); await tx.commit(); return result; } finally { tx.closed = true; }
    },
    async guard<T>(name: 'radar_auto_publication', fn: () => Promise<T>, job: Job): Promise<T> {
      const owner = randomUUID();
      const lease = await rpc.call<Lease | null>('radar_cb_store_lease', { p_name: name, p_owner: owner, p_release: false });
      if (!lease) throw new CloudbaseRpcError('conflict');
      if (lease.name !== name || lease.owner !== owner || !Number.isFinite(Date.parse(lease.until))) throw new CloudbaseRpcError('response');
      try { return await leases.run({...lease,job:{id:job.id,attempts:job.attempts,leaseUntil:job.leaseUntil}}, fn); }
      finally { await rpc.call('radar_cb_store_lease', { p_name: name, p_owner: owner, p_release: true }); }
    }
  };
}
export function cloudbaseStore(rpc: CloudbaseRpc) { let store = stores.get(rpc); if (!store) { store = makeStore(rpc); stores.set(rpc, store); } return store; }
