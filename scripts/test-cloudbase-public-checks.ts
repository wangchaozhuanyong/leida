import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { CloudbaseRpc,CloudbaseRpcError } from '../src/server/cloudbase/rpc';
import { createCloudbasePublicReader } from '../src/server/cloudbase/public-read';
import { readPublicVersion,getPublicRead } from '../src/server/public-read';
import { publicRevision } from '../src/server/public-version';
import { getPublicData } from '../src/server/service';
import type { Evidence,Article,RadarEvent,Publication,Source,PublicData } from '../src/lib/types';
import type { PublicReadOptions } from '../src/lib/public-read';
import {buildForecastSnapshot,type ForecastCase} from '../src/lib/forecast';

export async function testCloudbasePublic(pool:pg.Pool,rpc:CloudbaseRpc,pass:(name:string,detail:string)=>void,countCalls:()=>number,gateway:{baseURL:string;token:string}) {
  const schema=await readFile(new URL('./migrations/cloudbase-public-schema.sql',import.meta.url),'utf8');
  const functions=await readFile(new URL('./migrations/cloudbase-public-read.sql',import.meta.url),'utf8');
  // Reproduce the real platform's automatic new-table write grants.
  await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role');
  await pool.query(schema);await pool.query(functions);
  const privileged=(await pool.query("SELECT count(*)::integer AS writes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('radar_evidence','radar_events','radar_articles','radar_publications','radar_sources','radar_notices','radar_activities','radar_settings','radar_forecast_cases','radar_forecast_snapshots','radar_forecast_outcomes') AND has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE')")).rows[0].writes;
  assert.equal(privileged,0,'new public tables must revoke the platform default write grants');
  const at=new Date().toISOString(),source:Source={id:'public-qa-source',name:'公开测试来源',kind:'status',url:'https://status.openai.com',enabled:true,validated:true,intervalMinutes:2,version:1,status:'healthy',lastSuccessAt:at};
  const privateCanary=randomBytes(24).toString('hex');
  const seed=await pool.connect();
  const put=async(table:string,payload:{id:string})=>{await seed.query(`INSERT INTO public.radar_${table}(id,payload) VALUES($1,$2)`,[payload.id,JSON.stringify(payload)]);};
  try{
    await seed.query('BEGIN');await put('sources',source);
    await put('settings',{id:'site',name:'模钥重置雷达 QA',description:'公开接口对比',version:4,autoPublish:false} as {id:string});
    await put('settings',{id:'private-config',value:privateCanary} as {id:string});
    for(let i=0;i<45;i++){
      const index=String(i).padStart(3,'0'),time=new Date(Date.parse(at)-(i+1)*3600_000).toISOString();
      const evidence:Evidence={id:`public-qa-evidence-${index}`,sourceId:source.id,messageId:`message-${index}`,url:`https://example.org/${index}`,text:'公开原文'.repeat(150),publishedAt:time,collectedAt:time,hash:`hash-${index}`,contextComplete:true,historical:false,provenance:'official'};
      const action={id:`action-${index}`,kind:i%2?'banked_reset' as const:'automatic_reset' as const,stage:i===0?'promised' as const:'claimed_complete' as const,scope:'public' as const,eligibility:'公开公告所述用户',evidenceIds:[evidence.id],statementAt:time,...(i===0?{expectedAt:new Date(Date.parse(at)+3600_000).toISOString()}:{}),evidenceQuote:'公开原文'};
      const event:RadarEvent={id:`public-qa-event-${index}`,title:`动态 ${index}`,version:1,status:i===6?'merged':i===5?'withdrawn':'published',...(i===6?{mergedInto:'public-qa-event-004'}:{}),actions:[action],evidenceIds:[evidence.id],publicationId:`public-qa-publication-${index}`,updatedAt:time};
      const article:Article={id:`public-qa-article-${index}`,eventId:event.id,title:`公告 ${index}`,summary:'公开摘要'.repeat(300),translation:'公开中文正文'.repeat(150),category:i%3===0?'product':i%3===1?'reset':'activity',version:1,status:i===5?'withdrawn':'published',publicationId:event.publicationId,evidenceIds:[evidence.id],publishedAt:time,sourcePublishedAt:time,updatedAt:time};
      const publication:Publication={id:event.publicationId,eventId:event.id,articleId:article.id,event,article,cutoffAt:time,publishedAt:time,reason:'QA公开固定版本'};
      await put('evidence',evidence);await put('events',event);await put('articles',article);await put('publications',publication);
      if(i===8){const news={...publication,id:'public-qa-newer-news',mode:'news_only' as const,publishedAt:at,article:{...article,id:'public-qa-newer-article',publicationId:'public-qa-newer-news',publishedAt:at,category:'product' as const},articleId:'public-qa-newer-article'};await put('publications',news);await put('articles',news.article);await seed.query("UPDATE public.radar_events SET payload=jsonb_set(payload,'{publicationId}',to_jsonb($2::text)) WHERE id=$1",[event.id,news.id]);}
    }
    const unpublished:Evidence={id:'public-qa-unpublished',sourceId:source.id,messageId:'unpublished',text:privateCanary,url:'https://example.org/private',publishedAt:at,collectedAt:at,hash:'private-canary',contextComplete:true,historical:false,provenance:'official'};await put('evidence',unpublished);
    await put('activities',{id:'public-qa-activity',title:'28 天测试',timezone:'America/Los_Angeles',startsOn:'2026-10-05',days:28,rules:'公开进度',version:1,items:[{day:1,articleId:'public-qa-article-002',eventId:'public-qa-event-002'}]} as {id:string});
    await put('notices',{id:'public-qa-notice',eventId:'public-qa-event-001',publicationId:'public-qa-publication-001',semanticKey:'public-qa-notice',title:'公开结果',summary:'公开状态',categories:['result'],status:'active',createdAt:at} as {id:string});
    const snapshotId='forecast_snapshot_'+'a'.repeat(64),caseId='public-qa-case';
    const forecastCase:ForecastCase={id:caseId,identity:'public-qa-signal',sourceId:source.id,title:'公开测试信号',url:'https://status.openai.com',target:'automatic_reset',signalEvidenceIds:['public-qa-evidence-000'],signalAt:at,collectedAt:at,windows:{24:new Date(Date.parse(at)+86400_000).toISOString(),48:new Date(Date.parse(at)+172800_000).toISOString()},status:'watching',coverage:{status:'unverified',sourceIds:[source.id],reason:'测试'},late:false,snapshotId,createdAt:at,updatedAt:at};
    await put('forecast_cases',forecastCase);
    await put('forecast_snapshots',{...buildForecastSnapshot({id:snapshotId,signature:'qa-frozen-snapshot',case:forecastCase,generatedAt:at,evidenceCutoffAt:at,cases:[forecastCase],outcomes:[]}),trainingObservationIds:['training-qa']} as {id:string});
    await seed.query('COMMIT');
  }catch(error){await seed.query('ROLLBACK');throw error;}finally{seed.release();}
  pass('public_empty_schema_and_read_permissions','eleven new read-only tables and three STABLE backend RPC functions installed in disposable PostgreSQL');

  const direct=await pool.connect();
  try{await direct.query('BEGIN');await direct.query('SET LOCAL ROLE service_role');await direct.query("SELECT set_config('request.jwt.claims',$1,true)",['{"role":"service_role"}']);await assert.rejects(direct.query("INSERT INTO public.radar_events(id,payload) VALUES('forbidden','{}')"),error=>(error as {code?:string}).code==='42501');await direct.query('ROLLBACK');}finally{direct.release();}
  const volatility=(await pool.query("SELECT provolatile FROM pg_proc WHERE proname IN ('radar_cb_public_version','radar_cb_public_bundle','radar_cb_forecast_snapshot')")).rows;assert.equal(volatility.length,3);assert.ok(volatility.every(row=>row.provolatile==='s'));
  pass('public_no_writes_and_single_snapshot','service role cannot insert through public reader grants; all three reads use STABLE single-statement snapshots');
  const canonical=(value:unknown):unknown=>{
    if(Array.isArray(value)){const items=value.map(canonical);return items.every(v=>v&&typeof v==='object'&&'id'in v)?items.sort((a,b)=>String((a as {id:string}).id).localeCompare(String((b as {id:string}).id))):items;}
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='serverTime'&&key!=='generatedAt').map(([key,v])=>[key,canonical(v)]));
    return value;
  };
  const views:PublicReadOptions[]=[{view:'home'},{view:'methodology'},{view:'calendar'},{view:'state'},{view:'history',filter:'all'},{view:'history',filter:'banked_reset'},{view:'news',filter:'all'},{view:'news',filter:'product'},{view:'detail',entity:'events',id:'public-qa-event-006'},{view:'detail',entity:'articles',id:'public-qa-article-001'},{view:'detail',entity:'sources',id:'public-qa-evidence-001'},{view:'detail',entity:'publications',id:'public-qa-publication-008'},{view:'activity',id:'public-qa-activity',day:1,publications:['public-qa-publication-002']},{view:'notices'}];
  const differences=(a:unknown,b:unknown,prefix='root'):string[]=>{if(JSON.stringify(a)===JSON.stringify(b))return [];if(a&&b&&typeof a==='object'&&typeof b==='object')return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(key=>differences((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key],prefix+'.'+key)).slice(0,12);return [prefix];};
  const nativeModule=await import('../src/db');
  for(const view of views){
    console.log('PUBLIC_SCOPE',view.view,view.entity??view.filter??'');
    const native=await getPublicRead(view),clock=()=>native.data.forecasts?.generatedAt??native.data.serverTime;
    const reader=createCloudbasePublicReader(rpc,clock),cloud=await reader.read(view);
    const paths=differences(canonical(cloud),canonical(native));if(paths.length)console.error('PARITY_FIELDS',view.view,view.entity??'',paths.join(','));
    assert.deepEqual(canonical(cloud),canonical(native),`public scope parity: ${view.view}/${view.entity??''}/${view.filter??''}`);
    assert.ok(!JSON.stringify(cloud).includes(privateCanary),'private config or unreferenced evidence must never cross public response');
    if(view.view==='home')assert.ok(Buffer.byteLength(JSON.stringify(cloud))<100*1024,'home public response must stay below 100 KiB');
    if(view.view==='history'||view.view==='news'){assert.deepEqual(cloud.page?.ids,native.page?.ids);assert.deepEqual(cloud.data.publications.map(p=>p.id),native.data.publications.map(p=>p.id));}
  }
  pass('fourteen_native_cloud_scope_parities','home/forecast/calendar/state/history/news/details/merge/activity/notices match current native API; home under 100 KiB; private canaries absent');
  const now=new Date().toISOString(),version=await readPublicVersion(nativeModule.pool,now);
  const cloudVersion=await createCloudbasePublicReader(rpc,()=>now).version();assert.deepEqual(cloudVersion,{version:version.version,contentVersion:version.contentVersion});
  const nativeData=await getPublicData(),cloudData=await createCloudbasePublicReader(rpc,()=>nativeData.forecasts?.generatedAt??nativeData.serverTime).legacy();assert.deepEqual(canonical(cloudData),canonical(nativeData));
  assert.equal(await createCloudbasePublicReader(rpc,()=>nativeData.forecasts?.generatedAt??nativeData.serverTime).legacyVersion(),publicRevision(nativeData));
  pass('light_and_legacy_version_parities','light hashes and legacy bootstrap/version remain coherent; no forced-refresh compatibility loop');
  const bursts=createCloudbasePublicReader(rpc,()=>now),beforeBurst=countCalls();
  const concurrent=await Promise.all(Array.from({length:100},()=>bursts.read({view:'home'})));
  assert.equal(countCalls()-beforeBurst,1);assert.equal(new Set(concurrent.map(r=>r.version)).size,1);
  pass('hundred_public_reads_share_one_rpc','100 simultaneous backend summary reads share one controlled RPC; this is not a real cloud user-capacity claim');

  for(const view of ['history','news'] as const){
    const reader=createCloudbasePublicReader(rpc,()=>now),ids:string[]=[];let cursor:string|undefined,total=0;
    for(let page=0;page<5;page++){const cloud=await reader.read({view,filter:'all',cursor});total=cloud.page!.total;assert.ok(cloud.page!.ids.length<=20);ids.push(...cloud.page!.ids);if(!cloud.page!.nextCursor)break;cursor=cloud.page!.nextCursor;}
    assert.equal(ids.length,total);assert.equal(new Set(ids).size,total);
  }
  pass('real_sql_cursor_pagination','SQL selects 21-row boundary for 20-row pages; all history/news records read without overlap or omission');
  const fixed=await createCloudbasePublicReader(rpc,()=>now).snapshot('forecast_snapshot_'+'a'.repeat(64));assert.deepEqual((fixed as unknown as {trainingObservationIds:string[]}).trainingObservationIds,['training-qa']);
  assert.equal(await createCloudbasePublicReader(rpc,()=>now).snapshot('not-a-frozen-id'),undefined);
  pass('fixed_snapshot_preserved','detailed immutable forecast payload remains accessible only by a validated fixed id; summary never substitutes for original');
  const before=(await pool.query("SELECT md5(string_agg(id||payload::text,',' ORDER BY id)) AS hash FROM radar_publications")).rows[0].hash;
  for(const table of ['evidence','publications','forecast_snapshots'])await assert.rejects(pool.query(`UPDATE radar_${table} SET payload=payload`),error=>error instanceof Error&&error.message==='immutable record');
  const clockReader=createCloudbasePublicReader(rpc,()=>now);
  await assert.rejects(clockReader.read({view:'history',filter:'all',cursor:Buffer.from(JSON.stringify({view:'news',filter:'all',at:now,publishedAt:now,id:'one'})).toString('base64url')}));
  assert.equal((await pool.query("SELECT md5(string_agg(id||payload::text,',' ORDER BY id)) AS hash FROM radar_publications")).rows[0].hash,before);
  pass('readonly_invalid_scope_and_frozen_rows','cross-view cursor rejected; public reads leave immutable publication bytes unchanged');
  const firstVersion=await createCloudbasePublicReader(rpc,()=>now).version();
  await pool.query("UPDATE public.radar_sources SET payload=jsonb_set(payload,'{lastSuccessAt}',to_jsonb($2::text)) WHERE id=$1",[source.id,new Date(Date.parse(now)-15000).toISOString()]);
  const timeVersion=await createCloudbasePublicReader(rpc,()=>now).version();assert.equal(timeVersion.contentVersion,firstVersion.contentVersion);assert.notEqual(timeVersion.version,firstVersion.version);
  await pool.query("UPDATE public.radar_sources SET payload=jsonb_set(payload,'{status}','\"failed\"'::jsonb) WHERE id=$1",[source.id]);
  const faultVersion=await createCloudbasePublicReader(rpc,()=>now).version();assert.notEqual(faultVersion.contentVersion,timeVersion.contentVersion);
  pass('source_state_and_content_versions','collection timestamp updates state only; source failure invalidates factual/forecast content version');
  const originalFetch=globalThis.fetch,configuration=['RADAR_PUBLIC_READ_BACKEND','CLOUDBASE_ENV_ID','CLOUDBASE_API_KEY'] as const;
  const previous=Object.fromEntries(configuration.map(key=>[key,process.env[key]]));
  try{
    globalThis.fetch=(input,init)=>{const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);return originalFetch(target.hostname==='leida-test-qa.api.tcloudbasegateway.com'?gateway.baseURL+target.pathname:input,init);};
    Object.assign(process.env,{RADAR_PUBLIC_READ_BACKEND:'cloudbase',CLOUDBASE_ENV_ID:'leida-test-qa',CLOUDBASE_API_KEY:gateway.token});
    const {GET}=await import('../src/app/api/v1/[...path]/route');
    const call=(path:string[],query='',headers?:Record<string,string>)=>GET(new Request(gateway.baseURL+'/api/v1/'+path.join('/')+query,{headers}),{params:Promise.resolve({path})});
    const first=await call(['version'],'?light=1');assert.equal(first.status,200);const etag=first.headers.get('etag');assert.ok(etag);
    assert.equal((await call(['version'],'?light=1',{'if-none-match':etag})).status,304);
    for(const [path,query] of [[['bootstrap'],'?view=home'],[['status'],'?view=history&filter=all'],[['bootstrap'],''],[['health'],''],[['forecasts','forecast_snapshot_'+'a'.repeat(64)],'']] as [string[],string][]){assert.equal((await call(path,query)).status,200);}
    assert.equal((await call(['bootstrap'],'?view=detail&id=one&entity=settings')).status,400);
    assert.equal((await call(['forecasts','forecast_snapshot_'+'f'.repeat(64)])).status,404);
    pass('actual_public_api_routes','actual GET handlers pass configured CloudBase bootstrap/history/legacy/health/fixed snapshot, ETag 304, invalid input 400 and missing snapshot 404');
  }finally{globalThis.fetch=originalFetch;for(const key of configuration){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
  return {sourceAt:at};
}
