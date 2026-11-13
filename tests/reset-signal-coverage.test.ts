import test from 'node:test';
import assert from 'node:assert/strict';
import type {Evidence,PublicData,Publication,Source} from '../src/lib/types';
import type {ReferencePublicSignal,ResetSignalReview} from '../src/lib/forecast';
import {referenceForecast} from '../src/lib/forecast';
import {projectPublicForecastRecords} from '../src/server/forecast';
import {collectSource,fetchArchiveSignalLeads,SourceRateLimitError} from '../src/server/ingestion';
import {referencePublicSignals,REFERENCE_SIGNAL_SOURCE,referenceSignalVersion} from '../src/server/reference-reset-source';
import {acceptResetSignalReview,interpretForwardResetSignal,interpretResetHint} from '../src/server/reset-hint';
import {publicResetOutlook} from '../src/lib/reset-outlook';
import {RESET_WATCH_ENDPOINT} from '../src/server/reset-watch';
import {parseTiboresetObservations,TIBORESET_OBSERVATION_SOURCE} from '../src/server/tiboreset-observation-source';
import {TIBO_PUBLIC_SOURCE} from '../src/server/tibo-public';
import {homeResetStatus} from '../miniprogram/utils/home-reset-status';
import {statusPosterInput} from '../miniprogram/utils/home-poster-input';
import {createStatusPosterLayout} from '../miniprogram/packages/poster/status-poster';
import {observedReminderRounds,reminderContentCurrent} from '../src/lib/reminder-lifecycle';
import {pool,list,one,put} from '../src/db';
import type {Candidate,Job} from '../src/lib/types';
import {runForecastCycle} from '../src/server/forecast';
import {getPublicRead} from '../src/server/public-read';
import {createEvidence,defaultSite} from '../src/server/service';
import {enrichKnownEvidence,enrichQuotedResetContext} from '../src/server/source-enrichment';
import {runOne,scheduleDue} from '../src/server/worker';

const ORIGIN='2026-11-11T06:57:08.459Z';
const AT='2026-11-11T12:00:00.000Z';
const HOUR=3600000;
const shifted=(iso:string,hours:number)=>new Date(Date.parse(iso)+hours*HOUR).toISOString();
const snowflake=(at:string)=>((BigInt(Date.parse(at))-1288834974657n)<<22n).toString();
const source=(definition:Source):Source=>({...definition,enabled:true,validated:true,status:'healthy',lastSuccessAt:AT,referenceSnapshotAt:AT});
const tibo=source(TIBO_PUBLIC_SOURCE);
const reference=source(REFERENCE_SIGNAL_SOURCE);
const archive:Source={...tibo,id:'reset-archive',name:'归档',kind:'archive',url:'https://codex-resets.com/zh-CN'};
const sources=[tibo,reference,archive,source(TIBORESET_OBSERVATION_SOURCE)];

function post(text:string,publishedAt=ORIGIN,extra:Partial<Evidence>={}):Evidence {
 const id=snowflake(publishedAt);
 return {id:'post-'+id,hash:id,sourceId:tibo.id,messageId:id,url:'https://x.com/thsottiaux/status/'+id,text,
  publishedAt,collectedAt:publishedAt,contextComplete:true,historical:false,provenance:'archive',textOrigin:'original',
  metadata:{category:'reset',sourceGroup:'fxembed:thsottiaux'},...extra};
}
function data(signals:ReferencePublicSignal[],at=AT,history?:Publication,observation?:Evidence):PublicData {
 const historyList=history?[history]:[];
 return {events:historyList.map(p=>p.event),articles:historyList.map(p=>p.article),publications:historyList,
  evidence:observation?[observation]:[],sources,activities:[],notices:[],serverTime:at,
  site:{name:'隔离回放',description:'',version:1,autoPublish:false},
  forecasts:{status:'ready',generatedAt:at,ruleVersion:'test',modelVersion:'test',cases:[],reference:referenceForecast(),referenceSignals:signals}};
}
function earlierCompletion(at:string):Publication {
 const action={id:'old-banked',kind:'banked_reset' as const,stage:'claimed_complete' as const,scope:'public' as const,
  eligibility:'公开',statementAt:at,evidenceIds:[]};
 const event={id:'old-event',title:'上一次',version:1,status:'published' as const,actions:[action],evidenceIds:[],publicationId:'old-pub',updatedAt:at};
 const article={id:'old-article',eventId:event.id,title:'上一次',summary:'发卡已完成',translation:'',category:'reset' as const,
  version:1,status:'published' as const,publicationId:event.publicationId,evidenceIds:[],publishedAt:at,updatedAt:at};
 return {id:event.publicationId,eventId:event.id,articleId:article.id,event,article,cutoffAt:at,publishedAt:at,reason:'回放夹具'};
}
function cardAt(view:PublicData,kind:'automatic_reset'|'banked_reset',at=view.serverTime) {
 const card=homeResetStatus(view,at).cards.find(item=>item.kind===kind);
 assert.ok(card);
 return card;
}

