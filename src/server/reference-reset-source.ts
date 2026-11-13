import {z} from 'zod';
import {observedResetText} from '../lib/reset-observations';
import type {Evidence,Source} from '../lib/types';
import type {Incoming} from './ingestion';
import type {BenefitClaim} from './benefit-rules';
import {benefitClauses,isTruncatedBenefitText} from './benefit-rules';
import {acceptResetSignalReview,cancelsResetSignal,excludedResetSignal,interpretForwardResetSignal,interpretResetHint,interpretResetReplyHint,isContextualCancellation,isResetSignalDelay,mentionsResetSignal,resetHintTiming,resetSignalKinds,RESET_SIGNAL_LOOKBACK_MS,RESET_SIGNAL_WINDOW_MS} from './reset-hint';
import {evidenceBenefitClaims,gatherExplicitEvidenceContext,originalConflict,resetReplyParent,selectOriginal} from './source-context';
import {forecastSourceAvailable,referenceSnapshotFresh,type PublicResetHint,type ReferencePublicSignal,type ResetSignalReview} from '../lib/forecast';
import {RESET_WATCH_ENDPOINT,parseResetWatchDiscovery} from './reset-watch';
import {CODEX_LIMITS_OBSERVATION_SOURCE} from './codexlimits-observation-source';
import {TIBORESET_OBSERVATION_SOURCE} from './tiboreset-observation-source';

export const REFERENCE_DATA_ROOT='https://raw.githubusercontent.com/gdutxiaoxu/codex-reset-radar/master/data';
export const REFERENCE_RESET_SOURCE:Source={id:'aiplanwatch-reference',name:'AIPlanWatch 公开数据对账',kind:'archive',url:`${REFERENCE_DATA_ROOT}/latest.json`,enabled:false,validated:false,intervalMinutes:30,collectionPolicy:'manual',version:1,status:'unconnected'};
export const REFERENCE_SIGNAL_SOURCE:Source={...REFERENCE_RESET_SOURCE,id:'aiplanwatch-signals',name:'AIPlanWatch 公开信号对账',url:`${REFERENCE_DATA_ROOT}/signals.json`};
export const REFERENCE_HISTORY_SOURCE:Source={...REFERENCE_RESET_SOURCE,id:'aiplanwatch-history',name:'AIPlanWatch 重置与重置卡对账',url:`${REFERENCE_DATA_ROOT}/resets.json`,intervalMinutes:360};
export const REFERENCE_SOURCES=[REFERENCE_RESET_SOURCE,REFERENCE_SIGNAL_SOURCE,REFERENCE_HISTORY_SOURCE,CODEX_LIMITS_OBSERVATION_SOURCE,TIBORESET_OBSERVATION_SOURCE];
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
const archiveSourceId='reset-archive';
const recentHintMs=RESET_SIGNAL_WINDOW_MS;
const originalPost=/^https:\/\/x\.com\/thsottiaux\/status\/\d{15,20}$/;
export function isResetWatchLead(evidence:Pick<Evidence,'sourceId'|'metadata'>):boolean {
 return evidence.sourceId===archiveSourceId&&evidence.metadata?.sourceGroup==='codex-resets'&&evidence.metadata.referenceSignal?.referenceUrl===RESET_WATCH_ENDPOINT;
}

/** Archive discovery and HTML history have distinct ingestion roles for a
 * post. Public forecasts still group both with the canonical original ID. */
export function evidenceLane(evidence:Pick<Evidence,'sourceId'|'messageId'|'metadata'>):string {
 return evidence.sourceId+':'+evidence.messageId+(isResetWatchLead(evidence)?':watch':'');
}
export function signalDiscoveryAvailable(source:Source|undefined):boolean {
 return !!source?.enabled&&source.id===archiveSourceId&&source.kind==='archive'&&source.url==='https://codex-resets.com/zh-CN'&&
   (keepKnownDatedHint(source)||source.pauseReason==='structure'&&source.publicationPaused===true);
}

