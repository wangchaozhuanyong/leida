const { resetObservationSources } = require('./reset-observations');
/** @typedef {import('../../src/lib/public-facts').PublicFactsData} Facts */
/** @typedef {import('../../src/lib/reset-observations').ResetObservation} Observation */
const beijingDate = at => new Date(Date.parse(at) + 8 * 3600000).toISOString().slice(0, 10);
const beijingTime = at => new Date(Date.parse(at) + 8 * 3600000).toISOString().slice(11, 16);
const observationKey = o => o.kind + ':' + o.observedAt;
/** Keep every valid source, including two sources reporting the same minute.
 * This does not change the source facts, publication identity, or training data.
 * @param {Facts} data @returns {Observation[]}
 */
function observationSources(data) {
  return resetObservationSources(data);
}
/** A date summary is NOT a claim that all reports prove exactly one reset round.
 * Proven separate completion actions remain separate. No proximity heuristic is used.
 * @param {Facts} data @param {Observation[]} [observations]
 */
function observationDayGroups(data, observations = observationSources(data)) {
  /** @type {Map<string, Observation[]>} */
  const groups = new Map();
  for (const o of observations) {
    const key = o.kind + ':' + beijingDate(o.observedAt);
    groups.set(key, [...(groups.get(key)||[]), o]);
  }
  // Multiple distinct entries from the SAME source may describe separate rounds.
  // Do not erase them with a one-reset-per-day rule, or guess which other source
  // belongs to which round. Only exact-time peers can share those entries.
  /** @type {[string, Observation[]][]} */
  const partitions=[...groups].flatMap(([key,rows])=>{
    const counts=new Map();
    for(const o of rows)counts.set(o.sourceId,(counts.get(o.sourceId)||0)+1);
    if(![...counts.values()].some(n=>n>1))return [[key,rows]];
    const times=new Map();
    for(const o of rows)times.set(o.observedAt,[...(times.get(o.observedAt)||[]),o]);
    return [...times].map(([at,items])=>[key+':'+at,items]);
  });
  return partitions.flatMap(([key, rows])=>{
    const sorted = rows.slice().sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt)||a.sourceId.localeCompare(b.sourceId)||a.evidenceId.localeCompare(b.evidenceId));
    const first = sorted[0], last = sorted[sorted.length-1];
    const publication = data.publications.find(p=>p.id===first.publicationId);
    if(!publication)return [];
    const sourceNames = [...new Set(sorted.map(o=>o.sourceName))];
    const times = [...new Set(sorted.map(o=>beijingTime(o.observedAt)))];
    const multi = sorted.length > 1, summaryScope=key===first.kind+':'+beijingDate(first.observedAt)?'date':'time';
    return [{id:'observation-day:'+key,kind:first.kind,date:beijingDate(first.observedAt),at:first.observedAt,observedUntil:last.observedAt,
      publication,observations:sorted,sourceCount:sourceNames.length,evidenceCount:sorted.length,sourceName:sourceNames.join('、'),
      evidenceType:'observed',statusLabel:'来源观测',isObservationSummary:multi,summaryScope,
      timeRange:times.length>1?times[0]+'–'+times[times.length-1]:times[0],
      title:multi?'额度已重置（观测）':publication?.article.title||'额度重置观测',
      summary:multi?`来源：${sourceNames.join('、')}。最早观测 ${beijingTime(first.observedAt)}（北京时间）。`:'',
      sources:sorted.map(o=>({id:o.evidenceId,title:o.sourceName,time:beijingDate(o.observedAt)+' '+beijingTime(o.observedAt),at:o.observedAt,publicationId:o.publicationId,path:'/pages/detail/index?publicationId='+encodeURIComponent(o.publicationId)}))}];
  }).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
}
/** One rule for record lists and activity facts. Unproven reports are date summaries,
 * not extra completed actions. Directly cited observations attach to their completion.
 * @param {Facts} data
 * @param {{action:import('../../src/lib/types').BenefitAction,publication:import('../../src/lib/types').Publication}[]} completed
 */
function resetRecordFacts(data, completed) {
  const observations = observationSources(data), consumed = new Set();
  const confirmed = completed.map(({action, publication})=>{
    const cited = observations.filter(o=>o.kind===action.kind && action.evidenceIds.includes(o.evidenceId));
    cited.forEach(o=>consumed.add(observationKey(o)));
    return {id:action.id,kind:action.kind,at:action.statementAt,publication,evidenceType:'confirmed',statusLabel:'完成确认',sourceName:'',isObservationSummary:false,
      observedUntil:'',sourceCount:0,evidenceCount:0,timeRange:'',summary:'',summaryScope:'',title:publication.article.title,sources:[]};
  });
  return [...confirmed,...observationDayGroups(data,observations.filter(o=>!consumed.has(observationKey(o))))]
    .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
}
module.exports = { observationSources, observationDayGroups, resetRecordFacts };
