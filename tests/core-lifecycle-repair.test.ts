import test from 'node:test';
import assert from 'node:assert/strict';
import {forecastRevision} from '../src/lib/forecast-display';
import {incomingFingerprint} from '../src/server/ingestion';
import {createRequire} from 'node:module';
import type {Evidence,Publication,PublicData,Notice} from '../src/lib/types';
import {extractBenefitClaims,extractReplyClaims} from '../src/server/benefit-rules';
import {parseReferenceLatest,referenceCompletionClaim,REFERENCE_RESET_SOURCE} from '../src/server/reference-reset-source';
import {parseReferenceOriginal} from '../src/server/source-enrichment';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {validateDraft} from '../src/server/domain';
import {completionElapsed} from '../src/components/public/model';
import {publicResetOutlook} from '../src/lib/reset-outlook';
import {reminderContentCurrent} from '../src/lib/reminder-lifecycle';
import {statusTimelineModel,statusPosterSnapshot,statusTimelineRevision} from '../src/lib/status-timeline';
import {buildReferenceCadence,publicReferenceCadence,referenceCadenceVisible,REFERENCE_CADENCE_VERSION,projectReferenceCadence,validatedReferenceReview} from '../src/lib/reference-cadence';
const require=createRequire(import.meta.url),native=require('../miniprogram/utils/model.js'),nativeTimeline=require('../miniprogram/utils/status-timeline.js');
const sourceAt='2026-10-17T21:12:21.000Z',snapshotAt='2026-10-17T21:41:52.431Z',postId='2111566005684289735',url=`https://x.com/thsottiaux/status/${postId}`;
const snapshot=()=>({schema_version:1,generated_at:snapshotAt,last_global_reset:{event_id:'reset-reference',reset_type:'global',record_status:'recorded',occurred_at:sourceAt,source:{url}},latest_signal:{signal_id:postId,recorded_at:sourceAt,summary:'Done',source:{url}}});
function referenceEvidence():Evidence {
 const raw=parseReferenceLatest(snapshot(),'2026-10-17T22:00:00Z')[0];
 return {...raw,id:'reference-evidence',hash:'fixture',historical:true};
}
function completedEvidence(){return parseReferenceOriginal({code:200,tweet:{id:postId,text:'Done',created_at:'Sat Oct 17 21:12:21 +0000 2026',author:{screen_name:'thsottiaux',id:'1953337039510003712'}}},referenceEvidence(),'2026-10-17T22:00:00Z')!;}
function publication(stage:'promised'|'claimed_complete'='promised'):Publication {
 const action={id:'round-a',kind:'automatic_reset' as const,stage,scope:'public' as const,eligibility:'所有用户',evidenceIds:['proof'],evidenceQuote:'We will reset usage for all accounts.',statementAt:stage==='promised'?'2026-10-17T16:20:00Z':sourceAt,...(stage==='promised'?{expectedAt:'2026-10-18T06:00:00Z'}:{})};
 const event={id:'event-a',title:'重置',version:1,status:'published' as const,actions:[action],evidenceIds:['proof'],publicationId:'pub-a',updatedAt:action.statementAt};
 const article={id:'article-a',eventId:event.id,title:'重置安排',summary:'测试公开安排',translation:'',category:'reset' as const,version:1,status:'published' as const,publicationId:'pub-a',evidenceIds:['proof'],publishedAt:action.statementAt,updatedAt:action.statementAt};
 return {id:'pub-a',eventId:event.id,articleId:article.id,event,article,publishedAt:action.statementAt,cutoffAt:action.statementAt,reason:'fixture',mode:'state_change'};
}
function data(p:Publication):PublicData{return {events:[p.event],articles:[p.article],publications:[p],evidence:[],notices:[],activities:[],sources:[],site:{name:'测试',description:'',autoPublish:true,version:1},serverTime:'2026-10-17T22:00:00Z'};}
const notice:Notice={id:'n',eventId:'event-a',publicationId:'pub-a',semanticKey:'round-a',title:'预告',summary:'',status:'active',categories:['announcement'],createdAt:'2026-10-17T16:21:00Z'};

