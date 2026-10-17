import {createHash} from 'node:crypto';
import type {PublicData} from '../lib/types';
import type {PublicReadEnvelope} from '../lib/public-read';
import {activeResetWatch, resetWatchRevision, resetWatchTime, validResetWatch, type ResetWatch} from '../lib/reset-watch';

export const RESET_WATCH_ENDPOINT = 'https://codex-resets.com/api/v1/status';
export const RESET_WATCH_CACHE_MS = 5 * 60_000;
// Changing the public selection/interpretation must invalidate an unchanged facts cache once.
const PUBLIC_RESET_PRESENTATION_VERSION='source-driven-public-reset-20261017-2';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_AGE_MS = 15 * 60_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const canonicalTime=(value:unknown):string=>{const at=resetWatchTime(value);return Number.isFinite(at)?new Date(at).toISOString():value as string;};
type FailureCode = 'RESPONSE_INVALID'|'RESPONSE_STALE'|'SCHEDULE_INVALID'|'SIGNAL_INVALID'|'TIMEOUT'|'HTTP_4XX'|'HTTP_5XX'|'HTTP_OTHER'|'CONTENT_TYPE'|'BODY_TOO_LARGE'|'BODY_EMPTY'|'JSON_INVALID'|'NETWORK_TLS'|'NETWORK_DNS'|'NETWORK_TIMEOUT'|'NETWORK';
class WatchReadError extends Error { constructor(readonly code:FailureCode, message:string) {super(message);} }
function sourceFields(source:unknown):{sourceType?:'observed';sourceUrl?:string} {
  if(!record(source))throw new WatchReadError('SIGNAL_INVALID','Invalid reset watch source');
  if(source.type==='x_post'&&source.author==='thsottiaux'&&typeof source.url==='string')return {sourceUrl:source.url};
  if(source.type==='observed')return {sourceType:'observed',...(source.url!==undefined?{sourceUrl:source.url as string}:{})};
  throw new WatchReadError('SIGNAL_INVALID','Invalid reset watch source');
}
export function safeResetWatchFailure(error:unknown):FailureCode {
  if(error instanceof WatchReadError)return error.code;
  const cause=error instanceof Error&&(error as Error & {cause?:{code?:string}}).cause;
  const code=cause&&cause.code;
  if(code&&['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN'].includes(code))return 'NETWORK_TLS';
  if(code&&['ENOTFOUND','EAI_AGAIN'].includes(code))return 'NETWORK_DNS';
  if(code&&['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT'].includes(code))return 'NETWORK_TIMEOUT';
  return 'NETWORK';
}

/** Only documented source fields cross this boundary; upstream chance is explicitly attributed. */
export function parseResetWatchResponse(value: unknown, checkedAt: string): ResetWatch {
  const current = resetWatchTime(checkedAt);
  if (!record(value) || !record(value.data) || !record(value.meta) || value.meta.api_version !== 'v1' || !Number.isFinite(current)) throw new WatchReadError('RESPONSE_INVALID','Invalid reset watch response');
  const generated = resetWatchTime(value.meta.generated_at);
  if (!Number.isFinite(generated) || generated > current || current - generated > MAX_RESPONSE_AGE_MS) throw new WatchReadError('RESPONSE_STALE','Stale reset watch response');
  if (!Object.prototype.hasOwnProperty.call(value.data, 'active_watch') || !Object.prototype.hasOwnProperty.call(value.data, 'latest_reset') || !Object.prototype.hasOwnProperty.call(value.data, 'scheduled_reset')) throw new WatchReadError('RESPONSE_INVALID','Missing reset status fields');
  const latest=value.data.latest_reset;
  if(latest!==null&&(!record(latest)||!Number.isFinite(resetWatchTime(latest.announced_at))||resetWatchTime(latest.announced_at)>generated))throw new WatchReadError('RESPONSE_INVALID','Invalid latest reset');
  const scheduled=value.data.scheduled_reset;
  if(scheduled!==null){
    if(!record(scheduled)||scheduled.status!=='scheduled'||!['regular','banked'].includes(String(scheduled.reset_type)))throw new WatchReadError('SCHEDULE_INVALID','Invalid scheduled reset');
    const result:ResetWatch={status:'none',checkedAt,scheduledReset:{id:scheduled.id as string,kind:scheduled.reset_type==='banked'?'banked_reset':'automatic_reset',announcedAt:canonicalTime(scheduled.announced_at),scheduledFor:scheduled.scheduled_for===null?null:canonicalTime(scheduled.scheduled_for),text:scheduled.text as string,...sourceFields(scheduled.source)}};
    if(!validResetWatch(result)||resetWatchTime(result.scheduledReset!.announcedAt)>generated)throw new WatchReadError('SCHEDULE_INVALID','Invalid scheduled reset');
    return result;
  }
  const watch = value.data.active_watch;
  if (watch === null) return {status: 'none', checkedAt};
  if (!record(watch) || watch.reset_chance_percent !== null && (typeof watch.reset_chance_percent !== 'number' || !Number.isInteger(watch.reset_chance_percent) || watch.reset_chance_percent < 0 || watch.reset_chance_percent > 100)) throw new WatchReadError('SIGNAL_INVALID','Invalid reset watch source');
  const result = {status: 'active', checkedAt, signal: {
    ...sourceFields(watch.source), text: watch.text, level: watch.level,
    observedAt: canonicalTime(watch.observed_at), expiresAt: canonicalTime(watch.expires_at), forecastWindow: watch.forecast_window, chancePercent:watch.reset_chance_percent,
  }};
  if (!validResetWatch(result) || resetWatchTime(result.signal!.observedAt) > generated) throw new WatchReadError('SIGNAL_INVALID','Invalid reset watch signal');
  const resolvedAt = record(latest) ? latest.announced_at as string : undefined;
  // A published reset supersedes earlier speculation. Expiry cannot become a completion.
  if (!activeResetWatch(result, checkedAt, resolvedAt) || value.data.scheduled_reset !== null) return {status: 'none', checkedAt};
  return result;
}