export function parseResetWatchLeads(value:unknown,collectedAt:string):Incoming[] {
 const records=new Map<string,Incoming>();
 for(const watch of parseResetWatchDiscovery(value,collectedAt)){
  const item=watch.signal??watch.scheduledReset;
  if(!item?.sourceUrl||item.sourceType==='observed'||!originalPost.test(item.sourceUrl))continue;
  const messageId=item.sourceUrl.split('/').at(-1)!;
  const originalAt=Number((BigInt(messageId)>>22n)+1288834974657n), at=Date.parse(collectedAt);
  if(!Number.isSafeInteger(originalAt)||originalAt>at||originalAt<=at-RESET_SIGNAL_LOOKBACK_MS)continue;
  const publishedAt=new Date(originalAt).toISOString(), summary=item.text.slice(0,3000);
  const reportedAt=watch.signal?.observedAt??watch.scheduledReset?.announcedAt??collectedAt;
  records.set(messageId,{sourceId:archiveSourceId,messageId,url:item.sourceUrl,text:summary,publishedAt,collectedAt,
   contextComplete:false,provenance:'archive',textOrigin:'archive_excerpt',
   metadata:{category:'reset',sourceGroup:'codex-resets',referenceSignal:{recordedAt:reportedAt,summary,referenceUrl:RESET_WATCH_ENDPOINT}}});
 }
 return [...records.values()];
}
function hintDisplayUntil(hint:PublicResetHint){
 return Date.parse(hint.expiresAt)+(hint.dayLabel?86400000:0);
}
function signalClosesAt(hint:PublicResetHint|undefined){
 return ms(hint?.expiresAt)+(hint?.windowBasis==='fallback_48h'?0:86_400_000);
}
function keepKnownDatedHint(source:Source|undefined):boolean {
 return !!source?.enabled&&source.validated&&!source.publicationPaused&&source.status!=='paused'&&source.status!=='unconnected';
}

const sourceNames:Record<string,ReferencePublicSignal['sourceName']>={
 [tiboSourceId]:'Tibo 公开动态',[REFERENCE_SIGNAL_SOURCE.id]:'AIPlanWatch',[archiveSourceId]:'Codex Resets',
};
export interface ReferenceSignalDecision {
 state:'forecast'|'pending'|'excluded'|'cancelled';at:string;reason:string;
}
export interface ReferenceSignalDecisionRecord extends ReferenceSignalDecision {
 evidenceId:string;publishedAt:string;collectedAt:string;projectedAt?:string;
}
const ms=(at?:string)=>Date.parse(at??'');
const recent=(item:Evidence,now:number)=>ms(item.publishedAt)<=now&&ms(item.publishedAt)>now-RESET_SIGNAL_LOOKBACK_MS&&ms(item.collectedAt)<=now;
function knownSignalSource(item:Evidence):boolean {
 if(item.provenance!=='archive'||!originalPost.test(item.url)||!item.url.endsWith('/'+item.messageId))return false;
 if(item.sourceId===tiboSourceId)return item.metadata?.sourceGroup==='fxembed:thsottiaux';
 if(item.sourceId===REFERENCE_SIGNAL_SOURCE.id)return item.metadata?.sourceGroup==='aiplanwatch'&&item.metadata.referenceSignal?.referenceUrl===REFERENCE_SIGNAL_SOURCE.url;
 return item.sourceId===archiveSourceId&&item.metadata?.sourceGroup==='codex-resets'&&item.metadata.category==='reset';
}
function isUsableOriginal(item:Evidence):boolean {
 return item.textOrigin==='original'&&!isTruncatedBenefitText(item.text);
}

