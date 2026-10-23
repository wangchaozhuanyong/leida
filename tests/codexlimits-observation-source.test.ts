import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {load} from 'cheerio';
import type {Evidence} from '../src/lib/types';
import {CODEX_LIMITS_OBSERVATION_SOURCE as source,parseCodexLimitsObservations as parse} from '../src/server/codexlimits-observation-source';
import {fetchRecords,incomingFingerprint,sourceReadCheckpoint,SourceRateLimitError,SourceStructureError} from '../src/server/ingestion';
import {REFERENCE_SOURCES,referenceContentsURL,referenceCompletionClaim} from '../src/server/reference-reset-source';
import {observedEvidence,timelineObservation} from '../src/lib/reset-observations';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {evidenceBenefitClaims} from '../src/server/source-context';
import {validateDraft} from '../src/server/domain';
import {canEnrich,sourceCollectionDue} from '../src/server/worker';
import {sourceCollectionSchedule,sourceNextCollectionAt} from '../src/server/source-collection-policy';
const html=readFileSync(new URL('./fixtures/codexlimits-reset-observations.html',import.meta.url),'utf8');
const at='2026-10-23T20:19:26.735Z',observedAt='2026-10-23T17:40:00.000Z';
const native=createRequire(import.meta.url)('../miniprogram/utils/reset-observations.js');
const evidence=():Evidence=>({...parse(html,at)[0],id:'limits-observed',hash:'fixture',historical:true});
const change=(edit:(document:ReturnType<typeof load>)=>void)=>{const $=load(html);edit($);return $.html();};

test('真实HTML只读取明确第三方观测，不把确认引用、历史公告和账号自测提升为官方完成',()=>{
 const rows=parse(html,at);
 assert.deepEqual(rows.map(row=>row.publishedAt),[observedAt,'2026-10-22T17:10:00.000Z']);
 assert.equal(rows[0].messageId,`observed-codexlimits-${Date.parse(observedAt)}`);
 assert.equal(rows[0].metadata?.referenceReset?.snapshotAt,at,'快照时间是本次读取时间，不虚构来源生成时间');
 assert.equal(rows[0].metadata?.referenceReset?.summary,'Third-party observation on Oct 23, 17:40 UTC.');
 assert.equal(rows[0].url,source.url);assert.equal(rows[0].parentId,undefined);assert.equal(rows[0].contextComplete,false);
 assert.equal(parse(change($=>{$('.pending-badge').filter((_,e)=>$(e).text()==='Detected').closest('article').remove();}),at).length,0);
 const duplicated=change($=>{$('body').append($('article').first().clone());});assert.equal(parse(duplicated,at).length,2);
});

test('标题、观测标识、精确UTC、日期和来源链接必须一致，结构错误不猜测或降精度',()=>{
 const replacements:[string,string][]=[
  ['Usage reset landed','Reset expected tomorrow'],['17:40 UTC.','17:40 PST.'],['17:40 UTC.','UTC.'],
  ['17:40 UTC.','24:00 UTC.'],['17:40 UTC.','17:60 UTC.'],['Oct 23, 17:40','Oct 24, 17:40'],
  ['<span>Oct 23</span>','<span>Oct 24</span>'],['<span>2026</span>','<span>2027</span>'],
  ['Third-party observation on','Forecast expected on'],['href="/reset-history"','href="https://evil.invalid/reset-history"']
 ];
 for(const [before,after] of replacements)assert.throws(()=>parse(html.replace(before,after),at),/CODEX_LIMITS_/,`${before} -> ${after}`);
 assert.throws(()=>parse(html.replaceAll('Oct 23','Feb 30'),at),/TIME_INVALID/);
 assert.throws(()=>parse(html,'invalid'),/STRUCTURE_INVALID/);
 assert.throws(()=>parse('<html><p>Third-party observation on Oct 23, 17:40 UTC.</p></html>',at),/STRUCTURE_INVALID/);
 const forecasts=change($=>{$('.pending-badge').text('Scheduled');$('.archive-event-body > p').text('Reset expected tomorrow.');});assert.deepEqual(parse(forecasts,at),[]);
 for(const broken of [change($=>{$('.pending-badge').text('Observation');}),change($=>{$('.pending-history-row').removeClass('pending-history-row');})])assert.throws(()=>parse(broken,at),/STRUCTURE_INVALID/,'仍有第三方观测正文但识别标记变化时不能报健康空结果');
 const banked=change($=>{$('article').attr('data-type','banked');});assert.deepEqual(parse(banked,at),[]);
});

