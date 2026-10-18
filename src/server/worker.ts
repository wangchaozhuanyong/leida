import {REFERENCE_RESET_SOURCE,REFERENCE_SOURCES} from './reference-reset-source';
import { lockTransaction } from '../db';
import { configuredStorageRpc } from './cloudbase/storage-config';
import { cloudbaseTasks } from './cloudbase/tasks';
import { CloudbaseRpcError } from './cloudbase/rpc';
import { pool, list, one, insert, put, transaction, withAutoPublicationGuard } from '../db';
import type { Candidate, Evidence, Job, Source, SiteSettings, RadarEvent, DraftContent, CandidateAutomation, Article } from '../lib/types';
import { AIServiceError, generateContent, type AIRecord } from './ai';
import { collectSource, SourceStructureError, SourceRateLimitError, SourceConfigurationError, SourceTransientError } from './ingestion';
import { gatherEvidenceContext, gatherExplicitEvidenceContext, hasCompleteContext, evidenceBenefitClaims, directEvidenceBenefitClaims, processingObstacles, isVerifiedCampaignCalendar } from './source-context';
import { extractBenefitClaims } from './benefit-rules';
import { buildAutomaticTemplate, evidenceFingerprint, classifyBlockers, isClearlyUnrelated, hasExplicitCorrectionText } from './automatic-content';
import { enrichKnownEvidence, enrichQuotedResetContext } from './source-enrichment';
import { DomainError, now, validateDraft, hash } from './domain';
import { audit, createEvidence, publishCandidate, queueJob, defaultSite, publishedTemplateArticle, isStaleMachineConflict, automaticNewsContextUpgrade } from './service';
import { isHistoricalContent } from '../lib/history';
import {processWechatJob,scheduleWechatDeliveries} from './wechat';
import {runForecastCycle} from './forecast';
import {createWorkerCadence,safeWorkerFailure,type WorkerPhase} from './worker-timing';
import {sourceCollectionSchedule,sourceNextCollectionAt,verifiedCollectionWindow} from './source-collection-policy';

