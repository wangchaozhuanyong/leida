import type { Activity } from './types';

export const ACTIVITY_RETENTION_DAYS = 3;
const calendarDayMs = 86400000;
type Schedule = Pick<Activity, 'startsOn' | 'days' | 'timezone'>;

function startDate(activity: Schedule): number | undefined {
  if (!Number.isInteger(activity.days) || activity.days < 1 || activity.days > 366 || !/^\d{4}-\d{2}-\d{2}$/.test(activity.startsOn)) return;
  const start = Date.parse(`${activity.startsOn}T00:00:00Z`);
  if (Number.isFinite(start) && new Date(start).toISOString().slice(0, 10) === activity.startsOn) return start;
}

/** Count calendar dates in the activity timezone, including across daylight-saving changes. */
export function activityDayNumber(activity: Schedule, now: string): number | undefined {
  const start = startDate(activity);
  if (start === undefined || !Number.isFinite(Date.parse(now))) return;
  try {
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: activity.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
    return Math.floor((Date.parse(`${date}T00:00:00Z`) - start) / calendarDayMs) + 1;
  } catch { return; }
}

export function activityHomeVisible(activity: Activity, now: string): boolean {
  const day = activityDayNumber(activity, now);
  return activity.showOnHome !== false && day !== undefined && day <= activity.days + ACTIVITY_RETENTION_DAYS;
}

/** The first hidden date, at midnight in the configured activity timezone. */
export function activityHideDate(activity: Schedule): string | undefined {
  const start = startDate(activity);
  if (start === undefined) return;
  return new Date(start + (activity.days + ACTIVITY_RETENTION_DAYS) * calendarDayMs).toISOString().slice(0, 10);
}