function directSignalHints(item:Evidence,context:Evidence[]):PublicResetHint[] {
 const claims=evidenceBenefitClaims(item,context);
 const hintFor=(text:string)=>interpretResetHint(text,item.publishedAt)??interpretForwardResetSignal(text,item.publishedAt);
 if(claims.length)return claims.filter(claim=>claim.scope==='public'&&claim.stage==='promised'&&
   claims.filter(other=>other.kind===claim.kind).length===1).flatMap(claim=>{
  const parsed=resetHintTiming(claim.kind,claim.quote,item.publishedAt);
  if(parsed?.windowBasis==='source_time')return [parsed];
  if(parsed&&claim.expectedAt&&ms(claim.expectedAt)>ms(item.publishedAt))return [{
   kind:claim.kind,expiresAt:claim.expectedAt,windowBasis:'source_time',timeNote:claim.timeNote,
  }];
  if(parsed?.windowBasis==='fallback_48h'){
   const combined=hintFor(item.text);
   if(combined?.kind===claim.kind&&combined.windowBasis!=='fallback_48h')return [combined];
  }
  return parsed?[parsed]:[];
 });
 const combined=hintFor(item.text);
 if(combined)return [combined];
 if(resetSignalKinds(item.text).length===1&&isResetSignalDelay(item.text)&&!cancelsResetSignal(item.text)){
  const latest=benefitClauses(item.text).at(-1);
  const update=latest&&hintFor(latest);
  if(update&&update.windowBasis!=='fallback_48h')return [update];
 }
 if(resetSignalKinds(item.text).length!==2||excludedResetSignal(item.text))return [];
 const clauses=benefitClauses(item.text);
 const hints=clauses.flatMap(clause=>{
  const [kind,...otherKinds]=resetSignalKinds(clause);
  if(!kind||otherKinds.length||clauses.some(other=>other!==clause&&resetSignalKinds(other).includes(kind)))return [];
  const hint=hintFor(clause);
  return hint?[hint]:[];
 });
 return hints;
}

/** A dated or uncertain parent can identify a reply's topic before an article
 * is published. An unrelated quoted post or conflicting lineage cannot. */
function signalParent(item:Evidence,known:Evidence[],now:string):ReturnType<typeof resetReplyParent> {
 const formal=resetReplyParent(item,known,now);
 if(formal)return formal;
 const lineage=gatherExplicitEvidenceContext(item,known);
 const parent=lineage[1];
 if(!parent||lineage.some(row=>!isUsableOriginal(row)||originalConflict(row,known)))return;
 const hints=directSignalHints(parent,lineage.slice(1));
 if(hints.length===1&&resetSignalKinds(parent.text).length<=1)return {parent,kind:hints[0].kind};
}

export function needsResetSignalReview(primary:Evidence,context:Evidence[],now:string):boolean {
 const cutoff=ms(now);
 if(!knownSignalSource(primary)||!isUsableOriginal(primary)||!recent(primary,cutoff)||ms(primary.publishedAt)+recentHintMs<=cutoff||
   originalConflict(primary,context)||excludedResetSignal(primary.text)||evidenceBenefitClaims(primary,context).length||
   directSignalHints(primary,context).length||!(/[\p{L}\p{N}]/u.test(primary.text.replace(/^@\w+\s+/,''))))return false;
 const parent=signalParent(primary,context,now);
 if(context.some(item=>!isUsableOriginal(item)||item.parentId&&!context.some(parent=>parent.messageId===item.parentId)))return false;
 if(parent&&interpretResetReplyHint(primary.text,primary.publishedAt,parent.kind))return false;
 return true;
}

export function needsResetSignalContext(primary:Evidence,context:Evidence[],now:string):boolean {
 const cutoff=ms(now);
 return knownSignalSource(primary)&&isUsableOriginal(primary)&&recent(primary,cutoff)&&
  ms(primary.publishedAt)+recentHintMs>cutoff&&!!primary.parentId&&
  !context.some(item=>item.messageId===primary.parentId&&isUsableOriginal(item))&&
  !evidenceBenefitClaims(primary,context).length&&!directSignalHints(primary,context).length;
}

function publicSignal(item:Evidence,group:Evidence[],recordedAt:string,fields:Partial<ReferencePublicSignal>):ReferencePublicSignal {
 const names=[...new Set([item,...group].map(row=>sourceNames[row.sourceId]))];
 return {id:item.messageId,text:item.text.slice(0,3000),publishedAt:item.publishedAt,recordedAt,sourceUrl:item.url,sourceName:names[0],
  ...(names.length>1?{sourceNames:names}:{}),...fields};
}

function mergeSignal(previous:ReferencePublicSignal, next:ReferencePublicSignal):ReferencePublicSignal {
 const first=previous.roundAt??previous.publishedAt;
 // Soft updates ("soon") carry the original observation window or stated date.
 const specificity=(hint:PublicResetHint|undefined)=>hint?.windowBasis==='source_time'?2:hint?.dayLabel?1:0;
 const updatedTime=specificity(next.hint)>0&&specificity(next.hint)>=specificity(previous.hint);
 const chosen=next.cancelled||updatedTime?next:previous;
 return {...chosen,roundAt:first,roundSourceUrls:[...new Set([
  ...(previous.roundSourceUrls??[previous.sourceUrl]),...(next.roundSourceUrls??[next.sourceUrl]),
 ])].slice(-12)};
}

