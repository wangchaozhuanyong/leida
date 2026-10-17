import {createHash} from 'node:crypto';
import type {PublicData} from '../lib/types';
import type {PublicReadEnvelope} from '../lib/public-read';
import {activeResetWatch, resetWatchRevision, resetWatchTime, validResetWatch, type ResetWatch} from '../lib/reset-watch';

export const RESET_WATCH_ENDPOINT = 'https://codex-resets.com/api/v1/status';
export const RESET_WATCH_CACHE_MS = 5 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_AGE_MS = 15 * 60_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Only the documented public watch fields cross this boundary; probability is deliberately omitted. */
export function parseResetWatchResponse(value: unknown, checkedAt: string): ResetWatch {
  const current = resetWatchTime(checkedAt);
  if (!record(value) || !record(value.data) || !record(value.meta) || value.meta.api_version !== 'v1' || !Number.isFinite(current)) throw new Error('Invalid reset watch response');
  const generated = resetWatchTime(value.meta.generated_at);
  if (!Number.isFinite(generated) || generated > current || current - generated > MAX_RESPONSE_AGE_MS) throw new Error('Stale reset watch response');
  if (!Object.prototype.hasOwnProperty.call(value.data, 'active_watch') || !Object.prototype.hasOwnProperty.call(value.data, 'latest_reset') || !Object.prototype.hasOwnProperty.call(value.data, 'scheduled_reset')) throw new Error('Missing reset status fields');
  const watch = value.data.active_watch;
  if (watch === null) return {status: 'none', checkedAt};
  if (!record(watch) || !record(watch.source) || watch.source.type !== 'x_post' || watch.source.author !== 'thsottiaux'
    || watch.reset_chance_percent !== null && (typeof watch.reset_chance_percent !== 'number' || !Number.isInteger(watch.reset_chance_percent) || watch.reset_chance_percent < 0 || watch.reset_chance_percent > 100)) throw new Error('Invalid reset watch source');
  const result = {status: 'active', checkedAt, signal: {
    sourceUrl: watch.source.url, text: watch.text, level: watch.level,
    observedAt: watch.observed_at, expiresAt: watch.expires_at, forecastWindow: watch.forecast_window,
  }};
  if (!validResetWatch(result) || resetWatchTime(result.signal!.observedAt) > generated) throw new Error('Invalid reset watch signal');
  const latest = value.data.latest_reset;
  if (latest !== null && (!record(latest) || !Number.isFinite(resetWatchTime(latest.announced_at)) || resetWatchTime(latest.announced_at) > generated)) throw new Error('Invalid latest reset');
  const resolvedAt = record(latest) ? latest.announced_at as string : undefined;
  // A published reset supersedes earlier speculation. Expiry cannot become a completion.
  if (!activeResetWatch(result, checkedAt, resolvedAt) || value.data.scheduled_reset !== null) return {status: 'none', checkedAt};
  return result;
}

interface ReaderOptions { fetcher?: typeof fetch; now?: () => number; ttlMs?: number; timeoutMs?: number; }
export function createResetWatchReader({fetcher = fetch, now = Date.now, ttlMs = RESET_WATCH_CACHE_MS, timeoutMs = 1500}: ReaderOptions = {}) {
  let cached: ResetWatch | undefined, validUntil = 0, pending: Promise<ResetWatch> | undefined;
  return async function read(): Promise<ResetWatch> {
    const current = now();
    if (!pending && (!cached || current >= validUntil)) {
      pending = (async () => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {controller.abort(); reject(new Error('Reset watch timeout'));}, timeoutMs); });
        try {
          const result = await Promise.race([deadline, (async () => {
            const response = await fetcher(RESET_WATCH_ENDPOINT, {headers: {Accept: 'application/json'}, cache: 'no-store', redirect: 'error', signal: controller.signal});
            if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Reset watch unavailable');
            const length = Number(response.headers.get('content-length'));
            if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error('Reset watch response too large');
            if (!response.body) throw new Error('Missing reset watch response');
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = []; let size = 0;
            try {
              while (true) {
                const part = await reader.read(); if (part.done) break;
                size += part.value.byteLength;
                if (size > MAX_BODY_BYTES) throw new Error('Reset watch response too large');
                chunks.push(part.value);
              }
            } finally { void reader.cancel().catch(() => {}); }
            return parseResetWatchResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')), new Date(now()).toISOString());
          })()]);
          cached = result;
        } catch {
          cached = {status: 'unavailable', checkedAt: new Date(now()).toISOString()};
        } finally {
          controller.abort(); if (timer) clearTimeout(timer);
          validUntil = now() + ttlMs; pending = undefined;
        }
        return cached!;
      })();
    }
    const result = pending ? await pending : cached!;
    // Time alone can expire a cached signal, without extending its original deadline.
    return result.status === 'active' && !activeResetWatch(result, new Date(now()).toISOString()) ? {status: 'none', checkedAt: result.checkedAt} : result;
  };
}
export const getResetWatch = createResetWatchReader();
export function resetWatchVersion(base: string, watch: ResetWatch | undefined, now: string): string {
  return createHash('sha256').update(JSON.stringify([base, resetWatchRevision(watch, now)])).digest('hex').slice(0, 24);
}
export function withResetWatchData(data: PublicData, watch: ResetWatch): PublicData {
  return data.forecasts ? {...data, forecasts: {...data.forecasts, watch}} : data;
}
export function withResetWatchEnvelope(result: PublicReadEnvelope, watch: ResetWatch, now: string): PublicReadEnvelope {
  return {...result, data: withResetWatchData({...result.data, serverTime: now}, watch),
    version: resetWatchVersion(result.version, watch, now), contentVersion: resetWatchVersion(result.contentVersion, watch, now)};
}
