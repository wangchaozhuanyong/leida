import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SearchParamsContext} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import type {Article, PublicData, Publication, Evidence, Notice} from '../src/lib/types';
import {groupedNoticeUpdates, latestSourceSuccess, publicArticleSummary, publicContentRevision, publicNavSection} from '../src/components/public/model';
import {Home, EventPage, Settings, Methodology} from '../src/components/public/PublicApp';

const time = '2026-10-12T04:00:00.000Z';
const article: Article = {id:'article', eventId:'event', publicationId:'v1', title:'用量重置：公告称已完成', summary:'公开完成声明。', translation:'', category:'reset', version:1, status:'published', evidenceIds:['source-a'], publishedAt:time, updatedAt:time, publicationMode:'state_change', contentOrigin:'template'};
const publication: Publication = {id:'v1', eventId:'event', articleId:'article', article, cutoffAt:time, publishedAt:time, mode:'state_change', reason:'', event:{id:'event', title:article.title, version:1, status:'published', publicationId:'v1', updatedAt:time, evidenceIds:['source-a'], actions:[{id:'action', kind:'automatic_reset', stage:'claimed_complete', scope:'public', eligibility:'原帖未列明具体套餐', statementAt:time, evidenceIds:['source-a','source-b']}]} };
const evidence = (id:string):Evidence => ({id, sourceId:'source', messageId:id, url:'https://example.com/'+id, text:'测试公开原文', publishedAt:time, collectedAt:time, hash:id, contextComplete:true, historical:false, provenance:'official'});
const fixture = ():PublicData => structuredClone({articles:[article], events:[publication.event], publications:[publication], evidence:[evidence('source-a'),evidence('source-b')], notices:[], activities:[], sources:[{id:'source',name:'公开来源',status:'healthy',lastSuccessAt:time}], site:{name:'模钥重置雷达',description:'',autoPublish:true,version:1},serverTime:'2026-10-12T05:00:00.000Z'});

