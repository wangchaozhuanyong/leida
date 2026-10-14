import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {BenefitAction, Publication, PublicData} from '../src/lib/types';
import {announcementClock, completionElapsed, completionTime, latestCompletedBenefits} from '../src/components/public/model';
import {Home} from '../src/components/public/PublicApp';

const now='2026-10-13T08:00:00.000Z';
function publication(id:string,kind:BenefitAction['kind'],statementAt:string):Publication {
 const action:BenefitAction={id:`action-${id}`,kind,stage:'claimed_complete',scope:'public',eligibility:'公开用户',statementAt,evidenceIds:[]};
 const eventId=`event-${id}`,articleId=`article-${id}`;
 const event:Publication['event']={id:eventId,title:'隔离测试公告',status:'published',version:1,publicationId:id,evidenceIds:[],updatedAt:now,actions:[action]};
 const article:Publication['article']={id:articleId,eventId,publicationId:id,title:'隔离测试公告',summary:'公开完成公告',translation:'',category:'reset',status:'published',version:1,evidenceIds:[],historical:false,publishedAt:now,updatedAt:now};
 return {id,eventId,articleId,event,article,publishedAt:now,cutoffAt:now,mode:'state_change',reason:'隔离展示测试'};
}
function fixture(publications:Publication[],serverTime=now):PublicData {
 return {serverTime,events:publications.map(p=>structuredClone(p.event)),articles:publications.map(p=>structuredClone(p.article)),publications,evidence:[],notices:[],activities:[],sources:[],site:{name:'测试雷达',description:'',autoPublish:true,version:1}};
}
const reset=()=>publication('reset','automatic_reset','2026-10-13T05:06:06.031Z');
const card=()=>publication('card','banked_reset','2026-10-13T07:25:00.000Z');

test('最近完成按类型独立保留，原文时间排序，不以本站重新发布时间排序',()=>{
 const old=publication('old-reset','automatic_reset','2026-10-11T05:00:00Z'),r=reset(),c=card();
 r.publishedAt='2026-10-13T05:10:00Z';
 const data=fixture([old,r,c]),before=structuredClone(data);
 const rows=latestCompletedBenefits(data);
 assert.deepEqual(rows.map(row=>row.action.id),['action-card','action-reset']);
 assert.equal(completionElapsed(rows[0].action,now)?.label,'35分钟前');
 assert.equal(completionElapsed(rows[1].action,now)?.label,'2小时53分钟前');
 assert.deepEqual(data,before,'展示选择不修改业务记录');
});
test('未来、无效、未完成、个人、新闻以及撤回记录均不能充当完成依据',()=>{
 const valid=reset(),future=card(),invalid=card(),unpublished=card(),privateRecord=card(),news=card(),withdrawn=card(),promised=card();
 const records=[valid,future,invalid,unpublished,privateRecord,news,withdrawn,promised];
 records.forEach((p,i)=>{p.id=`pub-${i}`;p.eventId=p.event.id=`event-${i}`;p.event.publicationId=p.id;p.articleId=p.article.id=`article-${i}`;p.article.eventId=p.eventId;p.article.publicationId=p.id;p.event.actions[0].id=`action-${i}`;});
 future.event.actions[0].statementAt='2026-10-13T08:00:00.001Z';
 invalid.event.actions[0].statementAt='not-a-date';
 unpublished.publishedAt='2026-10-13T08:00:00.001Z';
 privateRecord.event.actions[0].scope='private';news.mode='news_only';withdrawn.article.status='withdrawn';promised.event.actions[0].stage='promised';
 const data=fixture(records);
 assert.deepEqual(latestCompletedBenefits(data).map(row=>row.publication.id),[valid.id]);
 assert.deepEqual(latestCompletedBenefits({...data,serverTime:'invalid'}),[]);
 unpublished.publishedAt='invalid';assert.equal(latestCompletedBenefits(data).length,1);
});
test('24小时展示从公开声明起算；之后仍保留两类完成记录及正确原文链接',()=>{
 const data=fixture([reset(),card()],'2026-10-14T08:00:00.000Z');
 const html=renderToStaticMarkup(createElement(Home,{data,historical:false,onWechatReminders:()=>{},onPoster:()=>{},onShare:async()=>{}}));
 assert.match(html,/等待预告/);assert.doesNotMatch(html,/is-completed/);
 assert.match(html,/公告称已重置用量/);assert.match(html,/公告称已发放重置卡/);
 assert.match(html,/href="\/events\/event-reset"/);assert.match(html,/href="\/events\/event-card"/);
 assert.match(html,/2026\/10\/13 13:06/);assert.match(html,/2026\/10\/13 15:25/);
 assert.equal(latestCompletedBenefits(data).length,2);
});
test('日期包含年份，跨年和零点按北京时间显示',()=>{
 assert.equal(completionTime('2026-10-13T05:06:06.031Z'),'2026/10/13 13:06');
 assert.equal(completionTime('2026-12-31T16:00:00Z'),'2027/01/01 00:00');
 assert.equal(completionTime('invalid'),'暂无记录');
});
test('刷新后的服务器时间延续原公告计时，整小时不显示零分钟',()=>{
 const action=reset().event.actions[0];
 assert.equal(completionElapsed({...action,statementAt:'2026-10-13T06:00:00Z'},now)?.label,'2小时前');
 assert.equal(completionElapsed({...action,statementAt:'2026-10-13T07:59:30Z'},now)?.label,'刚刚');
 assert.equal(completionElapsed(action,'2026-10-13T09:00:00Z')?.label,'3小时53分钟前');
 assert.equal(completionElapsed({...action,stage:'promised'},now),undefined);
 assert.equal(completionElapsed(action,'invalid'),undefined);
});
test('页面打开期间以服务器时钟推进，跨过24小时边界即停止展示完成时长',()=>{
 const action=reset().event.actions[0],baseline='2026-10-14T05:06:05.031Z';
 assert.equal(completionElapsed(action,announcementClock(baseline,0))?.label,'23小时59分钟前');
 assert.equal(completionElapsed(action,announcementClock(baseline,1000)),undefined);
 assert.equal(completionElapsed(action,announcementClock(baseline,2000)),undefined);
});
