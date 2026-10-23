import {load} from 'cheerio';
import type {Source} from '../lib/types';
import type {Incoming} from './ingestion';

export const CODEX_LIMITS_OBSERVATION_SOURCE:Source={id:'codexlimits-observations',name:'Codex Limits 第三方观测',kind:'archive',url:'https://codexlimits.com/reset-history',enabled:false,validated:false,intervalMinutes:5,collectionPolicy:'manual',version:1,status:'unconnected'};
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const clean=(text:string)=>text.replace(/\s+/g,' ').trim();

/** Only the HTML's explicitly detected observations have minute precision.
 * Reviewed announcements and the separately maintained JSON archive are not
 * evidence of a reset's effective time. No relationship to an X post is inferred. */
export function parseCodexLimitsObservations(html:string,collectedAt:string):Incoming[] {
 const collected=Date.parse(collectedAt),$=load(html),cards=$('article.archive-event');
 if(!Number.isFinite(collected)||!cards.length||cards.length>1000)throw new Error('CODEX_LIMITS_STRUCTURE_INVALID');
 const rows=new Map<string,Incoming>();
 cards.each((_,element)=>{
  const card=$(element);
  if(card.attr('data-type')==='global'&&/Third-party observation/i.test(card.text())&&(!card.hasClass('pending-history-row')||clean(card.find('.pending-badge').text())!=='Detected'))throw new Error('CODEX_LIMITS_OBSERVATION_STRUCTURE_INVALID');
  if(!card.hasClass('pending-history-row')||card.attr('data-type')!=='global'||clean(card.find('.pending-badge').text())!=='Detected')return;
  const title=clean(card.find('h2').text()),summary=clean(card.find('.archive-event-body > p').text());
  const stamp=summary.match(/^Third-party observation on (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{2}):(\d{2}) UTC\.$/);
  const date=card.find('.archive-date > span'),year=clean(date.eq(1).text());
  const link=card.find('.archive-event-footer a');
  if(title!=='Usage reset landed'||clean(card.find('.pill').text())!=='Public reset'||!stamp||!/^(?:20\d{2})$/.test(year)||clean(date.eq(0).text())!==`${stamp[1]} ${Number(stamp[2])}`||link.length!==1||!['/reset-history',CODEX_LIMITS_OBSERVATION_SOURCE.url].includes(link.attr('href')??''))throw new Error('CODEX_LIMITS_OBSERVATION_INVALID');
  const month=months.indexOf(stamp[1]),day=Number(stamp[2]),hour=Number(stamp[3]),minute=Number(stamp[4]);
  const time=Date.UTC(Number(year),month,day,hour,minute),parsed=new Date(time);
  if(parsed.getUTCFullYear()!==Number(year)||parsed.getUTCMonth()!==month||parsed.getUTCDate()!==day||hour>23||minute>59||time>collected)throw new Error('CODEX_LIMITS_OBSERVATION_TIME_INVALID');
  const occurredAt=parsed.toISOString(),messageId=`observed-codexlimits-${time}`;
  const record:Incoming={sourceId:CODEX_LIMITS_OBSERVATION_SOURCE.id,messageId,url:CODEX_LIMITS_OBSERVATION_SOURCE.url,text:`${title}\n${summary}`,publishedAt:occurredAt,collectedAt,contextComplete:false,provenance:'archive',textOrigin:'archive_excerpt',metadata:{category:'reset',sourceGroup:'codexlimits',benefitKind:'automatic_reset',referenceReset:{eventId:`codexlimits:automatic_reset:${occurredAt}`,occurredAt,referenceUrl:CODEX_LIMITS_OBSERVATION_SOURCE.url,summary,
   // The source supplies no generated-at field: this is our HTTP snapshot time.
   snapshotAt:collectedAt}}};
  rows.set(messageId,record);
 });
 return [...rows.values()].sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt));
}
