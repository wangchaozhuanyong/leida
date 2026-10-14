import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateAutomationObservation,recoverAutomationObservation,OBSERVATION_SOURCES,OBSERVATION_DURATION_MS,AUTOMATION_OBSERVATION_RULE_VERSION,type AutomationObservation,type ObservationInput} from '../src/lib/automation-observation';
import type {Evidence,Publication} from '../src/lib/types';
import {acquireObservationFileLock} from '../scripts/observation-lock.mjs';

const time='2026-10-10T09:00:00.000Z',stamp=Date.parse(time),startedAt='2026-10-07T09:00:00.000Z';
const state=():AutomationObservation=>({startedAt,samples:206,status:'waiting_configuration_or_recovery',lastSampleAt:new Date(stamp-300_000).toISOString(),realNewMessages:4,actualModelCalls:0,realGeneratedPublications:0,sourceFailureSamples:0,workerFailureSamples:0,failedSamples:0,maxSamplingGapMs:300_000,recordedPublicationIds:['retained-old-publication'],blockers:['智能服务尚未配置完成'],ruleVersion:AUTOMATION_OBSERVATION_RULE_VERSION,ruleActivatedAt:startedAt,processedCollectionFailureIds:[],collectionFailureEvents:0,runtimeIdentity:'fixture-runtime',runtimeBuildId:'fixture-build'});
const evidence:Evidence={id:'real-new-evidence',sourceId:'official-releases',messageId:'new-release',url:'https://github.com/openai/codex/releases/tag/test-public-real-chain',text:'Official source text',publishedAt:new Date(stamp-60_000).toISOString(),collectedAt:new Date(stamp-30_000).toISOString(),hash:'immutable',contextComplete:true,historical:false,provenance:'official',textOrigin:'structured'};
function publication(origin:'generated'|'template'='generated'):Publication {
 const id=`observed-${origin}`;
 return {id,eventId:'event',articleId:'article',publishedAt:new Date(stamp-20_000).toISOString(),cutoffAt:evidence.collectedAt,reason:'证据核验',contentOrigin:origin,
  article:{id:'article',eventId:'event',publicationId:id,title:'真实来源新动态',summary:'明确来源事实',translation:'中文内容',category:'product',version:1,status:'published',evidenceIds:[evidence.id],publishedAt:new Date(stamp-20_000).toISOString(),updatedAt:time,sourcePublishedAt:evidence.publishedAt,historical:false},
  event:{id:'event',title:'事件',version:1,status:'published',publicationId:id,actions:[],evidenceIds:[evidence.id],updatedAt:time}};
}
function input(pubs:Publication[]=[]):ObservationInput {
 return {time,sources:OBSERVATION_SOURCES.map(id=>({id,status:'healthy',enabled:true,validated:true,intervalMinutes:5,publicationPaused:false,lastSuccessAt:time})),heartbeatAt:time,aiReady:false,modelSuccessfulCalls:0,evidence:[evidence],publications:pubs,automaticPublicationIds:new Set(pubs.map(item=>item.id)),publicData:{version:'real-version',ids:new Set(pubs.map(item=>item.id)),currentIds:new Set(pubs.map(item=>item.id))},runtimeIdentity:'fixture-runtime',runtimeBuildId:'fixture-build',collectionFailures:{scannedFrom:startedAt,readThrough:time,total:0,records:[]}};
}
test('免费Tibo单独运行可开始运行与模板观察，不要求关闭的旧归档或收费AI',()=>{
 const request=input();
 request.sources=[{id:'tibo-public',status:'healthy',enabled:true,validated:true,intervalMinutes:2,publicationPaused:false,lastSuccessAt:time}];
 const result=evaluateAutomationObservation(state(),request);
 assert.equal(result.sourceFailure,false);
 assert.equal(result.state.runtimeStatus,'observing');
 assert.equal(result.state.templateStatus,'observing');
 assert.equal(result.state.status,'waiting_configuration_or_recovery');
 assert.equal(result.state.runtimeRequiredUntil,new Date(stamp+OBSERVATION_DURATION_MS).toISOString());
});
test('未配置智能接口只阻塞完整生成计时，运行和模板分层开始观察并保留旧记录',()=>{
 const {state:next}=evaluateAutomationObservation(state(),input([publication('template')]));
 assert.equal(next.status,'waiting_configuration_or_recovery');assert.equal(next.continuousHealthySince,undefined);
 assert.equal(next.runtimeStatus,'observing');assert.equal(next.templateStatus,'observing');assert.equal(next.continuousRuntimeHealthySince,time);assert.equal(next.continuousTemplateHealthySince,time);
 assert.equal(next.runtimeRequiredUntil,new Date(stamp+OBSERVATION_DURATION_MS).toISOString());assert.equal(next.realTemplatePublications,1);assert.equal(next.realGeneratedPublications,0);
 assert.equal(next.startedAt,startedAt);assert.equal(next.samples,207);assert.deepEqual(next.recordedPublicationIds,['retained-old-publication']);
});
test('已公开观测的 generated 不因后续版本替换或暂时网站中断而丢失，当前版本另外统计',()=>{
 const pub=publication(),first=evaluateAutomationObservation(state(),{...input([pub]),aiReady:true,modelSuccessfulCalls:1}).state;
 const replaced=evaluateAutomationObservation(first,{...input([pub]),aiReady:true,modelSuccessfulCalls:1,publicData:{version:'next-version',ids:new Set([pub.id]),currentIds:new Set()}}).state;
 assert.equal(replaced.realGeneratedPublications,1);assert.equal(replaced.currentRealGeneratedPublications,0);assert.deepEqual(replaced.observedGeneratedPublicationIds,[pub.id]);
 const offline=evaluateAutomationObservation(replaced,{...input([pub]),publicData:undefined}).state;assert.equal(offline.realGeneratedPublications,1);assert.equal(offline.runtimeStatus,'waiting_configuration_or_recovery');
});
test('数据库里的生成结果未曾被公开接口观察，不能计为完整生成正例',()=>{
 const pub=publication(),result=evaluateAutomationObservation(state(),{...input([pub]),publicData:{version:'v',ids:new Set(),currentIds:new Set()}}).state;
 assert.equal(result.realGeneratedPublications,0);assert.deepEqual(result.observedGeneratedPublicationIds,[]);
});
test('一次真实连接成功和多个调用不代替真实新消息的自动生成发布',()=>{
 const previous={...state(),continuousHealthySince:startedAt,continuousRuntimeHealthySince:startedAt,continuousTemplateHealthySince:startedAt};
 const result=evaluateAutomationObservation(previous,{...input(),aiReady:true,modelSuccessfulCalls:10}).state;
 assert.equal(result.actualModelCalls,10);assert.equal(result.status,'waiting_real_generated_publication');assert.equal(result.runtimeStatus,'ready_for_review');assert.equal(result.templateStatus,'waiting_new_template_publication');
});
test('历史补采、人工、待发布、撤回或非自动发布不能充当真实生成正例',()=>{
 for(const variant of ['historical','manual','pending','withdrawn','manual_publish','missing_evidence','future'] as const){
  const pub=publication(),request=input([pub]);
  if(variant==='historical')request.evidence=[{...evidence,historical:true}];
  if(variant==='manual')request.evidence=[{...evidence,provenance:'manual'}];
  if(variant==='pending')pub.article.status='withdrawn';
  if(variant==='withdrawn')pub.event.status='withdrawn';
  if(variant==='manual_publish')request.automaticPublicationIds=new Set();
  if(variant==='missing_evidence')request.evidence=[];
  if(variant==='future')pub.publishedAt=new Date(stamp+60_000).toISOString();
  assert.equal(evaluateAutomationObservation(state(),request).state.realGeneratedPublications,0,variant);
 }
});
test('缺来源、来源未验证、暂停、心跳时间异常和超过十分钟缺口分别重置各层时钟',()=>{
 const previous={...state(),continuousHealthySince:startedAt,continuousRuntimeHealthySince:startedAt,continuousTemplateHealthySince:startedAt};
 for(const variant of ['missing_source','unvalidated','paused','future_heartbeat','future_source','stale_heartbeat','sampling_gap'] as const){
  const request={...input(),aiReady:true},old={...previous};
  if(variant==='missing_source')request.sources=[];
  if(variant==='unvalidated')request.sources[0].validated=false;
  if(variant==='paused')request.sources[0].publicationPaused=true;
  if(variant==='future_heartbeat')request.heartbeatAt=new Date(stamp+1).toISOString();
  if(variant==='future_source')request.sources[0].lastSuccessAt=new Date(stamp+1).toISOString();
  if(variant==='stale_heartbeat')request.heartbeatAt=new Date(stamp-180_001).toISOString();
  if(variant==='sampling_gap')old.lastSampleAt=new Date(stamp-600_001).toISOString();
  const result=evaluateAutomationObservation(old,request).state;
  assert.equal(result.continuousHealthySince,undefined,variant);assert.equal(result.continuousRuntimeHealthySince,undefined,variant);assert.equal(result.continuousTemplateHealthySince,undefined,variant);
 }
});
test('动态活动来源也必须健康，人工补录不能单独证明自动采集正常',()=>{
 const request=input(),base=request.sources.find(source=>source.id==='tibo-public')!;
 for(const variant of ['failed','unvalidated','paused','stale'] as const){
  const dynamic={...base,id:'activity-4bf461f3914fbe78'};
  if(variant==='failed')dynamic.status='failed';
  if(variant==='unvalidated')dynamic.validated=false;
  if(variant==='paused')dynamic.publicationPaused=true;
  if(variant==='stale')dynamic.lastSuccessAt=new Date(stamp-24*3600_000).toISOString();
  const result=evaluateAutomationObservation(state(),{...request,sources:[base,dynamic]});
  assert.equal(result.sourceFailure,true,variant);
  assert.equal(result.state.runtimeStatus,'waiting_configuration_or_recovery',variant);
 }
 assert.equal(evaluateAutomationObservation(state(),{...request,sources:[{...base,id:'manual'}]}).sourceFailure,true);
 assert.equal(evaluateAutomationObservation(state(),{...request,sources:[{...base,id:'activity-4bf461f3914fbe78'}]}).sourceFailure,false);
});
test('恢复后只从新采样重新计时，不追认断点前的连续七十二小时',()=>{
 const paused=evaluateAutomationObservation({...state(),continuousRuntimeHealthySince:startedAt},{...input(),publicData:undefined}).state;
 const nextTime=new Date(stamp+300_000).toISOString(),request=input();request.time=nextTime;request.heartbeatAt=nextTime;request.sources.forEach(item=>item.lastSuccessAt=nextTime);
 request.collectionFailures.readThrough=nextTime;
 assert.equal(evaluateAutomationObservation(paused,request).state.continuousRuntimeHealthySince,nextTime);
});
test('有效连续七十二小时、真实模型结果与已公开观察发布齐备也只进入待复核',()=>{
 const previous={...state(),continuousHealthySince:startedAt,continuousRuntimeHealthySince:startedAt,continuousTemplateHealthySince:startedAt};
 const result=evaluateAutomationObservation(previous,{...input([publication(),publication('template')]),aiReady:true,modelSuccessfulCalls:1}).state;
 assert.equal(result.status,'ready_for_review');assert.equal(result.templateStatus,'ready_for_review');assert.equal(result.runtimeStatus,'ready_for_review');
});
const jsonl=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)+'\n').join('');
const committedSample=(value:AutomationObservation)=>({sampleId:`${value.startedAt}:${value.samples}`,sequence:value.samples,time:value.lastSampleAt,observationState:value});
test('timing 已写但状态未写时恢复编号，重启不重复记录已观测发布',()=>{
 const previous=state(),next=recoverAutomationObservation(previous,'',jsonl([{publicationId:'new-timing'},{publicationId:'new-timing'}]));
 assert.deepEqual(next.recordedPublicationIds,['retained-old-publication','new-timing']);assert.equal(next.samples,previous.samples);assert.equal(previous.recordedPublicationIds.length,1);
});
test('sample 已写但状态未写时恢复同轮次较新状态、连续时钟与发布编号',()=>{
 const previous=state(),next=evaluateAutomationObservation(previous,input([publication('template')])).state;next.recordedPublicationIds=['new-publication'];
 const recovered=recoverAutomationObservation(previous,jsonl([committedSample(next)]),jsonl([{publicationId:'new-timing'}]));
 assert.equal(recovered.samples,207);assert.equal(recovered.lastSampleAt,time);assert.equal(recovered.continuousRuntimeHealthySince,time);assert.equal(recovered.realTemplatePublications,1);
 assert.deepEqual(recovered.recordedPublicationIds,['retained-old-publication','new-timing','new-publication']);
});
test('旧格式采样保留但不用于倒算样本数或连续观察时长',()=>{
 const previous=state(),recovered=recoverAutomationObservation(previous,jsonl([{time:'2026-10-09T01:00:00Z',workerHealthy:true,websiteHealthy:true},{time,sources:[],aiReady:true}]),'');
 assert.deepEqual(recovered,previous);assert.equal(recovered.continuousRuntimeHealthySince,undefined);
});
test('不同 startedAt 的新格式记录不能覆盖当前观察轮次',()=>{
 const previous=state(),other={...evaluateAutomationObservation(previous,input()).state,startedAt:'2026-10-06T09:00:00.000Z',collectionFailureScannedFrom:'2026-10-06T09:00:00.000Z',samples:999};
 assert.deepEqual(recoverAutomationObservation(previous,jsonl([committedSample(other)]),''),previous);
});
test('重复的同编号完整 sample 恢复一次；较旧记录不回退已保存状态',()=>{
 const previous=state(),next=evaluateAutomationObservation(previous,input()).state,row=committedSample(next);
 const recovered=recoverAutomationObservation(previous,jsonl([row,row]),'');assert.equal(recovered.samples,207);
 assert.deepEqual(recoverAutomationObservation({...next,samples:208},jsonl([row]),''),{...next,samples:208});
});
test('残缺、损坏、编号冲突及缺恢复状态日志停止恢复并保持输入不变',()=>{
 const previous=state(),before=JSON.stringify(previous),next=evaluateAutomationObservation(previous,input()).state,row=committedSample(next);
 const invalid=[jsonl([row]).slice(0,-1),'{bad json}\n',jsonl([row,{...row,observationState:{...next,realNewMessages:99}}]),jsonl([{...row,sequence:999}]),jsonl([{time,sequence:207,sampleId:row.sampleId}])];
 for(const raw of invalid)assert.throws(()=>recoverAutomationObservation(previous,raw,''));
 assert.throws(()=>recoverAutomationObservation(previous,'',JSON.stringify({publicationId:'incomplete-timing'})));
 assert.throws(()=>recoverAutomationObservation(previous,'',jsonl([{publicationId:null}])));
 assert.equal(JSON.stringify(previous),before);
});

