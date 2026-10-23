import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {ActionKind,ActionStage,Evidence,Publication,PublicData} from '../src/lib/types';
import {resetStateCards} from '../src/lib/reset-state-cards';
import {resetObservations} from '../src/lib/reset-observations';
import {publicResetOutlook} from '../src/lib/reset-outlook';
import {publicActions} from '../src/lib/public-facts';
import {referenceForecast} from '../src/lib/forecast';

const now='2026-10-23T19:33:00.000Z'; // 北京时间 10 月 24 日 03:33。
const statementAt='2026-10-23T04:46:19.000Z';
const expectedAt='2026-10-23T18:00:00.000Z';
const observedAt='2026-10-23T17:40:00.000Z';
const collectedAt='2026-10-23T19:30:00.000Z';
const observationPost='2113162413008884099';

function empty():PublicData {
  return {events:[],articles:[],publications:[],evidence:[],notices:[],activities:[],sources:[],site:{name:'首页观测回归',description:'',autoPublish:false,version:1},serverTime:now};
}

function addDeclaration(data:PublicData,id:string,kind:ActionKind='automatic_reset',stage:ActionStage='promised',at=statementAt,expected:string|undefined=expectedAt,eventId=id):Publication {
  const evidenceId=`e-${id}`,publicationId=`p-${id}`;
  const article:Publication['article']={id:`a-${id}`,eventId,publicationId,title:id,summary:id,translation:'',category:'reset',status:'published',version:1,evidenceIds:[evidenceId],publishedAt:at,sourcePublishedAt:at,updatedAt:at};
  const event:Publication['event']={id:eventId,publicationId,status:'published',title:id,version:1,updatedAt:at,evidenceIds:[evidenceId],actions:[{id:`action-${eventId}`,kind,stage,scope:'public',eligibility:'暂未明确',statementAt:at,...(expected&&['promised','in_progress'].includes(stage)?{expectedAt:expected}:{}),evidenceIds:[evidenceId]}]};
  const publication:Publication={id:publicationId,eventId,articleId:article.id,article,event,cutoffAt:at,publishedAt:at,reason:'isolated home regression'};
  data.events=data.events.filter(e=>e.id!==eventId).concat(event);
  data.articles.push(article);data.publications.push(publication);
  data.evidence.push({id:evidenceId,sourceId:'tibo-public',messageId:'2113492187770175603',url:'https://x.com/thsottiaux/status/2113492187770175603',text:'An independently published reset announcement.',publishedAt:at,collectedAt:at,contextComplete:true,historical:false,hash:evidenceId,provenance:'official',textOrigin:'original'});
  return publication;
}

// Reuse the established reset-archive observation contract. Its reference post
// is deliberately different from the current promise: time proximity is not a link.
function archiveObservation(at=observedAt,receivedAt=collectedAt):Evidence {
  return {id:'e-observation',sourceId:'reset-archive',messageId:`observed-${observationPost}`,url:`https://x.com/thsottiaux/status/${observationPost}`,text:'Codex 使用限额已重置。查看你的限额。',publishedAt:at,collectedAt:receivedAt,contextComplete:false,historical:false,hash:'observation-fixture',provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'reset'}};
}

function addObservation(data:PublicData,e=archiveObservation()):Publication {
  const id='observation',publicationId=`p-${id}`,eventId=`event-${id}`;
  const article:Publication['article']={id:`a-${id}`,eventId,publicationId,title:'第三方重置观测',summary:e.text,translation:'',category:'reset',status:'published',version:1,evidenceIds:[e.id],publishedAt:e.collectedAt,sourcePublishedAt:e.publishedAt,updatedAt:e.collectedAt,publicationMode:'news_only'};
  const event:Publication['event']={id:eventId,publicationId,status:'published',title:article.title,version:1,updatedAt:e.collectedAt,evidenceIds:[e.id],actions:[]};
  const publication:Publication={id:publicationId,eventId,articleId:article.id,article,event,mode:'news_only',cutoffAt:e.collectedAt,publishedAt:e.collectedAt,reason:'isolated observation regression'};
  data.events.push(event);data.articles.push(article);data.publications.push(publication);data.evidence.push(e);
  return publication;
}

function fixture(observation:Evidence|null=archiveObservation()):PublicData {
  const data=empty();addDeclaration(data,'promise');
  if(observation)addObservation(data,observation);
  return data;
}

