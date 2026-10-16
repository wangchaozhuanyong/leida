import { lockTransaction } from '../db';
import {createHash} from 'node:crypto';
import {isCloudbaseClient,pool,list,one,insert,put,transaction,type Client} from '../db';
import type {Evidence,Source,Publication,RadarEvent,Article} from '../lib/types';
import {FORECAST_RULE_VERSION,FORECAST_MODEL_VERSION,referenceForecast,forecastWindows,forecastSourceAvailable,qualifyForecastSignal,matchForecastCase,buildForecastSnapshot,publicForecastCaseProjection,effectiveForecastOutcome,type ForecastPublicData,type ForecastCase,type ForecastSnapshot,type ForecastOutcome} from '../lib/forecast';
import {executeResetCadence,getCadenceSnapshot,isCadence,projectCadenceForecast,cadenceOutcomes,publicCadenceHorizonOutcomes,forecastCycleDue,type CadenceRuntime,type StoredCadenceForecast} from './reset-cadence-runtime';
import {configuredPublicRpc} from './cloudbase/public-config';
import {publicResetOutlook} from '../lib/reset-outlook';
import type {PublicFactsData} from '../lib/public-facts';

const key=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso=()=>new Date().toISOString();
export async function forecastTablesAvailable(client:Client=pool):Promise<boolean> {
 if(isCloudbaseClient(client)){await list('forecast_cases',client);await list('forecast_snapshots',client);await list('forecast_outcomes',client);return true;}
 const result=await client.query("SELECT to_regclass('radar_forecast_cases') AS cases,to_regclass('radar_forecast_snapshots') AS snapshots,to_regclass('radar_forecast_outcomes') AS outcomes");
 return !!(result.rows[0]?.cases&&result.rows[0]?.snapshots&&result.rows[0]?.outcomes);
}
export async function getForecastSnapshot(id:string,client:Client=pool):Promise<ForecastSnapshot|undefined> {
 if(!/^forecast_snapshot_[a-f0-9]{64}$/.test(id))return;
 const rpc=client===pool?configuredPublicRpc():undefined;if(rpc)return (await import('./cloudbase/public-read')).createCloudbasePublicReader(rpc).snapshot(id);
 if(!await forecastTablesAvailable(client))return;
 return one<ForecastSnapshot>('forecast_snapshots',id,client);
}
export async function getResetCadenceSnapshot(id:string,client:Client=pool):Promise<StoredCadenceForecast|undefined> {
 const rpc=client===pool?configuredPublicRpc():undefined;if(rpc){const row=await (await import('./cloudbase/public-read')).createCloudbasePublicReader(rpc).snapshot(id);return isCadence(row)?row:undefined;}
 if(!await forecastTablesAvailable(client))return;
 return getCadenceSnapshot(id,client);
}
export async function getPublicForecast(client:Client=pool,timestamp=iso(),publicData?:PublicFactsData,compact:boolean|'home'=false):Promise<ForecastPublicData> {
 const metadata={ruleVersion:FORECAST_RULE_VERSION,modelVersion:FORECAST_MODEL_VERSION,generatedAt:timestamp,reference:referenceForecast()};
 if(!await forecastTablesAvailable(client))return {...metadata,...(publicData?{outlook:publicResetOutlook(publicData)}:{}),status:'unavailable',reason:'历史实验数据结构尚未初始化',cases:[]};
 const facts=publicData??await (async()=>{const [events,articles,publications,evidence]=await Promise.all([list<RadarEvent>('events',client),list<Article>('articles',client),list<Publication>('publications',client),list<Evidence>('evidence',client)]);const publicEvidence=new Set(publications.flatMap(p=>p.article.evidenceIds));return {events,articles,publications,evidence:evidence.filter(e=>publicEvidence.has(e.id)),serverTime:timestamp};})();
 const cases:ForecastCase[]=compact==='home'?(await client.query("SELECT payload FROM radar_forecast_cases WHERE (payload->'windows'->>'48')::timestamptz>$1::timestamptz",[timestamp])).rows.map(row=>row.payload):await list<ForecastCase>('forecast_cases',client);
 const outcomes:ForecastOutcome[]=compact==='home'?(await client.query("SELECT payload FROM radar_forecast_outcomes WHERE payload->>'caseId'=ANY($1::text[])",[cases.map(c=>c.id)])).rows.map(row=>row.payload):await list<ForecastOutcome>('forecast_outcomes',client),sources=await list<Source>('sources',client);
 const snapshots:ForecastSnapshot[]=compact?(await client.query(`SELECT (payload - 'observations' - 'trainingObservationIds' - 'trainingIntervals' - 'historicalIntervals' - 'capacityPadding') || CASE WHEN payload->>'recordType'='reset_cadence' THEN jsonb_build_object('summaryOnly',true,'observations','[]'::jsonb,'trainingObservationIds','[]'::jsonb,'trainingIntervals','[]'::jsonb,'historicalIntervals','[]'::jsonb,'backtest',((payload->'backtest') - 'entries') || jsonb_build_object('entries','[]'::jsonb)) ELSE '{}'::jsonb END AS payload FROM radar_forecast_snapshots WHERE id=ANY($1::text[]) OR id IN (SELECT jsonb_each_text.value FROM radar_settings CROSS JOIN LATERAL jsonb_each_text(coalesce(payload->'cadenceSnapshotIds','{}'::jsonb)) WHERE id='forecast_runtime') OR id=(SELECT payload->>'cadenceSnapshotId' FROM radar_settings WHERE id='forecast_runtime') ${compact==='home'?'':"OR id IN (SELECT id FROM radar_forecast_snapshots WHERE payload->>'recordType'='reset_cadence' ORDER BY (payload->>'generatedAt')::timestamptz DESC,id LIMIT 12)"}`,[cases.map(c=>c.snapshotId)])).rows.map(row=>row.payload):await list<ForecastSnapshot>('forecast_snapshots',client);
 const runtime=await one<CadenceRuntime&{status?:string}>('settings','forecast_runtime',client);
 const cadenceSnapshot=runtime?.cadenceSnapshotId?(compact?snapshots.find(s=>s.id===runtime.cadenceSnapshotId) as unknown as StoredCadenceForecast:await getCadenceSnapshot(runtime.cadenceSnapshotId,client)):undefined;
 return projectPublicForecastRecords({cases,outcomes,sources,snapshots,runtime,cadenceSnapshot},timestamp,facts,compact);
}
/** Same factual projection for native and single-snapshot CloudBase reads. */
export function projectPublicForecastRecords(input:{cases:ForecastCase[];outcomes:ForecastOutcome[];sources:Source[];snapshots:ForecastSnapshot[];runtime?:(Partial<CadenceRuntime>&{status?:string});cadenceSnapshot?:StoredCadenceForecast},timestamp:string,facts:PublicFactsData,compact:boolean|'home'=false):ForecastPublicData {
 const {cases,outcomes,sources,snapshots,runtime,cadenceSnapshot}=input;
 const base={ruleVersion:FORECAST_RULE_VERSION,modelVersion:FORECAST_MODEL_VERSION,generatedAt:timestamp,reference:referenceForecast(),outlook:publicResetOutlook(facts)};
 const cadenceHistory=compact==='home'?[]:(snapshots as unknown as StoredCadenceForecast[]).filter(s=>s.recordType==='reset_cadence').sort((a,b)=>Date.parse(b.generatedAt)-Date.parse(a.generatedAt)).slice(0,12);
 const computationFailed=runtime?.status==='error';
 const cadenceByKind:NonNullable<ForecastPublicData['cadenceByKind']>={};
 for(const target of ['automatic_reset','banked_reset'] as const){const id=runtime?.cadenceSnapshotIds?.[target],stored=id?(snapshots as unknown as StoredCadenceForecast[]).find(s=>s.id===id):target==='automatic_reset'?cadenceSnapshot:undefined;const projected=projectCadenceForecast(stored,sources,timestamp);if(projected)cadenceByKind[target]=projected;}
 const cadence=cadenceByKind.automatic_reset??projectCadenceForecast(cadenceSnapshot,sources,timestamp);
 const visibleCadenceIds=new Set([...cadenceHistory.map(s=>s.id),...Object.values(runtime?.cadenceSnapshotIds??{}),...(cadenceSnapshot?[cadenceSnapshot.id]:[])]);
 const visibleCadence=(snapshots as unknown as StoredCadenceForecast[]).filter(s=>visibleCadenceIds.has(s.id));
 const cadenceHorizonOutcomes=compact==='home'?undefined:publicCadenceHorizonOutcomes(outcomes,visibleCadence,timestamp);
 return {...base,status:computationFailed?'unavailable':'ready',...(computationFailed?{reason:'预测观察处理失败，暂不提供当前实验估计；公开公告与固定历史记录继续保留。'}:{}),cadence:computationFailed?undefined:cadence,cadenceByKind:computationFailed?undefined:cadenceByKind,cadenceEvaluationByKind:runtime?.cadenceEvaluationByKind,cadenceHistory,cadenceOutcomes:cadenceOutcomes(outcomes).slice(0,12),...(cadenceHorizonOutcomes?{cadenceHorizonOutcomes}:{}),cases:cases.slice().sort((a,b)=>Date.parse(b.signalAt)-Date.parse(a.signalAt)).map(c=>{
  const available=forecastSourceAvailable(sources.find(s=>s.id===c.sourceId),timestamp);
  const projectedCase={...c,coverage:!available?{status:'gap' as const,sourceIds:c.coverage.sourceIds,reason:'信号来源暂停、失效或结构异常，不能据未找到消息标阴性'}:c.coverage},snapshot=snapshots.find(s=>s.id===c.snapshotId);
  const {status}=publicForecastCaseProjection(projectedCase,snapshot,timestamp);
  return {...projectedCase,status,snapshot,outcomes:outcomes.filter(o=>o.caseId===c.id).sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt))};
 })};
}
export interface ForecastCycleResult {status:'ready'|'unavailable'|'error';discovered:number;snapshots:number;outcomes:number;cadenceSnapshots?:number;cadenceOutcomes?:number;}
/** Independent observation transaction: never writes events, articles, publications or reader notices. */
export async function runForecastCycle(timestamp=iso(),options:{force?:boolean;inputsChanged?:boolean}={}):Promise<ForecastCycleResult> {
 try{return await transaction(async c=>{
  const result:ForecastCycleResult={status:'ready',discovered:0,snapshots:0,outcomes:0};
  await lockTransaction(c,'radar_forecast_cycle');
  const runtime=await one<CadenceRuntime>('settings','forecast_runtime',c);
  const inputs=await one<{id:string;revision?:string}>('settings','forecast_inputs',c);
  // A no-change worker tick reads only these two tiny settings rows. No history scan.
  if(!options.force&&!forecastCycleDue(runtime,inputs?.revision,timestamp,options.inputsChanged))return result;
  if(!await forecastTablesAvailable(c))return {...result,status:'unavailable'};
  const sources=await list<Source>('sources',c),all=await list<Evidence>('evidence',c),cases=await list<ForecastCase>('forecast_cases',c),outcomes=await list<ForecastOutcome>('forecast_outcomes',c),publications=await list<Publication>('publications',c),events=await list<RadarEvent>('events',c),articles=await list<Article>('articles',c);
  // Existing evidence versions retain their own public/collection times; older updates cannot reset a case window.
  const signals=all.filter(e=>Date.parse(e.collectedAt)<=Date.parse(timestamp)&&Date.parse(e.publishedAt)<=Date.parse(timestamp)).sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt));
  for(const e of signals){
   const signal=qualifyForecastSignal(e,sources.find(s=>s.id===e.sourceId),timestamp);if(!signal)continue;
   for(const target of ['automatic_reset','banked_reset'] as const){
    let current=cases.find(item=>item.identity===signal.identity&&item.target===target);
    if(!current){
     const id=`forecast_case_${key([signal.identity,target])}`,windows=forecastWindows(signal.signalAt),signature=key([id,FORECAST_RULE_VERSION,FORECAST_MODEL_VERSION]);
     const snapshotId=`forecast_snapshot_${signature}`,late=Math.max(Date.parse(e.collectedAt),Date.parse(timestamp))>=Date.parse(windows[24]);
     current={id,identity:signal.identity,title:'Codex 用量异常观察',url:signal.url,sourceId:e.sourceId,signalEvidenceIds:[e.id],target,signalAt:signal.signalAt,collectedAt:e.collectedAt,windows,status:Date.parse(timestamp)>=Date.parse(windows[48])?'elapsed':'watching',coverage:{status:'unverified',sourceIds:sources.filter(s=>forecastSourceAvailable(s,timestamp)&&['status','archive'].includes(s.kind)).map(s=>s.id),reason:'当前来源轮询不证明全部原帖与回复连续覆盖；未找到目标公告仍属未知'},late,snapshotId,createdAt:timestamp,updatedAt:timestamp};
     if(await insert('forecast_cases',current,c)){cases.push(current);result.discovered++;}
    } else if(!current.signalEvidenceIds.includes(e.id)){
     current={...current,signalEvidenceIds:[...current.signalEvidenceIds,e.id],updatedAt:timestamp};await put('forecast_cases',current,c);cases[cases.findIndex(item=>item.id===current!.id)]=current;
    }
   }
  }
  // Immutable publication actions must be supported by that article's own evidence, not inherited unrelated actions.
  for(const publication of publications.sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt))){
   if(Date.parse(publication.publishedAt)>Date.parse(timestamp))continue;
   const event=events.find(e=>e.id===publication.eventId),article=articles.find(a=>a.id===publication.articleId);
   if(event?.status!=='published'||article?.status!=='published'||publication.article.status!=='published'||publication.event.status!=='published')continue;
   for(const action of publication.event.actions){
    if(action.scope!=='public'||!Number.isFinite(Date.parse(action.statementAt)))continue;
    const proof=action.evidenceIds.map(id=>all.find(e=>e.id===id)).filter((e):e is Evidence=>!!e&&publication.article.evidenceIds.includes(e.id)&&Date.parse(e.collectedAt)<=Date.parse(timestamp)&&Date.parse(e.publishedAt)<=Date.parse(timestamp)&&forecastSourceAvailable(sources.find(s=>s.id===e.sourceId),timestamp)&&e.provenance!=='manual'&&e.textOrigin!=='archive_excerpt'&&!!action.evidenceQuote&&e.text.includes(action.evidenceQuote));
    for(const evidence of proof){
     const match=matchForecastCase(evidence,action.kind,cases,all);if(!match)continue;
     const current=cases.find(item=>item.id===match.caseId)!;
     const signature=key([current.id,action.stage,action.kind,action.statementAt,evidence.sourceId,evidence.messageId,action.scope,action.eligibility]);
     const outcome:ForecastOutcome={id:`forecast_outcome_${signature}`,signature,caseId:current.id,target:action.kind,stage:action.stage,evidenceIds:[evidence.id],publicationId:publication.id,eventId:publication.eventId,observedAt:timestamp,announcementAt:action.statementAt,relation:match.relation,relationVerified:true,actualDelivery:'unobserved',reason:'匹配公开公告及其对应资格，不代表任何个人账户实际到账'};
     if(await insert('forecast_outcomes',outcome,c)){outcomes.push(outcome);result.outcomes++;}
    }
   }
  }
  for(let current of cases){
   const available=forecastSourceAvailable(sources.find(s=>s.id===current.sourceId),timestamp),related=outcomes.filter(o=>o.caseId===current.id);
   // Withdrawal/correction is appended; it never edits a previous outcome or initial probability snapshot.
   for(const previous of related.filter(o=>o.publicationId&&o.stage!=='unknown'&&!o.invalidated)){
    const event=events.find(e=>e.id===previous.eventId),publication=publications.find(p=>p.id===previous.publicationId),article=articles.find(a=>a.id===publication?.articleId);
    const previousAction=publication?.event.actions.find(a=>a.kind===previous.target&&a.evidenceIds.some(id=>previous.evidenceIds.includes(id))),latest=event?.actions.find(a=>a.id===previousAction?.id);
    const changed=!!latest&&!!previousAction&&(latest.scope!==previousAction.scope||latest.eligibility!==previousAction.eligibility||latest.kind!==previousAction.kind||latest.stage==='cancelled'&&previousAction.stage!=='cancelled');
    if(event?.status!=='withdrawn'&&article?.status!=='withdrawn'&&!changed)continue;
    const signature=key([current.id,'invalidated',previous.id]);
    const invalidated:ForecastOutcome={id:`forecast_outcome_${signature}`,signature,caseId:current.id,target:current.target,stage:'unknown',evidenceIds:previous.evidenceIds,publicationId:previous.publicationId,eventId:previous.eventId,observedAt:timestamp,relation:'unmatched',relationVerified:false,actualDelivery:'unobserved',invalidated:true,reason:'关联公告已撤回、取消或资格订正，保留旧结局并标为不可训练'};
    if(await insert('forecast_outcomes',invalidated,c)){outcomes.push(invalidated);result.outcomes++;}
   }
   if(!await one<ForecastSnapshot>('forecast_snapshots',current.snapshotId,c)){
    const snapshot=buildForecastSnapshot({id:current.snapshotId,signature:key([current.id,FORECAST_RULE_VERSION,FORECAST_MODEL_VERSION]),case:current,generatedAt:timestamp,evidenceCutoffAt:timestamp,cases,outcomes});
    if(await insert('forecast_snapshots',snapshot,c))result.snapshots++;
   }
   const effective=effectiveForecastOutcome(outcomes,current.id,current.target,timestamp),validPositive=!!effective.positive;
   const status:ForecastCase['status']=!available?'paused':validPositive||effective.invalidated?'observed':Date.parse(timestamp)>=Date.parse(current.windows[48])?'elapsed':'watching';
   if(Date.parse(timestamp)>=Date.parse(current.windows[48])&&!validPositive&&!effective.invalidated){
    const signature=key([current.id,'unknown_after_48h']);
    const unknown:ForecastOutcome={id:`forecast_outcome_${signature}`,signature,caseId:current.id,target:current.target,stage:'unknown',evidenceIds:[],observedAt:timestamp,relation:'unmatched',relationVerified:false,actualDelivery:'unobserved',reason:available?'48小时窗口已结束，缺少明确匹配公告或可核验覆盖；未找到不等于没有发放':'48小时窗口已结束且来源存在缺口，结局未知'};
    if(await insert('forecast_outcomes',unknown,c)){outcomes.push(unknown);result.outcomes++;}
   }
   if(current.status!==status){current={...current,status,updatedAt:timestamp};await put('forecast_cases',current,c);}
  }
  const cadence=await executeResetCadence(c,all,sources,timestamp);
  result.cadenceSnapshots=cadence.snapshots;result.cadenceOutcomes=cadence.outcomes;
  await put('settings',{id:'forecast_runtime',checkedAt:timestamp,status:'ready',ruleVersion:FORECAST_RULE_VERSION,modelVersion:FORECAST_MODEL_VERSION,cadencePublicProjection:cadence.publicProjection,cadenceSnapshotId:cadence.snapshotId,cadenceSnapshotIds:cadence.snapshotIds,cadenceEvaluationByKind:cadence.evaluationByKind,inputsRevision:inputs?.revision,cadenceModelVersion:cadence.evaluationByKind.automatic_reset?.modelVersion,nextDueAt:cadence.nextDueAt},c);
  return result;
 });}catch{
  try{await put('settings',{id:'forecast_runtime',checkedAt:timestamp,status:'error',error:'预测观察处理失败，新闻与发放状态流程继续运行'});}catch{/* A storage failure cannot be repaired by this observation task. */}
  return {status:'error',discovered:0,snapshots:0,outcomes:0};
 }
}
