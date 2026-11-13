import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {Publication,PublicData,Notice,Evidence,DraftContent} from '../src/lib/types';
import {publicResetOutlook} from '../src/lib/reset-outlook';
import {reminderContentCurrent} from '../src/lib/reminder-lifecycle';
import {statusTimelineModel,statusPosterSnapshot} from '../src/lib/status-timeline';
import {projectPublicForecastRecords} from '../src/server/forecast';
import {REFERENCE_CADENCE_VERSION,referencePointsAt,buildReferenceCadence} from '../src/lib/reference-cadence';
import {parseReferenceSignals,parseReferenceHistory,referencePublicSignal,projectReferenceSignal,REFERENCE_SIGNAL_SOURCE} from '../src/server/reference-reset-source';
import {extractBenefitClaims} from '../src/server/benefit-rules';
import {interpretResetHint} from '../src/server/reset-hint';
import {needsSemanticReview} from '../src/server/automatic-content';
import {semanticReviewClaims} from '../src/server/semantic-benefit-review';
import {UNKNOWN_BENEFIT_AUDIENCE} from '../src/server/benefit-signal';
import {TIBO_PUBLIC_SOURCE} from '../src/server/tibo-public';
import {evidenceBenefitClaims} from '../src/server/source-context';
import {homeResetStatus} from '../miniprogram/utils/home-reset-status';
const require=createRequire(import.meta.url),native=require('../miniprogram/utils/model.js'),timeline=require('../miniprogram/utils/status-timeline.js');
const now='2026-10-18T03:00:00.000Z',doneAt='2026-10-17T21:12:21.000Z';
function published(stage:'promised'|'claimed_complete',id:string):Publication {
 const at=stage==='promised'?'2026-10-17T16:21:13.000Z':doneAt;
 const action={id:'action-'+id,kind:'automatic_reset' as const,stage,scope:'public' as const,eligibility:'所有用户',evidenceIds:['proof-'+id],evidenceQuote:stage==='promised'?'Global reset by EOD PST.':'Done',statementAt:at,...(stage==='promised'?{expectedAt:'2026-10-18T08:00:00.000Z',timeNote:'原文承诺日终前完成，预计最晚时间已换算为北京时间（UTC+8）'}:{})};
 const event={id:'event-'+id,title:'公开重置',version:1,status:'published' as const,actions:[action],evidenceIds:action.evidenceIds,publicationId:'pub-'+id,updatedAt:at};
 const article={id:'article-'+id,eventId:event.id,title:'重置公告',summary:'公开来源消息',translation:'',category:'reset' as const,version:1,status:'published' as const,publicationId:event.publicationId,evidenceIds:action.evidenceIds,publishedAt:at,updatedAt:at};
 return {id:event.publicationId,eventId:event.id,articleId:article.id,event,article,publishedAt:at,cutoffAt:at,mode:'state_change',reason:'fixture'};
}
function facts(...publications:Publication[]):PublicData {return {events:publications.map(p=>p.event),articles:publications.map(p=>p.article),publications,evidence:[],activities:[],notices:[],sources:[],serverTime:now,site:{name:'测试',description:'',autoPublish:false,version:1}};}
const notice:Notice={id:'notice',eventId:'event-old',publicationId:'pub-old',semanticKey:'fixture',title:'预告',summary:'',categories:['announcement'],status:'active',createdAt:'2026-10-17T16:22:00.000Z'};
test('完整与首页精简数据同态：保留未关联旧预告待核验，不继续倒计时或发送',()=>{
 const old=published('promised','old'),done=published('claimed_complete','done'),d=facts(old,done);
 d.evidence.push({id:'proof-done',sourceId:'aiplanwatch-reference',messageId:'2111566005684289735',url:'https://x.com/thsottiaux/status/2111566005684289735',text:'Done',textOrigin:'original',publishedAt:doneAt,collectedAt:doneAt,provenance:'archive',contextComplete:true,hash:'fixture',historical:false,metadata:{sourceGroup:'aiplanwatch'}});
 const thin={...d,evidence:d.evidence.map(({metadata:_,...e})=>({...e,text:''}))};
 assert.deepEqual(publicResetOutlook(thin),publicResetOutlook(d));
 assert.equal(publicResetOutlook(thin).status,'completed');
 assert.equal(publicResetOutlook(thin).pendingReview?.[0].eventId,old.eventId);
 assert.equal(old.event.actions[0].stage,'promised');
 assert.equal(native.resetOutlookModel(thin).active,null);
 assert.equal(reminderContentCurrent(notice,old,old.event,now,publicResetOutlook(thin).latestResolutions),false);
 old.event.actions[0].kind='banked_reset';
 assert.equal(publicResetOutlook(d).active?.kind,'banked_reset');
 assert.equal(reminderContentCurrent(notice,old,old.event,now,publicResetOutlook(d).latestResolutions),true);
});
test('外部旧安排不能复活；完成后发布的新一轮仍可展示，网页与原生一致',()=>{
 const d=facts(published('claimed_complete','done')),outlook=publicResetOutlook(d);
 const watch={status:'none' as const,checkedAt:now,scheduledReset:{id:'remote',kind:'automatic_reset' as const,announcedAt:'2026-10-17T16:21:13.000Z',scheduledFor:'2026-10-18T08:00:00.000Z',text:'Global reset by EOD PST',sourceUrl:'https://x.com/thsottiaux/status/2111492738025959922'}};
 let web=statusTimelineModel(outlook,now,undefined,{watch} as never);
 assert.equal(web.scheduled,false);assert.equal(web.completed,true);
 assert.deepEqual(timeline.statusTimelineModel(outlook,now,undefined,{watch}),web);
 watch.scheduledReset.announcedAt='2026-10-18T02:00:00.000Z';
 web=statusTimelineModel(outlook,now,undefined,{watch} as never);assert.equal(web.scheduled,true);
 assert.deepEqual(timeline.statusTimelineModel(outlook,now,undefined,{watch}),web);
});
test('首页概率投影使用公开完成锚点，不要求精简接口泄露正文或核验元数据',()=>{
 const d=facts(published('claimed_complete','done'));
 const frozen={modelVersion:REFERENCE_CADENCE_VERSION,status:'ready' as const,generatedAt:'2026-10-18T02:00:00.000Z',validUntil:'2026-10-18T08:00:00.000Z',anchorAt:doneAt,sampleCount:30,comparableCount:20,horizons:[{hours:24 as const,probability:.2},{hours:48 as const,probability:.4},{hours:72 as const,probability:.6}],reason:'审核通过的固定结果'};
 const result=projectPublicForecastRecords({cases:[],outcomes:[],snapshots:[],sources:[{id:'tibo-public',name:'公开动态',kind:'timeline',url:'https://api.fxtwitter.com/2/profile/thsottiaux/statuses',enabled:true,validated:true,version:1,intervalMinutes:10,status:'healthy',lastSuccessAt:now}],runtime:{status:'ready',referenceCadencePublic:frozen}},now,d,'home');
 assert.equal(result.referenceCadence?.status,'ready');assert.equal(result.referenceCadence?.anchorAt,doneAt);
});
test('日终截止与近似时刻分别标注，网页、原生和海报使用同一语义',()=>{
 const p=published('promised','old'),d=facts(p),outlook=publicResetOutlook(d),web=statusTimelineModel(outlook,now);
 assert.match(web.lead,/最晚/);assert.match(web.note,/预计最晚.*前/);
 assert.deepEqual(timeline.statusTimelineModel(outlook,now),web);
 assert.match(statusPosterSnapshot(d).nextNote,/最晚/);
 p.event.actions[0].timeNote='原文近似时间，已换算为北京时间';
 assert.match(statusTimelineModel(publicResetOutlook(d),now).note,/左右/);
});
test('待确认新闻不能沿旧版无动作兼容路径发送微信提醒',()=>{
 const p=published('promised','old');p.event.actions=[];p.mode='news_only';
 assert.equal(reminderContentCurrent(notice,p,p.event,now),false);
});
test('双福利完成表达保留两类，不把个人使用、否定或预告当成公共完成',()=>{
 const text='Dearest gentle codexer.\n\nWe did a sneaky double reset. Not only do you get a full reset on us. But you are also getting one into the reset bank to use at your own leisure. Enjoy';
 const claims=extractBenefitClaims(text,doneAt);
 assert.deepEqual(claims.map(c=>[c.kind,c.stage]),[['automatic_reset','claimed_complete'],['banked_reset','claimed_complete']]);
 assert.deepEqual(extractBenefitClaims(text.replace('We did','We will do'),doneAt),[]);
 assert.deepEqual(extractBenefitClaims(text.replace('We did','We did not do'),doneAt),[]);
 assert.deepEqual(extractBenefitClaims('My account got a double reset and one reset bank credit.',doneAt),[]);
});
test('参考信号只作为有出处的观察，不伪造预测窗口、概率、完成或微信事件',()=>{
 const url='https://x.com/thsottiaux/status/2110951585983631505',snapshot={schema_version:1,generated_at:now,signals:[{signal_id:'2110951585983631505',signal_type:'forecast_source',recorded_at:'2026-10-16T04:30:52.000Z',summary:'公开暗示，让我们打破循环。',source:{url}}]};
 const lead=parseReferenceSignals(snapshot,now)[0];
 assert.equal(lead.textOrigin,'archive_excerpt');
 const original={...lead,id:'signal-proof',hash:'fixture',historical:true,textOrigin:'original' as const,text:'Let us break the cycle.'};
 const source={...REFERENCE_SIGNAL_SOURCE,enabled:true,validated:true,status:'healthy' as const,lastSuccessAt:now,referenceSnapshotAt:now};
 assert.equal(referencePublicSignal([{...original,textOrigin:'archive_excerpt'}],[source],now),undefined);
 const signal=referencePublicSignal([original],[source],now);assert.ok(signal);
 const d=facts();const model=statusTimelineModel(publicResetOutlook(d),now,undefined,{referenceSignal:signal} as never);
 assert.equal(model.watching,true);assert.equal(model.scheduled,false);assert.equal(model.completed,false);assert.equal(model.chanceLabel,'');assert.equal(model.forecastWindow,'');
 assert.deepEqual(timeline.statusTimelineModel(publicResetOutlook(d),now,undefined,{referenceSignal:signal}),model);
 assert.equal(referencePublicSignal([original],[source],now,doneAt),undefined);
 assert.equal(referencePublicSignal([original],[{...source,status:'failed'}],now),undefined);
 const history=parseReferenceHistory({schema_version:1,generated_at:now,events:[{event_id:'banked',reset_type:'banked',record_status:'recorded',occurred_at:doneAt,source:{url:'https://x.com/thsottiaux/status/2111566005684289735'}}]},now);
 assert.equal(history.length,1);assert.equal(history[0].contextComplete,false);assert.equal(history[0].metadata?.referenceReset,undefined);
});
test('历史回放使用当时版本，撤回与未来补录不改写先前训练记录',()=>{
 const p=published('claimed_complete','done');p.event.actions[0].evidenceQuote='Done';
 const e={id:'proof-done',sourceId:'tibo-public',messageId:'2111566005684289735',url:'https://x.com/thsottiaux/status/2111566005684289735',text:'Done',textOrigin:'original' as const,publishedAt:doneAt,collectedAt:doneAt,provenance:'archive' as const,contextComplete:true,hash:'fixture',historical:false};
 const withdrawal=structuredClone(p);withdrawal.id='withdrawal';withdrawal.publishedAt='2026-10-18T02:00:00.000Z';withdrawal.event={...withdrawal.event,status:'withdrawn',publicationId:withdrawal.id};withdrawal.article={...withdrawal.article,status:'withdrawn'};
 const d=facts(p,withdrawal);d.evidence=[e];
 assert.equal(referencePointsAt(d,'2026-10-18T01:00:00.000Z').length,1);
 assert.equal(referencePointsAt(d,now).length,0);
 const wording=structuredClone(p);wording.id='wording';wording.publishedAt='2026-10-18T00:00:00.000Z';wording.event.publicationId=wording.id;
 const edited=facts(p,wording);edited.evidence=[e];
 assert.equal(referencePointsAt(edited,'2026-10-18T01:00:00.000Z')[0].knownAt,doneAt,'文案更新不能把原先已知的完成变成新知识');
 d.evidence[0].collectedAt='2026-10-18T04:00:00.000Z';
 assert.equal(referencePointsAt(d,'2026-10-18T01:00:00.000Z').length,0);
 const points=Array.from({length:120},(_,i)=>({id:String(i),at:new Date(Date.UTC(2025,0,1)+i*96*3600000).toISOString(),knownAt:new Date(Date.UTC(2025,0,1)+i*96*3600000).toISOString()}));
 const cutoff=new Date(Date.parse(points.at(-1)!.at)+72*3600000).toISOString(),candidate=buildReferenceCadence(points,cutoff);
 assert.notEqual(buildReferenceCadence(points,cutoff,{modelVersion:REFERENCE_CADENCE_VERSION,inputFingerprint:candidate.inputFingerprint,reviewedAt:cutoff,reviewedBy:'fixture',asOfRevisionsAudited:true,continuousCoverageVerified:true}).status,'ready','勾选审核不能替代修订回放');
});