test('真实周四发卡原帖回放，晚到观测更新首页、转发与两款海报',()=>{
 // https://raw.githubusercontent.com/hzyrgj001/codex-reset-tracker/f45a983d1f/data/raw/posts.json#L17547
 const original=post('Thursday is feeling codexy to me. Perhaps also a good time for a banked reset.',ORIGIN,{
  messageId:'2120410480204525936',url:'https://x.com/thsottiaux/status/2120410480204525936',
  parentId:'2120410006273380750',collectedAt:'2026-11-11T11:58:00.000Z',
 });
 const observedAt='2026-11-12T22:28:26.000Z', collectedAt='2026-11-13T06:35:55.000Z';
 const [observed]=parseTiboresetObservations(
  '<section id="log"><ul><li class="log-item" data-kind="other"><div class="log-item-meta">'+
  '<time class="log-item-abs" datetime="'+observedAt+'"></time><span class="pill">Note</span></div>'+
  '<p class="log-item-text"><a class="log-item-title" href="/r/2121007235465577607">The banked reset Tibo announced landed on our monitoring accounts.</a></p>'+
  '</li></ul></section>',collectedAt,
 );
 const evidence={...observed,id:'observed-report',hash:'fixture',historical:false};
 const publicObservation=earlierCompletion(collectedAt);
 publicObservation.mode='news_only';
 publicObservation.event.actions=[];
 publicObservation.event.evidenceIds=[evidence.id];
 publicObservation.article.evidenceIds=[evidence.id];
 const before=data(referencePublicSignals([original],sources,AT));
 const first=homeResetStatus(before).primary;
 assert.equal(first.hero.title,'周四可能发放');
 assert.equal(first.expectedAt,'2026-11-13T08:00:00.000Z');
 assert.equal(Date.parse(first.expectedAt)-Date.parse(AT),44*HOUR);
 assert.equal(first.hero.metric,'1天20小时0分钟0秒');
 assert.equal(statusPosterInput(before,'banked_reset').shareTitle,first.shareTitle);
 const during=data(before.forecasts!.referenceSignals!,'2026-11-12T22:30:00.000Z',publicObservation,evidence);
 assert.equal(homeResetStatus(during).primary.state,'estimated');
 const after=data(before.forecasts!.referenceSignals!,collectedAt,publicObservation,evidence);
 const card=homeResetStatus(after).primary;
 assert.equal(card.state,'observed');
 assert.equal(card.clockAt,observedAt);
 const poster=statusPosterInput(after);
 assert.equal(poster.statementAt,card.timeAt);
 assert.equal(poster.round,card.revision);
 assert.equal(poster.sharePath,card.sharePath);
 assert.match(poster.sourceLabel,/第三方观测/);
 for(const theme of ['precision','editorial']){
  const layout=createStatusPosterLayout(poster,(text:string,size:number)=>text.length*size,theme);
  assert.ok(layout.commands.some(command=>command.value===poster.title));
  assert.ok(layout.commands.some(command=>command.value===poster.sourceLabel));
 }
 const subsequent=post('We may hand out a reserve reset card.',shifted(observedAt,2));
 const outlook=publicResetOutlook(after,'banked_reset');
 const restarted=referencePublicSignals([original,subsequent],sources,collectedAt,{observedAt:{banked_reset:outlook.latestObservation?.observedAt}});
 assert.equal(restarted.length,2);
 const current=homeResetStatus(data(restarted,collectedAt,publicObservation,evidence)).primary;
 assert.equal(current.expectedAt,shifted(subsequent.publishedAt,48),'上轮已有有效观测，新的未定时间线索有自己的窗口');
 const secondAt=shifted(observedAt,4),secondId=snowflake(secondAt);
 const [secondReport]=parseTiboresetObservations(
  '<section id="log"><ul><li class="log-item" data-kind="other"><div class="log-item-meta">'+
  '<time class="log-item-abs" datetime="'+secondAt+'"></time><span class="pill">Note</span></div>'+
  '<p class="log-item-text"><a class="log-item-title" href="/r/'+secondId+'">A new banked Codex reset landed on our monitoring accounts.</a></p>'+
  '</li></ul></section>',collectedAt,
 );
 const secondEvidence={...secondReport,id:'second-observed-report',hash:'second',historical:false};
 const secondPublication:Publication={...publicObservation,id:'second-pub',articleId:'second-article',eventId:'second-event',
  event:{...publicObservation.event,id:'second-event',publicationId:'second-pub',evidenceIds:[secondEvidence.id]},
  article:{...publicObservation.article,id:'second-article',publicationId:'second-pub',eventId:'second-event',evidenceIds:[secondEvidence.id]}};
 const later=data(restarted,collectedAt,publicObservation,evidence);
 later.evidence.push(secondEvidence);
 later.events.push(secondPublication.event);
 later.articles.push(secondPublication.article);
 later.publications.push(secondPublication);
 assert.equal(homeResetStatus(later).primary.clockAt,secondAt);
});

