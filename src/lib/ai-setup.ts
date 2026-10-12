import type { AISettings } from './types';

// Existing official Beijing plan, verified on 2026-10-10. Applying it only edits the form.
export const recommendedAI = {
  baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model:'qwen3.7-flash-2026-07-15',
  dailyCallLimit:100,dailyBudget:1,inputPrice:0.2,outputPrice:0.8,currency:'CNY',
} satisfies Partial<AISettings>;

export function applyAIRecommendation(settings:AISettings):AISettings|undefined {
  // Never reuse an existing provider credential or replace a previously configured service.
  if(settings.hasKey||settings.baseUrl.trim()||settings.model.trim())return;
  return {...settings,...recommendedAI,enabled:false,testedAt:undefined};
}

export function aiConfigurationComplete(settings:AISettings):boolean {
  return !!(settings.hasKey&&settings.baseUrl.trim()&&settings.model.trim()
    &&Number.isInteger(settings.dailyCallLimit)&&settings.dailyCallLimit>0
    &&[settings.dailyBudget,settings.inputPrice,settings.outputPrice].every(value=>Number.isFinite(value)&&value>0));
}

export function aiSetupStep(settings:AISettings):{label:string;hint:string} {
  if(!aiConfigurationComplete(settings))return {label:'待填写配置',hint:'填写密钥、接口和费用上限，关闭自动处理后保存。'};
  if(!settings.testedAt)return {label:'待测试连接',hint:'测试已保存配置；测试会产生一次受限调用。'};
  if(!settings.enabled)return {label:'待启用',hint:'连接已测试，勾选自动智能处理后保存。'};
  return {label:'已启用',hint:'常规新闻自动生成；失败重试，预算用尽后次日继续。'};
}
