import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReferenceHistory,parseReferenceLatest,parseReferenceHistoricalLatest,referenceCompletionClaim,REFERENCE_HISTORY_SOURCE} from '../src/server/reference-reset-source';
import {parseReferenceOriginal,recoverReferenceHistoryEvidence,enrichKnownEvidence} from '../src/server/source-enrichment';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {validateDraft} from '../src/server/domain';
import {canEnrich} from '../src/server/worker';
import type {Evidence} from '../src/lib/types';
const id='2111566005684289735',at='2026-10-17T21:12:21.000Z',snapshotAt='2026-10-17T21:41:52.431Z',collectedAt='2026-10-23T12:00:00.000Z',sha='1ccf5ec6f08d1b17e79c5234918e270ccaf53de7';
const url=`https://x.com/thsottiaux/status/${id}`;
const snapshot=()=>({schema_version:1,generated_at:snapshotAt,last_global_reset:{event_id:'57205f59-83a4-43e2-99bc-07916b1046d0',reset_type:'global',record_status:'recorded',occurred_at:at,source:{url}},latest_signal:{signal_id:id,recorded_at:at,summary:'Done',source:{url}}});
const original=()=>({code:200,tweet:{id,text:'Done',created_at:'Sat Oct 17 21:12:21 +0000 2026',author:{screen_name:'thsottiaux',id:'1953337039510003712'}}});
function lead():Evidence {return {...parseReferenceHistory({schema_version:1,generated_at:snapshotAt,events:[snapshot().last_global_reset]},collectedAt)[0],id:'day13-history',hash:'fixture',historical:true};}
function verified():Evidence{return parseReferenceOriginal(original(),lead(),collectedAt)!;}
function fetcher(body:unknown=snapshot(),calls:string[]=[],commit=sha):typeof fetch{return async input=>{const target=String(input);calls.push(target);if(target.startsWith('https://api.fxtwitter.com/'))return Response.json(original());return Response.json(target.startsWith('https://api.github.com/')?[{sha:commit,commit:{committer:{date:'2026-10-17T21:41:56Z'}}}]:body);};}

test('Day13漏记复现：历史清单及裸Done不足以完成，实时快照不接受六天前数据',()=>{
 assert.equal(referenceCompletionClaim(lead()),undefined);
 assert.equal(referenceCompletionClaim(verified()),undefined);
 assert.throws(()=>parseReferenceLatest(snapshot(),collectedAt),/STALE/);
});
test('固定commit的历史快照保留原时间和真实补采时间，不伪装成实时快照',()=>{
 const archived=parseReferenceHistoricalLatest(snapshot(),sha,collectedAt)[0];
 assert.equal(archived.publishedAt,at);assert.equal(archived.collectedAt,collectedAt);
 assert.equal(archived.metadata?.referenceReset?.snapshotAt,snapshotAt);
 assert.match(archived.metadata!.referenceReset!.referenceUrl,new RegExp(`/${sha}/data/latest.json$`));
 assert.equal(archived.textOrigin,'archive_excerpt');
 assert.throws(()=>parseReferenceHistoricalLatest(snapshot(),'master',collectedAt));
 assert.throws(()=>parseReferenceHistoricalLatest(snapshot(),sha,'2026-10-16T00:00:00Z'));
});
test('真实Day13原帖和同时期快照联合补漏，通过正常中文草稿及事实校验',async()=>{
 const calls:string[]=[],row=await recoverReferenceHistoryEvidence(verified(),fetcher(snapshot(),calls));assert.ok(row);
 assert.equal(row.sourceId,REFERENCE_HISTORY_SOURCE.id);assert.equal(row.messageId,id);assert.equal(row.parentId,undefined);
 assert.equal(row.publishedAt,verified().publishedAt);assert.equal(row.historical,true);assert.equal(row.text,'Done');
 assert.equal(referenceCompletionClaim(row)?.stage,'claimed_complete');
 const draft=buildAutomaticTemplate([row]);assert.ok(draft);assert.equal(draft.actions[0].statementAt,verified().publishedAt);
 assert.match(draft.summary,/AIPlanWatch/);assert.deepEqual(validateDraft(draft,[row],true),[]);
 assert.equal(calls.length,2);assert.match(calls[0],/per_page=10/);assert.match(calls[1],new RegExp(`/${sha}/data/latest.json$`));
 assert.equal(await recoverReferenceHistoryEvidence(row,fetcher()),undefined,'已验证证据不重复补采');
});
test('正常原文补全入口执行历史恢复；已经补全文本但未分类的旧证据也能恢复',async()=>{
 for(const evidence of [lead(),verified()]){
  assert.equal(canEnrich(evidence),true,'已补全文本的历史候选仍能进入 worker 核对');
  const row=await enrichKnownEvidence(evidence,fetcher());assert.ok(row);assert.equal(referenceCompletionClaim(row)?.kind,'automatic_reset');
 }
});
test('错帖、错时间、错摘要、伪commit、未来归档都保持未确认',async()=>{
 const wrongPost=snapshot();wrongPost.last_global_reset.source.url='https://x.com/thsottiaux/status/2112432076767289678';
 const wrongTime=snapshot();wrongTime.last_global_reset.occurred_at='2026-10-17T21:13:00.000Z';
 const wrongSummary=snapshot();wrongSummary.latest_signal.summary='Done with lunch';
 const future=snapshot();future.generated_at='2027-10-17T21:41:52.431Z';
 for(const body of [wrongPost,wrongTime,wrongSummary,future])assert.equal(await recoverReferenceHistoryEvidence(verified(),fetcher(body)),undefined);
 assert.equal(await recoverReferenceHistoryEvidence(verified(),fetcher(snapshot(),[],'../../malicious')),undefined);
});
test('不推断父帖、不把其他Done、套餐类型或纯列表行直接变成额度完成',async()=>{
 for(const row of [{...verified(),sourceId:'tibo-public'},{...verified(),text:'Done with lunch'},{...verified(),parentId:'2111492673890824348'},{...verified(),textOrigin:'archive_excerpt' as const}]){
  let calls=0;assert.equal(await recoverReferenceHistoryEvidence(row,async()=>{calls++;throw new Error('must not fetch');}),undefined);assert.equal(calls,0);
 }
 assert.equal(referenceCompletionClaim({...verified(),metadata:{...verified().metadata,benefitKind:'automatic_reset',referenceReset:{eventId:'fake',snapshotAt,occurredAt:at,referenceUrl:REFERENCE_HISTORY_SOURCE.url,summary:'Done'}}}),undefined);
});
test('归档网络故障、跳转和限流保持原记录；不绕过限流继续请求',async()=>{
 for(const status of [302,403,429,500]){
  let calls=0;assert.equal(await recoverReferenceHistoryEvidence(verified(),async(_input,init)=>{calls++;assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).has('authorization'),false);return new Response('',{status});}),undefined);assert.equal(calls,1);
 }
});
