import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SearchParamsContext} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import type {BenefitAction,Evidence,PublicData,Publication} from '../src/lib/types';
import {EventPage} from '../src/components/public/PublicApp';
import {briefTime} from '../src/components/public/model';

const require=createRequire(import.meta.url),native=require('../miniprogram/utils/model.js');
const first='2026-11-01T00:43:20.000Z',second='2026-11-01T23:27:20.000Z',imported='2026-11-02T06:40:30.241Z';
function fixture():PublicData {
 const evidence:Evidence[]=[
  {id:'first-source',messageId:'2116692529970311254',sourceId:'publisher',url:'https://x.com/thsottiaux/status/2116692529970311254',text:'Banked 1/2',publishedAt:first,collectedAt:imported,hash:'first',contextComplete:true,textOrigin:'original',provenance:'archive',historical:true},
  {id:'second-source',messageId:'2117035794678546764',sourceId:'publisher',url:'https://x.com/thsottiaux/status/2117035794678546764',text:'Day 28/ Banked 2/2',publishedAt:second,collectedAt:imported,hash:'second',contextComplete:true,textOrigin:'original',provenance:'archive',historical:true}
 ];
 const actions:BenefitAction[]=evidence.map((e,i)=>({id:'batch-'+(i+1),kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'公开用户',statementAt:e.publishedAt,evidenceIds:[e.id],evidenceQuote:e.text}));
 const publications:Publication[]=evidence.map((e,i)=>{
  const id='pub-'+(i+1),articleId='article-'+(i+1);
  const event={id:'series',title:'两批发卡',version:2,status:'published' as const,publicationId:'pub-2',updatedAt:imported,actions:structuredClone(actions),evidenceIds:evidence.map(item=>item.id)};
  const article={id:articleId,eventId:'series',publicationId:id,title:`重置卡：第 ${i+1} 次发放（共 2 次）`,summary:e.text,translation:'',category:'reset' as const,version:1,status:'published' as const,evidenceIds:[e.id],publishedAt:imported,updatedAt:imported,sourcePublishedAt:e.publishedAt,historical:true};
  return{id,eventId:'series',articleId,event,article,cutoffAt:imported,publishedAt:imported,mode:'state_change',reason:'isolated late historical recovery'};
 });
 return{serverTime:'2026-11-04T08:00:00.000Z',events:[structuredClone(publications[1].event)],articles:publications.map(p=>structuredClone(p.article)),publications,evidence,sources:[{id:'publisher',name:'发布者公开动态',status:'healthy'}],notices:[],activities:[],site:{name:'隔离审查',description:'',version:1,autoPublish:true}};
}

for(const ordinal of [1,2])test(`详情按第${ordinal}批排序首要依据，保留其他批次与原快照`,()=>{
 const data=fixture(),before=structuredClone(data),detail=native.resolveDetail(data,{publicationId:'pub-'+ordinal});
 assert.equal(detail.isOld,false);
 assert.deepEqual(detail.actions.map((a:{id:string})=>a.id),['batch-'+ordinal]);
 assert.equal(detail.evidence[0].id,ordinal===1?'first-source':'second-source');
 assert.equal(detail.evidence[0].time,native.displayTime(ordinal===1?first:second));
 assert.equal(detail.time,native.displayTime(ordinal===1?first:second),'补采时间不能代替消息时间');
 assert.equal(detail.evidence.length,2,'另一批的上下文依据仍然可查');
 assert.deepEqual(data,before);
});

for(const ordinal of [1,2])test(`网站固定第${ordinal}批详情与小程序使用同批来源`,()=>{
 const data=fixture(),before=structuredClone(data);
 const html=renderToStaticMarkup(createElement(SearchParamsContext.Provider,{value:new URLSearchParams('version=pub-'+ordinal)},createElement(EventPage,{data,id:'series',onPoster(){},onShare:async()=>{}})));
 const source=html.slice(html.indexOf('<summary><span>查看来源'));
 const preview=source.match(/class="pub-source-preview">([^<]+)/)?.[1];
 assert.ok(preview?.includes(briefTime(ordinal===1?first:second)),'折叠来源预览必须是本批时间');
 const excerpts=[...source.matchAll(/class="pub-source-excerpt" dir="auto">([^<]+)/g)].map(match=>match[1]);
 assert.equal(excerpts[0],ordinal===1?'Banked 1/2':'Day 28/ Banked 2/2');
 assert.equal(excerpts.length,2);
 assert.deepEqual(data,before);
});

test('单篇同时声明两类福利时保留两类动作，不擅自裁掉一类来源',()=>{
 const data=fixture(),publication=data.publications[0];
 publication.event.actions[1].kind='automatic_reset';
 const detail=native.resolveDetail(data,{publicationId:publication.id});
 assert.deepEqual(new Set(detail.actions.map((a:{id:string})=>a.id)),new Set(['batch-1','batch-2']));
 assert.equal(detail.evidence.length,2);
});

test('仅新闻详情不借用整个系列完成动作，仍保留原文依据',()=>{
 const data=fixture(),publication=data.publications[0];publication.mode='news_only';
 const detail=native.resolveDetail(data,{publicationId:publication.id});
 assert.equal(detail.newsOnly,true);assert.deepEqual(detail.actions,[]);
 assert.equal(detail.evidence[0].id,'first-source');assert.equal(detail.evidence.length,1);
});
