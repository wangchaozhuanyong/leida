import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {buildResetCadenceForecast,type CadenceTarget} from '../src/lib/reset-cadence';

const require=createRequire(import.meta.url);
const {createTransport,createWechatTransport}=require('../miniprogram/utils/transport.js');
const {validateCadenceSnapshot}=require('../miniprogram/utils/cadence.js');
const generatedAt='2020-10-16T06:00:00.000Z';
const id=`forecast_cadence_${'a'.repeat(64)}`;
const path=`/api/v1/forecasts/cadence/${id}`;
const httpsConfig={mode:'https',baseUrl:'https://public.example.org',cloudEnv:'',serviceName:''};

function snapshot(target:CadenceTarget='automatic_reset') {
  const start=Date.parse(generatedAt)-12*48*3600000;
  const observations=Array.from({length:13},(_,i)=>{
    const at=new Date(start+i*48*3600000).toISOString();
    return {id:`${target}-${i}`,evidenceIds:[`evidence-${i}`],at,url:`https://x.com/example/status/${100+i}`,kind:target,timePrecision:'exact' as const,firstKnownAt:at};
  });
  return {...buildResetCadenceForecast({observations,target,generatedAt,inputFingerprint:'a'.repeat(64)}),id,recordType:'reset_cadence' as const,sourceIds:['tibo-public']};
}
function mock(body:unknown,mode:'https'|'cloud'='https') {
  const calls:any[]=[];
  const response={statusCode:200,data:body};
  const wxApi={
    request(options:any){calls.push(options);queueMicrotask(()=>options.success(response));return {abort(){}};},
    cloud:{init(){},callContainer(options:any){calls.push(options);return Promise.resolve(response);}}
  };
  const config=mode==='https'?httpsConfig:{mode:'cloud',baseUrl:'',cloudEnv:'isolated-test-env',serviceName:'test-service'};
  return {request:createTransport(wxApi,config),privateRequest:createWechatTransport(wxApi,config),calls};
}

test('固定重置预测通过真实原生 HTTPS 和云调用读取，保留匿名 GET 及完整冻结内容',async()=>{
  for(const mode of ['https','cloud'] as const)for(const target of ['automatic_reset','banked_reset'] as const){
    const original=snapshot(target),before=structuredClone(original),transport=mock({data:original},mode);
    assert.deepEqual((await transport.request(path).promise).data,original);
    assert.deepEqual(original,before);assert.equal(transport.calls.length,1);
    const call=transport.calls[0];assert.equal(call.method,'GET');assert.equal(call.header.Authorization,undefined);assert.equal(call.data,undefined);
    if(mode==='https')assert.equal(call.url,httpsConfig.baseUrl+path);
    else{assert.equal(call.path,path);assert.equal(call.header['X-WX-SERVICE'],'test-service');}
  }
});

test('已过期的旧混合模型仍可复盘，不要求新 target、精度或原始基线字段',async()=>{
  const legacy:any=snapshot();delete legacy.target;delete legacy.rawP24;delete legacy.rawP48;
  legacy.modelVersion='conditional-empirical-reset-cadence-20261012-3';legacy.eligibleCount=4;
  for(const row of legacy.observations){delete row.timePrecision;delete row.firstKnownAt;}
  assert.equal(validateCadenceSnapshot(legacy),true);
  assert.deepEqual((await mock({data:legacy}).request(path).promise).data,legacy);
});

test('积累、暂停、超出范围记录的空概率仍是合法固定记录',async()=>{
  for(const status of ['insufficient','paused','out_of_range']){
    const value:any={...snapshot(),status,p24:null,p48:null,rawP24:null,rawP48:null,predictedAt:null,windowStart:null,windowEnd:null};
    assert.deepEqual((await mock({data:value}).request(path).promise).data,value);
  }
});

