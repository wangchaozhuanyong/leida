/** Public GET results only. Rejected work is never retained; concurrent misses share one read. */
export function createPublicCache(ttlMs = 10_000, maxEntries = 128, now = Date.now) {
  const entries = new Map<string, { until: number; pending: Promise<unknown> }>();
  return async function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const old = entries.get(key);
    if (old && old.until > now()) return old.pending as Promise<T>;
    if (entries.size >= maxEntries) {
      for (const [id, entry] of entries) if (entry.until <= now()) entries.delete(id);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
    }
    const entry = { until: Infinity, pending: Promise.resolve().then(read) as Promise<unknown> };
    entries.set(key, entry);
    entry.pending.then(() => { entry.until = now() + ttlMs; }, () => { if (entries.get(key) === entry) entries.delete(key); });
    return entry.pending as Promise<T>;
  };
}
export const publicCached = createPublicCache();
