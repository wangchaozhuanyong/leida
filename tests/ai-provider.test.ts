import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db';
import { AIServiceError, accountCompletionResponse, buildGenerationPrompt, completionContent, defaultAI, generateContent, prepareCompletionRequest, type AIRecord, type CompletionResponse } from '../src/server/ai';
import type { DraftContent, Evidence } from '../src/lib/types';

const model='qwen3.7-flash-2026-07-15';
const settings:AIRecord={...defaultAI,id:'ai',enabled:true,hasKey:true,encryptedKey:'not-decrypted-test-placeholder',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',model,testedAt:'2026-10-09T08:00:00Z',dailyCallLimit:100,dailyBudget:1,inputPrice:0.2,outputPrice:0.8,currency:'CNY',version:1};
function evidence(patch:Partial<Evidence>={}):Evidence {
  return {id:'e1',sourceId:'source1',messageId:'post1',url:'https://example.com/post1',text:'Exact original source text',publishedAt:'2026-10-09T08:00:00Z',collectedAt:'2026-10-09T08:01:00Z',hash:'test-hash',contextComplete:true,historical:false,provenance:'official',textOrigin:'original',...patch};
}

test('百炼固定型号关闭思考并请求JSON，输入预算覆盖整个请求体',()=>{
  const request=prepareCompletionRequest('请返回 {"ok":true}，保留\\转义与中文',settings);
  const body=JSON.parse(request.body);
  assert.equal(request.endpoint.href,'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(body.model,model); assert.equal(body.enable_thinking,false);
  assert.deepEqual(body.response_format,{type:'json_object'});
  assert.equal(body.extra_body,undefined); assert.equal(body.max_tokens,1800);
  assert.equal(body.messages[0].role,'system'); assert.match(body.messages[0].content,/只返回请求的JSON/);
  assert.equal(body.messages[1].content,'请返回 {"ok":true}，保留\\转义与中文');
  assert.equal(request.inputBound,Buffer.byteLength(request.body,'utf8')+2048);
  assert.equal(defaultAI.currency,'CNY'); assert.equal(settings.inputPrice,0.2); assert.equal(settings.outputPrice,0.8);
});

test('北京和新加坡官方业务空间及legacy域名均适配所选型号',()=>{
  for(const host of ['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','workspace-123.cn-beijing.maas.aliyuncs.com','workspace-123.ap-southeast-1.maas.aliyuncs.com']) {
    const {body,endpoint}=prepareCompletionRequest('{}',{...settings,baseUrl:`https://${host}/compatible-mode/v1/`});
    assert.equal(JSON.parse(body).enable_thinking,false); assert.deepEqual(JSON.parse(body).response_format,{type:'json_object'});
    assert.equal(endpoint.hostname,host); assert.equal(endpoint.pathname,'/compatible-mode/v1/chat/completions');
  }
});

test('仿冒域名、其他区域和其他型号不携带百炼专用参数',()=>{
  for(const host of ['dashscope.aliyuncs.com.example.com','fake-dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com.example.com','workspace.cn-beijing.maas.aliyuncs.com.example.com','workspace.cn-beijing.maas.aliyuncs.com.evil.com','nested.workspace.cn-beijing.maas.aliyuncs.com','cn-beijing.maas.aliyuncs.com','-workspace.cn-beijing.maas.aliyuncs.com','workspace.us-east-1.maas.aliyuncs.com','api.example.com']) {
    const body=JSON.parse(prepareCompletionRequest('{}',{...settings,baseUrl:`https://${host}/v1`}).body);
    assert.equal(body.enable_thinking,undefined,host); assert.equal(body.response_format,undefined,host);
  }
  const body=JSON.parse(prepareCompletionRequest('{}',{...settings,model:'qwen-other'}).body);
  assert.equal(body.enable_thinking,undefined); assert.equal(body.response_format,undefined);
});

test('32000的完整输入上界允许请求，超过一个字节则容量暂缓',()=>{
  const baseline=prepareCompletionRequest('',settings).inputBound;
  const permitted=prepareCompletionRequest('a'.repeat(32000-baseline),settings);
  assert.equal(permitted.inputBound,32000);
  assert.throws(()=>prepareCompletionRequest('a'.repeat(32001-baseline),settings),(error:unknown)=>error instanceof AIServiceError&&error.failureKind==='capacity');
  assert.throws(()=>prepareCompletionRequest('中'.repeat(11000),settings),(error:unknown)=>error instanceof AIServiceError&&error.failureKind==='capacity');
  assert.throws(()=>prepareCompletionRequest('"'.repeat(16000),settings),(error:unknown)=>error instanceof AIServiceError&&error.failureKind==='capacity');
  assert.doesNotThrow(()=>prepareCompletionRequest('a'.repeat(50000),{...settings,baseUrl:'https://api.example.com/v1'}));
});

test('生成提示保留完整JSON、必要父帖和辅助来源身份，不截断正文或现有草稿',()=>{
  const parent=evidence({id:'parent',messageId:'parent-post',text:'P'.repeat(17000)+' 原帖结尾：限定 Plus 用户。',metadata:{sourceGroup:'same-archive',title:'归档描述不能冒充原帖'},historical:true});
  const child=evidence({id:'child',parentId:parent.id,text:'C'.repeat(6000)+' 回复结尾 "complete"\n仍应保留。'});
  const existing:DraftContent={title:'保留人工标题',summary:'已有摘要',translation:'已有译文',category:'reset',eventId:'event1',actions:[],evidenceIds:['child'],contextEvidenceIds:['parent'],contentOrigin:'template',publicationMode:'news_only'};
  const prompt=buildGenerationPrompt([parent,child],existing);
  const [draftJson,evidenceJson]=prompt.split('现有草稿：')[1].split('\n证据：');
  assert.deepEqual(JSON.parse(draftJson),existing); assert.deepEqual(JSON.parse(evidenceJson),[parent,child]);
  const request=prepareCompletionRequest(prompt,{...settings,baseUrl:'https://api.example.com/v1'});
  assert.equal(JSON.parse(request.body).messages[1].content,prompt);
  assert.match(prompt,/metadata是辅助归档描述，不是原帖原文/);
  assert.equal(JSON.parse(evidenceJson)[1].parentId,'parent');
});

test('超长证据在费用预留和模型请求前拒绝，不访问真实数据库',async()=>{
  const originalQuery=pool.query,originalConnect=pool.connect;
  let settingsReads=0,reservationAttempts=0;
  pool.query=(async(...args:unknown[])=>{
    assert.equal(args[0],'SELECT payload FROM radar_settings WHERE id = $1');
    assert.deepEqual(args[1],['ai']); settingsReads++;
    return {rows:[{payload:settings}],rowCount:1};
  }) as typeof pool.query;
  pool.connect=(async()=>{reservationAttempts++;throw new Error('测试禁止费用预留与真实数据库连接');}) as typeof pool.connect;
  try {
    await assert.rejects(generateContent([evidence({text:'中文必要原文'.repeat(10000)})]),(error:unknown)=>error instanceof AIServiceError&&error.failureKind==='capacity');
    assert.equal(settingsReads,1); assert.equal(reservationAttempts,0);
  } finally {pool.query=originalQuery;pool.connect=originalConnect;}
});

test('正常结束和缺结束字段的兼容接口保留正文',()=>{
  const content=' {"title":"真实中文标题","summary":"依据原文","translation":"完整译文"} ';
  for(const finish_reason of ['stop',undefined,null])assert.equal(completionContent({choices:[{finish_reason,message:{content}}]}),content);
});

test('输出截断即使碰巧是合法JSON也不能当完整新闻',()=>{
  assert.throws(()=>completionContent({choices:[{finish_reason:'length',message:{content:'{"title":"部分译文"}'}}]}),(error:unknown)=>error instanceof AIServiceError&&error.failureKind==='validation'&&/截断/.test(error.message));
});

test('拒绝和过滤只返回固定中文错误，不输出供应商原始消息',()=>{
  const providerPrivateMessage='provider-private-reason-do-not-log';
  for(const response of [
    {choices:[{finish_reason:'stop',message:{content:'{"title":"看似正常"}',refusal:providerPrivateMessage}}]},
    {choices:[{finish_reason:'content_filter',message:{content:providerPrivateMessage}}]},
  ])assert.throws(()=>completionContent(response),(error:unknown)=>error instanceof AIServiceError&&error.failureKind==='validation'&&!error.message.includes(providerPrivateMessage));
});

test('资源中断可恢复；其他明确未结束原因不能发布',()=>{
  assert.throws(()=>completionContent({choices:[{finish_reason:'insufficient_system_resource',message:{content:'{"title":"残留内容"}'}}]}),(error:unknown)=>error instanceof AIServiceError&&error.failureKind==='transient');
  for(const finish_reason of ['tool_calls','function_call','cancelled','provider-private-unknown-reason'])assert.throws(()=>completionContent({choices:[{finish_reason,message:{content:'{}'}}]}),(error:unknown)=>error instanceof AIServiceError&&error.failureKind==='validation'&&!error.message.includes(finish_reason));
});

test('空白、缺正文或非字符串正文均不能进入新闻生成',()=>{
  for(const response of [{},{choices:[]},{choices:[{}]},{choices:[{message:{content:null}}]},{choices:[{message:{content:''}}]},{choices:[{message:{content:'\n\t '}}]},{choices:[{message:{content:42}}]}])assert.throws(()=>completionContent(response as CompletionResponse),(error:unknown)=>error instanceof AIServiceError&&error.failureKind==='validation');
});

test('拒绝、截断和资源不足响应先按实际用量记账，再交给自动恢复',async()=>{
  const originalQuery=pool.query;
  let accounted=false;
  const records:unknown[][]=[];
  pool.query=(async(...args:unknown[])=>{
    assert.match(String(args[0]),/^UPDATE radar_ai_usage SET input_tokens=/);
    await Promise.resolve();records.push(args[1] as unknown[]);accounted=true;
    return {rows:[],rowCount:1};
  }) as typeof pool.query;
  try {
    for(const finish_reason of ['length','content_filter','insufficient_system_resource']){
      accounted=false;
      await assert.rejects(accountCompletionResponse({choices:[{finish_reason,message:{content:'{}'}}],usage:{prompt_tokens:200,completion_tokens:50}},'fixture-usage',settings,9000),(error:unknown)=>accounted&&error instanceof AIServiceError);
      assert.deepEqual(records.at(-1),['fixture-usage',200,50,(200*0.2+50*0.8)/1_000_000,'succeeded']);
    }
    accounted=false;
    await assert.rejects(accountCompletionResponse({choices:[{message:{content:'{}',refusal:'not-for-logs'}}],usage:{prompt_tokens:200,completion_tokens:50}},'fixture-refusal',settings,9000),(error:unknown)=>accounted&&error instanceof AIServiceError&&!error.message.includes('not-for-logs'));
    assert.equal(records.at(-1)?.[0],'fixture-refusal');
    assert.equal(records.at(-1)?.[3],(200*0.2+50*0.8)/1_000_000);
  } finally {pool.query=originalQuery;}
});

test('缺少有效用量时保守费用不丢失，记账失败不返回可发布内容',async()=>{
  const originalQuery=pool.query;
  const records:unknown[][]=[];
  pool.query=(async(...args:unknown[])=>{records.push(args[1] as unknown[]);return {rows:[],rowCount:1};}) as typeof pool.query;
  try {
    assert.equal(await accountCompletionResponse({choices:[{message:{content:'{"ok":true}'}}]},'fixture-estimated',settings,9000),'{"ok":true}');
    assert.deepEqual(records.at(-1),['fixture-estimated',9000,1800,(9000*0.2+1800*0.8)/1_000_000,'estimated']);
    await assert.rejects(accountCompletionResponse({choices:[{finish_reason:'length',message:{content:'{}'}}]},'fixture-estimated-rejected',settings,9000),AIServiceError);
    assert.equal(records.at(-1)?.[4],'estimated');
    pool.query=(async()=>{throw new Error('fixture-storage-interrupted');}) as typeof pool.query;
    await assert.rejects(accountCompletionResponse({choices:[{message:{content:'{"ok":true}'}}],usage:{prompt_tokens:200,completion_tokens:50}},'fixture-storage',settings,9000),/fixture-storage-interrupted/);
  } finally {pool.query=originalQuery;}
});
