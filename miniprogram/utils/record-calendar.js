const { publicActions, dateKey, displayTime } = require('./model');
/** @typedef {'all'|'automatic_reset'|'banked_reset'} RecordKind */
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
/** @param {import('../../src/lib/types').PublicData} data @param {{date?:string,kind?:RecordKind,month?:string}} [options] */
function recordCalendar(data, options = {}) {
  const { start, end } = recordRange(data.serverTime), kind = options.kind || 'all';
  const records = completedRecords(data), filtered = records.filter(item => kind === 'all' || item.action.kind === kind);
  const recentDate = filtered.length ? dateKey(filtered[0].action.statementAt) : '';
  let selected = options.date || recentDate || end;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selected) || dateKey(`${selected}T04:00:00Z`) !== selected || selected < start || selected > end) selected = recentDate || end;
  if (options.month && /^\d{4}-\d{2}$/.test(options.month) && options.month >= start.slice(0,7) && options.month <= end.slice(0,7)) {
    selected = filtered.map(item => dateKey(item.action.statementAt)).find(date => date.startsWith(options.month))
      || (options.month === end.slice(0,7) ? end : options.month === start.slice(0,7) ? start : `${options.month}-01`);
  }
  const month = selected.slice(0,7), months = [];
  for (const cursor = new Date(`${start.slice(0,7)}-01T12:00:00Z`); dateKey(cursor) && cursor.toISOString().slice(0,7) <= end.slice(0,7); cursor.setUTCMonth(cursor.getUTCMonth()+1)) {
    const value = cursor.toISOString().slice(0,7);
    months.unshift({ value, label: `${value.slice(0,4)}年 ${Number(value.slice(5))}月` });
  }
  /** @type {Map<string, ReturnType<typeof publicActions>>} */
  const byDate = new Map();
  filtered.forEach(item => { const date = dateKey(item.action.statementAt); byDate.set(date, [...(byDate.get(date) || []), item]); });
  const first = new Date(`${month}-01T12:00:00Z`), offset = (first.getUTCDay()+6)%7;
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth()+1, 0)).getUTCDate();
  const days = Array.from({ length: Math.ceil((offset + last) / 7) * 7 }, (_,index) => {
    const day = index-offset+1, blank = day<1 || day>last, date = blank ? `blank-${index}` : `${month}-${String(day).padStart(2,'0')}`;
    const items = byDate.get(date) || [];
    return { date, day: blank ? '' : String(day), blank, disabled: blank || date<start || date>end, selected: date===selected, today: date===end,
      count: items.length, automatic: items.some(item=>item.action.kind==='automatic_reset'), banked: items.some(item=>item.action.kind==='banked_reset') };
  });
  const selectedItems = (byDate.get(selected) || []).map(({ action, publication }) => ({ id: action.id, kind: action.kind,
    label: action.kind==='banked_reset'?'重置卡':'额度重置', title: publication.article.title, time: displayTime(action.statementAt).slice(11), at: action.statementAt,
    path: `/pages/detail/index?publicationId=${encodeURIComponent(publication.id)}`,
    href: `/events/${encodeURIComponent(publication.eventId)}?version=${encodeURIComponent(publication.id)}` }));
  const monthly = records.filter(item => dateKey(item.action.statementAt).startsWith(month));
  return { start, end, selected, month, months, monthIndex: months.findIndex(item=>item.value===month), days, selectedItems, recentDate,
    automaticCount: monthly.filter(item=>item.action.kind==='automatic_reset').length, bankedCount: monthly.filter(item=>item.action.kind==='banked_reset').length,
    selectedLabel: `${Number(selected.slice(5,7))}月${Number(selected.slice(8))}日`,
    periodLabel: `${start.replace(/-/g,'.')}—${end.replace(/-/g,'.')}` };
}
module.exports = { recordRange, completedRecords, recordCalendar };