test('无时间从第一条有效原帖算48小时，转述、重试与过期后的重复措辞不能延长',()=>{
 const first=post('We are toying with handing out a reserve reset card.');
 const repeat=post('We might hand out the banked reset soon.',shifted(ORIGIN,5));
 const lateRepeat=post('We may issue the banked reset soon.',shifted(ORIGIN,49));
 const copy={...first,id:'archived-copy',sourceId:reference.id,collectedAt:shifted(ORIGIN,1),metadata:{
  sourceGroup:'aiplanwatch',referenceSignal:{recordedAt:shifted(ORIGIN,.1),summary:'考虑发卡',referenceUrl:reference.url}}};
 const at=shifted(ORIGIN,6),end=shifted(ORIGIN,48);
 const signals=referencePublicSignals([first,repeat,copy],sources,at);
 assert.equal(signals.length,1);
 assert.equal(signals[0].hint?.expiresAt,end);
 assert.equal(signals[0].sourceUrl,first.url);
 assert.deepEqual(signals[0].sourceNames,['Tibo 公开动态','AIPlanWatch']);
 const older=earlierCompletion(shifted(ORIGIN,-20));
 const view=data(signals,at,older);
 assert.equal(homeResetStatus(view).primary.metricLabel,'距离观察窗口结束');
 assert.equal(homeResetStatus(view).primary.hero.metric,'1天18小时0分钟0秒');
 const reloaded=data(referencePublicSignals([lateRepeat,copy,repeat,first],sources,shifted(ORIGIN,50)),shifted(ORIGIN,50),older);
 const boundary=cardAt(view,'banked_reset',end);
 assert.equal(boundary.state,'completed');
 assert.equal(boundary.timeAt,older.publishedAt);
 assert.equal(boundary.roundNotice?.label,'本轮发卡预测已结束');
 assert.equal(homeResetStatus(reloaded).primary.revision,homeResetStatus(view,end).primary.revision);
 assert.match(statusPosterInput(reloaded).nextNote,/48 小时内暂未确认/);
 assert.notDeepEqual(referenceSignalVersion(signals,at),referenceSignalVersion(signals,end));
});

