import {isHistoricalArticle,isHistoricalEvidence} from './history';
import type {Evidence,Publication} from './types';

export const OBSERVATION_INTERVAL_MS=300_000;
export const OBSERVATION_DURATION_MS=72*3600_000;
export const AUTOMATION_OBSERVATION_RULE_VERSION='automation-collection-audit-runtime-v2';
export const OBSERVATION_SOURCES=['official-status','official-releases','reset-archive','activity-archive','tibo-public'];
type ObservationStatus='waiting_configuration_or_recovery'|'observing'|'ready_for_review'|'waiting_real_model'|'waiting_new_message'|'waiting_real_generated_publication'|'waiting_new_template_publication'|'interrupted';
export interface AutomationObservation {
 startedAt:string;requiredUntil?:string;continuousHealthySince?:string;samples:number;status:string;lastSampleAt?:string;
 realNewMessages:number;actualModelCalls:number;realGeneratedPublications:number;sourceFailureSamples:number;workerFailureSamples:number;
 failedSamples:number;maxSamplingGapMs:number;recordedPublicationIds:string[];blockers:string[];publicVersion?:string;error?:string;
 observedGeneratedPublicationIds?:string[];observedTemplatePublicationIds?:string[];
 currentRealGeneratedPublications?:number;realTemplatePublications?:number;currentRealTemplatePublications?:number;
 runtimeBlockers?:string[];continuousRuntimeHealthySince?:string;runtimeRequiredUntil?:string;runtimeStatus?:ObservationStatus;
 continuousTemplateHealthySince?:string;templateRequiredUntil?:string;templateStatus?:ObservationStatus;
 ruleVersion?:string;ruleActivatedAt?:string;processedCollectionFailureIds?:string[];collectionFailureEvents?:number;
 lastCollectionFailureAt?:string;collectionFailureScannedFrom?:string;collectionFailureReadThrough?:string;
 runtimeIdentity?:string;runtimeBuildId?:string;
}
export interface ObservationSource {
 id:string;status:string;enabled:boolean;validated:boolean;lastSuccessAt?:string;intervalMinutes:number;publicationPaused:boolean;
}
export interface ObservationInput {
 time:string;sources:ObservationSource[];heartbeatAt?:string;workerError?:string;aiReady:boolean;modelSuccessfulCalls:number;
 evidence:Evidence[];publications:Publication[];automaticPublicationIds:ReadonlySet<string>;
 publicData?:{version:string;ids:ReadonlySet<string>;currentIds:ReadonlySet<string>};
 collectionFailures:CollectionFailureScan;
 runtimeIdentity:string;runtimeBuildId:string;
}
export interface CollectionFailureScan {
 scannedFrom:string;readThrough:string;total:number;
 records:{id:string;sourceId:string|null;failedAt:string|null}[];
}
function validObservation(value:unknown):value is AutomationObservation {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const state=value as AutomationObservation;
 const counters=['samples','realNewMessages','actualModelCalls','realGeneratedPublications','sourceFailureSamples','workerFailureSamples','failedSamples','maxSamplingGapMs'] as const;
 const failureIds=state.processedCollectionFailureIds;
 if(state.ruleVersion!==undefined&&(typeof state.ruleVersion!=='string'||!state.ruleVersion))return false;
 if(failureIds!==undefined&&(!Array.isArray(failureIds)||failureIds.some(id=>typeof id!=='string'||!id)||new Set(failureIds).size!==failureIds.length))return false;
 if(state.collectionFailureEvents!==undefined&&(!Number.isInteger(state.collectionFailureEvents)||state.collectionFailureEvents<0||failureIds&&state.collectionFailureEvents!==failureIds.length))return false;
 if(state.ruleActivatedAt!==undefined&&(typeof state.ruleActivatedAt!=='string'||!Number.isFinite(Date.parse(state.ruleActivatedAt))||Date.parse(state.ruleActivatedAt)<Date.parse(state.startedAt)||!state.lastSampleAt||Date.parse(state.ruleActivatedAt)>Date.parse(state.lastSampleAt)))return false;
 for(const key of ['lastCollectionFailureAt','collectionFailureReadThrough'] as const)if(state[key]!==undefined&&(typeof state[key]!=='string'||!Number.isFinite(Date.parse(state[key]!))||Date.parse(state[key]!)<Date.parse(state.startedAt)||!state.lastSampleAt||Date.parse(state[key]!)>Date.parse(state.lastSampleAt)))return false;
 if(state.collectionFailureScannedFrom!==undefined&&(typeof state.collectionFailureScannedFrom!=='string'||!Number.isFinite(Date.parse(state.collectionFailureScannedFrom))||Date.parse(state.collectionFailureScannedFrom)>Date.parse(state.startedAt)))return false;
 if(state.ruleVersion===AUTOMATION_OBSERVATION_RULE_VERSION&&(!state.ruleActivatedAt||!failureIds||state.collectionFailureEvents===undefined||typeof state.runtimeIdentity!=='string'||!state.runtimeIdentity||typeof state.runtimeBuildId!=='string'||!state.runtimeBuildId))return false;
 return typeof state.startedAt==='string'&&Number.isFinite(Date.parse(state.startedAt))&&(!state.lastSampleAt||typeof state.lastSampleAt==='string'&&Number.isFinite(Date.parse(state.lastSampleAt))&&Date.parse(state.lastSampleAt)>=Date.parse(state.startedAt))&&typeof state.status==='string'&&counters.every(key=>Number.isFinite(state[key])&&state[key]>=0)&&(Number.isInteger(state.samples))&&Array.isArray(state.recordedPublicationIds)&&state.recordedPublicationIds.every(id=>typeof id==='string'&&!!id)&&Array.isArray(state.blockers)&&state.blockers.every(reason=>typeof reason==='string');
}
function journalRows(raw:string):Record<string,unknown>[] {
 if(!raw)return [];
 if(!raw.endsWith('\n'))throw new Error('观察日志存在未完成行');
 return raw.slice(0,-1).split('\n').map(line=>{
  const row:unknown=JSON.parse(line);
  if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('观察日志行无效');
  return row as Record<string,unknown>;
 });
}
/** Recover only committed complete journal lines; old samples never reconstruct continuity. */
export function recoverAutomationObservation(saved:AutomationObservation,samplesRaw:string,timingsRaw:string):AutomationObservation {
 if(!validObservation(saved))throw new Error('观察状态无效');
 const timings=journalRows(timingsRaw),samples=journalRows(samplesRaw),timingIds=new Set(saved.recordedPublicationIds);
 for(const row of timings){if(typeof row.publicationId!=='string'||!row.publicationId)throw new Error('观察发布时间记录无效');timingIds.add(row.publicationId);}
 let restored=saved;
 const committed=new Map<string,string>();
 for(const row of samples){
  if(typeof row.time!=='string'||!Number.isFinite(Date.parse(row.time)))throw new Error('观察采样时间无效');
  if(!Object.hasOwn(row,'observationState')){if(Object.hasOwn(row,'sampleId')||Object.hasOwn(row,'sequence'))throw new Error('新格式采样缺少恢复状态');continue;}
  if(!validObservation(row.observationState))throw new Error('可恢复的观察状态无效');
  const state=row.observationState;
  if(row.sequence!==state.samples||row.sampleId!==`${state.startedAt}:${state.samples}`||row.time!==state.lastSampleAt||state.samples<1)throw new Error('观察采样身份无效');
  const serialized=JSON.stringify(state),old=committed.get(row.sampleId as string);
  if(old!==undefined&&old!==serialized)throw new Error('同一观察采样编号存在冲突');
  committed.set(row.sampleId as string,serialized);
  if(state.startedAt===saved.startedAt&&state.samples>restored.samples){
   if(saved.lastSampleAt&&Date.parse(state.lastSampleAt!)<Date.parse(saved.lastSampleAt))throw new Error('恢复采样时间早于已有状态');
   restored=state;
  }
 }
 return {...restored,recordedPublicationIds:[...new Set([...timingIds,...restored.recordedPublicationIds])]};
}
function fresh(timestamp:string|undefined,now:number,maxAge:number):boolean {
 const age=now-Date.parse(timestamp??'');return Number.isFinite(age)&&age>=0&&age<=maxAge;
}
function clock(previous:string|undefined,time:string,blocked:boolean):{since?:string;until?:string;elapsed:boolean} {
 const timestamp=Date.parse(time);
 const since=blocked?undefined:previous&&Number.isFinite(Date.parse(previous))&&Date.parse(previous)<=timestamp?previous:time;
 const until=since?new Date(Date.parse(since)+OBSERVATION_DURATION_MS).toISOString():undefined;
 return {since,until,elapsed:!!until&&timestamp>=Date.parse(until)};
}
/** Scan the whole original anchor every time: a transaction may commit after an earlier sample. */
function collectionFailureProjection(previous:AutomationObservation,input:ObservationInput,enabledSources:ObservationSource[]) {
 const scan=input.collectionFailures,started=Date.parse(previous.startedAt),timestamp=Date.parse(input.time);
 const from=Date.parse(scan?.scannedFrom??''),through=Date.parse(scan?.readThrough??'');
 if(!scan||!Number.isFinite(from)||from>started||!Number.isFinite(through)||through<started||through>timestamp||previous.lastSampleAt&&through<Date.parse(previous.lastSampleAt)||!Array.isArray(scan.records)||!Number.isInteger(scan.total)||scan.total<0||scan.total!==scan.records.length)throw new Error('采集失败审计未完整覆盖观察锚点');
 const enabledIds=new Set(enabledSources.map(source=>source.id)),processed=new Set(previous.processedCollectionFailureIds??[]),seen=new Map<string,string>();
 const newlySeen:{id:string;failedAt:string;timestamp:number}[]=[];
 for(const record of scan.records){
  if(!record||typeof record.id!=='string'||!record.id)throw new Error('采集失败审计编号无效');
  const serialized=JSON.stringify([record.sourceId,record.failedAt]),old=seen.get(record.id);
  if(old!==undefined&&old!==serialized)throw new Error('采集失败审计编号存在冲突');
  seen.set(record.id,serialized);
  const failedAt=typeof record.failedAt==='string'?Date.parse(record.failedAt):NaN;
  if(!Number.isFinite(failedAt)||failedAt>timestamp)throw new Error('采集失败审计时间无效');
  if(failedAt<started)continue;
  if(typeof record.sourceId!=='string'||!record.sourceId)throw new Error('采集失败审计缺少来源归属');
  if(!enabledIds.has(record.sourceId)||processed.has(record.id))continue;
  processed.add(record.id);newlySeen.push({id:record.id,failedAt:record.failedAt!,timestamp:failedAt});
 }
 const changed=previous.ruleVersion!==AUTOMATION_OBSERVATION_RULE_VERSION;
 const interrupts=(since:string|undefined)=>{
  const beginning=changed?timestamp:Date.parse(since??'');
  return Number.isFinite(beginning)&&newlySeen.some(record=>record.timestamp>=beginning);
 };
 const latest=newlySeen.reduce((current,record)=>!current||record.timestamp>Date.parse(current)?record.failedAt:current,previous.lastCollectionFailureAt);
 return {changed,processed:[...processed],newlySeen,lastFailureAt:latest,fullInterrupted:interrupts(previous.continuousHealthySince),runtimeInterrupted:interrupts(previous.continuousRuntimeHealthySince),templateInterrupted:interrupts(previous.continuousTemplateHealthySince)};
}
/** Read-only acceptance projections. A successful connection test alone never qualifies a publication. */
export function evaluateAutomationObservation(previous:AutomationObservation,input:ObservationInput) {
 const timestamp=Date.parse(input.time),started=Date.parse(previous.startedAt);
 if(!validObservation(previous)||!Number.isFinite(timestamp)||!Number.isFinite(started)||timestamp<started)throw new Error('观察时间或状态无效');
 if(typeof input.runtimeIdentity!=='string'||!input.runtimeIdentity||typeof input.runtimeBuildId!=='string'||!input.runtimeBuildId)throw new Error('实际运行版本与进程身份无法核对');
 const gap=previous.lastSampleAt?timestamp-Date.parse(previous.lastSampleAt):0;
 const workerHealthy=fresh(input.heartbeatAt,timestamp,180_000)&&!input.workerError;
 const enabledSources=input.sources.filter(source=>source.enabled&&source.id!=='manual');
 const failures=collectionFailureProjection(previous,input,enabledSources);
 const unhealthySources=enabledSources.filter(source=>!source.validated||source.status!=='healthy'||source.publicationPaused||!fresh(source.lastSuccessAt,timestamp,(source.intervalMinutes||5)*3*60_000));
 const sourceFailure=enabledSources.length===0||unhealthySources.length>0;
 const restarted=previous.ruleVersion===AUTOMATION_OBSERVATION_RULE_VERSION&&(previous.runtimeIdentity!==input.runtimeIdentity||previous.runtimeBuildId!==input.runtimeBuildId);
 const baseRuntimeBlockers=[...(sourceFailure?['来源未启用、未验证、采集延迟或发布暂停']:[]),...(!workerHealthy?['任务服务异常或心跳过期']:[]),...(!input.publicData?['网站公开接口不可用']:[]),...(restarted?['运行进程或构建版本发生变化，连续验收重新计时']:[]),...(!Number.isFinite(gap)||gap<0||gap>OBSERVATION_INTERVAL_MS*2?['连续采样出现超过十分钟的缺口或时间异常']:[])];
 const auditBlocker='连续观察期间发生采集失败（已核对持久审计）';
 const runtimeBlockers=[...baseRuntimeBlockers,...(failures.runtimeInterrupted?[auditBlocker]:[])];
 const templateBlockers=[...baseRuntimeBlockers,...(failures.templateInterrupted?[auditBlocker]:[])];
 const blockers=[...baseRuntimeBlockers,...(failures.fullInterrupted?[auditBlocker]:[]),...(!input.aiReady?['智能服务尚未配置完成']:[])];
 const newEvidence=input.evidence.filter(item=>!isHistoricalEvidence(item)&&item.provenance!=='manual'&&Date.parse(item.publishedAt)>started&&Date.parse(item.publishedAt)<=timestamp&&Date.parse(item.collectedAt)<=timestamp);
 const newIds=new Set(newEvidence.map(item=>item.id));
 const qualified=input.publications.filter(publication=>{
  if(!input.automaticPublicationIds.has(publication.id)||Date.parse(publication.publishedAt)<=started||Date.parse(publication.publishedAt)>timestamp||publication.article.status!=='published'||publication.event.status!=='published'||publication.article.publicationId!==publication.id||isHistoricalArticle(publication.article,input.evidence))return false;
  const cited=input.evidence.filter(item=>publication.article.evidenceIds.includes(item.id));
  return cited.length>0&&cited.length===new Set(publication.article.evidenceIds).size&&cited.every(item=>item.provenance!=='manual')&&cited.some(item=>newIds.has(item.id));
 });
 const seen=(origin:'generated'|'template',saved:string[]|undefined)=>{
  const eligible=qualified.filter(publication=>publication.contentOrigin===origin);
  const savedIds=new Set(saved??[]);
  return eligible.filter(publication=>savedIds.has(publication.id)||input.publicData?.ids.has(publication.id)).map(publication=>publication.id).sort();
 };
 const generatedIds=seen('generated',previous.observedGeneratedPublicationIds),templateIds=seen('template',previous.observedTemplatePublicationIds);
 const current=(ids:string[])=>ids.filter(id=>input.publicData?.currentIds.has(id)).length;
 const full=clock(failures.changed?undefined:previous.continuousHealthySince,input.time,blockers.length>0),runtime=clock(failures.changed?undefined:previous.continuousRuntimeHealthySince,input.time,runtimeBlockers.length>0),template=clock(failures.changed?undefined:previous.continuousTemplateHealthySince,input.time,templateBlockers.length>0);
 const realNewMessages=new Set(newEvidence.map(item=>item.url)).size;
 const fullStatus:ObservationStatus=blockers.length?'waiting_configuration_or_recovery':!full.elapsed?'observing':!input.modelSuccessfulCalls?'waiting_real_model':!realNewMessages?'waiting_new_message':!generatedIds.length?'waiting_real_generated_publication':'ready_for_review';
 const state:AutomationObservation={...previous,samples:previous.samples+1,lastSampleAt:input.time,continuousHealthySince:full.since,requiredUntil:full.until,blockers,runtimeBlockers,
  ruleVersion:AUTOMATION_OBSERVATION_RULE_VERSION,ruleActivatedAt:failures.changed?input.time:previous.ruleActivatedAt,processedCollectionFailureIds:failures.processed,collectionFailureEvents:(previous.collectionFailureEvents??0)+failures.newlySeen.length,lastCollectionFailureAt:failures.lastFailureAt,collectionFailureScannedFrom:input.collectionFailures.scannedFrom,collectionFailureReadThrough:input.collectionFailures.readThrough,
  runtimeIdentity:input.runtimeIdentity,runtimeBuildId:input.runtimeBuildId,
  continuousRuntimeHealthySince:runtime.since,runtimeRequiredUntil:runtime.until,runtimeStatus:runtimeBlockers.length?'waiting_configuration_or_recovery':runtime.elapsed?'ready_for_review':'observing',
  continuousTemplateHealthySince:template.since,templateRequiredUntil:template.until,templateStatus:templateBlockers.length?'waiting_configuration_or_recovery':!template.elapsed?'observing':templateIds.length?'ready_for_review':'waiting_new_template_publication',
  observedGeneratedPublicationIds:generatedIds,observedTemplatePublicationIds:templateIds,realGeneratedPublications:generatedIds.length,currentRealGeneratedPublications:current(generatedIds),realTemplatePublications:templateIds.length,currentRealTemplatePublications:current(templateIds),
  maxSamplingGapMs:Math.max(previous.maxSamplingGapMs,Number.isFinite(gap)?gap:0),realNewMessages,actualModelCalls:input.modelSuccessfulCalls,sourceFailureSamples:previous.sourceFailureSamples+Number(sourceFailure),workerFailureSamples:previous.workerFailureSamples+Number(!workerHealthy),publicVersion:input.publicData?.version,error:undefined,status:fullStatus};
 return {state,workerHealthy,sourceFailure,qualifiedPublicationIds:qualified.map(publication=>publication.id),newCollectionFailures:failures.newlySeen.length,collectionFailureInterrupted:failures.fullInterrupted||failures.runtimeInterrupted||failures.templateInterrupted};
}