test('核验原文中的发卡暗示进入首页主卡，窗口关闭后冷加载也恢复上次发卡计时',()=>{
 const publishedAt='2026-11-11T06:57:08.459Z';
 const checkedAt='2026-11-11T12:00:00.000Z';
 const id='2120410480204525936';
 const url='https://x.com/thsottiaux/status/'+id;
 const text='Thursday is feeling codexy to me. Perhaps also a good time for a banked reset.';
 const source={...REFERENCE_SIGNAL_SOURCE,enabled:true,validated:true,status:'healthy' as const,lastSuccessAt:checkedAt,referenceSnapshotAt:checkedAt};
 const [archive]=parseReferenceSignals({schema_version:1,generated_at:checkedAt,signals:[{signal_id:id,signal_type:'forecast_source',recorded_at:publishedAt,summary:text,source:{url}}]},checkedAt);
 const evidence={...archive,id:'hint-proof',hash:'fixture',historical:false,textOrigin:'original' as const};
 assert.equal(referencePublicSignal([{...evidence,textOrigin:'archive_excerpt'}],[source],checkedAt),undefined);
 assert.equal(referencePublicSignal([{...evidence,text:'We went for a walk.'}],[source],checkedAt)?.hint,undefined);
 const older=previousCardCompletion();
 const quota=published('claimed_complete','quota');
 const quotaAt='2026-11-11T10:47:00.000Z';
 quota.event.actions[0].statementAt=quotaAt;
 quota.cutoffAt=quota.publishedAt=quota.article.publishedAt=quota.event.updatedAt=quotaAt;
 const d=facts(older,quota);
 d.serverTime=checkedAt;d.sources=[source];
 const signal=referencePublicSignal([evidence],[source],checkedAt,quotaAt);
 assert.deepEqual(signal?.hint,{kind:'banked_reset',dayLabel:'周四',expiresAt:'2026-11-13T08:00:00.000Z'});
 const delayedSource={...source,status:'delayed' as const};
 assert.deepEqual(referencePublicSignal([evidence],[delayedSource],checkedAt,quotaAt),signal);
 assert.deepEqual(projectReferenceSignal(signal,[delayedSource],checkedAt),signal);
 assert.equal(projectReferenceSignal(signal,[{...delayedSource,enabled:false}],checkedAt),undefined);
 d.forecasts=projectPublicForecastRecords({cases:[],outcomes:[],sources:[source],snapshots:[],runtime:{referenceSignal:signal}},checkedAt,d,'home');
 const home=homeResetStatus(d);
 assert.equal(home.primary.kind,'banked_reset');
 assert.equal(home.primary.state,'estimated');
 assert.equal(home.primary.hero.title,'周四可能发放');
 assert.equal(home.primary.hero.metric,'1天20小时0分钟');
 assert.equal(home.primary.hero.label,'距推测窗口结束');
 assert.equal(home.primary.timeLabel,'推测窗口结束');
 assert.equal(home.primary.time,'2026-11-13 16:00');
 assert.equal(home.primary.validUntil,'2026-11-13T08:00:00.000Z');
 const oneMinuteLater=homeResetStatus(d,'2026-11-11T12:01:00.000Z').primary;
 assert.equal(oneMinuteLater.hero.metric,'1天19小时59分钟');
 assert.equal(oneMinuteLater.revision,home.primary.revision);
 assert.equal(home.primary.sourceUrl,url);
 assert.equal(home.untyped,null);
 assert.equal(home.lastCard?.publicationId,older.id);
 assert.equal(home.cards.find(card=>card.kind==='automatic_reset')?.state,'completed');
 const end='2026-11-13T08:00:00.000Z';
 const lastMoment=homeResetStatus(d,'2026-11-13T07:59:59.999Z').primary;
 assert.equal(lastMoment.state,'estimated');
 assert.equal(lastMoment.hero.metric,'1秒');

 const delivered=previousCardCompletion('2026-11-12T17:00:00.000Z','new-banked');
 const afterDelivery=facts(older,quota,delivered);
 afterDelivery.forecasts=d.forecasts;
 afterDelivery.serverTime='2026-11-12T17:20:00.000Z';
 const switched=homeResetStatus(afterDelivery).primary;
 assert.equal(switched.state,'completed');
 assert.equal(switched.kind,'banked_reset');
 assert.match(switched.hero.badge,/已发放/);
 assert.equal(switched.hero.title,'距离上次发卡');
 assert.equal(switched.hero.metric,'20分钟');
 assert.equal(switched.publicationId,delivered.id);
 assert.notEqual(switched.revision,home.primary.revision);
 const past=homeResetStatus(d,end).cards.find(card=>card.kind==='banked_reset');
 assert.equal(past?.state,'overdue');assert.equal(past?.hero.metric,'0秒');assert.equal(past?.hero.label,'推测窗口已过');
 assert.equal(projectReferenceSignal(signal,[{...source,lastSuccessAt:end,referenceSnapshotAt:end}],end)?.hint?.expiresAt,end);
 const limit='2026-11-14T08:00:00.000Z',closed=homeResetStatus(d,limit).cards.find(card=>card.kind==='banked_reset');
 assert.equal(closed?.state,'completed');assert.equal(closed?.roundNotice?.label,'本轮发卡预测已结束');
 const reloaded=facts(older,quota);reloaded.serverTime=limit;
 const currentSource={...source,lastSuccessAt:limit,referenceSnapshotAt:limit};
 const retained=referencePublicSignal([evidence],[currentSource],limit,quotaAt);
 assert.deepEqual(retained,signal,'任务重算后保留最近一次已经关闭的推测依据');
 reloaded.forecasts=projectPublicForecastRecords({cases:[],outcomes:[],sources:[currentSource],snapshots:[],runtime:{referenceSignal:retained}},limit,reloaded,'home');
 const refreshed=homeResetStatus(reloaded).cards.find(card=>card.kind==='banked_reset');
 assert.equal(refreshed?.timeAt,older.event.actions[0].statementAt);
 const refreshedPoster=statusPosterSnapshot(reloaded);
 assert.equal(refreshedPoster.round,statusPosterSnapshot(d,limit).round);
 assert.match(refreshedPoster.nextNote,/本轮发卡预测已结束/);
});

