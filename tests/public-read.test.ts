import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicCache} from '../src/server/public-cache';
import {parsePublicRead,readPublicVersion} from '../src/server/public-read';
import {mergePublicPage} from '../src/lib/public-read';
import type {PublicData} from '../src/lib/types';

test('公开缓存合并并发、到期重查，失败不伪装成成功',async()=>{
 let now=0,calls=0;const cache=createPublicCache(2000,4,()=>now);
 let release!:(value:number)=>void;
 const read=()=>{calls++;return new Promise<number>(resolve=>{release=resolve;});};
 const jobs=Array.from({length:100},()=>cache('home',read));await Promise.resolve();assert.equal(calls,1);
 release(42);assert.deepEqual(await Promise.all(jobs),Array(100).fill(42));
 now=1999;assert.equal(await cache('home',async()=>99),42);
 now=2000;assert.equal(await cache('home',async()=>99),99);
 await assert.rejects(cache('failure',async()=>{throw Error('test unavailable');}));
 assert.equal(await cache('failure',async()=>7),7);
 assert.equal(await cache('different-view',async()=>8),8);
});

test('生产默认公开缓存十秒到期，读取失败不延长旧结果',async()=>{
 let now=0,calls=0;const cache=createPublicCache(undefined,4,()=>now);
 assert.equal(await cache('version',async()=>++calls),1);
 now=9999;assert.equal(await cache('version',async()=>++calls),1);
 now=10000;await assert.rejects(cache('version',async()=>{throw new Error('fixture');}));
 assert.equal(await cache('version',async()=>++calls),2);
});

test('分页和详情参数受约束；不允许任意实体、跨类型游标或大批版本',()=>{
 assert.deepEqual(parsePublicRead(new URLSearchParams('view=history&filter=banked_reset')).view,'history');
 for(const query of ['view=admin','view=detail&id=one&entity=settings','view=history&filter=paid','view=activity&id=one&day=0','view=detail&entity=events&id=../secret'])assert.throws(()=>parsePublicRead(new URLSearchParams(query)));
 assert.throws(()=>parsePublicRead(new URLSearchParams(`view=activity&id=one&${Array(51).fill('publication=one').join('&')}`)));
});

test('版本读取没有历史训练负载；成功时间仅改变状态版本，撤回和来源故障改变正文版本',async()=>{
 const statements:string[]=[];let success='2026-10-13T00:00:00Z',status='healthy',digest='same';
 const query=async(sql:string)=>{
  statements.push(sql);
  if(sql.includes('to_regclass'))return {rows:[{cases:true,snapshots:true,outcomes:true}]};
  if(sql.includes('FROM radar_sources'))return {rows:[{payload:{id:'source',name:'公开来源',enabled:true,validated:true,kind:'status',url:'https://example.org',status,intervalMinutes:100000,lastSuccessAt:success}}]};
  if(sql.includes('FROM radar_settings')&&!sql.includes('forecast_snapshots'))return {rows:[{payload:{id:'site',version:1}}]};
  if(sql.includes('AS digest'))return {rows:[{digest}]};
  return {rows:[]};
 };
 const first=await readPublicVersion({query} as any,'2026-10-13T01:00:00Z');success='2026-10-13T00:30:00Z';
 const clock=await readPublicVersion({query} as any,'2026-10-13T01:00:00Z');
 assert.equal(clock.contentVersion,first.contentVersion);assert.notEqual(clock.version,first.version);
 status='failed';const failed=await readPublicVersion({query} as any,'2026-10-13T01:00:00Z');assert.notEqual(failed.contentVersion,clock.contentVersion);
 digest='withdrawn';const withdrawn=await readPublicVersion({query} as any,'2026-10-13T01:00:00Z');assert.notEqual(withdrawn.contentVersion,failed.contentVersion);
 assert.ok(statements.every(sql=>!sql.includes('training')&&!/SELECT payload FROM radar_forecast_snapshots/.test(sql)));
});

test('加载更多按ID合并，更正采用下一页新状态且不重复记录',()=>{
 const data={events:[],articles:[],publications:[],evidence:[],notices:[],activities:[],sources:[],site:{name:'测试'},serverTime:'2026-10-13T00:00:00Z'} as unknown as PublicData;
 const old={...data,events:[{id:'same',status:'published'}]} as PublicData;
 const next={...data,events:[{id:'same',status:'withdrawn'},{id:'next',status:'published'}]} as PublicData;
 const result=mergePublicPage(old,next);assert.equal(result.events.length,2);assert.equal(result.events[0].status,'withdrawn');assert.equal(old.events[0].status,'published');
});