interface ReaderOptions { fetcher?: typeof fetch; now?: () => number; ttlMs?: number; timeoutMs?: number; onFailure?:(code:FailureCode)=>void; }
export function createResetWatchReader({fetcher = fetch, now = Date.now, ttlMs = RESET_WATCH_CACHE_MS, timeoutMs = 1500, onFailure = code => console.warn('RESET_WATCH_UNAVAILABLE', code)}: ReaderOptions = {}) {
  let cached: ResetWatch | undefined, validUntil = 0, pending: Promise<ResetWatch> | undefined;
  return async function read(): Promise<ResetWatch> {
    const current = now();
    if (!pending && (!cached || current >= validUntil)) {
      pending = (async () => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {controller.abort(); reject(new WatchReadError('TIMEOUT','Reset watch timeout'));}, timeoutMs); });
        try {
          const result = await Promise.race([deadline, (async () => {
            const response = await fetcher(RESET_WATCH_ENDPOINT, {headers: {Accept: 'application/json'}, cache: 'no-store', redirect: 'error', signal: controller.signal});
            if (!response.ok) throw new WatchReadError(response.status>=500?'HTTP_5XX':response.status>=400?'HTTP_4XX':'HTTP_OTHER','Reset watch unavailable');
            if (!response.headers.get('content-type')?.includes('application/json')) throw new WatchReadError('CONTENT_TYPE','Invalid reset watch content type');
            const length = Number(response.headers.get('content-length'));
            if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new WatchReadError('BODY_TOO_LARGE','Reset watch response too large');
            if (!response.body) throw new WatchReadError('BODY_EMPTY','Missing reset watch response');
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = []; let size = 0;
            try {
              while (true) {
                const part = await reader.read(); if (part.done) break;
                size += part.value.byteLength;
                if (size > MAX_BODY_BYTES) throw new WatchReadError('BODY_TOO_LARGE','Reset watch response too large');
                chunks.push(part.value);
              }
            } finally { void reader.cancel().catch(() => {}); }
            let value:unknown;try {value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch {throw new WatchReadError('JSON_INVALID','Invalid reset watch JSON');}
            return parseResetWatchResponse(value, new Date(now()).toISOString());
          })()]);
          cached = result;
        } catch(error) {
          onFailure(safeResetWatchFailure(error));
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
  return createHash('sha256').update(JSON.stringify([base, PUBLIC_RESET_PRESENTATION_VERSION, resetWatchRevision(watch, now)])).digest('hex').slice(0, 24);
}
export function withResetWatchData(data: PublicData, watch: ResetWatch): PublicData {
  return data.forecasts ? {...data, forecasts: {...data.forecasts, watch}} : data;
}
/** Older native validators require a Tibo URL; never break their entire bootstrap. */
export function publicWatchForClient(data:PublicData, acceptsObserved:boolean):PublicData {
  const watch=data.forecasts?.watch;
  if(acceptsObserved||!watch||!(watch.signal?.sourceType==='observed'||watch.scheduledReset?.sourceType==='observed'))return data;
  return withResetWatchData(data,{status:'unavailable',checkedAt:watch.checkedAt});
}
export function withResetWatchEnvelope(result: PublicReadEnvelope, watch: ResetWatch, now: string): PublicReadEnvelope {
  return {...result, data: withResetWatchData({...result.data, serverTime: now}, watch),
    version: resetWatchVersion(result.version, watch, now), contentVersion: resetWatchVersion(result.contentVersion, watch, now)};
}
