import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResetCadenceForecast,RESET_CADENCE_MODEL_VERSION} from '../src/lib/reset-cadence';
import {cadenceSourcesAvailable,projectCadenceForecast,resolveCadenceHorizon,evaluateCadence,forecastCycleDue,cadenceNextFixedAt,executeResetCadence,type StoredCadenceForecast} from '../src/server/reset-cadence-runtime';
import {forecastRevision} from '../src/lib/forecast-display';
import {referenceForecast,type ForecastPublicData,type CadenceHorizonOutcome} from '../src/lib/forecast';
import type {Source,Evidence} from '../src/lib/types';
import type {Client} from '../src/db';
import {projectPublicForecastRecords} from '../src/server/forecast';
import type {ForecastSnapshot} from '../src/lib/forecast';

const now='2026-10-10T00:00:00Z',time=Date.parse(now);
const source:Source={id:'reset-archive',name:'test',kind:'archive',url:'https://codex-resets.com/zh-CN',enabled:true,validated:true,status:'healthy',lastSuccessAt:now,intervalMinutes:5,version:1};
const snapshot=():StoredCadenceForecast=>({...buildResetCadenceForecast({observations:Array.from({length:14},(_,i)=>({id:`o${i}`,evidenceIds:[`e${i}`],at:new Date(time-12*3600_000-(13-i)*48*3600_000).toISOString(),url:`https://x.com/thsottiaux/status/${i+1}`,kind:'automatic_reset',timePrecision:'exact',firstKnownAt:new Date(time-12*3600_000-(13-i)*48*3600_000).toISOString()})),generatedAt:now,inputFingerprint:'fixture'}),recordType:'reset_cadence',sourceIds:[source.id]});

test('真实Tibo序列独立计算，只有实际使用的来源不可用才暂停',()=>{
 const tibo:Source={...source,id:'tibo-public',kind:'timeline',url:'https://api.fxtwitter.com/2/profile/thsottiaux/statuses',intervalMinutes:2};
 assert.equal(cadenceSourcesAvailable([tibo],[tibo.id],now),true);
 assert.equal(cadenceSourcesAvailable([tibo,{...source,status:'failed'}],[tibo.id],now),true);
 assert.equal(cadenceSourcesAvailable([tibo],[],now),true,'空序列进入样本不足，而非假定来源失效');
 for(const bad of [{...tibo,validated:false},{...tibo,status:'failed' as const},{...tibo,lastSuccessAt:'2026-10-01T00:00:00Z'},{...tibo,url:'https://example.com/feed'}]){
  assert.equal(cadenceSourcesAvailable([bad],[tibo.id],now),false);
 }
 assert.equal(cadenceSourcesAvailable([tibo],[tibo.id,source.id],now),false,'实际参与训练的缺失来源仍暂停');
});

test('健康来源空样本公开投影保持样本不足，不能声称来源暂停',()=>{
 const tibo:Source={...source,id:'tibo-public',kind:'timeline',url:'https://api.fxtwitter.com/2/profile/thsottiaux/statuses'};
 const empty:StoredCadenceForecast={...buildResetCadenceForecast({observations:[],generatedAt:now,inputFingerprint:'empty'}),recordType:'reset_cadence',sourceIds:[]};
 assert.equal(projectCadenceForecast(empty,[tibo],now)?.status,'insufficient');
 assert.equal(projectCadenceForecast(empty,[],now)?.status,'paused');
});
test('未来或无效采集成功时间暂停当前实验估计，不更改固定快照',()=>{
 const fixed=snapshot(),before=structuredClone(fixed);
 for(const lastSuccessAt of [new Date(time+1).toISOString(),'invalid-time']){
  const view=projectCadenceForecast(fixed,[{...source,lastSuccessAt}],now)!;
  assert.equal(view.status,'paused');assert.equal(view.p48,null);assert.equal(view.windowStart,null);
 }
 assert.deepEqual(fixed,before);
});

test('原快照保持固定，来源暂停和超时公开投影隐藏估计',()=>{
 const fixed=snapshot(),original=structuredClone(fixed);
 assert.equal(projectCadenceForecast(fixed,[source],now)?.status,'ready');
 for(const sources of [[],[{...source,enabled:false}],[{...source,status:'failed' as const}],[{...source,publicationPaused:true}]]){
  const view=projectCadenceForecast(fixed,sources,now)!;assert.equal(view.status,'paused');assert.equal(view.p48,null);assert.equal(view.windowStart,null);
 }
 const later=new Date(time+7*3600_000).toISOString(),fresh={...source,lastSuccessAt:later};
 assert.equal(projectCadenceForecast(fixed,[fresh],later)?.status,'paused');
 assert.deepEqual(fixed,original);
});

