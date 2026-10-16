import type {Evidence,RadarEvent,Source} from '../lib/types';

export const SOURCE_BURST_MS=2*3600_000;
export const sourceForecastConfiguration=(source:Source)=>{const schedule=sourceCollectionSchedule(source);return JSON.stringify([source.enabled,source.validated,source.publicationPaused===true,source.pauseReason??null,source.kind,source.url,schedule.intervalMinutes,schedule.effectiveIntervalMinutes,schedule.collectionPolicy,source.status]);};
export interface SourceCollectionWindow {identity:string;startsAt:string;endsAt:string;}
const normalMinutes=(source:Source)=>source.id==='tibo-public'?10:source.kind==='releases'?360:30;
const supported=(source:Source)=>source.id==='tibo-public'||['official-status','official-releases','reset-archive','activity-archive'].includes(source.id)||source.kind==='activity'&&source.discoveredFrom==='reset-archive';

/** Recognise only old shipped defaults. A saved custom interval remains manual. */
export function sourceCollectionSchedule(source:Source,timestamp=Date.now()):Pick<Source,'intervalMinutes'|'collectionPolicy'|'effectiveIntervalMinutes'> {
 const legacy=source.id==='tibo-public'?2:5,normal=normalMinutes(source);
 const adaptive=supported(source)&&source.collectionPolicy!=='manual'&&(source.collectionPolicy==='adaptive'||source.intervalMinutes===legacy||source.intervalMinutes===normal);
 if(!adaptive)return {intervalMinutes:source.intervalMinutes,collectionPolicy:'manual',effectiveIntervalMinutes:source.intervalMinutes};
 const window=source.collectionWindow;
 const active=!!window&&Date.parse(window.startsAt)<=timestamp&&timestamp<Date.parse(window.endsAt)&&Date.parse(window.endsAt)-Date.parse(window.startsAt)<=SOURCE_BURST_MS;
 const accelerated=source.kind==='status'?source.hasActiveIncident===true:active;
 const effective=accelerated?(source.id==='tibo-public'?2:source.kind==='archive'||source.kind==='activity'||source.kind==='status'?5:normal):normal;
 return {intervalMinutes:normal,collectionPolicy:'adaptive',effectiveIntervalMinutes:effective};
}

/** Only a published public action with its literal original evidence opens a burst. */
export function verifiedCollectionWindow(events:RadarEvent[],evidence:Evidence[],timestamp=Date.now()):SourceCollectionWindow|undefined {
 const windows:SourceCollectionWindow[]=[];
 for(const event of events){
  if(event.status!=='published')continue;
  for(const kind of ['automatic_reset','banked_reset'] as const){
   const latest=event.actions.filter(action=>action.kind===kind&&action.scope==='public'&&Date.parse(action.statementAt)<=timestamp).reverse().sort((a,b)=>Date.parse(b.statementAt)-Date.parse(a.statementAt))[0];
   if(!latest||!['promised','in_progress'].includes(latest.stage)||!latest.evidenceQuote)continue;
   const verified=latest.evidenceIds.some(id=>{const item=evidence.find(row=>row.id===id);return item&&item.provenance!=='manual'&&item.textOrigin==='original'&&item.text.includes(latest.evidenceQuote!)&&/^https:\/\/(?:x|twitter)\.com\/thsottiaux\/status\/\d+(?:[?#].*)?$/.test(item.url)&&Date.parse(item.publishedAt)<=timestamp&&Date.parse(item.collectedAt)<=timestamp;});
   if(!verified)continue;
   const statement=Date.parse(latest.statementAt),expected=Date.parse(latest.expectedAt??'');
   const startsAt=latest.stage==='promised'&&Number.isFinite(expected)?Math.max(statement,expected-3600_000):statement;
   const endsAt=startsAt+SOURCE_BURST_MS;
   if(endsAt<=timestamp)continue;
   windows.push({identity:`${event.id}:${latest.id}:${latest.statementAt}`,startsAt:new Date(startsAt).toISOString(),endsAt:new Date(endsAt).toISOString()});
  }
 }
 return windows.sort((a,b)=>Number(Date.parse(a.startsAt)>timestamp)-Number(Date.parse(b.startsAt)>timestamp)||Date.parse(b.endsAt)-Date.parse(a.endsAt))[0];
}

export function sourceNextCollectionAt(source:Source,timestamp=Date.now()):string {
 const schedule=sourceCollectionSchedule(source,timestamp);
 const next=timestamp+(source.pauseReason==='structure'?15:schedule.effectiveIntervalMinutes!)*60_000;
 const starts=Date.parse(source.collectionWindow?.startsAt??'');
 return new Date(schedule.collectionPolicy==='adaptive'&&!source.pauseReason&&starts>timestamp&&['timeline','archive','activity'].includes(source.kind)?Math.min(next,starts):next).toISOString();
}
