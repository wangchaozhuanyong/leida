import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateAutomationObservation,recoverAutomationObservation,type AutomationObservation,type ObservationInput} from '../src/lib/automation-observation';

const RULE='automation-collection-audit-runtime-v2';
const startedAt='2026-10-09T00:00:00.000Z',since='2026-10-12T00:00:00.000Z',last='2026-10-12T01:00:00.000Z',time='2026-10-12T01:05:00.000Z';
type Failure={id:string;sourceId:string|null;failedAt:string|null};
function previous():AutomationObservation {
 return {startedAt,samples:40,status:'observing',lastSampleAt:last,realNewMessages:4,actualModelCalls:1,realGeneratedPublications:1,sourceFailureSamples:11,workerFailureSamples:0,failedSamples:0,maxSamplingGapMs:300_000,recordedPublicationIds:['old-publication'],blockers:[],ruleVersion:RULE,ruleActivatedAt:since,processedCollectionFailureIds:[],collectionFailureEvents:0,runtimeIdentity:'fixture-runtime',runtimeBuildId:'fixture-build',continuousHealthySince:since,continuousRuntimeHealthySince:since,continuousTemplateHealthySince:since};
}
function input(rows:Failure[]=[],at=time):ObservationInput {
 return {time:at,sources:[{id:'tibo-public',status:'healthy',enabled:true,validated:true,intervalMinutes:2,publicationPaused:false,lastSuccessAt:at}],heartbeatAt:at,aiReady:true,modelSuccessfulCalls:1,evidence:[],publications:[],automaticPublicationIds:new Set(),publicData:{version:'current',ids:new Set(),currentIds:new Set()},runtimeIdentity:'fixture-runtime',runtimeBuildId:'fixture-build',collectionFailures:{scannedFrom:startedAt,readThrough:at,total:rows.length,records:rows}};
}
const failure=(id='audit-1',failedAt='2026-10-12T01:02:00.000Z',sourceId='tibo-public'):Failure=>({id,sourceId,failedAt});

