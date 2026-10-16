import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {pool,list,one,put} from '../src/db';
import {defaultAI} from '../src/server/ai';
import {createEvidence,getPublicData} from '../src/server/service';
import {runOne,scheduleDue} from '../src/server/worker';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {gatherEvidenceContext} from '../src/server/source-context';
import {publicActions} from '../src/lib/public-facts';
import {posterSvg} from '../src/server/poster';
import type {Evidence,Candidate,Source,Job,RadarEvent,Article,Publication,Notice,DraftContent} from '../src/lib/types';

const root=fileURLToPath(new URL('../',import.meta.url));
const reportName=process.env.RADAR_REPLAY_REPORT??'history-repair-worker-20261010.json';
assert.match(reportName,/^history-repair-worker-[\w-]+\.json$/,'回放输出限于本项目验收目录，不能覆盖旧报告');
const reportPath=fileURLToPath(new URL('../outputs/implementation-qa/'+reportName,import.meta.url));
type HistoricalInput=Pick<Evidence,'messageId'|'url'|'text'|'publishedAt'|'collectedAt'|'contextComplete'|'textOrigin'|'metadata'|'parentId'|'provenance'>;
interface ReplayReport {database:string;startedAt:string;finishedAt?:string;scope:string;sourceSnapshot:{readAt:string;publicEvidenceCount:number;inputKind:string;evidence:HistoricalInput[]};scenarios:Record<string,unknown>[];totals?:Record<string,unknown>;safety:Record<string,unknown>;status?:string;testSummary?:Record<string,unknown>;runner?:Record<string,unknown>;}
function write(report:ReplayReport) {writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');}

/** Reuse the project runner's isolation gates, without occupying the HTTP QA port. */
async function isolatedRun() {
  const value=process.env.DATABASE_URL;assert.ok(value,'仅使用本项目已有本机数据库配置');const url=new URL(value);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55489');assert.equal(url.pathname,'/radar','协调器只从本项目本机默认库创建隔离库');
  if(existsSync(reportPath))throw new Error('已有同名历史回放报告，请先保留旧报告再重新指定输出；不会覆盖');
  const response=await fetch('http://127.0.0.1:5190/api/v1/bootstrap',{signal:AbortSignal.timeout(10000)});assert.ok(response.ok,'必须取得已有本机公开证据，不以自编文本代替真实历史');
  const publicData=await response.json();
  const samples=JSON.parse(readFileSync(new URL('../outputs/implementation-qa/history-evidence-samples-20261010.json',import.meta.url),'utf8')).samples as {evidence:Evidence;expected:{kind:string;stage:string}[]}[];
  const historical=samples.filter(item=>item.expected.length>0).map(({evidence:item})=>({messageId:item.messageId,url:item.url,text:item.text,publishedAt:item.publishedAt,collectedAt:item.collectedAt,contextComplete:item.contextComplete,textOrigin:item.textOrigin,metadata:item.metadata,parentId:item.parentId,provenance:item.provenance}));
  assert.equal(historical.length,4,'使用已核实完整正文的四条历史正例，不能把归档旧标签当标准');
  const database=`radar_qa_history_${Date.now()}_${randomUUID().slice(0,8)}`;
  const admin=new pg.Pool({connectionString:url.href});try {await admin.query(`CREATE DATABASE "${database}"`);}finally {await admin.end();}
  url.pathname='/'+database;
  const report:ReplayReport={database,startedAt:new Date().toISOString(),scope:'First-batch repair acceptance: real PostgreSQL worker, verified saved historical originals, separate synthetic boundaries. No actual model or WeChat calls.',sourceSnapshot:{readAt:new Date().toISOString(),publicEvidenceCount:publicData.data.evidence.length,inputKind:'four independently checked original bodies from saved historical evidence samples; public site read only',evidence:historical},scenarios:[],safety:{productionDataModified:false,retainedIsolatedDatabase:true,httpQaPortUsed:false,externalAiCalls:0,externalWechatCalls:0}};write(report);
  const env={...process.env,DATABASE_URL:url.href,DOTENV_CONFIG_PATH:'/dev/null',DOTENV_CONFIG_OVERRIDE:undefined,RADAR_INTEGRATION:'1',RADAR_HISTORICAL_REPLAY:'1'};
  for(const script of ['scripts/migrate.ts','scripts/migrations/wechat.ts']) {
    const result=spawnSync('pnpm',['exec','tsx',script,...(script.includes('/migrations/')?['--apply']:[])],{cwd:root,env,encoding:'utf8'});
    if(result.status!==0){report.status='isolated_initialization_failed';write(report);throw new Error('隔离测试库初始化失败；未修改真实数据');}
  }
  const result=spawnSync('pnpm',['exec','tsx','--test','--test-concurrency=1','tests/historical-replay.test.ts'],{cwd:root,env,encoding:'utf8'});
  const logPath=reportPath.replace(/\.json$/,'.log');writeFileSync(logPath,(result.stdout??'')+(result.stderr??''));
  const finalReport=JSON.parse(readFileSync(reportPath,'utf8')) as ReplayReport;finalReport.runner={exitCode:result.status,signal:result.signal,logPath};if(result.status!==0)finalReport.status='failed';write(finalReport);
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');await pool.end();process.exitCode=result.status??1;
}

if(process.argv.includes('--isolated-run'))await isolatedRun();
else test('真实隔离库：历史原文与合成边界经worker自动发布回放',{skip:process.env.RADAR_HISTORICAL_REPLAY!=='1'},async t=>{
  const url=new URL(process.env.DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55489');const database=url.pathname.slice(1);assert.match(database,/^radar_qa_history_/,'必须是本任务独立QA库');
  const report=JSON.parse(readFileSync(reportPath,'utf8')) as ReplayReport;assert.equal(report.database,database);
  const tag=randomUUID().replace(/-/g,''),sourceId=`replay-${tag}`,author=`replay_fixture_${tag}`;
  const source=(sourceId:string,name:string,kind:Source['kind']='archive'):Source=>({id:sourceId,name,kind,url:'https://example.invalid/isolated-replay',enabled:true,validated:true,intervalMinutes:5,version:1,status:'healthy',nextRunAt:'2100-01-01T00:00:00.000Z'});
  await put('sources',source(sourceId,'合成边界夹具，非真实历史原帖'));
  await put('sources',source('official-status','已保存官方状态历史更新','status'));
  await put('sources',source('history-original','已有原文+单独辅助中文摘要'));
  await put('sources',source('history-english-only','真实英文原文；故意不传辅助译文的边界变体'));
  await put('settings',{...defaultAI,id:'ai',enabled:false});
  await put('settings',{id:'site',name:'隔离历史回放',description:'QA only',autoPublish:true,version:1});
  let serial=0,modelStubCalls=0,networkCalls=0,collectionCalls=0;
  const forbiddenFetch=globalThis.fetch;globalThis.fetch=(async()=>{networkCalls++;throw new Error('回放禁止真实外部请求');}) as typeof fetch;
  const createdCandidates:string[]=[];const originTime=Date.now()-60_000;
  const fixture=async(text:string,patch:Partial<Omit<Evidence,'id'|'hash'>>={})=>{
    const messageId=String(2300000000000000000n+BigInt(++serial)),time=new Date(originTime+serial*1000).toISOString();
    const record=await createEvidence({sourceId,messageId,url:`https://x.com/${author}/status/${messageId}`,text,publishedAt:time,collectedAt:new Date().toISOString(),contextComplete:true,historical:false,provenance:'archive',textOrigin:'original',metadata:{sourceGroup:'synthetic-replay-fixtures'},...patch});
    if(record.candidate)createdCandidates.push(record.candidate.id);return record;
  };
  const workerOptions={enrich:async()=>undefined,collect:async()=>{collectionCalls++;throw new Error('夹具来源不应触发真实采集');}};
  async function drain(generate?:((evidence:Evidence[],existing?:DraftContent)=>Promise<DraftContent>)) {
    // Application and PostgreSQL clocks may differ by milliseconds. An empty
    // claim immediately after scheduling is not proof that the queue is drained.
    let quiet=0;
    for(let count=0;count<100;count++){const processed=await runOne({...workerOptions,...(generate?{generate,allowTemplates:true}:{})});if(processed){quiet=0;continue;}if(++quiet>=3)return;await delay(25);}
    assert.fail('自动任务超过100次，可能重复调度');
  }
  async function counts() {
    const [events,articles,publications,notices,candidates,jobs]=await Promise.all([list<RadarEvent>('events'),list<Article>('articles'),list<Publication>('publications'),list<Notice>('notices'),list<Candidate>('candidates'),list<Job>('jobs')]);
    const data=await getPublicData(),actions=publicActions(data).map(item=>item.action);
    return {events:events.length,articles:articles.length,publications:publications.length,notices:notices.length,activeNotices:notices.filter(item=>item.status==='active').length,withdrawnNotices:notices.filter(item=>item.status==='withdrawn').length,publishedCandidates:candidates.filter(item=>item.status==='published').length,pendingCandidates:candidates.filter(item=>item.status==='pending').length,failedJobs:jobs.filter(item=>item.status==='failed').length,publicCompletedActions:actions.filter(item=>item.stage==='claimed_complete').length,publicPromisedActions:actions.filter(item=>item.stage==='promised').length,publicCancelledActions:actions.filter(item=>item.stage==='cancelled').length};
  }
  async function state(candidateId:string) {
    const candidate=(await one<Candidate>('candidates',candidateId))!;
    const publications=(await list<Publication>('publications')).filter(item=>item.article.evidenceIds[0]===candidate.evidenceId).sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt)||a.article.version-b.article.version);
    const latest=publications.at(-1),eventId=candidate.content.eventId??latest?.eventId,event=eventId?await one<RadarEvent>('events',eventId):undefined;
    const actionView=(action:RadarEvent['actions'][number])=>({id:action.id,kind:action.kind,stage:action.stage,scope:action.scope,eligibility:action.eligibility,expectedAt:action.expectedAt,timeNote:action.timeNote,statementAt:action.statementAt});
    return {candidateId,status:candidate.status,automation:candidate.automation?.state,reasonCodes:candidate.automation?.reasonCodes,reasons:candidate.reasons,publicationMode:candidate.content.publicationMode,contentOrigin:candidate.content.contentOrigin,eventId:event?.id,actions:event?.actions.map(actionView),publishedActions:latest?.event.actions.map(actionView),articleVersions:publications.map(item=>({articleId:item.articleId,version:item.article.version,historical:item.article.historical,publicationId:item.id,stages:item.event.actions.map(action=>action.stage)}))};
  }
  async function record(name:string,inputKind:string,check:(before:Awaited<ReturnType<typeof counts>>)=>Promise<Record<string,unknown>>) {
    const before=await counts(),candidateStart=createdCandidates.length;let details:Record<string,unknown>={},failure:unknown;
    try {details=await check(before);}catch(error){failure=error;details={result:'fail',error:{name:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:undefined}};}
    const after=await counts(),delta=Object.fromEntries(Object.entries(after).map(([key,value])=>[key,value-before[key as keyof typeof before]])),candidateIds=createdCandidates.slice(candidateStart);
    const observed=await Promise.all(candidateIds.map(candidateId=>state(candidateId))),jobs=(await list<Job>('jobs')).filter(job=>candidateIds.includes(job.candidateId??'')).map(job=>({candidateId:job.candidateId,status:job.status,attempts:job.attempts,error:job.error,payload:job.payload}));
    report.scenarios.push({name,inputKind,before,after,delta,...details,observed,jobs});write(report);
    if(failure)throw failure;
  }
  try {
    await t.test('中文预告→进行中→完成无需模型或后台点击，同一动作只计一次完成',async()=>record('chinese_lifecycle','synthetic_boundary',async()=>{
      const promise=await fixture('我们将为所有Codex账户发放重置卡。');await drain();const progress=await fixture('我们正在为所有Codex账户发放重置卡。',{parentId:promise.evidence.messageId});await drain();const complete=await fixture('我们已为所有Codex账户发放重置卡。',{parentId:progress.evidence.messageId});await drain();
      const states=await Promise.all([promise,progress,complete].map(item=>state(item.candidate!.id)));assert.ok(states.every(item=>item.status==='published'&&item.contentOrigin==='template'));
      const event=(await one<RadarEvent>('events',states[2].eventId!))!;assert.equal(event.actions.length,1);assert.equal(event.actions[0].stage,'claimed_complete');assert.equal(new Set(states.map(item=>item.eventId)).size,1);
      const ids=new Set([promise.evidence.id,progress.evidence.id,complete.evidence.id]);const snapshots=(await list<Publication>('publications')).filter(item=>ids.has(item.article.evidenceIds[0])).sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt));assert.deepEqual(snapshots.map(item=>item.event.actions[0].stage),['promised','in_progress','claimed_complete']);
      return {result:'pass',states,manualPublishClicks:0,modelCalls:0,immutableStageSequence:snapshots.map(item=>item.event.actions[0].stage)};
    }));
    await t.test('重复采集及乱序旧预告自动归档，不产生人工冲突或重复发放',async()=>record('duplicate_and_out_of_order','synthetic_boundary',async before=>{
      const rootPromise=await fixture('我们将为所有Codex账户发放重置卡。');await drain();
      const first=await fixture('我们已为所有Codex账户发放重置卡。',{parentId:rootPromise.evidence.messageId});await drain();const candidate=(await one<Candidate>('candidates',first.candidate!.id))!,baseline=await counts();const currentEvent=(await one<RadarEvent>('events',(await state(candidate.id)).eventId!))!;
      const {id:_id,hash:_hash,...same}=first.evidence;const duplicate=await createEvidence(same);assert.equal(duplicate.created,false);await drain();assert.deepEqual(await counts(),baseline);
      const earlier=await fixture('我们将为所有Codex账户发放重置卡。',{parentId:rootPromise.evidence.messageId,publishedAt:new Date(Date.parse(first.evidence.publishedAt)-500).toISOString()});await drain();const late=await state(earlier.candidate!.id),firstState=await state(candidate.id),event=(await one<RadarEvent>('events',firstState.eventId!))!;assert.equal(event.actions[0].stage,'claimed_complete');assert.equal((await counts()).publicCompletedActions,before.publicCompletedActions+1);assert.equal((await counts()).notices,baseline.notices);
      assert.equal(late.status,'published');assert.notEqual(late.automation,'conflict');assert.equal(event.title,currentEvent.title);
      const machineBlocked=(await one<Candidate>('candidates',earlier.candidate!.id))!;
      const legacyDraft=buildAutomaticTemplate(gatherEvidenceContext(earlier.evidence,await list<Evidence>('evidence')))!;assert.ok(legacyDraft.actions.length);
      await put('candidates',{...machineBlocked,status:'pending',version:machineBlocked.version+1,content:{...legacyDraft,eventId:event.id,actions:legacyDraft.actions.map(action=>({...action,id:event.actions[0].id}))},reasons:['动作资格或状态变化缺少明确更正证据，存在事实冲突'],automation:{...machineBlocked.automation!,state:'conflict',inputFingerprint:machineBlocked.automation!.inputFingerprint!.replace(/^[^:]+:/,'benefit-rules-before:')}});
      const beforeRecovery=await counts();
      // This raw fixture simulates deploying new rules over old stored state.
      // A restarted worker performs an initial scan; it is not a new-evidence write.
      await scheduleDue({skipSources:true});
      await drain();const recovered=await state(machineBlocked.id);assert.equal(recovered.status,'published');assert.notEqual(recovered.automation,'conflict');assert.equal((await counts()).publications,beforeRecovery.publications);assert.equal((await counts()).notices,beforeRecovery.notices);
      return {result:'pass',duplicateCreated:false,rootMessageId:rootPromise.evidence.messageId,collectionOrder:['root promise','later completion reply','earlier promise reply to same root'],latestStage:event.actions[0].stage,lateCandidate:late};
    }));
    await t.test('旧取消晚到先于人工保护判断归档，不覆盖新完成或制造更正提醒',async()=>record('older_cancellation_manual_protection','synthetic_boundary',async()=>{
      const root=await fixture('我们将为所有Codex账户发放重置卡。');await drain();const complete=await fixture('我们已为所有Codex账户发放重置卡。',{parentId:root.evidence.messageId});await drain();
      const current=(await one<RadarEvent>('events',(await state(complete.candidate!.id)).eventId!))!;const protectedEvent={...current,title:'人工校对的完成标题',version:current.version+1,manualFields:['title',`actions.${current.actions[0].id}.stage`]};await put('events',protectedEvent);const baseline=await counts();
      const cancelled=await fixture('更正：取消为所有Codex账户发放重置卡。',{parentId:root.evidence.messageId,publishedAt:new Date(Date.parse(complete.evidence.publishedAt)-500).toISOString()});await drain();const observed=await state(cancelled.candidate!.id);const event=(await one<RadarEvent>('events',current.id))!;
      assert.equal(observed.status,'published');assert.notEqual(observed.automation,'conflict');assert.equal(event.title,protectedEvent.title);assert.deepEqual(event.actions,protectedEvent.actions);assert.equal((await counts()).notices,baseline.notices);assert.equal((await counts()).publicCompletedActions,baseline.publicCompletedActions);
      return {result:'pass',observed,protectedTitle:event.title,manualProtectionPreserved:true};
    }));
    await t.test('分条与同段双动作都自动保持用量完成、重置卡待发',async()=>record('independent_benefit_actions','synthetic_boundary',async()=>{
      const usage=await fixture('我们已为所有Codex账户完成用量重置。');await drain();const card=await fixture('我们将为所有Codex账户发放重置卡。',{parentId:usage.evidence.messageId});await drain();const dual=await state(card.candidate!.id);assert.deepEqual(dual.actions?.map(action=>[action.kind,action.stage]).sort(),[['automatic_reset','claimed_complete'],['banked_reset','promised']].sort());
      const combined=await fixture('我们已为所有Codex账户完成用量重置，重置卡将为所有Codex账户另外发放。');await drain();const single=await state(combined.candidate!.id);assert.equal(single.status,'published');assert.equal(single.publicationMode,'state_change');assert.deepEqual(single.actions?.map(action=>[action.kind,action.stage]).sort(),[['automatic_reset','claimed_complete'],['banked_reset','promised']].sort());
      return {result:'pass',separatePosts:dual,singleParagraph:single};
    }));
    await t.test('定向补卡和私人结转只发布来源新闻，不增加普发动作和提醒',async()=>record('targeted_private_boundaries','synthetic_boundary',async before=>{
      const targeted=await fixture('定向补偿：我们已为受影响的所有Codex账户发放重置卡。');await drain();const privateItem=await fixture('个人结转：仅你这个账户已添加重置卡，不属于公共发放。');await drain();
      const states=await Promise.all([targeted,privateItem].map(item=>state(item.candidate!.id)));assert.ok(states.every(item=>item.status==='published'&&item.publicationMode==='news_only'&&item.actions?.length===0));const after=await counts();assert.equal(after.publicCompletedActions,before.publicCompletedActions);assert.equal(after.notices,before.notices);return {result:'pass',states};
    }));
    await t.test('已经过去的预计日期保持预告，计时和刷新不会制造完成',async()=>record('expired_forecast_is_not_completion','synthetic_boundary',async()=>{
      const item=await fixture('我们计划为所有Codex账户发放重置卡，预计2025年1月1日18:00（北京时间）。');await drain();await drain();const observed=await state(item.candidate!.id);assert.equal(observed.status,'published');assert.equal(observed.actions?.[0].stage,'promised');
      assert.equal(observed.actions?.[0].expectedAt,'2025-01-01T10:00:00.000Z');
      return {result:'pass',observed,deadlineInTextAlreadyPassed:true};
    }));
    await t.test('明确取消自动更正，撤回旧预告提醒并保留更正记录',async()=>record('explicit_cancellation','synthetic_boundary',async()=>{
      const plan=await fixture('我们将为所有Codex账户发放重置卡。');await drain();const cancelled=await fixture('更正：取消为所有Codex账户发放重置卡。',{parentId:plan.evidence.messageId});await drain();const observed=await state(cancelled.candidate!.id);assert.equal(observed.status,'published');assert.equal(observed.actions?.[0].stage,'cancelled');
      const notices=(await list<Notice>('notices')).filter(item=>item.eventId===observed.eventId);assert.equal(notices.filter(item=>item.status==='active'&&item.categories.includes('correction')).length,1);assert.ok(notices.some(item=>item.status==='withdrawn'));return {result:'pass',observed,notices:notices.map(item=>({status:item.status,categories:item.categories}))};
    }));
    await t.test('迟到父帖自动关联，无AI升级同文章且不重复发布',async()=>record('late_parent_recovery','synthetic_boundary_without_model',async()=>{
      const parentId='2300000000000999999';const child=await fixture('我们已为所有Codex账户发放重置卡。',{parentId,contextComplete:false});await drain();const beforeParent=await state(child.candidate!.id);assert.equal(beforeParent.publicationMode,'news_only');
      const parent=await fixture('我们将为所有Codex账户发放重置卡。',{messageId:parentId,url:`https://x.com/${author}/status/${parentId}`,publishedAt:new Date(Date.parse(child.evidence.publishedAt)-1000).toISOString()});await drain();const afterParentNoAI=await state(child.candidate!.id);assert.equal(afterParentNoAI.publicationMode,'state_change');
      const originalArticle=beforeParent.articleVersions[0]?.articleId;assert.ok(originalArticle);
      const baseline=await counts();await drain();await scheduleDue();await drain();assert.deepEqual(await counts(),baseline);
      const recovered=await state(child.candidate!.id);assert.equal(recovered.status,'published');assert.equal(recovered.publicationMode,'state_change');assert.equal(recovered.actions?.[0].stage,'claimed_complete');assert.ok(recovered.articleVersions.every(item=>item.articleId===originalArticle));assert.equal(recovered.articleVersions.length,2);
      return {result:'pass',beforeParent,afterParentNoAI,recovered,parentCandidateId:parent.candidate!.id,modelCalls:0,repeatedRunCreatesNoPublication:true};
    }));
    await t.test('中文产品动态自动成文，无人工发布也不制造福利提醒',async()=>record('chinese_product_news','synthetic_boundary',async before=>{
      const item=await fixture('Codex客户端新增中文用量提示功能。');await drain();const observed=await state(item.candidate!.id);assert.equal(observed.status,'published');assert.equal(observed.publicationMode,'news_only');assert.equal(observed.actions?.length,0);assert.equal((await counts()).notices,before.notices);return {result:'pass',observed,manualPublishClicks:0};
    }));
    await t.test('四条核实完整的历史英文原文自动形成中文事实与对应动作，不发即时提醒',async()=>record('verified_historical_english_automatic_facts','independently_verified_saved_originals',async before=>{
      const rows=[];for(const input of report.sourceSnapshot.evidence){const result=await createEvidence({...input,sourceId:'history-original',historical:true});if(result.candidate)createdCandidates.push(result.candidate.id);await drain();rows.push({messageId:input.messageId,url:input.url,rawTextHash:createHash('sha256').update(input.text).digest('hex'),sourcePublishedAt:input.publishedAt,textOrigin:input.textOrigin,contextComplete:input.contextComplete,auxiliaryChineseSummary:!!input.metadata?.summary&&/[\u3400-\u9fff]/.test(input.metadata.summary),observed:result.candidate?await state(result.candidate.id):undefined});}
      assert.ok(rows.every(row=>row.observed?.status==='published'&&row.observed.publicationMode==='state_change'));
      assert.deepEqual(rows.map(row=>row.observed!.publishedActions!.map(action=>[action.kind,action.stage])),[[['automatic_reset','claimed_complete']],[['automatic_reset','in_progress']],[['banked_reset','claimed_complete']],[['banked_reset','promised']]]);
      const relativeSource=report.sourceSnapshot.evidence[3],firstBanked=rows[3].observed!.publishedActions![0];
      assert.match(relativeSource.text,/First one will land in ~ 3 hours\./,'原文明示当前重置卡首轮的近似相对时间');
      assert.match(firstBanked.eligibility,/Astra/);assert.equal(firstBanked.statementAt,relativeSource.publishedAt);
      assert.equal(firstBanked.expectedAt,'2026-09-04T02:12:09.000Z');
      assert.equal(Date.parse(firstBanked.expectedAt!)-Date.parse(relativeSource.publishedAt),3*3600_000,'三小时从该原帖发布时间换算，不能借其他动作时间');
      assert.match(firstBanked.timeNote!,/^原文近似时间：.*并非最晚截止.*未给出误差范围/);
      assert.equal((await counts()).notices,before.notices);assert.ok(rows.every(row=>row.observed!.articleVersions.every(article=>article.historical)));
      return {result:'pass',rows,modelCalls:0,translationScope:'Limited rule facts written in Chinese; no full-text AI translation claimed.'};
    }));
    await t.test('明确英文无辅助中文摘要也能用事实模板发布，跨来源不重复计数',async()=>record('english_without_auxiliary_chinese','saved_original_text_metadata_withheld_boundary_variant',async before=>{
      const input=report.sourceSnapshot.evidence[0],result=await createEvidence({...input,sourceId:'history-english-only',historical:true,metadata:{category:'reset',sourceGroup:'codex-resets'}});assert.ok(result.candidate);createdCandidates.push(result.candidate.id);await drain();const observed=await state(result.candidate.id);assert.equal(observed.status,'published');assert.equal(observed.publicationMode,'state_change');assert.equal(observed.actions?.[0].stage,'claimed_complete');assert.equal((await counts()).publicCompletedActions,before.publicCompletedActions);assert.equal((await counts()).notices,before.notices);return {result:'pass',messageId:input.messageId,url:input.url,rawTextHash:createHash('sha256').update(input.text).digest('hex'),observed,modelCalls:0};
    }));
    await t.test('真实官方故障更新包含unexpected resets及恢复，也从不推断福利发放',async()=>record('saved_official_incident_updates','saved_verified_official_update_text_not_synthetic',async before=>{
      const research=JSON.parse(readFileSync(new URL('../work/incident-research.json',import.meta.url),'utf8'));
      const incidents=[research.incident_details[0],research.incident_details.find((item:{incident_id:string})=>item.incident_id==='01KK26XE1W536H7DQV2EXM3GHE'),research.unexpected_reset_special].filter(Boolean);const rows=[];
      for(const incident of incidents)for(const update of incident.updates){const result=await createEvidence({sourceId:'official-status',messageId:`${incident.incident_id}:${update.utc}`,url:incident.url,text:update.summary,publishedAt:update.utc,collectedAt:new Date().toISOString(),contextComplete:true,historical:true,provenance:'official',textOrigin:'structured',metadata:{status:String(update.status).toLowerCase(),sourceGroup:'openai-status'}});if(result.candidate)createdCandidates.push(result.candidate.id);await drain();const observed=result.candidate?await state(result.candidate.id):undefined;assert.equal(observed?.status,'published');assert.equal(observed?.publicationMode,'news_only');assert.equal(observed?.actions?.length,0);rows.push({incidentId:incident.incident_id,url:incident.url,status:update.status,sourcePublishedAt:update.utc,bodyHash:createHash('sha256').update(update.summary).digest('hex'),observed});}
      assert.equal((await counts()).publicCompletedActions,before.publicCompletedActions);assert.equal((await counts()).notices,before.notices);return {result:'pass',sourceFile:'work/incident-research.json',updates:rows.length,rows,caveat:'Replays previously saved verified status bodies; does not re-fetch providers or prove personal-account compensation.'};
    }));
    await t.test('客户端公共事实与固定版本海报使用同一已发布快照',async()=>record('shared_public_snapshot','isolated_published_version_consistency',async()=>{
      const data=await getPublicData();const facts=publicActions(data);assert.ok(facts.length>0);
      for(const fact of facts){const stored=(await one<Publication>('publications',fact.publication.id))!;assert.deepEqual(fact.action,stored.event.actions.find(action=>action.id===fact.action.id));assert.deepEqual(fact.publication.event,stored.event);const svg=posterSvg(fact.publication,'隔离验收');assert.match(svg,/隔离验收/);assert.ok(svg.includes(fact.action.kind==='banked_reset'?'重置卡':'用量重置'));}
      return {result:'pass',checkedPublicActions:facts.length,assertionScope:'Shared published data and poster rendering; no browser or real WeChat claim.'};
    }));
    report.totals={...await counts(),testedCandidates:createdCandidates.length,modelStubCalls,actualAiUsageRows:(await pool.query('SELECT count(*)::int AS count FROM radar_ai_usage')).rows[0].count,networkCalls,collectionCalls};assert.equal(networkCalls,0);assert.equal(collectionCalls,0);assert.equal(report.totals.actualAiUsageRows,0);
    report.testSummary={scenarios:report.scenarios.length,passed:report.scenarios.filter(item=>item.result==='pass').length,failed:report.scenarios.filter(item=>item.result==='fail').length};report.status=report.scenarios.some(item=>item.result==='fail')?'failed':'completed_repair_acceptance';
  } catch(error){report.status='failed';throw error;}
  finally {globalThis.fetch=forbiddenFetch;report.finishedAt=new Date().toISOString();write(report);await pool.end();}
});