test('同轮明确期限用后续原帖时间，额外批次和两类预测都保留',()=>{
 const first=post('We may issue a reserve reset card.');
 const quota=post('We plan to reset the Codex quota.',shifted(ORIGIN,1));
 const revised=post('It should land within six hours.',shifted(ORIGIN,2),{parentId:first.messageId});
 const second=post('A second banked reset is coming within 8 hours.',shifted(ORIGIN,3),{parentId:first.messageId});
 const at=shifted(ORIGIN,4);
 const signals=referencePublicSignals([second,quota,first,revised],sources,at);
 const banked=signals.filter(item=>item.hint?.kind==='banked_reset');
 assert.equal(banked.length,2);
 assert.equal(banked[0].hint?.expiresAt,shifted(revised.publishedAt,6));
 assert.equal(banked[0].roundAt,first.publishedAt);
 assert.equal(banked[1].hint?.expiresAt,shifted(second.publishedAt,8));
 const facts=data(signals,at),view=homeResetStatus(facts);
 assert.ok(view.secondary);
 assert.equal(cardAt(facts,'banked_reset').timeAt,shifted(second.publishedAt,8));
 assert.equal(cardAt(facts,'automatic_reset').timeAt,shifted(quota.publishedAt,48));
 const cancellation=post('We will not issue the banked reset.',shifted(ORIGIN,3.5),{parentId:second.messageId});
 const after=data(referencePublicSignals([second,first,revised,quota,cancellation],sources,at),at);
 const firstBatch=cardAt(after,'banked_reset');
 assert.equal(firstBatch.state,'estimated');
 assert.equal(firstBatch.timeAt,shifted(revised.publishedAt,6),'明确取消第二批，不结束第一批');
 const noSecond=data(referencePublicSignals([first,revised,{...cancellation,parentId:first.messageId}],sources,at),at,earlierCompletion(shifted(ORIGIN,-10)));
 assert.equal(cardAt(noSecond,'banked_reset').roundNotice?.basis,'发布者取消声明');
 const weakLater=post('Maybe the banked reset Friday.',shifted(ORIGIN,2.5),{parentId:revised.messageId});
 const guarded=referencePublicSignals([first,revised,weakLater],sources,at);
 assert.equal(guarded[0].hint?.expiresAt,shifted(revised.publishedAt,6));
 const moved=post('Change of plans: we will issue the reserve reset card within 12 hours.',shifted(ORIGIN,3.6));
 assert.equal(referencePublicSignals([first,revised,moved],sources,at)[0].hint?.expiresAt,shifted(moved.publishedAt,12));
 for(const message of ['We cancelled the product demo.','The banked reset was not cancelled.','不会取消重置卡发放。',
  'We won’t issue the banked reset today.','今天不会发放重置卡。','We cancelled the demo. The banked reset is unchanged.']){
  const unrelated=post(message,shifted(ORIGIN,3.7),{parentId:first.messageId});
  assert.equal(referencePublicSignals([first,revised,unrelated],sources,at)[0].cancelled,undefined,message);
 }
});

test('同一条补查到的取消依据同步首页和提醒，并且推迟消息保留原计时',()=>{
 const first=post('We will grant a banked reset to all paid Codex users within six hours.');
 const old=data([],shifted(ORIGIN,1),earlierCompletion(ORIGIN));
 const publication=old.publications[0],action=publication.event.actions[0];
 Object.assign(action,{stage:'promised',expectedAt:shifted(ORIGIN,6),evidenceIds:[first.id]});
 publication.article.evidenceIds=[first.id];
 publication.event.evidenceIds=[first.id];
 old.evidence.push(first);
 const delay=post('We will not issue the banked reset today.',shifted(ORIGIN,.5),{parentId:first.messageId});
 const delayed=referencePublicSignals([first,delay],sources,old.serverTime);
 assert.ok(delayed.some(signal=>signal.id===delay.messageId&&signal.reviewPending));
 assert.equal(homeResetStatus({...old,forecasts:data(delayed,old.serverTime).forecasts}).primary.timeAt,shifted(ORIGIN,6));
 const cancelled={...delay,text:'The banked reset has been cancelled.'};
 const signals=referencePublicSignals([first,cancelled],sources,old.serverTime);
 assert.ok(signals.some(signal=>signal.cancelled));
 assert.equal(homeResetStatus({...old,forecasts:data(signals,old.serverTime).forecasts}).primary.roundNotice?.basis,'发布者取消声明');
 const notice={id:'cancelled-reminder',semanticKey:'announcement',eventId:publication.eventId,publicationId:publication.id,
  title:'发卡预告',summary:'公开发卡安排',status:'active' as const,categories:['announcement' as const],createdAt:ORIGIN};
 assert.equal(reminderContentCurrent(notice,publication,publication.event,old.serverTime,undefined,old.evidence),true);
 assert.equal(reminderContentCurrent(notice,publication,publication.event,old.serverTime,undefined,old.evidence,observedReminderRounds(old,undefined,signals)),false);
});

test('更早发卡完成后，同批旧补充没有重开，独立新线索仍可开窗',()=>{
 const first=post('We may issue a reserve reset card.');
 const repeat=post('We may issue the reserve reset soon.',shifted(ORIGIN,1));
 const completionAt=shifted(ORIGIN,2),at=shifted(ORIGIN,4);
 const second=post('We may issue a reserve reset card.',shifted(ORIGIN,3));
 const signals=referencePublicSignals([first,repeat,second],sources,at,{resolvedAt:{banked_reset:completionAt}});
 assert.equal(signals.length,2);
 assert.equal(signals[0].hint?.expiresAt,shifted(ORIGIN,48));
 assert.equal(signals[1].hint?.expiresAt,shifted(second.publishedAt,48));
});

