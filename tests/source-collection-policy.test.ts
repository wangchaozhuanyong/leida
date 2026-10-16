import test from 'node:test';
import assert from 'node:assert/strict';
import type {Evidence,RadarEvent,Source} from '../src/lib/types';
import {sourceCollectionSchedule,sourceNextCollectionAt,verifiedCollectionWindow} from '../src/server/source-collection-policy';
import {sourceDefinitions,fetchRecords,fetchReleasePages,sourceReadCheckpoint,incomingFingerprint,hasOpenCodexIncident,type Incoming} from '../src/server/ingestion';

const at=Date.parse('2026-10-16T12:00:00Z');
const source=(id:string):Source=>({...sourceDefinitions.find(item=>item.id===id)!,enabled:true,validated:true});
const evidence:Evidence={id:'e1',sourceId:'tibo-public',messageId:'1',url:'https://x.com/thsottiaux/status/1',text:'Global reset rolling out now.',publishedAt:'2026-10-16T11:30:00Z',collectedAt:'2026-10-16T11:31:00Z',textOrigin:'original',hash:'original',historical:false,contextComplete:true,provenance:'archive'};
const event:RadarEvent={id:'event',title:'Reset',version:1,status:'published',publicationId:'pub',updatedAt:evidence.publishedAt,evidenceIds:[evidence.id],actions:[{id:'a',kind:'automatic_reset',stage:'in_progress',scope:'public',eligibility:'all',statementAt:evidence.publishedAt,evidenceIds:[evidence.id],evidenceQuote:evidence.text}]};

