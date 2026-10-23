import {z} from 'zod';
import {observedResetText} from '../lib/reset-observations';
import type {Evidence,Source} from '../lib/types';
import type {Incoming} from './ingestion';
import type {BenefitClaim} from './benefit-rules';
import {isTruncatedBenefitText} from './benefit-rules';
import {forecastSourceAvailable,referenceSnapshotFresh,type ReferencePublicSignal} from '../lib/forecast';
import {CODEX_LIMITS_OBSERVATION_SOURCE} from './codexlimits-observation-source';

export const REFERENCE_DATA_ROOT='https://raw.githubusercontent.com/gdutxiaoxu/codex-reset-radar/master/data';
export const REFERENCE_RESET_SOURCE:Source={id:'aiplanwatch-reference',name:'AIPlanWatch 公开数据对账',kind:'archive',url:`${REFERENCE_DATA_ROOT}/latest.json`,enabled:false,validated:false,intervalMinutes:30,collectionPolicy:'manual',version:1,status:'unconnected'};
export const REFERENCE_SIGNAL_SOURCE:Source={...REFERENCE_RESET_SOURCE,id:'aiplanwatch-signals',name:'AIPlanWatch 公开信号对账',url:`${REFERENCE_DATA_ROOT}/signals.json`};
export const REFERENCE_HISTORY_SOURCE:Source={...REFERENCE_RESET_SOURCE,id:'aiplanwatch-history',name:'AIPlanWatch 重置与重置卡对账',url:`${REFERENCE_DATA_ROOT}/resets.json`,intervalMinutes:360};
export const REFERENCE_SOURCES=[REFERENCE_RESET_SOURCE,REFERENCE_SIGNAL_SOURCE,REFERENCE_HISTORY_SOURCE,CODEX_LIMITS_OBSERVATION_SOURCE];
/** The public Contents API serves the same fixed repository files. Keep the
 * canonical source URL/proof unchanged; never derive a request from user input. */
export function referenceContentsURL(source:Source):string|undefined {
 const fixed=[REFERENCE_RESET_SOURCE,REFERENCE_SIGNAL_SOURCE,REFERENCE_HISTORY_SOURCE].find(item=>item.id===source.id&&item.kind===source.kind&&item.url===source.url);
 if(!fixed)return;
 return `https://api.github.com/repos/gdutxiaoxu/codex-reset-radar/contents/data/${fixed.url.slice(REFERENCE_DATA_ROOT.length+1)}?ref=master`;
}
const at=z.string().datetime({offset:true});
const source=z.object({url:z.string().regex(/^https:\/\/x\.com\/thsottiaux\/status\/\d{15,20}$/),label:z.string().optional()});
const record=z.object({event_id:z.string().min(1).max(180),reset_type:z.literal('global'),record_status:z.literal('recorded'),occurred_at:at,source});
const latestSchema=z.object({schema_version:z.literal(1),generated_at:at,last_global_reset:record.nullable(),latest_signal:z.object({signal_id:z.string(),recorded_at:at,summary:z.string().min(1).max(3000),source}).nullable()});
const signalSchema=z.object({schema_version:z.literal(1),generated_at:at,signals:z.array(z.object({signal_id:z.string().regex(/^\d{15,20}$/),signal_type:z.enum(['forecast_source','reset_announcement']),recorded_at:at,summary:z.string().min(1).max(3000),source})).max(1000)});
const historySchema=z.object({schema_version:z.literal(1),generated_at:at,events:z.array(z.object({event_id:z.string().min(1).max(180),reset_type:z.enum(['global','banked','unknown']),record_status:z.string().min(1).max(40),occurred_at:at,source})).max(1000)});

function archiveSnapshot(generatedAt:string,collectedAt:string) {
 const generated=Date.parse(generatedAt),collected=Date.parse(collectedAt);
 if(!Number.isFinite(collected)||!Number.isFinite(generated)||generated>collected+60000)throw new Error('REFERENCE_SNAPSHOT_TIME_INVALID');
}
/** Versioned archives change only when their data changes. Their original
 * timestamp is retained; stale signal contents never establish live coverage. */