test('父帖迟到、语义复核和断流保留状态，不能根据补录回填或虚构时间',()=>{
 const parent=post('We may issue a reserve reset card.',ORIGIN,{collectedAt:shifted(ORIGIN,2)});
 const reply=post('明天应该到账。',shifted(ORIGIN,1),{parentId:parent.messageId});
 const at=shifted(ORIGIN,1.5);
 const unknown=post('What about the reserve reset card?',shifted(ORIGIN,.5));
 const known=post('A usage limit reset is on the table.',shifted(ORIGIN,.75));
 const before=referencePublicSignals([parent,reply,unknown,known],sources,at);
 const view=homeResetStatus(data(before,at));
 assert.equal(view.untyped?.title,'有新消息，待核对');
 assert.equal(view.primary.kind,'automatic_reset');
 assert.equal(before.some(item=>item.hint?.kind==='banked_reset'),false);
 const later=shifted(ORIGIN,2);
 const failed=sources.map(item=>item.id===tibo.id?{...item,status:'failed' as const}:item);
 const after=referencePublicSignals([reply,parent,known,unknown],failed,later);
 const projection=projectPublicForecastRecords({cases:[],outcomes:[],sources:failed,snapshots:[],runtime:{referenceSignals:after}},later,data([]),'home');
 const cards=homeResetStatus({...data([],later),forecasts:projection});
 assert.equal(cards.cards.find(item=>item.kind==='banked_reset')?.state,'estimated');
 assert.match(cards.sourceWarning,/更新延迟/);
 assert.equal(after.find(item=>item.hint?.kind==='banked_reset')?.recordedAt,later);
 const unfamiliar=post('Time to put another rain check into the drawer.',shifted(ORIGIN,3));
 const reviewedAt=shifted(ORIGIN,4);
 const result=acceptResetSignalReview({disposition:'future',kind:'banked_reset',quote:unfamiliar.text,expectedAt:'2030-01-01T00:00:00Z'},[unfamiliar],reviewedAt)!;
 const reviews=new Map<string,ResetSignalReview>([[unfamiliar.id,result]]);
 assert.equal(referencePublicSignals([unfamiliar],sources,shifted(ORIGIN,3.5),{reviews}).length,0);
 assert.equal(referencePublicSignals([unfamiliar],sources,reviewedAt,{reviews})[0].hint?.expiresAt,shifted(unfamiliar.publishedAt,48));
 const negated={...unfamiliar,text:'We will not issue another banked reset.'};
 assert.equal(acceptResetSignalReview({disposition:'future',kind:'banked_reset',quote:'issue another banked reset.'},[negated],reviewedAt),undefined);
 const targeted=post('Maybe we will issue a banked reset for my account.',shifted(ORIGIN,5));
 assert.equal(referencePublicSignals([targeted],sources,shifted(ORIGIN,6)).length,0);
});

test('一条原帖给出两个独立安排时保留两类日期与海报，避免混用时间',()=>{
 const original=post('We may issue a reserve reset card on Thursday. We may reset the Codex quota within six hours.');
 const at=shifted(ORIGIN,1);
 const view=data(referencePublicSignals([original],sources,at),at);
 assert.equal(view.forecasts!.referenceSignals!.length,2);
 const banked=cardAt(view,'banked_reset'),quota=cardAt(view,'automatic_reset');
 assert.equal(banked.timeAt,'2026-11-13T08:00:00.000Z');
 assert.equal(quota.timeAt,shifted(ORIGIN,6));
 assert.equal(statusPosterInput(view,'banked_reset').statementAt,banked.timeAt);
 assert.equal(statusPosterInput(view,'automatic_reset').statementAt,quota.timeAt);
});

