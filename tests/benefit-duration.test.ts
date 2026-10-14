import assert from 'node:assert/strict';
import test from 'node:test';
import {benefitTime,eligibilityMatches,extractBenefitClaims} from '../src/server/benefit-rules';

const at='2026-10-12T00:00:00.000Z';
const message=(duration:string)=>`We will reset usage for all paid accounts ${duration}.`;

test('分钟及组合时长按完整总量换算，保留原文预告与期限区别',()=>{
  const cases:[string,number][]=[['in 90 minutes',90],['in 120 minutes',120],['within 1 hour and 30 minutes',90],['in 2 hours 15 minutes',135],['in an hour and 30 minutes',90],['in the next hour and 30 minutes',90],['in about 1.5 hours',90],['within 48 hours and 0 minutes',2880],['in 2880 minutes',2880]];
  for(const [duration,minutes] of cases){
    const text=message(duration),expected=new Date(Date.parse(at)+minutes*60_000).toISOString();
    assert.equal(benefitTime(text,at).expectedAt,expected,text);
    const claims=extractBenefitClaims(text,at);
    assert.equal(claims.length,1,text);assert.equal(claims[0].expectedAt,expected,text);assert.equal(claims[0].stage,'promised');
  }
  assert.match(benefitTime(message('in 90 minutes'),at).timeNote!,/^原文预计时刻/);
  assert.ok(!/^原文预计时刻/.test(benefitTime(message('within 90 minutes'),at).timeNote!));
  for(const [text,minutes] of [['我们将为所有付费账户在1小时30分钟内重置用量。',90],['我们将为所有付费账户在2小时又15分钟内重置用量。',135],['我们将为所有付费账户在90分钟内重置用量。',90]] as const){
    assert.equal(benefitTime(text,at).expectedAt,new Date(Date.parse(at)+minutes*60_000).toISOString(),text);
  }
});

test('不截断不支持的时长、区间或超过48小时的总量',()=>{
  for(const duration of ['in 0 minutes','in -5 minutes','in 2881 minutes','in 48 hours and 1 minute','in 1 hour and 60 minutes','in 1 minute and 30 minutes','in 1 hour and approximately 30 minutes','in 1 hour and a few minutes','in 1 hour and 30 seconds','in 1 hour to 2 hours','in 1 hour or 2 hours','in 1 hour / 2 hours']){
    assert.equal(benefitTime(message(duration),at).expectedAt,undefined,duration);
  }
  assert.equal(benefitTime(message('in 90 minutes'),'invalid').expectedAt,undefined);
});

test('时间语法豁免不能吞掉后续地区或资格条件',()=>{
  for(const text of [message('in 90 minutes if eligible'),message('in 1 hour and 30 minutes from China'),message('in 2 hours 15 minutes except free users')])assert.deepEqual(extractBenefitClaims(text,at),[],text);
});

test('多时区文字不能把后一个时区错误套用到前一个钟点',()=>{
  for(const text of ['We will reset usage for all paid accounts on 2026-10-12 at 10:00 PST (18:00 UTC).','We will reset usage for all paid accounts on 2026-10-12 at 10:00 PST (UTC+8).','Global reset by EOD PST GMT.']){
    assert.equal(benefitTime(text,at).expectedAt,undefined,text);
    const claims=extractBenefitClaims(text,at);assert.equal(claims[0]?.stage,'promised',text);assert.equal(claims[0]?.expectedAt,undefined,text);
  }
  const text='We will reset usage for all paid accounts on 2026-10-12 at 10:00 PST (UTC-8).';
  assert.equal(benefitTime(text,at).expectedAt,'2026-10-12T18:00:00.000Z');
});

test('部分套餐账户不得扩大成全套餐公开重置',()=>{
  for(const qualifier of ['some','certain','selected','affected']){
    const claims=extractBenefitClaims(`We have reset Codex usage limits for ${qualifier} Pro users.`,at);
    assert.equal(claims.length,1,qualifier);assert.equal(claims[0].scope,'targeted',qualifier);
    assert.ok(claims[0].eligibility.includes(qualifier),qualifier);
    assert.equal(eligibilityMatches(claims[0].eligibility,'Pro套餐账户'),false,qualifier);
  }
});

test('多个ISO备选时刻及无效原帖时间不会偷偷选第一个或抛异常',()=>{
  const text='We will reset usage for all paid accounts on 2026-10-12T10:00:00Z or 2026-10-12T12:00:00Z.';
  assert.equal(benefitTime(text,at).expectedAt,undefined);assert.equal(extractBenefitClaims(text,at)[0]?.expectedAt,undefined);
  assert.equal(extractBenefitClaims(text,at)[0]?.stage,'promised');
  assert.equal(benefitTime('Reset at 2026-10-12T10:00:00Z (2026-10-12T10:00:00Z).',at).expectedAt,'2026-10-12T10:00:00.000Z');
  assert.equal(benefitTime('Reset today at 10:00 UTC.','invalid').expectedAt,undefined);
});