test('Done仅经明确单一父预告继承福利，裸消息和混合福利不认定完成',()=>{
 assert.deepEqual(extractBenefitClaims('Done',sourceAt),[]);
 const parent=extractBenefitClaims('We will reset usage for all accounts.',sourceAt);
 assert.equal(extractReplyClaims('Done.',sourceAt,parent)[0]?.stage,'claimed_complete');
 assert.deepEqual(extractReplyClaims('Done',sourceAt,[...parent,{...parent[0],kind:'banked_reset'}]),[]);
 assert.deepEqual(extractReplyClaims('Not done',sourceAt,parent),[]);
});
test('参考分类与核验原帖共同补漏，保留原始时间、不虚构父帖，并通过发布事实校验',()=>{
 const excerpt=referenceEvidence();assert.equal(referenceCompletionClaim(excerpt),undefined);
 const original=completedEvidence();assert.ok(original);assert.equal(original.parentId,undefined);
 const claim=referenceCompletionClaim(original);assert.equal(claim?.kind,'automatic_reset');
 const draft=buildAutomaticTemplate([original]);assert.ok(draft);assert.equal(draft.actions[0].statementAt,sourceAt);assert.match(draft.summary,/AIPlanWatch/);
 assert.deepEqual(validateDraft(draft,[original],true),[]);
 assert.equal(referenceCompletionClaim({...original,sourceId:'manual'}),undefined);
 assert.equal(referenceCompletionClaim({...original,text:'Done with lunch'}),undefined);
 assert.equal(parseReferenceOriginal({code:200,tweet:{id:postId,text:'Done',created_at:sourceAt,author:{screen_name:'another',id:'1953337039510003712'}}},excerpt),undefined);
});
test('对账快照必须新鲜、同帖同时间；不把任意recorded清单行当完成',()=>{
 assert.throws(()=>parseReferenceLatest(snapshot(),'2026-10-20T00:00:00Z'));
 assert.throws(()=>parseReferenceLatest(snapshot(),'2026-10-17T21:00:00Z'));
 const mismatched=snapshot();mismatched.latest_signal.source.url=url+'0';assert.equal(parseReferenceLatest(mismatched,'2026-10-17T22:00:00Z')[0].metadata?.referenceReset?.summary,'');
 assert.throws(()=>parseReferenceLatest({schema_version:1,generated_at:snapshotAt,events:[snapshot().last_global_reset]},'2026-10-17T22:00:00Z'));
});
test('上次重置计时跨24小时持续显示且每秒递增，网页与原生一致',()=>{
 const action=publication('claimed_complete').event.actions[0];
 for(const now of ['2026-10-17T21:12:22Z','2026-10-18T22:14:24Z']){
  assert.deepEqual(native.completionElapsed(action,now),completionElapsed(action,now));
 }
 assert.equal(completionElapsed(action,'2026-10-18T22:14:24Z')?.label,'1天1小时2分钟3秒');
 assert.equal(completionElapsed(action,'2026-10-17T21:12:22Z')?.parts.at(-1)?.value,1);
 assert.equal(completionElapsed(action,'2026-10-17T21:12:20Z'),undefined);
});
test('新完成压下无法关联的更早同类预告，但不把旧事件改为完成，另一类安排保留',()=>{
 const old=publication(),done=publication('claimed_complete');done.id='pub-b';done.eventId=done.event.id='event-b';done.event.publicationId=done.id;done.event.actions[0].id='round-b';
 const facts=data(old);done.event.actions[0].evidenceIds=[completedEvidence().id];facts.evidence.push(completedEvidence());facts.events.push(done.event);facts.publications.push(done);facts.articles.push({...done.article,id:'article-b',eventId:done.eventId});
 assert.equal(publicResetOutlook(facts).active,undefined);assert.equal(old.event.actions[0].stage,'promised');
 assert.equal(native.resetOutlookModel(facts).active,null);
 old.event.actions[0].kind='banked_reset';
 assert.equal(publicResetOutlook(facts).active?.kind,'banked_reset');assert.equal(native.resetOutlookModel(facts).active?.kind,'banked_reset');
});
test('入队/发送阶段均可取消过期、完成、取消或改期预告；不取消独立其他动作',()=>{
 const p=publication();assert.equal(reminderContentCurrent(notice,p,p.event,'2026-10-17T22:00:00Z'),true);
 assert.equal(reminderContentCurrent(notice,p,p.event,'2026-10-18T06:00:00Z'),false);
 assert.equal(reminderContentCurrent(notice,p,publication('claimed_complete').event,'2026-10-17T22:00:00Z'),false);
 const another=structuredClone(p.event);another.actions.push({...another.actions[0],id:'banked',kind:'banked_reset',stage:'claimed_complete'});
 assert.equal(reminderContentCurrent(notice,p,another,'2026-10-17T22:00:00Z'),true);
 another.actions[0].expectedAt='2026-10-18T07:00:00Z';assert.equal(reminderContentCurrent(notice,p,another,'2026-10-17T22:00:00Z'),false);
});
test('完成后旧外部安排不得复活，海报与首页同源，秒变化不使海报反复失效',()=>{
 const p=publication('claimed_complete'),facts=data(p),outlook=publicResetOutlook(facts),a=statusTimelineModel(outlook,facts.serverTime);
 assert.deepEqual(nativeTimeline.statusTimelineModel(outlook,facts.serverTime),a);
 assert.equal(a.scheduled,false);
 assert.equal(statusTimelineRevision(a),statusTimelineRevision(statusTimelineModel(outlook,'2026-10-17T22:00:01Z')));
 assert.equal(statusPosterSnapshot(facts).statementAt,sourceAt);assert.equal(statusPosterSnapshot(facts).validUntil,'2026-10-18T21:12:21.000Z');
});
test('历史经验比例只条件计数、不加Beta先验；不足、冷却、未经审计不得公布数字',()=>{
 const start=Date.parse('2026-01-01T00:00:00Z'),points=Array.from({length:35},(_,i)=>({id:String(i),at:new Date(start+i*96*3600000).toISOString(),knownAt:new Date(start+i*96*3600000).toISOString()}));
 const now=new Date(start+34*96*3600000+72*3600000).toISOString();
 const result=buildReferenceCadence(points,now);assert.equal(result.sampleCount,34);assert.equal(result.comparableCount,34);
 assert.deepEqual(result.candidateHorizons.map(p=>p.probability),[1,1,1]);assert.equal(result.status,'pending_review');assert.deepEqual(result.horizons,[]);
 assert.equal(buildReferenceCadence(points,new Date(start+34*96*3600000+1000).toISOString()).status,'reset_just_happened');
 assert.equal(buildReferenceCadence(points.slice(0,12),now).status,'insufficient_data');
 assert.equal(buildReferenceCadence([...points,{id:'future-knowledge',at:points[0].at,knownAt:'2027-01-01T00:00:00Z'}],now).sampleCount,34);
 const publicData=publicReferenceCadence(result);assert.equal('candidateHorizons'in publicData,false);assert.equal('inputFingerprint'in publicData,false);
 assert.equal(referenceCadenceVisible({...publicData,status:'ready',modelVersion:REFERENCE_CADENCE_VERSION,horizons:result.candidateHorizons},'2027-01-01T00:00:00Z'),false);
 assert.equal(native.referenceCadenceView(publicData,now),null);
});

