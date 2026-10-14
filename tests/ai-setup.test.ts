import test from 'node:test';
import assert from 'node:assert/strict';
import { aiConfigurationComplete, aiSetupStep, applyAIRecommendation } from '../src/lib/ai-setup';
import type { AISettings } from '../src/lib/types';

const empty:AISettings={enabled:false,baseUrl:'',model:'',hasKey:false,dailyCallLimit:0,dailyBudget:0,inputPrice:0,outputPrice:0,currency:'CNY',version:9,callsToday:7};

test('首次推荐仅填表，不能伪造密钥、启用或连接测试状态',()=>{
  const before=structuredClone(empty),result=applyAIRecommendation(empty)!;
  assert.equal(result.enabled,false);assert.equal(result.hasKey,false);assert.equal(result.testedAt,undefined);
  assert.equal(result.version,9);assert.equal(result.callsToday,7);assert.deepEqual(empty,before);
  assert.equal(aiConfigurationComplete(result),false);assert.equal(aiSetupStep(result).label,'待填写配置');
});

test('已有接口或密钥时禁止推荐配置重用凭证和覆盖既有服务',()=>{
  for(const patch of [{hasKey:true},{baseUrl:'https://example.com/v1'},{model:'own-model'}])assert.equal(applyAIRecommendation({...empty,...patch}),undefined);
});

test('预算和计价缺失或非有限数字时不能进入测试和自动处理阶段',()=>{
  const complete={...applyAIRecommendation(empty)!,hasKey:true};
  assert.equal(aiConfigurationComplete(complete),true);
  for(const key of ['dailyCallLimit','dailyBudget','inputPrice','outputPrice'] as const){
    for(const value of [0,-1,NaN,Infinity])assert.equal(aiConfigurationComplete({...complete,[key]:value}),false);
  }
  assert.equal(aiConfigurationComplete({...complete,dailyCallLimit:0.5}),false);
});

test('配置、测试与启用按真实已保存状态推进，测试成功不等于已启用',()=>{
  const complete={...applyAIRecommendation(empty)!,hasKey:true};
  assert.equal(aiSetupStep(complete).label,'待测试连接');
  assert.equal(aiSetupStep({...complete,testedAt:'2026-10-10T08:00:00Z'}).label,'待启用');
  assert.equal(aiSetupStep({...complete,testedAt:'2026-10-10T08:00:00Z',enabled:true}).label,'已启用');
});
