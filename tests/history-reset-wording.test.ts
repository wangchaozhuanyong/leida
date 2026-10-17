import test from 'node:test';
import assert from 'node:assert/strict';
import {extractBenefitClaims} from '../src/server/benefit-rules';
const at='2026-07-29T04:09:02Z';
test('历史原帖的英文完成缩写和明确产品用量声明可以识别，不扩大具体套餐资格',()=>{
  for(const text of [
    "I've reset usage limits for all ChatGPT Work and Codex users.",
    "We've now reset usage limits for all paid users of Codex and ChatGPT Work.",
    'We have reset usage limits across Codex and ChatGPT Work.',
    'I have reset usage limits for Codex and ChatGPT Work.'
  ]){const claims=extractBenefitClaims(text,at);assert.equal(claims.length,1,text);assert.equal(claims[0].kind,'automatic_reset');assert.equal(claims[0].stage,'claimed_complete');assert.equal(claims[0].scope,'public');if(!/all|paid/.test(text))assert.match(claims[0].eligibility,/原帖未列明具体套餐/);}
});
test('相同措辞的假设、否定、个人及限定用户不进入公共完成次数',()=>{
  for(const text of [
    "If I've reset usage limits for all Codex users, would you try again?",
    "I've not reset usage limits for all Codex users.",
    "I have never reset usage limits for Codex and ChatGPT Work.",
    "I've reset usage limits for my account only.",
    'We have reset usage limits for selected users of Codex and ChatGPT Work.',
    'We have reset usage limits for Codex and ChatGPT Work in Europe.'
  ])assert.equal(extractBenefitClaims(text,at).filter(c=>c.scope==='public'&&c.stage==='claimed_complete').length,0,text);
});
test('未来发放措辞不会因完成缩写兼容而变成已完成',()=>{
  assert.equal(extractBenefitClaims('We will reset usage limits for all paid Codex users in the next hour.',at)[0].stage,'promised');
  assert.equal(extractBenefitClaims('We are resetting usage limits for all paid Codex users.',at)[0].stage,'in_progress');
});
