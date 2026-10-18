import test from 'node:test';
import assert from 'node:assert/strict';
import type {BenefitAction,PublicData,Publication} from '../src/lib/types';
import {publicResetOutlook} from '../src/lib/reset-outlook';
import {announcementCountdown} from '../src/components/public/model';
import {forecastRevision} from '../src/lib/forecast-display';
import {referenceForecast} from '../src/lib/forecast';
import {getPublicForecast} from '../src/server/forecast';
import type {Client} from '../src/db';

const announcedAt='2026-10-10T22:16:20.441Z',deadline='2026-10-11T07:00:00.000Z',completedAt='2026-10-11T04:01:09.077Z';
function publication(stage:BenefitAction['stage']='promised',extra:Partial<BenefitAction>={}):Publication {
 const time=stage==='claimed_complete'?completedAt:announcedAt;
 const action:BenefitAction={id:'same-round',kind:'automatic_reset',scope:'public',stage,statementAt:time,eligibility:'全局范围',evidenceIds:['evidence'],...(stage==='promised'?{expectedAt:deadline,timeNote:'Codex Resets 的日终换算，仅供参考'}:{}),...extra};
 const id=`pub-${stage}`,articleId=`article-${stage}`;
 const event={id:'event',title:'公开重置',status:'published' as const,version:stage==='promised'?1:2,publicationId:id,evidenceIds:['evidence'],updatedAt:time,actions:[action]};
 const article={id:articleId,eventId:event.id,publicationId:id,title:'公开重置',summary:'公开动态',translation:'',category:'reset' as const,status:'published' as const,version:event.version,evidenceIds:['evidence'],publishedAt:time,updatedAt:time,sourcePublishedAt:time,historical:false};
 return {id,eventId:event.id,articleId,event,article,publishedAt:time,cutoffAt:time,mode:'state_change',reason:'隔离状态测试'};
}
function fixture(p=publication(),now='2026-10-11T02:00:00Z'):PublicData {
 return {serverTime:now,events:[p.event],articles:[p.article],publications:[p],evidence:[],notices:[],activities:[],sources:[],site:{name:'隔离测试',description:'',autoPublish:true,version:1}};
}

test('明确预告产生小时倒计时；保留归档换算说明，不靠历史間隔',()=>{
 const data=fixture(),outlook=publicResetOutlook(data);
 assert.equal(outlook.status,'scheduled');assert.equal(outlook.active?.expectedAt,deadline);
 assert.equal(announcementCountdown(outlook.active!,data.serverTime).label,'预计5小时内');
 assert.match(outlook.active?.timeNote??'',/仅供参考/);
});

test('真实同轮顺序：预告→完成→等待新预告，旧预告快照不能复活',()=>{
 const promised=publication(),complete=publication('claimed_complete');
 const data=fixture(complete,'2026-10-11T05:00:00Z');
 data.publications.unshift(promised);data.articles.unshift(promised.article);
 const before=structuredClone(data),outlook=publicResetOutlook(data);
 assert.equal(outlook.status,'completed');assert.equal(outlook.active,undefined);
 assert.equal(outlook.latestCompletion?.statementAt,completedAt);
 assert.equal(outlook.lastResolved?.announcedAt,announcedAt);
 assert.equal(outlook.lastResolved?.announcedDeadline,deadline);
 assert.equal(outlook.lastResolved?.resolvedAt,completedAt);
 assert.deepEqual(data,before,'投影不重写历史数据');
});

test('截至时间到了仍是逾期等待，不能自动完成或转到统计预测',()=>{
 for(const now of [deadline,'2026-10-12T07:00:00Z']){
  const outlook=publicResetOutlook(fixture(publication(),now));
  assert.equal(outlook.status,'overdue');assert.equal(outlook.active?.stage,'promised');assert.equal(outlook.latestCompletion,undefined);
 }
});