function previousCardCompletion(at=doneAt,id='banked') {
 const record=published('claimed_complete',id);
 Object.assign(record.event.actions[0],{kind:'banked_reset',statementAt:at});
 record.publishedAt=record.cutoffAt=record.article.publishedAt=record.event.updatedAt=at;
 return record;
}

test('换说法保留类别，否定、转述、玩笑、混合类别和无关日期不会造出预告',()=>{
 const at='2026-11-11T06:57:08.459Z';
 for(const text of ['We are considering issuing a reset card on Thursday.','We might grant a reserve reset Thursday.','周四可能发放备用重置。']){
  assert.equal(interpretResetHint(text,at)?.kind,'banked_reset',text);
  assert.equal(interpretResetHint(text,at)?.dayLabel,'周四',text);
  assert.deepEqual(extractBenefitClaims(text,at),[],text);
 }
 assert.equal(interpretResetHint('We might restore full Codex quota tomorrow.',at)?.kind,'automatic_reset');
 assert.equal(interpretResetHint('Thursday is the product demo. We might grant a banked reset.',at)?.dayLabel,undefined);
 assert.equal(interpretResetHint('We may issue a banked reset Thursday or Friday.',at)?.dayLabel,undefined);
 assert.equal(interpretResetHint('Tomorrow we might grant a banked reset.',at)?.dayLabel,'周三');
 assert.equal(interpretResetHint('Maybe a banked reset Saturday.','2026-03-07T20:00:00.000Z')?.expiresAt,'2026-03-08T08:00:00.000Z');
 for(const text of ['We may not issue a banked reset Thursday.','We might have granted a banked reset yesterday.','Someone said we might grant a banked reset Thursday.','“Maybe a banked reset on Thursday.”','Maybe a banked reset Thursday. Just kidding.','Could we get a banked reset Thursday?','You might use a banked reset Thursday.','We might issue a banked reset and reset Codex usage limits.','We will grant a banked reset Thursday.','We have already granted a banked reset to all paid Codex users.']){
  assert.equal(interpretResetHint(text,at),undefined,text);
 }
});