test('固定重置预测拒绝错误 ID、异常状态、概率、时间及不完整的数组合同',async()=>{
  const mutations:Array<[string,(value:any)=>void]>=[
    ['wrong id',value=>{value.id=`forecast_cadence_${'b'.repeat(64)}`;}],
    ['record type',value=>{value.recordType='other';}],
    ['status',value=>{value.status='complete';}],
    ['probability range',value=>{value.p48=1.01;}],
    ['probability NaN',value=>{value.p24=NaN;}],
    ['probability order',value=>{value.p24=.9;value.p48=.5;}],
    ['ready missing probability',value=>{value.p24=null;}],
    ['paused has probability',value=>{value.status='paused';}],
    ['future generation',value=>{value.generatedAt='2999-01-01T00:00:00.000Z';value.validUntil='2999-01-01T06:00:00.000Z';}],
    ['invalid calendar',value=>{value.generatedAt='2020-02-30T06:00:00.000Z';}],
    ['cutoff after generation',value=>{value.cutoffAt='2020-10-16T06:00:01.000Z';}],
    ['invalid expiry',value=>{value.validUntil=value.generatedAt;}],
    ['unbounded expiry',value=>{value.validUntil='2020-10-17T06:00:00.000Z';}],
    ['window reversed',value=>{value.windowStart='2020-10-19T06:00:00.000Z';}],
    ['target missing on current',value=>{delete value.target;}],
    ['eligible count',value=>{value.eligibleCount=4;}],
    ['fractional samples',value=>{value.sampleCount=8.5;}],
    ['observations missing',value=>{delete value.observations;}],
    ['observation future',value=>{value.observations[0].firstKnownAt='2999-01-01T00:00:00.000Z';}],
    ['interval missing',value=>{value.trainingIntervals=[{}];}],
    ['interval inconsistent',value=>{value.historicalIntervals[0].hours=1;}],
    ['backtest invalid',value=>{value.backtest.entries=[{}];}],
    ['backtest counts',value=>{value.backtest.hits=value.backtest.tests+1;}],
    ['source IDs invalid',value=>{value.sourceIds=[{}];}]
  ];
  for(const [label,mutate] of mutations){
    const value=snapshot();mutate(value);const transport=mock({data:value});
    await assert.rejects(transport.request(path).promise,/格式不完整/,label);
    assert.equal(transport.calls.length,1,label);
  }
  for(const body of [null,{data:null},{data:{id}},{data:{snapshot:snapshot()}}])await assert.rejects(mock(body).request(path).promise,/格式不完整/);
});

test('重置预测只允许精确固定 ID，越界路径及私有 transport 均在发请求前拒绝',async()=>{
  for(const invalid of [
    '/api/v1/forecasts/cadence/arbitrary',`${path}/extra`,`${path}?current=1`,`${path}#fragment`,
    path.replace('a'.repeat(64),'A'.repeat(64)),path.replace('a'.repeat(64),'a'.repeat(63)),
    path.replace('a'.repeat(64),'a'.repeat(65)),'/api/v1/forecasts/cadence/../admin',
    '/api/v1/forecasts/cadence/%2e%2e','/api/admin/forecasts/cadence/'+id
  ]){
    const transport=mock({data:snapshot()});
    await assert.rejects(transport.request(invalid).promise,/不受支持/,invalid);assert.equal(transport.calls.length,0);
  }
  const transport=mock({data:snapshot()});
  await assert.rejects(transport.privateRequest(path,{sessionToken:'isolated-not-real'}).promise,/不受支持/);assert.equal(transport.calls.length,0);
});

function fixedPage(value:unknown,query:Record<string,string>={cadence:id}) {
  const transport=mock({data:value});let registration:any;
  const filename=new URL('../miniprogram/pages/methodology/index.js',import.meta.url);
  runInNewContext(readFileSync(filename,'utf8'),{Page:(page:unknown)=>{registration=page;},require:createRequire(filename),getApp:()=>({publicApi:transport.request}),Date});
  const page:any={...registration,data:structuredClone(registration.data),setData(patch:unknown){Object.assign(this.data,patch);}};
  page.onLoad(query);return {page,calls:transport.calls};
}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('原生观察详情实际使用 cadence 路由读取冻结快照，旧记录明确标注历史模型',async()=>{
  const original=snapshot(),current=fixedPage(original);await flush();
  assert.equal(current.calls[0].url,httpsConfig.baseUrl+path);assert.deepEqual(current.page.data.cadenceSnapshot,original);
  assert.equal(current.page.data.fixedError,'');assert.equal(current.page.data.fixedLoading,false);
  const legacy:any={...snapshot(),modelVersion:'conditional-empirical-reset-cadence-20261012-3'};delete legacy.target;
  const old=fixedPage(legacy);await flush();assert.match(old.page.data.cadenceNote,/旧记录仅用于复盘/);
  const invalid=fixedPage(original,{cadence:'arbitrary'});await flush();
  assert.equal(invalid.calls.length,0);assert.match(invalid.page.data.fixedError,/链接无效/);
});
