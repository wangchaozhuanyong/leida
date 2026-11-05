import {announcementNeedsReview, type ResetOutlook} from './reset-outlook';
import type {Evidence,Notice,Publication,RadarEvent} from './types';
import {observedEvidence,resetObservations} from './reset-observations';
import {publicActions,type PublicFactsData} from './public-facts';

const resultLifetime=24*3600_000;
const recentResult=(at:string,now:string)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=Date.parse(now)&&Date.parse(now)-Date.parse(at)<resultLifetime;

/** Same explicit event/post identity used by the public outlook. A source index
 * or temporal proximity alone must never cancel another round's announcement. */
function hasRoundObservation(action:RadarEvent['actions'][number],eventId:string,data:PublicFactsData):boolean {
  const pending=publicActions(data).filter(item=>item.action.kind===action.kind&&['promised','in_progress'].includes(item.action.stage));
  return resetObservations(data).some(observation=>{
    if(observation.kind!==action.kind||Date.parse(observation.observedAt)<Date.parse(action.statementAt))return false;
    const candidates=pending.filter(item=>Date.parse(item.action.statementAt)<=Date.parse(observation.observedAt)&&
      (item.event.id===observation.eventId||observation.referenceUrl!==observation.sourceUrl&&item.action.evidenceIds.some(id=>data.evidence.some(e=>e.id===id&&e.url===observation.referenceUrl))));
    return candidates.length===1&&candidates[0].event.id===eventId&&candidates[0].action.id===action.id;
  });
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
export function reminderContentCurrent(notice:Notice, publication:Publication, event:RadarEvent|undefined, now:string,resolutions?:ResetOutlook['latestResolutions'],evidence:Evidence[]=[],data?:PublicFactsData):boolean {
  if(notice.status!=='active'||!event||event.status!=='published')return false;
  if(!Number.isFinite(Date.parse(now))||Date.parse(notice.createdAt)>Date.parse(now)||Date.parse(publication.publishedAt)>Date.parse(now))return false;
  if(notice.categories.includes('correction'))return true;
  if(publication.article.historical)return false;
  const observation=notice.categories.includes('result')?reminderObservation(publication,evidence,now):undefined;
  if(observation)return recentResult(observation.observedAt,now);
  if(publication.mode==='news_only'||publication.article.publicationMode==='news_only')return false;
  const actions=publication.event.actions.filter(action=>action.scope==='public'&&publication.article.evidenceIds.some(id=>action.evidenceIds.includes(id)));
  // Legacy imported notices without typed actions retain their existing contract.
  if(!actions.length)return publication.event.actions.length===0&&(!notice.categories.includes('result')||recentResult(notice.createdAt,now));
  const stage=notice.categories.includes('result')?'claimed_complete':notice.categories.includes('announcement')?'pending':undefined;
  if(!stage)return false;
  return actions.some(action=>{
    if(stage==='claimed_complete')return action.stage==='claimed_complete'&&recentResult(action.statementAt,now)&&event.actions.some(current=>current.id===action.id&&current.kind===action.kind&&current.stage==='claimed_complete');
    if(!['promised','in_progress'].includes(action.stage)||announcementNeedsReview(action,resolutions?.[action.kind],event.id))return false;
    if(action.expectedAt&&Date.parse(action.expectedAt)<=Date.parse(now))return false;
    if(data&&hasRoundObservation(action,event.id,data))return false;
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
