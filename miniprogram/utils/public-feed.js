/** Shared public presentation only: original records and event state remain unchanged.
 * @typedef {import('../../src/lib/types').PublicData} PublicData
 * @typedef {import('../../src/lib/types').Publication} Publication
 * @typedef {{id:string, latest:Publication, updates:Publication[], category:'reset'|'activity'|'product', incident:boolean, withdrawn:boolean, observation?:ReturnType<typeof observationDayGroups>[number]}} NewsGroup
 */
const { observationDayGroups } = require('./reset-records');
/** @param {Publication} p */
function sourceTime(p) {
  if (p.mode === 'news_only' || p.article.publicationMode === 'news_only') return p.article.sourcePublishedAt || p.article.publishedAt;
  return [p.article.sourcePublishedAt, ...p.event.actions.map(a => a.statementAt)].filter(t => t && Number.isFinite(Date.parse(t))).sort((a,b)=>Date.parse(a)-Date.parse(b)).pop() || p.article.publishedAt;
}
/** @param {Publication} a @param {Publication} b */
const compare = (a, b) => Date.parse(sourceTime(b)) - Date.parse(sourceTime(a)) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id);
/** @param {PublicData} data @param {string} id */
function eventKey(data, id) {
  const seen = new Set(); let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const event = data.events.find(e => e.id === current);
    if (event?.status !== 'merged' || !event.mergedInto || !data.events.some(e => e.id === event.mergedInto)) return current;
    current = event.mergedInto;
  }
  return id; // Invalid merge cycles must not join unrelated stories.
}
/** An exact official incident URL is an identity; similar titles/times are not.
 * @param {PublicData} data @param {Publication} p */
function incidentKey(data, p) {
  const ids = new Set(p.article.evidenceIds);
  const keys = [...new Set(data.evidence.filter(e => ids.has(e.id)).map(e => {
    const match = /^https:\/\/status\.openai\.com\/incidents\/([a-zA-Z0-9_-]+)(?:[/?#]|$)/.exec(e.url);
    return match ? match[1] : '';
  }).filter(Boolean))];
  return keys.length === 1 ? keys[0] : '';
}
/** @param {PublicData} data @returns {NewsGroup[]} */
function publicNewsGroups(data) {
  /** @type {Map<string, {publications:Publication[], incident:boolean}>} */
  const groups = new Map();
  const valid = data.publications.filter(p => Number.isFinite(Date.parse(p.publishedAt)) && Date.parse(p.publishedAt) <= Date.parse(data.serverTime));
  const current = valid.filter(p => data.articles.some(a => a.publicationId === p.id));
  for (const p of current) {
    const incident = incidentKey(data, p), key = incident ? 'incident:' + incident : 'event:' + eventKey(data, p.eventId);
    const group = groups.get(key) || {publications: [], incident: !!incident};
    group.publications.push(p); groups.set(key, group);
  }
  return [...groups].map(([id, group]) => {
    const ordered = group.publications.slice().sort(compare);
    const event = data.events.find(e => 'event:' + e.id === id);
    const latest = ordered.find(p => p.id === event?.publicationId) || ordered[0];
    const eventIds = new Set(group.publications.map(p => p.eventId));
    const seen = new Set();
    const updates = valid.filter(p => eventIds.has(p.eventId)).sort(compare).filter(p => {
      // Rewording is retained; exact repeat snapshots are not a second progress step.
      const signature = JSON.stringify([p.article.id, sourceTime(p), p.article.title, p.article.summary, p.event.actions, p.article.status, p.event.status]);
      if (seen.has(signature)) return false;
      seen.add(signature); return true;
    });
    const withdrawn = latest.article.status === 'withdrawn' || latest.event.status === 'withdrawn' || data.articles.some(a=>a.id===latest.articleId && a.status==='withdrawn') || data.events.some(e=>e.id===latest.eventId && e.status==='withdrawn');
    return {id, latest, updates, withdrawn, incident:group.incident, category:group.incident ? 'product' : latest.article.category};
  }).sort((a, b) => compare(a.latest, b.latest));
}
/** @param {PublicData} data @returns {NewsGroup[]} */
function homeNewsGroups(data) {
  const groups=publicNewsGroups(data).filter(g => !g.incident && (g.category === 'reset' || g.latest.event.actions.length > 0 && g.latest.mode !== 'news_only' && g.latest.article.publicationMode !== 'news_only'));
  const summaries=observationDayGroups(data).filter(g=>g.isObservationSummary);
  const grouped=new Set(summaries.flatMap(g=>g.observations.map(o=>o.publicationId)));
  return [...groups.filter(g=>!grouped.has(g.latest.id)),...summaries.map(observation=>({id:observation.id,latest:observation.publication,
    updates:observation.sources.map(s=>data.publications.find(p=>p.id===s.publicationId)).filter(Boolean),category:'reset',incident:false,withdrawn:false,observation}))]
    .sort((a,b)=>compare(a.latest,b.latest)).slice(0,3);
}
module.exports = {publicNewsGroups, homeNewsGroups};