function quota(data:PublicData,at=now) {
  return resetStateCards(data,at).cards.find(c=>c.kind==='automatic_reset')!;
}

function assertNoIndependentObservation(card:ReturnType<typeof quota>) {
  for(const key of ['observationSourceName','observationTime','observationAt','observationPublicationId','observationEventId'] as const)assert.equal(card[key],'',key);
  assert.doesNotMatch(card.dialTitle,/已有重置观测/);
}

function assertParallelObservation(data:PublicData,sourceName:string) {
  const before=structuredClone(data),outlook=publicResetOutlook(data),actions=publicActions(data),card=quota(data);
  assert.equal(card.state,'overdue');
  assert.equal(card.timeAt,expectedAt);assert.equal(card.time,'2026-10-24 02:00');
  assert.equal(card.publicationId,'p-promise');assert.equal(card.eventId,'promise');
  assert.equal(card.observationSourceName,sourceName);
  assert.equal(card.observationAt,observedAt);assert.equal(card.observationTime,'2026-10-24 01:40');
  assert.equal(card.observationPublicationId,'p-observation');assert.equal(card.observationEventId,'event-observation');
  assert.equal(card.expectedElapsed,'原预计时间已过 1小时33分钟');
  assert.match(card.dialTitle,/已有重置观测/);assert.match(card.title,/第三方/);assert.match(card.description,/完成声明/);
  assert.equal(card.metric,'');assert.deepEqual(card.clockParts,[]);
  assert.deepEqual(card.progress.map(p=>p.current),[true,false,false],'独立观测不点亮完成阶段');
  assert.equal(outlook.status,'overdue');assert.equal(outlook.active?.publicationId,'p-promise');
  assert.equal(outlook.active?.expectedAt,expectedAt);assert.equal(outlook.latestGlobalCompletionAt,undefined);
  assert.equal(actions.length,1);assert.equal(actions[0].action.stage,'promised');
  assert.deepEqual(publicResetOutlook(data),outlook);assert.deepEqual(publicActions(data),actions);assert.deepEqual(data,before,'首页投影不得修改原事实或预测输入');
}

test('首页将 01:40 独立观测与 02:00 原预告并列，03:33 仍待完成声明',()=>{
  assertParallelObservation(fixture(),'Codex Resets');
});

test('已有服务器预测与 outlook 投影保持不变，独立观测仅补充首页呈现',()=>{
  const data=fixture();
  data.forecasts={status:'ready',ruleVersion:'home-regression',modelVersion:'home-regression',generatedAt:now,cases:[],reference:referenceForecast(),outlook:publicResetOutlook(data)};
  const forecastBefore=structuredClone(data.forecasts);
  assertParallelObservation(data,'Codex Resets');
  assert.deepEqual(data.forecasts,forecastBefore);
});

test('Codex Limits 真实公开 HTML 的分钟观测进入首页，原预告身份与时间保持独立',async()=>{
  const {parseCodexLimitsObservations}=await import('../src/server/codexlimits-observation-source');
  const html=readFileSync(new URL('./fixtures/codexlimits-reset-observations.html',import.meta.url),'utf8');
  const rows=parseCodexLimitsObservations(html,collectedAt);
  const raw=rows.find(e=>e.publishedAt===observedAt);
  assert.ok(raw,'真实 fixture 必须产生北京时间 01:40 的观测');
  const data=fixture({...raw,id:'e-codexlimits-observation',hash:'fixture-codexlimits',historical:false});
  assert.equal(resetObservations(data)[0]?.sourceName,'Codex Limits');
  assertParallelObservation(data,'Codex Limits');
});

test('较新的预告不被之前的独立观测占据，即使旧观测仍在 24 小时内',()=>{
  const data=fixture();addDeclaration(data,'next-promise','automatic_reset','promised','2026-10-23T18:10:00.000Z','2026-10-23T19:00:00.000Z');
  const card=quota(data);
  assert.equal(card.state,'overdue');assert.equal(card.publicationId,'p-next-promise');assert.equal(card.timeAt,'2026-10-23T19:00:00.000Z');
  assertNoIndependentObservation(card);assert.equal(card.expectedElapsed,'原预计时间已过 33分钟');
});

test('观测时间与预告声明同刻仍独立显示，不凭时间相等将预告标记完成',()=>{
  const data=fixture();data.publications[0].event.actions[0].statementAt=observedAt;
  const card=quota(data);
  assert.equal(card.state,'overdue');assert.equal(card.observationAt,observedAt);assert.equal(card.publicationId,'p-promise');
  assert.equal(publicResetOutlook(data).active?.stage,'promised');
});