test('相邻健康采样之间的持久 collect 失败仍断三个连续钟，快照故障计数保持原口径',()=>{
 const before=previous(),result=evaluateAutomationObservation(before,input([failure()]));
 assert.equal(result.sourceFailure,false);
 assert.equal(result.state.continuousRuntimeHealthySince,undefined);
 assert.equal(result.state.continuousTemplateHealthySince,undefined);
 assert.equal(result.state.continuousHealthySince,undefined);
 assert.equal(result.state.collectionFailureEvents,1);
 assert.equal(result.state.sourceFailureSamples,11);
 assert.equal(result.state.runtimeStatus,'waiting_configuration_or_recovery');
 assert.deepEqual(result.state.processedCollectionFailureIds,['audit-1']);
 assert.equal(before.collectionFailureEvents,0);
});
test('晚提交失败即使发生时间早于上一采样，整锚点重扫仍打断当前连续窗',()=>{
 const result=evaluateAutomationObservation(previous(),input([failure('late','2026-10-12T00:45:00.000Z')])).state;
 assert.equal(result.continuousRuntimeHealthySince,undefined);
 assert.equal(result.collectionFailureEvents,1);
 assert.equal(result.lastCollectionFailureAt,'2026-10-12T00:45:00.000Z');
});
test('同轮重复、重启恢复与重复扫描不重复计数或反复断钟',()=>{
 const before=previous(),request=input([failure(),failure()]);
 const failed=evaluateAutomationObservation(before,request).state;
 const row={sampleId:`${failed.startedAt}:${failed.samples}`,sequence:failed.samples,time:failed.lastSampleAt,observationState:failed};
 const recovered=recoverAutomationObservation(before,JSON.stringify(row)+'\n','');
 assert.equal(recovered.collectionFailureEvents,1);
 const nextAt='2026-10-12T01:10:00.000Z',resumed=evaluateAutomationObservation(recovered,input([failure()],nextAt)).state;
 assert.equal(resumed.collectionFailureEvents,1);
 assert.equal(resumed.continuousRuntimeHealthySince,nextAt);
 const third=evaluateAutomationObservation(resumed,input([failure()],'2026-10-12T01:15:00.000Z')).state;
 assert.equal(third.collectionFailureEvents,1);
 assert.equal(third.continuousRuntimeHealthySince,nextAt);
});
test('当前合法连续窗之前的新发现历史失败仅记数，锚点前失败不计数',()=>{
 const rows=[failure('old','2026-10-11T23:59:00.000Z'),failure('before-anchor','2026-10-08T23:59:00.000Z')];
 const result=evaluateAutomationObservation(previous(),input(rows)).state;
 assert.equal(result.collectionFailureEvents,1);
 assert.equal(result.continuousRuntimeHealthySince,since);
 assert.equal(result.continuousTemplateHealthySince,since);
 assert.equal(result.continuousHealthySince,since);
 assert.deepEqual(result.processedCollectionFailureIds,['old']);
});
test('只纳入当前已启用非 manual 来源，动态活动来源也覆盖',()=>{
 const request=input([failure('manual',undefined,'manual'),failure('disabled',undefined,'disabled'),failure('dynamic',undefined,'activity-new')]);
 request.sources.push({...request.sources[0],id:'activity-new'});
 const result=evaluateAutomationObservation(previous(),request).state;
 assert.equal(result.collectionFailureEvents,1);
 assert.deepEqual(result.processedCollectionFailureIds,['dynamic']);
 assert.equal(result.continuousRuntimeHealthySince,undefined);
});
test('缺扫描、覆盖起点过晚、数量不完整、未来或倒退扫描时间均 fail closed',()=>{
 const variants=[undefined,{...input().collectionFailures!,scannedFrom:'2026-10-09T00:00:00.001Z'},{...input().collectionFailures!,total:1},{...input().collectionFailures!,readThrough:'2026-10-12T01:05:00.001Z'},{...input().collectionFailures!,readThrough:'2026-10-12T00:59:59.999Z'}];
 for(const scan of variants){const request=input();request.collectionFailures=scan as ObservationInput['collectionFailures'];assert.throws(()=>evaluateAutomationObservation(previous(),request));}
});
test('未来、无效时间、缺失归属与冲突重复 ID 不隐去失败或推进时钟',()=>{
 const variants:Failure[][]=[[failure('future','2026-10-12T01:05:00.001Z')],[failure('invalid','not-a-time')],[{...failure(),failedAt:null}],[{...failure(),sourceId:null}],[{...failure(),id:''}],[failure(),failure('audit-1','2026-10-12T01:03:00.000Z')]];
 for(const records of variants){const before=previous(),saved=JSON.stringify(before);assert.throws(()=>evaluateAutomationObservation(before,input(records)));assert.equal(JSON.stringify(before),saved);}
});
test('新版规则启用仅重新启动连续验收，保留旧观察锚点、计数、发布与历史记录',()=>{
 const old=previous();delete old.ruleVersion;delete old.ruleActivatedAt;delete old.processedCollectionFailureIds;delete old.collectionFailureEvents;
 const result=evaluateAutomationObservation(old,input([failure('past','2026-10-12T01:02:00.000Z')])).state;
 assert.equal(result.ruleVersion,RULE);assert.equal(result.ruleActivatedAt,time);
 assert.equal(result.startedAt,startedAt);assert.equal(result.samples,41);assert.equal(result.sourceFailureSamples,11);
 assert.deepEqual(result.recordedPublicationIds,['old-publication']);
 assert.equal(result.collectionFailureEvents,1);
 assert.equal(result.continuousRuntimeHealthySince,time);assert.equal(result.continuousTemplateHealthySince,time);assert.equal(result.continuousHealthySince,time);
});
test('不同层的合法连续窗不被窗前历史失败误断',()=>{
 const before={...previous(),continuousHealthySince:'2026-10-12T00:55:00.000Z',continuousRuntimeHealthySince:'2026-10-12T00:55:00.000Z'};
 const result=evaluateAutomationObservation(before,input([failure('template-only','2026-10-12T00:45:00.000Z')])).state;
 assert.equal(result.continuousHealthySince,'2026-10-12T00:55:00.000Z');
 assert.equal(result.continuousRuntimeHealthySince,'2026-10-12T00:55:00.000Z');
 assert.equal(result.continuousTemplateHealthySince,undefined);
});
test('恢复拒绝损坏的新规则审计断点，不把缺处理编号当成重启可恢复状态',()=>{
 const variants=[{...previous(),processedCollectionFailureIds:undefined},{...previous(),processedCollectionFailureIds:['duplicate','duplicate']},{...previous(),collectionFailureEvents:-1},{...previous(),ruleActivatedAt:'not-a-time'},{...previous(),lastCollectionFailureAt:'not-a-time'},{...previous(),lastCollectionFailureAt:time},{...previous(),collectionFailureScannedFrom:'2026-10-09T00:00:00.001Z'},{...previous(),collectionFailureReadThrough:time}];
 for(const state of variants)assert.throws(()=>recoverAutomationObservation(state,'',''));
});
test('扫描错误不允许沿用较早失败断点推进，恢复仍需下一完整健康采样',()=>{
 const before=previous(),request=input();request.collectionFailures.total=1;
 assert.throws(()=>evaluateAutomationObservation(before,request));
 // Mirrors the existing observer catch: all clocks clear, while committed audit IDs remain.
 const interrupted:AutomationObservation={...before,status:'interrupted',runtimeStatus:'interrupted',templateStatus:'interrupted',continuousHealthySince:undefined,requiredUntil:undefined,continuousRuntimeHealthySince:undefined,runtimeRequiredUntil:undefined,continuousTemplateHealthySince:undefined,templateRequiredUntil:undefined,failedSamples:before.failedSamples+1};
 const recovered=recoverAutomationObservation(interrupted,'','');
 const result=evaluateAutomationObservation(recovered,input([],time)).state;
 assert.equal(result.continuousRuntimeHealthySince,time);
 assert.equal(result.failedSamples,1);
 assert.equal(result.collectionFailureEvents,0);
});

test('采样之间进程重启或构建切换也断钟，身份缺失不能算健康',()=>{
 for(const variant of ['runtimeIdentity','runtimeBuildId'] as const){
  const request=input();request[variant]='new-runtime';
  const result=evaluateAutomationObservation(previous(),request).state;
  assert.equal(result.continuousRuntimeHealthySince,undefined,variant);assert.equal(result.continuousTemplateHealthySince,undefined,variant);
  assert.match(result.runtimeBlockers!.join(' '),/运行进程或构建版本/);
  const nextAt='2026-10-12T01:10:00.000Z';
  const next={...input([],nextAt),[variant]:'new-runtime'};
  assert.equal(evaluateAutomationObservation(result,next).state.continuousRuntimeHealthySince,nextAt);
 }
 for(const key of ['runtimeIdentity','runtimeBuildId'] as const){const request=input();request[key]='';assert.throws(()=>evaluateAutomationObservation(previous(),request),/身份/);}
});
