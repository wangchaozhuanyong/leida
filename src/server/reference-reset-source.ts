import {z} from 'zod';
import {observedResetText} from '../lib/reset-observations';
import type {Evidence,Source} from '../lib/types';
import type {Incoming} from './ingestion';
import type {BenefitClaim} from './benefit-rules';
import {isTruncatedBenefitText} from './benefit-rules';
import {interpretResetHint,interpretResetReplyHint} from './reset-hint';
import {evidenceBenefitClaims,originalConflict,resetReplyParent} from './source-context';
import {speechDisposition} from './benefit-language';
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
 const start=new Date(collectedAt),day=start.getUTCDate();
 start.setUTCMonth(start.getUTCMonth()-6,1);
 const endOfMonth=new Date(start);
 endOfMonth.setUTCMonth(endOfMonth.getUTCMonth()+1,0);
 start.setUTCDate(Math.min(day,endOfMonth.getUTCDate()));
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

const tiboSourceId='tibo-public';
const recentHintMs=2*86400000;
const originalPost=/^https:\/\/x\.com\/thsottiaux\/status\/\d{15,20}$/;

/** Keep one current actionable hint. Ambiguous replies may be retained for
 * review, while fresh, usable clues take precedence on the homepage. */
export function referencePublicSignal(evidence:Evidence[],sources:Source[],now:string,completedAt?:string):ReferencePublicSignal|undefined {
 const cutoff=Date.parse(now);
 const fresh=new Set([REFERENCE_SIGNAL_SOURCE.id,tiboSourceId].filter(id=>forecastSourceAvailable(sources.find(s=>s.id===id),now)));
 if(!fresh.size)return;
 const known=evidence.filter(e=>Date.parse(e.publishedAt)<=cutoff&&Date.parse(e.collectedAt)<=cutoff);
 const items=known.filter(e=>fresh.has(e.sourceId)&&e.provenance==='archive'&&e.textOrigin==='original'&&
   originalPost.test(e.url)&&e.url.endsWith('/'+e.messageId)&&!isTruncatedBenefitText(e.text)&&
   (e.sourceId===tiboSourceId?e.metadata?.sourceGroup==='fxembed:thsottiaux'&&Date.parse(e.publishedAt)>cutoff-recentHintMs:
     e.metadata?.sourceGroup==='aiplanwatch'&&e.metadata.referenceSignal?.referenceUrl===REFERENCE_SIGNAL_SOURCE.url))
   .sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)||Number(b.sourceId===tiboSourceId)-Number(a.sourceId===tiboSourceId));
 let pending:ReferencePublicSignal|undefined;
 const seen=new Set<string>();
 for(const item of items){
  if(seen.has(item.messageId)||originalConflict(item,known))continue;
  const parent=resetReplyParent(item,known,now);
  const reply=parent&&interpretResetReplyHint(item.text,item.publishedAt,parent.kind);
  const hint=interpretResetHint(item.text,item.publishedAt)??(reply&&parent?{...reply,parentSourceUrl:parent.parent.url}:undefined);
  if(hint&&Date.parse(hint.expiresAt)<=cutoff)continue;
  if(hint?.kind!=='banked_reset'&&completedAt&&Date.parse(item.publishedAt)<=Date.parse(completedAt))continue;
  const reference=item.metadata?.referenceSignal;
  const direct=item.sourceId===tiboSourceId;
  if(direct&&!hint&&(!parent||evidenceBenefitClaims(item,[item,parent.parent]).length||
    ['denied','reported'].includes(speechDisposition(item.text))))continue;
  const text=reference?.summary??item.text.slice(0,3000);
  const recordedAt=reference?.recordedAt??item.collectedAt;
  const availableAt=parent&&(!hint||hint.parentSourceUrl)?
    new Date(Math.max(Date.parse(recordedAt),Date.parse(item.collectedAt),Date.parse(parent.parent.collectedAt))).toISOString():recordedAt;
  const result:ReferencePublicSignal={id:item.messageId,text,publishedAt:item.publishedAt,recordedAt:availableAt,
    sourceUrl:item.url,sourceName:direct?'Tibo 公开动态':'AIPlanWatch',...(hint?{hint}:direct?{reviewPending:true}:{})};
  if(hint)return result;
  seen.add(item.messageId);
  pending??=result;
 }
 return pending;
}

export function projectReferenceSignal(value:ReferencePublicSignal|undefined,sources:Source[],now:string,completedAt?:string):ReferencePublicSignal|undefined {
 if(!value)return;
 const sourceId=value.sourceName==='Tibo 公开动态'?tiboSourceId:value.sourceName==='AIPlanWatch'?REFERENCE_SIGNAL_SOURCE.id:undefined;
 const cutoff=Date.parse(now),published=Date.parse(value.publishedAt),recorded=Date.parse(value.recordedAt);
 if(!sourceId||!forecastSourceAvailable(sources.find(s=>s.id===sourceId),now)||!/^\d{15,20}$/.test(value.id)||
   value.sourceUrl!==`https://x.com/thsottiaux/status/${value.id}`||typeof value.text!=='string'||!value.text.trim()||value.text.length>3000||
   !Number.isFinite(published)||!Number.isFinite(recorded)||published>cutoff||recorded>cutoff)return;
 const hint=value.hint;
 if(hint&&Date.parse(hint.expiresAt)<=cutoff||value.reviewPending&&published+recentHintMs<=cutoff)return;
 if(hint?.kind!=='banked_reset'&&completedAt&&published<=Date.parse(completedAt))return;
 return value;
}
