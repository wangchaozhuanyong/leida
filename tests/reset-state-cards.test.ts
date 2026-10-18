import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {PublicData,Publication,ActionKind,ActionStage} from '../src/lib/types';
import {publicResetOutlook} from '../src/lib/reset-outlook';
import {resetStateCards} from '../src/lib/reset-state-cards';
import {ResetStateCards,ResetStateCardView} from '../src/components/public/ResetStateCards';
import {InstrumentDial} from '../src/components/public/InstrumentDial';
import {referenceForecast} from '../src/lib/forecast';
const require=createRequire(import.meta.url),native=require('../miniprogram/utils/reset-state-cards.js');
const now='2026-10-18T12:00:00.000Z';
function fixture():PublicData{return {site:{name:'仅测试',description:'',version:1,autoPublish:false},events:[],articles:[],publications:[],evidence:[],sources:[],activities:[],notices:[],serverTime:now};}
function add(data:PublicData,id:string,kind:ActionKind,stage:ActionStage,statementAt='2026-10-18T10:00:00Z',expectedAt?:string,eventId=id):Publication{
 const article={id:'a-'+id,eventId,publicationId:'p-'+id,title:id,summary:id,translation:'',category:'reset' as const,status:'published' as const,version:1,evidenceIds:['e-'+id],publishedAt:statementAt,sourcePublishedAt:statementAt,updatedAt:statementAt};
 const event={id:eventId,publicationId:article.publicationId,status:'published' as const,title:id,version:1,updatedAt:statementAt,evidenceIds:article.evidenceIds,actions:[{id:'action-'+eventId,kind,stage,scope:'public' as const,eligibility:'暂未明确',statementAt,expectedAt,evidenceIds:article.evidenceIds}]};
 const publication={id:article.publicationId,eventId,articleId:article.id,article,event,cutoffAt:statementAt,publishedAt:statementAt,reason:'测试'};
 data.events=data.events.filter(e=>e.id!==eventId).concat(event);data.articles.push(article);data.publications.push(publication);
 data.evidence.push({id:'e-'+id,sourceId:'official',messageId:id,url:'https://x.com/thsottiaux/status/2110618732666257557',text:'fixture',publishedAt:statementAt,collectedAt:statementAt,hash:id,contextComplete:true,historical:false,provenance:'official'});
 return publication;
}
function projected(data:PublicData){data.forecasts={status:'ready',ruleVersion:'test',modelVersion:'test',generatedAt:now,cases:[],reference:referenceForecast(),outlook:publicResetOutlook(data)};return data;}
function card(data:PublicData,kind:ActionKind='automatic_reset',at=now){return resetStateCards(data,at).cards.find(c=>c.kind===kind)!;}

test('两类独立：额度已完成仍保留更早的无时间发卡安排，或过点发卡安排',()=>{
 for(const expected of [undefined,'2026-10-18T09:00:00Z','2026-10-18T14:35:00Z']){
  const d=fixture();add(d,'cards','banked_reset','promised','2026-10-18T08:00:00Z',expected);add(d,'reset','automatic_reset','claimed_complete');projected(d);
  assert.equal(card(d).state,'completed');assert.equal(card(d,'banked_reset').state,expected?Date.parse(expected)>Date.parse(now)?'scheduled':'overdue':'announced');
  assert.equal(card(d).title,'额度重置已确认');assert.equal(card(d,'banked_reset').publicationId,'p-cards');
  assert.deepEqual(native.resetStateCards(d,now),resetStateCards(d,now));
 }
});

test('完成超过24小时切回等待，跨天秒计时及上次发卡时间持续保留',()=>{
 const d=fixture();add(d,'reset','automatic_reset','claimed_complete','2026-10-17T00:00:00Z');add(d,'card','banked_reset','claimed_complete','2026-10-16T12:00:00Z');projected(d);
 const model=resetStateCards(d,now);assert.equal(model.cards[0].state,'waiting');assert.match(model.lastReset!.elapsed,/1天12小时0分钟0秒/);assert.ok(model.lastCard);
 const next=resetStateCards(d,'2026-10-18T12:00:01Z');assert.notEqual(next.lastReset!.elapsed,model.lastReset!.elapsed);assert.deepEqual(next.cards,model.cards);
});