export function referenceCollectionHealth(source:Source,collectedAt:string):Pick<Source,'status'|'error'> {
 const delayed=source.id===REFERENCE_SIGNAL_SOURCE.id&&!referenceSnapshotFresh(source.referenceSnapshotAt,collectedAt);
 return {status:!source.enabled?'paused':delayed?'delayed':'healthy',error:delayed?'公开信号快照尚未更新；旧记录仅供回看，继续定时检查':undefined};
}
export function parseReferenceSignals(value:unknown,collectedAt:string):Incoming[] {
 const data=signalSchema.parse(value);archiveSnapshot(data.generated_at,collectedAt);
 return data.signals.filter(row=>row.signal_type==='forecast_source').map(row=>{
  const messageId=row.source.url.split('/').at(-1)!;
  if(messageId!==row.signal_id||Date.parse(row.recorded_at)>Date.parse(data.generated_at))throw new Error('REFERENCE_SIGNAL_INVALID');
  return {sourceId:REFERENCE_SIGNAL_SOURCE.id,messageId,url:row.source.url,text:row.summary,publishedAt:new Date(Number((BigInt(messageId)>>22n)+1288834974657n)).toISOString(),collectedAt,provenance:'archive',textOrigin:'archive_excerpt',contextComplete:false,metadata:{category:'reset',sourceGroup:'aiplanwatch',referenceSignal:{recordedAt:row.recorded_at,summary:row.summary,referenceUrl:REFERENCE_SIGNAL_SOURCE.url}}};
 });
}
export function parseReferenceHistory(value:unknown,collectedAt:string):Incoming[] {
 const data=historySchema.parse(value);archiveSnapshot(data.generated_at,collectedAt);
 const start=new Date(collectedAt);start.setUTCMonth(start.getUTCMonth()-6);
 return data.events.filter(row=>Date.parse(row.occurred_at)>=start.getTime()&&Date.parse(row.occurred_at)<=Date.parse(data.generated_at)).map(row=>{
  const messageId=row.source.url.split('/').at(-1)!;
  // Generic recorded rows are discovery leads. No completion, audience or parent
  // is inferred from their classification; the original must pass normal rules.
  return {sourceId:REFERENCE_HISTORY_SOURCE.id,messageId,url:row.source.url,text:'参考项目历史记录，等待核对原文、福利类型及事件阶段。',publishedAt:new Date(Number((BigInt(messageId)>>22n)+1288834974657n)).toISOString(),collectedAt,provenance:'archive',textOrigin:'archive_excerpt',contextComplete:false,metadata:{category:'reset',sourceGroup:'aiplanwatch'}};
 });
}

/** Only the explicitly typed last_global_reset is completion evidence. A generic
 * resets.json `recorded` row is merely a discovery candidate, never a completion. */
export function parseReferenceLatest(value:unknown,collectedAt:string):Incoming[] {
  const data=latestSchema.parse(value),row=data.last_global_reset,signal=data.latest_signal;
  const collected=Date.parse(collectedAt),generated=Date.parse(data.generated_at);
  if(!Number.isFinite(collected)||generated>collected+60000||collected-generated>48*3600000)throw new Error('REFERENCE_SNAPSHOT_STALE');
  if(!row)return [];
  if(Date.parse(row.occurred_at)>generated)throw new Error('REFERENCE_TIME_MISMATCH');
  const matches=!!signal&&row.source.url===signal.source.url&&row.source.url.endsWith('/'+signal.signal_id)&&Math.abs(Date.parse(row.occurred_at)-Date.parse(signal.recorded_at))<=1000;
  const summary=matches?signal!.summary:'',messageId=row.source.url.split('/').at(-1)!;
  const snowflake=Number((BigInt(messageId)>>22n)+1288834974657n);
  if(snowflake>Date.parse(row.occurred_at)+1000)throw new Error('REFERENCE_TIME_MISMATCH');
  const observed=Math.abs(snowflake-Date.parse(row.occurred_at))>1000;
  if(observed&&(!matches||!observedResetText(summary)))throw new Error('REFERENCE_TIME_MISMATCH');
  return [{sourceId:REFERENCE_RESET_SOURCE.id,messageId:observed?`observed-${messageId}`:messageId,url:row.source.url,text:summary||'参考项目记录了公共额度重置，等待核对原文。',publishedAt:row.occurred_at,collectedAt,provenance:'archive',textOrigin:'archive_excerpt',contextComplete:false,metadata:{category:'reset',sourceGroup:'aiplanwatch',benefitKind:'automatic_reset',referenceReset:{eventId:row.event_id,snapshotAt:data.generated_at,occurredAt:row.occurred_at,referenceUrl:REFERENCE_RESET_SOURCE.url,summary}}}];
}

/** Replay a pinned historical latest.json. Its original timestamp is retained;
 * it is never used as the current signal or current collection health. */
