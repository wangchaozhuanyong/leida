import type { PublicData, Source } from '../../lib/types';
import type { PublicReadOptions, PublicReadEnvelope, PublicPage } from '../../lib/public-read';
import type { ForecastCase, ForecastOutcome, ForecastSnapshot } from '../../lib/forecast';
import type { StoredCadenceForecast } from '../reset-cadence-runtime';
import { projectPublicHistory } from '../../lib/history';
import { publicResetOutlook } from '../../lib/reset-outlook';
import { publicActions } from '../../lib/public-facts';
import { parsePublicRead, decodeCursor, encodePublicCursor, finishPublicVersion } from '../public-read';
import { projectPublicForecastRecords } from '../forecast';
import { createPublicCache } from '../public-cache';
import { publicRevision } from '../public-version';
import { CloudbaseRpc, CloudbaseRpcError } from './rpc';

interface VersionData {
  digests: string[]; sources: Source[]; settings: Record<string,unknown>[];
  deadlines: {id:string;action:string;deadline:string}[];
  cases: {id:string;digest:string;w24:string;w48:string}[];
  snapshots: {id:string;until:string;generated:string}[]; outcomeDigest:string;
}
interface Bundle extends Pick<PublicData,'events'|'articles'|'publications'|'evidence'|'activities'|'notices'> {
  versionData:VersionData;site:PublicData['site']|null;
  page:{total:number;rows:{id:string;at:string;published:string}[]}|null;
  forecastRecords:{cases:ForecastCase[];snapshots:ForecastSnapshot[];outcomes:ForecastOutcome[];runtime?:{status?:string;cadenceSnapshotId?:string}|null};
}
function validVersion(value:unknown):asserts value is VersionData {
  if(!value||typeof value!=='object')throw new CloudbaseRpcError('response');
  const row=value as VersionData;
  if(!Array.isArray(row.digests)||row.digests.length!==5||row.digests.some(d=>!/^[a-f0-9]{32}$/.test(d))||!/^[a-f0-9]{32}$/.test(row.outcomeDigest)||!['sources','settings','deadlines','cases','snapshots'].every(key=>Array.isArray((row as unknown as Record<string,unknown>)[key])))throw new CloudbaseRpcError('response');
}
export function cloudbasePublicVersion(value:unknown,timestamp:string) {
  validVersion(value);
  const expired=(time:string)=>Date.parse(time)<=Date.parse(timestamp);
  const settings=value.settings.map(p=>p.id==='site'?p:{id:p.id??undefined,status:p.status??undefined,cadenceSnapshotId:p.cadenceSnapshotId??undefined});
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
const readers=new WeakMap<CloudbaseRpc,ReturnType<typeof factory>>();
function factory(rpc:CloudbaseRpc,clock:()=>string) {
  const cache=createPublicCache();
  async function read(options:PublicReadOptions):Promise<PublicReadEnvelope> {
    const parsed=optionsForRpc(options),key=JSON.stringify(parsed);
    const result=await cache(key,async()=>{const now=clock(),bundle=await rpc.call<Bundle>('radar_cb_public_bundle',{p_options:parsed,p_now:now});return response(bundle,options,now);});
    return {...result,data:{...result.data,serverTime:clock()}};
  }
  return {read,version:()=>cache('version',async()=>{const state=cloudbasePublicVersion(await rpc.call('radar_cb_public_version'),clock());return {version:state.version,contentVersion:state.contentVersion};}),
    legacyVersion:()=>cache('legacy-version',async()=>{const now=clock(),bundle=await rpc.call<Bundle>('radar_cb_public_bundle',{p_options:{view:'methodology'},p_now:now});const data=response(bundle,{view:'methodology'},now).data;return publicRevision({...data,publications:bundle.publications});}),
    legacy:()=>cache('legacy',async()=>{const now=clock();return response(await rpc.call('radar_cb_public_bundle',{p_options:{view:'legacy'},p_now:now}),{view:'legacy'},now).data;}),
    snapshot:async(id:string)=>{if(!/^(forecast_snapshot_|forecast_cadence_)[a-f0-9]{64}$/.test(id))return;return (await rpc.call<ForecastSnapshot|null>('radar_cb_forecast_snapshot',{p_id:id}))??undefined;}};
}
export function createCloudbasePublicReader(rpc:CloudbaseRpc,clock?:()=>string) {
  if(clock)return factory(rpc,clock);
  let reader=readers.get(rpc);if(!reader){reader=factory(rpc,()=>new Date().toISOString());readers.set(rpc,reader);}return reader;
}