test('新一轮预告和旧完成分别保留；不以时间接近合并不同轮次',()=>{
 const complete=publication('claimed_complete'),next=publication('promised',{id:'next-round',statementAt:'2026-10-11T05:10:00Z',expectedAt:'2026-10-11T08:00:00Z'});
 next.id='pub-next';next.eventId=next.event.id='event-next';next.event.publicationId=next.id;next.article.id=next.articleId='article-next';next.article.eventId=next.eventId;next.article.publicationId=next.id;next.publishedAt=next.article.publishedAt=next.event.actions[0].statementAt;
 const data=fixture(complete,'2026-10-11T06:00:00Z');data.events.push(next.event);data.articles.push(next.article);data.publications.push(next);
 const outlook=publicResetOutlook(data);
 assert.equal(outlook.status,'scheduled');assert.equal(outlook.active?.actionId,'next-round');assert.equal(outlook.latestCompletion?.actionId,'same-round');
 assert.equal(outlook.lastResolved?.announcedAt,undefined,'不能借另一事件的预告填充完成历史');
});

test('取消立即关预测；完成和重置卡分别保留原始类型',()=>{
 const cancelled=publicResetOutlook(fixture(publication('cancelled'), '2026-10-11T05:00:00Z'));
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.active,undefined);
 assert.equal(publicResetOutlook(fixture(publication('promised',{kind:'banked_reset'}))).active?.kind,'banked_reset');
 assert.equal(publicResetOutlook(fixture(publication('in_progress'), '2026-10-11T05:00:00Z')).status,'in_progress');
});

test('没有时间的预告不猜小时；没有新证据不能生成下一轮区间',()=>{
 const data=fixture(publication('promised',{expectedAt:undefined}));
 assert.equal(publicResetOutlook(data).status,'announced');
 const empty={...data,events:[],articles:[],publications:[],forecasts:{status:'ready' as const,ruleVersion:'test',modelVersion:'test',generatedAt:data.serverTime,cases:[],reference:referenceForecast()}};
 assert.deepEqual(publicResetOutlook(empty),{status:'monitoring',byKind:{automatic_reset:{status:'monitoring'},banked_reset:{status:'monitoring'}}});
});

test('较早未关联预告不能遮住新完成；保留旧事件原状态而不猜同轮',()=>{
 const old=publication('in_progress',{id:'old-banked',kind:'banked_reset',statementAt:'2026-10-07T19:19:17Z',expectedAt:undefined});
 old.id='old-publication';old.eventId=old.event.id='old-event';old.event.publicationId=old.id;
 old.publishedAt=old.article.publishedAt=old.event.actions[0].statementAt;
 const complete=publication('claimed_complete');
 const data=fixture(complete,'2026-10-11T05:00:00Z');data.events.push(old.event);data.articles.push(old.article);data.publications.push(old);
 const before=structuredClone(data),outlook=publicResetOutlook(data);
 assert.equal(outlook.status,'completed');assert.equal(outlook.active,undefined);
 assert.equal(outlook.latestCompletion?.actionId,'same-round');
 assert.deepEqual(data,before);assert.equal(data.events[1].actions[0].stage,'in_progress');
});

test('另一类福利完成不取消尚未到期的明确安排',()=>{
 const pending=publication('promised',{id:'future-banked',kind:'banked_reset',expectedAt:'2026-10-11T08:00:00Z'});
 pending.id='future-pub';pending.eventId=pending.event.id='future-event';pending.event.publicationId=pending.id;
 const data=fixture(publication('claimed_complete'),'2026-10-11T05:00:00Z');data.events.push(pending.event);data.publications.push(pending);
 assert.equal(publicResetOutlook(data).active?.actionId,'future-banked');
 const overdue=publicResetOutlook({...data,serverTime:'2026-10-11T09:00:00Z'});
 assert.equal(overdue.active?.actionId,'future-banked');assert.equal(overdue.status,'overdue');
});

