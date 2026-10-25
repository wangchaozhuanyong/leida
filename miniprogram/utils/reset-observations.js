/** @typedef {import('../../src/lib/types').Evidence} Evidence */
/** @typedef {import('../../src/lib/public-facts').PublicFactsData} PublicFactsData */
const valid=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const archive='https://codex-resets.com/zh-CN';
const reference='https://raw.githubusercontent.com/gdutxiaoxu/codex-reset-radar/master/data/latest.json';
const codexLimits='https://codexlimits.com/reset-history';
const observedResetText=text=>typeof text==='string'&&/^(?:Codex\s*使用限额已重置[。.!]?\s*(?:查看你的限额[。.!]?)?|Codex usage limits have been reset[.!]?(?:\s*Check your limits[.!]?)?)$/i.test(text.trim());
/** A source observation is never an author's completion announcement or a training outcome. */
function observedEvidence(e,now) {
  if(!e||e.provenance!=='archive'||e.textOrigin!=='archive_excerpt'||!valid(now)||!valid(e.publishedAt)||!valid(e.collectedAt)||Date.parse(e.publishedAt)>Date.parse(e.collectedAt)||Date.parse(e.collectedAt)>Date.parse(now))return null;
  if(e.sourceId==='codexlimits-observations'){
    const proof=e.metadata?.referenceReset,date=new Date(e.publishedAt);
    const stamp=`${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getUTCMonth()]} ${date.getUTCDate()}, ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')} UTC.`;
    const summary=`Third-party observation on ${stamp}`;
    if(e.parentId||e.contextComplete||e.metadata?.category!=='reset'||e.metadata?.sourceGroup!=='codexlimits'||e.metadata?.benefitKind!=='automatic_reset'||e.url!==codexLimits||e.messageId!==`observed-codexlimits-${date.getTime()}`||date.toISOString()!==e.publishedAt||date.getUTCSeconds()!==0||date.getUTCMilliseconds()!==0||proof?.referenceUrl!==codexLimits||proof.eventId!==`codexlimits:automatic_reset:${e.publishedAt}`||proof.occurredAt!==e.publishedAt||proof.snapshotAt!==e.collectedAt||proof.summary!==summary||e.text!==`Usage reset landed\n${summary}`)return null;
    return {kind:'automatic_reset',observedAt:e.publishedAt,collectedAt:e.collectedAt,evidenceId:e.id,sourceId:e.sourceId,sourceName:'Codex Limits',sourceUrl:codexLimits,referenceUrl:codexLimits,sourceType:'observed'};
  }
  const id=e.messageId?.match(/^observed-(\d{15,20})$/)?.[1];
  if(!id||e.url!==`https://x.com/thsottiaux/status/${id}`||Date.parse(e.publishedAt)<Number((BigInt(id)>>22n)+1288834974657n))return null;
  const codex=e.sourceId==='reset-archive'&&e.metadata?.sourceGroup==='codex-resets'&&e.metadata?.category==='reset'&&observedResetText(e.text);
  const proof=e.metadata?.referenceReset;
  const other=e.sourceId==='aiplanwatch-reference'&&e.metadata?.sourceGroup==='aiplanwatch'&&e.metadata?.benefitKind==='automatic_reset'&&proof?.referenceUrl===reference&&observedResetText(proof.summary)&&e.text===proof.summary&&proof.occurredAt===e.publishedAt&&valid(proof.snapshotAt)&&Date.parse(proof.snapshotAt)>=Date.parse(e.publishedAt)&&Date.parse(proof.snapshotAt)<=Date.parse(e.collectedAt)+60000;
  if(!codex&&!other)return null;
  return {kind:'automatic_reset',observedAt:e.publishedAt,collectedAt:e.collectedAt,evidenceId:e.id,sourceId:e.sourceId,sourceName:codex?'Codex Resets':'AIPlanWatch',sourceUrl:codex?archive:reference,referenceUrl:e.url,sourceType:'observed'};
}
/** Only published, still-visible evidence participates; repeated collection is one observation. */
function resetObservations(data) {
  if(!data||!valid(data.serverTime))return [];
  const current=new Map();
  for(const e of data.evidence||[]){
    const observation=observedEvidence(e,data.serverTime);if(!observation)continue;
    const publication=(data.publications||[]).filter(p=>p.article.evidenceIds.includes(e.id)&&p.event.status==='published'&&p.article.status==='published'&&valid(p.publishedAt)&&Date.parse(p.publishedAt)<=Date.parse(data.serverTime)&&
      !data.events.some(event=>event.id===p.eventId&&['withdrawn','merged'].includes(event.status))&&!data.articles.some(a=>a.id===p.articleId&&a.status==='withdrawn'))
      .sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0];
    if(!publication)continue;
    const key=e.sourceId+':'+e.messageId,previous=current.get(key);
    if(!previous||Date.parse(previous.collectedAt)<Date.parse(e.collectedAt))current.set(key,{...observation,eventId:publication.eventId,publicationId:publication.id});
  }
  // Normal record links prefer the current publication of the same observation.
  const currentRank=(o)=>Number((data.articles||[]).some(a=>a.publicationId===o.publicationId));
  const published=(o)=>Date.parse((data.publications||[]).find(p=>p.id===o.publicationId)?.publishedAt||'')||0;
  const seen=new Set();
  return [...current.values()].sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)||currentRank(b)-currentRank(a)||published(b)-published(a)||a.evidenceId.localeCompare(b.evidenceId)).filter(o=>{const key=o.kind+':'+o.observedAt;if(seen.has(key))return false;seen.add(key);return true;});
}
function timelineObservation(outlook,now,completion) {
 const o=outlook?.latestObservation;
 if(outlook?.active||!o||!valid(now)||o.kind!=='automatic_reset'||o.sourceType!=='observed'||!['reset-archive','aiplanwatch-reference','codexlimits-observations'].includes(o.sourceId)||o.sourceUrl!==(o.sourceId==='reset-archive'?archive:o.sourceId==='codexlimits-observations'?codexLimits:reference)||!valid(o.observedAt)||!valid(o.collectedAt)||Date.parse(o.observedAt)>Date.parse(o.collectedAt)||Date.parse(o.collectedAt)>Date.parse(now)||Date.parse(now)-Date.parse(o.observedAt)>=86400000||completion&&Date.parse(completion.statementAt)>=Date.parse(o.observedAt))return null;
 return o;
}
module.exports={observedEvidence,resetObservations,timelineObservation,observedResetText};
