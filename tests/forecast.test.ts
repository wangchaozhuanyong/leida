import test from 'node:test';
import assert from 'node:assert/strict';
import {forecastEstimate,betaCdf,forecastWindows,buildForecastSnapshot,referenceForecast,publicForecastCaseProjection,qualifyForecastSignal,type ForecastCase} from '../src/lib/forecast';
import {forecastTablesAvailable,getPublicForecast,getForecastSnapshot} from '../src/server/forecast';
import type {Client} from '../src/db';
import type {Evidence,Source} from '../src/lib/types';

const fixture=():ForecastCase=>({id:'fixture',identity:'openai-status:fixture',title:'固定标题',url:'https://status.openai.com/incidents/fixture',sourceId:'source',signalEvidenceIds:['signal'],target:'automatic_reset',signalAt:'2026-10-10T00:00:00Z',collectedAt:'2026-10-10T00:01:00Z',windows:forecastWindows('2026-10-10T00:00:00Z'),status:'watching',coverage:{status:'unverified',sourceIds:['source'],reason:'隔离夹具未核验覆盖'},late:false,snapshotId:'snapshot',createdAt:'2026-10-10T00:01:00Z',updatedAt:'2026-10-10T00:01:00Z'});
test('三例种子Dirichlet及Beta区间可复现，重置卡和零样本不套概率',()=>{
 const value=forecastEstimate([1,2,0],'automatic_reset');assert.equal(value.p24,.3);assert.equal(value.p48,.8);
 assert.ok(Math.abs(value.interval48![0]-.025**.25)<1e-12);assert.ok(Math.abs(value.interval48![1]-.975**.25)<1e-12);
 assert.ok(Math.abs(betaCdf(value.interval24![0],1.5,3.5)-.025)<1e-10);
 assert.equal(forecastEstimate([1,2,0],'banked_reset').p48,null);assert.equal(forecastEstimate([0,0,0],'automatic_reset').p48,null);
 assert.equal(referenceForecast().calibrated,false);assert.equal(referenceForecast().coverage,'unverified');
});
test('正文明确to be consumed faster无需异常标题兜底',()=>{
 const time='2026-10-10T00:00:00Z',source:Source={id:'source',name:'official fixture',kind:'status',url:'https://status.openai.com/api/v2/incidents.json',enabled:true,validated:true,intervalMinutes:5,version:1,status:'healthy',lastSuccessAt:time};
 const e:Evidence={id:'e',sourceId:'source',messageId:'update',url:'https://status.openai.com/incidents/fixture',text:'We identified an issue causing Codex usage to be consumed faster than expected.',metadata:{title:'Codex Usage'},publishedAt:time,collectedAt:time,contextComplete:true,historical:false,provenance:'official',textOrigin:'structured',hash:'fixture'};
 assert.equal(qualifyForecastSignal(e,source)?.identity,'openai-status:fixture');assert.equal(qualifyForecastSignal({...e,text:'Codex experienced errors. The issue is resolved.'},source),undefined);
});
test('固定快照首报与窗口；late24保守不输出预测，冻结标题不跟case变',()=>{
 const c=fixture(),saved=structuredClone(c),snapshot=buildForecastSnapshot({id:'snapshot',signature:'fixture',case:c,generatedAt:'2026-10-10T00:02:00Z',evidenceCutoffAt:'2026-10-10T00:02:00Z',cases:[],outcomes:[]});
 assert.equal(snapshot.p48,.8);assert.equal(snapshot.basis,'experimental_seed');assert.equal(snapshot.trainingApplied,false);assert.deepEqual(snapshot.windows,c.windows);
 c.title='后改标题';assert.equal(snapshot.title,saved.title);assert.equal(snapshot.generatedAt,'2026-10-10T00:02:00Z');
 const late=buildForecastSnapshot({id:'late',signature:'late',case:c,generatedAt:'2026-10-11T00:01:00Z',evidenceCutoffAt:'2026-10-11T00:01:00Z',cases:[],outcomes:[]});assert.equal(late.p24,null);assert.equal(late.p48,null);assert.equal(late.late,true);assert.equal(late.lateWindows[48],false);
});
test('公开投影按固定截止隐藏过期目标与暂停，不改变快照',()=>{
 const c=fixture(),snapshot=buildForecastSnapshot({id:'snapshot',signature:'fixture',case:c,generatedAt:'2026-10-10T00:02:00Z',evidenceCutoffAt:'2026-10-10T00:02:00Z',cases:[],outcomes:[]}),before=structuredClone(snapshot);
 assert.deepEqual(publicForecastCaseProjection(c,snapshot,'2026-10-11T01:00:00Z'),{status:'watching',current:true,current24:false,current48:true});
 assert.equal(publicForecastCaseProjection(c,snapshot,'2026-10-12T00:00:00Z').current,false);
 assert.equal(publicForecastCaseProjection({...c,coverage:{...c.coverage,status:'gap'}},snapshot,'2026-10-10T01:00:00Z').status,'paused');assert.deepEqual(snapshot,before);
});
test('未迁移只查to_regclass，无失败事务、无缺表读取',async()=>{
 const calls:string[]=[],client={query:async(sql:string)=>{calls.push(sql);return {rows:[{cases:null,snapshots:null,outcomes:null}]};}} as unknown as Client;
 assert.equal(await forecastTablesAvailable(client),false);const data=await getPublicForecast(client);assert.equal(data.status,'unavailable');assert.equal(data.cases.length,0);
 assert.equal(await getForecastSnapshot(`forecast_snapshot_${'a'.repeat(64)}`,client),undefined);assert.ok(calls.every(sql=>sql.includes('to_regclass')));
});