test('重置卡完成不消除额度信号；同轮安排已完成才屏蔽远端旧安排',()=>{
 const at='2026-10-17T20:00:00Z',completion={kind:'banked_reset' as const,stage:'claimed_complete' as const,statementAt:'2026-10-17T21:00:00Z'};
 const watch={status:'active' as const,checkedAt:'2026-10-17T22:00:00Z',signal:{sourceUrl:url,text:'A reset hint',observedAt:at,expiresAt:'2026-10-18T04:00:00Z',forecastWindow:'within a few hours',level:'elevated' as const}};
 const forecasts={status:'ready' as const,ruleVersion:'test',modelVersion:'test',generatedAt:'2026-10-17T22:00:00Z',cases:[],reference:{p24:null,p48:null,interval24:null,interval48:null,counts:[0,0,0] as [number,number,number],prior:[0.5,0.5,1] as [number,number,number],sampleCount:0,sampleIds:[],coverage:'unverified' as const,method:'test',note:'test',calibrated:false as const},watch};
 const outlook={status:'completed' as const,latestCompletion:{...completion,actionId:'banked',eventId:'b',publicationId:'p'}};
 assert.equal(statusTimelineModel(outlook,'2026-10-17T22:00:00Z',completion,forecasts).watching,true);
 assert.equal(statusTimelineModel({...outlook,latestGlobalCompletionAt:'2026-10-17T20:30:00Z'},'2026-10-17T22:00:00Z',completion,forecasts).watching,false);
 const schedule={status:'none' as const,checkedAt:'2026-10-17T22:00:00Z',scheduledReset:{id:postId,kind:'automatic_reset' as const,announcedAt:'2026-10-17T16:00:00Z',scheduledFor:'2026-10-18T04:00:00Z',sourceUrl:url,text:'安排'}};
 const resolved={actionId:'a',eventId:'a',publicationId:'a',kind:'automatic_reset' as const,stage:'claimed_complete' as const,statementAt:sourceAt,resolvedAt:sourceAt,announcedAt:schedule.scheduledReset.announcedAt};
 assert.equal(statusTimelineModel({status:'completed',lastResolved:resolved},'2026-10-17T22:00:00Z',resolved,{...forecasts,watch:schedule}).scheduled,false);
 const other={...schedule,scheduledReset:{...schedule.scheduledReset,announcedAt:'2026-10-17T17:00:00Z'}};
 const ambiguous=statusTimelineModel({status:'completed',lastResolved:resolved},'2026-10-17T22:00:00Z',resolved,{...forecasts,watch:other});
 assert.equal(ambiguous.scheduled,false,'未关联旧安排保留待核验，不覆盖已确认完成');assert.match(ambiguous.detail,/待确认/);
 assert.equal(other.scheduledReset.scheduledFor,'2026-10-18T04:00:00Z','不改写或关闭源数据中的独立轮次');
 other.scheduledReset.announcedAt='2026-10-17T21:30:00Z';
 assert.equal(statusTimelineModel({status:'completed',lastResolved:resolved},'2026-10-17T22:00:00Z',resolved,{...forecasts,watch:other}).scheduled,true,'完成后新预告可独立展示');
});

