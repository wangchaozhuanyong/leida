import test from 'node:test';
import assert from 'node:assert/strict';
import type { Article, Evidence, PublicData, Publication } from '../src/lib/types';
import { isHistoricalEvidence, isHistoricalContent, isHistoricalArticle, projectPublicHistory } from '../src/lib/history';
import { upcomingActions, publicActions, articleSourceTime, publicationSourceTime, publicationWithdrawn, sortedStatePublications } from '../src/components/public/model';
import { posterSvg } from '../src/server/poster';

const old = '2026-07-16T04:14:09Z', collected = '2026-10-09T13:58:56.474Z';
const evidence = (id='old', extra:Partial<Evidence>={}):Evidence => ({id,hash:id,sourceId:'reset-archive',messageId:id,url:`https://example.org/${id}`,text:'原始记录',publishedAt:old,collectedAt:collected,contextComplete:true,historical:false,provenance:'archive',...extra});
const article = (id='article', extra:Partial<Article>={}):Article => ({id,eventId:'event',title:'历史来源记录',summary:'按保存原文记录',translation:'',category:'reset',version:1,status:'published',publicationId:'pub',evidenceIds:['old'],publishedAt:'2026-10-09T15:30:19.362Z',updatedAt:'2026-10-09T15:30:19.362Z',historical:false,...extra});
const data = ():PublicData => {
  const a=article();
  const event:Publication['event']={id:'event',title:a.title,version:1,status:'published',publicationId:'pub',updatedAt:a.publishedAt,evidenceIds:['old'],actions:[{id:'action',kind:'banked_reset',stage:'promised',eligibility:'所有账户',scope:'public',evidenceIds:['old'],statementAt:old}]};
  return {evidence:[evidence()],articles:[{...a,version:2,historical:true}],events:[event],publications:[{id:'pub',articleId:a.id,eventId:event.id,event,article:a,cutoffAt:collected,publishedAt:a.publishedAt,reason:'原始版本说明'}],notices:[],activities:[],sources:[],site:{name:'模钥重置雷达',description:'',autoPublish:true,version:1},serverTime:collected};
};

test('旧false标记按保存时的真实时间兼容，边界及不完整时间不冒充实时',()=>{
  assert.equal(isHistoricalEvidence(evidence()),true);
  const first='2026-10-09T00:00:00Z';
  assert.equal(isHistoricalEvidence(evidence('fresh',{publishedAt:first,collectedAt:'2026-10-10T00:00:00Z'})),false);
  assert.equal(isHistoricalEvidence(evidence('late',{publishedAt:first,collectedAt:'2026-10-10T00:00:00.001Z'})),true);
  assert.equal(isHistoricalEvidence(evidence('broken',{collectedAt:'unknown'})),true);
  assert.equal(isHistoricalEvidence(evidence('explicit',{publishedAt:collected,collectedAt:collected,historical:true})),true);
});

test('及时采集却很晚生成也是历史补录，实际新原文不会被旧上下文拖成历史',()=>{
  const timely=evidence('timely',{collectedAt:old});
  assert.equal(isHistoricalEvidence(timely),false);
  assert.equal(isHistoricalContent([timely],collected),true);
  const fresh=evidence('fresh',{publishedAt:collected,collectedAt:collected});
  assert.equal(isHistoricalContent([timely,fresh],collected),false);
  assert.equal(isHistoricalArticle(article('fresh',{evidenceIds:['old','fresh']}),[evidence(),fresh]),false);
  assert.equal(isHistoricalArticle(article('unknown',{evidenceIds:['old','missing']}),[evidence()]),false,'缺失其他证据时不能臆断整篇均为旧消息');
});

test('只读投影修复v1显示，保持版本事实、来源时间和原始对象不变',()=>{
  const original=data(),before=structuredClone(original),projected=projectPublicHistory(original);
  assert.deepEqual(original,before,'不覆盖不可变快照或证据');
  assert.equal(projected.publications[0].article.version,1);
  assert.equal(projected.articles[0].version,2);
  assert.equal(projected.publications[0].article.historical,true);
  assert.equal(projected.publications[0].article.sourcePublishedAt,'2026-07-16T04:14:09.000Z');
  assert.equal(projected.publications[0].publishedAt,original.publications[0].publishedAt);
  assert.equal(projected.publications[0].cutoffAt,collected);
  assert.deepEqual(projected.publications[0].event.actions,original.publications[0].event.actions);
  assert.equal(upcomingActions(original).length,0,'旧false标识的历史预告也不会挤入近期发放');
  assert.equal(articleSourceTime(projected.publications[0].article),projected.publications[0].article.sourcePublishedAt);
  const poster=posterSvg(projected.publications[0],original.site.name);
  assert.match(poster,/历史收录/);assert.match(poster,/来源发布/);assert.match(poster,/2026\/07\/16/);
});

