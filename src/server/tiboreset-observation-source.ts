import {load} from 'cheerio';
import type {Source} from '../lib/types';
import {TIBORESET_OBSERVATION_ID, TIBORESET_TRACKER, tiboresetBankedObservationText} from '../lib/reset-observations';
import type {Incoming} from './ingestion';

export const TIBORESET_OBSERVATION_SOURCE:Source={
  id:TIBORESET_OBSERVATION_ID,name:'Tibo Reset Tracker 发卡观测',kind:'archive',url:TIBORESET_TRACKER,
  enabled:false,validated:false,intervalMinutes:5,collectionPolicy:'manual',version:1,status:'unconnected',
};

/** Consume the tracker operator's direct observations, not its forecast or copied X announcements. */
export function parseTiboresetObservations(html:string,collectedAt:string):Incoming[] {
  const current=Date.parse(collectedAt), $=load(html), cards=$('#log li.log-item');
  if(!Number.isFinite(current)||!cards.length||cards.length>1000)throw new Error('TIBORESET_STRUCTURE_INVALID');
  const records=new Map<string,Incoming>();
  for(const item of cards.toArray()){
    const card=$(item), link=card.find('.log-item-text a.log-item-title');
    const text=link.text().replace(/\s+/g,' ').trim();
    if(!tiboresetBankedObservationText(text))continue;
    const id=link.attr('href')?.match(/^\/r\/(\d{15,20})$/)?.[1];
    const stamp=card.find('time.log-item-abs');
    const time=Date.parse(stamp.attr('datetime')??'');
    const kind=card.attr('data-kind'), badge=card.find('.log-item-meta .pill').text().trim();
    if(link.length!==1||!id||stamp.length!==1||card.find('a.log-item-link').length||
      !(kind==='other'&&badge==='Note'||kind==='banked'&&badge==='Banked')||
      !Number.isFinite(time)||time>current||Math.floor(Number((BigInt(id)>>22n)+1288834974657n)/1000)!==Math.floor(time/1000)){
      throw new Error('TIBORESET_OBSERVATION_INVALID');
    }
    // This is a live source. Backfilling old reports would overlap older
    // independently recorded batches without their original round linkage.
    if(current-time>48*3600_000)continue;
    const publishedAt=new Date(time).toISOString(), url=new URL('/r/'+id,TIBORESET_TRACKER).href;
    const record:Incoming={sourceId:TIBORESET_OBSERVATION_ID,messageId:'observed-'+id,url,text,publishedAt,collectedAt,
      contextComplete:false,provenance:'archive',textOrigin:'archive_excerpt',
      metadata:{category:'reset',sourceGroup:'tiboreset',benefitKind:'banked_reset',
        referenceReset:{eventId:'tiboreset:banked_reset:'+id,occurredAt:publishedAt,snapshotAt:collectedAt,referenceUrl:url,summary:text}}};
    const previous=records.get(id);
    if(previous&&(previous.publishedAt!==publishedAt||previous.text!==text))throw new Error('TIBORESET_OBSERVATION_CONFLICT');
    records.set(id,record);
  }
  return [...records.values()].sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt));
}