test('当前预测与结局改变公开轮询版本，读取时钟不改变版本',()=>{
 const data:ForecastPublicData={status:'ready',cases:[],reference:referenceForecast(),ruleVersion:'r',modelVersion:'m',generatedAt:now,cadence:snapshot()};
 assert.deepEqual(forecastRevision(data),forecastRevision({...data,generatedAt:new Date(time+60_000).toISOString()}));
 assert.notDeepEqual(forecastRevision(data),forecastRevision({...data,cadence:{...data.cadence!,id:'changed'}}));
 assert.notDeepEqual(forecastRevision(data),forecastRevision({...data,cadence:{...data.cadence!,status:'paused'}}));
});


test('按实际采集间隔判断新鲜度，不把降频后的健康来源误判为断流',()=>{
 const later=new Date(time+25*60_000).toISOString();
 assert.equal(cadenceSourcesAvailable([{...source,effectiveIntervalMinutes:10}],[source.id],later),true);
 assert.equal(cadenceSourcesAvailable([source],[source.id],later),false);
});
test('无变化只在六小时固定节点或到期结算点运行，新事实与更正立即失效',()=>{
 const runtime={id:'forecast_runtime',checkedAt:now,nextDueAt:cadenceNextFixedAt(now),cadencePublicProjection:{version:'cadence-public-20261016-1' as const,digest:'fixture',snapshots:[],horizonOutcomes:[]},cadenceModelVersion:RESET_CADENCE_MODEL_VERSION,inputsRevision:'a',cadenceSnapshotId:'auto',cadenceSnapshotIds:{automatic_reset:'auto',banked_reset:'bank'}};
 assert.equal(forecastCycleDue(runtime,'a',new Date(time+60_000).toISOString()),false);
 assert.equal(forecastCycleDue(runtime,'b',new Date(time+60_000).toISOString()),true);
 assert.equal(forecastCycleDue(runtime,'a',new Date(time+60_000).toISOString(),true),true);
 assert.equal(forecastCycleDue(runtime,'a',new Date(time+6*3600_000).toISOString()),true);
 assert.equal(forecastCycleDue({...runtime,cadenceSnapshotIds:undefined},'a',now),true,'旧单一模型必须升级');
});
test('24/48小时结局按同类型精确时间独立结算，无连续覆盖证明的缺事件一律未知',()=>{
 const fixed={...snapshot(),evaluationSample:true},before=structuredClone(fixed),at=(hours:number)=>new Date(time+hours*3600_000).toISOString();
 const observation={id:'new',kind:'automatic_reset' as const,timePrecision:'exact' as const,firstKnownAt:at(30),at:at(30),url:'https://x.com/thsottiaux/status/21000000000000001',evidenceIds:['new-proof']};
 assert.equal(resolveCadenceHorizon(fixed,[observation],24,at(23)),undefined);
 assert.equal(resolveCadenceHorizon(fixed,[observation],24,at(50))?.result,'unknown');
 const found=resolveCadenceHorizon(fixed,[observation],48,at(50))!;
 assert.equal(found.result,'occurred');assert.equal(found.scorable,true);assert.equal(found.actualAt,at(30));
 assert.equal(resolveCadenceHorizon(fixed,[{...observation,kind:'banked_reset'}],48,at(50))?.result,'unknown');
 assert.equal(resolveCadenceHorizon(fixed,[{...observation,timePrecision:'date'}],48,at(50))?.result,'unknown');
 assert.equal(resolveCadenceHorizon(fixed,[{...observation,firstKnownAt:at(49)}],48,at(50))?.scorable,false,'晚采事实不能美化实时预测成绩');
 assert.equal(resolveCadenceHorizon({...fixed,modelVersion:'old-mixed-model'},[observation],48,at(50)),undefined);
 assert.deepEqual(fixed,before);
});
test('真实评分仅使用当前版本的固定非重叠48小时队列，与同数据未平滑比例比较',()=>{
 const at=(hours:number)=>new Date(time+hours*3600_000).toISOString(),base={...snapshot(),evaluationSample:true,p48:.6,rawP48:.5};
 const samples=[{...base,id:'first'},{...base,id:'overlap',generatedAt:at(6)},{...base,id:'second',generatedAt:at(48)},{...base,id:'late',generatedAt:at(96)},{...base,id:'mixed',generatedAt:at(144),modelVersion:'old-model'}];
 const outcome=(id:string,result:CadenceHorizonOutcome['result'],scorable=true):CadenceHorizonOutcome=>{const start=samples.find(s=>s.id===id)?.generatedAt??now;return {id:`outcome-${id}`,recordType:'reset_cadence_horizon_outcome',snapshotId:id,target:'automatic_reset',modelVersion:base.modelVersion,horizonHours:48,windowStart:start,windowEnd:new Date(Date.parse(start)+48*3600_000).toISOString(),observedAt:at(200),result,scorable,...(result==='occurred'?{actualAt:new Date(Date.parse(start)+30*3600_000).toISOString()}:{}),evidenceIds:['fixture'],reason:'fixture'};};
 const rows=[outcome('first','occurred'),outcome('overlap','occurred'),outcome('second','unknown',false),outcome('late','occurred',false),outcome('mixed','occurred')];
 const value=evaluateCadence(samples,rows,'automatic_reset',at(200));
 assert.equal(value.maturedSamples,1);assert.equal(value.positiveSamples,1);assert.equal(value.unknownSamples,2);
 assert.ok(Math.abs(value.brierScore!-.16)<1e-12);assert.equal(value.baselineBrierScore,.25);assert.ok(Math.abs(value.skill!-.36)<1e-12);assert.equal(value.externalWeight,0);assert.equal(value.calibrated,false);
 const corrected=[...rows,{...outcome('first','unknown',false),id:'correction',observedAt:at(200),supersedes:'outcome-first'}];
 assert.equal(evaluateCadence(samples,corrected,'automatic_reset',at(202)).maturedSamples,0,'同一observedAt追加撤回后按supersedes链排除旧正例，不能由ID排序选回阳性');
});