test('刷新区分来源心跳与真实新发布，撤回也属于内容变化',()=>{
  const data=fixture(), initial=publicContentRevision(data);
  data.serverTime='2026-10-12T06:00:00.000Z';
  data.sources[0].lastSuccessAt=data.serverTime;
  data.sources[0].status='delayed';
  assert.equal(publicContentRevision(data),initial);
  data.articles[0].publicationId='v2';
  assert.notEqual(publicContentRevision(data),initial);
  data.articles[0].publicationId='v1';data.articles[0].status='withdrawn';
  assert.notEqual(publicContentRevision(data),initial);
});
test('采集成功时间只来自有效来源记录，不能用页面刷新时间替代',()=>{
  assert.equal(latestSourceSuccess([]),undefined);
  assert.equal(latestSourceSuccess([{id:'a',name:'a',status:'failed',lastSuccessAt:'bad'},...fixture().sources]),time);
});
test('模板文案隐藏处理流程，人工摘要保持原样且不删除资格限定',()=>{
  const text='官方发布了 Codex 稳定版本 v1。已保存发布说明；完整中文改动会在智能服务可用后自动补充。';
  assert.doesNotMatch(publicArticleSummary({...article,summary:text}),/智能服务/);
  assert.equal(publicArticleSummary({...article,summary:text,manualFields:['summary']}),text);
  assert.equal(publicArticleSummary({...article,summary:text,contentOrigin:'generated'}),text);
  assert.match(publicArticleSummary({...article,summary:'根据公开归档保存的原帖，公告称已完成，原帖未列明具体套餐。 原文发布时间：2026/10/12 12:00（北京时间）。这是中文事实摘要，个人账户是否到账尚未观测。'}),/原帖未列明具体套餐。 个人账户是否到账尚未观测/);
});
test('详情页属于原有导航分类',()=>{
  assert.equal(publicNavSection('events'),'history');assert.equal(publicNavSection('sources'),'history');
  assert.equal(publicNavSection('articles'),'news');assert.equal(publicNavSection('activities'),'news');
  assert.equal(publicNavSection('notices'),'settings');
});
test('详情只展示一份重复来源，动作独有的不同原文仍可达',()=>{
  const data=fixture();
  data.evidence.push({...evidence('action-only'),text:'动作独有的补充原文。'});
  data.publications[0].event.actions[0].evidenceIds.push('action-only');
  const html=renderToStaticMarkup(createElement(SearchParamsContext.Provider,{value:new URLSearchParams()},createElement(EventPage,{data,id:'event',onPoster(){},onShare:async()=>{}})));
  assert.equal((html.match(/测试公开原文/g)||[]).length,1);
  assert.match(html,/href="https:\/\/example.com\/source-a"/);
  assert.match(html,/href="https:\/\/example.com\/action-only"/);
  assert.match(html,/查看来源/);assert.doesNotMatch(html,/相同内容的另外|辅助归档/);
  assert.match(html,/个人账户是否到账尚未观测/);assert.match(html,/原帖未列明具体套餐/);
});
test('首页先显示当前进度，再显示独立历史计时，预告不会清空最近完成记录',()=>{
  const data=fixture();
  const render=()=>renderToStaticMarkup(createElement(Home,{data,historical:false,onWechatReminders(){},onPoster(){},onShare:async()=>{}}));
  const idle=render();assert.match(idle,/pub-home-dashboard/);assert.match(idle,/上次额度重置已经过去/);
  assert.doesNotMatch(idle,/pub-dial-face|pub-home-dial/);
  assert.ok(idle.indexOf('pub-reset-progress')<idle.indexOf('pub-last-reset'));
  assert.ok(idle.indexOf('pub-last-reset')<idle.indexOf('pub-home-card-actions'));
  const pending=structuredClone(publication);pending.id='v2';pending.article.id='article2';pending.article.publicationId='v2';pending.event.id='event2';pending.eventId='event2';pending.event.publicationId='v2';
  pending.event.actions=[{...pending.event.actions[0],id:'new-action',stage:'promised',statementAt:'2026-10-12T04:30:00Z',expectedAt:'2026-10-12T08:20:00Z',timeNote:'原文预计时刻'}];
  data.publications.push(pending);data.events.push(pending.event);data.articles.push(pending.article);
  const active=render();assert.doesNotMatch(active,/pub-dial-face/);assert.match(active,/3小时20分钟/);assert.match(active,/公开预告/);
  assert.match(active,/查看安排依据/);assert.match(active,/href="\/events\/event2\?version=v2"/);
  assert.doesNotMatch(active,/pub-home-record-evidence/);
  assert.equal((active.match(/class="pub-home-completions"/g)||[]).length,1,'完成记录不因当前预告重复分组');
});
test('同轮提醒只归组展示，保留全部版本与原始顺序',()=>{
  const row=(id:string,eventId:string,createdAt:string):Notice=>({id,eventId,publicationId:`pub-${id}`,semanticKey:id,title:id,summary:id,categories:['result'],status:'active',createdAt});
  const notices=[row('older','same','2026-10-11T04:28:00Z'),row('other','other','2026-10-12T04:48:00Z'),row('newer','same','2026-10-11T09:48:00Z')];
  const before=structuredClone(notices), groups=groupedNoticeUpdates(notices);
  assert.deepEqual(groups.map(group=>group.latest.id),['other','newer']);
  assert.deepEqual(groups[1].updates.map(notice=>notice.id),['newer','older']);
  assert.deepEqual(notices,before);
});
test('依据入口保留真实原文片段，待开放提醒不承诺可订阅',()=>{
  const data=fixture();data.evidence[0].text='完成声明的实际原文。';
  const html=renderToStaticMarkup(createElement(SearchParamsContext.Provider,{value:new URLSearchParams()},createElement(EventPage,{data,id:'event',onPoster(){},onShare:async()=>{}})));
  assert.match(html,/完成声明的实际原文。/);assert.doesNotMatch(html,/来源1 ·/);
  const home=renderToStaticMarkup(createElement(Home,{data,historical:false,wechatEntry:'unavailable',onWechatReminders(){},onPoster(){},onShare:async()=>{}}));
  assert.match(home,/待开放/);assert.match(home,/上次额度重置已经过去/);assert.match(home,/1小时0分钟0秒/);assert.doesNotMatch(home,/去微信订阅/);
});

test('站内信加载失败只影响信箱内容，微信提醒仍可见且不冒充空信箱',()=>{
  const html=renderToStaticMarkup(createElement(Settings,{notices:[],read:[],markRead(){},storageError:'',pending:createElement('p',{role:'alert'},'消息暂时无法加载')}));
  assert.ok(html.indexOf('微信提醒')<html.indexOf('站内信'));
  assert.match(html,/查看全部提醒/);assert.match(html,/消息暂时无法加载/);assert.match(html,/小程序内开启/);
  assert.doesNotMatch(html,/暂无提醒|刷新授权状态|选择接收下一次提醒|活动进展/);
});

test('观察记录保留固定记录功能，不再给读者展示内部判断流程',()=>{
  const html=renderToStaticMarkup(createElement(Methodology,{data:fixture(),snapshotId:null,cadenceId:null,onPoster(){},onShare:async()=>{}}));
  assert.match(html,/观察记录/);
  assert.doesNotMatch(html,/如何判断重置|先看承诺，再看完成|原文、中文与更正/);
});
