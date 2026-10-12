import type {Evidence} from './types';
import {isHistoricalEvidence} from './history';

export interface StoredCollectionInput {evidence:Evidence;storedAt:string;}
export interface CollectionTiming {
 messageId:string;url:string;sourcePublishedAt:string;firstCollectedAt:string;firstStoredAt:string;
 measurement:'in_window'|'backfill'|'invalid_time';sourceToStorageMs:number|null;
}
export interface CollectionObservation {
 ruleVersion:'collection-storage-v1';startedAt:string;checkedAt:string;
 measuredMessages:number;backfillMessages:number;invalidMessages:number;
 medianSourceToStorageMs:number|null;maximumSourceToStorageMs:number|null;
 storageTimestampMeaning:'postgres_transaction_created_at';
 completeTimelineCoverage:'NOT_MEASURED';upstreamAvailabilityDelay:'NOT_MEASURED';records:CollectionTiming[];
}

/** Retain the original anchor and reject partial or time-reversed journals. */
export function validateCollectionObservationJournal(raw:string,startedAt:string,time:string):void {
 const start=Date.parse(startedAt),at=Date.parse(time);
 if(!Number.isFinite(start)||!Number.isFinite(at)||start>at)throw new Error('采集观察窗口无效');
 if(!raw)return;
 if(!raw.endsWith('\n'))throw new Error('采集观察日志存在未完成行');
 let previous=start;
 for(const line of raw.slice(0,-1).split('\n')){
  const sample=JSON.parse(line),checked=Date.parse(sample?.checkedAt);
  if(sample?.ruleVersion!=='collection-storage-v1'||sample.startedAt!==startedAt||!Number.isFinite(checked)||checked<previous||checked>at)throw new Error('采集观察日志身份或时间无效');
  previous=checked;
 }
}

/** Measure the first stored row's transaction timestamp, not request-start
 * time, exact commit time, or upstream availability.
 * A later revision cannot replace a post's first receipt or count it twice. */
export function evaluateCollectionObservation(input:{startedAt:string;time:string;rows:StoredCollectionInput[]}):CollectionObservation {
 const start=Date.parse(input.startedAt),at=Date.parse(input.time);
 if(!Number.isFinite(start)||!Number.isFinite(at)||at<start)throw new Error('采集观察窗口无效');
 const groups=new Map<string,StoredCollectionInput[]>();
 for(const row of input.rows){
  const e=row.evidence;
  if(e.sourceId!=='tibo-public'||e.provenance!=='archive'||e.textOrigin!=='original'||e.metadata?.sourceGroup!=='fxembed:thsottiaux')continue;
  if(!/^[1-9]\d{0,19}$/.test(e.messageId)||e.url!==`https://x.com/thsottiaux/status/${e.messageId}`)continue;
  const old=groups.get(e.messageId)??[];old.push(row);groups.set(e.messageId,old);
 }
 const records:CollectionTiming[]=[];
 for(const rows of groups.values()){
  if(!rows.some(row=>Date.parse(row.storedAt)>=start||Date.parse(row.evidence.publishedAt)>=start))continue;
  // Do not sort malformed values into an apparently valid first receipt.
  const invalid=rows.some(row=>!Number.isFinite(Date.parse(row.storedAt))||!Number.isFinite(Date.parse(row.evidence.publishedAt))||!Number.isFinite(Date.parse(row.evidence.collectedAt)));
  const ordered=[...rows].sort((a,b)=>Date.parse(a.storedAt)-Date.parse(b.storedAt));
  const first=ordered[0],e=first.evidence,published=Date.parse(e.publishedAt),stored=Date.parse(first.storedAt),collected=Date.parse(e.collectedAt);
  const snowflake=Number((BigInt(e.messageId)>>22n)+1288834974657n);
  const badTime=invalid||rows.some(row=>row.evidence.publishedAt!==e.publishedAt)||Math.abs(published-snowflake)>1000||stored<published||collected>stored||stored>at||published>at;
  const measurement=badTime?'invalid_time':published<start||stored<start||isHistoricalEvidence(e)?'backfill':'in_window';
  records.push({messageId:e.messageId,url:e.url,sourcePublishedAt:e.publishedAt,firstCollectedAt:e.collectedAt,firstStoredAt:first.storedAt,measurement,sourceToStorageMs:measurement==='in_window'?stored-published:null});
 }
 records.sort((a,b)=>a.messageId.length-b.messageId.length||a.messageId.localeCompare(b.messageId));
 const delays=records.flatMap(row=>row.sourceToStorageMs===null?[]:[row.sourceToStorageMs]).sort((a,b)=>a-b),n=delays.length;
 return {ruleVersion:'collection-storage-v1',startedAt:input.startedAt,checkedAt:input.time,measuredMessages:n,
  backfillMessages:records.filter(row=>row.measurement==='backfill').length,invalidMessages:records.filter(row=>row.measurement==='invalid_time').length,
  medianSourceToStorageMs:n?(delays[Math.floor((n-1)/2)]+delays[Math.floor(n/2)])/2:null,maximumSourceToStorageMs:n?delays[n-1]:null,
  storageTimestampMeaning:'postgres_transaction_created_at',completeTimelineCoverage:'NOT_MEASURED',upstreamAvailabilityDelay:'NOT_MEASURED',records};
}