function memoryClient(){
 const tables=new Map<string,Map<string,unknown>>();
 const client={query:async(sql:string,args:unknown[]=[])=>{
  const table=sql.match(/(?:FROM|INTO) radar_([a-z_]+)/)?.[1];if(!table)throw new Error('unexpected query');
  let rows=tables.get(table);if(!rows){rows=new Map();tables.set(table,rows);}
  if(sql.startsWith('INSERT')){const id=String(args[0]);if(rows.has(id))return {rows:[],rowCount:0};rows.set(id,JSON.parse(String(args[1])));return {rows:[],rowCount:1};}
  return {rows:[...rows.entries()].filter(([id])=>!sql.includes('WHERE id =')||id===args[0]).map(([,payload])=>({payload:structuredClone(payload)})),rowCount:rows.size};
 }} as unknown as Client;
 return {client,tables};
}
test('双模型六小时内幂等留档，到期补录与撤回只追加结局，不覆盖原快照',async()=>{
 const {client,tables}=memoryClient(),at=(hours:number)=>new Date(time+hours*3600_000).toISOString();
 const direct:Source={...source,id:'tibo-public',kind:'timeline',url:'https://api.fxtwitter.com/2/profile/thsottiaux/statuses',effectiveIntervalMinutes:10};
 const evidence=(i:number,hours:number,banked=false):Evidence=>({id:`e${i}`,sourceId:direct.id,messageId:String(21000000000000000n+BigInt(i)),url:`https://x.com/thsottiaux/status/${21000000000000000n+BigInt(i)}`,text:banked?'We have added a banked reset for all users.':'We have reset Codex usage limits for all users.',textOrigin:'original',provenance:'official',contextComplete:true,historical:false,publishedAt:at(hours),collectedAt:at(hours),hash:`hash-${i}`});
 const history=Array.from({length:14},(_,i)=>evidence(i,-12-(13-i)*48));
 const first=await executeResetCadence(client,history,[direct],now);
 assert.equal(first.snapshots,2);assert.ok(first.snapshotIds.automatic_reset);assert.ok(first.snapshotIds.banked_reset);assert.notEqual(first.snapshotIds.automatic_reset,first.snapshotIds.banked_reset);
 const frozen=structuredClone([...tables.get('forecast_snapshots')!.values()]);
 const again=await executeResetCadence(client,history,[{...direct,lastSuccessAt:at(.1)}],at(.1));
 assert.equal(again.snapshots,0);assert.deepEqual([...tables.get('forecast_snapshots')!.values()],frozen);
 const settled=await executeResetCadence(client,history,[{...direct,lastSuccessAt:at(50)}],at(50));
 assert.ok(settled.outcomes>=2);const initial=[...tables.get('forecast_outcomes')!.values()] as CadenceHorizonOutcome[];
 assert.ok(initial.every(o=>o.result==='unknown'));
 const late={...evidence(80,30),collectedAt:at(51)};
 await executeResetCadence(client,[...history,late],[{...direct,lastSuccessAt:at(51)}],at(51));
 const appended=[...tables.get('forecast_outcomes')!.values()] as CadenceHorizonOutcome[];
 assert.ok(appended.some(o=>o.result==='occurred'&&!o.scorable&&o.supersedes));
 assert.deepEqual(appended.filter(o=>initial.some(p=>p.id===o.id)),initial,'旧结局保留');
 const count=appended.length;
 await executeResetCadence(client,[...history,late],[{...direct,lastSuccessAt:at(51.1)}],at(51.1));
 assert.equal(tables.get('forecast_outcomes')!.size,count,'同输入重跑不重复追加修订');
});