const MAX_ACTIVE_GENERATION = 10;
const MAX_ACTIVE_HISTORICAL = 2;
const MAX_GENERATION_ATTEMPTS = 3;
const activeJob = (job:Job) => job.status === 'queued' || job.status === 'running';
const enabledSource = (source:Source|undefined) => !!source?.enabled && source.validated && !source.publicationPaused && source.kind !== 'manual' && source.id!=='tibo-timeline';
const CONTEXT_PROBE_INTERVAL = 15 * 60_000;
export function sourceCollectionDue(source:Source,timestamp=Date.now()):boolean {
  return source.id!=='tibo-timeline' && source.enabled && source.kind!=='manual' && (source.validated || source.pauseReason==='structure'&&source.publicationPaused===true) && (!source.nextRunAt || Date.parse(source.nextRunAt)<=timestamp);
}
export function generationCooldown(cycle:number,timestamp=Date.now()):string {
  return new Date(timestamp+[15,30,60][Math.min(Math.max(cycle-1,0),2)]*60_000).toISOString();
}
export function isRecoverableStorageError(error:unknown):boolean {
  if(error instanceof CloudbaseRpcError)return ['conflict','unknown','rejected'].includes(error.kind);
  const code=typeof error==='object'&&error!==null&&'code' in error?String(error.code):'';
  return /^(?:08[A-Z0-9]{3}|40001|40P01|53300|57P0[123]|ECONNRESET|ECONNREFUSED|ETIMEDOUT)$/.test(code);
}
export function sourceRetryAt(source:Source,retryAt?:string,timestamp=Date.now()):string {
  const failures=(source.consecutiveFailures??0)+1;
  const backoff=source.pauseReason==='structure'?CONTEXT_PROBE_INTERVAL:Math.min(60,2**Math.min(failures,6))*60_000;
  return new Date(Math.max(timestamp+backoff,retryAt?Date.parse(retryAt):0)).toISOString();
}
export function contextFor(candidate:Candidate,primary:Evidence,all:Evidence[]):Evidence[] {
  const supplemental=all.filter(item=>candidate.content.evidenceIds.includes(item.id)&&all.find(latest=>latest.sourceId===item.sourceId&&latest.messageId===item.messageId)?.id===item.id);
  const context=[...new Map([...gatherEvidenceContext(primary,all),...supplemental].map(item=>[item.id,item])).values()];
  return hasCompleteContext(primary,context)?context.filter(item=>hasCompleteContext(item,context)||isVerifiedCampaignCalendar(item,context)):context;
}
export function canEnrich(primary:Evidence):boolean {
  return (primary.provenance==='archive'||primary.provenance==='official'&&primary.sourceId==='tibo-timeline') && (primary.textOrigin!=='original'||!primary.contextComplete&&(!!primary.parentId||/https:\/\/t\.co\/[A-Za-z0-9]+\b/.test(primary.text))) && /^https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+(?:[?#].*)?$/.test(primary.url);
}
export function aiReady(ai:AIRecord|undefined):boolean {
  return !!(ai?.enabled && ai.testedAt && ai.encryptedKey && ai.model && ai.baseUrl && ai.dailyCallLimit > 0 && ai.dailyBudget > 0 && ai.inputPrice > 0 && ai.outputPrice > 0);
}
export function nextBudgetDay(timestamp=Date.now()):string {
  const offset=8*3600_000,day=24*3600_000;
  return new Date(Math.floor((timestamp+offset)/day)*day+day-offset).toISOString();
}
function sourceFor(candidate:Candidate,evidence:Evidence[],sources:Source[]):Source|undefined {
  return sources.find(source=>source.id===evidence.find(item=>item.id===candidate.evidenceId)?.sourceId);
}
function untouched(candidate:Candidate):boolean {
  return (candidate.status==='pending' || candidate.status==='published'&&candidate.automation?.templatePublished===true) && !candidate.humanEdited;
}
export function fingerprintChange(saved:string|undefined,current:string):'new'|'none'|'rules'|'evidence' {
 if(!saved)return 'new';if(saved===current)return 'none';
 const evidenceHash=(value:string)=>value.match(/^(?:[A-Za-z0-9._-]+:)?([a-f0-9]{64})$/)?.[1];
 const previous=evidenceHash(saved),next=evidenceHash(current);
 return previous&&next&&previous===next?'rules':'evidence';
}
/** The latest typed completion is a reconciliation lead, not a published fact.
 * Give its original-text check a turn before older history probes consume both
 * slots. The usual source, context, publication and historical-alert guards still apply. */
function latestReferenceCompletionLead(evidence:Evidence[],timestamp:number):Evidence|undefined {
  return evidence.filter(item=>{
    const proof=item.metadata?.referenceReset;
    return item.sourceId===REFERENCE_RESET_SOURCE.id&&item.provenance==='archive'&&!item.parentId&&item.metadata?.sourceGroup==='aiplanwatch'&&item.metadata.benefitKind==='automatic_reset'&&proof?.referenceUrl===REFERENCE_RESET_SOURCE.url&&proof.occurredAt===item.publishedAt&&Number.isFinite(Date.parse(item.publishedAt))&&Date.parse(item.publishedAt)<=timestamp;
  }).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)||Date.parse(b.collectedAt)-Date.parse(a.collectedAt))[0];
}
export function generationCandidateOrder(candidates:Candidate[],evidence:Evidence[],timestamp=Date.now()):Candidate[] {
  const latestReference=latestReferenceCompletionLead(evidence,timestamp);
  const at=new Date(timestamp).toISOString();
  return [...candidates].sort((a,b)=>{
    const first=evidence.find(item=>item.id===a.evidenceId),second=evidence.find(item=>item.id===b.evidenceId);
    const firstHistorical=!!first&&isHistoricalContent([first],at),secondHistorical=!!second&&isHistoricalContent([second],at);
    const firstTime=Date.parse(first?.publishedAt??a.createdAt),secondTime=Date.parse(second?.publishedAt??b.createdAt);
    const firstLead=!!latestReference&&first?.id===latestReference.id,secondLead=!!latestReference&&second?.id===latestReference.id;
    return Number(firstHistorical)-Number(secondHistorical)||Number(secondLead)-Number(firstLead)||(firstHistorical?firstTime-secondTime:secondTime-firstTime);
  });
}
export async function scheduleDue(options:{allowTemplates?:boolean;allowEnrichment?:boolean;skipGeneration?:boolean;skipSources?:boolean}={}):Promise<void> {
  const allowTemplates=options.allowTemplates!==false;
  await transaction(async c=>{
    await lockTransaction(c,'radar_scheduler');
    const sources=await list<Source>('sources',c);
    // Install only alongside an already enabled primary collector. Initial data
    // is a silent reconciliation; administrator pauses remain authoritative.
    if(!options.skipSources&&sources.some(source=>source.id==='tibo-public'&&source.enabled&&source.validated))for(const definition of REFERENCE_SOURCES){
      if(sources.some(source=>source.id===definition.id))continue;
      const reference={...definition,enabled:true,publicationPaused:true,pauseReason:'structure' as const,nextRunAt:now()};
      await put('sources',reference,c);sources.push(reference);
      await audit('worker','source.reference.register',reference.id,'已启用公开数据低频对账；不替代实时原文采集',undefined,{intervalMinutes:definition.intervalMinutes},c);
    }
    for(const source of options.skipSources?[]:sources) if(sourceCollectionDue(source)) {
      await queueJob('collect',{sourceId:source.id,structureProbe:source.pauseReason==='structure'},c);
      const schedule=sourceCollectionSchedule(source);
      await put('sources',{...source,...schedule,nextRunAt:sourceNextCollectionAt(source)},c);
    }
    if(options.skipGeneration)return;
    const ai=await one<AIRecord>('settings','ai',c);
    const ready=aiReady(ai);
    const site=await one<SiteSettings>('settings','site',c)??defaultSite;
    const candidates=await list<Candidate>('candidates',c);
    const evidence=await list<Evidence>('evidence',c);
    const articles=await list<Article>('articles',c);
    const events=await list<RadarEvent>('events',c);
    const collectionWindow=verifiedCollectionWindow(events,evidence);
    for(const source of sources){
      const schedule=sourceCollectionSchedule({...source,collectionWindow});
      if(schedule.collectionPolicy!=='adaptive')continue;
      if(JSON.stringify(source.collectionWindow)!==JSON.stringify(collectionWindow)||source.effectiveIntervalMinutes!==schedule.effectiveIntervalMinutes||source.collectionPolicy!==schedule.collectionPolicy||source.intervalMinutes!==schedule.intervalMinutes){
        const updated={...source,...schedule,collectionWindow};
        const due=sourceNextCollectionAt(updated,Date.parse(source.lastSuccessAt??now()));
        await put('sources',{...updated,nextRunAt:source.status==='failed'?source.nextRunAt:source.nextRunAt&&Date.parse(source.nextRunAt)<Date.parse(due)?source.nextRunAt:due},c);
      }
    }
    if(!ready&&!site.autoPublish)return;
    const jobs=await list<Job>('jobs',c);
    const generating=jobs.filter(job=>job.kind==='generate');
    let active=generating.filter(activeJob).length;
    let historicalActive=generating.filter(job=>activeJob(job)&&(job.payload.historical===true||evidence.some(item=>item.id===candidates.find(candidate=>candidate.id===job.candidateId)?.evidenceId&&isHistoricalContent([item],job.createdAt)))).length;
    const sorted=generationCandidateOrder(candidates.filter(candidate=>untouched(candidate)&&!candidate.reasons.some(reason=>reason.includes('由人工草稿'))),evidence);
    const lead=latestReferenceCompletionLead(evidence,Date.now());
    const pendingReference=lead&&enabledSource(sources.find(source=>source.id===lead.sourceId))&&sorted.some(candidate=>candidate.evidenceId===lead.id&&candidate.status==='pending');
    for(const candidate of sorted) {
      if(active>=MAX_ACTIVE_GENERATION)break;
      if(candidate.automation?.reasonCodes.includes('parent_conflict'))continue;
      const original=evidence.find(item=>item.id===candidate.evidenceId);
      if(original&&evidence.find(item=>item.sourceId===original.sourceId&&item.messageId===original.messageId)?.id!==original.id)continue;
      if(!original || original.provenance==='manual' || !enabledSource(sourceFor(candidate,evidence,sources)))continue;
      if(candidate.status==='pending'&&isClearlyUnrelated(original)) {
        const ignored:Candidate={...candidate,status:'ignored',version:candidate.version+1,reasons:['自动排除无事实信息的回复，原文仍保留'],updatedAt:now(),automation:{state:'ready',reasonCodes:['unrelated_content'],dependencyIds:[],inputFingerprint:evidenceFingerprint([original]),evaluatedAt:now()}};
        await put('candidates',ignored,c);
        await audit('worker','candidate.auto_ignore',candidate.id,'自动排除无事实信息的回复',candidate,ignored,c);
        continue;
      }
      const historical=isHistoricalContent([original],now());
      if(historical&&historicalActive>=MAX_ACTIVE_HISTORICAL)continue;
      // The persisted claim function serves old historical jobs first. Keep one
      // slot free of new old probes until the latest completion check runs;
      // sorting insertion alone would still starve it at claim time.
      if(historical&&pendingReference&&original.id!==lead?.id&&historicalActive>=MAX_ACTIVE_HISTORICAL-1)continue;
      const previous=generating.filter(job=>job.candidateId===candidate.id);
      if(previous.some(activeJob))continue;
      const latest=previous[0];
      const context=contextFor(candidate,original,evidence);
      const fingerprint=evidenceFingerprint(context);
      const savedFingerprint=candidate.automation?.inputFingerprint??(typeof latest?.payload.inputFingerprint==='string'?latest.payload.inputFingerprint:undefined);
      const change=fingerprintChange(savedFingerprint,fingerprint),ruleOnly=change==='rules';
      const inputChanged=savedFingerprint?change!=='none':previous.some(job=>job.payload.generated===true)&&context.some(item=>!candidate.content.evidenceIds.includes(item.id));
      const generated=previous.some(job=>job.payload.generated===true);
      const enrichArticle=candidate.status==='published'&&candidate.automation?.templatePublished===true;
      const actualArticle=enrichArticle?publishedTemplateArticle(candidate,original,evidence,articles,events):undefined;
      if(enrichArticle&&!actualArticle)continue;
      const publishedRecheck=enrichArticle&&actualArticle?.publicationMode==='news_only'&&inputChanged;
      const template=allowTemplates&&(!enrichArticle||publishedRecheck)?buildAutomaticTemplate(context):undefined;
      const obstacles=processingObstacles(context);
      if(!template&&!ready&&!enrichArticle&&!obstacles.missing){
        if(inputChanged||!savedFingerprint)await put('candidates',{...candidate,automation:{state:obstacles.conflict?'conflict':'deferred',reasonCodes:obstacles.codes,dependencyIds:[],inputFingerprint:fingerprint,evaluatedAt:now()},updatedAt:now()},c);
        continue;
      }
      const probeDue=obstacles.missing && options.allowEnrichment!==false && canEnrich(original) && (!candidate.automation?.resumeAt||Date.parse(candidate.automation.resumeAt)<=Date.now());
      const newsContextProbe=enrichArticle&&actualArticle?.publicationMode==='news_only'&&!hasCompleteContext(original,context)&&probeDue;
      const candidateEvent=events.find(event=>event.id===(candidate.content.eventId??actualArticle?.eventId));
      if(ruleOnly&&candidate.automation?.state==='conflict'&&!isStaleMachineConflict(candidate,candidateEvent)&&!isResolvedNewsContextConflict(candidate,original,context,events,evidence,articles))continue;
      // A rule release may re-evaluate supported templates once, not all old long-form model inputs.
      if(ruleOnly&&!template)continue;
      if(enrichArticle&&!ready&&!(publishedRecheck&&template)&&!newsContextProbe)continue;
      const augmentationGenerated=enrichArticle&&latest?.payload.enrichArticle===true&&latest.payload.generated===true&&candidate.content.contentOrigin==='generated';
      const resumingPublication=latest?.payload.publishOnly===true&&latest.status==='failed'&&latest.payload.blockedReason==='source';
      const publishOnly=(!enrichArticle||augmentationGenerated) && generated && !inputChanged && (candidate.reasons.length===0||resumingPublication) && site.autoPublish;
      const waitingEvidence=['waiting_evidence','deferred'].includes(candidate.automation?.state??'');
      const contextProbe=newsContextProbe||!inputChanged&&generated&&!publishOnly&&(!enrichArticle||augmentationGenerated)&&waitingEvidence&&probeDue;
      const failureDue=latest?.status==='failed'&&(
        latest.payload.blockedReason==='budget'&&(Date.parse(String(latest.payload.resumeAfter))<=Date.now()||latest.payload.aiVersion!==ai?.version)||
        ['configuration','capacity'].includes(String(latest.payload.blockedReason))&&latest.payload.aiVersion!==ai?.version||
        latest.payload.blockedReason==='source'||latest.payload.blockedReason==='cooldown'&&Date.parse(String(latest.payload.resumeAfter))<=Date.now());
      if(candidate.automation?.state==='conflict'&&!inputChanged)continue;
      if(augmentationGenerated&&!inputChanged&&!publishOnly&&!contextProbe&&!failureDue)continue;
      if(generated&&!publishOnly&&!enrichArticle&&!inputChanged&&!contextProbe&&!failureDue)continue;
      if(!publishOnly&&!ready&&!template&&!probeDue)continue;
      if(latest?.status==='failed') {
        if(!failureDue&&!inputChanged)continue;
        const {blockedReason:_blocked,resumeAfter:_resume,failureKind:_kind,...oldPayload}=latest.payload;
        const payload={...oldPayload,historical,aiVersion:ai?.version,expectedVersion:candidate.version,inputFingerprint:fingerprint,...(inputChanged?{generated:false,generatedCandidateVersion:undefined,publishOnly:false,contextProbe:false}:{}),...(enrichArticle?{enrichArticle:true}:{}),...(publishOnly?{publishOnly:true}:{})};
        await put('jobs',{...latest,status:'queued',attempts:0,availableAt:now(),leaseUntil:undefined,finishedAt:undefined,error:undefined,payload},c);
      } else {
        if(latest&&!generated&&!ready&&!inputChanged&&!probeDue)continue;
        await queueJob('generate',{candidateId:candidate.id,automatic:true,historical,evidencePublishedAt:original.publishedAt,aiVersion:ai?.version,expectedVersion:candidate.version,inputFingerprint:fingerprint,...(publishOnly?{publishOnly:true}:{}),...(enrichArticle?{enrichArticle:true}:{}),...(contextProbe?{contextProbe:true}:{}),...(!ready&&!template?{contextProbe:true}:{})},c);
      }
      active++;
      if(historical)historicalActive++;
    }
  });
}
export async function claimJob():Promise<Job|undefined> {
  const rpc=configuredStorageRpc();if(rpc)return cloudbaseTasks(rpc).claim();
  return transaction(async c=>{
    const row=await c.query(`SELECT id,payload FROM radar_jobs
      WHERE (payload->>'status'='queued' AND (payload->>'availableAt')::timestamptz<=now())
        OR (payload->>'status'='running' AND (payload->>'leaseUntil')::timestamptz<now())
      ORDER BY CASE WHEN payload->>'status'='running' THEN 0
        WHEN payload->>'kind'='collect' THEN 1
        WHEN payload->>'kind'='generate' AND coalesce(payload#>>'{payload,historical}','false')<>'true' THEN 2
        WHEN payload->>'kind'='generate' THEN 3 ELSE 4 END,
        CASE WHEN payload->>'kind'='generate' AND coalesce(payload#>>'{payload,historical}','false')<>'true' THEN payload#>>'{payload,evidencePublishedAt}' END DESC NULLS LAST,
        CASE WHEN payload->>'kind'='generate' AND payload#>>'{payload,historical}'='true' THEN payload#>>'{payload,evidencePublishedAt}' END ASC NULLS LAST,
        created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`);
    const old=row.rows[0]?.payload as Job|undefined;
    if(!old)return;
    const job:Job={...old,status:'running',attempts:old.attempts+1,leaseUntil:new Date(Date.now()+120_000).toISOString()};
    await put('jobs',job,c);
    return job;
  });
}
// Only explicit provider identities can connect records; model-generated event IDs never do.
function messageKey(evidence:Evidence,messageId=evidence.messageId):string {
  try {
    const url=new URL(evidence.url);
    const author=url.pathname.match(/^\/([^/]+)\/status\/\d+/)?.[1]?.toLowerCase();
    if((url.hostname==='x.com'||url.hostname==='twitter.com')&&author)return `x:${author}:${messageId}`;
  } catch { /* Non-URL fixture or legacy records remain source-scoped. */ }
  return `${evidence.sourceId}:${messageId}`;
}
function linkedBenefitContext(primary:Evidence,context:Evidence[]):{context:Evidence[];bounded:boolean} {
  // A self-contained benefit statement is the referent for its completion.
  // Its older product/activity ancestors remain lineage, not another reset round.
  const full=context;
  context=gatherExplicitEvidenceContext(primary,context);
  const benefit=evidenceBenefitClaims(primary,full).length>0;
  const referent=benefit?context.findIndex((item,index)=>index>0&&hasCompleteContext(item,full)&&directEvidenceBenefitClaims(item,full).length>0):-1;
  const standalone=benefit&&referent<0&&directEvidenceBenefitClaims(primary,full).length>0;
  return {context:referent>0?context.slice(0,referent+1):standalone?[primary]:context,bounded:referent>0||standalone};
}
/** Action identity and event links must use the same verified benefit boundary. */
export function actionIdentityEvidence(primary:Evidence,context:Evidence[]):Evidence {
  return linkedBenefitContext(primary,context).context.at(-1)??primary;
}
export function resolveLinkedEvents(primary:Evidence,context:Evidence[],events:RadarEvent[],all:Evidence[],articles:Article[]=[]):RadarEvent[] {
  const {context:linkedContext,bounded}=linkedBenefitContext(primary,context);
  const keys=new Set(linkedContext.flatMap((item,index)=>[messageKey(item),...(item.parentId&&(!bounded||index<linkedContext.length-1)?[messageKey(item,item.parentId)]:[])]));
  keys.add(messageKey(primary));
  const linked=events.filter(event=>event.evidenceIds.some(id=>{
    const item=all.find(evidence=>evidence.id===id);
    return !!item&&item.provenance!=='manual'&&(keys.has(messageKey(item)) || !!item.parentId&&keys.has(messageKey(item,item.parentId)));
  }));
  // A reviewed-as-pending ancestor is background, not a second benefit round.
  // Keep its article/history intact and upgrade the time reply's own news shell.
  if(primary.provenance==='manual'||primary.textOrigin!=='original'||!evidenceBenefitClaims(primary,context).some(claim=>claim.scope==='public'))return linked;
  const ancestorKeys=new Set(gatherExplicitEvidenceContext(primary,context).slice(1).map(item=>messageKey(item)));
  return linked.filter(event=>{
    if(event.status!=='published'||event.actions.length||event.manualFields?.length||event.mergedInto)return true;
    if(event.evidenceIds.some(id=>{const item=all.find(e=>e.id===id);return !item||item.provenance==='manual'||messageKey(item)===messageKey(primary)||!context.some(e=>e.id===id);}))return true;
    const owned=articles.filter(article=>article.eventId===event.id);
    if(owned.length!==1)return true;
    const article=owned[0],main=all.find(item=>item.id===article.evidenceIds[0]);
    return !(article.status==='published'&&article.publicationMode==='news_only'&&article.contentOrigin==='template'&&article.reviewStatus==='pending'&&!article.manualFields?.length&&main&&ancestorKeys.has(messageKey(main)));
  });
}
/** Only release the exact machine conflict eliminated by excluding pending ancestor news. */
export function isResolvedNewsContextConflict(candidate:Candidate,primary:Evidence,context:Evidence[],events:RadarEvent[],all:Evidence[],articles:Article[]):boolean {
  if(candidate.humanEdited||candidate.automation?.state!=='conflict'||!candidate.reasons.length||candidate.reasons.some(reason=>reason!=='事件关联不明'))return false;
  const before=resolveLinkedEvents(primary,context,events,all),after=resolveLinkedEvents(primary,context,events,all,articles);
  return before.length>1&&after.length===1&&after[0].status==='published'&&!after[0].manualFields?.length&&after[0].evidenceIds.some(id=>all.some(e=>e.id===id&&messageKey(e)===messageKey(primary)));
}
function resolveTarget(event:RadarEvent,events:RadarEvent[]):RadarEvent|undefined {
  let current:RadarEvent|undefined=event;
  const seen=new Set<string>();
  while(current?.status==='merged'&&current.mergedInto&&!seen.has(current.id)) {seen.add(current.id);current=events.find(item=>item.id===current!.mergedInto);}
  return current?.status==='published'?current:undefined;
}
class SourcePausedError extends DomainError {}
type Generator = (evidence:Evidence[],existing?:DraftContent)=>Promise<DraftContent>;
async function saveAutomation(candidate:Candidate,automation:CandidateAutomation,reasons=candidate.reasons):Promise<void> {
  await transaction(async c=>{
    const current=await one<Candidate>('candidates',candidate.id,c,true);
    if(current?.version===candidate.version&&!current.humanEdited)await put('candidates',{...current,automation,reasons,updatedAt:now()},c);
  });
}
async function generateCandidate(job:Job,generator:Generator,allowTemplates:boolean,enrich:typeof enrichKnownEvidence,enrichQuoted:typeof enrichQuotedResetContext):Promise<boolean> {
  let candidate=await one<Candidate>('candidates',job.candidateId!);
  if(!candidate||candidate.status==='ignored'||candidate.status==='published'&&(!job.payload.enrichArticle||!candidate.automation?.templatePublished))return false;
  if(candidate.humanEdited&&!job.payload.force)throw new DomainError('人工修改的候选不会被自动生成覆盖',409);
  if(candidate.automation?.reasonCodes.includes('parent_conflict')&&!job.payload.force)return false;
  let generatedCheckpoint=job.payload.generated===true&&job.payload.generatedCandidateVersion===candidate.version;
  if(typeof job.payload.expectedVersion==='number'&&job.payload.expectedVersion!==candidate.version&&!generatedCheckpoint)throw new DomainError('候选已被编辑，生成结果没有覆盖原内容',409);
  let all=await list<Evidence>('evidence');
  let primary=all.find(evidence=>evidence.id===candidate!.evidenceId);
  if(!primary)throw new DomainError('原文不存在');
  if(!job.payload.force) {
    const source=await one<Source>('sources',primary.sourceId);
    if(primary.provenance==='manual')throw new DomainError('人工补录不能由自动任务发布');
    if(!enabledSource(source))throw new SourcePausedError('来源已暂停或未通过验证，自动处理已暂停');
  }
  if(canEnrich(primary)&&!job.payload.publishOnly&&!generatedCheckpoint&&(!job.payload.enrichArticle||job.payload.contextProbe)) {
    let enriched:Evidence|undefined;
    try {
      enriched=await enrich(primary);
    } catch { /* Public embed failure must not block the regular source or other messages. */ }
    if(enriched) {
      const {id:_id,hash:_hash,...input}=enriched;
      const saved=await createEvidence(input);
      // A separate new-version candidate is scheduled independently; never overwrite the old article here.
      if(saved.candidate&&saved.candidate.id!==candidate.id)return false;
      if(saved.candidate)candidate=saved.candidate;
      all=await list<Evidence>('evidence');
      primary=all.find(item=>item.id===candidate!.evidenceId)??primary;
      generatedCheckpoint=false;
    }
  }
  if(primary.provenance==='archive'&&primary.textOrigin==='original'&&!hasCompleteContext(primary,contextFor(candidate,primary,all))) {
    let quoted:Evidence[]=[];
    try {quoted=await enrichQuoted(primary,all);} catch { /* An unavailable quoted original leaves this message waiting for evidence. */ }
    for(const item of quoted){
      const {id:_id,hash:_hash,...input}=item;
      const saved=await createEvidence(input);
      if(item.messageId!==primary.messageId)continue;
      if(saved.candidate&&saved.candidate.id!==candidate.id)return false;
      if(saved.candidate)candidate=saved.candidate;
      primary=saved.evidence;
      generatedCheckpoint=false;
    }
    if(quoted.length)all=await list<Evidence>('evidence');
  }
  const gathered=gatherEvidenceContext(primary,all);
  const context=contextFor(candidate,primary,all);
  const fingerprint=evidenceFingerprint(context);
  const previousFingerprint=candidate.automation?.inputFingerprint;
  if(generatedCheckpoint&&job.payload.inputFingerprint!==fingerprint)generatedCheckpoint=false;
  if(job.payload.contextProbe&&previousFingerprint===fingerprint) {
    const blocked=classifyBlockers(candidate.reasons,context);
    const obstacles=processingObstacles(context);
    const waiting=obstacles.missing;
    const state=waiting?Date.now()-Date.parse(candidate.createdAt)>24*3600_000?'deferred':'waiting_evidence':obstacles.conflict?'conflict':'deferred';
    await saveAutomation(candidate,{...blocked,state,reasonCodes:obstacles.codes,inputFingerprint:fingerprint,evaluatedAt:now(),resumeAt:waiting?new Date(Date.now()+CONTEXT_PROBE_INTERVAL).toISOString():undefined,articleId:candidate.automation?.articleId,templatePublished:candidate.automation?.templatePublished});
    return false;
  }
  const ai=await one<AIRecord>('settings','ai');
  const actualArticle=job.payload.enrichArticle?publishedTemplateArticle(candidate,primary,all,await list<Article>('articles'),await list<RadarEvent>('events')):undefined;
  if(job.payload.enrichArticle&&!actualArticle)throw new DomainError('已发布模板已撤回、被人工处理或关联发生变化，自动补充未覆盖现有内容',409);
  const publishedRecheck=actualArticle?.publicationMode==='news_only'&&fingerprint!==previousFingerprint;
  const template=allowTemplates&&(!job.payload.enrichArticle||publishedRecheck)?buildAutomaticTemplate(context):undefined;
  let draft:DraftContent;
  if(job.payload.publishOnly&&job.payload.inputFingerprint===fingerprint||generatedCheckpoint)draft=structuredClone(candidate.content);
  else if(template)draft=template;
  else if(aiReady(ai)||generator!==generateContent)draft={...await generator(context,candidate.content),contentOrigin:'generated'};
  else {
    const blocked=classifyBlockers(candidate.reasons,context);
    const obstacles=processingObstacles(context);
    const waiting=obstacles.missing;
    await saveAutomation(candidate,{...blocked,state:waiting?'waiting_evidence':obstacles.conflict?'conflict':'deferred',reasonCodes:obstacles.codes,inputFingerprint:fingerprint,evaluatedAt:now(),resumeAt:waiting?new Date(Date.now()+CONTEXT_PROBE_INTERVAL).toISOString():undefined,articleId:candidate.automation?.articleId,templatePublished:candidate.automation?.templatePublished});
    return false;
  }
  // Hold only the short link/publish phase, never an external model request.
  return withAutoPublicationGuard(async()=>{
    draft.evidenceIds=[...new Set([...draft.evidenceIds,...context.map(item=>item.id)])];
    if(candidate.content.activityId) {draft.activityId=candidate.content.activityId;draft.activityDay=candidate.content.activityDay;}
    const events=await list<RadarEvent>('events');
    const articles=await list<Article>('articles');
    const matched=resolveLinkedEvents(primary,gathered,events,all,articles);
    let linked=[...new Map(matched.map(event=>resolveTarget(event,events)).filter((event):event is RadarEvent=>!!event).map(event=>[event.id,event])).values()];
    if(linked.length>1){
      linked=linked.filter(event=>!linked.some(target=>target.id!==event.id&&automaticNewsContextUpgrade(primary,draft,event,target,all,articles)));
    }
    if(draft.publicationMode==='news_only'&&draft.reviewStatus){
      // Campaign/background citations do not make independent product posts the
      // same event. Reuse only an article whose primary post has this identity.
      linked=linked.filter(event=>articles.some(article=>article.eventId===event.id&&article.status==='published'&&all.some(item=>item.id===article.evidenceIds[0]&&messageKey(item)===messageKey(primary))));
    }
    const requestedEventId=draft.eventId;
    // A previously saved human link is retained only for manual regeneration; all automatic links are evidence-derived.
    draft.eventId=linked.length===1?linked[0].id:job.payload.force?candidate.content.eventId:undefined;
    const assignedEvent=events.find(event=>event.id===draft.eventId);
    const root=actionIdentityEvidence(primary,gathered);
    const ambiguousActions:string[]=[];
    draft.actions=draft.actions.map((action,index)=>{
      let matching=assignedEvent?.actions.filter(previous=>previous.kind===action.kind&&previous.scope===action.scope)??[];
      if(matching.length===0&&hasExplicitCorrectionText(action.evidenceQuote??''))matching=assignedEvent?.actions.filter(previous=>previous.kind===action.kind)??[];
      if(matching.length>1)ambiguousActions.push('同一事件含有多轮同类动作，请核对对应轮次');
      const prior=candidate.content.actions.find(previous=>previous.id===action.id);
      return {...action,id:matching.length===1?matching[0].id:prior?.id??`action_${hash(`${messageKey(root)}:${action.kind}:${action.scope}:${index}`)}`};
    });
    const reasons=validateDraft(draft,all,true);
    if(requestedEventId&&requestedEventId!==draft.eventId&&requestedEventId!==candidate.content.eventId)reasons.push('生成内容的事件关联没有原文依据，请人工核对');
    if(linked.length>1)reasons.push('事件关联不明');
    if(matched.some(event=>event.status==='withdrawn'||!resolveTarget(event,events)))reasons.push('关联事件已撤回或无法解析，需人工核对');
    reasons.push(...ambiguousActions);
    const persisted=await transaction(async c=>{
      const currentJob=await one<Job>('jobs',job.id,c,true);
      if(currentJob?.status!=='running'||currentJob.leaseUntil!==job.leaseUntil)throw new DomainError('任务租约已被接管，旧处理结果不再写入',409);
      const current=await one<Candidate>('candidates',candidate.id,c,true);
      if(!current||current.version!==candidate.version)throw new DomainError('候选已被编辑，生成结果没有覆盖原内容',409);
      if(current.humanEdited) {
        const copy:Candidate={...current,id:`${current.id}_generated_${Date.now()}`,content:draft,status:'pending',version:1,humanEdited:false,reasons:['由人工草稿重新生成，请人工对比',...reasons],createdAt:now(),updatedAt:now()};
        await insert('candidates',copy,c);
        await audit('worker','candidate.generate',copy.id,'保留人工编辑，生成独立候选',undefined,copy,c);
        return copy;
      }
      const retained=current.reasons.filter(reason=>/由人工草稿/.test(reason));
      const nextReasons=[...new Set([...retained,...reasons])];
      const automation:CandidateAutomation={...classifyBlockers(nextReasons,context),inputFingerprint:fingerprint,evaluatedAt:now(),articleId:current.automation?.articleId,templatePublished:current.automation?.templatePublished};
      if(['waiting_evidence','deferred'].includes(automation.state))automation.resumeAt=new Date(Date.now()+CONTEXT_PROBE_INTERVAL).toISOString();
      const next:Candidate={...current,content:draft,reasons:nextReasons,automation,version:current.version+1,updatedAt:now()};
      await put('candidates',next,c);
      await put('jobs',{...currentJob,payload:{...currentJob.payload,generated:true,generatedCandidateVersion:next.version,inputFingerprint:fingerprint,contentOrigin:draft.contentOrigin}},c);
      return next;
    });
    const site=await one<SiteSettings>('settings','site')??defaultSite;
    if(site.autoPublish&&!persisted.reasons.length) {
      try { await publishCandidate(persisted.id,persisted.version,'worker','规则核验通过，自动发布',true); }
      catch(error) {
        if(!(error instanceof DomainError))throw error;
        if(/来源.*(?:暂停|未验证|验证)/.test(error.message))throw new SourcePausedError(error.message);
        await transaction(async c=>{
          const current=await one<Candidate>('candidates',persisted.id,c,true);
          if(current?.version===persisted.version&&!current.humanEdited) {
            const nextReasons=[...new Set([...current.reasons,error.message])];
            const automation={...classifyBlockers(nextReasons,context),inputFingerprint:fingerprint,evaluatedAt:now(),articleId:current.automation?.articleId,templatePublished:current.automation?.templatePublished};
            await put('candidates',{...current,reasons:nextReasons,automation,updatedAt:now()},c);
          }
        });
      }
    }
    return true;
  },job);
}
export interface WorkerDependencies { onStage?:(phase:WorkerPhase)=>void; generate?:Generator; collect?:typeof collectSource; enrich?:typeof enrichKnownEvidence; enrichQuoted?:typeof enrichQuotedResetContext; schedule?:boolean; allowTemplates?:boolean; wechat?:typeof processWechatJob; cadence?:ReturnType<typeof createWorkerCadence>; }
const workerCadence=createWorkerCadence();
let forecastInputsChanged=false;
export async function writeWorkerHeartbeat(error?:string,processed:boolean|string=false):Promise<void> {
  const previous=await one<{id:string;heartbeatAt:string;lastJobAt?:string;error?:string}>('settings','worker_runtime');
  await put('settings',{id:'worker_runtime',heartbeatAt:now(),lastJobAt:typeof processed==='string'?processed:processed?now():previous?.lastJobAt,error});
}
export async function runOne(dependencies:WorkerDependencies={}):Promise<boolean> {
  const phase=(name:WorkerPhase)=>dependencies.onStage?.(name);
  const allowTemplates=dependencies.allowTemplates??!dependencies.generate;
  const cadence=dependencies.cadence??workerCadence;
  if(dependencies.schedule!==false) {
    await cadence.run('sources',()=>{phase('source_schedule');return scheduleDue({allowTemplates,skipGeneration:true});});
    // One small persisted marker replaces full scans when the inputs are stable.
    // createEvidence/publication transactions update it, including admin/backfill
    // writes performed outside this worker process.
    phase('input_read');
    const inputs=await one<{revision?:string}>('settings','forecast_inputs');
    cadence.observe('generation',inputs?.revision);
    await cadence.run('generation',()=>{phase('generation_schedule');return scheduleDue({allowTemplates,allowEnrichment:!dependencies.generate||!!dependencies.enrich,skipSources:true});});
    try {await cadence.run('wechat',()=>{phase('wechat_schedule');return scheduleWechatDeliveries();});} catch(error) {console.error('微信提醒调度暂不可用，其他任务继续运行',safeWorkerFailure(error,'wechat_schedule'));}
    try {await cadence.run('forecast',async()=>{
      phase('forecast');
      if((await runForecastCycle(now(),{inputsChanged:forecastInputsChanged})).status==='error')throw new Error('预测观察暂不可用');
      forecastInputsChanged=false;
    });} catch(error) {console.error('预测观察暂不可用，新闻任务继续运行',safeWorkerFailure(error,'forecast'));}
  }
  phase('claim');
  const job=await claimJob();
  if(!job)return false;
  try {
    if(job.kind==='wechat_send') {
      phase('job_wechat');
      const result=await (dependencies.wechat??processWechatJob)(job);
      phase('job_result');
      await transaction(async c=>{
        const current=await one<Job>('jobs',job.id,c,true);
        if(current?.status!=='running'||current.leaseUntil!==job.leaseUntil)return;
        const waiting=result.state==='deferred'||result.state==='sending'||result.state==='queued';
        const resumeAt=result.resumeAt??new Date(Date.now()+120_000).toISOString();
        await put('jobs',{...current,status:waiting?'queued':'succeeded',leaseUntil:undefined,finishedAt:waiting?undefined:now(),availableAt:waiting?resumeAt:current.availableAt,error:result.reason,payload:{...current.payload,wechatState:result.state,...(waiting?{resumeAfter:resumeAt}:{})}},c);
      });
      cadence.nudge('wechat');
      return true;
    }
    const enrich=dependencies.enrich??(dependencies.generate?async()=>undefined:enrichKnownEvidence);
    const enrichQuoted=dependencies.enrichQuoted??(dependencies.generate?async()=>[]:enrichQuotedResetContext);
    phase(job.kind==='generate'?'job_generate':'job_collect');
    const generated=job.kind==='generate'?await generateCandidate(job,dependencies.generate??generateContent,allowTemplates,enrich,enrichQuoted):false;
    if(job.kind!=='generate') {
      const collected=await (dependencies.collect??collectSource)(job.sourceId!,job.kind==='backfill'||job.payload.historical===true);
      phase('job_result');
      if(collected.created>0||collected.healthChanged){forecastInputsChanged=true;cadence.nudge('generation','forecast');}
      await transaction(async c=>{
        const source=await one<Source>('sources',job.sourceId!,c,true);
        if(source&&(source.status!==(source.enabled?'healthy':'paused')||!source.validated||source.publicationPaused||source.error)){forecastInputsChanged=true;await put('sources',{...source,validated:true,publicationPaused:false,pauseReason:undefined,consecutiveFailures:0,status:source.enabled?'healthy':'paused',error:undefined,...sourceCollectionSchedule(source),nextRunAt:sourceNextCollectionAt(source)},c);}
      });
    }
    phase('job_result');
    await transaction(async c=>{
      const current=await one<Job>('jobs',job.id,c,true);
      if(current?.status==='running'&&current.leaseUntil===job.leaseUntil) {
        const {failureKind:_kind,blockedReason:_blocked,resumeAfter:_resume,...payload}=current.payload;
        await put('jobs',{...current,status:'succeeded',leaseUntil:undefined,finishedAt:now(),error:undefined,payload:{...payload,...(generated?{generated:true}:{})}},c);
      }
    });
  } catch(error) {
    const message=error instanceof DomainError?error.message:'任务处理失败，请检查来源与服务配置';
    const failureKind=error instanceof AIServiceError?error.failureKind:error instanceof SourceConfigurationError?'configuration':error instanceof SourceTransientError||isRecoverableStorageError(error)?'transient':error instanceof DomainError?error.status===409?'conflict':'validation':'unknown';
    const recoverableModelFailure=error instanceof AIServiceError&&['transient','validation'].includes(failureKind)||isRecoverableStorageError(error);
    const retry=job.kind==='generate'&&recoverableModelFailure&&job.attempts<MAX_GENERATION_ATTEMPTS||job.kind==='wechat_send'&&isRecoverableStorageError(error);
    phase('job_failure_write');
    await transaction(async c=>{
      const current=await one<Job>('jobs',job.id,c,true);
      if(!current||current.leaseUntil!==job.leaseUntil)return;
      const retryMs=Math.max(error instanceof AIServiceError?error.retryAfterMs??0:0,job.attempts===1?30_000:120_000);
      const cooldownCycle=Number(current.payload.cooldownCycle??0)+1;
      const cooldown=job.kind==='generate'&&recoverableModelFailure&&!retry;
      const payload:Job['payload']={...current.payload,failureKind,...(failureKind==='budget'?{blockedReason:'budget',resumeAfter:nextBudgetDay()}:failureKind==='configuration'?{blockedReason:'configuration'}:failureKind==='capacity'?{blockedReason:'capacity'}:error instanceof SourcePausedError?{blockedReason:'source'}:cooldown?{blockedReason:'cooldown',cooldownCycle,resumeAfter:generationCooldown(cooldownCycle)}:{})};
      await put('jobs',{...current,status:retry?'queued':'failed',leaseUntil:undefined,error:message,finishedAt:retry?undefined:now(),availableAt:retry?new Date(Date.now()+retryMs).toISOString():current.availableAt,payload},c);
      if(job.sourceId&&job.kind!=='generate') {
        const source=await one<Source>('sources',job.sourceId,c,true);
        if(source) {
          if(source.status!=='failed'||source.publicationPaused!== (error instanceof SourceStructureError?true:source.publicationPaused))forecastInputsChanged=true;
          const configuration=error instanceof SourceConfigurationError;
          const next:Source={...source,status:'failed',error:message,validated:error instanceof SourceStructureError||configuration?false:source.validated,publicationPaused:configuration?false:error instanceof SourceStructureError?true:source.publicationPaused,pauseReason:configuration?undefined:error instanceof SourceStructureError?'structure':source.pauseReason,consecutiveFailures:(source.consecutiveFailures??0)+1,version:source.version+1};
          next.nextRunAt=sourceRetryAt(source,error instanceof SourceRateLimitError?error.retryAt:undefined);
          if(error instanceof SourceStructureError)next.nextRunAt=new Date(Date.now()+CONTEXT_PROBE_INTERVAL).toISOString();
          await put('sources',next,c);
        }
      }
      if(job.candidateId) {
        const candidate=await one<Candidate>('candidates',job.candidateId,c,true);
        if(candidate&&!candidate.humanEdited&&candidate.status!=='ignored') {
          const automation:CandidateAutomation={...candidate.automation,inputFingerprint:typeof payload.inputFingerprint==='string'?payload.inputFingerprint:candidate.automation?.inputFingerprint,state:failureKind==='capacity'?'deferred':failureKind==='budget'||cooldown||retry?'cooldown':failureKind==='configuration'||error instanceof SourcePausedError?'configuration':failureKind==='conflict'?'conflict':'waiting_evidence',reasonCodes:[failureKind==='capacity'?'input_capacity':failureKind==='budget'?'budget_exhausted':cooldown||retry?'temporary_failure':error instanceof SourcePausedError?'source_paused':failureKind],dependencyIds:candidate.automation?.dependencyIds??[],evaluatedAt:now(),resumeAt:typeof payload.resumeAfter==='string'?payload.resumeAfter:retry?new Date(Date.now()+retryMs).toISOString():undefined};
          await put('candidates',{...candidate,automation,reasons:[...new Set([...candidate.reasons,message])],updatedAt:now()},c);
        }
      }
      await audit('worker',retry?'job.retry_scheduled':'job.failed',job.id,message,undefined,{kind:job.kind,attempts:job.attempts,failureKind},c);
    });
  }
  // Fresh evidence feeds generation on the next turn; publication feeds reminders.
  // Manual changes in the separate web process are picked up by the bounded cadence.
  if(job.kind==='generate'){forecastInputsChanged=true;cadence.nudge('generation','forecast','wechat');}
  else if(forecastInputsChanged)cadence.nudge('forecast');
  return true;
}
