import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';
import type {Evidence,Publication,PublicData} from '../src/lib/types';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const now='2026-10-23T19:33:00.000Z',observedAt='2026-10-23T17:40:00.000Z';

function fixture():PublicData {
  const collectedAt='2026-10-23T19:30:00.000Z',statementAt='2026-10-23T04:46:19.000Z';
  const evidence:Evidence={id:'isolated-observation',sourceId:'reset-archive',messageId:'observed-2113162413008884099',url:'https://x.com/thsottiaux/status/2113162413008884099',text:'Codex 使用限额已重置。查看你的限额。',publishedAt:observedAt,collectedAt,contextComplete:false,historical:false,hash:'isolated-observation',provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'reset'}};
  const publication=(id:string,observation:boolean):Publication=>{
    const time=observation?collectedAt:statementAt,eventId=`event-${id}`,articleId=`article-${id}`,mode=observation?'news_only' as const:'state_change' as const;
    const article:Publication['article']={id:articleId,eventId,publicationId:id,title:observation?'来源重置观测':'原重置预告',summary:'隔离导航回归输入',translation:'',category:'reset',status:'published',version:1,evidenceIds:observation?[evidence.id]:[],publishedAt:time,updatedAt:time,publicationMode:mode};
    const event:Publication['event']={id:eventId,publicationId:id,title:article.title,status:'published',version:1,evidenceIds:article.evidenceIds,updatedAt:time,actions:observation?[]:[{id:'pending-reset',kind:'automatic_reset',stage:'promised',scope:'public',eligibility:'所有用户',statementAt,expectedAt:'2026-10-23T18:00:00.000Z',evidenceIds:[]}]};
    return {id,eventId,articleId,article,event,mode,publishedAt:time,cutoffAt:time,reason:'isolated navigation regression'};
  };
  const publications=[publication('active-announcement',false),publication('observed-reset',true)];
  return {publications,events:publications.map(p=>p.event),articles:publications.map(p=>p.article),evidence:[evidence],activities:[],sources:[],notices:[],site:{name:'隔离导航测试',description:'',version:1,autoPublish:false},serverTime:now};
}

function nativeHome(data=fixture()) {
  let definition:any,timerId=0;
  const timers=new Map<number,()=>void>(),cache=new Map<string,{exports:any}>();
  const navigations:Array<{url:string;fail?:()=>void}>=[],toasts:Array<{title:string;icon:string}>=[];
  class Clock extends Date {static now(){return 1000000;}}
  const state=()=>({data,receivedAt:1000000,loading:false,unconfigured:false,error:''});
  const app={client:{subscribe(fn:(value:ReturnType<typeof state>)=>void){fn(state());return()=>{};},getState:state}};
  function load(filename:string):any {
    if(cache.has(filename))return cache.get(filename)!.exports;
    const module={exports:{}};cache.set(filename,module);
    new Script(readFileSync(filename,'utf8'),{filename}).runInNewContext({module,exports:module.exports,Date:Clock,Page(value:unknown){definition=value;},getApp:()=>app,
      wx:{navigateTo(options:{url:string;fail?:()=>void}){navigations.push(options);},showToast(options:{title:string;icon:string}){toasts.push(options);}},
      setInterval(fn:()=>void){timers.set(++timerId,fn);return timerId;},clearInterval(id:number){timers.delete(id);},
      require(path:string){const file=resolve(dirname(filename),path.endsWith('.js')?path:`${path}.js`);assert.ok(file.startsWith(resolve(root,'miniprogram')+'/'));return load(file);}});
    return module.exports;
  }
  load(resolve(root,'miniprogram/pages/home/index.js'));
  const page={...definition,data:structuredClone(definition.data),setData(patch:Record<string,unknown>){Object.assign(this.data,patch);}};
  page.onLoad({});page.onShow();
  return {page,navigations,toasts,timers};
}
const tap=(kind='automatic_reset')=>({currentTarget:{dataset:{kind}}});

test('真实首页观测按钮进入 observationPublicationId，保留原预告独立入口',()=>{
  const h=nativeHome();
  try{
    const card=h.page.data.resetCards.find((item:{kind:string})=>item.kind==='automatic_reset');
    assert.equal(card.state,'overdue');assert.equal(card.publicationId,'active-announcement');assert.equal(card.observationPublicationId,'observed-reset');
    h.page.openObservation(tap());assert.equal(h.navigations[0].url,'/pages/detail/index?publicationId=observed-reset');assert.equal(h.toasts.length,0);
    h.page.openStatusEvidence(tap());assert.equal(h.navigations[1].url,'/pages/detail/index?publicationId=active-announcement');
    assert.equal(card.publicationId,'active-announcement');assert.equal(card.timeAt,'2026-10-23T18:00:00.000Z');
    const markup=readFileSync(resolve(root,'miniprogram/pages/home/index.wxml'),'utf8');
    assert.match(markup,/<button[^>]*data-kind="\{\{card\.kind\}\}"[^>]*bindtap="openObservation"[^>]*>查看观测依据/);
  }finally{h.page.onUnload();}
  assert.equal(h.timers.size,0);
});

test('观测导航失败明确提示且不降级打开另一条预告',()=>{
  const h=nativeHome();
  try{
    h.page.openObservation(tap());assert.equal(h.navigations.length,1);assert.ok(h.navigations[0].fail);
    h.navigations[0].fail!();assert.equal(h.toasts.length,1);assert.equal(h.toasts[0].title,'观测详情加载失败，请重试');assert.equal(h.toasts[0].icon,'none');assert.equal(h.navigations.length,1);
    h.page.openObservation(tap());assert.equal(h.navigations[1].url,'/pages/detail/index?publicationId=observed-reset','重试仍进入观测记录');
  }finally{h.page.onUnload();}
});

test('没有该类型观测、未知类别或未加载卡片时不误开活动预告',()=>{
  const h=nativeHome();
  try{
    h.page.openObservation(tap('banked_reset'));h.page.openObservation(tap('unknown'));
    h.page.data.resetCards=undefined;h.page.openObservation(tap());
    assert.equal(h.navigations.length,0);assert.equal(h.toasts.length,0);
  }finally{h.page.onUnload();}
});

test('观测编号仅作为编码后的参数，不拼成额外导航查询',()=>{
  const h=nativeHome();
  try{
    h.page.data.resetCards=[{kind:'automatic_reset',publicationId:'active-announcement',observationPublicationId:'observed /?next=active&x=1'}];
    h.page.openObservation(tap());assert.equal(h.navigations[0].url,'/pages/detail/index?publicationId=observed%20%2F%3Fnext%3Dactive%26x%3D1');
  }finally{h.page.onUnload();}
});
