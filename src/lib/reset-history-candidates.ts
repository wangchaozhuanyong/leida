import type {ActionKind,Evidence} from './types';

export const RESET_HISTORY_DISCOVERY_REF='dcc002033a28e50c13d1248ee9650dd6c3fd7260';
export const RESET_HISTORY_DISCOVERY_URL=`https://api.github.com/repos/gdutxiaoxu/codex-reset-radar/contents/data/resets.json?ref=${RESET_HISTORY_DISCOVERY_REF}`;
export interface HistoryClaim {eventId:string;kind:ActionKind|'unspecified';occurredAt:string;timePrecision:'date'|'timestamp';}
export interface ResetHistoryCandidate {
 id:string;url:string;messageId:string;sourceClaims:HistoryClaim[];
 listedKind:ActionKind|'unspecified';typeConflict:boolean;duplicateCount:number;
 originalPublishedAt:string;
 reviewStatus:'pending';trainingEligible:false;
}
export interface ResetHistoryDiscovery {
 schemaVersion:1;sourceGeneratedAt:string;cutoffAt:string;
 candidates:ResetHistoryCandidate[];
 rejected:{index:number;eventId?:string;reason:string}[];
}
export interface HistoryCacheOriginCorrection {id:string;url:string;sourceId:string;from:'original';to:'archive_excerpt';reason:string;}
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
export function historyTimestamp(value:unknown):number {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN;
 const [year,month,day]=value.slice(0,10).split('-').map(Number);
 if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59)return NaN;
 return Date.parse(value);
}
export function historyPostIdentity(value:unknown):{url:string;messageId:string;publishedAt:string}|undefined {
 if(typeof value!=='string')return;
 try{
  const url=new URL(value);
  if(url.protocol!=='https:'||!['x.com','twitter.com'].includes(url.hostname)||url.port||url.username||url.password||url.search||url.hash)return;
  const id=url.pathname.match(/^\/thsottiaux\/status\/(\d{15,20})\/?$/)?.[1];if(!id)return;
  const identity=BigInt(id);if(identity<=0n||identity>0xffffffffffffffffn)return;
  const at=Number((identity>>22n)+1288834974657n);
  if(!Number.isSafeInteger(at))return;
  return {url:`https://x.com/thsottiaux/status/${id}`,messageId:id,publishedAt:new Date(at).toISOString()};
 }catch{return;}
}
export function prepareResetHistoryCandidates(input:unknown,cutoffAt:string):ResetHistoryDiscovery {
 const root=object(input),cutoff=historyTimestamp(cutoffAt);
 if(!Number.isFinite(cutoff))throw new Error('历史核对截止时间无效');
 if(root?.schema_version!==1||!Number.isFinite(historyTimestamp(root.generated_at))||!Array.isArray(root.events)||root.events.length>1000)throw new Error('历史清单结构或数量上限无效');
 if(historyTimestamp(root.generated_at)>cutoff)throw new Error('历史清单生成时间晚于核对截止');
 const grouped=new Map<string,ResetHistoryCandidate>(),rejected:ResetHistoryDiscovery['rejected']=[];
 for(const [index,value] of root.events.entries()){
  const row=object(value),source=object(row?.source),identity=historyPostIdentity(source?.url);
  const eventId=typeof row?.event_id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(row.event_id)?row.event_id:undefined;
  if(!eventId||!identity||row?.record_status!=='recorded'||!['global','banked','unknown'].includes(String(row?.reset_type))){rejected.push({index,...(eventId?{eventId}:{}),reason:'条目身份、作者原帖或类型结构无效'});continue;}
  const occurredAt=row!.occurred_at;
  const dateOnly=typeof occurredAt==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(occurredAt);
  const at=dateOnly?historyTimestamp(`${occurredAt}T00:00:00Z`):historyTimestamp(occurredAt);
  if(!Number.isFinite(at)||at>cutoff||historyTimestamp(identity.publishedAt)>cutoff){rejected.push({index,eventId,reason:'条目日期无效或晚于核对截止'});continue;}
  const kind=row!.reset_type==='global'?'automatic_reset':row!.reset_type==='banked'?'banked_reset':'unspecified';
  const midnight=dateOnly||/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?Z$/.test(String(occurredAt));
  const claim:HistoryClaim={eventId,kind,occurredAt:String(occurredAt),timePrecision:midnight?'date':'timestamp'};
  const previous=grouped.get(identity.url);
  if(previous){
   previous.sourceClaims.push(claim);previous.duplicateCount++;
   const kinds=new Set(previous.sourceClaims.map(item=>item.kind).filter(item=>item!=='unspecified'));
   previous.typeConflict=kinds.size>1;previous.listedKind=kinds.size===1?[...kinds][0]:'unspecified';
  }else grouped.set(identity.url,{id:`history:${identity.messageId}`,url:identity.url,messageId:identity.messageId,sourceClaims:[claim],listedKind:kind,typeConflict:false,duplicateCount:0,originalPublishedAt:identity.publishedAt,reviewStatus:'pending',trainingEligible:false});
 }
 return {schemaVersion:1,sourceGeneratedAt:String(root.generated_at),cutoffAt,candidates:[...grouped.values()].sort((a,b)=>a.originalPublishedAt.localeCompare(b.originalPublishedAt)),rejected};
}

