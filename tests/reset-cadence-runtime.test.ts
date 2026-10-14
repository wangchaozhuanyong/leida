import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResetCadenceForecast} from '../src/lib/reset-cadence';
import {cadenceSourcesAvailable,projectCadenceForecast,type StoredCadenceForecast} from '../src/server/reset-cadence-runtime';
import {forecastRevision} from '../src/lib/forecast-display';
import {referenceForecast,type ForecastPublicData} from '../src/lib/forecast';
import type {Source} from '../src/lib/types';

const now='2026-10-10T00:00:00Z',time=Date.parse(now);
const source:Source={id:'reset-archive',name:'test',kind:'archive',url:'https://codex-resets.com/zh-CN',enabled:true,validated:true,status:'healthy',lastSuccessAt:now,intervalMinutes:5,version:1};
const snapshot=():StoredCadenceForecast=>({...buildResetCadenceForecast({observations:Array.from({length:14},(_,i)=>({id:`o${i}`,evidenceIds:[`e${i}`],at:new Date(time-12*3600_000-(13-i)*48*3600_000).toISOString(),url:`https://x.com/thsottiaux/status/${i+1}`,kind:'automatic_reset'})),generatedAt:now,inputFingerprint:'fixture'}),recordType:'reset_cadence',sourceIds:[source.id]});

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
