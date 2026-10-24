import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {Evidence,Publication,PublicData} from '../src/lib/types';
import {publicResetOutlook,type ResetOutlook} from '../src/lib/reset-outlook';
import {resetObservations} from '../src/lib/reset-observations';
import {publicActions} from '../src/lib/public-facts';
import {referenceResetPoints} from '../src/lib/reference-cadence';
import {statusPosterSnapshot} from '../src/lib/status-timeline';
import {buildAutomaticTemplate} from '../src/server/automatic-content';

const require=createRequire(import.meta.url);
const model=require('../miniprogram/utils/model.js');
const {statusTimelineModel}=require('../miniprogram/utils/status-timeline.js');
const {statusPosterInput,createStatusPosterLayout}=require('../miniprogram/packages/poster/status-poster.js');
const observedAt='2026-10-22T17:00:00.000Z',now='2026-10-23T06:00:00.000Z',post='2113162413008884099';

function fixture():PublicData {
  const e:Evidence={id:`observed-${post}`,sourceId:'reset-archive',messageId:`observed-${post}`,url:`https://x.com/thsottiaux/status/${post}`,text:'Codex 使用限额已重置。查看你的限额。',publishedAt:observedAt,collectedAt:'2026-10-23T03:09:11.392Z',contextComplete:false,historical:false,hash:'observation-fixture',provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'reset'}};
  const draft=buildAutomaticTemplate([e]);assert.ok(draft);
  const p:Publication={id:'observed-publication',eventId:'observed-event',articleId:'observed-article',mode:'news_only',event:{id:'observed-event',title:draft.title,version:1,status:'published',actions:[],evidenceIds:[e.id],publicationId:'observed-publication',updatedAt:e.collectedAt},article:{...draft,id:'observed-article',eventId:'observed-event',version:1,status:'published',publicationId:'observed-publication',publishedAt:e.collectedAt,updatedAt:e.collectedAt},publishedAt:e.collectedAt,cutoffAt:e.collectedAt,reason:'isolated observation projection test'};
  return {events:[p.event],articles:[p.article],publications:[p],evidence:[e],notices:[],activities:[],sources:[],site:{name:'雷达',description:'',autoPublish:true,version:1},serverTime:now};
}
function supplied(data:PublicData,patch:Partial<ResetOutlook>={}) {
  data.forecasts={outlook:{status:'monitoring',...patch}} as PublicData['forecasts'];
}
function announcement(data:PublicData,stage:'promised'|'claimed_complete',statementAt:string,expectedAt?:string) {
  const p=structuredClone(data.publications[0]);
  p.id='announcement-publication';p.eventId=p.event.id='announcement-event';p.articleId=p.article.id='announcement-article';
  p.event.publicationId=p.article.publicationId=p.id;p.article.eventId=p.eventId;
  p.mode=p.article.publicationMode='state_change';p.publishedAt=statementAt;
  p.event.actions=[{id:'announcement-action',kind:'automatic_reset',stage,scope:'public',eligibility:'公开用户',statementAt,...(expectedAt?{expectedAt}:{}),evidenceIds:[]}];
  p.article.evidenceIds=[];p.event.evidenceIds=[];
  data.events.push(p.event);data.articles.push(p.article);data.publications.push(p);
  return {actionId:'announcement-action',eventId:p.eventId,publicationId:p.id,kind:'automatic_reset' as const,stage,statementAt,...(expectedAt?{expectedAt}:{})};
}

test('旧 API 未提供 outlook 时从已发布的真实证据回退投影观测',()=>{
  const data=fixture(),before=structuredClone(data),outlook=model.resetOutlookModel(data);
  assert.deepEqual(outlook.latestObservation,resetObservations(data)[0]);
  assert.equal(outlook.status,'monitoring');assert.equal(outlook.latestCompletion,null);assert.equal(outlook.active,null);
  assert.equal(outlook.latestGlobalCompletionAt,undefined);
  assert.deepEqual(data,before);
});

test('服务器 outlook 未带观测或带伪造时间时均重新核验公开证据',()=>{
  const data=fixture(),observation=resetObservations(data)[0];
  for(const latestObservation of [undefined,{...observation,observedAt:'2026-10-23T05:59:00Z',sourceName:'未经验证的投影'}]) {
    supplied(data,{...(latestObservation?{latestObservation}:{})});
    assert.deepEqual(model.resetOutlookModel(data).latestObservation,observation);
  }
});

test('没有证据或没有公开发布时不能接受单独的 latestObservation 投影',()=>{
  const data=fixture(),observation=resetObservations(data)[0];supplied(data,{latestObservation:observation});
  for(const missing of ['evidence','publications'] as const) {
    const invalid=structuredClone(data);invalid[missing]=[];
    assert.equal(model.resetOutlookModel(invalid).latestObservation,undefined,missing);
  }
});

test('已撤回、未来或未经核验来源的证据不能通过服务器投影恢复',()=>{
  const data=fixture(),observation=resetObservations(data)[0];supplied(data,{latestObservation:observation});
  const mutations:Array<(d:PublicData)=>void>=[
    d=>{d.events[0].status='withdrawn';},
    d=>{d.articles[0].status='withdrawn';},
    d=>{d.evidence[0].publishedAt='2026-10-24T00:00:00Z';},
    d=>{d.evidence[0].sourceId='manual';},
    d=>{d.evidence[0].text='也许重置了';},
  ];
  for(const mutate of mutations){const invalid=structuredClone(data);mutate(invalid);assert.equal(model.resetOutlookModel(invalid).latestObservation,undefined);}
});