test('同轮完成立即结束倒计时，不同轮旧预告只留历史，撤回不再显示安排',()=>{
 const d=fixture();add(d,'old','automatic_reset','promised','2026-10-18T08:00:00Z','2026-10-18T15:00:00Z','round');add(d,'done','automatic_reset','claimed_complete','2026-10-18T10:00:00Z',undefined,'round');add(d,'unmatched','automatic_reset','promised','2026-10-18T07:00:00Z','2026-10-19T15:00:00Z');projected(d);
 assert.equal(card(d).state,'completed');assert.equal(card(d).metric,'');
 const newP=add(d,'new','automatic_reset','promised','2026-10-18T11:00:00Z','2026-10-18T14:00:00Z');newP.event.status='withdrawn';projected(d);assert.equal(card(d).state,'completed');
});

test('明确安排按天小时分钟显示，到点停止；进行中须有进展声明，取消有独立文案',()=>{
 const d=fixture();add(d,'future','automatic_reset','promised',undefined,'2026-10-20T00:45:00Z');projected(d);
 assert.equal(card(d).metric,'1天12小时45分钟');assert.match(card(d).description,/预计时间仅供参考，以实际发放为主/);
 assert.equal(card(d,'automatic_reset','2026-10-20T00:45:00Z').state,'overdue');assert.equal(card(d,'automatic_reset','2026-10-20T00:45:00Z').metric,'');
 const p=add(d,'start','banked_reset','in_progress','2026-10-18T11:00:00Z','2026-10-18T11:30:00Z');projected(d);assert.equal(card(d,'banked_reset').state,'progress');
 p.event.actions[0].stage='cancelled';projected(d);assert.equal(card(d,'banked_reset').title,'本轮发卡安排已取消');assert.equal(card(d,'banked_reset').metric,'');
});

test('时间调整必须同事件同动作，保留原时间并只按最新时间计时',()=>{
 const d=fixture();add(d,'v1','banked_reset','promised','2026-10-18T08:00:00Z','2026-10-18T13:00:00Z','one');add(d,'v2','banked_reset','promised','2026-10-18T09:00:00Z','2026-10-18T14:35:00Z','one');projected(d);
 assert.equal(card(d,'banked_reset').state,'revised');assert.equal(card(d,'banked_reset').metric,'2小时35分钟');assert.match(card(d,'banked_reset').oldTime,/21:00/);
 const legacy=structuredClone(d);delete legacy.forecasts!.outlook;assert.equal(card(legacy,'banked_reset').state,'revised');
});

test('未知类型信号不继承最近完成类别，发布窗口不滚动计时，观察过期回等待',()=>{
 const d=fixture();add(d,'done','banked_reset','claimed_complete','2026-10-18T09:00:00Z');projected(d);
 d.forecasts!.watch={status:'active',checkedAt:now,signal:{sourceType:'observed',text:'A hint',level:'strong',observedAt:'2026-10-18T10:00:00Z',expiresAt:'2026-10-18T14:00:00Z',forecastWindow:'within 2 hours'}};
 const before=JSON.stringify(d),model=resetStateCards(d);assert.equal(model.untyped!.kind,null);assert.equal(model.untyped!.title,'发现重置相关信号');assert.equal(model.untyped!.window,'2小时内');assert.equal(model.untyped!.metric,'');assert.equal(model.cards[1].state,'completed');
 assert.equal(resetStateCards(d,'2026-10-18T13:00:00Z').untyped!.window,'2小时内');assert.equal(resetStateCards(d,'2026-10-18T14:00:00Z').untyped,null);assert.match(resetStateCards(d,'2026-10-18T14:00:00Z').expiredNote,/已过观察期/);assert.equal(JSON.stringify(d),before);
 const html=renderToStaticMarkup(createElement(ResetStateCardView,{card:model.untyped!}));assert.match(html,/没有公开原文链接/);assert.match(html,/不是发放截止时间/);
});

test('已有可信分类的信号按类型显示；来源中断保留完成事实',()=>{
 const d=fixture();projected(d);
 const url='https://x.com/thsottiaux/status/2110618732666257557';
 d.forecasts!.watch={status:'active',checkedAt:now,signal:{sourceUrl:url,text:'public hint',level:'elevated',observedAt:'2026-10-18T10:00:00Z',expiresAt:'2026-10-18T14:00:00Z',forecastWindow:'within 2 hours'}};
 d.forecasts!.cases=[{id:'existing',url,target:'banked_reset',status:'watching',coverage:{status:'verified'},signalEvidenceIds:[]} as any];
 assert.equal(card(d,'banked_reset').title,'预计近期发放重置卡');assert.equal(card(d).state,'waiting');
 add(d,'done','automatic_reset','claimed_complete');projected(d);d.forecasts!.watch={status:'unavailable',checkedAt:now};assert.equal(card(d).state,'completed');assert.match(resetStateCards(d).sourceWarning,/仍保留/);
});