test('旧预计时间早于新完成时只留在历史，不遮住最新状态或被强行完成',()=>{
 const pending=publication('promised',{id:'old-estimate',kind:'banked_reset',statementAt:'2026-09-03T23:12:09Z',expectedAt:'2026-09-04T02:12:09Z',timeNote:'原文近似时间：并非最晚截止'});
 pending.id='old-estimate-pub';pending.eventId=pending.event.id='old-estimate-event';pending.event.publicationId=pending.id;
 pending.publishedAt=pending.article.publishedAt=pending.event.actions[0].statementAt;
 const data=fixture(publication('claimed_complete'),'2026-10-11T05:00:00Z');data.events.push(pending.event);data.publications.push(pending);
 const before=structuredClone(data),outlook=publicResetOutlook(data);
 assert.equal(outlook.status,'completed');assert.equal(outlook.active,undefined);
 assert.deepEqual(data,before);assert.equal(data.events[1].actions[0].stage,'promised');
});

test('同一时刻的重置完成和独立发卡承诺各自保留',()=>{
 const complete=publication('claimed_complete');
 complete.event.actions.push({...complete.event.actions[0],id:'same-post-banked',kind:'banked_reset',stage:'promised',expectedAt:undefined});
 const outlook=publicResetOutlook(fixture(complete,'2026-10-11T05:00:00Z'));
 assert.equal(outlook.status,'announced');assert.equal(outlook.active?.actionId,'same-post-banked');
 assert.equal(outlook.latestCompletion?.actionId,'same-round');
});

test('私人、定向、仅新闻、撤回、未来预告均不进入公共预测',()=>{
 const cases=[publication('promised',{scope:'private'}),publication('promised',{scope:'targeted'}),publication('promised',{statementAt:'2026-10-12T00:00:00Z'})];
 const news=publication();news.mode='news_only';cases.push(news);
 const withdrawn=publication();withdrawn.event.status='withdrawn';cases.push(withdrawn);
 const future=publication();future.publishedAt='2026-10-12T00:00:00Z';cases.push(future);
 const invalid=publication();invalid.publishedAt='无效时间';cases.push(invalid);
 for(const p of cases)assert.deepEqual(publicResetOutlook(fixture(p)),{status:'monitoring',byKind:{automatic_reset:{status:'monitoring'},banked_reset:{status:'monitoring'}}});
});

test('历史补录预告不冒充现在，历史完成仍可查；延迟证据不制造预测',()=>{
 const old=publication('promised',{statementAt:'2026-09-01T00:00:00Z',expectedAt:undefined});old.article.historical=true;
 assert.equal(publicResetOutlook(fixture(old)).active,undefined);
 const done=publication('claimed_complete');done.article.historical=true;
 assert.equal(publicResetOutlook(fixture(done,'2026-10-11T05:00:00Z')).status,'completed');
});

test('公开版本随本轮完成变化；仅获取时钟变化不制造新消息',()=>{
 const data=fixture(),forecast={status:'ready' as const,ruleVersion:'r',modelVersion:'m',generatedAt:data.serverTime,cases:[],reference:referenceForecast(),outlook:publicResetOutlook(data)};
 assert.deepEqual(forecastRevision({...forecast,generatedAt:'2026-10-11T02:00:30Z'}),forecastRevision(forecast));
 assert.notDeepEqual(forecastRevision({...forecast,outlook:publicResetOutlook(fixture(publication('claimed_complete'),'2026-10-11T05:00:00Z'))}),forecastRevision(forecast));
});

test('历史实验表尚未初始化，公共预告仍可投影，不读取缺失表',async()=>{
 const calls:string[]=[],client={query:async(sql:string)=>{calls.push(sql);return {rows:[{cases:null,snapshots:null,outcomes:null}]};}} as unknown as Client;
 const data=fixture(),view=await getPublicForecast(client,data.serverTime,data);
 assert.equal(view.status,'unavailable');assert.equal(view.outlook?.status,'scheduled');
 assert.equal(view.outlook?.active?.expectedAt,deadline);assert.ok(calls.every(sql=>sql.includes('to_regclass')));
});
