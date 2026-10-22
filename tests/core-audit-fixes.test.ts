import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {Publication,PublicData,Notice} from '../src/lib/types';
import {publicResetOutlook} from '../src/lib/reset-outlook';
import {reminderContentCurrent} from '../src/lib/reminder-lifecycle';
import {statusTimelineModel,statusPosterSnapshot} from '../src/lib/status-timeline';
import {projectPublicForecastRecords} from '../src/server/forecast';
import {REFERENCE_CADENCE_VERSION,referencePointsAt,buildReferenceCadence} from '../src/lib/reference-cadence';
import {parseReferenceSignals,parseReferenceHistory,referencePublicSignal,REFERENCE_SIGNAL_SOURCE} from '../src/server/reference-reset-source';
import {extractBenefitClaims} from '../src/server/benefit-rules';
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
