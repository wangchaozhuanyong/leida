import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SearchParamsContext} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import type {Evidence, PublicData, Publication} from '../src/lib/types';
import {uniqueDisplayEvidence} from '../src/components/public/model';
import {EventPage} from '../src/components/public/PublicApp';

const {resolveDetail}=createRequire(import.meta.url)('../miniprogram/utils/model.js');
const time='2026-10-17T21:12:21.000Z', url='https://x.com/thsottiaux/status/2111566005684289735';
const evidence=(id:string, patch:Partial<Evidence>={}):Evidence=>({id,sourceId:'tibo-public',messageId:'2111566005684289735',url,text:'Done',publishedAt:time,collectedAt:'2026-10-23T01:00:00.000Z',hash:id,contextComplete:true,historical:true,provenance:'archive',textOrigin:'original',...patch});
function fixture(rows:Evidence[]):PublicData {
  const ids=rows.map(row=>row.id);
  const event:Publication['event']={id:'event',title:'额度重置已完成',version:1,status:'published',publicationId:'publication',updatedAt:time,evidenceIds:ids,actions:[{id:'action',kind:'automatic_reset',stage:'claimed_complete',scope:'public',eligibility:'暂未明确',statementAt:time,evidenceIds:ids}]};
  const article:Publication['article']={id:'article',eventId:event.id,publicationId:'publication',title:event.title,summary:'公开完成声明。',translation:'',category:'reset',version:1,status:'published',evidenceIds:ids,publishedAt:time,updatedAt:time};
  const publication:Publication={id:'publication',eventId:event.id,articleId:article.id,event,article,cutoffAt:time,publishedAt:time,mode:'state_change',reason:''};
  return {events:[event],articles:[article],publications:[publication],evidence:rows,notices:[],activities:[],sources:[{id:'tibo-public',name:'Tibo',status:'healthy'},{id:'aiplanwatch-history',name:'历史来源',status:'healthy'}],site:{name:'重置雷达',description:'',autoPublish:true,version:1},serverTime:'2026-10-23T02:00:00.000Z'};
}

test('同一原帖跨来源与毫秒精度只呈现一次，网站详情与小程序一致且不改历史数据',()=>{
  const data=fixture([evidence('original'),evidence('archive',{sourceId:'aiplanwatch-history',publishedAt:'2026-10-17T21:12:21.411Z'})]);
  const before=structuredClone(data);
  const html=renderToStaticMarkup(createElement(SearchParamsContext.Provider,{value:new URLSearchParams()},createElement(EventPage,{data,id:'event',onPoster(){},onShare:async()=>{}})));
  assert.equal((html.match(/class="pub-source-row"/g)||[]).length,1);
  assert.equal((html.match(/>Done<\/p>/g)||[]).length,1);
  const mini=resolveDetail(data,{publicationId:'publication'});
  assert.equal(mini.evidence.length,1);
  assert.equal(mini.evidence[0].url,url);
  assert.deepEqual(data,before);
});

test('同文同时间的不同帖子、同 URL 的不同正文都保留',()=>{
  const rows=[evidence('first'),evidence('other-post',{url:'https://x.com/thsottiaux/status/2111566005684289736'}),evidence('edit',{text:'Done, for selected accounts only.'})];
  assert.deepEqual(uniqueDisplayEvidence(rows).map(row=>row.id),['first','other-post','edit']);
  assert.equal(resolveDetail(fixture(rows),{publicationId:'publication'}).evidence.length,3);
  const html=renderToStaticMarkup(createElement(SearchParamsContext.Provider,{value:new URLSearchParams()},createElement(EventPage,{data:fixture(rows),id:'event',onPoster(){},onShare:async()=>{}})));
  assert.equal((html.match(/class="pub-source-row"/g)||[]).length,3);
});

test('X 与 Twitter 同帖别名、分享参数及排版空白可以折叠，但不能借相似域名折叠',()=>{
  const rows=[evidence('original'),evidence('alias',{url:'https://mobile.twitter.com/thsottiaux/status/2111566005684289735?s=20',text:' Done\n',publishedAt:'2026-10-17T21:12:22Z'}),evidence('image',{url:url+'/photo/1'}),evidence('different-host',{url:'https://x.com.example.org/thsottiaux/status/2111566005684289735'})];
  assert.deepEqual(uniqueDisplayEvidence(rows).map(row=>row.id),['original','different-host']);
});

test('非帖子来源按地址、正文和时间保留；无有效地址的独立资料不能因正文相同消失',()=>{
  const rows=[evidence('a',{url:'https://example.org/news'}),evidence('b',{url:'https://example.org/other'}),evidence('later',{url:'https://example.org/news',publishedAt:'2026-10-18T21:12:21Z'}),evidence('missing-a',{url:''}),evidence('missing-b',{url:''})];
  assert.deepEqual(uniqueDisplayEvidence(rows).map(row=>row.id),rows.map(row=>row.id));
  assert.equal(uniqueDisplayEvidence([rows[0],{...rows[0],id:'same-instant',publishedAt:'2026-10-18T05:12:21+08:00'}]).length,1);
});

test('来源观测与原帖声明分开，不把同帖不同观测时刻或来源混成一条',()=>{
  const observed=evidence('observation',{messageId:'observed-2111566005684289735',sourceId:'reset-archive'});
  const rows=[evidence('original'),observed,{...observed,id:'later',publishedAt:'2026-10-18T00:00:00Z'},{...observed,id:'other-source',sourceId:'aiplanwatch-reference'}];
  assert.deepEqual(uniqueDisplayEvidence(rows).map(row=>row.id),rows.map(row=>row.id));
});

test('同帖选择官方副本但保持原分组位置，输入对象与排列不变',()=>{
  const rows=[evidence('archive'),evidence('different',{url:'https://x.com/thsottiaux/status/2111566005684289736'}),evidence('official',{provenance:'official',publishedAt:'2026-10-17T21:12:21.411Z'})];
  const before=structuredClone(rows);
  assert.deepEqual(uniqueDisplayEvidence(rows).map(row=>row.id),['official','different']);
  assert.deepEqual(rows,before);
});
