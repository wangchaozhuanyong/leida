import {createHash} from 'node:crypto';
import {insert,list,one,put,pool,type Client} from '../db';
import type {Evidence,Source} from '../lib/types';
import {forecastSourceAvailable,type ForecastCadenceOutcome,type CadenceHorizonOutcome,type CadenceEvaluation} from '../lib/forecast';
import {buildResetCadenceForecast,RESET_CADENCE_MODEL_VERSION,type ResetCadenceForecast,type CadenceTarget,type CadenceObservation} from '../lib/reset-cadence';
import {CADENCE_PUBLIC_PROJECTION_VERSION,createCadencePublicProjection,type CadencePublicProjection} from './cadence-public-projection';
import {extractCadenceObservations} from './reset-cadence-evidence';

export interface StoredCadenceForecast extends ResetCadenceForecast {recordType:'reset_cadence';sourceIds:string[];inputFingerprint:string;evaluationSample?:boolean;}
export type CadenceOutcome=ForecastCadenceOutcome;
export interface CadenceRuntime {id:string;checkedAt:string;nextDueAt?:string;inputsRevision?:string;cadenceModelVersion?:string;cadencePublicProjection?:CadencePublicProjection;cadenceSnapshotId?:string;cadenceSnapshotIds?:Partial<Record<CadenceTarget,string>>;cadenceEvaluationByKind?:Partial<Record<CadenceTarget,CadenceEvaluation>>;}
export const CADENCE_TARGETS:CadenceTarget[]=['automatic_reset','banked_reset'];
export const cadenceNextFixedAt=(timestamp:string)=>new Date((Math.floor(Date.parse(timestamp)/(6*3600_000))+1)*6*3600_000).toISOString();
/** Publication/correction paths call this in their existing transaction. No schema or read-side writes. */
export async function markForecastInputsChanged(client:Client=pool):Promise<void>{await put('settings',{id:'forecast_inputs',revision:createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex')},client);}
export function forecastCycleDue(runtime:CadenceRuntime|undefined,inputsRevision:string|undefined,timestamp:string,changed=false):boolean {
 return changed||runtime?.cadencePublicProjection?.version!==CADENCE_PUBLIC_PROJECTION_VERSION||runtime?.cadenceModelVersion!==RESET_CADENCE_MODEL_VERSION||!runtime?.cadenceSnapshotIds?.automatic_reset||!runtime.cadenceSnapshotIds.banked_reset||runtime.inputsRevision!==inputsRevision||!Number.isFinite(Date.parse(runtime.nextDueAt??''))||Date.parse(timestamp)>=Date.parse(runtime.nextDueAt!);
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const isCadence=(value:unknown):value is StoredCadenceForecast=>!!value&&typeof value==='object'&&'recordType' in value&&value.recordType==='reset_cadence';
const isOutcome=(value:unknown):value is CadenceOutcome=>!!value&&typeof value==='object'&&'recordType' in value&&value.recordType==='reset_cadence_outcome';

/** Training can come from either verified public feed. An unused failed
 * archive does not disable a healthy direct Tibo series. */
export function cadenceSourcesAvailable(sources:Source[],sourceIds:string[],timestamp:string):boolean {
 const feeds=sources.filter(source=>
  source.id==='reset-archive'&&source.kind==='archive'&&source.url==='https://codex-resets.com/zh-CN'||
  source.id==='tibo-public'&&source.kind==='timeline'&&source.url==='https://api.fxtwitter.com/2/profile/thsottiaux/statuses');
 if(!sourceIds.length)return feeds.some(source=>forecastSourceAvailable(source,timestamp));
 return sourceIds.every(id=>forecastSourceAvailable(feeds.find(source=>source.id===id),timestamp));
}

/** A fixed horizon is resolved independently of the model's moving display interval.
 * Current polling does not prove continuous historical coverage, so absence is unknown. */
export function resolveCadenceHorizon(forecast:StoredCadenceForecast,observations:CadenceObservation[],horizonHours:24|48,timestamp:string):CadenceHorizonOutcome|undefined {
 const start=Date.parse(forecast.generatedAt),end=start+horizonHours*3600_000,now=Date.parse(timestamp);
 if(forecast.modelVersion!==RESET_CADENCE_MODEL_VERSION||!forecast.target||forecast.status!=='ready'||!Number.isFinite(start)||!Number.isFinite(now)||now<end)return;
 const next=observations.filter(o=>o.kind===forecast.target&&o.timePrecision==='exact'&&Number.isFinite(Date.parse(o.firstKnownAt??''))&&Date.parse(o.firstKnownAt!)<=now&&Date.parse(o.at)>start&&Date.parse(o.at)<=end).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.id.localeCompare(b.id))[0];
 const onTime=!!next&&Date.parse(next.firstKnownAt!)<=end;
 return {id:`forecast_cadence_horizon_${digest([forecast.id,horizonHours])}`,recordType:'reset_cadence_horizon_outcome',snapshotId:forecast.id,modelVersion:forecast.modelVersion,target:forecast.target,horizonHours,windowStart:forecast.generatedAt,windowEnd:new Date(end).toISOString(),observedAt:timestamp,result:next?'occurred':'unknown',scorable:onTime,...(next?{actualAt:next.at}:{}),evidenceIds:next?.evidenceIds??[],reason:next?(onTime?'窗口内存在可核验的同类型公开重置动态；个人到账未观测。':'窗口内事件在截止后才被采集，保留发生事实，不加入实时预测评分。'):'窗口已到期，但来源轮询健康不能证明连续覆盖；没有找到公告记为未知，不作为负例。'};
}
export const isCadenceHorizonOutcome=(value:unknown):value is CadenceHorizonOutcome=>!!value&&typeof value==='object'&&'recordType' in value&&value.recordType==='reset_cadence_horizon_outcome';

/** Append-only corrections can share a timestamp; the explicit chain wins ties. */
function latestCadenceResolution(rows:CadenceHorizonOutcome[]):CadenceHorizonOutcome|undefined {
 const superseded=new Set(rows.flatMap(o=>o.supersedes?[o.supersedes]:[]));
 return rows.filter(o=>!superseded.has(o.id)).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)||b.id.localeCompare(a.id))[0];
}

/** Only frozen non-overlapping 48-hour samples of the current version enter this comparison. */
export function evaluateCadence(snapshots:StoredCadenceForecast[],outcomes:CadenceHorizonOutcome[],target:CadenceTarget,timestamp:string):CadenceEvaluation {
 const fixed=snapshots.filter(s=>s.modelVersion===RESET_CADENCE_MODEL_VERSION&&s.target===target&&s.evaluationSample&&s.status==='ready'&&Date.parse(s.generatedAt)+48*3600_000<=Date.parse(timestamp)).sort((a,b)=>Date.parse(a.generatedAt)-Date.parse(b.generatedAt)||a.id.localeCompare(b.id));
 let total=0,positive=0,unknown=0,score=0,baseline=0,lastEnd=-Infinity;
 for(const snapshot of fixed){
  const start=Date.parse(snapshot.generatedAt);if(start<lastEnd)continue;lastEnd=start+48*3600_000;
  const outcome=latestCadenceResolution(outcomes.filter(o=>o.snapshotId===snapshot.id&&o.horizonHours===48&&o.modelVersion===snapshot.modelVersion&&o.target===target&&Date.parse(o.observedAt)<=Date.parse(timestamp)));
  if(!outcome?.scorable||outcome.result==='unknown'||snapshot.p48===null||!Number.isFinite(snapshot.p48)||snapshot.p48<0||snapshot.p48>1||!snapshot.eligibleCount||Date.parse(outcome.windowStart)!==start||Date.parse(outcome.windowEnd)!==lastEnd||Date.parse(outcome.observedAt)<lastEnd||outcome.result==='occurred'&&(!outcome.actualAt||Date.parse(outcome.actualAt)<=start||Date.parse(outcome.actualAt)>lastEnd||!outcome.evidenceIds.length)){unknown++;continue;}
  const raw=snapshot.rawP48;
  if(raw===undefined||raw===null||!Number.isFinite(raw)||raw<0||raw>1){unknown++;continue;}
  const y=outcome.result==='occurred'?1:0;total++;positive+=y;score+=(snapshot.p48-y)**2;baseline+=(raw-y)**2;
 }
 const brierScore=total?score/total:null,baselineBrierScore=total?baseline/total:null;
 return {modelVersion:RESET_CADENCE_MODEL_VERSION,maturedSamples:total,positiveSamples:positive,unknownSamples:unknown,brierScore,baselineBrierScore,skill:baselineBrierScore!==null&&baselineBrierScore>0&&brierScore!==null?1-brierScore/baselineBrierScore:null,calibrated:false,externalWeight:0,explanation:'仅统计当前模型固定且互不重叠的48小时窗口；与同一批输入的未平滑历史比例比较。未知、迟到与旧模型不计入评分；尚无连续覆盖证明，未找到公告不能算未发生。'};
}

/** This forecasts public messages. It never publishes a reset or sends reader notifications. */
export async function executeResetCadence(client:Client,evidence:Evidence[],sources:Source[],timestamp:string):Promise<{snapshotId:string;snapshotIds:Partial<Record<CadenceTarget,string>>;snapshots:number;outcomes:number;evaluationByKind:Partial<Record<CadenceTarget,CadenceEvaluation>>;nextDueAt:string;publicProjection:CadencePublicProjection}> {
 const observations=extractCadenceObservations(evidence,sources,timestamp);
 // Disabling polling pauses future predictions, but does not retract an unchanged public fact.
 const resolutionObservations=extractCadenceObservations(evidence,sources.map(source=>({...source,enabled:true})),timestamp);
 const stored=(await list<unknown>('forecast_snapshots',client)).filter(isCadence),existingOutcomes=(await list<unknown>('forecast_outcomes',client)).filter(isCadenceHorizonOutcome);
 const snapshotIds:Partial<Record<CadenceTarget,string>>={},evaluationByKind:Partial<Record<CadenceTarget,CadenceEvaluation>>={};
 let snapshots=0,outcomes=0,nextDueAt=cadenceNextFixedAt(timestamp);
 for(const target of CADENCE_TARGETS){
  const own=observations.filter(o=>o.kind===target);
  const qualified=buildResetCadenceForecast({observations:own,target,generatedAt:timestamp,inputFingerprint:'source-selection'});
  const trainingIds=new Set(qualified.trainingObservationIds),used=new Set(qualified.observations.filter(o=>trainingIds.has(o.id)).flatMap(o=>o.evidenceIds));
  const sourceIds=[...new Set(evidence.filter(e=>used.has(e.id)).map(e=>e.sourceId))].sort();
  const paused=!cadenceSourcesAvailable(sources,sourceIds,timestamp);
  const inputFingerprint=digest([RESET_CADENCE_MODEL_VERSION,target,own,sourceIds,paused]);
  const bucket=Math.floor(Date.parse(timestamp)/(6*3600_000)),snapshotId=`forecast_cadence_${digest([inputFingerprint,bucket,target])}`;
  snapshotIds[target]=snapshotId;
  if(!stored.some(s=>s.id===snapshotId)){
   const model=buildResetCadenceForecast({observations:own,target,generatedAt:timestamp,inputFingerprint,paused,pauseReason:'历史重置来源暂停、采集延迟或结构异常，恢复后重新计算。'});
   const previous=stored.filter(s=>s.modelVersion===RESET_CADENCE_MODEL_VERSION&&s.target===target&&s.evaluationSample).sort((a,b)=>Date.parse(b.generatedAt)-Date.parse(a.generatedAt))[0];
   const evaluationSample=model.status==='ready'&&(!previous||Date.parse(timestamp)>=Date.parse(previous.generatedAt)+48*3600_000);
   const snapshot:StoredCadenceForecast={...model,id:snapshotId,recordType:'reset_cadence',sourceIds,inputFingerprint,evaluationSample};
   if(await insert('forecast_snapshots',snapshot,client)){snapshots++;stored.push(snapshot);}
  }
 }
 for(const forecast of stored){
  if(forecast.modelVersion!==RESET_CADENCE_MODEL_VERSION||!forecast.target||forecast.status!=='ready')continue;
  for(const horizon of [24,48] as const){
   const due=Date.parse(forecast.generatedAt)+horizon*3600_000;
   if(due>Date.parse(timestamp)){if(due<Date.parse(nextDueAt))nextDueAt=new Date(due).toISOString();continue;}
   let outcome=resolveCadenceHorizon(forecast,resolutionObservations,horizon,timestamp);
   if(!outcome)continue;
   const previous=latestCadenceResolution(existingOutcomes.filter(o=>o.snapshotId===forecast.id&&o.horizonHours===horizon&&Date.parse(o.observedAt)<=Date.parse(timestamp)));
   const signature=(o:CadenceHorizonOutcome)=>digest([o.result,o.scorable,o.actualAt,[...o.evidenceIds].sort()]);
   if(previous&&signature(previous)===signature(outcome))continue;
   // Late facts and withdrawals append a new resolution; the original remains immutable.
   if(previous)outcome={...outcome,id:`forecast_cadence_horizon_${digest([forecast.id,horizon,previous.id,signature(outcome)])}`,supersedes:previous.id};
   if(await insert('forecast_outcomes',outcome,client)){outcomes++;existingOutcomes.push(outcome);}
  }
 }
 for(const target of CADENCE_TARGETS)evaluationByKind[target]=evaluateCadence(stored,existingOutcomes,target,timestamp);
 const visibleIds=new Set([...Object.values(snapshotIds),...stored.slice().sort((a,b)=>Date.parse(b.generatedAt)-Date.parse(a.generatedAt)||a.id.localeCompare(b.id)).slice(0,12).map(s=>s.id)]);
 const visible=stored.filter(s=>visibleIds.has(s.id)),publicProjection=createCadencePublicProjection(visible,publicCadenceHorizonOutcomes(existingOutcomes,visible,timestamp));
 return {snapshotId:snapshotIds.automatic_reset!,snapshotIds,snapshots,outcomes,evaluationByKind,nextDueAt,publicProjection};
}

export async function getCadenceSnapshot(id:string,client:Client):Promise<StoredCadenceForecast|undefined> {
 if(!/^forecast_cadence_[a-f0-9]{64}$/.test(id))return;
 const row=await one<unknown>('forecast_snapshots',id,client);
 return isCadence(row)?row:undefined;
}

export function projectCadenceForecast(snapshot:StoredCadenceForecast|undefined,sources:Source[],timestamp:string):ResetCadenceForecast|undefined {
 if(!snapshot)return;
 if(snapshot.modelVersion!==RESET_CADENCE_MODEL_VERSION||!snapshot.target)return {...snapshot,status:'paused',p24:null,p48:null,predictedAt:null,windowStart:null,windowEnd:null,explanation:'当前模型已按用量重置与重置卡拆分；旧混合模型只保留历史记录，不作为当前预测。'};
 if(!snapshot.sourceIds.length?!(snapshot.status==='insufficient'&&cadenceSourcesAvailable(sources,[],timestamp)):snapshot.sourceIds.some(id=>!forecastSourceAvailable(sources.find(s=>s.id===id),timestamp)))return {...snapshot,status:'paused',p24:null,p48:null,predictedAt:null,windowStart:null,windowEnd:null,explanation:'历史重置来源暂停、失效或采集延迟，暂不提供当前估计；固定预测记录继续保留。'};
 if(!Number.isFinite(Date.parse(timestamp))||!Number.isFinite(Date.parse(snapshot.generatedAt))||!Number.isFinite(Date.parse(snapshot.validUntil))||Date.parse(snapshot.generatedAt)>Date.parse(timestamp)||Date.parse(snapshot.validUntil)<=Date.parse(timestamp))return {...snapshot,status:'paused',p24:null,p48:null,predictedAt:null,windowStart:null,windowEnd:null,explanation:'预测更新已超时，等待后台重新计算；旧记录不会冒充当前预测。'};
 return snapshot;
}

export function cadenceOutcomes(rows:unknown[]):CadenceOutcome[]{return rows.filter(isOutcome).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));}