test('历史入站不产生假实时公告，重要更正和近期真实提醒继续保留',()=>{
  const original=data();
  original.notices=[
    {id:'old-alert',eventId:'event',publicationId:'pub',semanticKey:'old',title:'历史公告',summary:'',categories:['announcement'],status:'active',createdAt:collected},
    {id:'correction',eventId:'event',publicationId:'pub',semanticKey:'correction',title:'重要更正',summary:'',categories:['correction'],status:'active',createdAt:collected},
    {id:'current',eventId:'new-event',publicationId:'new-pub',semanticKey:'current',title:'近期公告',summary:'',categories:['result'],status:'active',createdAt:collected},
  ];
  assert.deepEqual(projectPublicHistory(original).notices.map(notice=>notice.id),['correction','current']);
  assert.equal(original.notices.length,3);
});

test('晚补采的旧公告按原文进展排序，排序不修改发布快照',()=>{
  const original=data();
  const recent:Publication=structuredClone(original.publications[0]);
  recent.id='recent-pub';recent.eventId='recent-event';recent.event.id='recent-event';recent.event.publicationId=recent.id;
  recent.article.id='recent-article';recent.article.eventId=recent.eventId;recent.article.publicationId=recent.id;
  recent.publishedAt='2026-10-08T05:00:00Z';recent.article.publishedAt=recent.publishedAt;
  recent.event.actions[0].statementAt='2026-10-08T03:44:00Z';
  original.events.push(recent.event);original.publications.push(recent);original.articles.push(recent.article);
  const before=structuredClone(original);
  assert.deepEqual(sortedStatePublications(original).map(p=>p.id),['recent-pub','pub']);
  assert.equal(publicationSourceTime(original.publications[0]),old,'缺原文日期时使用动作证据时间，不使用晚入库时间');
  assert.deepEqual(original,before);
});

test('排序取最新有效进展，翻译措辞更新不改变事实日期',()=>{
  const p=data().publications[0];
  p.article.sourcePublishedAt='2026-10-08T01:00:00Z';
  p.event.actions.push({...p.event.actions[0],id:'later',statementAt:'2026-10-08T03:44:00Z'});
  assert.equal(publicationSourceTime(p),'2026-10-08T03:44:00Z');
  p.publishedAt='2026-10-10T00:00:00Z';p.article.publishedAt=p.publishedAt;
  assert.equal(publicationSourceTime(p),'2026-10-08T03:44:00Z');
  p.event.actions[1].statementAt='invalid';
  assert.equal(publicationSourceTime(p),'2026-10-08T01:00:00Z');
});

test('仅新闻版本不借用旧动作日期，同一来源时间保持稳定排序',()=>{
  const original=data(),p=original.publications[0];
  p.mode='news_only';p.article.sourcePublishedAt='2026-08-01T00:00:00Z';
  p.event.actions[0].statementAt='2026-10-08T03:44:00Z';
  assert.equal(publicationSourceTime(p),'2026-08-01T00:00:00Z');
  p.mode='state_change';
  const other=structuredClone(p);other.id='a-pub';other.eventId='a-event';other.event.id='a-event';other.event.publicationId=other.id;
  original.events.push(other.event);original.publications.push(other);
  assert.deepEqual(sortedStatePublications(original).map(p=>p.id),['a-pub','pub']);
});

test('撤回的旧状态文章仍保留历史，但不能继续成为当前福利和日程依据',()=>{
  const original=data();
  original.publications[0].event.actions[0].stage='claimed_complete';
  const news=structuredClone(original.publications[0]);
  news.id='news-pub';news.articleId='news-article';news.article.id=news.articleId;news.article.publicationId=news.id;
  news.mode='news_only';news.article.publicationMode='news_only';news.publishedAt='2026-10-09T16:00:00Z';
  original.events[0].publicationId=news.id;original.publications.push(news);original.articles.push(news.article);
  assert.equal(publicActions(original).length,1);
  original.articles[0].status='withdrawn';
  assert.equal(publicActions(original).length,0,'当前文章撤回使旧状态依据失效');
  assert.equal(publicationWithdrawn(original,original.publications[0]),true,'旧快照在列表中也必须显示撤回状态');
  assert.equal(sortedStatePublications(original).length,1,'历史版本和撤回说明仍可追溯');
  original.articles[0].status='published';original.publications[0].article.status='withdrawn';
  assert.equal(publicActions(original).length,0,'撤回快照也不能成为当前依据');
});