test('按类型投影保留额度观测但不能混入重置卡',()=>{
  const data=fixture(),observation=resetObservations(data)[0];
  supplied(data,{byKind:{automatic_reset:{status:'monitoring'},banked_reset:{status:'monitoring',latestObservation:observation}}});
  assert.deepEqual(model.resetOutlookModel(data,'automatic_reset').latestObservation,observation);
  assert.equal(model.resetOutlookModel(data,'banked_reset').latestObservation,undefined);
  delete data.forecasts;
  assert.deepEqual(model.resetOutlookModel(data,'automatic_reset').latestObservation,observation);
  assert.equal(model.resetOutlookModel(data,'banked_reset').latestObservation,undefined);
});

test('未关联观测保留现有预告及逾期状态，不把另一轮预告变成完成',()=>{
  for(const expectedAt of ['2026-10-23T05:00:00Z','2026-10-23T07:00:00Z']){
    const data=fixture(),active=announcement(data,'promised','2026-10-22T16:00:00Z',expectedAt);
    supplied(data,{status:'scheduled',active});
    const outlook=model.resetOutlookModel(data),timeline=statusTimelineModel(outlook,now);
    assert.deepEqual(outlook.active,active);assert.equal(outlook.latestObservation.observedAt,observedAt);
    assert.equal(outlook.status,Date.parse(expectedAt)<Date.parse(now)?'overdue':'scheduled');
    assert.equal(timeline.completed,false);assert.notEqual(timeline.sourceType,'observed');
    assert.equal(data.publications[1].event.actions[0].stage,'promised');
    delete data.forecasts;
    assert.deepEqual(model.resetOutlookModel(data).active,active);
  }
});

test('小程序海报从实际 model 入口显示观测标题和时间，和网站语义一致',()=>{
  const data=fixture();supplied(data);
  const poster=statusPosterInput(data),web=statusPosterSnapshot({...data,forecasts:{...data.forecasts!,outlook:publicResetOutlook(data)}});
  assert.equal(poster.title,'已有重置观测');assert.equal(poster.label,'距本轮观测');assert.equal(poster.statementLabel,'来源记录时间');
  assert.equal(poster.statementAt,observedAt);assert.equal(poster.publicationId,'observed-publication');
  assert.equal(poster.statementAt,web.statementAt);assert.equal(poster.publicationId,web.publicationId);
  assert.match(poster.sourceLabel,/Codex Resets.*第三方观测/);assert.match(poster.nextNote,/发布者完成声明.*账户以实际/);
  assert.equal(poster.value,'13小时0分钟');assert.equal(poster.unit,'');
  assert.doesNotMatch(`${poster.title} ${poster.label} ${poster.statementLabel}`,/公告称|公告时间|距该公告/);
});

test('两款小程序海报的真实布局命令均使用观测标签',()=>{
  const input=statusPosterInput(fixture());
  for(const theme of ['precision','editorial']){
    const layout=createStatusPosterLayout(input,(value:string,size:number)=>value.length*size,theme,true);
    const texts=layout.commands.filter((c:{type:string})=>c.type==='text').map((c:{value:string})=>c.value);
    assert.ok(texts.includes('已有重置观测'),theme);assert.ok(texts.includes('来源记录时间'),theme);assert.ok(texts.includes('距本轮观测'),theme);
    assert.ok(!texts.includes('公告称已重置用量'),theme);assert.ok(!texts.includes('公告时间'),theme);
  }
});

test('观测超过 24 小时仍可保留事实但不再作为当前完成海报',()=>{
  const data=fixture();data.serverTime='2026-10-23T17:00:00.000Z';
  const outlook=model.resetOutlookModel(data);assert.equal(outlook.latestObservation.observedAt,observedAt);
  const timeline=statusTimelineModel(outlook,data.serverTime);assert.equal(timeline.completed,false);assert.notEqual(timeline.sourceType,'observed');
  assert.notEqual(statusPosterInput(data).title,'来源观测：用量已重置');
});

test('真实完成公告晚于来源观测时保持公告标签',()=>{
  const data=fixture();announcement(data,'claimed_complete','2026-10-23T04:00:00Z');
  const input=statusPosterInput(data);
  assert.equal(input.title,'额度重置已确认');assert.equal(input.label,'距完成声明');assert.equal(input.statementLabel,'完成消息时间');
  assert.equal(input.statementAt,'2026-10-23T04:00:00Z');assert.equal(input.publicationId,'announcement-publication');
});

test('观测投影及海报生成不产生完成动作、预测样本或重复记录',()=>{
  const data=fixture();data.evidence.push({...data.evidence[0],id:'observed-new-collection',collectedAt:'2026-10-23T04:00:00Z'});data.publications[0].article.evidenceIds.push('observed-new-collection');
  const before=structuredClone(data);model.resetOutlookModel(data);statusPosterInput(data);
  assert.equal(resetObservations(data).length,1);assert.deepEqual(publicActions(data),[]);assert.deepEqual(referenceResetPoints(data),[]);
  assert.equal(data.publications[0].event.actions.length,0);assert.deepEqual(data,before);
});