test('明确期限、日历时区与有效期分开，历史、个人使用、否定和询问不开窗',()=>{
 assert.equal(interpretForwardResetSignal('6小时内发放重置卡，有效期7天。',ORIGIN)?.expiresAt,shifted(ORIGIN,6));
 assert.equal(interpretResetHint('A reserve reset card is on the table for Thursday at 4 PM PT.',ORIGIN)?.expiresAt,'2026-11-13T00:00:00.000Z');
 assert.equal(interpretResetHint('A reserve reset card is on the table for Thursday at 4 PM PT, valid for 7 days.',ORIGIN)?.expiresAt,'2026-11-13T00:00:00.000Z');
 assert.equal(interpretResetHint('周四可能发放重置卡，北京时间。',ORIGIN)?.expiresAt,'2026-11-12T16:00:00.000Z');
 assert.equal(interpretResetHint('We might issue a reset card within three days.',ORIGIN)?.expiresAt,shifted(ORIGIN,72));
 assert.equal(interpretResetHint('我们可能在3天内发放重置卡。',ORIGIN)?.expiresAt,shifted(ORIGIN,72));
 assert.equal(interpretResetHint('We might issue a reset card. It should land within six hours.',ORIGIN)?.expiresAt,shifted(ORIGIN,6));
 assert.equal(interpretResetHint('We might issue a reset card on Thursday at 4 PM ET.',ORIGIN)?.expiresAt,'2026-11-12T21:00:00.000Z');
 assert.equal(interpretResetHint('We might issue a reset card by EOD.',ORIGIN)?.expiresAt,'2026-11-11T08:00:00.000Z');
 assert.equal(interpretResetHint('We might issue a reset card Thursday, PT or ET.',ORIGIN),undefined);
 assert.equal(interpretResetHint('We may issue a banked reset today at 8 AM PT.','2026-11-11T21:00:00.000Z'),undefined);
 for(const text of ['We will never issue another banked reset.','We may have given out a reserve reset yesterday.',
  'We may deliver a banked reset to selected paid users.',
  'How to use your banked reset','Maybe I should use my banked reset this week.','Should we get a reset card?']){
  assert.equal(interpretResetHint(text,ORIGIN)??interpretForwardResetSignal(text,ORIGIN),undefined,text);
 }
});

test('补读公开状态同时保留两个原帖发现，转述只能待核对且不会进入提醒',async()=>{
 const at=new Date().toISOString(),original=post('We might issue a banked reset.',shifted(at,-2));
 const quota=post('We will reset usage limits.',shifted(at,-3));
 const payload={meta:{api_version:'v1',generated_at:at},data:{latest_reset:null,
  scheduled_reset:{id:'quota',reset_type:'regular',status:'scheduled',announced_at:quota.publishedAt,scheduled_for:shifted(at,2),text:'公告摘要',
   source:{type:'x_post',author:'thsottiaux',url:quota.url}},
  active_watch:{level:'elevated',text:'Third-party forecast of a banked reset.',observed_at:shifted(at,-1),expires_at:shifted(at,1),
   forecast_window:'within 3 hours',reset_chance_percent:null,source:{type:'x_post',author:'thsottiaux',url:original.url}},
 }};
 const seen=await fetchArchiveSignalLeads({fetcher:async url=>{assert.equal(String(url),RESET_WATCH_ENDPOINT);return Response.json(payload);}});
 assert.deepEqual(seen.map(item=>item.messageId),[quota.messageId,original.messageId]);
 const partial=structuredClone(payload);
 Object.assign(partial.data.scheduled_reset,{scheduled_for:'格式异常'});
 const {reset_chance_percent:_chance,...optionalChance}=partial.data.active_watch;
 const incomplete=await fetchArchiveSignalLeads({fetcher:async()=>Response.json({...partial,data:{...partial.data,active_watch:optionalChance}})});
 assert.deepEqual(incomplete.map(item=>item.messageId),[original.messageId],'另一条数据损坏时仍保留有效原帖');
 const leads=seen.map(item=>({...item,id:item.messageId,hash:'fixture',historical:false}));
 const now=leads[0].collectedAt;
 const pending=referencePublicSignals(leads,sources,now);
 assert.equal(pending.length,1);
 assert.equal(pending[0].reviewPending,true);
 assert.equal(pending[0].hint,undefined);
 const verified=referencePublicSignals([...leads,original],sources,now);
 assert.equal(verified.find(item=>item.hint)?.hint?.expiresAt,shifted(original.publishedAt,48));
 const pub=earlierCompletion(original.publishedAt);
 pub.mode='news_only';pub.event.actions=[];
 assert.equal(reminderContentCurrent({id:'notice',status:'active',categories:['announcement'],createdAt:now} as never,pub,pub.event,now),false);
 await assert.rejects(fetchArchiveSignalLeads({fetcher:async()=>new Response(null,{status:429,headers:{'Retry-After':'120'}})}),SourceRateLimitError);
});