function contextualFixture(){
 const checkedAt='2026-11-11T20:00:00.000Z';
 const source={...TIBO_PUBLIC_SOURCE,enabled:true,validated:true,status:'healthy' as const,lastSuccessAt:checkedAt};
 const post=(id:string,text:string,publishedAt:string):Evidence=>({
   id,sourceId:source.id,messageId:id,url:'https://x.com/thsottiaux/status/'+id,text,
   publishedAt,collectedAt:checkedAt,hash:id,textOrigin:'original',contextComplete:true,
   provenance:'archive',historical:false,metadata:{sourceGroup:'fxembed:thsottiaux',category:'reset'},
 });
 const parent=post('2120400000000000000','We will grant a banked reset to all paid Codex users.','2026-11-11T17:00:00.000Z');
 const child={...post('2120410000000000000','We should be able to get it done tomorrow.','2026-11-11T18:00:00.000Z'),parentId:parent.messageId,contextComplete:false};
 return {checkedAt,source,parent,child};
}

test('不等第三方标注：已核验的父帖给短回复提供类别，回复给推测倒计时提供日期',()=>{
 const {checkedAt,source,parent,child}=contextualFixture();
 const ref=referencePublicSignal([child,parent],[source],checkedAt);
 assert.equal(ref?.sourceName,'Tibo 公开动态');
 assert.equal(ref?.sourceUrl,child.url);
 assert.deepEqual(ref?.hint,{kind:'banked_reset',dayLabel:'周四',expiresAt:'2026-11-13T08:00:00.000Z',parentSourceUrl:parent.url});
 assert.deepEqual(evidenceBenefitClaims(child,[child,parent]),[]);
 assert.equal(needsSemanticReview(undefined,[child,parent]),false);
 const guessedAction={...published('promised','guess').event.actions[0],kind:'banked_reset' as const,
   statementAt:child.publishedAt,evidenceIds:[child.id],evidenceQuote:child.text,expectedAt:undefined,
   timeNote:undefined,eligibility:UNKNOWN_BENEFIT_AUDIENCE};
 assert.equal(semanticReviewClaims([child,parent],{actions:[guessedAction]} as DraftContent),undefined);
 const announced=published('promised','parent');
 announced.event.actions[0].kind='banked_reset';
 announced.event.actions[0].statementAt=parent.publishedAt;
 announced.event.actions[0].expectedAt=undefined;
 announced.event.actions[0].evidenceIds=announced.event.evidenceIds=announced.article.evidenceIds=[parent.id];
 announced.publishedAt=announced.cutoffAt=announced.article.publishedAt=announced.event.updatedAt=parent.publishedAt;
 const d=facts(announced);
 d.serverTime=checkedAt;d.evidence=[parent,child];
 d.forecasts=projectPublicForecastRecords({cases:[],outcomes:[],sources:[source],snapshots:[],runtime:{referenceSignal:ref}},checkedAt,d,'home');
 const main=homeResetStatus(d).primary;
 assert.equal(main.state,'estimated');
 assert.equal(main.parentSourceUrl,parent.url);
 assert.equal(main.hero.title,'周四可能发放');
 assert.equal(main.hero.metric,'1天12小时0分钟');
 assert.equal(announced.event.actions[0].stage,'promised');
 announced.event.actions[0].expectedAt='2026-11-12T23:00:00.000Z';
 d.forecasts.outlook=publicResetOutlook(d);
 assert.equal(homeResetStatus(d).primary.state,'scheduled');
 const delivered=previousCardCompletion('2026-11-11T17:45:00.000Z','resolved-parent');
 delivered.eventId=delivered.event.id=delivered.article.eventId=announced.eventId;
 delivered.event.version=2;
 delivered.event.actions[0].id=announced.event.actions[0].id;
 const resolved=facts(announced,delivered);
 resolved.events=[delivered.event];
 resolved.serverTime=checkedAt;resolved.evidence=[parent,child];
 resolved.forecasts={...d.forecasts,outlook:publicResetOutlook(resolved)};
 assert.equal(homeResetStatus(resolved).primary.state,'completed');
});

