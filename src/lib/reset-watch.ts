/** A third-party public observation, separate from official announcements and our cadence model. */
export interface ResetWatchSignal {
  sourceUrl: string;
  text: string;
  level: 'elevated' | 'strong';
  observedAt: string;
  expiresAt: string;
  forecastWindow: string;
}
export interface ResetWatch {
  status: 'active' | 'none' | 'unavailable';
  checkedAt: string;
  signal?: ResetWatchSignal;
}
export const RESET_WATCH_CREDIT_URL = 'https://codex-resets.com/';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
export function resetWatchTime(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : NaN;
}
export function validResetWatch(value: unknown): value is ResetWatch {
  if (!record(value) || !['active', 'none', 'unavailable'].includes(String(value.status)) || !Number.isFinite(resetWatchTime(value.checkedAt))) return false;
  if (value.status !== 'active') return value.signal === undefined;
  const s = value.signal;
  return record(s) && (s.level === 'elevated' || s.level === 'strong')
    && typeof s.sourceUrl === 'string' && /^https:\/\/x\.com\/thsottiaux\/status\/\d{15,20}$/.test(s.sourceUrl)
    && boundedText(s.text, 4000) && boundedText(s.forecastWindow, 200)
    && Number.isFinite(resetWatchTime(s.observedAt)) && Number.isFinite(resetWatchTime(s.expiresAt))
    && resetWatchTime(s.expiresAt) > resetWatchTime(s.observedAt)
    && resetWatchTime(s.observedAt) <= resetWatchTime(value.checkedAt);
}
/** An expiry is an observation deadline, never proof of reset or a promised delivery time. */
export function activeResetWatch(watch: ResetWatch | undefined, now: string, resolvedAt?: string): ResetWatchSignal | undefined {
  if (!validResetWatch(watch) || watch.status !== 'active') return;
  const signal = watch.signal!, current = Date.parse(now), resolved = Date.parse(resolvedAt ?? '');
  if (!Number.isFinite(current) || resetWatchTime(watch.checkedAt) > current || resetWatchTime(signal.observedAt) > current
    || resetWatchTime(signal.expiresAt) <= current || Number.isFinite(resolved) && resolved >= resetWatchTime(signal.observedAt)) return;
  return signal;
}
/** The checked timestamp must not invalidate every page on an unchanged poll. */
export function resetWatchRevision(watch: ResetWatch | undefined, now: string): unknown {
  if (!validResetWatch(watch)) return {status: 'unavailable'};
  const signal = activeResetWatch(watch, now);
  return signal ? {status: 'active', signal} : {status: watch.status === 'active' ? 'none' : watch.status};
}
