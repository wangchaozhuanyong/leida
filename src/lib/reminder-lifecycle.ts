import {announcementNeedsReview, type ResetOutlook} from './reset-outlook';
import type {Evidence,Notice,Publication,RadarEvent} from './types';
import {observedEvidence,resetObservations,resetObservationSources} from './reset-observations';
import {isNewsOnly,publicationWithdrawn,publicActions,type PublicFactsData} from './public-facts';
import type {ReferencePublicSignal} from './forecast';
import {assignObservations,publishedRounds,roundKey,signalRounds,withSignal} from './round-evidence.cjs';

const reminderLifetime=24*3600_000;
const recentStatement=(at:string,now:string)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=Date.parse(now)&&Date.parse(now)-Date.parse(at)<reminderLifetime;

/** Compute once per facts snapshot, using the same round assignment as the homepage. */
export function observedReminderRounds(data:PublicFactsData,resolutions?:ResetOutlook['latestResolutions'],signals:ReadonlyArray<ReferencePublicSignal|undefined>=[]):ReadonlySet<string> {
  const observations=resetObservationSources(data);
  if(!observations.length&&!signals.some(signal=>signal?.cancelled))return new Set();
  const facts=publicActions(data);
  const snapshots=data.publications.filter(publication=>!isNewsOnly(publication)&&!publicationWithdrawn(data,publication));
  const observed=new Set<string>();
  for(const kind of ['automatic_reset','banked_reset'] as const){
    const reports=observations.filter(observation=>observation.kind===kind);
    const signalsForKind=signalRounds(signals,kind,data.serverTime);
    if(!reports.length&&!signalsForKind.some(signal=>signal.cancelled))continue;
    const published=publishedRounds(facts.filter(item=>item.action.kind===kind),snapshots,data.evidence,data.serverTime,resolutions);
    const rounds=signalsForKind.reduce(withSignal,published);
    const {assignments}=assignObservations(rounds,reports);
    for(const key of assignments.keys())observed.add(key);
    const publishedKeys=new Set(published.filter(round=>round.stage!=='cancelled').map(roundKey));
    for(const round of rounds)if(round.stage==='cancelled'&&publishedKeys.has(roundKey(round)))observed.add(roundKey(round));
  }
  return observed;
}

/** Reuse the same strict source proof and occurrence identity as the public calendar. */
export function reminderObservationEvidence(evidence:Evidence[],ids:string[],now:string) {
  const observations=evidence.filter(item=>ids.includes(item.id)).map(item=>observedEvidence(item,now)).filter(item=>item!==null);
  return new Set(observations.map(item=>`${item.kind}:${item.observedAt}`)).size===1?observations[0]:undefined;
}
export function reminderObservation(publication:Publication,evidence:Evidence[],now:string) {
  if(publication.mode!=='news_only'&&publication.article.publicationMode!=='news_only')return;
  if(publication.article.category!=='reset'||!reminderObservationEvidence(evidence,publication.article.evidenceIds,now))return;
  return resetObservations({events:[publication.event],articles:[publication.article],publications:[publication],evidence,serverTime:now})[0];
}

/** Match the record view's observation-only date summary for reminder delivery.
 * This bucket does not identify an actual reset round or include confirmed actions. */
export function reminderObservationBucket(publication:Publication,evidence:Evidence[],now:string) {
  const observation=reminderObservation(publication,evidence,now);
  if(observation)return `${observation.kind}:${new Date(Date.parse(observation.observedAt)+8*3600_000).toISOString().slice(0,10)}`;
}

/** Content validity, independent of delivery credit and reader authorization. */
export function reminderContentCurrent(notice:Notice, publication:Publication, event:RadarEvent|undefined, now:string,resolutions?:ResetOutlook['latestResolutions'],evidence:Evidence[]=[],observedRounds?:ReadonlySet<string>):boolean {
  if(notice.status!=='active'||!event||event.status!=='published')return false;
  const currentTime=Date.parse(now);
  if(!Number.isFinite(currentTime)||Date.parse(notice.createdAt)>currentTime||Date.parse(publication.publishedAt)>currentTime)return false;
  if(notice.categories.includes('correction'))return true;
  if(publication.article.historical)return false;
  const observation=notice.categories.includes('result')?reminderObservation(publication,evidence,now):undefined;
  if(observation)return recentStatement(observation.observedAt,now);
  if(publication.mode==='news_only'||publication.article.publicationMode==='news_only')return false;
  const actions=publication.event.actions.filter(action=>action.scope==='public'&&publication.article.evidenceIds.some(id=>action.evidenceIds.includes(id)));
  // Imported notices without typed actions use the saved notice time.
  if(!actions.length)return publication.event.actions.length===0&&recentStatement(notice.createdAt,now);
  const stage=notice.categories.includes('result')?'claimed_complete':notice.categories.includes('announcement')?'pending':undefined;
  if(!stage)return false;
  return actions.some(action=>{
    if(stage==='claimed_complete')return action.stage==='claimed_complete'&&recentStatement(action.statementAt,now)&&event.actions.some(current=>current.id===action.id&&current.kind===action.kind&&current.stage==='claimed_complete');
    if(!['promised','in_progress'].includes(action.stage)||announcementNeedsReview(action,resolutions?.[action.kind],event.id))return false;
    // An untimed progress notice must not hold a credit indefinitely after an outage.
    const deadline=Date.parse(action.expectedAt??'');
    if(Number.isFinite(deadline)?deadline<=currentTime:!recentStatement(action.statementAt,now))return false;
    if(observedRounds?.has(roundKey({eventId:event.id,actionId:action.id})))return false;
    return event.actions.some(current=>current.id===action.id&&current.kind===action.kind&&['promised','in_progress'].includes(current.stage)&&current.expectedAt===action.expectedAt&&Date.parse(current.statementAt)===Date.parse(action.statementAt));
  });
}

/** Late processing cannot turn a message from before consent into a new event. */
export function reminderStatementAt(notice:Notice,publication:Publication,evidence:Evidence[]=[]):string {
 if(notice.categories.includes('correction'))return notice.createdAt;
 const observation=notice.categories.includes('result')?reminderObservation(publication,evidence,notice.createdAt):undefined;
 if(observation)return observation.observedAt;
 const relevant=publication.event.actions.filter(a=>a.scope==='public'&&publication.article.evidenceIds.some(id=>a.evidenceIds.includes(id))&&(notice.categories.includes('result')?a.stage==='claimed_complete':['promised','in_progress'].includes(a.stage)));
 return relevant.map(a=>a.statementAt).filter(at=>Number.isFinite(Date.parse(at))).sort((a,b)=>Date.parse(b)-Date.parse(a))[0]??notice.createdAt;
}