function isNewSignalRound(text:string):boolean {
 return /\b(?:another|second|third|separate|batch\s+\d|new round)\b|下一批|另(?:一|发|补)|第[二三四五\d]+批|新一轮/i.test(text);
}

interface ReferenceSignalOptions {
 reviews?:Map<string,ResetSignalReview>;
 resolvedAt?:Partial<Record<PublicResetHint['kind'],string>>;
 observedAt?:Partial<Record<PublicResetHint['kind'],string>>;
 onDecision?:(item:Evidence,decision:ReferenceSignalDecision)=>void;
}

function applyReferenceSignal(rounds:ReferencePublicSignal[],item:Evidence,group:Evidence[],
  change:{kind:PublicResetHint['kind'];hint?:PublicResetHint;links:string[];parent?:ReturnType<typeof signalParent>;
    at:string;resolvedAt?:string;observedAt?:string}):ReferenceSignalDecision {
 const {kind,hint,links,parent,at}=change;
 const anchor=ms(item.publishedAt),resolution=ms(change.resolvedAt),observation=ms(change.observedAt);
 // Shared background posts do not make siblings the same batch.
 let matching:ReferencePublicSignal[]=[];
 for(const url of links){
  matching=rounds.filter(round=>round.hint?.kind===kind&&(round.roundSourceUrls?.includes(url)||round.sourceUrl===url));
  if(matching.length)break;
 }
 let prior=rounds.filter(round=>round.hint?.kind===kind&&ms(round.roundAt??round.publishedAt)<=anchor&&
  (!Number.isFinite(resolution)||resolution>anchor||ms(round.roundAt??round.publishedAt)>resolution));
 if(observation<=anchor){
  const possible=prior.filter(round=>!round.cancelled&&ms(round.roundAt??round.publishedAt)<=observation&&
   signalClosesAt(round.hint)>=observation);
  // A report fitting two rounds cannot break a fallback link to either one.
  if(possible.length===1)prior=prior.filter(round=>round!==possible[0]);
 }
 const competing=prior.filter(round=>!round.cancelled&&signalClosesAt(round.hint)>anchor);
 const distinct=isNewSignalRound(item.text);
 const explicitChange=!hint||/\b(?:change of plans|rescheduled|correction|instead|moved to)\b|改期|改为|更正|调整为/i.test(item.text);
 const fallback=hint?.windowBasis==='fallback_48h';
 const linked=(!distinct||explicitChange)&&matching.length===1?matching[0]:undefined;
 const singleOpen=!distinct&&!links.length&&competing.length===1&&
  (explicitChange||fallback||competing[0].hint?.windowBasis==='fallback_48h')?competing[0]:undefined;
 const previous=linked??singleOpen??(!distinct&&!links.length&&!competing.length&&fallback?
  prior.findLast(round=>round.hint?.windowBasis==='fallback_48h'&&anchor<=signalClosesAt(round.hint)+recentHintMs):undefined);
 if(hint){
  if(previous&&fallback&&(previous.cancelled||signalClosesAt(previous.hint)<=anchor)){
   return {state:'excluded',at,reason:'closed_round_restatement'};
  }
  const next=publicSignal(item,group,at,{hint,roundSourceUrls:[item.url]});
  if(previous){
   rounds[rounds.indexOf(previous)]=mergeSignal(previous,next);
   return {state:'forecast',at,reason:fallback?'retained_round_window':'updated_round_window'};
  }
  if(!distinct&&(matching.length>=2||!links.length&&competing.length>=2&&fallback))return {state:'pending',at,reason:'ambiguous_round'};
  rounds.push(next);
  return {state:'forecast',at,reason:hint.windowBasis??'source_day'};
 }
 if(previous){
  rounds[rounds.indexOf(previous)]=mergeSignal(previous,publicSignal(item,group,at,{hint:previous.hint,cancelled:true}));
  return {state:'cancelled',at,reason:'verified_withdrawal'};
 }
 if(links.length&&matching.length===0&&parent?.kind===kind){
  rounds.push(publicSignal(item,group,at,{hint:{kind,expiresAt:item.publishedAt,parentSourceUrl:parent.parent.url},
   roundAt:parent.parent.publishedAt,roundSourceUrls:[item.url],cancelled:true}));
  return {state:'cancelled',at,reason:'verified_parent_withdrawal'};
 }
 return {state:'excluded',at,reason:'withdrawal_without_unique_round'};
}

