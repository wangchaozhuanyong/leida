// Packaged separately for the worker and the WeChat client. Keep this file
// identical to its counterpart; the round-evidence regression checks both.
/** @typedef {import('../../src/lib/types').BenefitAction} BenefitAction */
/** @typedef {import('../../src/lib/types').ActionKind} ActionKind */
/** @typedef {import('../../src/lib/types').Evidence} Evidence */
/** @typedef {import('../../src/lib/types').Publication} Publication */
/** @typedef {import('../../src/lib/types').RadarEvent} RadarEvent */
/** @typedef {import('../../src/lib/forecast').ReferencePublicSignal} ReferenceSignal */
/** @typedef {import('../../src/lib/reset-outlook').ResolvedResetRound} ResolvedRound */
/** @typedef {import('../../src/lib/reset-observations').ResetObservation} Observation */
/**
 * @typedef {Pick<BenefitAction,'kind'|'stage'|'statementAt'|'expectedAt'|'timeNote'> &
 *   Partial<Pick<BenefitAction,'eligibility'>> & {
 *   eventId:string, actionId:string, publicationId:string, startAt:string,
 *   hasPromise:boolean, urls:string[], remote:boolean, previousExpectedAt?:string,
 *   statementUrls?:string[],
 *   timingPublicationId?:string, sourceName?:string, sourceUrl?:string,
 *   sourceType?:string, signal?:ReferenceSignal
 * }} Round
 */

const DAY = 86400000;
const valid = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const millis = value => valid(value) ? Date.parse(value) : -Infinity;
/** @param {{eventId:string,actionId:string}} round */
const roundKey = round => round.eventId + ':' + round.actionId;
/** @param {Pick<BenefitAction,'stage'>} round */
const pending = round => round.stage === 'promised' || round.stage === 'in_progress';
/** @param {Pick<BenefitAction,'stage'>} round */
const resolved = round => round.stage === 'claimed_complete' || round.stage === 'cancelled';

/** @param {Round} a @param {Round} b */
function orderRounds(a, b) {
  return millis(b.startAt) - millis(a.startAt) || millis(b.statementAt) - millis(a.statementAt) || roundKey(a).localeCompare(roundKey(b));
}

/**
 * @param {{kind:ActionKind,statementAt:string,id?:string,actionId?:string}} action
 * @param {{kind:ActionKind,statementAt:string,eventId?:string,actionId?:string,announcedAt?:string}|null|undefined} resolution
 * @param {string} [eventId]
 */
function announcementNeedsReview(action, resolution, eventId) {
  if (!resolution || resolution.kind !== action.kind || !(Date.parse(resolution.statementAt) > Date.parse(action.statementAt))) return false;
  // An independently identified round with an evidenced lifecycle cannot close this one.
  const actionId = action.actionId || action.id;
  const differentRound = eventId && resolution.eventId && (eventId !== resolution.eventId || (actionId && resolution.actionId && actionId !== resolution.actionId));
  return !(differentRound && resolution.announcedAt && Date.parse(resolution.announcedAt) < Date.parse(action.statementAt));
}

/** @param {Round[]} rounds */
function latestResolution(rounds) {
  return rounds.filter(resolved).sort((a, b) => millis(b.statementAt) - millis(a.statementAt))[0];
}

/** @param {Round[]} rounds @param {Round|undefined} resolution */
function openRounds(rounds, resolution) {
  const latest = resolution && {...resolution, announcedAt: resolution.hasPromise ? resolution.startAt : undefined};
  return rounds.filter(round => pending(round) && ((
    round.eventId === 'signal' && resolution?.eventId === 'signal' && roundKey(round) !== roundKey(resolution)
  ) || !announcementNeedsReview(round, latest, round.eventId)));
}

/**
 * Rebuild the original start and latest supported deadline from visible snapshots.
 * @param {{action:BenefitAction,event:RadarEvent,publication:Publication}[]} facts
 * @param {Publication[]} snapshots Non-withdrawn snapshots of public actions
 * @param {Evidence[]} evidence
 * @param {string} now
 * @param {Partial<Record<ActionKind,ResolvedRound>>} [resolutions]
 * @returns {Round[]}
 */