test('公开投影兼容automatic入口，同时保留独立重置卡与固定评估，旧混合模型不作当前预测',()=>{
 const automatic=snapshot(),banked={...automatic,id:'banked',target:'banked_reset' as const};
 const evaluation=evaluateCadence([],[],'banked_reset',now);
 const facts={events:[],articles:[],publications:[],evidence:[],serverTime:now};
 const records={cases:[],outcomes:[],sources:[source],snapshots:[automatic,banked] as unknown as ForecastSnapshot[],runtime:{cadenceSnapshotId:automatic.id,cadenceSnapshotIds:{automatic_reset:automatic.id,banked_reset:banked.id},cadenceEvaluationByKind:{banked_reset:evaluation}},cadenceSnapshot:automatic};
 const view=projectPublicForecastRecords(records,now,facts,'home');
 assert.equal(view.cadence?.id,automatic.id);assert.equal(view.cadenceByKind?.banked_reset?.id,'banked');assert.deepEqual(view.cadenceEvaluationByKind?.banked_reset,evaluation);assert.deepEqual(view.cadenceHistory,[]);
 assert.notDeepEqual(forecastRevision(view),forecastRevision({...view,cadenceByKind:{...view.cadenceByKind,banked_reset:{...banked,id:'next-bank'}}}));
 const legacy={...automatic,modelVersion:'old-mixed',target:undefined};
 assert.equal(projectCadenceForecast(legacy,[source],now)?.status,'paused');assert.equal(projectCadenceForecast(legacy,[source],now)?.p48,null);
});

test('公开24/48小时结局只带当前和最近快照的最新修正，首页不传整组历史',()=>{
 const at=(hours:number)=>new Date(time+hours*3600_000).toISOString();
 const automatic=snapshot(),banked={...automatic,id:'banked',target:'banked_reset' as const},old={...automatic,id:'old',modelVersion:'old-mixed'},outside={...automatic,id:'outside',generatedAt:at(-500)};
 const outcome=(id:string,snapshotId:string,horizonHours:24|48,result:CadenceHorizonOutcome['result'],extra:Partial<CadenceHorizonOutcome>={}):CadenceHorizonOutcome=>({id,recordType:'reset_cadence_horizon_outcome',snapshotId,target:snapshotId==='banked'?'banked_reset':'automatic_reset',modelVersion:automatic.modelVersion,horizonHours,windowStart:automatic.generatedAt,windowEnd:at(horizonHours),observedAt:at(50),result,scorable:result==='occurred',evidenceIds:['proof'],reason:result==='unknown'?'无连续覆盖，未知':'公开动态已发生',...(result==='occurred'?{actualAt:at(20)}:{}),...extra});
 const original=outcome('old-positive',automatic.id,48,'occurred');
 const corrected=outcome('corrected-unknown',automatic.id,48,'unknown',{observedAt:at(50),supersedes:original.id});
 const rows=[original,corrected,outcome('unknown24',automatic.id,24,'unknown'),outcome('banked48','banked',48,'occurred'),outcome('old-model','old',48,'occurred',{modelVersion:'old-mixed'}),outcome('outside-history','outside',48,'occurred',{windowStart:outside.generatedAt,windowEnd:at(-452)}),outcome('wrong-target',automatic.id,48,'occurred',{target:'banked_reset',observedAt:at(52)}),outcome('future',automatic.id,24,'occurred',{observedAt:at(100)})];
 const facts={events:[],articles:[],publications:[],evidence:[],serverTime:at(60)};
 const records={cases:[],outcomes:rows as unknown as import('../src/lib/forecast').ForecastOutcome[],sources:[{...source,lastSuccessAt:at(60)}],snapshots:[automatic,banked,old,...Array.from({length:12},(_,i)=>({...automatic,id:`recent-${i}`,generatedAt:at(-i-1)})),outside] as unknown as ForecastSnapshot[],runtime:{cadenceSnapshotId:automatic.id,cadenceSnapshotIds:{automatic_reset:automatic.id,banked_reset:'banked'}},cadenceSnapshot:automatic};
 const view=projectPublicForecastRecords(records,at(60),facts,true),selected=view.cadenceHorizonOutcomes!;
 assert.deepEqual(selected.map(o=>o.id).sort(),['banked48','corrected-unknown','unknown24']);
 assert.equal(selected.find(o=>o.snapshotId===automatic.id&&o.horizonHours===48)?.result,'unknown');
 assert.equal(projectPublicForecastRecords(records,at(60),facts,'home').cadenceHorizonOutcomes,undefined);
 assert.notDeepEqual(forecastRevision(view),forecastRevision({...view,cadenceHorizonOutcomes:selected.filter(o=>o.id!=='corrected-unknown')}));
 assert.equal(original.result,'occurred','投影不改旧结局');assert.equal(automatic.p48,snapshot().p48,'投影不改冻结概率');
});
