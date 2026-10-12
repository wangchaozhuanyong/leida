// Retained, isolated database proof. No collector, AI request or WeChat send runs here.
import 'dotenv/config';
import pg from 'pg';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..'),output=resolve(root,'outputs/implementation-qa/reset-cadence-isolated-20261011.json');
const url=new URL(process.env.DATABASE_URL!);
if(url.hostname!=='127.0.0.1'||url.port!=='55489'||url.pathname!=='/radar')throw new Error('只允许本项目本机配置创建隔离验收库');
const database=`radar_qa_reset_cadence_${Date.now()}_${randomBytes(3).toString('hex')}`;
const admin=new pg.Pool({connectionString:url.href});
await admin.query(`CREATE DATABASE "${database}"`);await admin.end();url.pathname='/'+database;
process.env.DATABASE_URL=url.href;
for(const script of ['scripts/migrate.ts','scripts/migrations/forecast.ts']){
 const result=spawnSync('pnpm',['exec','tsx',script,...(script.includes('/migrations/')?['--apply']:[])],{cwd:root,env:{...process.env},encoding:'utf8'});
 if(result.status!==0)throw new Error('隔离验收结构初始化失败');
}
const {pool,put,insert,list,one,transaction}=await import('../src/db');
const {runForecastCycle,getPublicForecast,getResetCadenceSnapshot}=await import('../src/server/forecast');
const {createEvidence,queueJob}=await import('../src/server/service');
const {runOne}=await import('../src/server/worker');
type Evidence=import('../src/lib/types').Evidence;
type Article=import('../src/lib/types').Article;
type RadarEvent=import('../src/lib/types').RadarEvent;
type Publication=import('../src/lib/types').Publication;
const checks:Record<string,boolean>={};
const origin='2026-10-10T00:00:00.000Z',base=Date.parse(origin),source={id:'reset-archive',name:'合成验收来源',kind:'archive' as const,url:'https://codex-resets.com/zh-CN',enabled:true,validated:true,status:'healthy' as const,intervalMinutes:5,version:1,lastSuccessAt:origin};
try{
 assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,database);
 await put('sources',source);
 const evidence=(n:number,at:string)=>({id:`qa-cadence-${n}`,sourceId:source.id,messageId:`21000000000000000${String(n).padStart(2,'0')}`,url:`https://x.com/thsottiaux/status/21000000000000000${String(n).padStart(2,'0')}`,text:'We have reset Codex usage limits for all users.',textOrigin:'original' as const,provenance:'archive' as const,publishedAt:at,collectedAt:origin,hash:`qa-only-${n}`,contextComplete:true,historical:true,metadata:{category:'reset' as const,sourceGroup:'codex-resets'}});
 for(let n=0;n<13;n++)await insert('evidence',evidence(n,new Date(base-12*3600_000-(12-n)*48*3600_000).toISOString()));
 const result=await runForecastCycle(origin),first=(await getPublicForecast(undefined,origin)).cadence!;
 checks.executed=result.cadenceSnapshots===1&&first.status==='ready'&&first.sampleCount===12;
 checks.realCalculation=first.p24===0&&first.p48===1&&first.backtest.tests===4;
 const fixed=await getResetCadenceSnapshot(first.id);assert.ok(fixed);
 const later=new Date(base+30_000).toISOString(),repeat=await runForecastCycle(later,{force:true});
 checks.idempotent=repeat.cadenceSnapshots===0&&(await getPublicForecast(undefined,later)).cadence?.id===first.id;
 checks.fixed=JSON.stringify(await getResetCadenceSnapshot(first.id))===JSON.stringify(fixed);
 const futureAt=new Date(base+72*3600_000).toISOString();
 await put('sources',{...source,lastSuccessAt:futureAt});await insert('evidence',{...evidence(20,futureAt),collectedAt:futureAt,historical:false});
 const next=await runForecastCycle(futureAt),view=await getPublicForecast(undefined,futureAt);
 checks.observedSeparately=next.cadenceOutcomes===1&&view.cadenceOutcomes?.[0]?.snapshotId===first.id&&view.cadenceOutcomes[0].inWindow===false;
 checks.frozenAfterOutcome=JSON.stringify(await getResetCadenceSnapshot(first.id))===JSON.stringify(fixed);
 const pauseAt=new Date(base+72*3600_000+2*60_000).toISOString();await put('sources',{...source,lastSuccessAt:futureAt,enabled:false,status:'paused'});await runForecastCycle(pauseAt);
 const paused=(await getPublicForecast(undefined,pauseAt)).cadence!;
 checks.pauseHidesEstimate=paused.status==='paused'&&paused.p24===null&&paused.predictedAt===null;
 checks.noBenefitMutation=(await list('events')).length===0&&(await list('articles')).length===0&&(await list('publications')).length===0&&(await list('notices')).length===0;
 await assert.rejects(pool.query('UPDATE radar_forecast_snapshots SET payload=payload WHERE id=$1',[first.id]),/immutable forecast/);
 checks.immutableDatabase=true;
 // Replay the real two-step collection gap without network or AI: a bare
 // completion first becomes news, then its explicit original parent is saved.
 const liveAt=new Date().toISOString(),parentAt=new Date(Date.now()-60_000).toISOString();
 await put('sources',{...source,lastSuccessAt:liveAt,enabled:true,status:'healthy'});
 const input:Omit<Evidence,'id'|'hash'>={sourceId:source.id,messageId:'2109132167112782291',url:'https://x.com/thsottiaux/status/2109132167112782291',text:'Put the reset in the bag. All propagated. https://t.co/HGxaD3Zdcj',textOrigin:'original',provenance:'archive',publishedAt:liveAt,collectedAt:liveAt,contextComplete:false,historical:false,metadata:{summary:'重置已完成，全部传播。',category:'reset',sourceGroup:'codex-resets'}};
 let aiCalls=0;
 const process=()=>runOne({schedule:false,allowTemplates:true,enrich:async()=>undefined,enrichQuoted:async()=>[],generate:async()=>{aiCalls++;throw new Error('隔离验收不允许AI调用');}});
 const queued=async(candidate:NonNullable<Awaited<ReturnType<typeof createEvidence>>['candidate']>)=>transaction(c=>queueJob('generate',{candidateId:candidate.id,automatic:true,expectedVersion:candidate.version},c));
 const bare=await createEvidence(input);assert.ok(bare.candidate);await queued(bare.candidate);await process();
 const oldArticle=(await list<Article>('articles')).find(article=>article.evidenceIds[0]===bare.evidence.id)!;assert.equal(oldArticle.publicationMode,'news_only');
 const oldPublication=await one<Publication>('publications',oldArticle.publicationId),frozenNews=JSON.stringify(oldPublication);
 const parent=await createEvidence({...input,messageId:'2109045392684032299',url:'https://x.com/thsottiaux/status/2109045392684032299',text:'Global reset by EOD. May the tokens do good things for you.',publishedAt:parentAt,contextComplete:true,metadata:{category:'reset',sourceGroup:'codex-resets',scheduledReset:{kind:'automatic_reset',expectedAt:new Date(Date.now()+3*3600_000).toISOString(),sourceUrl:'https://codex-resets.com/zh-CN'}}});
 assert.ok(parent.candidate);await queued(parent.candidate);await process();
 const parentArticle=(await list<Article>('articles')).find(article=>article.evidenceIds[0]===parent.evidence.id)!;assert.equal(parentArticle.publicationMode,'state_change');
 const joined=await createEvidence({...input,parentId:parent.evidence.messageId,collectedAt:new Date().toISOString()});assert.ok(joined.candidate);await queued(joined.candidate);await process();
 const upgraded=await one<Article>('articles',oldArticle.id),target=await one<RadarEvent>('events',parentArticle.eventId),shell=await one<RadarEvent>('events',oldArticle.eventId);
 checks.newsContextUpgrade=upgraded?.eventId===parentArticle.eventId&&upgraded.publicationMode==='state_change'&&upgraded.version===oldArticle.version+1;
 checks.newsShellMerged=shell?.status==='merged'&&shell.mergedInto===parentArticle.eventId;
 checks.newsPublicationPreserved=JSON.stringify(await one<Publication>('publications',oldArticle.publicationId))===frozenNews;
 checks.confirmationClosesPromise=target?.actions.length===1&&target.actions[0].stage==='claimed_complete'&&target.actions[0].statementAt===liveAt&&aiCalls===0;
 assert.ok(Object.values(checks).every(Boolean),JSON.stringify(checks));
 const report={database,retained:true,contains:'isolated synthetic QA only',checkedAt:new Date().toISOString(),checks,pass:Object.values(checks).every(Boolean),collectorCalls:0,aiCalls:0,wechatSends:0};
 writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,checks:Object.keys(checks).length,report:output}));assert.equal(report.pass,true);
}finally{await pool.end();}