test('隔离库：公开接口发现、原帖补查、语义复核与首页投影经过真实任务入口',{
 skip:process.env.RADAR_SIGNAL_COVERAGE_INTEGRATION!=='1',
},async t=>{
 const database=new URL(process.env.DATABASE_URL!);
 assert.equal(database.hostname,'127.0.0.1');
 assert.equal(database.port,'55489');
 assert.match(database.pathname,/^\/radar_qa_forecast_coverage(?:_[a-z0-9]+)?$/);
 assert.equal(process.env.RADAR_STORAGE_BACKEND,'native');
 const at=new Date().toISOString();
 const direct=post('We might issue a reserve reset card.',shifted(at,-2));
 const missing=post('A Codex quota reset may be coming within 6 hours.',shifted(at,-1.5));
 const old=post('A historic log entry.',shifted(at,-24));
 const future='2100-01-01T00:00:00.000Z';
 const enabled=sources.map(item=>({...item,lastSuccessAt:at,referenceSnapshotAt:at,nextRunAt:future}));
 await Promise.all(enabled.map(item=>put('sources',item)));
 await put('settings',{...defaultSite,id:'site'});
 const sourceRow='<article class="log-item" data-tweet-id="'+old.messageId+'"><p class="log-item-text">旧归档</p>'+
  '<time data-datetime="'+old.publishedAt+'"></time><a class="log-item-link" href="'+old.url+'">X</a></article>';
 const statusFor=(item:Evidence)=>({meta:{api_version:'v1',generated_at:at},data:{
  latest_reset:null,scheduled_reset:null,
  active_watch:{level:'elevated',forecast_window:'within 30 hours',observed_at:shifted(at,-1),expires_at:shifted(at,1),reset_chance_percent:null,
   text:'第三方转述',source:{type:'x_post',author:'thsottiaux',url:item.url}},
 }});
 const http=(input:Evidence,archiveDown=false,watchDown=false):typeof fetch=>async url=>{
  if(String(url)===RESET_WATCH_ENDPOINT)return watchDown?new Response(null,{status:429,headers:{'Retry-After':'60'}}):Response.json(statusFor(input));
  assert.equal(String(url),archive.url);
  return new Response(sourceRow,{status:archiveDown?503:200});
 };
 const noWait=async()=>{};
 try{
  await collectSource(archive.id,false,{fetcher:http(direct)});
  await collectSource(archive.id,false,{fetcher:http(direct)});
  let raw=await list<Evidence>('evidence');
  assert.equal(raw.filter(item=>item.messageId===direct.messageId).length,1);
  await assert.rejects(collectSource(archive.id,false,{fetcher:http(missing,true),sleep:noWait,onRequestEvent:async()=>{}}),/503/);
  assert.ok((await list<Evidence>('evidence')).some(item=>item.messageId===missing.messageId));
  await collectSource(archive.id,false,{fetcher:http(missing,false,true)});
  assert.equal((await one<Source>('sources',archive.id))?.status,'healthy');
  assert.ok((await list<{action:string}>('audits')).some(item=>item.action==='source.watch_failed'));
  await put('sources',{...enabled.find(item=>item.id===archive.id)!,status:'failed',validated:false,publicationPaused:true,pauseReason:'structure'});
  const enrich=(item:Evidence)=>enrichKnownEvidence(item,async url=>{
   const match=[direct,missing].find(row=>String(url)==='https://api.fxtwitter.com/status/'+row.messageId);
   if(!match)return new Response(null,{status:404});
   return Response.json({code:200,tweet:{id:match.messageId,text:match.text,created_at:match.publishedAt,
    author:{id:'1953337039510003712',screen_name:'thsottiaux',protected:false}}});
  });
  for(let i=0;i<3;i++){
   await scheduleDue({skipSources:true});
   while(await runOne({schedule:false,enrich,enrichQuoted:async()=>[]})){}
  }
  raw=await list<Evidence>('evidence');
  assert.equal(raw.filter(item=>item.textOrigin==='original'&&[direct.messageId,missing.messageId].includes(item.messageId)).length,2);
  assert.equal((await list('notices')).length,0);
  assert.equal((await list('publications')).length,0);
  const knownAt=new Date().toISOString();
  assert.equal((await runForecastCycle(knownAt,{force:true})).status,'ready');
  const boot=(await getPublicRead({view:'home'})).data;
  const home=homeResetStatus(boot);
  assert.equal(home.primary.kind,'banked_reset');
  assert.equal(home.primary.expectedAt,shifted(direct.publishedAt,48));
  assert.equal(home.secondary?.timeAt,shifted(missing.publishedAt,6));
  assert.equal(statusPosterInput(boot).round,home.primary.revision);
  const decisions=await one<{signalDecisions:Record<string,{state:string;projectedAt:string}>}>('settings','forecast_runtime');
  assert.equal(decisions?.signalDecisions[direct.messageId].state,'forecast');
  assert.equal(decisions?.signalDecisions[direct.messageId].projectedAt,knownAt);
  await put('sources',enabled.find(item=>item.id===archive.id)!);
  await put('settings',{id:'ai',enabled:true,encryptedKey:'isolated-fixture',testedAt:at,model:'stub',baseUrl:'https://example.invalid',
   dailyCallLimit:5,dailyBudget:1,inputPrice:1,outputPrice:1,version:1});
  const signal=post('I put a rain check in the drawer for you.',shifted(at,-.5),{sourceId:archive.id,
   metadata:{category:'reset',sourceGroup:'codex-resets'}});
  const {id:_,hash:__,...input}=signal;
  const {candidate}=await createEvidence(input);
  assert.ok(candidate);
  let modelCalls=0;
  await scheduleDue({skipSources:true,allowEnrichment:false});
  for(let i=0;i<10&&await runOne({schedule:false,enrich:async()=>undefined,enrichQuoted:async()=>[],
   generate:async()=>{throw new Error('该条只应进行预测线索复核');},reviewSignal:async rows=>{
    modelCalls++;
    assert.equal(rows[0].messageId,signal.messageId);
    return acceptResetSignalReview({disposition:'future',kind:'banked_reset',quote:signal.text},rows,new Date().toISOString());
   }});i++){}
  assert.equal(modelCalls,1);
  assert.equal((await one<Candidate>('candidates',candidate.id))?.automation?.signalReview?.disposition,'future');
  const duplicate=await createEvidence({...input,sourceId:reference.id,metadata:{sourceGroup:'aiplanwatch',
   referenceSignal:{recordedAt:signal.publishedAt,summary:'相关线索',referenceUrl:reference.url}}});
  assert.ok(duplicate.candidate);
  await scheduleDue({skipSources:true,allowEnrichment:false});
  for(let i=0;i<10&&await runOne({schedule:false,enrich:async()=>undefined,enrichQuoted:async()=>[],generate:async()=>({
   title:'原文',summary:'公开原文',translation:signal.text,category:'reset',evidenceIds:[duplicate.evidence.id],actions:[],
  }),reviewSignal:async()=>{modelCalls++;throw new Error('同一原帖不得重复复核');}});i++){}
  assert.equal(modelCalls,1);
  assert.equal((await list<Job>('jobs')).some(job=>job.kind==='wechat_send'),false);

  await t.test('接口只给回复时补取可信父帖，无模型也能按原文重判',async()=>{
   const parent=post('We may issue a second reserve reset card.',shifted(at,-.35));
   const child=post('It should land within six hours.',shifted(at,-.3),{parentId:parent.messageId});
   const relay:typeof fetch=async url=>{
    assert.match(String(url),/^https:\/\/api\.fxtwitter\.com\/status\/\d+$/);
    const item=[parent,child].find(row=>String(url).endsWith('/'+row.messageId));
    assert.ok(item);
    return Response.json({code:200,tweet:{id:item.messageId,text:item.text,created_at:item.publishedAt,
     author:{id:'1953337039510003712',screen_name:'thsottiaux',protected:false},
     ...(item.parentId?{replying_to:'thsottiaux',replying_to_status:item.parentId}:{})}});
   };
   const [lead]=await fetchArchiveSignalLeads({fetcher:async()=>Response.json(statusFor(child))});
   assert.ok(lead);
   await put('settings',{id:'ai',enabled:false});
   await createEvidence({...lead,historical:false});
   for(let i=0;i<4;i++){
    await scheduleDue({skipSources:true});
    for(let n=0;n<20&&await runOne({schedule:false,enrich:item=>item.messageId===child.messageId?enrichKnownEvidence(item,relay):Promise.resolve(undefined),
     enrichQuoted:(item,all)=>item.messageId===child.messageId?enrichQuotedResetContext(item,all,relay):Promise.resolve([]),
     generate:async()=>{throw new Error('测试禁止生成文章和访问模型');}});n++){}
   }
   const evidence=await list<Evidence>('evidence');
   assert.ok(evidence.some(item=>item.messageId===parent.messageId&&item.textOrigin==='original'));
   const signals=referencePublicSignals(evidence,sources,new Date().toISOString());
   const matched=signals.find(signal=>signal.sourceUrl===child.url);
   assert.equal(matched?.hint?.expiresAt,shifted(child.publishedAt,6));
   assert.equal(matched?.hint?.parentSourceUrl,parent.url);
   assert.equal((await list<Job>('jobs')).some(job=>job.kind==='wechat_send'),false);
  });
 }finally{await pool.end();}
});
