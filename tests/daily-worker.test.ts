import test from 'node:test';
import assert from 'node:assert/strict';
import { generationCooldown, sourceCollectionDue, sourceRetryAt, isRecoverableStorageError } from '../src/server/worker';
import type { Source } from '../src/lib/types';

const timestamp=Date.parse('2026-10-09T00:00:00Z');
const source:Source={id:'test-source',name:'测试来源',kind:'archive',url:'https://example.invalid',enabled:true,validated:true,intervalMinutes:5,version:1,status:'healthy'};

test('临时生成故障三次后分级冷却，最高一小时',()=>{
  assert.equal(generationCooldown(1,timestamp),'2026-10-09T00:15:00.000Z');
  assert.equal(generationCooldown(2,timestamp),'2026-10-09T00:30:00.000Z');
  assert.equal(generationCooldown(3,timestamp),'2026-10-09T01:00:00.000Z');
  assert.equal(generationCooldown(50,timestamp),'2026-10-09T01:00:00.000Z');
});

test('结构异常只暂停发布并定时探测，人工暂停不会自动启用',()=>{
  assert.equal(sourceCollectionDue(source,timestamp),true);
  assert.equal(sourceCollectionDue({...source,validated:false},timestamp),false);
  assert.equal(sourceCollectionDue({...source,validated:false,publicationPaused:true,pauseReason:'structure'},timestamp),true);
  assert.equal(sourceCollectionDue({...source,enabled:false,validated:false,publicationPaused:true,pauseReason:'structure'},timestamp),false);
  assert.equal(sourceCollectionDue({...source,nextRunAt:'2026-10-09T00:05:00Z'},timestamp),false);
});

test('来源退避使用跨任务失败次数，遵守提供方限流时间',()=>{
  assert.equal(sourceRetryAt(source,undefined,timestamp),'2026-10-09T00:02:00.000Z');
  assert.equal(sourceRetryAt({...source,consecutiveFailures:2},undefined,timestamp),'2026-10-09T00:08:00.000Z');
  assert.equal(sourceRetryAt({...source,consecutiveFailures:50},undefined,timestamp),'2026-10-09T01:00:00.000Z');
  assert.equal(sourceRetryAt({...source,pauseReason:'structure'},undefined,timestamp),'2026-10-09T00:15:00.000Z');
  assert.equal(sourceRetryAt(source,'2026-10-09T02:00:00Z',timestamp),'2026-10-09T02:00:00.000Z');
});

test('存储暂时中断和事务重试可恢复，程序与数据错误不无限重试',()=>{
  assert.equal(isRecoverableStorageError({code:'ECONNRESET'}),true);
  assert.equal(isRecoverableStorageError({code:'57P03'}),true);
  assert.equal(isRecoverableStorageError({code:'40001'}),true);
  assert.equal(isRecoverableStorageError({code:'23505'}),false);
  assert.equal(isRecoverableStorageError(new Error('程序错误')),false);
});