test('缺父帖、迟到补证、冲突和无关回复保留证据边界，陌生说法进入现有复核',()=>{
 const {checkedAt,source,parent,child}=contextualFixture();
 assert.equal(referencePublicSignal([child],[source],checkedAt),undefined);
 const later='2026-11-11T20:05:00.000Z',lateParent={...parent,collectedAt:later};
 assert.equal(referencePublicSignal([child,lateParent],[source],checkedAt),undefined);
 const late=referencePublicSignal([child,lateParent],[source],later);
 assert.equal(late?.hint?.kind,'banked_reset');
 assert.equal(late?.recordedAt,later);
 assert.equal(projectReferenceSignal(late,[source],checkedAt),undefined);
 const conflicting={...parent,id:'conflicting',text:'We will reset usage limits for all paid Codex users.'};
 assert.equal(referencePublicSignal([child,parent,conflicting],[source],checkedAt),undefined);
 const unknown={...child,text:'Pencils down once the lights come up.'};
 const pending=referencePublicSignal([unknown,parent],[source],checkedAt);
 assert.equal(pending?.reviewPending,true);
 assert.equal(pending?.hint,undefined);
 const newsDraft={actions:[],publicationMode:'news_only'} as unknown as DraftContent;
 assert.equal(needsSemanticReview(newsDraft,[unknown,parent]),true);
 assert.equal(needsSemanticReview(newsDraft,[unknown]),false);
 assert.equal(referencePublicSignal([{...child,text:'👀'}],[source],checkedAt),undefined);
 assert.equal(referencePublicSignal([{...child,text:'We should get it done tomorrow.'},{...parent,text:'Our new editor ships today.'}],[source],checkedAt),undefined);
 const ambiguous={...child,text:'We should ship the new editor tomorrow.'};
 assert.equal(referencePublicSignal([ambiguous,parent],[source],checkedAt)?.hint,undefined);
 const cancelled={...child,text:'We will not get it done tomorrow.'};
 assert.equal(referencePublicSignal([cancelled,parent],[source],checkedAt)?.hint,undefined);
});
