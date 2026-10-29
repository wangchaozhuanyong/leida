import {sourceCollectionSchedule,sourceForecastConfiguration} from './source-collection-policy';
import {markForecastInputsChanged} from './reset-cadence-runtime';
import { lockTransaction, repeatableRead } from '../db';
import { z } from 'zod';
import { list, one, insert, put, transaction, type Client } from '../db';
import type { AdminData, PublicData, Candidate, Evidence, RadarEvent, Article, Publication, Source, Job, Audit, Notice, Activity, DraftContent, SiteSettings } from '../lib/types';
import { customerNotice } from '../lib/notice-display';
import { createAdminNotice } from '../lib/admin-notice';
import { DomainError, id, hash, now, assertVersion, draftSchema, validateDraft, mergeActions, noticeKey, safeTemplate, requireReason } from './domain';
import { defaultAI, publicAI, encryptKey, validateEndpoint, testAI, AIServiceError, type AIRecord } from './ai';
import { hasExplicitCorrectionText, normalizedEligibility } from './automatic-content';
import {adminWechat,saveWechatSettings} from './wechat';
import { automationRows, workerRuntimeStatus } from '../lib/automation';
import {activityHideDate} from '../lib/activity-display';
import { isHistoricalContent, projectPublicHistory } from '../lib/history';
import {getPublicForecast} from './forecast';
import {gatherEvidenceContext,hasCompleteContext,originalConflict} from './source-context';
import {TIBO_PUBLIC_SOURCE} from './tibo-public';
import {configuredPublicRpc} from './cloudbase/public-config';
import {observedEvidence} from '../lib/reset-observations';
import {reminderObservationEvidence} from '../lib/reminder-lifecycle';
export const defaultSite:SiteSettings = { name:'模钥重置雷达',description:'跟踪公开重置公告与重置卡动态',autoPublish:true,version:1 };
const str=(x:unknown)=>z.string().min(1).max(200).parse(x);
export async function audit(actor:string,action:string,objectId:string,reason:string,before:unknown,after:unknown,c:Client) { await insert('audits',{id:id('audit'),actor,action,objectId,reason,createdAt:now(),before,after} satisfies Audit,c); }
type TrackedAdminAction='candidate.create'|'candidate.generate'|'source.collect'|'source.backfill'|'ai.test';
const trackedLabels:Record<TrackedAdminAction,string>={'candidate.create':'人工补充原文','candidate.generate':'重新生成候选','source.collect':'发起采集','source.backfill':'发起补采','ai.test':'智能连接测试'};
async function failedOperationAudit(actor:string,action:TrackedAdminAction,objectId:string,error:unknown,partial?:{evidenceId:string;candidateId?:string}) {
  const status=error instanceof DomainError?error.status:error instanceof z.ZodError?400:500;
  const failureKind=error instanceof AIServiceError?error.failureKind:status===409?'conflict':status===400?'validation':'operation';
  const reason=partial?'原文已保存，后续候选编辑未完成':`${trackedLabels[action]}失败`;
  try { await transaction(c=>audit(actor,action,objectId,reason,undefined,{outcome:partial?'partial':'failed',status,failureKind,...partial},c)); }
  catch { console.error('后台操作的失败审计记录未保存'); }
}
async function locked<T extends {version:number}>(table:Parameters<typeof one>[0], objectId:unknown, version:unknown,c:Client):Promise<T> { const record=await one<T>(table,str(objectId),c,true); assertVersion(record,version); return record!; }
function currentSource(s:Source):Source { if(s.enabled&&s.status==='paused')s={...s,status:s.lastSuccessAt?'healthy':'unconnected'}; if(s.enabled && s.lastSuccessAt && Date.now()-Date.parse(s.lastSuccessAt)>(s.effectiveIntervalMinutes??s.intervalMinutes)*3*60_000) return {...s,status:'delayed'}; return s; }
export async function getAdminData():Promise<AdminData> { const [sources,candidates,events,articles,publications,evidence,jobs,notices,activities,audits,ai,site,heartbeat,wechat,forecasts]=await Promise.all([list<Source>('sources'),list<Candidate>('candidates'),list<RadarEvent>('events'),list<Article>('articles'),list<Publication>('publications'),list<Evidence>('evidence'),list<Job>('jobs'),list<Notice>('notices'),list<Activity>('activities'),list<Audit>('audits'),publicAI(),one<SiteSettings>('settings','site'),one<{heartbeatAt?:string;lastJobAt?:string;error?:string}>('settings','worker_runtime'),adminWechat(),getPublicForecast()]);
 const data:AdminData={sources:(sources.some(s=>s.id===TIBO_PUBLIC_SOURCE.id)?sources:[...sources,TIBO_PUBLIC_SOURCE]).filter(s=>s.id!=='tibo-timeline').map(currentSource),candidates,events,articles,publications,evidence,jobs,notices,activities,audits,ai,wechat,forecasts,site:site??defaultSite};
 const flows=automationRows(data);
 const tally=(state:string)=>flows.filter(({candidate,flow})=>state==='conflict'?flow.state==='review'&&candidate.automation?.state==='conflict':flow.state===state).length;
 const queued=jobs.filter(job=>job.status==='queued');
 const forecastRuntime=await one<{status?:string}>('settings','forecast_runtime');
 const workerError=forecastRuntime?.status==='error'?'预测观察暂时异常，新闻任务继续运行':heartbeat?.error;
 const runtime:NonNullable<AdminData['runtime']>={worker:{status:workerRuntimeStatus({...heartbeat,error:workerError}),heartbeatAt:heartbeat?.heartbeatAt,lastJobAt:heartbeat?.lastJobAt,error:workerError},backlog:{queued:queued.length,running:jobs.filter(job=>job.status==='running').length,waitingEvidence:tally('waiting_evidence'),deferred:tally('deferred'),cooldown:tally('cooldown'),configuration:tally('configuration'),conflict:tally('conflict')},oldestQueuedAt:queued.map(job=>job.createdAt).sort()[0]};
 return {...data,runtime}; }
async function getStoredPublicData():Promise<PublicData> { const rpc=configuredPublicRpc();if(rpc)return (await import('./cloudbase/public-read')).createCloudbasePublicReader(rpc).legacy();return transaction(async c=> { await repeatableRead(c); const [events,articles,publications,evidence,notices,activities,site,sources]=await Promise.all([list<RadarEvent>('events',c),list<Article>('articles',c),list<Publication>('publications',c),list<Evidence>('evidence',c),list<Notice>('notices',c),list<Activity>('activities',c),one<SiteSettings>('settings','site',c),list<Source>('sources',c)]); const publicEvidence=new Set(publications.flatMap(p=>p.article.evidenceIds)); const data=projectPublicHistory({events,articles,publications,evidence:evidence.filter(e=>publicEvidence.has(e.id)),notices,activities,site:site??defaultSite,sources:sources.map(currentSource).map(({id,name,status,lastSuccessAt})=>({id,name,status,lastSuccessAt})),serverTime:now()}); return {...data,forecasts:await getPublicForecast(c,data.serverTime,data)}; }); }
export async function getPublicData():Promise<PublicData> {
 const data=await getStoredPublicData();
 return {...data,notices:data.notices.filter(customerNotice),serverTime:new Date().toISOString()};
}
function actionContent(actions:RadarEvent['actions']):{title:string;summary:string;translation:string} { const stage={promised:'已有发放安排',in_progress:'正在进行',claimed_complete:'公告称已完成',cancelled:'已取消'};const names={automatic_reset:'用量重置',banked_reset:'重置卡'};const title=actions.length===1?`${names[actions[0].kind]}：${stage[actions[0].stage]}`:'用量重置与重置卡进展';return {title,summary:actions.map(a=>`${names[a.kind]}${stage[a.stage]}，适用对象：${a.eligibility}。`).join(''),translation:''}; }
interface PublishOptions { actor:string; reason:string; existingArticle?:Article; correction?:boolean; suppressNotice?:boolean; withdrawn?:boolean; automatic?:boolean; eventTitle?:string; }