function publishedRounds(facts, snapshots, evidence, now, resolutions) {
  const current = millis(now);
  const byEvent = new Map();
  for (const snapshot of snapshots) {
    const versions = byEvent.get(snapshot.eventId) || [];
    versions.push(snapshot);
    byEvent.set(snapshot.eventId, versions);
  }
  const eligible = facts.filter(({action, publication}) =>
    valid(action.statementAt) && millis(action.statementAt) <= current &&
    valid(publication.publishedAt) && millis(publication.publishedAt) <= current);
  return eligible.map(({action, event, publication}) => {
    const versions = (byEvent.get(event.id) || [])
      .filter(snapshot => millis(snapshot.publishedAt) <= millis(publication.publishedAt))
      .flatMap(snapshot => snapshot.event.actions.filter(candidate =>
        candidate.id === action.id && candidate.kind === action.kind && candidate.scope === 'public' &&
        valid(candidate.statementAt) && millis(candidate.statementAt) <= current)
        .map(candidate => ({...candidate, publicationId: snapshot.id})))
      .sort((a, b) => millis(a.statementAt) - millis(b.statementAt));
    const promises = versions.filter(pending);
    const timed = promises.filter(item => valid(item.expectedAt)).pop();
    const prior = promises.filter(item => valid(item.expectedAt) && item.publicationId !== publication.id).pop();
    const projected = resolutions?.[action.kind];
    const sameResolution = projected?.publicationId === publication.id && projected.actionId === action.id && projected.stage === action.stage ? projected : null;
    const knownStart = promises[0]?.statementAt || sameResolution?.announcedAt;
    const expectedAt = valid(action.expectedAt) ? action.expectedAt : timed?.expectedAt || sameResolution?.announcedDeadline || '';
    const timeNote = (valid(action.expectedAt) && action.timeNote)
      || (timed?.expectedAt === expectedAt && timed?.timeNote)
      || (sameResolution?.announcedDeadline === expectedAt && sameResolution?.announcedDeadlineNote)
      || action.timeNote || '';
    const ids = new Set(versions.flatMap(item => item.evidenceIds).concat(action.evidenceIds));
    const supporting = evidence.filter(item => ids.has(item.id));
    return {...action, timeNote, actionId:action.id, eventId:event.id, publicationId:publication.id,
      startAt:knownStart || action.statementAt, expectedAt, hasPromise:valid(knownStart), remote:false,
      urls:supporting.map(item => item.url),
      statementUrls:supporting.filter(item => !item.messageId?.startsWith('observed-')).map(item => item.url),
      timingPublicationId:!valid(action.expectedAt) && pending(action) ? timed?.publicationId : undefined,
      previousExpectedAt:prior?.expectedAt && prior.expectedAt !== expectedAt ? prior.expectedAt : ''};
  }).sort(orderRounds);
}

/**
 * @param {ReadonlyArray<ReferenceSignal|undefined>} signals
 * @param {ActionKind} kind
 * @param {string} now
 * @returns {ReferenceSignal[]}
 */
function signalRounds(signals, kind, now) {
  const current = millis(now);
  return signals.filter(signal => {
    const hint = signal?.hint;
    return !!signal && hint?.kind === kind && (signal.cancelled || hint.dayLabel || hint.windowBasis) &&
      valid(signal.publishedAt) && valid(signal.recordedAt) && millis(signal.publishedAt) <= current &&
      millis(signal.recordedAt) <= current && millis(hint.expiresAt) > millis(signal.roundAt || signal.publishedAt);
  }).sort((a, b) => millis(a?.roundAt || a?.publishedAt) - millis(b?.roundAt || b?.publishedAt));
}

/**
 * Merge a verified timing hint into its published round or keep it separate.
 * @param {Round[]} rounds
 * @param {ReferenceSignal} signal
 * @returns {Round[]}
 */
