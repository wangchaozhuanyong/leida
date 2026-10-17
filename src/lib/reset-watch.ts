/** A third-party public observation, separate from official announcements and our cadence model. */
export interface ResetWatchSignal {
  sourceType?: 'x_post' | 'observed';
  sourceUrl?: string;
  text: string;
  level: 'elevated' | 'strong';
  observedAt: string;
  expiresAt: string;
  forecastWindow: string;
  /** Passed through from reset_chance_percent; never our accuracy or a trained probability. */
  chancePercent?: number | null;
}
export interface ResetScheduledAnnouncement {
  id:string;
  kind:'automatic_reset'|'banked_reset';
  announcedAt:string;
  scheduledFor:string|null;
  sourceType?:'x_post'|'observed';
  sourceUrl?:string;
  text:string;
}
export interface ResetWatch {
  status: 'active' | 'none' | 'unavailable';
  checkedAt: string;
  signal?: ResetWatchSignal;
  scheduledReset?:ResetScheduledAnnouncement;
}
export const RESET_WATCH_CREDIT_URL = 'https://codex-resets.com/';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const sourceUrl=(value:unknown):value is string=>typeof value==='string'&&/^https:\/\/x\.com\/thsottiaux\/status\/\d{15,20}$/.test(value);
export function validWatchSource(value: Record<string, unknown>): boolean {
  if (value.sourceType === undefined || value.sourceType === 'x_post') return sourceUrl(value.sourceUrl);
  if (value.sourceType !== 'observed') return false;
  if (value.sourceUrl === undefined) return true;
  if(typeof value.sourceUrl!=='string'||value.sourceUrl.length>2048||/[\u0000-\u0020]/.test(value.sourceUrl))return false;
  try { const url = new URL(String(value.sourceUrl)); return typeof value.sourceUrl === 'string' && url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
const chance=(value:unknown)=>value===undefined||value===null||typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=100;
export function resetWatchTime(value: unknown): number {
  if(typeof value!=='string'||value.length>64||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN;
  const year=Number(value.slice(0,4)),month=Number(value.slice(5,7)),day=Number(value.slice(8,10));
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59)return NaN;
  return Date.parse(value);
}
export function validResetWatch(value: unknown): value is ResetWatch {
  if (!record(value) || !['active', 'none', 'unavailable'].includes(String(value.status)) || !Number.isFinite(resetWatchTime(value.checkedAt))) return false;
  const scheduled=value.scheduledReset;
  if(scheduled!==undefined&&(!record(scheduled)||value.status!=='none'||!boundedText(scheduled.id,64)||!['automatic_reset','banked_reset'].includes(String(scheduled.kind))||!validWatchSource(scheduled)||!boundedText(scheduled.text,4000)||!Number.isFinite(resetWatchTime(scheduled.announcedAt))||resetWatchTime(scheduled.announcedAt)>resetWatchTime(value.checkedAt)||scheduled.scheduledFor!==null&&(!Number.isFinite(resetWatchTime(scheduled.scheduledFor))||resetWatchTime(scheduled.scheduledFor)<resetWatchTime(scheduled.announcedAt))))return false;
  if (value.status !== 'active') return value.signal === undefined;
  const s = value.signal;
  return record(s) && (s.level === 'elevated' || s.level === 'strong')
    && validWatchSource(s) && chance(s.chancePercent)
    && boundedText(s.text, 4000) && boundedText(s.forecastWindow, 200)
    && Number.isFinite(resetWatchTime(s.observedAt)) && Number.isFinite(resetWatchTime(s.expiresAt))
    && resetWatchTime(s.expiresAt) > resetWatchTime(s.observedAt)
    && resetWatchTime(s.observedAt) <= resetWatchTime(value.checkedAt);
}
export function activeResetSchedule(watch:ResetWatch|undefined,now:string):ResetScheduledAnnouncement|undefined {
  if(!validResetWatch(watch)||!watch.scheduledReset)return;
  const current=Date.parse(now),s=watch.scheduledReset;
  // scheduled_reset explicitly means awaiting execution. An unrelated newer
  // completion (even of the same kind) cannot identify or close this round.
  if(!Number.isFinite(current)||resetWatchTime(watch.checkedAt)>current||resetWatchTime(s.announcedAt)>current)return;
  return s;
}
/** Readable translations of documented relative windows; unknown wording stays source text. */
export function resetWatchWindow(value:string):string {
  const hours=value.trim().match(/^(?:within|in(?: the next)?)\s+(\d+(?:\.\d+)?)\s+hours?\.?$/i);
  if(hours)return `${hours[1]}小时内`;
  if(/^(?:within|in(?: the next)?)\s+(?:a\s+)?few\s+hours\.?$/i.test(value.trim()))return '数小时内';
  return value;
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
  const scheduledReset=activeResetSchedule(watch,now);
  if(scheduledReset)return {status:'none',scheduledReset,overdue:scheduledReset.scheduledFor!==null&&Date.parse(scheduledReset.scheduledFor)<=Date.parse(now)};
  return signal ? {status: 'active', signal} : {status: watch.status === 'active' ? 'none' : watch.status};
}