const fixtureBase=resolve(dirname(fileURLToPath(import.meta.url)),'../outputs/implementation-qa/observation-lock-qa');mkdirSync(fixtureBase,{recursive:true});
function lockFixture(){const root=mkdtempSync(resolve(fixtureBase,'fixture-'));mkdirSync(resolve(root,'outputs/implementation-qa'),{recursive:true});return root;}
test('锁拒绝 legacy 观察进程并保留已有进程 manifest',()=>{
 const root=lockFixture(),manifest=resolve(root,'outputs/implementation-qa/daily-observer-process.json');writeFileSync(manifest,JSON.stringify({pid:81736,root,startedAt}));const before=readFileSync(manifest,'utf8');
 assert.throws(()=>acquireObservationFileLock(root,{pid:100,probe:pid=>({state:'observer',identity:String(pid)})}));assert.equal(readFileSync(manifest,'utf8'),before);assert.equal(existsSync(resolve(root,'outputs/implementation-qa/daily-observer.lock')),false);
});
test('确认已死或 PID 已被其他程序复用才回收锁，不依赖单纯 PID 存活',()=>{
 for(const status of ['missing','other']){
  const root=lockFixture(),path=resolve(root,'outputs/implementation-qa/daily-observer.lock');writeFileSync(path,JSON.stringify({pid:99,root,identity:'old-start'}));
  const release=acquireObservationFileLock(root,{pid:100,probe:pid=>pid===99?{state:status}:{state:'observer',identity:'new-start'}});
  assert.equal(JSON.parse(readFileSync(path,'utf8')).identity,'new-start');release();assert.equal(existsSync(path),false);
 }
});
test('身份未能核对的锁保持原样；释放不会删除另一个所有者的锁',()=>{
 const root=lockFixture(),path=resolve(root,'outputs/implementation-qa/daily-observer.lock');writeFileSync(path,JSON.stringify({pid:99,root}));const before=readFileSync(path,'utf8');
 assert.throws(()=>acquireObservationFileLock(root,{pid:100,probe:()=>({state:'unknown'})}));assert.equal(readFileSync(path,'utf8'),before);
 const release=acquireObservationFileLock(root,{pid:100,probe:pid=>pid===99?{state:'missing'}:{state:'observer',identity:'new'}});writeFileSync(path,JSON.stringify({pid:101,root,token:'other-owner'}));release();assert.equal(JSON.parse(readFileSync(path,'utf8')).token,'other-owner');
});