test('观测之后同轮公开完成公告优先显示，保留原预告历史且不再显示待确认观测',()=>{
  const data=fixture();addDeclaration(data,'completed','automatic_reset','claimed_complete','2026-10-23T18:20:00.000Z',undefined,'promise');
  const card=quota(data);
  assert.equal(card.state,'completed');assert.equal(card.publicationId,'p-completed');assert.equal(card.timeAt,'2026-10-23T18:20:00.000Z');
  assertNoIndependentObservation(card);assert.equal(card.expectedElapsed,'');
  assert.equal(data.publications[0].event.actions[0].stage,'promised','旧发布版本不改写');
  assert.equal(publicResetOutlook(data).latestGlobalCompletionAt,'2026-10-23T18:20:00.000Z');
});

test('撤回事件、撤回文章和未发布观测不进入首页独立观测',()=>{
  for(const change of [
    (data:PublicData)=>{data.events.find(e=>e.id==='event-observation')!.status='withdrawn';},
    (data:PublicData)=>{data.articles.find(a=>a.id==='a-observation')!.status='withdrawn';},
    (data:PublicData)=>{data.publications=data.publications.filter(p=>p.id!=='p-observation');},
  ]){
    const data=fixture();change(data);const card=quota(data);
    assert.equal(resetObservations(data).length,0);assert.equal(card.state,'overdue');assert.equal(card.timeAt,expectedAt);assertNoIndependentObservation(card);
  }
});

test('未来观测时间、未来采集时间和未来发布时间均不进入首页独立观测',()=>{
  const future='2026-10-23T19:34:00.000Z';
  for(const data of [fixture(archiveObservation(future,future)),fixture(archiveObservation(observedAt,future)),fixture()]){
    if(data.evidence[1].collectedAt===collectedAt)data.publications[1].publishedAt=future;
    assert.equal(resetObservations(data).length,0);assertNoIndependentObservation(quota(data));
  }
});

test('24 小时观察期边界排除过期观测，但不抹去其历史记录',()=>{
  const oldObserved='2026-10-22T19:33:00.000Z';
  for(const at of [oldObserved,'2026-10-22T19:32:59.000Z']){
    const data=empty();addDeclaration(data,'promise','automatic_reset','promised','2026-10-22T10:00:00.000Z');addObservation(data,archiveObservation(at));
    assert.equal(resetObservations(data).length,1,'事实历史仍保留');
    const card=quota(data);assert.equal(card.state,'overdue');assertNoIndependentObservation(card);assert.equal(card.timeAt,expectedAt);
  }
  const fresh=empty();addDeclaration(fresh,'promise','automatic_reset','promised','2026-10-22T10:00:00.000Z');addObservation(fresh,archiveObservation('2026-10-22T19:33:01.000Z'));
  assert.equal(quota(fresh).observationAt,'2026-10-22T19:33:01.000Z','未满 24 小时的有效观测仍可并列');
});

test('额度观测不混入重置卡；两类预告均保持各自的记录和时间',()=>{
  const data=fixture();addDeclaration(data,'banked-promise','banked_reset');
  const view=resetStateCards(data),banked=view.cards.find(c=>c.kind==='banked_reset')!;
  assert.equal(view.cards[0].observationPublicationId,'p-observation');
  assert.equal(banked.state,'overdue');assert.equal(banked.publicationId,'p-banked-promise');assert.equal(banked.timeAt,expectedAt);assertNoIndependentObservation(banked);
  assert.match(banked.description,/重置卡发放完成声明/);assert.equal(view.lastCard,null);
});

test('无有效观测的过点预告说明已过去多久，刚到预计时间不伪称已完成',()=>{
  const data=fixture(null),card=quota(data);
  assert.equal(card.state,'overdue');assert.equal(card.expectedElapsed,'原预计时间已过 1小时33分钟');assertNoIndependentObservation(card);
  assert.match(card.description,/尚未采集到额度重置完成声明/);assert.match(card.description,/不代表你的账户尚未恢复/);
  assert.equal(card.timeAt,expectedAt);assert.equal(publicResetOutlook(data).latestGlobalCompletionAt,undefined);
  const justDue=quota(data,expectedAt);assert.equal(justDue.state,'overdue');assert.equal(justDue.expectedElapsed,'刚到原预计时间');assert.equal(justDue.metric,'');
});