/** Derive per-category rounds from the evidence known at this instant.
 * Excerpts are discovery only. They cannot set dates, stages or eligibility. */
export function referencePublicSignals(
 evidence:Evidence[],sources:Source[],now:string,options:ReferenceSignalOptions={},
):ReferencePublicSignal[] {
 const cutoff=ms(now);
 const enabled=new Map(sources.filter(source=>source.id in sourceNames&&(keepKnownDatedHint(source)||signalDiscoveryAvailable(source))).map(source=>[source.id,source]));
 if(!enabled.size)return [];
 const known=evidence.filter(item=>ms(item.collectedAt)<=cutoff&&ms(item.publishedAt)<=cutoff);
 const groups=new Map<string,Evidence[]>();
 for(const item of known){
  if(!recent(item,cutoff)||!enabled.has(item.sourceId)||!knownSignalSource(item))continue;
  const group=groups.get(item.messageId);
  if(group)group.push(item);else groups.set(item.messageId,[item]);
 }
 const ordered=[...groups.values()].sort((a,b)=>ms(a[0].publishedAt)-ms(b[0].publishedAt)||a[0].messageId.localeCompare(b[0].messageId));
 const rounds:ReferencePublicSignal[]=[];
 let pending:ReferencePublicSignal|undefined;
 for(const group of ordered){
  // An embedded copy can omit the parent relationship. Keep the richer
  // original and use the first equivalent collection time when available.
  const originals=group.filter(isUsableOriginal);
  const usable=originals.filter(row=>row.parentId);
  const preferred=usable.length?usable:originals;
  const item=selectOriginal(preferred.filter(row=>row.sourceId===tiboSourceId))??selectOriginal(preferred.length?preferred:group)!;
  const equivalent=originals.filter(row=>row.text===item.text&&(!item.parentId||row.parentId===item.parentId));
  const originalRecordedAt=equivalent.length?Math.min(...equivalent.map(row=>ms(row.collectedAt))):ms(item.collectedAt);
  const context=gatherExplicitEvidenceContext(item,known);
  const claims=isUsableOriginal(item)?evidenceBenefitClaims(item,context):[];
  const parent=isUsableOriginal(item)?signalParent(item,known,now):undefined;
  const conflict=originalConflict(item,known)||context.some(row=>originalConflict(row,known));
  const recorded=new Date(Math.max(originalRecordedAt,...context.slice(1).map(row=>ms(row.collectedAt)))).toISOString();
  const review=!conflict&&isUsableOriginal(item)?equivalent.map(row=>options.reviews?.get(row.id)).find(value=>value&&
    ms(value.reviewedAt)<=cutoff&&value.evidenceIds.slice(1).join()===context.slice(1).map(row=>row.id).join()):undefined;
  const reviewed=review?acceptResetSignalReview(review,context,review.reviewedAt):undefined;
  const reply=parent&&interpretResetReplyHint(item.text,item.publishedAt,parent.kind);
  const direct=!conflict&&isUsableOriginal(item)?directSignalHints(item,context):[];
  const inherited=!conflict&&reply&&parent?{...reply,parentSourceUrl:parent.parent.url}:undefined;
  const inferred=!conflict&&reviewed?.disposition==='future'&&reviewed.kind&&!claims.length&&
    (!parent||parent.kind===reviewed.kind)?resetHintTiming(reviewed.kind,reviewed.quote,item.publishedAt):undefined;
  const hints=direct.length?direct:inherited?[inherited]:inferred?[inferred]:[];
  const links=context.slice(1).map(row=>row.url);
  const cancelled=!conflict&&isUsableOriginal(item)&&cancelsResetSignal(item.text);
  const delayed=(!!parent||mentionsResetSignal(item.text))&&isResetSignalDelay(item.text);
  const cancelKinds=cancelled?resetSignalKinds(item.text):[];
  const cancelKind=cancelKinds.length===1?cancelKinds[0]:cancelled&&cancelKinds.length===0&&isContextualCancellation(item.text)?parent?.kind:undefined;
  const anchor=ms(item.publishedAt);
  const changes=hints.length?hints.map(hint=>({kind:hint.kind,hint})):cancelKind?[{kind:cancelKind,hint:undefined}]:[];
  if(changes.length){
   const at=direct.length&&!claims.length?new Date(originalRecordedAt).toISOString():inferred&&reviewed?
    new Date(Math.max(ms(recorded),ms(reviewed.reviewedAt))).toISOString():recorded;
   const decisions=changes.map(change=>applyReferenceSignal(rounds,item,group,{...change,links,parent,at,
    resolvedAt:options.resolvedAt?.[change.kind],observedAt:options.observedAt?.[change.kind]}));
   if(decisions.some(decision=>decision.state==='pending')&&anchor+recentHintMs>cutoff)pending=publicSignal(item,group,recorded,{reviewPending:true});
   options.onDecision?.(item,decisions.find(decision=>decision.state==='forecast')??decisions[0]);
   continue;
  }
  if(cancelled||reviewed?.disposition==='excluded'||claims.length||excludedResetSignal(item.text)&&!delayed||anchor+recentHintMs<=cutoff){
   options.onDecision?.(item,{state:'excluded',at:recorded,reason:cancelled?'withdrawal_without_unique_round':reviewed?.disposition==='excluded'?'semantic_exclusion':claims.length?'handled_by_publication':anchor+recentHintMs<=cutoff?'observation_window_elapsed':'non_future_content'});
   continue;
  }
  const referenceLead=isResetWatchLead(item);
  const related=mentionsResetSignal(item.text)||!!parent||context.slice(1).some(row=>mentionsResetSignal(row.text)||known.some(other=>other.messageId===row.messageId&&mentionsResetSignal(other.text)))||referenceLead||
   item.sourceId===REFERENCE_SIGNAL_SOURCE.id&&isUsableOriginal(item)&&forecastSourceAvailable(enabled.get(item.sourceId),now);
  if(!related){
   const unresolved=reviewed?.disposition==='pending'||needsResetSignalReview(item,context,now);
   options.onDecision?.(item,{state:!isUsableOriginal(item)||unresolved?'pending':'excluded',at:recorded,
    reason:!isUsableOriginal(item)?'missing_original':unresolved?'semantic_context_unresolved':'no_verified_reset_context'});
   continue;
  }
  const displayText=!isUsableOriginal(item)?'来源收录了一条公开线索，原帖仍在核对。':item.text.slice(0,3000);
  pending=publicSignal(item,group,recorded,{text:displayText,reviewPending:true});
  options.onDecision?.(item,{state:'pending',at:recorded,reason:conflict?'conflicting_original':!isUsableOriginal(item)?'missing_original':item.parentId&&!parent?'parent_context_unresolved':delayed?'timing_change_unresolved':'future_direction_unresolved'});
 }
 const visible=rounds.filter(round=>round.hint&&(
  !round.cancelled&&signalClosesAt(round.hint)>cutoff||round===rounds.findLast(other=>other.hint?.kind===round.hint?.kind)));
 // Bound the public payload without letting one busy category crowd out the other.
 const bounded=['automatic_reset','banked_reset'].flatMap(kind=>visible.filter(round=>round.hint?.kind===kind).slice(-6));
 return [...bounded,...(pending?[pending]:[])];
}