export function parseReferenceHistoricalLatest(value:unknown,commit:string,collectedAt:string):Incoming[] {
 if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('REFERENCE_ARCHIVE_COMMIT_INVALID');
 const data=latestSchema.parse(value);archiveSnapshot(data.generated_at,collectedAt);
 return parseReferenceLatest(data,data.generated_at).map(row=>({...row,collectedAt,metadata:{...row.metadata,referenceReset:{...row.metadata!.referenceReset!,referenceUrl:`https://raw.githubusercontent.com/gdutxiaoxu/codex-reset-radar/${commit}/data/latest.json`}}}));
}
export function referenceCompletionText(text:string):boolean {
 return /^(?:done(?: and dusted)?|(?:hi[.!]? )?(?:it is|it's) done|resets? all propagated[.!]?(?: that will be all[.!]? have a fantastic weekend[.!]?)?)[.!]?$/i.test(text.replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim());
}
export function needsReferenceHistoryRecovery(evidence:Evidence):boolean {
 return evidence.sourceId===REFERENCE_HISTORY_SOURCE.id&&evidence.provenance==='archive'&&evidence.textOrigin==='original'&&!evidence.parentId&&evidence.metadata?.sourceGroup==='aiplanwatch'&&referenceCompletionText(evidence.text)&&!referenceCompletionClaim(evidence);
}

/** The original post and the reference's typed classification must both agree.
 * This supplies a benefit type, never a fabricated reply or event relationship. */
export function referenceCompletionClaim(evidence:Evidence):BenefitClaim|undefined {
  const proof=evidence.metadata?.referenceReset;
  const pinned=!!proof&&/^https:\/\/raw\.githubusercontent\.com\/gdutxiaoxu\/codex-reset-radar\/[a-f0-9]{40}\/data\/latest\.json$/.test(proof.referenceUrl);
  const allowedSource=evidence.sourceId===REFERENCE_RESET_SOURCE.id||evidence.sourceId===REFERENCE_HISTORY_SOURCE.id&&pinned;
  if(!allowedSource||evidence.provenance!=='archive'||evidence.textOrigin!=='original'||evidence.parentId||evidence.metadata?.sourceGroup!=='aiplanwatch'||evidence.metadata?.benefitKind!=='automatic_reset'||!proof||(!pinned&&proof.referenceUrl!==REFERENCE_RESET_SOURCE.url)||![proof.occurredAt,proof.snapshotAt,evidence.publishedAt,evidence.collectedAt].every(at=>Number.isFinite(Date.parse(at)))||Math.abs(Date.parse(proof.occurredAt)-Date.parse(evidence.publishedAt))>1000||Date.parse(proof.snapshotAt)<Date.parse(proof.occurredAt)||Date.parse(proof.snapshotAt)>Date.parse(evidence.collectedAt)+60000||isTruncatedBenefitText(evidence.text)||!/^https:\/\/x\.com\/thsottiaux\/status\/\d{15,20}$/.test(evidence.url)||!evidence.url.endsWith('/'+evidence.messageId))return;
  const clean=(s:string)=>s.replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim();
  if(proof.summary&&clean(proof.summary)!==clean(evidence.text)||!referenceCompletionText(evidence.text))return;
  return {kind:'automatic_reset',stage:'claimed_complete',scope:'public',eligibility:'公开额度重置（依据 AIPlanWatch 分类，适用套餐以原公告为准）',quote:evidence.text};
}

/** A public hint is an attributed observation, without an invented forecast
 * window, expiration time, probability or completion classification. */
export function referencePublicSignal(evidence:Evidence[],sources:Source[],now:string,completedAt?:string):ReferencePublicSignal|undefined {
 if(!forecastSourceAvailable(sources.find(s=>s.id===REFERENCE_SIGNAL_SOURCE.id),now))return;
 const items=evidence.filter(e=>e.sourceId===REFERENCE_SIGNAL_SOURCE.id&&e.provenance==='archive'&&e.textOrigin==='original'&&e.metadata?.sourceGroup==='aiplanwatch'&&e.metadata.referenceSignal?.referenceUrl===REFERENCE_SIGNAL_SOURCE.url&&/^https:\/\/x\.com\/thsottiaux\/status\/\d{15,20}$/.test(e.url)&&e.url.endsWith('/'+e.messageId)&&!isTruncatedBenefitText(e.text)&&Date.parse(e.publishedAt)<=Date.parse(now)&&Date.parse(e.collectedAt)<=Date.parse(now)&&(!completedAt||Date.parse(e.publishedAt)>Date.parse(completedAt)))
  .sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt));
 const first=items[0];if(!first)return;
 return {id:first.messageId,text:first.metadata!.referenceSignal!.summary,publishedAt:first.publishedAt,recordedAt:first.metadata!.referenceSignal!.recordedAt,sourceUrl:first.url,sourceName:'AIPlanWatch'};
}
export function projectReferenceSignal(value:ReferencePublicSignal|undefined,sources:Source[],now:string,completedAt?:string):ReferencePublicSignal|undefined {
 if(!value||value.sourceName!=='AIPlanWatch'||!forecastSourceAvailable(sources.find(s=>s.id===REFERENCE_SIGNAL_SOURCE.id),now)||!/^\d{15,20}$/.test(value.id)||value.sourceUrl!==`https://x.com/thsottiaux/status/${value.id}`||typeof value.text!=='string'||!value.text.trim()||value.text.length>3000||!Number.isFinite(Date.parse(value.publishedAt))||!Number.isFinite(Date.parse(value.recordedAt))||Date.parse(value.publishedAt)>Date.parse(now)||Date.parse(value.recordedAt)>Date.parse(now)||completedAt&&Date.parse(value.publishedAt)<=Date.parse(completedAt))return;
 return value;
}
