import {validatedReferenceReview} from '../../lib/reference-cadence';
import type { PublicData, Source } from '../../lib/types';
import type { PublicReadOptions, PublicReadEnvelope, PublicPage } from '../../lib/public-read';
import type { ForecastCase, ForecastOutcome, ForecastSnapshot } from '../../lib/forecast';
import type { StoredCadenceForecast, CadenceRuntime } from '../reset-cadence-runtime';
import { projectPublicHistory } from '../../lib/history';
import { publicResetOutlook } from '../../lib/reset-outlook';
import { publicActions, recentCompletedBenefits } from '../../lib/public-facts';
import { parsePublicRead, decodeCursor, encodePublicCursor, finishPublicVersion } from '../public-read';
import { projectPublicForecastRecords } from '../forecast';
import { createPublicCache } from '../public-cache';
import { publicRevision } from '../public-version';
import { CloudbaseRpc, CloudbaseRpcError } from './rpc';
import {createHash} from 'node:crypto';
import {parseCadencePublicProjection,publicCadenceEvaluation,type CadencePublicProjection} from '../cadence-public-projection';
import {RESET_CADENCE_MODEL_VERSION} from '../../lib/reset-cadence';

interface VersionData {
  digests: string[]; sources: Source[]; settings: Record<string,unknown>[];
  deadlines: {id:string;action:string;deadline:string}[];
  cases: {id:string;digest:string;w24:string;w48:string}[];
  snapshots: {id:string;until:string;generated:string}[]; outcomeDigest:string;
}
interface Bundle extends Pick<PublicData,'events'|'articles'|'publications'|'evidence'|'activities'|'notices'> {
  versionData:VersionData;site:PublicData['site']|null;
  page:{total:number;rows:{id:string;at:string;published:string}[]}|null;
  forecastRecords:{cases:ForecastCase[];snapshots:ForecastSnapshot[];outcomes:ForecastOutcome[];runtime?:(Partial<CadenceRuntime>&{status?:string})|null};
}
function validVersion(value:unknown):asserts value is VersionData {
  if(!value||typeof value!=='object')throw new CloudbaseRpcError('response');
  const row=value as VersionData;
  if(!Array.isArray(row.digests)||row.digests.length!==5||row.digests.some(d=>!/^[a-f0-9]{32}$/.test(d))||!/^[a-f0-9]{32}$/.test(row.outcomeDigest)||!['sources','settings','deadlines','cases','snapshots'].every(key=>Array.isArray((row as unknown as Record<string,unknown>)[key])))throw new CloudbaseRpcError('response');
}
export function cloudbasePublicVersion(value:unknown,timestamp:string) {
  validVersion(value);
  const expired=(time:string)=>Date.parse(time)<=Date.parse(timestamp);
  const settings=value.settings.map(p=>p.id==='site'?p:{id:p.id??undefined,status:p.status??undefined,cadenceSnapshotId:p.cadenceSnapshotId??undefined,cadenceSnapshotIds:p.cadenceSnapshotIds??undefined,cadenceEvaluationByKind:p.cadenceEvaluationByKind??undefined,cadenceProjectionDigest:p.cadenceProjectionDigest??undefined,...(p.referenceSignal?{referenceSignal:p.referenceSignal}:{}),...(p.referenceCadencePublic?{referenceCadencePublic:p.referenceCadencePublic,referenceExpired:expired(String((p.referenceCadencePublic as {validUntil?:unknown}).validUntil??''))}:{})});
  const parts:unknown[]=[...value.digests,settings,value.deadlines.map(row=>[row.id,row.action,expired(row.deadline)]),value.cases.map(row=>[row.id,row.digest,expired(row.w24),expired(row.w48)]),value.snapshots.map(row=>[row.id,expired(row.until),Date.parse(row.generated)>Date.parse(timestamp)]),value.outcomeDigest];
  return finishPublicVersion(parts,value.sources,timestamp);
}
function optionsForRpc(options:PublicReadOptions) {
  // Reuse the public API's validation even when invoked outside the HTTP route.
  const params=new URLSearchParams({view:options.view});
  for(const key of ['id','entity','version','filter','cursor','day'] as const)if(options[key]!==undefined)params.set(key,String(options[key]));
  for(const id of options.publications??[])params.append('publication',id);
  const parsed=parsePublicRead(params),cursor=decodeCursor(parsed.cursor,parsed);
  return {...parsed,cursor};
}
function pageFrom(bundle:Bundle,options:PublicReadOptions):PublicPage|undefined {
  if(options.view!=='history'&&options.view!=='news')return;
  const page=bundle.page;
  if(!page||!Number.isInteger(page.total)||page.total<0||!Array.isArray(page.rows)||page.rows.length>21||page.rows.some(row=>typeof row.id!=='string'||!Number.isFinite(Date.parse(row.at))||!Number.isFinite(Date.parse(row.published))))throw new CloudbaseRpcError('response');
  const visible=page.rows.slice(0,20),last=visible.at(-1);
  return {ids:visible.map(row=>row.id),total:page.total,nextCursor:page.rows.length>20&&last?encodePublicCursor({at:new Date(last.at).toISOString(),publishedAt:new Date(last.published).toISOString(),id:last.id,view:options.view,filter:options.filter??'all'}):null};
}
function response(bundle:Bundle,options:PublicReadOptions|{view:'legacy'},timestamp:string):PublicReadEnvelope {
  if(!bundle||!['events','articles','publications','evidence','activities','notices'].every(field=>Array.isArray((bundle as unknown as Record<string,unknown>)[field]))||!bundle.forecastRecords)throw new CloudbaseRpcError('response');
  const state=cloudbasePublicVersion(bundle.versionData,timestamp);
  const facts=projectPublicHistory({events:bundle.events,articles:bundle.articles,publications:bundle.publications,evidence:bundle.evidence,activities:bundle.activities,notices:bundle.notices,site:bundle.site??{name:'模钥重置雷达',description:options.view==='legacy'?'跟踪公开重置公告与重置卡动态':'',autoPublish:options.view==='legacy',version:1},sources:state.sources,serverTime:timestamp});
  const selected=new Set<string>();
  let data:PublicData={...facts};
  const page=options.view==='legacy'?undefined:pageFrom(bundle,options);
  if(options.view==='home'||options.view==='methodology'){
    const outlook=publicResetOutlook(facts);
    for(const id of [outlook.active?.publicationId,outlook.latestCompletion?.publicationId,outlook.lastResolved?.publicationId])if(id)selected.add(id);
    const actions=publicActions(facts).sort((a,b)=>Date.parse(b.action.statementAt)-Date.parse(a.action.statementAt));
    recentCompletedBenefits(facts).forEach(item=>selected.add(item.publication.id));
    for(const kind of ['automatic_reset','banked_reset'] as const){const item=actions.find(item=>item.action.kind===kind&&item.action.stage==='claimed_complete'&&Date.parse(item.action.statementAt)<=Date.parse(timestamp)&&Date.parse(item.publication.publishedAt)<=Date.parse(timestamp));if(item)selected.add(item.publication.id);}
    facts.articles.slice().sort((a,b)=>Date.parse(b.sourcePublishedAt||b.publishedAt)-Date.parse(a.sourcePublishedAt||a.publishedAt)).slice(0,3).forEach(a=>selected.add(a.publicationId));
  }else if(options.view==='calendar')publicActions(facts).forEach(item=>selected.add(item.publication.id));
  else facts.publications.forEach(p=>selected.add(p.id));
  if(options.view==='home'||options.view==='methodology'||options.view==='calendar'){
    const publications=facts.publications.filter(p=>selected.has(p.id));
    const eventIds=new Set(publications.map(p=>p.eventId)),articleIds=new Set(publications.map(p=>p.articleId));
    const evidenceIds=new Set(publications.flatMap(p=>[...p.article.evidenceIds,...p.event.evidenceIds,...p.event.actions.flatMap(a=>a.evidenceIds),...(p.article.contextEvidenceIds??[])]));
    data={...facts,publications,events:facts.events.filter(e=>eventIds.has(e.id)),articles:facts.articles.filter(a=>articleIds.has(a.id)),evidence:facts.evidence.filter(e=>evidenceIds.has(e.id))};
  }
  if(options.view==='state')data={...data,events:[],articles:[],publications:[],evidence:[],activities:[],notices:[]};
  if(page){const positions=new Map(page.ids.map((id,index)=>[id,index]));data.publications.sort((a,b)=>(positions.get(a.id)??0)-(positions.get(b.id)??0));data.articles.sort((a,b)=>(positions.get(a.publicationId)??0)-(positions.get(b.publicationId)??0));}
  if(options.view==='home'||options.view==='methodology'||options.view==='legacy'){
    const records=bundle.forecastRecords;
    if(!['cases','snapshots','outcomes'].every(field=>Array.isArray((records as unknown as Record<string,unknown>)[field])))throw new CloudbaseRpcError('response');
    const cadence=records.runtime?.cadenceSnapshotId?records.snapshots.find(s=>s.id===records.runtime?.cadenceSnapshotId) as unknown as StoredCadenceForecast|undefined:undefined;
    data.forecasts=projectPublicForecastRecords({...records,sources:bundle.versionData.sources,runtime:records.runtime??undefined,cadenceSnapshot:cadence},timestamp,facts,options.view==='home'?'home':options.view!=='legacy');
  }
  // Selection never rewrites the records or the frozen forecast rows.
  return {data:projectPublicHistory(data),version:state.version,contentVersion:state.contentVersion,...(page?{page}:{})};
}
const compatHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const has=(value:object,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
interface CompatibleRuntime extends Partial<CadenceRuntime> {id:'forecast_runtime';status:'ready';cadenceProjectionDigest:string;}
type CadenceReadFailure='RUNTIME_INVALID'|'COMPUTATION_FAILED'|'PROJECTION_INVALID'|'MODEL_MISMATCH'|'EVALUATION_INVALID'|'READ_RESPONSE_INVALID'|'RUNTIME_CHANGED'|'PUBLIC_VERSION_CHANGED'|'READ_TIMEOUT'|'READ_FAILED';
class CadenceReadError extends Error {
 constructor(readonly reason:CadenceReadFailure){super(reason);}
}
function compatibilityRuntime(value:unknown,timestamp:string):{runtime:CompatibleRuntime;projection:CadencePublicProjection} {
 if(!value||typeof value!=='object')throw new CadenceReadError('RUNTIME_INVALID');
 const row=value as CadenceRuntime&{status?:string};
 if(row.id!=='forecast_runtime')throw new CadenceReadError('RUNTIME_INVALID');
 if(row.status==='error')throw new CadenceReadError('COMPUTATION_FAILED');
 if(row.status!=='ready'||!Number.isFinite(Date.parse(row.checkedAt))||Date.parse(row.checkedAt)>Date.parse(timestamp))throw new CadenceReadError('RUNTIME_INVALID');
 const ids=row.cadenceSnapshotIds;
 if(!ids||!['automatic_reset','banked_reset'].every(target=>/^forecast_cadence_[a-f0-9]{64}$/.test(String(ids[target as keyof typeof ids])))||row.cadenceSnapshotId!==ids.automatic_reset)throw new CadenceReadError('RUNTIME_INVALID');
 let projection:CadencePublicProjection;
 try{projection=parseCadencePublicProjection(row.cadencePublicProjection,timestamp);}catch{throw new CadenceReadError('PROJECTION_INVALID');}
 for(const target of ['automatic_reset','banked_reset'] as const)if(!projection.snapshots.some(s=>s.id===ids[target]&&s.target===target&&s.modelVersion===RESET_CADENCE_MODEL_VERSION))throw new CadenceReadError('MODEL_MISMATCH');
 const evaluation=row.cadenceEvaluationByKind;
 if(!evaluation?.automatic_reset||!evaluation.banked_reset)throw new CadenceReadError('EVALUATION_INVALID');
 let cadenceEvaluationByKind:CompatibleRuntime['cadenceEvaluationByKind'];
 try{cadenceEvaluationByKind={automatic_reset:publicCadenceEvaluation(evaluation.automatic_reset),banked_reset:publicCadenceEvaluation(evaluation.banked_reset)};}catch{throw new CadenceReadError('EVALUATION_INVALID');}
 const publicSignal=row.referenceSignal?{id:row.referenceSignal.id,text:row.referenceSignal.text,publishedAt:row.referenceSignal.publishedAt,recordedAt:row.referenceSignal.recordedAt,sourceUrl:row.referenceSignal.sourceUrl,sourceName:row.referenceSignal.sourceName}:undefined;
 const runtime:CompatibleRuntime={id:'forecast_runtime',status:'ready',...(validatedReferenceReview(row.referenceReview)?{referenceReview:validatedReferenceReview(row.referenceReview)}:{}),...(publicSignal?{referenceSignal:publicSignal}:{}),...(row.referenceCadencePublic?{referenceCadencePublic:row.referenceCadencePublic}:{}),cadenceSnapshotId:ids.automatic_reset,cadenceSnapshotIds:{automatic_reset:ids.automatic_reset,banked_reset:ids.banked_reset},cadenceEvaluationByKind,cadenceProjectionDigest:projection.digest};
 return {runtime,projection};
}
/** Existing backend-only fixed-row read. Never list settings, commit, lease, or read credentials. */
async function readCompatibilityRuntime(rpc:CloudbaseRpc,timestamp:string,signal:AbortSignal) {
 if(signal.aborted)throw new CloudbaseRpcError('unknown',undefined,'REQUEST_TIMEOUT');
 const value=await rpc.call<{fingerprint?:unknown;rows?:unknown;more?:unknown;after?:unknown}>('radar_cb_store_read',{p_table:'settings',p_after:null,p_id:'forecast_runtime'},{signal});
 if(!value||typeof value.fingerprint!=='string'||!/^[a-f0-9]{32}$/.test(value.fingerprint)||!Array.isArray(value.rows)||value.rows.length!==1||value.more!==false||value.after!==null)throw new CadenceReadError('READ_RESPONSE_INVALID');
 const row=value.rows[0] as {id?:string;payload?:unknown;createdAt?:string};
 if(!row||row.id!=='forecast_runtime'||!Number.isFinite(Date.parse(row.createdAt??'')))throw new CadenceReadError('READ_RESPONSE_INVALID');
 // fingerprint describes the entire settings table, including unrelated heartbeats.
 // Consistency below compares the fixed prediction's validated public projection.
 return compatibilityRuntime(row.payload,timestamp);
}
function patchVersionRuntime(version:VersionData,runtime:Record<string,unknown>,projection?:CadencePublicProjection):VersionData {
 const snapshots=new Map(version.snapshots.map(s=>[s.id,s]));
 for(const s of projection?.snapshots??[])snapshots.set(s.id,{id:s.id,until:s.validUntil,generated:s.generatedAt});
 return {...version,settings:version.settings.map(row=>row.id==='forecast_runtime'?runtime:row),snapshots:[...snapshots.values()].sort((a,b)=>a.id.localeCompare(b.id))};
}
/** Old SQL installations are enriched only by already-authorized business reads.
 * At most THREE additional RPCs and one shared 1.5s budget per cached miss.
 * No retries or schema/control-plane calls; a slow prediction must never hold up facts. */
async function supplementLegacyProjection(rpc:CloudbaseRpc,version:VersionData,timestamp:string,bundle?:Bundle):Promise<{version:VersionData;bundle?:Bundle}> {
 validVersion(version);
 const original=version.settings.find(row=>row.id==='forecast_runtime');
 if(process.env.RADAR_STORAGE_BACKEND!=='cloudbase'||!original||has(original,'cadenceSnapshotIds'))return {version,bundle};
 if(original.status==='error')return {version,bundle};
 const unavailable=(reason:CadenceReadFailure,error?:unknown)=>{
  // Only fixed reason codes and the RPC's already-sanitized diagnostic code reach logs.
  console.warn('FORECAST_READ_UNAVAILABLE',reason,error instanceof CloudbaseRpcError?error.diagnosticCode:'');
  const runtime={id:'forecast_runtime',status:reason==='COMPUTATION_FAILED'?'error':'read_unavailable',cadenceSnapshotId:typeof original.cadenceSnapshotId==='string'?original.cadenceSnapshotId:undefined,cadenceSnapshotIds:{},cadenceProjectionDigest:'unavailable'};
  const next=patchVersionRuntime(version,runtime);
  return {version:next,...(bundle?{bundle:{...bundle,versionData:next,forecastRecords:{...bundle.forecastRecords,runtime}}}:{})};
 };
 const controller=new AbortController();
 let rejectDeadline!:(error:CloudbaseRpcError)=>void;
 const deadline=new Promise<never>((_,reject)=>{rejectDeadline=reject;});
 const timeout=setTimeout(()=>{controller.abort();rejectDeadline(new CloudbaseRpcError('unknown',undefined,'REQUEST_TIMEOUT'));},1500);
 try{return await Promise.race([deadline,(async()=>{
  const first=await readCompatibilityRuntime(rpc,timestamp,controller.signal);
  if(controller.signal.aborted)throw new CloudbaseRpcError('unknown',undefined,'REQUEST_TIMEOUT');
  if(first.runtime.cadenceSnapshotId!==original.cadenceSnapshotId||first.runtime.status!==original.status)return unavailable('RUNTIME_CHANGED');
  const [last,after]=await Promise.all([readCompatibilityRuntime(rpc,timestamp,controller.signal),rpc.call<VersionData>('radar_cb_public_version',{},{signal:controller.signal})]);
  if(controller.signal.aborted)throw new CloudbaseRpcError('unknown',undefined,'REQUEST_TIMEOUT');
  validVersion(after);
  if(compatHash(first.runtime)!==compatHash(last.runtime))return unavailable('RUNTIME_CHANGED');
  if(compatHash(version)!==compatHash(after))return unavailable('PUBLIC_VERSION_CHANGED');
  const next=patchVersionRuntime(version,first.runtime as unknown as Record<string,unknown>,first.projection);
  if(!bundle)return {version:next};
  const snapshots=new Map(first.projection.snapshots.map(s=>[s.id,s as unknown as ForecastSnapshot]));
  for(const s of bundle.forecastRecords.snapshots)snapshots.set(s.id,s);
  const outcomes=new Map(first.projection.horizonOutcomes.map(o=>[o.id,o as unknown as ForecastOutcome]));
  for(const o of bundle.forecastRecords.outcomes)outcomes.set(o.id,o);
  return {version:next,bundle:{...bundle,versionData:next,forecastRecords:{...bundle.forecastRecords,snapshots:[...snapshots.values()],outcomes:[...outcomes.values()],runtime:first.runtime}}};
 })()]);}catch(error){return unavailable(error instanceof CadenceReadError?error.reason:controller.signal.aborted?'READ_TIMEOUT':'READ_FAILED',error);}finally{controller.abort();clearTimeout(timeout);}
}
async function compatibleBundle(rpc:CloudbaseRpc,options:Record<string,unknown>,timestamp:string):Promise<Bundle> {
 const bundle=await rpc.call<Bundle>('radar_cb_public_bundle',{p_options:options,p_now:timestamp});
 if(!bundle?.forecastRecords)throw new CloudbaseRpcError('response');
 return (await supplementLegacyProjection(rpc,bundle.versionData,timestamp,bundle)).bundle!;
}
const readers=new WeakMap<CloudbaseRpc,ReturnType<typeof factory>>();
function factory(rpc:CloudbaseRpc,clock:()=>string) {
  const cache=createPublicCache();
  async function read(options:PublicReadOptions):Promise<PublicReadEnvelope> {
    const parsed=optionsForRpc(options),key=JSON.stringify(parsed);
    const result=await cache(key,async()=>{const now=clock(),bundle=await compatibleBundle(rpc,parsed,now);return response(bundle,options,now);});
    return {...result,data:{...result.data,serverTime:clock()}};
  }
  return {read,version:()=>cache('version',async()=>{const state=cloudbasePublicVersion((await supplementLegacyProjection(rpc,await rpc.call<VersionData>('radar_cb_public_version'),clock())).version,clock());return {version:state.version,contentVersion:state.contentVersion};}),
    legacyVersion:()=>cache('legacy-version',async()=>{const now=clock(),bundle=await compatibleBundle(rpc,{view:'methodology'},now);const data=response(bundle,{view:'methodology'},now).data;return publicRevision({...data,publications:bundle.publications});}),
    legacy:()=>cache('legacy',async()=>{const now=clock();return response(await compatibleBundle(rpc,{view:'legacy'},now),{view:'legacy'},now).data;}),
    snapshot:async(id:string)=>{if(!/^(forecast_snapshot_|forecast_cadence_)[a-f0-9]{64}$/.test(id))return;return (await rpc.call<ForecastSnapshot|null>('radar_cb_forecast_snapshot',{p_id:id}))??undefined;}};
}
export function createCloudbasePublicReader(rpc:CloudbaseRpc,clock?:()=>string) {
  if(clock)return factory(rpc,clock);
  let reader=readers.get(rpc);if(!reader){reader=factory(rpc,()=>new Date().toISOString());readers.set(rpc,reader);}return reader;
}
