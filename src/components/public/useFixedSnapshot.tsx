'use client';

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { usePublicContentVersion } from './PublicSession';

type FixedValue = { id: string };
type FixedState = { value?: FixedValue; error: string; loading: boolean; unavailable: boolean; checkedVersion?: string | null };
const empty: FixedState = { error: '', loading: false, unavailable: false };
export class FixedSnapshotCache {
  private entries = new Map<string, FixedState>();
  private requests = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private listeners = new Set<() => void>();
  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (key: string | null) => key ? this.entries.get(key) ?? empty : empty;
  private put(key: string, state: FixedState) { this.entries.set(key, state); this.listeners.forEach(listener => listener()); }
  load(key: string, id: string, version: string | null, force = false): Promise<void> {
    const pending = this.requests.get(key);
    if (pending) return pending.promise;
    const old = this.get(key);
    if (!force && (old.value || old.unavailable) && old.checkedVersion === version) return Promise.resolve();
    const controller = new AbortController();
    this.put(key, { ...old, loading: true });
    const current = () => !controller.signal.aborted && this.requests.get(key)?.controller === controller;
    // Register the request before invoking fetch, including implementations that throw synchronously.
    const promise = Promise.resolve().then(async () => {
      try {
        if (!current()) return;
        const response = await this.fetcher(key, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (!current()) return;
        if (response.status === 404 || response.status === 410) {
          this.put(key, { error: '这条历史记录已不可用。', loading: false, unavailable: true, checkedVersion: version });
          return;
        }
        const body = await response.json();
        if (!response.ok || body.data?.id !== id) throw new Error('这条历史记录暂时无法加载，请重试。');
        if (current()) this.put(key, { value: body.data as FixedValue, error: '', loading: false, unavailable: false, checkedVersion: version });
      } catch {
        if (current()) this.put(key, { ...this.get(key), error: this.get(key).error || '这条历史记录暂时无法加载，请重试。', loading: false });
      } finally {
        if (this.requests.get(key)?.controller === controller) this.requests.delete(key);
      }
    });
    this.requests.set(key, { controller, promise });
    return promise;
  }
  stop() { for (const [key, request] of this.requests) { request.controller.abort(); this.put(key, { ...this.get(key), loading: false }); } this.requests.clear(); }
}
const Context = createContext<FixedSnapshotCache | null>(null);
export function FixedSnapshotProvider({ children }: { children: React.ReactNode }) {
  const [cache] = useState(() => new FixedSnapshotCache());
  useEffect(() => () => cache.stop(), [cache]);
  return <Context.Provider value={cache}>{children}</Context.Provider>;
}
export function useFixedSnapshot<T extends FixedValue>(endpoint: string | null, id: string | null) {
  const shared = useContext(Context);
  const [local] = useState(() => new FixedSnapshotCache());
  const cache = shared ?? local;
  const version = usePublicContentVersion();
  const get = useCallback(() => cache.get(endpoint), [cache, endpoint]);
  const state = useSyncExternalStore(cache.subscribe, get, () => empty);
  useEffect(() => { if (endpoint && id) void cache.load(endpoint, id, version); }, [cache, endpoint, id, version, state.checkedVersion]);
  useEffect(() => () => { if (!shared) local.stop(); }, [local, shared]);
  return { value: state.value as T | undefined, error: state.error, loading: state.loading, unavailable: state.unavailable, retry: () => { if (endpoint && id) void cache.load(endpoint, id, version, true); } };
}