/** Compatibility for clients that only understand one dated or untyped clue. */
export function legacyReferenceSignal(values:ReferencePublicSignal[]|undefined,sources:Source[],now:string,completedAt?:string):ReferencePublicSignal|undefined {
 return values?.filter(signal=>!signal.cancelled&&signal.sourceName!=='Codex Resets'&&(!signal.hint||signal.hint.dayLabel))
  .sort((a,b)=>Number(!!b.hint&&hintDisplayUntil(b.hint)>ms(now))-Number(!!a.hint&&hintDisplayUntil(a.hint)>ms(now))||ms(b.publishedAt)-ms(a.publishedAt))
  .map(signal=>projectReferenceSignal(signal,sources,now,completedAt)).find(Boolean);
}

export function projectReferenceSignal(value:ReferencePublicSignal|undefined,sources:Source[],now:string,completedAt?:string,preserveRound=false):ReferencePublicSignal|undefined {
 if(!value)return;
 const sourceId=Object.keys(sourceNames).find(id=>sourceNames[id]===value.sourceName);
 const source=sources.find(item=>item.id===sourceId);
 const cutoff=Date.parse(now),published=Date.parse(value.publishedAt),recorded=Date.parse(value.recordedAt);
 const knownDatedHint=(value.hint?.dayLabel||preserveRound)&&(keepKnownDatedHint(source)||preserveRound&&signalDiscoveryAvailable(source));
 if(!sourceId||(!forecastSourceAvailable(source,now)&&!knownDatedHint)||!/^\d{15,20}$/.test(value.id)||
   value.sourceUrl!==`https://x.com/thsottiaux/status/${value.id}`||typeof value.text!=='string'||!value.text.trim()||value.text.length>3000||
   !Number.isFinite(published)||!Number.isFinite(recorded)||published>cutoff||recorded>cutoff)return;
 const hint=value.hint;
 if(hint&&(!Number.isFinite(hintDisplayUntil(hint))||!preserveRound&&!hint.dayLabel&&hintDisplayUntil(hint)<=cutoff)||value.reviewPending&&published+recentHintMs<=cutoff)return;
 if(preserveRound){
  if(hint&&(!['automatic_reset','banked_reset'].includes(hint.kind)||ms(hint.expiresAt)<=ms(value.roundAt??value.publishedAt)||
    hint.windowBasis!==undefined&&!['source_time','source_day','fallback_48h'].includes(hint.windowBasis)||
    hint.parentSourceUrl!==undefined&&!originalPost.test(hint.parentSourceUrl)))return;
  if(value.roundAt!==undefined&&(!Number.isFinite(ms(value.roundAt))||ms(value.roundAt)>published))return;
  if(value.roundSourceUrls!==undefined&&(!Array.isArray(value.roundSourceUrls)||value.roundSourceUrls.length>12||value.roundSourceUrls.some(url=>!originalPost.test(url))))return;
  if(value.sourceNames!==undefined&&(!Array.isArray(value.sourceNames)||value.sourceNames.length>3||value.sourceNames.some(name=>!Object.values(sourceNames).includes(name))))return;
 }
 if(hint?.kind!=='banked_reset'&&completedAt&&published<=Date.parse(completedAt))return;
 return value;
}

