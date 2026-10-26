const { publicActions, dateKey, displayTime } = require('./model');
const { resetRecordFacts } = require('./reset-records');
/** @typedef {'all'|'automatic_reset'|'banked_reset'} RecordKind */
/** @typedef {ReturnType<typeof resetRecordFacts>[number]} CalendarRecord */
/** Clamp a rolling six-calendar-month boundary, including month-end and leap years. */
function recordRange(now) {
  const end = dateKey(now);
  if (!end) return { start: '', end: '' };
  const cursor = new Date(`${end.slice(0,7)}-01T12:00:00Z`);
  cursor.setUTCMonth(cursor.getUTCMonth() - 6);
  const last = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
  cursor.setUTCDate(Math.min(Number(end.slice(8)), last));
  return { start: cursor.toISOString().slice(0,10), end };
}
/** @param {import('../../src/lib/types').PublicData} data */
function completedRecords(data) {
  const { start, end } = recordRange(data.serverTime), now = Date.parse(data.serverTime);
  return publicActions(data).filter(({ action, publication }) => action.stage === 'claimed_complete'
    && Number.isFinite(Date.parse(action.statementAt)) && Date.parse(action.statementAt) <= now
    && Number.isFinite(Date.parse(publication.publishedAt)) && Date.parse(publication.publishedAt) <= now
    && dateKey(action.statementAt) >= start && dateKey(action.statementAt) <= end)
    .sort((a,b) => Date.parse(b.action.statementAt) - Date.parse(a.action.statementAt) || a.action.id.localeCompare(b.action.id));
}
/** Calendar presentation only; observations never become completion actions.
 * @param {import('../../src/lib/types').PublicData} data
 * @returns {CalendarRecord[]}
 */
function calendarRecords(data) {
  const completed = completedRecords(data), { start, end } = recordRange(data.serverTime);
  return resetRecordFacts(data,completed).filter(r=>dateKey(r.at)>=start&&dateKey(r.at)<=end);
}
/** @param {import('../../src/lib/types').PublicData} data @param {{date?:string,kind?:RecordKind,month?:string,recentLimit?:number}} [options] */
function recordCalendar(data, options = {}) {
  const { start, end } = recordRange(data.serverTime), kind = options.kind || 'all';
  const records = calendarRecords(data), filtered = records.filter(item => kind === 'all' || item.kind === kind);
  // Limit rendering only. The complete half-year history still supplies the calendar.
  const recentLimit = Number.isSafeInteger(options.recentLimit) && options.recentLimit >= 10 ? options.recentLimit : 10;
  const recentRecords = filtered.slice(0, recentLimit);
  const recentDate = filtered.length ? dateKey(filtered[0].at) : '';
  let selected = options.date || recentDate || end;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selected) || dateKey(`${selected}T04:00:00Z`) !== selected || selected < start || selected > end) selected = recentDate || end;
  if (options.month && /^\d{4}-\d{2}$/.test(options.month) && options.month >= start.slice(0,7) && options.month <= end.slice(0,7)) {
    selected = filtered.map(item => dateKey(item.at)).find(date => date.startsWith(options.month))
      || (options.month === end.slice(0,7) ? end : options.month === start.slice(0,7) ? start : `${options.month}-01`);
  }
  const month = selected.slice(0,7), months = [];
  for (const cursor = new Date(`${start.slice(0,7)}-01T12:00:00Z`); dateKey(cursor) && cursor.toISOString().slice(0,7) <= end.slice(0,7); cursor.setUTCMonth(cursor.getUTCMonth()+1)) {
    const value = cursor.toISOString().slice(0,7);
    months.unshift({ value, label: `${value.slice(0,4)}年 ${Number(value.slice(5))}月` });
  }
  /** @type {Map<string, CalendarRecord[]>} */
  const byDate = new Map();
  filtered.forEach(item => { const date = dateKey(item.at); byDate.set(date, [...(byDate.get(date) || []), item]); });
  const first = new Date(`${month}-01T12:00:00Z`), offset = (first.getUTCDay()+6)%7;
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth()+1, 0)).getUTCDate();
  const days = Array.from({ length: Math.ceil((offset + last) / 7) * 7 }, (_,index) => {
    const day = index-offset+1, blank = day<1 || day>last, date = blank ? `blank-${index}` : `${month}-${String(day).padStart(2,'0')}`;
    const items = byDate.get(date) || [];
    const confirmed = items.filter(item=>item.evidenceType==='confirmed'), observedCount=items.length-confirmed.length;
    return { date, day: blank ? '' : String(day), blank, disabled: blank || date<start || date>end, selected: date===selected, today: date===end,
      count: items.length, automatic: items.some(item=>item.kind==='automatic_reset'), banked: items.some(item=>item.kind==='banked_reset'),
      confirmedCount:confirmed.length,observedCount,observed:observedCount>0,
      confirmedAutomatic:confirmed.some(item=>item.kind==='automatic_reset'),confirmedBanked:confirmed.some(item=>item.kind==='banked_reset') };
  });
  const present = ({ id,kind,at,publication,evidenceType,statusLabel,sourceName,isObservationSummary,sources,sourceCount,evidenceCount,timeRange,title,summaryScope }) => ({ id, kind,
    label: kind==='banked_reset'?'重置卡':'额度重置', title, time: displayTime(at).slice(11), timeRange,at,evidenceType,statusLabel,sourceName,isObservationSummary,sources,sourceCount,evidenceCount,
    date: displayTime(at).slice(0,10),
    recordTitle:kind==='banked_reset'?'重置卡发放':isObservationSummary?'额度重置观测':'额度重置',timeLabel:evidenceType==='observed'?isObservationSummary&&summaryScope==='date'?'最早观测':'观测时间':'声明时间',
    path: `/pages/detail/index?publicationId=${encodeURIComponent(publication.id)}`,
    href: `/events/${encodeURIComponent(publication.eventId)}?version=${encodeURIComponent(publication.id)}` });
  const selectedItems = (byDate.get(selected) || []).map(present);
  const monthly = records.filter(item => dateKey(item.at).startsWith(month));
  return { start, end, selected, month, months, monthIndex: months.findIndex(item=>item.value===month), days, selectedItems, recentDate,
    recentRecords:recentRecords.map(present), recentTotal:filtered.length, recentHasMore:recentRecords.length<filtered.length,
    automaticCount: monthly.filter(item=>item.kind==='automatic_reset').length, bankedCount: monthly.filter(item=>item.kind==='banked_reset').length,
    confirmedCount:monthly.filter(item=>item.evidenceType==='confirmed').length,observedCount:monthly.filter(item=>item.evidenceType==='observed').length,
    observedDateCount:new Set(monthly.filter(item=>item.evidenceType==='observed').map(item=>dateKey(item.at))).size,
    observationEvidenceCount:monthly.filter(item=>item.evidenceType==='observed').reduce((sum,item)=>sum+item.evidenceCount,0),
    selectedConfirmedCount:selectedItems.filter(item=>item.evidenceType==='confirmed').length,selectedObservedCount:selectedItems.filter(item=>item.evidenceType==='observed').length,
    selectedLabel: `${Number(selected.slice(5,7))}月${Number(selected.slice(8))}日`,
    periodLabel: `${start.replace(/-/g,'.')}—${end.replace(/-/g,'.')}` };
}
module.exports = { recordRange, completedRecords, recordCalendar };