/** Whitelist only public evidence fields. Never serialize an entire old package. */
export function publicHistoryEvidence(input:unknown,cutoffAt:string,onOriginCorrection?:(correction:HistoryCacheOriginCorrection)=>void):Evidence[] {
 const root=object(input),records=object(root?.records),data=object(root?.data);
 const rows=Array.isArray(input)?input:Array.isArray(root?.records)?root.records:Array.isArray(root?.evidence)?root.evidence:Array.isArray(records?.evidence)?records.evidence:Array.isArray(data?.evidence)?data.evidence:[];
 const cutoff=historyTimestamp(cutoffAt),result:Evidence[]=[];
 if(!Number.isFinite(cutoff))return result;
 for(const raw of rows){
  const row=object(raw),identity=historyPostIdentity(row?.url);
  if(!row||!identity||typeof row.text!=='string'||!row.text.trim()||row.text.length>30000||!['archive','official'].includes(String(row.provenance))||!['original','structured','archive_excerpt'].includes(String(row.textOrigin))||typeof row.sourceId!=='string'||!/^[-a-z0-9_]{1,100}$/i.test(row.sourceId))continue;
  const published=historyTimestamp(row.publishedAt),collected=historyTimestamp(row.collectedAt);
  if(!Number.isFinite(published)||!Number.isFinite(collected)||published>cutoff||collected>cutoff||collected<published||Math.abs(published-historyTimestamp(identity.publishedAt))>1000)continue;
  if(row.messageId!==identity.messageId)continue;
  const metadata=object(row.metadata),sourceGroup=typeof metadata?.sourceGroup==='string'&&['fxembed:thsottiaux','x-api:thsottiaux','codex-resets','history-oembed:thsottiaux'].includes(metadata.sourceGroup)?metadata.sourceGroup:undefined;
  const parentId=typeof row.parentId==='string'&&/^\d{15,20}$/.test(row.parentId)&&BigInt(row.parentId)<BigInt(identity.messageId)?row.parentId:undefined;
  const id=typeof row.id==='string'&&/^[A-Za-z0-9_:.+-]{1,180}$/.test(row.id)?row.id:`history-cache:${identity.messageId}:${collected}`;
  // The fixed Chinese archive supplies translated summaries. Its old cache
  // marker is not proof that this Chinese body was the author's original post.
  const translatedArchive=row.textOrigin==='original'&&row.sourceId==='reset-archive'&&row.provenance==='archive'&&sourceGroup==='codex-resets'&&/\p{Script=Han}/u.test(row.text);
  const textOrigin=translatedArchive?'archive_excerpt':row.textOrigin as Evidence['textOrigin'];
  if(translatedArchive)onOriginCorrection?.({id,url:identity.url,sourceId:row.sourceId,from:'original',to:'archive_excerpt',reason:'固定中文归档译文缺少作者原文保真依据，撤销旧original标记；正文与来源身份完整保留。'});
  result.push({id,sourceId:row.sourceId,messageId:identity.messageId,url:identity.url,text:row.text,parentId,publishedAt:new Date(published).toISOString(),collectedAt:new Date(collected).toISOString(),hash:typeof row.hash==='string'&&/^[a-f0-9]{64}$/i.test(row.hash)?row.hash:'',contextComplete:translatedArchive?false:row.contextComplete===true,historical:true,provenance:row.provenance as Evidence['provenance'],textOrigin,metadata:{...(sourceGroup?{sourceGroup}:{}),category:'reset'}});
 }
 return result;
}

/** Re-evaluate an old completeness flag only when the saved original itself is explicit. */
export function refreshHistoryOriginalContext(records:Evidence[],standaloneReset:(text:string)=>boolean):Evidence[] {
 return records.map(record=>record.textOrigin==='original'&&!record.contextComplete&&standaloneReset(record.text)?{...record,contextComplete:true}:record);
}