export function projectReferenceSignals(values:ReferencePublicSignal[]|undefined,sources:Source[],now:string):ReferencePublicSignal[]|undefined {
 if(!Array.isArray(values))return;
 return values.slice(0,13).flatMap(value=>{
  const signal=value&&typeof value==='object'?projectReferenceSignal(value,sources,now,undefined,true):undefined;
  if(!signal)return [];
  const {id,text,publishedAt,recordedAt,sourceUrl,sourceName,sourceNames,roundAt,roundSourceUrls,reviewPending,cancelled,hint}=signal;
  return [{id,text,publishedAt,recordedAt,sourceUrl,sourceName,sourceNames,roundAt,roundSourceUrls,reviewPending:reviewPending===true||undefined,cancelled:cancelled===true||undefined,
   ...(hint?{hint:{kind:hint.kind,expiresAt:hint.expiresAt,dayLabel:typeof hint.dayLabel==='string'?hint.dayLabel.slice(0,12):undefined,
    windowBasis:hint.windowBasis,parentSourceUrl:hint.parentSourceUrl,timeNote:typeof hint.timeNote==='string'?hint.timeNote.slice(0,360):undefined}}:{})}];
 });
}

/** Only the boundaries affect public cache identity. Seconds on the clock
 * are rendered locally and must not invalidate the API on every tick. */
export function referenceSignalVersion(values:unknown,timestamp:string):unknown {
 if(!Array.isArray(values))return;
 const now=ms(timestamp);
 return values.filter(signal=>signal&&typeof signal==='object').map(signal=>{
  const deadline=signal.hint?ms(signal.hint.expiresAt):ms(signal.publishedAt)+recentHintMs;
  return [signal,now>=deadline,!!signal.hint&&signal.hint.windowBasis!=='fallback_48h'&&now>=deadline+86400000];
 });
}
