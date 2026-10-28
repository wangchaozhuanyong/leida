import test from 'node:test';
import assert from 'node:assert/strict';
import {buildForecastSnapshot,forecastWindows,referenceForecast,type ForecastCase,type ForecastPublicData} from '../src/lib/forecast';
import {forecastRevision,forecastExplanationText} from '../src/lib/forecast-display';
import {publicRevision} from '../src/server/public-version';
import {forecastPosterSvg} from '../src/server/forecast-poster';
import {fullTime} from '../src/lib/labels';
import type {PublicData} from '../src/lib/types';
import {createPosterFromEndpoint} from '../src/components/public/poster-image';

const signalAt='2026-10-10T00:00:00Z';
const caseFixture:ForecastCase={id:'case-public',identity:'test',title:'隔离实验信号<&>',url:'https://status.openai.com/incidents/abc',sourceId:'status',signalEvidenceIds:['e1'],target:'automatic_reset',signalAt,collectedAt:signalAt,windows:forecastWindows(signalAt),status:'watching',coverage:{status:'unverified',sourceIds:['status'],reason:'连续覆盖未核验'},late:false,snapshotId:'snapshot-public',createdAt:signalAt,updatedAt:signalAt};
const snapshot=()=>buildForecastSnapshot({id:'snapshot-public',signature:'fixed',case:caseFixture,generatedAt:'2026-10-10T00:01:00Z',evidenceCutoffAt:'2026-10-10T00:01:00Z',cases:[],outcomes:[]});
const forecast=():ForecastPublicData=>({status:'ready',ruleVersion:'rule',modelVersion:'model',generatedAt:signalAt,cases:[{...caseFixture,snapshot:snapshot(),outcomes:[]}],reference:referenceForecast()});
const data=(forecasts:ForecastPublicData):PublicData=>({events:[],articles:[],publications:[],evidence:[],notices:[],activities:[],site:{name:'模钥重置雷达',description:'',version:1,autoPublish:true},sources:[],serverTime:signalAt,forecasts});

test('预测海报使用用户说明，历史概率、来源等级、时间与内部说明不被改写',()=>{
 for(const basis of ['late','already_known','insufficient','verified_live','experimental_seed'] as const){
  const fixed={...snapshot(),basis,explanation:'内部处理说明：实时结局尚不用于训练。'};
  if(['late','already_known','insufficient'].includes(basis)){fixed.p24=null;fixed.p48=null;fixed.interval24=null;fixed.interval48=null;}
  const before=structuredClone(fixed),text=forecastExplanationText(fixed);
  const svg=forecastPosterSvg(fixed,'模钥重置雷达','https://radar.example/methodology?snapshot=snapshot-public');
  assert.ok(svg.includes(text));assert.doesNotMatch(svg,/内部处理说明|规则批次|固定快照/);
  assert.match(svg,/来源连续覆盖未核验/);assert.ok(svg.includes(fullTime(fixed.windows[48])));
  assert.deepEqual(fixed,before);
 }
});

test('预测轮询版本忽略读取时钟、结局与暂停会改变公开版本',()=>{
 const original=forecast(),next={...original,generatedAt:'2026-10-10T00:03:00Z'};
 assert.deepEqual(forecastRevision(next),forecastRevision(original));assert.equal(publicRevision(data(next)),publicRevision(data(original)));
 const paused={...original,cases:original.cases.map(c=>({...c,status:'paused' as const}))};
 assert.notEqual(publicRevision(data(paused)),publicRevision(data(original)));
 const outcome={id:'outcome',caseId:caseFixture.id,target:'automatic_reset' as const,stage:'unknown' as const,evidenceIds:[],observedAt:'2026-10-12T00:00:00Z',relation:'unmatched' as const,relationVerified:false,actualDelivery:'unobserved' as const,reason:'未知',signature:'o'};
 assert.notEqual(publicRevision(data({...original,cases:[{...original.cases[0],outcomes:[outcome]}]})),publicRevision(data(original)));
});

test('预测海报只读取冻结快照，时间、窗口、实验标签与共享快照一致',()=>{
 const fixed=snapshot(),url='https://radar.example/methodology?snapshot=snapshot-public';
 const original=forecastPosterSvg(fixed,'模钥重置雷达',url);
 assert.match(original,/24小时：30%/);assert.match(original,/48小时：80%/);assert.ok(original.includes(fullTime(fixed.windows[24])));assert.ok(original.includes(fullTime(fixed.windows[48])));
 assert.match(original,/实际到账以账户显示为准/);assert.match(original,/覆盖未核验/);assert.match(original,/snapshot-public/);
 assert.match(original,/这是当时的预测/);assert.equal(forecastPosterSvg(structuredClone(fixed),'模钥重置雷达',url),original);
 const card={...fixed,target:'banked_reset' as const,p24:null,p48:null,interval24:null,interval48:null,sampleCount:0};
 assert.match(forecastPosterSvg(card,'模钥重置雷达',url),/样本不足/);assert.doesNotMatch(forecastPosterSvg(card,'模钥重置雷达',url),/80%/);
});

test('图片生成入口允许固定预测海报，仍拒绝管理地址和外部链接',async()=>{
 const original=globalThis.fetch,requests:string[]=[];
 globalThis.fetch=async(input)=>{requests.push(String(input));return new Response('模拟暂不可用',{status:503});};
 try {
  await assert.rejects(createPosterFromEndpoint('/api/v1/forecast-posters/snapshot-public','实验.png',new AbortController().signal),/海报生成失败/);
  assert.deepEqual(requests,['/api/v1/forecast-posters/snapshot-public']);
  for(const url of ['/api/admin/data','https://example.com/api/v1/forecast-posters/id'])await assert.rejects(createPosterFromEndpoint(url,'实验.png',new AbortController().signal),/地址无效/);
  assert.equal(requests.length,1);
 }finally{globalThis.fetch=original;}
});