test('固定来源沿既有HTTP安全读取，不请求旧JSON；正常5分钟采集且人工停用不被调度',async()=>{
 assert.equal(source.enabled,false);assert.equal(source.validated,false);assert.equal(REFERENCE_SOURCES.find(item=>item.id===source.id),source);
 assert.equal(referenceContentsURL(source),undefined);
 const active={...source,enabled:true,validated:true,publicationPaused:false},calls:string[]=[];
 const rows=await fetchRecords(active,false,{forceFullRead:true,onRequestEvent:async()=>{},fetcher:async(input,init)=>{
  calls.push(String(input));assert.equal(String(input),source.url);assert.equal(init?.redirect,'error');assert.ok(init?.signal);
  const headers=new Headers(init?.headers);assert.equal(headers.has('authorization'),false);assert.equal(headers.has('cookie'),false);
  return new Response(html,{headers:{etag:'"limits-fixture"'}});
 }});
 assert.equal(rows.length,2);assert.deepEqual(calls,[source.url]);assert.equal(sourceReadCheckpoint(active)?.unchanged,false);
 const cached={...active,...sourceReadCheckpoint(active)};
 assert.deepEqual(await fetchRecords(cached,false,{onRequestEvent:async()=>{},fetcher:async(_input,init)=>{assert.equal(new Headers(init?.headers).get('If-None-Match'),'"limits-fixture"');return new Response(null,{status:304});}}),[]);
 assert.equal(sourceReadCheckpoint(cached)?.referenceSnapshotAt,cached.referenceSnapshotAt,'304不能刷新观测时间或原读取时间');
 assert.equal(sourceCollectionSchedule(active).effectiveIntervalMinutes,5);
 assert.equal(sourceNextCollectionAt(active,Date.parse(at)),new Date(Date.parse(at)+300000).toISOString());
 assert.equal(sourceCollectionDue({...active,enabled:false}),false);
 for(const patch of [{url:'https://127.0.0.1/reset-history'},{url:'https://example.com/reset-history'},{kind:'status' as const}]){
  let fetched=false;
  await assert.rejects(fetchRecords({...source,...patch},false,{onRequestEvent:async()=>{},fetcher:async()=>{fetched=true;return new Response(html);}}),/允许名单/);
  assert.equal(fetched,false);
 }
});

test('错误HTML及限流停止当前批次；不会回退静态JSON或其他站点',async()=>{
 for(const status of [200,429]){
  let calls=0;
  await assert.rejects(fetchRecords(source,false,{onRequestEvent:async()=>{},fetcher:async input=>{calls++;assert.equal(String(input),source.url);return new Response('<html>not an archive</html>',{status,headers:{'retry-after':status===429?'60':''}});}}),status===429?SourceRateLimitError:SourceStructureError);
  assert.equal(calls,1);
 }
});

test('再次读取只改变采集快照，不改变观测内容指纹；真实新时间保留独立身份',()=>{
 const first=parse(html,at),second=parse(html,'2026-10-23T21:00:00.000Z');
 assert.equal(incomingFingerprint(first),incomingFingerprint(second));
 assert.notEqual(first[0].metadata?.referenceReset?.snapshotAt,second[0].metadata?.referenceReset?.snapshotAt);
 const newer=parse(html.replaceAll('Oct 23','Oct 24'),'2026-10-25T00:00:00Z');
 assert.notEqual(first[0].messageId,newer[0].messageId);assert.notEqual(incomingFingerprint(first),incomingFingerprint(newer));
});

test('新观测经news-only模板发布，绝不成为claimed_complete、原帖补证或预测训练动作',()=>{
 const e=evidence(),observation=observedEvidence(e,at)!;
 assert.equal(observation.sourceName,'Codex Limits');assert.equal(observation.observedAt,observedAt);assert.equal(observation.referenceUrl,source.url);
 assert.deepEqual(native.observedEvidence(e,at),observation);assert.equal(referenceCompletionClaim(e),undefined);assert.equal(canEnrich(e),false);
 assert.deepEqual(evidenceBenefitClaims(e,[e]),[]);
 const draft=buildAutomaticTemplate([e])!;
 assert.equal(draft.publicationMode,'news_only');assert.deepEqual(draft.actions,[]);assert.match(draft.summary,/个人账户是否到账请查看实际额度/);
 assert.deepEqual(validateDraft(draft,[e],true),[]);
 const outlook={latestObservation:{...observation,eventId:'event',publicationId:'publication'}};
 assert.deepEqual(timelineObservation(outlook,at),outlook.latestObservation);assert.deepEqual(native.timelineObservation(outlook,at),timelineObservation(outlook,at));
 assert.equal(timelineObservation(outlook,'2026-10-24T17:40:00.000Z'),null);
});

test('观测证明契约在网站/小程序一致：拒绝伪造原帖、时间、分类、来源或正文',()=>{
 const original=evidence();
 const patches:Partial<Evidence>[]=[{sourceId:'manual'},{url:'https://x.com/thsottiaux/status/2113492502355562875'},{parentId:'2113492502355562875'},{contextComplete:true},{textOrigin:'original'},{provenance:'official'},{messageId:'observed-2113492502355562875'},{text:'Done'},{publishedAt:'2026-10-24T17:40:00.000Z'}];
 for(const patch of [{sourceGroup:'other'},{benefitKind:'banked_reset'},{category:'product'}])patches.push({metadata:{...original.metadata,...patch} as Evidence['metadata']});
 for(const patch of [{referenceUrl:'https://example.invalid'},{occurredAt:at},{snapshotAt:observedAt},{summary:'Reset expected tomorrow'},{eventId:'original-post'}])patches.push({metadata:{...original.metadata,referenceReset:{...original.metadata!.referenceReset!,...patch}}});
 for(const patch of patches){const altered={...original,...patch};assert.equal(observedEvidence(altered,at),null,JSON.stringify(patch));assert.deepEqual(native.observedEvidence(altered,at),observedEvidence(altered,at));}
});
