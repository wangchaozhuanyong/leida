import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,mkdtempSync,cpSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import type {Evidence,Publication,PublicData} from '../src/lib/types';
import {resetObservations,observedEvidence,timelineObservation} from '../src/lib/reset-observations';
import {publicResetOutlook} from '../src/lib/reset-outlook';
import {publicActions,sortedStatePublications} from '../src/lib/public-facts';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {parseReferenceLatest} from '../src/server/reference-reset-source';
import {enrichKnownEvidence,enrichCampaignAnchor,parseKnownRelayOriginal} from '../src/server/source-enrichment';
import {gatherEvidenceContext,evidenceBenefitClaims} from '../src/server/source-context';
import {validateDraft} from '../src/server/domain';
import {statusTimelineModel,statusPosterSnapshot} from '../src/lib/status-timeline';
const require=createRequire(import.meta.url),{resetStateCards}=require('../miniprogram/utils/reset-state-cards.js');
const now='2026-10-23T06:00:00.000Z',observedAt='2026-10-22T17:00:00.000Z',post='2113162413008884099';
const original=(messageId:string,text:string,publishedAt:string,parentId?:string):Evidence=>({id:messageId,sourceId:'tibo-public',messageId,url:`https://x.com/thsottiaux/status/${messageId}`,text,publishedAt,collectedAt:now,parentId,contextComplete:false,historical:true,hash:messageId,provenance:'archive',textOrigin:'original',metadata:{sourceGroup:'fxembed:thsottiaux'}});
function observation():Evidence{return {...original('observed-'+post,'Codex 使用限额已重置。查看你的限额。',observedAt),url:`https://x.com/thsottiaux/status/${post}`,sourceId:'reset-archive',collectedAt:'2026-10-23T03:09:11.392Z',textOrigin:'archive_excerpt',historical:false,metadata:{sourceGroup:'codex-resets',category:'reset'}};}
function fixture(e=observation()):PublicData {
 const draft=buildAutomaticTemplate([e])!;
 const p:Publication={id:'observed-publication',eventId:'observed-event',articleId:'observed-article',mode:'news_only',event:{id:'observed-event',title:draft.title,version:1,status:'published',actions:[],evidenceIds:[e.id],publicationId:'observed-publication',updatedAt:e.collectedAt},article:{...draft,id:'observed-article',eventId:'observed-event',version:1,status:'published',publicationId:'observed-publication',publishedAt:e.collectedAt,updatedAt:e.collectedAt},publishedAt:e.collectedAt,cutoffAt:e.collectedAt,reason:'retained observation'};
 return {events:[p.event],articles:[p.article],publications:[p],evidence:[e],notices:[],activities:[],sources:[],site:{name:'雷达',description:'',autoPublish:true,version:1},serverTime:now};
}
test('完整后台任务模块在没有小程序目录的运行边界中仍能加载',()=>{
 const outputs=resolve('outputs');mkdirSync(outputs,{recursive:true});
 const isolated=mkdtempSync(join(outputs,'worker-runtime-'));
 try{
  cpSync(resolve('src'),join(isolated,'src'),{recursive:true});
  const code=`await import(${JSON.stringify(pathToFileURL(join(isolated,'src/server/worker.ts')).href)});const {pool}=await import(${JSON.stringify(pathToFileURL(join(isolated,'src/db/index.ts')).href)});await pool.end();`;
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{encoding:'utf8',timeout:10000,env:{...process.env,NODE_ENV:'test',DATABASE_URL:'postgresql://radar@127.0.0.1:1/runtime_gate'}});
  assert.equal(result.status,0,JSON.stringify({status:result.status,signal:result.signal,errorCode:result.error&&'code' in result.error?result.error.code:null,stderr:result.stderr}));
 }finally{rmSync(isolated,{recursive:true});}
});
test('服务器与原生小程序的观测投影及时间线保持一致',()=>{
 const native=require('../miniprogram/utils/reset-observations.js');
 for(const patch of [{},{sourceId:'manual'},{text:'可能会重置'},{publishedAt:'2026-10-24T00:00:00Z'}]){
  const e={...observation(),...patch},data=fixture(e);
  assert.deepEqual(native.observedEvidence(e,now),observedEvidence(e,now));
  assert.deepEqual(native.resetObservations(data),resetObservations(data));
  const outlook=publicResetOutlook(data);
  assert.deepEqual(native.timelineObservation(outlook,now),timelineObservation(outlook,now));
 }
});
test('真实01:00观测进入公共状态和共享首页计时，不伪造成原帖声明或预测训练动作',()=>{
 const data=fixture(),outlook=publicResetOutlook(data),view=resetStateCards(data);
 assert.equal(outlook.latestObservation?.observedAt,observedAt);
 assert.equal(outlook.byKind?.automatic_reset?.latestObservation?.observedAt,observedAt);
 assert.equal(outlook.latestGlobalCompletionAt,undefined);assert.deepEqual(publicActions(data),[]);
 assert.equal(view.lastReset.statementAt,observedAt);assert.equal(view.lastReset.sourceType,'observed');
 assert.equal(view.cards[0].state,'observed');assert.match(view.cards[0].footer,/依据第三方观测/);
 assert.equal(data.publications[0].mode,'news_only');assert.equal(data.publications[0].event.actions.length,0);
 assert.match(data.articles[0].summary,/观测时间/);assert.equal(view.lastCard,null);
 assert.deepEqual(require('../miniprogram/utils/status-timeline.js').statusTimelineModel(outlook,now),statusTimelineModel(outlook,now));
 assert.equal(statusPosterSnapshot(data).title,'来源观测：用量已重置');assert.equal(statusPosterSnapshot(data).statementAt,observedAt);
});
test('重复采集只呈现一条观测；撤回、未来、其他来源及不明确消息均不能推动计时',()=>{
 const data=fixture();data.evidence.push({...data.evidence[0],id:'new-version',collectedAt:'2026-10-23T04:00:00Z'});data.publications[0].article.evidenceIds.push('new-version');
 assert.equal(resetObservations(data).length,1);
 for(const patch of [{sourceId:'manual'},{text:'可能会重置'},{publishedAt:'2026-10-24T00:00:00Z'},{collectedAt:'2026-10-24T00:00:00Z'},{textOrigin:'original'},{url:'https://evil.invalid/'}]){
  const invalid=fixture({...observation(),...patch} as Evidence);assert.equal(resetObservations(invalid).length,0,JSON.stringify(patch));
 }
 data.events[0].status='withdrawn';assert.equal(resetObservations(data).length,0);
});
test('同帖但发文时间不同的辅助完成记录保存为观测，未来于观测的原帖仍被拒绝',()=>{
 const url=`https://x.com/thsottiaux/status/${post}`;
 const snapshot={schema_version:1,generated_at:now,last_global_reset:{event_id:'source-reset',reset_type:'global',record_status:'recorded',occurred_at:observedAt,source:{url}},latest_signal:{signal_id:post,recorded_at:observedAt,summary:'Codex usage limits have been reset. Check your limits.',source:{url}}};
 const raw=parseReferenceLatest(snapshot,now)[0];assert.equal(raw.messageId,'observed-'+post);assert.equal(raw.publishedAt,observedAt);
 const data=fixture({...raw,id:'reference-observed',hash:'hash',historical:true});assert.equal(resetObservations(data)[0].sourceName,'AIPlanWatch');
 const planned=structuredClone(snapshot);planned.latest_signal.summary='Lands tomorrow before 10am PST.';assert.throws(()=>parseReferenceLatest(planned,now),/TIME_MISMATCH/);
 snapshot.last_global_reset.occurred_at='2026-10-21T00:00:00Z';assert.throws(()=>parseReferenceLatest(snapshot,now),/TIME_MISMATCH/);
});
test('观测不请求原帖补正文，避免把未来安排覆盖成完成观测',async()=>{
 assert.equal(await enrichKnownEvidence(observation(),async()=>{throw new Error('must not fetch');}),undefined);
});
test('历史事件指向其他普通动态时仍找到观测；已有完成观测不被同帖旧信号复活',()=>{
 const data=fixture();data.events[0]={...data.events[0],publicationId:'another-news'};
 assert.equal(sortedStatePublications(data)[0].id,'observed-publication');
 assert.equal(require('../miniprogram/utils/model.js').sortedStatePublications(data)[0].id,'observed-publication');
 data.forecasts={outlook:publicResetOutlook(data),referenceSignal:{sourceUrl:observation().url,publishedAt:'2026-10-22T06:55:54Z',recordedAt:now,sourceName:'AIPlanWatch'}} as any;
 assert.equal(resetStateCards(data).untyped,null);assert.equal(statusTimelineModel(data.forecasts!.outlook!,now,undefined,data.forecasts).watching,false);
 assert.equal(statusPosterSnapshot(data).statementLabel,'观测时间');
});
function campaign(){
 const rule=original('2106845241357824205','Over the next 28 days, each day we’ll either ship one thing that is a clear improvement and relevant for most codex/work users or ship a full reset. Let the improvements begin.','2026-10-04T20:33:43Z');
 const anchor=original('2107158998495748264','Day 1/ We have optimized the default speed to be faster for Codex.','2026-10-05T17:20:29Z',rule.messageId);
 const calendar:Evidence={...anchor,id:'calendar',sourceId:'activity-archive',textOrigin:'archive_excerpt',metadata:{activity:{id:'challenge-28',title:'28天挑战',startsOn:'2026-10-05',timezone:'America/Los_Angeles',days:28,rules:'每天改进或完整重置'}}};
 return [rule,anchor,calendar];
}
test('真实Day17及时间回复形成可核验预告，Day15完成、Day18预告保留不同阶段',()=>{
 const base=campaign();
 const day=original('2113162277688070445','Day 17/ Bet you thought we forgot, but no, it’s reset day today.\n\nAlso good time to remind you to get Daybreak Blue access, it only takes 15 mins and you don’t want to have to do it in the middle of an incident.','2026-10-22T06:55:22Z');
 const reply=original(post,'Lands tomorrow before 10am PST.','2026-10-22T06:55:54Z',day.messageId);
 const all=[...base,day,reply],draft=buildAutomaticTemplate(gatherEvidenceContext(reply,all));
 assert.equal(draft?.publicationMode,'state_change');assert.equal(draft?.actions[0].stage,'promised');
 assert.equal(draft?.actions[0].expectedAt,'2026-10-22T18:00:00.000Z');assert.deepEqual(validateDraft(draft!,gatherEvidenceContext(reply,all),true),[]);
 const data=fixture(),p=structuredClone(data.publications[0]);p.id='announcement-publication';p.eventId=p.event.id='announcement-event';p.event.publicationId=p.id;p.articleId=p.article.id='announcement-article';p.article.eventId=p.eventId;p.article.publicationId=p.id;p.mode=p.article.publicationMode='state_change';p.event.actions=draft!.actions;p.article.evidenceIds=draft!.evidenceIds;p.publishedAt=reply.publishedAt;
 data.events.push(p.event);data.articles.push(p.article);data.publications.push(p);data.evidence.push(...all);
 assert.equal(publicResetOutlook(data).active,undefined,'linked observation stops the same announcement countdown without changing its action');assert.equal(p.event.actions[0].stage,'promised');
 assert.equal(resetStateCards(data).cards[0].state,'observed');
 const missing=all.filter(e=>e.messageId!==base[1].messageId);assert.deepEqual(evidenceBenefitClaims(reply,gatherEvidenceContext(reply,missing)),[]);
 const complete=original('2112432076767289678','Day 15/ Nevermind, we’re still cooking... and reset. Enjoy.','2026-10-20T06:33:48Z');
 assert.equal(evidenceBenefitClaims(complete,gatherEvidenceContext(complete,[...base,complete]))[0]?.stage,'claimed_complete');
 const next=original('2113492187770175603','Day 18/ Decisions API is GA, OpenResponses joined the Linux Foundation, we shipped some performance improvements and Uber is going all-in on codex & work. But yes… that’s a reset!','2026-10-23T04:46:19Z');
 assert.equal(evidenceBenefitClaims(next,gatherEvidenceContext(next,[...base,next]))[0]?.stage,'promised');
 for(const text of ['Day 18/ Maybe that’s a reset!','Day 18/ That’s a reset only for my account.']){
  const invalid={...next,text};assert.equal(evidenceBenefitClaims(invalid,gatherEvidenceContext(invalid,[...base,invalid])).length,0);
 }
});
test('缺少Day1时仅补取固定原帖，必须核验作者、真实时间及真实父关系',async()=>{
 const base=campaign(),day=original('2113162277688070445','Day 17/ it’s reset day today.','2026-10-22T06:55:22Z');
 let calls=0;
 const fetcher:typeof fetch=async input=>{calls++;assert.equal(String(input),'https://api.fxtwitter.com/status/2107158998495748264');return Response.json(JSON.parse(readFileSync(new URL('./fixtures/campaign-day1-quote.json',import.meta.url),'utf8')));};
 const recovered=await enrichCampaignAnchor(day,[base[0],base[2]],fetcher);assert.equal(recovered?.parentId,base[0].messageId);assert.equal(recovered?.historical,true);assert.equal(calls,1);assert.equal(evidenceBenefitClaims(day,gatherEvidenceContext(day,[base[0],base[2],day,recovered!]))[0]?.stage,'promised');
 assert.equal(await enrichCampaignAnchor(day,[...base],async()=>{throw new Error('already saved');}),undefined);
 const bad:typeof fetch=async()=>Response.json({code:200,tweet:{id:base[1].messageId,text:base[1].text,created_at:base[1].publishedAt,author:{id:'1953337039510003712',screen_name:'thsottiaux'}}});
 assert.equal(await enrichCampaignAnchor(day,[base[0],base[2]],bad),undefined);
});

test('Day15完成原帖使用真实原帖编号、作者和编号对应的发布时间',()=>{
 const source=JSON.parse(readFileSync(new URL('./fixtures/campaign-day15-original.json',import.meta.url),'utf8'));
 const id=source.tweet.id,publishedAt=new Date(Number((BigInt(id)>>22n)+1288834974657n)).toISOString();
 const prototype=original(id,'',publishedAt),parsed=parseKnownRelayOriginal(source,prototype,now);
 assert.ok(parsed);assert.equal(parsed.messageId,'2112432076767289678');
 assert.equal(Math.floor(Date.parse(parsed.publishedAt)/1000),Math.floor(Date.parse(source.tweet.created_at)/1000));
 assert.equal(evidenceBenefitClaims(parsed,gatherEvidenceContext(parsed,[...campaign(),parsed]))[0]?.stage,'claimed_complete');
});
