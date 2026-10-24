const { publicActions, dateKey, displayTime } = require('./model');
const { resetObservations } = require('./reset-observations');
/** @typedef {'all'|'automatic_reset'|'banked_reset'} RecordKind */
/** @typedef {{id:string,kind:import('../../src/lib/types').ActionKind,at:string,publication:import('../../src/lib/types').Publication,evidenceType:'confirmed'|'observed',statusLabel:string,sourceName:string}} CalendarRecord */
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
  const observationKey = item => `${item.kind}:${item.observedAt}`;
  // Only an action's direct citation supplies the relationship. Article-level
  // citations may describe a later round while retaining older completion actions.
  // Re-check cited evidence so a duplicate source's ID can resolve the same
  // observation even when the public projection selected another source.
  const confirmedObservations = new Set(completed.flatMap(({action}) => {
    const direct = resetObservations({...data,evidence:data.evidence.filter(e=>action.evidenceIds.includes(e.id))});
    return direct.filter(item=>item.kind===action.kind).map(observationKey);
  }));
  /** @type {CalendarRecord[]} */
  const records = completed.map(({action,publication})=>({id:action.id,kind:action.kind,at:action.statementAt,publication,evidenceType:'confirmed',statusLabel:'完成确认',sourceName:''}));
  for(const observation of resetObservations(data)) {
    if(dateKey(observation.observedAt)<start||dateKey(observation.observedAt)>end||confirmedObservations.has(observationKey(observation)))continue;
    const publication=data.publications.find(p=>p.id===observation.publicationId);
    if(publication)records.push({id:`observation:${observationKey(observation)}`,kind:observation.kind,at:observation.observedAt,publication,evidenceType:'observed',statusLabel:'来源观测',sourceName:observation.sourceName});
  }
  return records.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
}
/** @param {import('../../src/lib/types').PublicData} data @param {{date?:string,kind?:RecordKind,month?:string}} [options] */
function recordCalendar(data, options = {}) {
  const { start, end } = recordRange(data.serverTime), kind = options.kind || 'all';
  const records = calendarRecords(data), filtered = records.filter(item => kind === 'all' || item.kind === kind);
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
  const selectedItems = (byDate.get(selected) || []).map(({ id,kind,at,publication,evidenceType,statusLabel,sourceName }) => ({ id, kind,
    label: kind==='banked_reset'?'重置卡':'额度重置', title: publication.article.title, time: displayTime(at).slice(11), at,evidenceType,statusLabel,sourceName,
    path: `/pages/detail/index?publicationId=${encodeURIComponent(publication.id)}`,
    href: `/events/${encodeURIComponent(publication.eventId)}?version=${encodeURIComponent(publication.id)}` }));
  const monthly = records.filter(item => dateKey(item.at).startsWith(month));
  return { start, end, selected, month, months, monthIndex: months.findIndex(item=>item.value===month), days, selectedItems, recentDate,
    automaticCount: monthly.filter(item=>item.kind==='automatic_reset').length, bankedCount: monthly.filter(item=>item.kind==='banked_reset').length,
    confirmedCount:monthly.filter(item=>item.evidenceType==='confirmed').length,observedCount:monthly.filter(item=>item.evidenceType==='observed').length,
    selectedConfirmedCount:selectedItems.filter(item=>item.evidenceType==='confirmed').length,selectedObservedCount:selectedItems.filter(item=>item.evidenceType==='observed').length,
    selectedLabel: `${Number(selected.slice(5,7))}月${Number(selected.slice(8))}日`,
    periodLabel: `${start.replace(/-/g,'.')}—${end.replace(/-/g,'.')}` };
}
module.exports = { recordRange, completedRecords, recordCalendar };