export function providerIdentity(evidence:Evidence):string {
 const observation=observedEvidence(evidence,evidence.collectedAt);
 // The borrowed announcement URL is a reference, not this observation's
 // identity. Keep verified cross-source copies together without reusing the
 // original announcement's article, actions or manual protections.
 if(observation)return `observation:${observation.kind}:${evidence.messageId}:${observation.observedAt}`;
 const match=evidence.url.match(/^https:\/\/(?:x|twitter)\.com\/([^/?#]+)\/status\/(\d+)(?:[?#].*)?$/i);
 return match?`x:${match[1].toLowerCase()}:${match[2]}`:`${evidence.sourceId}:${evidence.messageId}`;
}
/** Upgrade only a machine-created empty news shell after its explicit parent is known. */
export function automaticNewsContextUpgrade(primary:Evidence,content:DraftContent,duplicate:RadarEvent,target:RadarEvent,evidence:Evidence[],articles:Article[]):Article|undefined {
 if(primary.provenance==='manual'||!primary.parentId||duplicate.id===target.id||duplicate.status!=='published'||duplicate.mergedInto||target.status!=='published'||duplicate.actions.length||duplicate.manualFields?.length||target.manualFields?.length||content.publicationMode!=='state_change'||content.actions.length!==1||target.actions.length!==1)return;
 const incoming=content.actions[0],previous=target.actions[0];
 if(incoming.kind!==previous.kind||incoming.scope!=='public'||previous.scope!=='public'||previous.stage==='cancelled'||normalizedEligibility(incoming.eligibility)!==normalizedEligibility(previous.eligibility)||![incoming.statementAt,previous.statementAt,primary.publishedAt].every(value=>Number.isFinite(Date.parse(value)))||Date.parse(incoming.statementAt)<Date.parse(previous.statementAt))return;
 const context=gatherEvidenceContext(primary,evidence),ancestors=context.slice(1);
 if(!hasCompleteContext(primary,context)||!ancestors.length||ancestors.at(-1)?.parentId||context.some(item=>item.provenance==='manual')||ancestors.some(item=>!Number.isFinite(Date.parse(item.publishedAt))||Date.parse(item.publishedAt)>Date.parse(primary.publishedAt)))return;
 const parentKeys=new Set(ancestors.map(providerIdentity));
 if(!target.evidenceIds.some(id=>{const item=evidence.find(e=>e.id===id);return item&&item.provenance!=='manual'&&parentKeys.has(providerIdentity(item));}))return;
 const childKey=providerIdentity(primary);
 if(!duplicate.evidenceIds.length||duplicate.evidenceIds.some(id=>{const item=evidence.find(e=>e.id===id);return !item||item.provenance==='manual'||providerIdentity(item)!==childKey;}))return;
 const linked=articles.filter(article=>article.eventId===duplicate.id);
 if(linked.length!==1)return;
 const article=linked[0],main=evidence.find(item=>item.id===article.evidenceIds[0]);
 if(article.status!=='published'||article.publicationMode!=='news_only'||article.contentOrigin!=='template'||article.manualFields?.length||!main||main.provenance==='manual'||providerIdentity(main)!==childKey)return;
 return article;
}
function articleForPrimary(candidate:Candidate,content:DraftContent,primary:Evidence|undefined,evidence:Evidence[],articles:Article[],automatic:boolean):Article|undefined {
 if(!primary)return;
 const matches=(article:Article)=>{const main=evidence.find(item=>item.id===article.evidenceIds[0]);return article.status==='published'&&(article.eventId===content.eventId||automatic&&!content.eventId)&&!!main&&providerIdentity(main)===providerIdentity(primary);};
 const linked=articles.find(article=>article.id===candidate.automation?.articleId&&matches(article));
 return linked??(automatic?articles.find(matches):undefined);
}
function changedManualFields(existing:RadarEvent,content:DraftContent):string[]{
 const fields:string[]=[];if(existing.title!==content.title)fields.push('title');
 for(const action of content.actions){const old=existing.actions.find(item=>item.id===action.id);if(!old)continue;for(const key of ['kind','stage','eligibility','scope','expectedAt','timeNote'] as const)if(old[key]!==action[key])fields.push(`actions.${action.id}.${key}`);}
 return fields;
}
function preserveManualFields(content:DraftContent,event:RadarEvent):DraftContent {
 const fields=event.manualFields??[];const result={...content,actions:content.actions.map(action=>({...action}))};
 if(fields.includes('title'))result.title=event.title;
 for(const incoming of result.actions){const old=event.actions.find(action=>action.id===incoming.id);if(!old)continue;
  for(const key of ['kind','stage','eligibility','scope','expectedAt','timeNote'] as const){if(!fields.includes(`actions.${incoming.id}.${key}`))continue;
   if(key==='eligibility'&&normalizedEligibility(incoming.eligibility)===normalizedEligibility(old.eligibility))continue;
   const rank={promised:1,in_progress:2,claimed_complete:3,cancelled:4};
   if(key==='stage'&&rank[incoming.stage]>rank[old.stage]&&Date.parse(incoming.statementAt)>Date.parse(old.statementAt))continue;
   if(incoming[key]!==old[key])throw new DomainError('新证据与人工保护字段冲突，请核对对应字段');
  }
 }
 return result;
}
function sameActionFacts(first:RadarEvent['actions'][number],second:RadarEvent['actions'][number]):boolean {
 return first.kind===second.kind&&first.stage===second.stage&&normalizedEligibility(first.eligibility)===normalizedEligibility(second.eligibility)&&first.scope===second.scope&&first.expectedAt===second.expectedAt&&first.timeNote===second.timeNote;
}
/** Collection order cannot authorize a change to a newer statement. */
export function partitionAutomaticActions(content:DraftContent,event:RadarEvent|undefined):{current:DraftContent['actions'];stale:DraftContent['actions']} {
 const current:DraftContent['actions']=[],stale:DraftContent['actions']=[];
 for(const action of content.actions){
  const old=event?.actions.find(item=>item.id===action.id);
  const incomingTime=Date.parse(action.statementAt),previousTime=Date.parse(old?.statementAt??'');
  if(old&&old.kind!==action.kind)throw new DomainError('同一动作的福利类型冲突，不能按旧声明忽略');
  if(old&&Number.isFinite(incomingTime)&&Number.isFinite(previousTime)){
   if(incomingTime<previousTime){stale.push(action);continue;}
   if(incomingTime===previousTime&&!sameActionFacts(action,old))throw new DomainError('同一动作在相同声明时间出现不同事实，存在事实冲突');
  }
  current.push(action);
 }
 return {current,stale};
}
export function mixedAutomaticEventTitle(content:DraftContent,event:RadarEvent|undefined,hasStale:boolean,correction=false):string|undefined {
 if(!event||!hasStale||content.publicationMode==='news_only'||!content.actions.length)return;
 return event.manualFields?.includes('title')?event.title:actionContent(mergeActions(event.actions,content.actions,correction)).title;
}
export function isStaleMachineConflict(candidate:Candidate,event:RadarEvent|undefined):boolean {
 if(candidate.humanEdited||candidate.automation?.state!=='conflict'||!event||event.status!=='published'||!candidate.content.actions.length)return false;
 const allowed=new Set(['动作资格或状态变化缺少明确更正证据，存在事实冲突','完成状态不能由普通进展回退，请使用人工更正']);
 if(!candidate.reasons.length||candidate.reasons.some(reason=>!allowed.has(reason)))return false;
 try{const {current,stale}=partitionAutomaticActions(candidate.content,event);return current.length===0&&stale.length===candidate.content.actions.length;}catch{return false;}
}
/** The published article, rather than an interrupted candidate draft, is authoritative. */
export function publishedTemplateArticle(candidate:Candidate,primary:Evidence,evidence:Evidence[],articles:Article[],events:RadarEvent[]):Article|undefined {
 if(!candidate.automation?.templatePublished||candidate.humanEdited)return;
 const article=articleForPrimary(candidate,{...candidate.content,eventId:undefined},primary,evidence,articles,true);
 if(!article||article.contentOrigin==='generated'||events.find(event=>event.id===article.eventId)?.status!=='published')return;
 return article;
}
const sameIds=(first:string[]|undefined,second:string[]|undefined)=>JSON.stringify([...(first??[])].sort())===JSON.stringify([...(second??[])].sort());
export function samePublishedContent(content:DraftContent,article:Article,event:RadarEvent|undefined,activity?:Activity,correction=false):boolean {
 if(!event||event.status!=='published'||article.status!=='published')return false;
 if(content.reviewStatus!==article.reviewStatus||JSON.stringify(content.reviewReasons)!==JSON.stringify(article.reviewReasons))return false;
 if(content.title!==article.title||content.summary!==article.summary||content.translation!==article.translation||content.category!==article.category||(content.publicationMode??'state_change')!==(article.publicationMode??'state_change')||content.evidenceIds[0]!==article.evidenceIds[0]||!sameIds(content.evidenceIds,article.evidenceIds)||!sameIds(content.contextEvidenceIds,article.contextEvidenceIds))return false;
 if(content.activityId&&(!activity||activity.id!==content.activityId||!activity.items.some(item=>item.articleId===article.id&&item.eventId===event.id&&item.day===content.activityDay)))return false;
 if(content.publicationMode==='news_only')return true;
 const merged=mergeActions(event.actions,content.actions,correction);
 return merged.length===event.actions.length&&merged.every(action=>{const old=event.actions.find(item=>item.id===action.id);return !!old&&sameActionFacts(action,old);});
}
export function automaticCorrection(content:DraftContent,event:RadarEvent|undefined,evidence:Evidence[]):boolean {
 if(!event||content.publicationMode==='news_only')return false;
 const changes=partitionAutomaticActions(content,event).current.filter(action=>{const old=event.actions.find(item=>item.id===action.id);return old&&(action.stage!==old.stage||normalizedEligibility(action.eligibility)!==normalizedEligibility(old.eligibility)||action.scope!==old.scope||action.expectedAt!==old.expectedAt);});
 const rank={promised:1,in_progress:2,claimed_complete:3,cancelled:4};
 const qualifies=changes.filter(action=>{const old=event.actions.find(item=>item.id===action.id)!;return action.stage==='cancelled'||rank[action.stage]<rank[old.stage]||normalizedEligibility(action.eligibility)!==normalizedEligibility(old.eligibility)||action.scope!==old.scope||(action.expectedAt!==old.expectedAt&&/correction|corrected|更正|改为/i.test(action.evidenceQuote??''));});
 if(!qualifies.length)return false;
 const valid=qualifies.every(action=>hasExplicitCorrectionText(action.evidenceQuote??'')&&action.evidenceIds.some(eid=>{const e=evidence.find(item=>item.id===eid);return e&&!event.evidenceIds.includes(e.id)&&e.text.includes(action.evidenceQuote??'')&&Date.parse(e.publishedAt)>=Date.parse(event.actions.find(item=>item.id===action.id)!.statementAt);}));
 if(!valid)throw new DomainError('动作资格或状态变化缺少明确更正证据，存在事实冲突');
 if(content.actions.some(action=>event.actions.some(old=>old.id===action.id&&old.kind!==action.kind)))throw new DomainError('福利类型冲突，应分别记录不同动作');
 return true;
}
async function publish(content:DraftContent, c:Client, opts:PublishOptions):Promise<Publication> {
  const evidence=await list<Evidence>('evidence',c); const reasons=validateDraft(content,evidence);
  if(reasons.length && !opts.withdrawn) throw new DomainError(reasons.join('；'));
  const existing=content.eventId?await one<RadarEvent>('events',content.eventId,c,true):undefined;
  if(content.eventId&&!existing) throw new DomainError('关联事件不存在',404);
  if(existing?.status==='merged') throw new DomainError('该事件已经合并，请使用目标事件');
  if(existing?.status==='withdrawn'&&!opts.correction) throw new DomainError('该事件已撤回，请人工更正后恢复');
  const eventId=existing?.id??id('event'); const publicationId=id('pub'); const articleId=opts.existingArticle?.id??id('article'); const time=now();
  const newsOnly=content.publicationMode==='news_only'&&!opts.withdrawn;
  const actions=newsOnly?(existing?.actions??[]):opts.correction?(opts.automatic?mergeActions(existing?.actions??[],content.actions,true):content.actions):mergeActions(existing?.actions??[],content.actions);
  const manualFields=existing?.manualFields??[];
  const event:RadarEvent=newsOnly&&existing?existing:{id:eventId,title:opts.eventTitle??content.title,version:(existing?.version??0)+1,status:opts.withdrawn?'withdrawn':'published',actions,evidenceIds:[...new Set([...(existing?.evidenceIds??[]),...content.evidenceIds])],publicationId,updatedAt:time,manualFields:opts.correction&&!opts.automatic&&existing?[...new Set([...manualFields,...changedManualFields(existing,content)])]:manualFields};
  const cited=evidence.filter(e=>content.evidenceIds.includes(e.id)); const cutoffAt=new Date(Math.max(...cited.map(e=>Date.parse(e.collectedAt)))).toISOString();
  const firstPublishedAt=opts.existingArticle?.publishedAt??time;
  const historical=isHistoricalContent(cited,firstPublishedAt);
  const article:Article={id:articleId,eventId,title:content.title,summary:content.summary,translation:content.translation,category:content.category,version:(opts.existingArticle?.version??0)+1,status:opts.withdrawn?'withdrawn':'published',publicationId,evidenceIds:content.evidenceIds,contextEvidenceIds:content.contextEvidenceIds,publishedAt:firstPublishedAt,updatedAt:time,publicationMode:content.publicationMode??'state_change',contentOrigin:content.contentOrigin,reviewStatus:content.reviewStatus,reviewReasons:content.reviewReasons,manualFields:opts.existingArticle?.manualFields,sourcePublishedAt:new Date(Math.max(...cited.map(e=>Date.parse(e.publishedAt)))).toISOString(),historical};
  const publication:Publication={id:publicationId,eventId,articleId,event,article,cutoffAt,publishedAt:time,reason:opts.reason,mode:content.publicationMode??'state_change',contentOrigin:content.contentOrigin};
  await insert('publications',publication,c); if(!newsOnly||!existing)await put('events',event,c); await put('articles',article,c);
  const factKey=noticeKey(event,existing);
  const observation=newsOnly&&content.category==='reset'?reminderObservationEvidence(evidence,content.evidenceIds,time):undefined;
  const observationKey=observation?hash(`reset-observation:${observation.kind}:${observation.observedAt}`):undefined;
  const key=newsOnly?observationKey:opts.correction&&existing?(opts.automatic?(factKey?hash(`correction:${factKey}`):undefined):hash(`${eventId}:correction:${event.version}`)):factKey;
  if(opts.automatic&&opts.correction&&key)for(const notice of await list<Notice>('notices',c))if(notice.eventId===eventId&&notice.status==='active'&&notice.categories.some(category=>category==='announcement'||category==='result'))await put('notices',{...notice,status:'withdrawn'},c);
  const activity=content.activityId?await one<Activity>('activities',content.activityId,c,true):undefined;
  if(content.activityId&&!activity) throw new DomainError('关联活动不存在');
  if(activity&&content.activityDay) { if(content.activityDay>activity.days) throw new DomainError('天数超出活动范围'); const items=activity.items.filter(x=>x.articleId!==articleId); await put('activities',{...activity,version:activity.version+1,items:[...items,{day:content.activityDay,articleId,eventId}]},c); }
  // Linking an already published article to its campaign is enrichment, not a
  // new announcement. Actual benefit changes still have their own fact key.
  const semantic=key??(activity&&cited[0]&&!opts.existingArticle?hash(`activity:${activity.id}:${content.activityDay}:${providerIdentity(cited[0])}`):undefined);
  if(semantic&&(!historical||(opts.correction&&opts.actor!=='worker'))&&!opts.suppressNotice&&!opts.withdrawn) { const categories:Notice['categories']=opts.correction?['correction']:observation?['result']:newsOnly?[]:content.actions.filter(a=>a.scope==='public').some(a=>a.stage==='claimed_complete')?['result']:['announcement']; if(activity) categories.push('activity'); await insert('notices',{id:`notice_${semantic}`,semanticKey:semantic,eventId,publicationId,title:article.title,summary:article.summary,categories,status:'active',createdAt:time} satisfies Notice,c); }
  await audit(opts.actor,opts.withdrawn?'publication.withdraw':opts.correction?'publication.correct':'publication.publish',eventId,opts.reason,existing,publication,c);
  await markForecastInputsChanged(c);
  return publication;
}
async function withdrawalNotice(publication:Publication, kind:'event'|'article', objectId:string, reason:string, c:Client):Promise<void> {
  const semanticKey=hash(`withdrawal:${kind}:${objectId}:${publication.id}`);
  const title=`${kind==='event'?'事件':'文章'}已撤回：${publication.article.title}`;
  await insert('notices',{id:`notice_${semanticKey}`,semanticKey,eventId:publication.eventId,publicationId:publication.id,title,summary:`撤回原因：${reason}`,categories:['correction'],status:'active',createdAt:now()} satisfies Notice,c);
}
/** Internal maintenance only. Uses normal fact validation and never emits historical alerts. */
export async function publishHistoricalDraft(content:DraftContent,c:Client,reason:string,existingArticle?:Article):Promise<Publication> {
  const evidence=await list<Evidence>('evidence',c),cited=evidence.filter(row=>content.evidenceIds.includes(row.id));
  if(cited.length!==new Set(content.evidenceIds).size||!isHistoricalContent(cited,now())||!cited.every(row=>Number.isFinite(Date.parse(row.publishedAt))&&Date.parse(row.publishedAt)<=Date.now()))throw new DomainError('历史补录证据范围不符');
  if(existingArticle&&(existingArticle.status!=='published'||existingArticle.publicationMode!=='news_only'||existingArticle.contentOrigin!=='template'||existingArticle.manualFields?.length))throw new DomainError('历史文章不符合自动补证范围');
  const previous=existingArticle&&content.eventId!==existingArticle.eventId?await one<RadarEvent>('events',existingArticle.eventId,c):undefined;
  if(existingArticle&&content.eventId!==existingArticle.eventId&&!previous)throw new DomainError('历史文章的原事件不存在');
  if(previous){const primary=evidence.find(e=>e.id===content.evidenceIds[0]),target=await one<RadarEvent>('events',content.eventId!,c);if(!primary||!target||automaticNewsContextUpgrade(primary,content,previous,target,evidence,await list<Article>('articles',c))?.id!==existingArticle!.id)throw new DomainError('历史文章父帖关联未通过核对');}
  const result=await publish(content,c,{actor:'authorized-history-backfill',reason,suppressNotice:true,existingArticle});
  if(previous){
    const merged={...previous,status:'merged' as const,mergedInto:result.eventId,version:previous.version+1,updatedAt:now()};await put('events',merged,c);
    for(const activity of await list<Activity>('activities',c))if(activity.items.some(item=>item.articleId===result.articleId&&item.eventId===previous.id))await put('activities',{...activity,version:activity.version+1,items:activity.items.map(item=>item.articleId===result.articleId&&item.eventId===previous.id?{...item,eventId:result.eventId}:item)},c);
    await audit('authorized-history-backfill','event.news_context_link',previous.id,'历史原帖补证，复用已有父帖事件并保留旧快照',previous,{event:merged,articleId:result.articleId},c);
  }
  return result;
}

export async function createEvidence(input: Omit<Evidence,'id'|'hash'>,actor?:string):Promise<{evidence:Evidence;created:boolean;candidate?:Candidate}> {
  return transaction(async c=> {
    await lockTransaction(c,'evidence:'+input.sourceId+':'+input.messageId);
    let parentConflict:string|undefined;
    if(input.textOrigin!=='original'){
      const original=(await list<Evidence>('evidence',c)).find(item=>item.sourceId===input.sourceId&&item.messageId===input.messageId&&item.textOrigin==='original');
      if(original){
        if(input.parentId&&original.parentId&&input.parentId!==original.parentId){
          parentConflict=`明确父帖关系冲突：已保存 ${original.parentId}，归档新增 ${input.parentId}，等待核对`;
          input={...input,contextComplete:false};
        }else{
          const parentId=input.parentId??original.parentId;
          input={...input,text:original.text,textOrigin:'original',contextComplete:parentId?false:original.contextComplete,parentId,publishedAt:original.publishedAt,metadata:{...original.metadata,...input.metadata,summary:input.text}};
        }
      }
    }
    const checksum=hash(JSON.stringify({text:input.text,url:input.url,publishedAt:input.publishedAt,parentId:input.parentId,contextComplete:input.contextComplete,provenance:input.provenance,textOrigin:input.textOrigin,metadata:input.metadata}));const ev:Evidence={...input,hash:checksum,id:`evidence_${hash(`${input.sourceId}:${input.messageId}:${checksum}`)}`};
    const finish=async(result:{evidence:Evidence;created:boolean;candidate?:Candidate})=>{if(actor)await audit(actor,'candidate.create',result.candidate?.id??result.evidence.id,result.created?'人工原文已保存并进入候选处理':'重复原文，保留已有记录',undefined,{outcome:result.created?'created':'duplicate',evidenceId:result.evidence.id,candidateId:result.candidate?.id},c);return result;};
    const prior=(await list<Evidence>('evidence',c)).find(e=>e.sourceId===ev.sourceId&&e.messageId===ev.messageId&&e.text===ev.text&&e.url===ev.url&&Date.parse(e.publishedAt)===Date.parse(ev.publishedAt)&&e.parentId===ev.parentId&&e.contextComplete===ev.contextComplete&&e.provenance===ev.provenance&&e.textOrigin===ev.textOrigin&&JSON.stringify(e.metadata)===JSON.stringify(ev.metadata));if(prior)return finish({evidence:prior,created:false});const created=await insert('evidence',ev,c); if(!created){const existing=(await list<Evidence>('evidence',c)).find(e=>e.sourceId===ev.sourceId&&e.messageId===ev.messageId&&e.hash===ev.hash);return finish({evidence:existing??ev,created:false});}
    await markForecastInputsChanged(c);
    const edits=(await list<Evidence>('evidence',c)).filter(e=>e.id!==ev.id&&e.sourceId===ev.sourceId&&e.messageId===ev.messageId).sort((a,b)=>b.collectedAt.localeCompare(a.collectedAt));
    const latest=edits[0];const sameOriginal=!!latest&&latest.text===ev.text&&latest.url===ev.url&&Date.parse(latest.publishedAt)===Date.parse(ev.publishedAt);
    const existingCandidates=await list<Candidate>('candidates',c);const olderIds=new Set(edits.map(e=>e.id));
    if(sameOriginal&&!parentConflict){
      const waiting=existingCandidates.find(candidate=>olderIds.has(candidate.evidenceId)&&candidate.status==='pending'&&!candidate.humanEdited&&candidate.reasons.includes('待生成中文内容并核对事实'));
      const active=waiting&&(await list<Job>('jobs',c)).some(job=>job.candidateId===waiting.id&&['queued','running'].includes(job.status));
      if(waiting&&!active){
        const candidate:Candidate={...waiting,evidenceId:ev.id,version:waiting.version+1,updatedAt:now(),content:{...waiting.content,evidenceIds:waiting.content.evidenceIds.map(eid=>eid===waiting.evidenceId?ev.id:eid)},reasons:[...waiting.reasons.filter(reason=>reason!=='上下文缺失，请核对父帖'),...(!ev.contextComplete?['上下文缺失，请核对父帖']:[])]};
        await put('candidates',candidate,c);return finish({evidence:ev,created:true,candidate});
      }
    }
    const candidate:Candidate={id:id('candidate'),evidenceId:ev.id,version:1,status:'pending',reasons:[...(parentConflict?[parentConflict]:[]),...(!ev.contextComplete?['上下文缺失，等待补证']:[]),'待生成中文内容并核对事实'],content:safeTemplate(ev),createdAt:now(),updatedAt:now(),humanEdited:false,automation:{state:parentConflict?'conflict':'waiting_evidence',reasonCodes:parentConflict?['parent_conflict']:ev.contextComplete?[]:['missing_context'],dependencyIds:ev.parentId?[ev.parentId]:[]}};
    await insert('candidates',candidate,c); return finish({evidence:ev,created:true,candidate}); });
}
export async function queueJob(kind:Job['kind'],payload:{sourceId?:string;candidateId?:string;[key:string]:unknown},c:Client,operation?:{actor:string;action:TrackedAdminAction;objectId:string}):Promise<Job> {
  await lockTransaction(c,`radar_queue:${kind}:${payload.sourceId??''}:${payload.candidateId??''}`);
  const finish=async(job:Job,reused:boolean)=>{if(operation)await audit(operation.actor,operation.action,operation.objectId,`${trackedLabels[operation.action]}：${reused?'复用已有待执行任务':'已加入任务队列'}`,undefined,{outcome:reused?'already_pending':'queued',jobId:job.id,jobStatus:job.status},c);return job;};
  const pending=(await list<Job>('jobs',c)).find(j=>j.kind===kind&&j.sourceId===payload.sourceId&&j.candidateId===payload.candidateId&&['queued','running'].includes(j.status)); if(pending)return finish(pending,true);
  const job:Job={id:id('job'),kind,sourceId:payload.sourceId,candidateId:payload.candidateId,status:'queued',attempts:0,availableAt:now(),createdAt:now(),payload}; await insert('jobs',job,c); return finish(job,false);
}
export interface CandidatePreview { canPublish:boolean; reasons:string[]; changes:string[]; pages:string[]; willNotify:boolean; noticeReason:string; expectedEventVersion?:number; }
export async function previewCandidate(candidateId:string,version:number):Promise<CandidatePreview> {return transaction(async c=>{
  await repeatableRead(c);
  const candidate=await one<Candidate>('candidates',candidateId,c);assertVersion(candidate,version);
  const evidence=await list<Evidence>('evidence',c),events=await list<RadarEvent>('events',c),articles=await list<Article>('articles',c);const parsed=draftSchema.safeParse(candidate!.content);
  if(!parsed.success)return {canPublish:false,reasons:['候选内容结构不完整，请先保存必要字段'],changes:[],pages:[],willNotify:false,noticeReason:'内容未通过校验，不会发布提醒'};
  const content=parsed.data,existing=events.find(e=>e.id===content.eventId);const reasons=validateDraft(content,evidence),changes:string[]=[];
  if(candidate!.status==='published'||candidate!.status==='ignored')reasons.push('候选已经处理，不能重复发布');
  if(content.eventId&&!existing)reasons.push('关联事件不存在');
  if(existing&&existing.status!=='published')reasons.push('关联事件已撤回或合并，请使用人工更正或目标事件');
  if(content.actions.some(a=>events.some(e=>e.status==='published'&&e.id!==content.eventId&&e.actions.some(old=>old.id===a.id))))reasons.push('动作已经属于另一事件，请先关联事件');
  const labels={automatic_reset:'用量重置',banked_reset:'重置卡'},stages={promised:'预告',in_progress:'进行中',claimed_complete:'公告称已完成',cancelled:'取消'};let merged=content.actions;
  try{merged=mergeActions(existing?.actions??[],content.actions);}catch(error){reasons.push(error instanceof DomainError?error.message:'事件动作无法合并');}
  if(!existing)changes.push('新增一个事件');
  for(const action of content.actions){const old=existing?.actions.find(a=>a.id===action.id),label=labels[action.kind];if(!old){changes.push(`新增${label}动作：${stages[action.stage]}；适用对象：${action.eligibility}`);continue;}
    if(Date.parse(action.statementAt)<Date.parse(old.statementAt)){changes.push(`${label}为较早公告：保留当前${stages[old.stage]}状态，不回退`);continue;}
    if(old.stage!==action.stage)changes.push(`${label}状态：${stages[old.stage]} → ${stages[action.stage]}`);
    if(old.eligibility!==action.eligibility||old.scope!==action.scope)changes.push(`${label}资格或范围发生变化：${old.eligibility} → ${action.eligibility}`);
    if(old.expectedAt!==action.expectedAt||old.timeNote!==action.timeNote)changes.push(`${label}预计时间或时区说明发生变化`);
  }
  if(existing&&content.actions.length&&!changes.length)changes.push('福利状态、资格及预计时间不变');
  changes.push(`新增中文新闻：${content.title}`);
  if(content.activityId){const activity=await one<Activity>('activities',content.activityId,c);if(!activity)reasons.push('关联活动不存在');else if(!content.activityDay||content.activityDay>activity.days)reasons.push('活动天数超出范围');else changes.push(`加入活动“${activity.title}”第${content.activityDay}天`);}
  const primary=evidence.find(item=>item.id===candidate!.evidenceId);
  const previousArticle=articleForPrimary(candidate!,content,primary,evidence,articles,!candidate!.humanEdited&&primary?.provenance!=='manual');
  const eventEvidenceIds=[...new Set([...(existing?.evidenceIds??[]),...content.evidenceIds])],cited=evidence.filter(e=>content.evidenceIds.includes(e.id));const historical=isHistoricalContent(cited,previousArticle?.publishedAt??now());
  const proposed:RadarEvent={id:existing?.id??'preview-event',title:content.title,version:(existing?.version??0)+1,status:'published',actions:merged,evidenceIds:eventEvidenceIds,publicationId:'preview',updatedAt:now()};
  const observation=content.publicationMode==='news_only'&&content.category==='reset'?reminderObservationEvidence(evidence,content.evidenceIds,now()):undefined;
  const observationKey=observation?hash(`reset-observation:${observation.kind}:${observation.observedAt}`):undefined;
  const observationChange=observationKey&&!await one<Notice>('notices',`notice_${observationKey}`,c);
  const materialChange=!!noticeKey(proposed,existing)||!!content.activityId&&!previousArticle||!!observationChange;const canPublish=reasons.length===0,willNotify=canPublish&&!historical&&materialChange;
  const noticeReason=!canPublish?'内容未通过校验，不会发布提醒':historical?'首次发布历史资料，不生成实时提醒':!materialChange?'没有新的公开动作、有效观测或活动条目，不重复提醒':observationChange?'发布包含新的有效重置观测，将生成一条结果提醒':'发布包含新的公开动作变化或活动条目，将生成一条微信提醒记录';
  return {canPublish,reasons:[...new Set(reasons)],changes,pages:canPublish?['首页','公告列表','事件详情','日程','分享海报',...(content.activityId?['活动页']:[]),...(willNotify?['微信提醒']:[])]:[],willNotify,noticeReason,expectedEventVersion:existing?.version};
});}
export async function publishCandidate(candidateId:string,version:number,actor:string,reason:string,automatic=false,expectedEventVersion?:number,requireEventVersion=false):Promise<Publication> {
  return transaction(async c=>{
    await lockTransaction(c,'radar_publication');
    const candidate=await locked<Candidate>('candidates',candidateId,version,c);
    const enrichment=automatic&&candidate.status==='published'&&candidate.automation?.templatePublished;
    if((candidate.status==='published'&&!enrichment)||candidate.status==='ignored')throw new DomainError('候选已处理');
    let content=draftSchema.parse(candidate.content);
    const evidence=await list<Evidence>('evidence',c),events=await list<RadarEvent>('events',c),articles=await list<Article>('articles',c);
    const primary=evidence.find(item=>item.id===candidate.evidenceId);
    let newsUpgrade:{event:RadarEvent;article:Article}|undefined;
    if(primary&&content.evidenceIds.includes(primary.id))content={...content,evidenceIds:[primary.id,...content.evidenceIds.filter(id=>id!==primary.id)]};
    if(automatic){
      const source=primary?await one<Source>('sources',primary.sourceId,c):undefined;
      if(!source?.enabled||!source.validated||source.publicationPaused)throw new DomainError('来源已暂停或未验证，暂不自动发布');
      if(candidate.humanEdited||primary?.provenance==='manual')throw new DomainError('人工修改的内容需人工发布');
      const duplicates=events.filter(event=>event.status==='published'&&event.evidenceIds.some(eid=>{const item=evidence.find(e=>e.id===eid);return item&&primary&&providerIdentity(item)===providerIdentity(primary);})&&
        (content.publicationMode!=='news_only'||!content.reviewStatus||articles.some(article=>article.eventId===event.id&&article.status==='published'&&evidence.some(item=>item.id===article.evidenceIds[0]&&primary&&providerIdentity(item)===providerIdentity(primary)))));
      if(duplicates.length>1)throw new DomainError('同一原帖存在多个事件，关联冲突');
      if(!content.eventId&&duplicates[0])content.eventId=duplicates[0].id;
      else if(duplicates[0]&&duplicates[0].id!==content.eventId){
        const duplicate=await one<RadarEvent>('events',duplicates[0].id,c,true),target=await one<RadarEvent>('events',content.eventId!,c,true);
        const provisional=duplicate&&target&&primary?automaticNewsContextUpgrade(primary,content,duplicate,target,evidence,articles):undefined;
        const article=provisional?await one<Article>('articles',provisional.id,c,true):undefined;
        if(!duplicate||!target||!primary||!article||!automaticNewsContextUpgrade(primary,content,duplicate,target,evidence,articles.map(item=>item.id===article.id?article:item))||content.actions[0].id!==target.actions[0].id)throw new DomainError('原帖已有事件，关联冲突');
        newsUpgrade={event:duplicate,article};
      }
    }
    const existing=content.eventId?await one<RadarEvent>('events',content.eventId,c,true):undefined;
    if(content.eventId&&(requireEventVersion||expectedEventVersion!==undefined))assertVersion(existing,expectedEventVersion);
    if(content.actions.some(action=>events.some(event=>event.status==='published'&&event.id!==content.eventId&&event.actions.some(old=>old.id===action.id))))throw new DomainError('动作已经属于另一事件，请先关联事件');
    if(automatic){const sourceErrors=validateDraft(content,evidence,true);if(sourceErrors.length)throw new DomainError(sourceErrors.join('；'));}
    const originalContent=structuredClone(content);
    const partition=automatic?partitionAutomaticActions(content,existing):{current:content.actions,stale:[]};
    const archiveOnly=partition.stale.length>0&&partition.current.length===0;
    if(automatic&&partition.stale.length){
      content={...content,actions:partition.current};
      if(archiveOnly){const statementTime=new Date(partition.stale.map(action=>action.statementAt).sort()[0]).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});content={...content,title:'较早公告记录',summary:`来源较早公告（${statementTime}，北京时间）：${content.summary}`.slice(0,2400),publicationMode:'news_only'};}
    }
    if(automatic&&existing&&!archiveOnly)content=preserveManualFields(content,existing);
    const errors=validateDraft(content,evidence,automatic);
    if(automatic&&primary?.metadata?.activity){const definition=primary.metadata.activity,current=await one<Activity>('activities',definition.id,c);const manuallyConfigured=(await list<Audit>('audits',c)).some(entry=>entry.action==='activity.save'&&entry.objectId===definition.id);if(current&&manuallyConfigured&&(['timezone','startsOn','days','rules'] as const).some(field=>current[field]!==definition[field]))errors.push('活动来源规则与人工配置冲突，暂缓关联');}
    if(automatic&&candidate.automation?.state==='conflict')errors.push(...candidate.reasons);
    if(errors.length)throw new DomainError([...new Set(errors)].join('；'));
    const matchingArticle=newsUpgrade?.article??articleForPrimary(candidate,content,primary,evidence,articles,automatic);
    const previousArticle=matchingArticle?await one<Article>('articles',matchingArticle.id,c,true):undefined;
    if(enrichment&&!previousArticle)throw new DomainError('模板文章不存在，不能补充另一文章');
    // A copy can keep the original body while losing its reply relationship.
    // Missing context is not a correction to an already qualified statement.
    const canonical=previousArticle&&evidence.find(item=>item.id===previousArticle.evidenceIds[0]);
    const sameQualifiedPost=automatic&&primary&&previousArticle?.publicationMode==='state_change'&&existing?.status==='published'&&canonical?.textOrigin==='original'&&providerIdentity(primary)===providerIdentity(canonical);
    if(sameQualifiedPost&&content.publicationMode==='news_only'&&originalConflict(primary,[primary,canonical]))throw new DomainError('同一原帖正文或父帖存在冲突，不能用待确认副本替换已核验文章',409);
    const incompleteOriginalCopy=sameQualifiedPost&&primary.textOrigin==='original'&&!originalConflict(primary,[primary,canonical])&&!hasCompleteContext(primary,gatherEvidenceContext(primary,evidence));
    if(sameQualifiedPost&&content.publicationMode==='news_only'&&(primary.textOrigin==='archive_excerpt'||incompleteOriginalCopy)&&hasCompleteContext(canonical,gatherEvidenceContext(canonical,evidence))){
      const retained=await one<Publication>('publications',previousArticle.publicationId,c);
      if(!retained||retained.mode==='news_only')throw new DomainError('完整原文的发布快照缺失，不能替换为摘要',409);
      if(content.activityId&&content.activityDay){const activity=await one<Activity>('activities',content.activityId,c,true);if(activity&&!activity.items.some(item=>item.articleId===previousArticle.id&&item.day===content.activityDay))await put('activities',{...activity,version:activity.version+1,items:[...activity.items,{day:content.activityDay,articleId:previousArticle.id,eventId:previousArticle.eventId}]},c);}
      const canonicalContent:DraftContent={...content,title:previousArticle.title,summary:previousArticle.summary,translation:previousArticle.translation,category:previousArticle.category,eventId:previousArticle.eventId,evidenceIds:previousArticle.evidenceIds,contextEvidenceIds:previousArticle.contextEvidenceIds,actions:retained.event.actions.filter(action=>action.evidenceIds.includes(canonical.id)&&Math.abs(Date.parse(action.statementAt)-Date.parse(canonical.publishedAt))<1000),publicationMode:'state_change',contentOrigin:previousArticle.contentOrigin,reviewStatus:undefined,reviewReasons:undefined};
      await put('candidates',{...candidate,status:'published',version:candidate.version+1,updatedAt:now(),content:canonicalContent,reasons:[],automation:{...candidate.automation,state:'ready',reasonCodes:['canonical_original_retained'],dependencyIds:[],articleId:previousArticle.id,templatePublished:previousArticle.contentOrigin==='template',evaluatedAt:now()}},c);
      await audit(actor,'candidate.original_retained',candidate.id,'归档副本保留出处，沿用同一原帖已核验的完整原文发布版本',candidate,{publicationId:retained.id,evidenceId:primary.id},c);
      return retained;
    }
    if(automatic&&previousArticle?.manualFields)for(const field of previousArticle.manualFields)content[field]=previousArticle[field];
    const correction=automatic&&automaticCorrection(content,existing,evidence);
    const activity=content.activityId?await one<Activity>('activities',content.activityId,c):undefined;
    // Re-evaluation of an already archived source is not a new publication.
    const archivedAgain=archiveOnly&&existing?.status==='published'&&previousArticle&&sameIds(content.evidenceIds,previousArticle.evidenceIds)&&sameIds(content.contextEvidenceIds,previousArticle.contextEvidenceIds)&&(!content.activityId||activity?.items.some(item=>item.articleId===previousArticle.id&&item.day===content.activityDay));
    if(automatic&&previousArticle&&(archivedAgain||samePublishedContent(content,previousArticle,existing,activity,correction))){
      const result=await one<Publication>('publications',previousArticle.publicationId,c);
      if(!result)throw new DomainError('当前文章的发布快照不存在，无法安全复用');
      const persistedContent=archivedAgain?{...originalContent,title:previousArticle.title,summary:previousArticle.summary,translation:previousArticle.translation,category:previousArticle.category,evidenceIds:previousArticle.evidenceIds,contextEvidenceIds:previousArticle.contextEvidenceIds,publicationMode:previousArticle.publicationMode??'state_change',contentOrigin:previousArticle.contentOrigin}:content;
      await put('candidates',{...candidate,status:'published',version:candidate.version+1,updatedAt:now(),content:{...persistedContent,eventId:result.eventId},reasons:[],automation:{...candidate.automation,state:'ready',reasonCodes:[],dependencyIds:[],articleId:result.articleId,templatePublished:persistedContent.contentOrigin==='template',evaluatedAt:now()}},c);
      await audit(actor,'candidate.publication_unchanged',candidate.id,'重新核验通过，复用已有发布版本；事实和内容未变化',candidate,{publicationId:result.id,articleId:result.articleId,archived:archiveOnly},c);
      return result;
    }
    const eventTitle=automatic?mixedAutomaticEventTitle(content,existing,!!partition.stale.length,correction):undefined;
    const result=await publish(content,c,{actor,reason,existingArticle:previousArticle,correction,automatic,eventTitle});
    if(newsUpgrade){
      const merged={...newsUpgrade.event,status:'merged' as const,mergedInto:result.eventId,version:newsUpgrade.event.version+1,updatedAt:now()};
      await put('events',merged,c);
      for(const activity of await list<Activity>('activities',c))if(activity.items.some(item=>item.articleId===result.articleId&&item.eventId===newsUpgrade.event.id)){
        const current=await one<Activity>('activities',activity.id,c,true);
        if(current)await put('activities',{...current,version:current.version+1,items:current.items.map(item=>item.articleId===result.articleId&&item.eventId===newsUpgrade.event.id?{...item,eventId:result.eventId}:item)},c);
      }
      await audit(actor,'event.news_context_link',newsUpgrade.event.id,'核验明确父帖后，空动作模板新闻关联到已有预告；旧发布快照保留',newsUpgrade.event,{event:merged,articleId:result.articleId,publicationId:result.id},c);
    }
    await put('candidates',{...candidate,status:'published',version:candidate.version+1,updatedAt:now(),content:{...content,eventId:result.eventId},reasons:[],automation:{...candidate.automation,state:'ready',reasonCodes:[],dependencyIds:[],articleId:result.articleId,templatePublished:content.contentOrigin==='template',evaluatedAt:now()}},c);
    return result;
  });
}
export async function executeCommand(action:string,input:Record<string,unknown>,actor:string):Promise<unknown> {
  if(action==='settings.tibo')throw new DomainError('收费采集已停用，无需配置 X 凭据');
  if(action==='settings.wechat')return saveWechatSettings(input,actor);
  if(action==='candidate.preview') return previewCandidate(str(input.id),Number(input.version));
  if(action==='candidate.publish') return publishCandidate(str(input.id),Number(input.version),actor,typeof input.reason==='string'?input.reason:'站长核对发布',false,typeof input.expectedEventVersion==='number'?input.expectedEventVersion:undefined,true);
  if(action==='ai.test') {
    let result:Awaited<ReturnType<typeof testAI>>;
    try { result=await testAI(); } catch(error) {await failedOperationAudit(actor,action,'ai',error);throw error;}
    try { await transaction(c=>audit(actor,action,'ai','智能连接测试成功',undefined,{outcome:'succeeded',testedAt:result.testedAt},c)); }
    catch { throw new DomainError('连接测试已成功，但操作记录未保存。请刷新配置状态，避免重复测试。',503); }
    return result;
  }
  if(action==='settings.ai'&&typeof input.baseUrl==='string'&&input.baseUrl)await validateEndpoint(input.baseUrl);
  if(action==='source.validate') {const {validateSource}=await import('./ingestion');return validateSource(str(input.id),actor);}
  if(action==='candidate.create') {
    let result:Awaited<ReturnType<typeof createEvidence>>|undefined;
    try {
      const parsed=z.object({sourceId:z.string().default('manual'),url:z.string().url(),text:z.string().min(2).max(20000),publishedAt:z.string().datetime({offset:true}),parentId:z.string().optional(),contextComplete:z.boolean().default(false)}).parse(input);
      const u=new URL(parsed.url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw new DomainError('原文链接格式无效');
      result=await createEvidence({...parsed,messageId:typeof input.messageId==='string'?input.messageId:`manual_${hash(parsed.url+parsed.publishedAt)}`,collectedAt:now(),historical:input.historical===true,provenance:'manual'},actor);if(result.candidate&&input.content) await executeCommand('candidate.save',{id:result.candidate.id,version:1,content:input.content},actor);return result;
    } catch(error) {await failedOperationAudit(actor,action,result?.candidate?.id??result?.evidence.id??'manual',error,result?{evidenceId:result.evidence.id,candidateId:result.candidate?.id}:undefined);throw error;}
  }
  return transaction(async c=>{
    await lockTransaction(c,'radar_publication');
    if(action==='notice.publish') {
      const requestId=input.requestId===undefined?undefined:z.string().uuid().parse(input.requestId);
      const noticeId=requestId?`notice_${hash(`${actor}:${requestId}`).slice(0,32)}`:id('notice');
      const notice=createAdminNotice(input,noticeId,now());
      const existing=requestId?await one<Notice>('notices',noticeId,c):undefined;
      if(existing){
        if(existing.origin!=='admin'||existing.title!==notice.title||existing.body!==notice.body||input.createdAt!==undefined&&existing.createdAt!==notice.createdAt||input.pinned!==undefined&&!!existing.pinned!==notice.pinned)throw new DomainError('这次发布内容已变化，请重新打开编辑后发布',409);
        return existing;
      }
      await insert('notices',notice,c);
      await audit(actor,action,notice.id,'发布站内信',undefined,notice,c);
      return notice;
    }
    if(action==='notice.pin') {
      const {id:noticeId,pinned,expectedPinned}=z.object({id:z.string().min(1).max(180),pinned:z.boolean(),expectedPinned:z.boolean()}).parse(input);
      const notice=await one<Notice>('notices',noticeId,c);
      if(!notice||notice.origin!=='admin'||notice.status!=='active')throw new DomainError('仅可置顶已发布的手动站内信',404);
      if(!!notice.pinned===pinned)return notice;
      if(!!notice.pinned!==expectedPinned)throw new DomainError('置顶状态已变化，请刷新后重试',409);
      const next={...notice,pinned};
      await put('notices',next,c);
      await audit(actor,action,notice.id,pinned?'置顶站内信':'取消站内信置顶',notice,next,c);
      return next;
    }
    if(action==='notice.withdraw') {
      const notice=await one<Notice>('notices',str(input.id),c);
      if(!notice||notice.origin!=='admin')throw new DomainError('未找到管理员发布的站内信',404);
      if(notice.status==='withdrawn')return notice;
      const next={...notice,status:'withdrawn'} as Notice;
      await put('notices',next,c);
      await audit(actor,action,notice.id,'撤回站内信',notice,next,c);
      return next;
    }
    if(action==='candidate.save'||action==='candidate.ignore'||action==='candidate.generate') {
      const old=await locked<Candidate>('candidates',input.id,input.version,c);if(old.status==='published'||old.status==='ignored')throw new DomainError('候选已处理，不能修改');
      if(action==='candidate.generate') return queueJob('generate',{candidateId:old.id,force:true,expectedVersion:old.version},c,{actor,action,objectId:old.id});
      const content=action==='candidate.save'?draftSchema.parse(input.content):old.content;
      const updated:Candidate={...old,content,status:action==='candidate.ignore'?'ignored':'draft',humanEdited:true,version:old.version+1,updatedAt:now(),reasons:action==='candidate.ignore'?[requireReason(input.reason)]:validateDraft(content,await list<Evidence>('evidence',c))};
      await put('candidates',updated,c);await audit(actor,action,old.id,typeof input.reason==='string'?input.reason:'人工编辑候选',old,updated,c);return updated;
    }
    if(action==='event.correct') {const old=await locked<RadarEvent>('events',input.id,input.version,c); const content=draftSchema.parse(input.content);return publish({...content,eventId:old.id},c,{actor,reason:requireReason(input.reason),correction:true});}
    if(action==='event.withdraw') {const old=await locked<RadarEvent>('events',input.id,input.version,c);if(old.status!=='published')throw new DomainError('事件已撤回或合并，不能重复撤回',409);const p=await one<Publication>('publications',old.publicationId,c);if(!p)throw new DomainError('发布记录不存在');const reason=requireReason(input.reason);let result=await publish({...p.article,actions:old.actions,eventId:old.id},c,{actor,reason,correction:true,withdrawn:true,existingArticle:p.article});
      for(const article of await list<Article>('articles',c))if(article.eventId===old.id&&article.id!==p.article.id&&article.status!=='withdrawn'){result=await publish({...article,actions:old.actions,eventId:old.id},c,{actor,reason,withdrawn:true,correction:true,existingArticle:article,suppressNotice:true});}
      for(const n of await list<Notice>('notices',c))if(n.eventId===old.id)await put('notices',{...n,status:'withdrawn'},c);await withdrawalNotice(result,'event',old.id,reason,c);return result;
    }
    if(action==='event.merge') {const source=await locked<RadarEvent>('events',input.id,input.version,c); const target=await locked<RadarEvent>('events',input.targetId,input.targetVersion,c);if(source.id===target.id||source.status!=='published'||target.status!=='published')throw new DomainError('请选择两个不同的有效事件');const reason=requireReason(input.reason); const p=await one<Publication>('publications',target.publicationId,c);if(!p)throw new DomainError('发布记录不存在');
      const mergedActions=mergeActions(target.actions,source.actions);const merged=await publish({...p.article,...actionContent(mergedActions),eventId:target.id,actions:mergedActions,evidenceIds:[...new Set([...target.evidenceIds,...source.evidenceIds])]},c,{actor,reason,correction:true,suppressNotice:true});
      await put('events',{...source,status:'merged',mergedInto:target.id,version:source.version+1,updatedAt:now()},c);for(const n of await list<Notice>('notices',c))if(n.eventId===source.id)await put('notices',{...n,status:'withdrawn'},c);await audit(actor,action,source.id,reason,source,merged.event,c);return merged;
    }
    if(action==='event.split') {const old=await locked<RadarEvent>('events',input.id,input.version,c);const actionIds=z.array(z.string()).min(1).parse(input.actionIds);const moved=old.actions.filter(a=>actionIds.includes(a.id)),remaining=old.actions.filter(a=>!actionIds.includes(a.id));if(moved.length!==new Set(actionIds).size||!moved.length||!remaining.length)throw new DomainError('拆分后两个事件都须保留至少一个动作');const reason=requireReason(input.reason);const p=await one<Publication>('publications',old.publicationId,c);if(!p)throw new DomainError('发布记录不存在');
      const first=await publish({...p.article,...actionContent(remaining),eventId:old.id,actions:remaining},c,{actor,reason,correction:true,suppressNotice:true});const second=await publish({...p.article,...actionContent(moved),eventId:undefined,title:str(input.title),actions:moved},c,{actor,reason,suppressNotice:true});return {original:first,created:second};
    }
    if(action==='article.save'||action==='article.withdraw') {const old=await locked<Article>('articles',input.id,input.version,c);const event=await one<RadarEvent>('events',old.eventId,c,true);if(!event)throw new DomainError('关联事件不存在');const content=draftSchema.parse({...old,title:input.title??old.title,summary:input.summary??old.summary,translation:input.translation??old.translation,actions:old.publicationMode==='news_only'?[]:event.actions,evidenceIds:old.publicationMode==='news_only'?old.evidenceIds:[...new Set([...old.evidenceIds,...event.evidenceIds])],eventId:event.id});const reason=requireReason(input.reason);if(action==='article.withdraw'&&old.status==='withdrawn')throw new DomainError('文章已撤回，不能重复撤回',409);
      if(action==='article.withdraw'&&event.publicationId===old.publicationId) {const result=await publish({...old,actions:event.actions,eventId:event.id},c,{actor,reason,correction:true,withdrawn:true,existingArticle:old});for(const n of await list<Notice>('notices',c))if(n.eventId===event.id)await put('notices',{...n,status:'withdrawn'},c);await withdrawalNotice(result,'event',event.id,reason,c);return result;}
      if(action==='article.withdraw') {const pId=id('pub');const time=now();const article:Article={...old,status:'withdrawn',version:old.version+1,publicationId:pId,updatedAt:time};const previous=await one<Publication>('publications',old.publicationId,c);const p:Publication={id:pId,eventId:event.id,articleId:old.id,event,article,cutoffAt:previous?.cutoffAt??time,publishedAt:time,reason};await insert('publications',p,c);await put('articles',article,c);const articlePublications=new Set((await list<Publication>('publications',c)).filter(p=>p.articleId===old.id).map(p=>p.id));for(const n of await list<Notice>('notices',c))if(articlePublications.has(n.publicationId))await put('notices',{...n,status:'withdrawn'},c);await withdrawalNotice(p,'article',old.id,reason,c);await audit(actor,action,old.id,reason,old,article,c);await markForecastInputsChanged(c);return p;}
      const changed=(['title','summary','translation'] as const).filter(field=>old[field]!==content[field]);return publish(content,c,{actor,reason,existingArticle:{...old,manualFields:[...new Set([...(old.manualFields??[]),...changed])]},suppressNotice:true});
    }
    if(action==='source.save') {const old=await locked<Source>('sources',input.id,input.version,c);if(old.id==='tibo-timeline'&&input.enabled!==false)throw new DomainError('收费采集已停用，请使用免费公开动态');const patch=z.object({name:z.string().min(1).max(100).optional(),url:z.string().url().optional(),enabled:z.boolean().optional(),intervalMinutes:z.number().int().min(old.kind==='timeline'?2:5).max(1440).optional(),collectionPolicy:z.enum(['adaptive','manual']).optional()}).parse(input);if(patch.url&&patch.url!==old.url)throw new DomainError('来源地址由受支持适配器固定，不能改为其他网站');if(patch.enabled&&!old.validated)throw new DomainError('请先验证来源再启用');const configured={...old,...patch,collectionPolicy:patch.collectionPolicy??(patch.intervalMinutes!==undefined&&patch.intervalMinutes!==old.intervalMinutes?'manual':old.collectionPolicy)} as Source;const updated:Source={...configured,...sourceCollectionSchedule(configured),version:old.version+1,status:patch.enabled===false?'paused':patch.enabled===true?(old.lastSuccessAt?'healthy':'unconnected'):old.status,nextRunAt:patch.enabled||patch.intervalMinutes!==undefined||patch.collectionPolicy!==undefined?now():old.nextRunAt};await put('sources',updated,c);if(sourceForecastConfiguration(old)!==sourceForecastConfiguration(updated))await markForecastInputsChanged(c);await audit(actor,action,old.id,'修改来源设置',old,updated,c);return updated;}
    if(action==='source.collect'||action==='source.backfill') {const source=await one<Source>('sources',str(input.id),c);if(!source)throw new DomainError('来源不存在');if(source.id==='tibo-timeline')throw new DomainError('收费采集已停用，请使用免费公开动态');if(!source.validated)throw new DomainError('请先验证来源');if(source.kind==='timeline'&&action==='source.backfill')throw new DomainError('Tibo 直采按持久分页自动补齐，不支持独立历史补采');return queueJob(action==='source.collect'?'collect':'backfill',{sourceId:source.id,historical:action==='source.backfill'},c,{actor,action,objectId:source.id});}
    if(action==='job.retry') {const old=await one<Job>('jobs',str(input.id),c,true);if(!old||old.status!=='failed')throw new DomainError('只有失败任务可以重试');const updated:Job={...old,status:'queued',attempts:0,availableAt:now(),leaseUntil:undefined,error:undefined,finishedAt:undefined,payload:{...old.payload,failureKind:undefined,blockedReason:undefined,resumeAfter:undefined}};await put('jobs',updated,c);await audit(actor,action,old.id,'手动重试任务',old,updated,c);return updated;}
    if(action==='activity.save') {const old=input.id?await locked<Activity>('activities',input.id,input.version,c):undefined;const parsed=z.object({title:z.string().min(2).max(120),timezone:z.string().refine(v=>{try{new Intl.DateTimeFormat('zh-CN',{timeZone:v});return true;}catch{return false;}},'时区无效'),startsOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(startsOn=>activityHideDate({startsOn,days:1,timezone:'UTC'})!==undefined,'活动日期无效'),days:z.number().int().min(1).max(366),rules:z.string().min(2).max(5000),showOnHome:z.boolean().optional()}).parse(input);const items=input.items===undefined?(old?.items??[]):z.array(z.object({day:z.number().int().min(1),articleId:z.string(),eventId:z.string()})).max(1000).parse(input.items);const unique=new Set<string>();for(const entry of items){if(entry.day>parsed.days)throw new DomainError('条目天数超出活动范围');if(unique.has(entry.articleId))throw new DomainError('同一文章不能重复添加到活动');unique.add(entry.articleId);if(old?.items.some(previous=>previous.day===entry.day&&previous.articleId===entry.articleId&&previous.eventId===entry.eventId))continue;const article=await one<Article>('articles',entry.articleId,c);const event=await one<RadarEvent>('events',entry.eventId,c);if(!article||article.status!=='published'||article.eventId!==entry.eventId||!event||event.status!=='published')throw new DomainError('活动只能关联匹配的有效公开文章与事件');}const item:Activity={...parsed,showOnHome:parsed.showOnHome??old?.showOnHome??true,id:old?.id??id('activity'),version:(old?.version??0)+1,items};await put('activities',item,c);await audit(actor,action,item.id,'保存活动规则',old,item,c);return item;}
    if(action==='settings.site') {const old=await one<SiteSettings>('settings','site',c,true)??defaultSite;assertVersion(old,input.version);const parsed=z.object({name:z.string().min(2).max(40),description:z.string().max(180),autoPublish:z.boolean()}).parse(input);const value={id:'site',...parsed,version:old.version+1};await put('settings',value,c);await audit(actor,action,'site','修改站点配置',old,value,c);return value;}
    if(action==='settings.ai') {const old=await one<AIRecord>('settings','ai',c,true)??defaultAI;assertVersion(old,input.version);const parsed=z.object({enabled:z.boolean(),baseUrl:z.string().max(600),model:z.string().max(100),dailyCallLimit:z.number().int().min(0).max(100000),dailyBudget:z.number().min(0).max(100000),inputPrice:z.number().min(0),outputPrice:z.number().min(0),currency:z.string().min(1).max(10)}).parse(input);const newKey=typeof input.key==='string'&&input.key.trim()?encryptKey(input.key.trim()):old.encryptedKey;const changed=parsed.baseUrl!==old.baseUrl||parsed.model!==old.model||newKey!==old.encryptedKey;const value:AIRecord={...old,...parsed,id:'ai',encryptedKey:newKey,hasKey:!!newKey,testedAt:changed?undefined:old.testedAt,version:old.version+1};if(value.enabled&&(!value.testedAt||!value.hasKey||!value.model||!value.dailyCallLimit||!value.dailyBudget||!value.inputPrice||!value.outputPrice))throw new DomainError('先保存完整配置、设置限额和单价并测试成功后再启用');await put('settings',value,c);const {encryptedKey:_key,...safe}=value;await audit(actor,action,'ai','更新智能服务配置',undefined,safe,c);return safe;}
    throw new DomainError('不支持的操作',404);
  }).catch(async error=>{if(action==='candidate.generate'||action==='source.collect'||action==='source.backfill')await failedOperationAudit(actor,action,typeof input.id==='string'&&input.id.length<=200?input.id:action==='candidate.generate'?'candidate':'source',error);throw error;});
}