test('采集默认策略迁移旧默认，保留自定义频率及人工选择',()=>{
 for(const [id,normal] of [['tibo-public',10],['reset-archive',30],['activity-archive',30],['official-status',30],['official-releases',360]] as const){
  const old={...source(id),collectionPolicy:undefined,intervalMinutes:id==='tibo-public'?2:5};
  assert.equal(sourceCollectionSchedule(old,at).effectiveIntervalMinutes,normal);
  assert.equal(sourceCollectionSchedule({...old,intervalMinutes:47},at).effectiveIntervalMinutes,47);
  assert.equal(sourceCollectionSchedule({...old,collectionPolicy:'manual'},at).effectiveIntervalMinutes,old.intervalMinutes);
 }
});
test('只有核实公开预告和进行中动作加速，完成、过期、辅助摘要不加速',()=>{
 const window=verifiedCollectionWindow([event],[evidence],at);
 assert.ok(window);
 const timeline={...source('tibo-public'),collectionWindow:window};
 assert.equal(sourceCollectionSchedule(timeline,at).effectiveIntervalMinutes,2);
 assert.equal(sourceCollectionSchedule({...source('reset-archive'),collectionWindow:window},at).effectiveIntervalMinutes,5);
 assert.equal(sourceCollectionSchedule({...source('official-releases'),collectionWindow:window},at).effectiveIntervalMinutes,360);
 assert.equal(sourceCollectionSchedule(timeline,at+2*3600_000).effectiveIntervalMinutes,10);
 assert.equal(verifiedCollectionWindow([event],[{...evidence,textOrigin:'archive_excerpt'}],at),undefined);
 assert.equal(verifiedCollectionWindow([event],[{...evidence,provenance:'manual'}],at),undefined);
 assert.equal(verifiedCollectionWindow([{...event,actions:[...event.actions,{...event.actions[0],id:'done',stage:'claimed_complete',statementAt:'2026-10-16T11:50:00Z'}]}],[evidence],at),undefined);
 const later={...event,actions:[{...event.actions[0],stage:'promised' as const,expectedAt:'2026-10-17T12:00:00Z'}]};
 const futureWindow=verifiedCollectionWindow([later],[evidence],at);
 assert.ok(futureWindow);assert.equal(sourceCollectionSchedule({...timeline,collectionWindow:futureWindow},at).effectiveIntervalMinutes,10);
 assert.equal(sourceCollectionSchedule({...timeline,collectionWindow:futureWindow},Date.parse('2026-10-17T11:00:00Z')).effectiveIntervalMinutes,2);
 assert.equal(sourceNextCollectionAt({...timeline,collectionWindow:futureWindow},Date.parse('2026-10-17T10:59:00Z')),'2026-10-17T11:00:00.000Z');
 assert.equal(sourceNextCollectionAt(timeline,at),'2026-10-16T12:02:00.000Z');
});
test('官方状态只按每个Codex故障最新进展提速，已解决旧更新不继续触发',()=>{
 const update=(status:string,publishedAt:string):Incoming=>({...evidence,provenance:'official',parentId:'incident',publishedAt,metadata:{title:'Codex elevated errors',status}});
 assert.equal(hasOpenCodexIncident([update('investigating','2026-10-16T10:00:00Z')]),true);
 assert.equal(hasOpenCodexIncident([update('resolved','2026-10-16T11:00:00Z'),update('investigating','2026-10-16T10:00:00Z')]),false);
 assert.equal(hasOpenCodexIncident([{...update('investigating',evidence.publishedAt),metadata:{title:'ChatGPT errors',status:'investigating'}}]),false);
 assert.equal(sourceCollectionSchedule({...source('official-status'),hasActiveIncident:true},at).effectiveIntervalMinutes,5);
});
const body=JSON.stringify({incidents:[{id:'incident',name:'Codex elevated errors',incident_updates:[{id:'update',body:'Investigating increased Codex errors.',created_at:'2026-10-16T10:00:00Z',status:'investigating'}]}]});
test('持久HTTP validator重启后304直接结束、不重放正文且不记录失败',async()=>{
 const original=source('official-status');
 assert.equal((await fetchRecords(original,false,{fetcher:async()=>new Response(body,{headers:{etag:'"status-v1"'}}),onRequestEvent:async()=>{throw Error('no failures expected');}})).length,1);
 const restarted={...source('official-status'),httpCheckpoints:sourceReadCheckpoint(original)!.httpCheckpoints};
 let calls=0;
 const rows=await fetchRecords(restarted,false,{fetcher:async(_url,init)=>{calls++;assert.equal(new Headers(init?.headers).get('If-None-Match'),'"status-v1"');return new Response(null,{status:304});},onRequestEvent:async()=>{throw Error('304 must not be failure');}});
 assert.deepEqual(rows,[]);assert.equal(calls,1);assert.equal(sourceReadCheckpoint(restarted)?.unchanged,true);
});
test('服务端200但正文hash未变也跳过存证；强制验证和历史读不跳过',async()=>{
 const original=source('official-status');
 await fetchRecords(original,false,{fetcher:async()=>new Response(body),onRequestEvent:async()=>{}});
 const saved={...source('official-status'),httpCheckpoints:sourceReadCheckpoint(original)!.httpCheckpoints};
 assert.deepEqual(await fetchRecords(saved,false,{fetcher:async()=>new Response(body),onRequestEvent:async()=>{}}),[]);
 assert.equal((await fetchRecords(saved,true,{fetcher:async()=>new Response(body),onRequestEvent:async()=>{}})).length,1);
 assert.equal((await fetchRecords(saved,false,{fetcher:async()=>new Response(body),forceFullRead:true,onRequestEvent:async()=>{}})).length,1);
});
test('失败后恢复为未变化响应也保留恢复诊断',async()=>{
 const original=source('official-status');
 await fetchRecords(original,false,{fetcher:async()=>new Response(body),onRequestEvent:async()=>{}});
 const saved={...source('official-status'),httpCheckpoints:sourceReadCheckpoint(original)!.httpCheckpoints};
 const events:string[]=[];let requests=0;
 assert.deepEqual(await fetchRecords(saved,false,{fetcher:async()=>++requests===1?new Response('',{status:503}):new Response(body),sleep:async()=>{},onRequestEvent:async event=>{events.push(event.outcome);}}),[]);
 assert.deepEqual(events,['failed','recovered']);assert.equal(requests,2);
});
test('版本分页补漏不能被相同头页中断，保留分页预算与下一断点',async()=>{
 const saved={...source('official-releases'),releaseScan:{nextPage:3,baseline:'2026-10-10T00:00:00Z'}};
 const page=JSON.stringify(Array.from({length:5},(_,i)=>({id:i,draft:false,prerelease:false,tag_name:'v1',html_url:`https://github.com/openai/codex/releases/tag/${i}`,body:'release',published_at:'2026-10-16T00:00:00Z'})));
 const first=await fetchReleasePages(saved,async()=>new Response(page));
 const pages:number[]=[];
 const second=await fetchReleasePages({...saved,httpCheckpoints:first.httpCheckpoints},async url=>{pages.push(Number(new URL(String(url)).searchParams.get('page')));return new Response(page);});
 assert.deepEqual(pages,[1,2,3]);assert.ok(second.records.length);assert.equal(second.scan.nextPage,4);assert.equal(second.unchanged,undefined);
});
test('批次指纹忽略采集时刻但保留正文编辑和上下文变化',()=>{
 const first=incomingFingerprint([evidence]);
 assert.equal(first,incomingFingerprint([{...evidence,collectedAt:'2026-10-16T12:00:00Z'}]));
 assert.notEqual(first,incomingFingerprint([{...evidence,text:'Changed announcement'}]));
 assert.notEqual(first,incomingFingerprint([{...evidence,parentId:'parent'}]));
});