test('公开概率使用冻结截止，过期或完成锚点变化立即撤下；无审核状态不导致轮询版本反复变化',()=>{
 const frozen={modelVersion:REFERENCE_CADENCE_VERSION,status:'ready' as const,generatedAt:'2026-10-17T22:00:00Z',validUntil:'2026-10-18T04:00:00Z',anchorAt:sourceAt,sampleCount:30,comparableCount:15,horizons:[{hours:24 as const,probability:.2},{hours:48 as const,probability:.4},{hours:72 as const,probability:.6}],reason:'历史参考'};
 const a=projectReferenceCadence(frozen,sourceAt,'2026-10-17T22:01:00Z'),b=projectReferenceCadence(frozen,sourceAt,'2026-10-17T23:00:00Z');
 assert.deepEqual(a,b);assert.equal(a.generatedAt,frozen.generatedAt);
 assert.equal(projectReferenceCadence(frozen,sourceAt,'2026-10-18T04:00:00Z').status,'expired');
 assert.equal(projectReferenceCadence(frozen,'2026-10-18T00:00:00Z','2026-10-18T01:00:00Z').horizons.length,0);
 assert.equal(validatedReferenceReview({modelVersion:REFERENCE_CADENCE_VERSION}),undefined);
 const base={status:'ready' as const,ruleVersion:'test',modelVersion:'test',generatedAt:sourceAt,cases:[],reference:{p24:null,p48:null,interval24:null,interval48:null,counts:[0,0,0] as [number,number,number],prior:[0,0,0] as [number,number,number],sampleCount:0,sampleIds:[],coverage:'unverified' as const,method:'',note:'',calibrated:false as const}};
 assert.deepEqual(forecastRevision({...base,referenceCadence:projectReferenceCadence(undefined,sourceAt,'2026-10-17T22:00:00Z')}),forecastRevision({...base,referenceCadence:projectReferenceCadence(undefined,sourceAt,'2026-10-17T23:00:00Z')}));
});
test('对账仅导出时间变化不重复创建证据，真正新完成消息仍改变输入指纹',()=>{
 const a=parseReferenceLatest(snapshot(),'2026-10-17T22:00:00Z'),newExport=snapshot();newExport.generated_at='2026-10-17T21:51:00Z';
 const b=parseReferenceLatest(newExport,'2026-10-17T22:00:00Z');assert.equal(incomingFingerprint(a),incomingFingerprint(b));
 b[0].text='Done.';assert.notEqual(incomingFingerprint(a),incomingFingerprint(b));
});

test('样本、时间回测和审计同时达标才开放三档概率，审核不完整或未来审核均保持关闭',()=>{
 const start=Date.parse('2025-01-01T00:00:00Z');
 const points=Array.from({length:120},(_,i)=>({id:String(i),at:new Date(start+i*96*3600000).toISOString(),knownAt:new Date(start+i*96*3600000).toISOString()}));
 const now=new Date(start+119*96*3600000+72*3600000).toISOString(),replay={fingerprint:'fixture-immutable-history',pointsAt:(at:string)=>points.filter(p=>Date.parse(p.knownAt)<=Date.parse(at))},candidate=buildReferenceCadence(points,now,undefined,replay);
 assert.ok(candidate.evaluation.points>=30);assert.ok(candidate.evaluation.independentCycles>=10);
 const review={modelVersion:REFERENCE_CADENCE_VERSION,inputFingerprint:candidate.inputFingerprint,reviewedAt:now,reviewedBy:'fixture-reviewer',asOfRevisionsAudited:true,continuousCoverageVerified:true};
 const approved=buildReferenceCadence(points,now,review,replay);assert.equal(approved.status,'ready');assert.deepEqual(approved.horizons.map(p=>p.hours),[24,48,72]);
 assert.equal(buildReferenceCadence(points,now,{...review,continuousCoverageVerified:false},replay).horizons.length,0);
 assert.equal(buildReferenceCadence(points,now,{...review,reviewedAt:new Date(Date.parse(now)+1000).toISOString()},replay).horizons.length,0);
});