function withSignal(rounds, signal) {
  if (!signal.hint) return rounds;
  const hint=signal.hint;
  const resolution = latestResolution(rounds), open = openRounds(rounds, resolution);
  const startAt=signal.roundAt||signal.publishedAt, anchor=millis(startAt), deadline=millis(hint.expiresAt);
  const urls=[...new Set([signal.sourceUrl,...(signal.roundSourceUrls||[])])];
  const exact=rounds.filter(round=>round.urls.some(url=>urls.includes(url)));
  const related=exact.length?exact:rounds.filter(round=>hint.parentSourceUrl&&round.urls.includes(hint.parentSourceUrl));
  if(related.length>1||related.some(resolved))return rounds;
  if(!signal.cancelled&&resolution&&resolution.eventId!=='signal'&&millis(resolution.statementAt)>=anchor&&
    (!resolution.hasPromise||millis(resolution.startAt)>=anchor))return rounds;
  if(signal.cancelled&&related.length===1){
    return rounds.map(round=>round===related[0]?{...round,stage:'cancelled',statementAt:signal.publishedAt,
      publicationId:'',expectedAt:'',sourceUrl:signal.sourceUrl,sourceName:signal.sourceName,sourceType:'x_post'}:round);
  }
  const active = open[0];
  const fallback=hint.windowBasis==='fallback_48h';
  const linked=related.find(round=>pending(round)&&round.eventId!=='signal');
  const compatible=!related.length&&open.length===1&&active?.stage==='in_progress'&&
    millis(active.statementAt)>=anchor&&millis(active.statementAt)<=deadline+(fallback?0:DAY);
  const target=linked??(compatible?active:undefined);
  if(target&&!signal.cancelled){
    const timed=valid(target.expectedAt);
    if(timed&&!(linked&&hint.windowBasis==='source_time'&&millis(signal.publishedAt)>millis(target.statementAt)))return rounds;
    return rounds.map(round=>round===target?{...round,startAt:millis(round.startAt)<anchor?round.startAt:startAt,
      expectedAt:hint.expiresAt,previousExpectedAt:timed&&target.expectedAt!==hint.expiresAt?target.expectedAt:'',
      timeNote:hint.timeNote||'',urls:[...new Set([...round.urls,...urls])],
      statementUrls:[...new Set([...(round.statementUrls||[]),...urls])],signal}:round).sort(orderRounds);
  }
  if(active&&!signal.cancelled&&fallback&&!active.signal&&valid(active.expectedAt)&&
    millis(active.startAt)<=anchor&&roundExpiry(active)>millis(signal.recordedAt))return rounds;
  return [...rounds,{kind:hint.kind,stage:signal.cancelled?'cancelled':'promised',actionId:signal.id,eventId:'signal',publicationId:'',
    statementAt:signal.publishedAt,startAt,expectedAt:signal.cancelled?'':hint.expiresAt,remote:false,
    hasPromise:true,urls,statementUrls:urls,sourceName:signal.sourceName,sourceUrl:signal.sourceUrl,sourceType:'x_post',
    timeNote:hint.timeNote||'',...(signal.cancelled?{}:{signal})}].sort(orderRounds);
}

/** @param {Round} round */
const roundExpiry=round=>millis(round.expectedAt)+(round.signal?.hint?.windowBasis==='fallback_48h'?0:DAY);

/** @param {Round[]} rounds @param {Observation[]} observations Both arrays contain one benefit kind. */
function assignObservations(rounds, observations) {
  /** @type {Map<string,Observation[]>} */
  const assignments = new Map();
  /** @type {Observation[]} */
  const independent = [], unassigned = [];
  // Match earlier observations first so a resolved round does not compete with a later arrangement.
  for (const observation of observations.slice().sort((a, b) => millis(a.observedAt) - millis(b.observedAt))) {
    const observedAt = millis(observation.observedAt);
    const postReference = observation.referenceUrl && observation.referenceUrl !== observation.sourceUrl;
    const eligible=rounds.filter(round=>round.stage!=='cancelled'&&(!round.hasPromise||observedAt>=millis(round.startAt)));
    const byPost=postReference?eligible.filter(round=>round.urls.includes(observation.referenceUrl)):[];
    const explicit=byPost.length?byPost:eligible.filter(round=>round.eventId===observation.eventId);
    const resolution = rounds.filter(round => resolved(round) && millis(round.statementAt) <= observedAt)
      .sort((a, b) => millis(b.statementAt) - millis(a.statementAt))[0];
    const latest = resolution && {...resolution, announcedAt:resolution.hasPromise ? resolution.startAt : undefined};
    // An explicit reference can point to a round outside a compact snapshot.
    // Never infer a different published round from its timing.
    const possible = rounds.filter(round => {
      const otherPost = postReference && !round.urls.includes(observation.referenceUrl)
        && round.statementUrls?.some(url => /^https:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(url));
      const sharedSource = round.statementUrls?.includes(observation.sourceUrl);
      return !otherPost && !sharedSource && round.stage !== 'cancelled' && round.hasPromise && observedAt >= millis(round.startAt)
      && !announcementNeedsReview(round, latest, round.eventId)
      && (valid(round.expectedAt) ? observedAt <= roundExpiry(round)
        : pending(round) || (round.stage === 'claimed_complete' && millis(round.statementAt) >= observedAt
          && millis(round.statementAt) - observedAt <= DAY));
    });
    const candidates = explicit.length ? explicit : possible.filter(round => {
      const prior = assignments.get(roundKey(round));
      if (!prior?.length) return true;
      const first = millis(prior[0].observedAt);
      return !possible.some(other => roundKey(other) !== roundKey(round) && millis(other.startAt) > first);
    });
    if (candidates.length === 1) {
      const key = roundKey(candidates[0]);
      assignments.set(key, [...(assignments.get(key) || []), observation]);
    } else {
      independent.push(observation);
      if (!candidates.length) unassigned.push(observation);
    }
  }
  const newestFirst = (a, b) => millis(b.observedAt) - millis(a.observedAt);
  return {assignments, independent:independent.sort(newestFirst), unassigned:unassigned.sort(newestFirst)};
}

module.exports = {announcementNeedsReview, assignObservations, latestResolution, openRounds,
  orderRounds, pending, publishedRounds, roundExpiry, roundKey, signalRounds, withSignal};