/** Bounded public resolutions, never an export of every historic forecast row. */
export function publicCadenceHorizonOutcomes(rows:unknown[],snapshots:StoredCadenceForecast[],timestamp:string):CadenceHorizonOutcome[] {
 const now=Date.parse(timestamp),allowed=new Map(snapshots.filter(s=>s.modelVersion===RESET_CADENCE_MODEL_VERSION&&!!s.target).map(s=>[s.id,s]));
 const groups=new Map<string,CadenceHorizonOutcome[]>();
 for(const outcome of rows.filter(isCadenceHorizonOutcome)){
  const snapshot=allowed.get(outcome.snapshotId),generated=Date.parse(snapshot?.generatedAt??''),observed=Date.parse(outcome.observedAt),end=generated+outcome.horizonHours*3600_000;
  if(!snapshot||outcome.modelVersion!==RESET_CADENCE_MODEL_VERSION||outcome.modelVersion!==snapshot.modelVersion||outcome.target!==snapshot.target||![24,48].includes(outcome.horizonHours)||!['occurred','not_occurred','unknown'].includes(outcome.result)||!Number.isFinite(generated)||!Number.isFinite(observed)||!Number.isFinite(now)||observed>now||observed<end||Date.parse(outcome.windowStart)!==generated||Date.parse(outcome.windowEnd)!==end)continue;
  const key=`${outcome.snapshotId}:${outcome.horizonHours}`,group=groups.get(key)??[];group.push(outcome);groups.set(key,group);
 }
 const selected:CadenceHorizonOutcome[]=[];
 for(const group of groups.values()){
  const latest=latestCadenceResolution(group);
  if(latest)selected.push(latest);
 }
 return selected.sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)||a.snapshotId.localeCompare(b.snapshotId)||a.horizonHours-b.horizonHours);
}