test('旧接口单状态可显示，当前两类投影可靠时优先使用，两类切换入口不混成阶段线',()=>{
 const d=fixture();projected(d);d.forecasts!.outlook={status:'scheduled',active:{actionId:'a',eventId:'e',publicationId:'p',kind:'banked_reset',stage:'promised',statementAt:'2026-10-18T10:00:00Z',expectedAt:'2026-10-18T14:00:00Z'}};
 assert.equal(card(d,'banked_reset').state,'scheduled');assert.equal(card(d).state,'waiting');
 const html=renderToStaticMarkup(createElement(ResetStateCards,{data:d}));assert.match(html,/role="tablist"/);assert.match(html,/重置卡/);assert.match(html,/时间已公布/);assert.doesNotMatch(html,/timeline-stages|较早的安排/);
});

test('未验证的实验分类不能替未知信号归类，旧线索不盖过较新的完成；两个信号按发布时间选择',()=>{
 const d=fixture();projected(d);const url='https://x.com/thsottiaux/status/2110618732666257557';
 d.forecasts!.watch={status:'active',checkedAt:now,signal:{sourceUrl:url,text:'hint',level:'strong',observedAt:'2026-10-18T11:00:00Z',expiresAt:'2026-10-18T14:00:00Z',forecastWindow:'within 2 hours'}};
 d.forecasts!.cases=[{target:'banked_reset',url,status:'watching',coverage:{status:'unverified'},signalEvidenceIds:[]} as any];
 d.forecasts!.referenceSignal={id:'older',sourceName:'AIPlanWatch',sourceUrl:url,text:'earlier',publishedAt:'2026-10-18T10:00:00Z',recordedAt:'2026-10-18T10:30:00Z'};
 assert.equal(resetStateCards(d).untyped!.window,'2小时内');assert.equal(card(d,'banked_reset').state,'waiting');
 add(d,'newer','automatic_reset','claimed_complete','2026-10-18T11:30:00Z');d.forecasts!.outlook=publicResetOutlook(d);assert.equal(resetStateCards(d).untyped,null);assert.equal(card(d).state,'completed');
});

test('CloudBase首页保留两类的公告与独立投影，不因全局只选一轮而丢失另一类',async()=>{
 const {CloudbaseRpc}=await import('../src/server/cloudbase/rpc');const {createCloudbasePublicReader}=await import('../src/server/cloudbase/public-read');
 const d=fixture();add(d,'banked','banked_reset','promised','2026-10-18T08:00:00Z');add(d,'done','automatic_reset','claimed_complete');
 const bundle={...d,page:null,versionData:{digests:Array(5).fill('0'.repeat(32)),sources:[],settings:[],deadlines:[],cases:[],snapshots:[],outcomeDigest:'0'.repeat(32)},forecastRecords:{cases:[],snapshots:[],outcomes:[]}};
 const rpc=new CloudbaseRpc('local-state-qa','synthetic-only',async(_input,init)=>{assert.equal(JSON.parse(String(init?.body)).p_options.view,'home');return Response.json(bundle);});
 const result=await createCloudbasePublicReader(rpc,()=>now).read({view:'home'});
 assert.ok(result.data.publications.some(p=>p.id==='p-banked'));assert.ok(result.data.publications.some(p=>p.id==='p-done'));
 assert.equal(result.data.forecasts?.outlook?.byKind?.banked_reset?.active?.publicationId,'p-banked');assert.equal(card(result.data,'banked_reset').state,'announced');assert.equal(card(result.data).state,'completed');
});


test('桌面表盘跟随所选类别，旧接口的发卡安排仍可显示且不套用额度时长',()=>{
 const d=fixture();projected(d);d.forecasts!.outlook={status:'scheduled',active:{actionId:'a',eventId:'e',publicationId:'p',kind:'banked_reset',stage:'promised',statementAt:'2026-10-18T10:00:00Z',expectedAt:'2026-10-18T14:35:00Z'}};
 const html=renderToStaticMarkup(createElement(InstrumentDial,{data:d,statusKind:'banked_reset',outlook:{status:'monitoring'},serverTime:now}));assert.match(html,/2小时35分钟/);assert.match(html,/重置卡 · /);
 const quota=renderToStaticMarkup(createElement(InstrumentDial,{data:d,statusKind:'automatic_reset',outlook:{status:'monitoring'},serverTime:now}));assert.doesNotMatch(quota,/2小时35分钟/);assert.match(quota,/等待下一次 Reset/);
});
