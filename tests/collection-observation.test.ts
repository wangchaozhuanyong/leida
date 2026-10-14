import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateCollectionObservation,validateCollectionObservationJournal,type StoredCollectionInput} from '../src/lib/collection-observation';
import type {Evidence} from '../src/lib/types';

const startedAt='2026-10-12T00:00:00.000Z',time='2026-10-12T01:00:00.000Z';
function row(publishedAt:string,delayMs=60_000,patch:Partial<Evidence>={}):StoredCollectionInput {
 const messageId=String((BigInt(Date.parse(publishedAt))-1288834974657n)<<22n);
 const storedAt=new Date(Date.parse(publishedAt)+delayMs).toISOString();
 return {storedAt,evidence:{id:messageId,sourceId:'tibo-public',messageId,url:`https://x.com/thsottiaux/status/${messageId}`,text:'Public source text',hash:messageId,publishedAt,collectedAt:new Date(Date.parse(storedAt)-3000).toISOString(),historical:false,contextComplete:true,provenance:'archive',textOrigin:'original',metadata:{sourceGroup:'fxembed:thsottiaux'},...patch}};
}
const measure=(rows:StoredCollectionInput[])=>evaluateCollectionObservation({startedAt,time,rows});
test('没有真实窗口新帖时保留空统计，不能生成速度或完整覆盖结论',()=>{
 const result=measure([]);assert.equal(result.measuredMessages,0);assert.equal(result.medianSourceToStorageMs,null);
 assert.equal(result.completeTimelineCoverage,'NOT_MEASURED');assert.equal(result.upstreamAvailabilityDelay,'NOT_MEASURED');
});
test('发帖到首次入库记录使用数据库时间，不用提前的请求起始时间',()=>{
 const result=measure([row('2026-10-12T00:10:00.000Z',33_000),row('2026-10-12T00:11:00.000Z',92_000)]);
 assert.equal(result.measuredMessages,2);assert.equal(result.medianSourceToStorageMs,62_500);assert.equal(result.maximumSourceToStorageMs,92_000);
 assert.equal(result.records[0].sourceToStorageMs,33_000);assert.equal(result.storageTimestampMeaning,'postgres_transaction_created_at');
});
test('修订、重复输入和次序变化不能改变首次记录或重复计数',()=>{
 const original=row('2026-10-12T00:10:00.000Z',30_000),revision={...original,storedAt:'2026-10-12T00:20:00.000Z',evidence:{...original.evidence,id:'revision',collectedAt:'2026-10-12T00:19:57.000Z',text:'Edited public text'}};
 for(const rows of [[original,revision],[revision,original],[revision,original,original]]){
  const result=measure(rows);assert.equal(result.measuredMessages,1);assert.equal(result.maximumSourceToStorageMs,30_000);assert.equal(result.records[0].firstStoredAt,original.storedAt);
 }
});
test('窗口以前的补采、旧帖子修订和历史标记均不计实时速度',()=>{
 const old=row('2026-10-11T23:00:00.000Z',75*60_000),flagged=row('2026-10-12T00:10:00.000Z',60_000,{historical:true});
 const prior=row('2026-10-11T23:50:00.000Z',60_000),revision={...prior,storedAt:'2026-10-12T00:20:00.000Z',evidence:{...prior.evidence,id:'revision'}};
 const result=measure([old,flagged,prior,revision]);assert.equal(result.measuredMessages,0);assert.equal(result.backfillMessages,3);assert.ok(result.records.every(r=>r.sourceToStorageMs===null));
});
test('发布时间、采集时间、入库时间异常不产生负数或虚假快速结果',()=>{
 const original=row('2026-10-12T00:10:00.000Z');
 for(const bad of [
  {...original,storedAt:'2026-10-12T00:09:00.000Z'},
  {...original,storedAt:'2026-10-12T02:00:00.000Z'},
  {...original,storedAt:'not-a-date'},
  {...original,evidence:{...original.evidence,collectedAt:'not-a-date'}},
  {...original,evidence:{...original.evidence,collectedAt:'2026-10-12T00:12:00.000Z'}},
  {...original,evidence:{...original.evidence,publishedAt:'2026-10-12T00:10:10.000Z'}}
 ]){const result=measure([bad]);assert.equal(result.measuredMessages,0);assert.equal(result.invalidMessages,1);assert.equal(result.maximumSourceToStorageMs,null);}
});
test('同一帖子发布时间冲突时不任意选择修订作为速度依据',()=>{
 const original=row('2026-10-12T00:10:00.000Z');
 const revised={...original,evidence:{...original.evidence,id:'revision',publishedAt:'2026-10-12T00:10:01.000Z'}};
 assert.equal(measure([original,revised]).invalidMessages,1);
});
test('人工、归档摘要、其他来源和错误作者地址不能充当免费原文实测',()=>{
 const original=row('2026-10-12T00:10:00.000Z');
 for(const patch of [{provenance:'manual'},{sourceId:'reset-archive'},{textOrigin:'archive_excerpt'},{metadata:{}},{url:'https://x.com/other/status/'+original.evidence.messageId},{messageId:'invalid'}] as Partial<Evidence>[]){
  assert.equal(measure([{...original,evidence:{...original.evidence,...patch}}]).records.length,0);
 }
});
test('观察窗口或检查时间非法时拒绝，不自动重置历史窗口',()=>{
 for(const patch of [{startedAt:'bad'},{time:'bad'},{time:'2026-10-11T00:00:00Z'}])assert.throws(()=>evaluateCollectionObservation({startedAt,time,rows:[],...patch}));
});
const journalLine=(checkedAt:string,patch:Record<string,unknown>={})=>JSON.stringify({ruleVersion:'collection-storage-v1',startedAt,checkedAt,...patch})+'\n';
test('完整采样日志在重启后保留同一窗口，空的新窗口也可继续观察',()=>{
 assert.doesNotThrow(()=>validateCollectionObservationJournal('',startedAt,time));
 assert.doesNotThrow(()=>validateCollectionObservationJournal(journalLine('2026-10-12T00:05:00Z')+journalLine('2026-10-12T00:10:00Z'),startedAt,time));
});
test('残缺、损坏、不同窗口和规则的日志不能被当成可恢复证据',()=>{
 for(const raw of ['{bad}\n',journalLine('2026-10-12T00:05:00Z').trimEnd(),journalLine('2026-10-12T00:05:00Z',{startedAt:time}),journalLine('2026-10-12T00:05:00Z',{ruleVersion:'other'}),'null\n']){
  assert.throws(()=>validateCollectionObservationJournal(raw,startedAt,time));
 }
});
test('窗口前、未来或倒退的采样时间拒绝，不能改窗口来掩盖缺口',()=>{
 for(const raw of [journalLine('2026-10-11T23:59:00Z'),journalLine('2026-10-12T02:00:00Z'),journalLine('2026-10-12T00:10:00Z')+journalLine('2026-10-12T00:05:00Z')]){
  assert.throws(()=>validateCollectionObservationJournal(raw,startedAt,time));
 }
});
