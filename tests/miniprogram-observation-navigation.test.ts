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
      setInterval(fn:()=>void){timers.set(++timerId,fn);return timerId;},clearInterval(id:number){timers.delete(id);},setTimeout(){return ++timerId;},clearTimeout(){},
      require(path:string){const file=resolve(dirname(filename),path.endsWith('.js')?path:`${path}.js`);assert.ok(file.startsWith(resolve(root,'miniprogram')+'/'));return load(file);}});
    return module.exports;
  }
  load(resolve(root,'miniprogram/pages/home/index.js'));
  const page={...definition,data:structuredClone(definition.data),setData(patch:Record<string,unknown>){for(const [key,value] of Object.entries(patch)){const parts=key.split('.');let target=this.data;for(const part of parts.slice(0,-1))target=target[part];target[parts.at(-1)!]=value;}}};
  page.onLoad({});page.onShow();
  return {page,navigations,toasts,timers};
}
const tap=(kind='automatic_reset')=>({currentTarget:{dataset:{kind}}});

test('可信观测使首页进入已重置并从来源时间计时，主按钮进入实际观测记录',()=>{
  const data=fixture(),before=structuredClone(data),h=nativeHome(data);
  try{
    const card=h.page.data.resetCards.find((item:{kind:string})=>item.kind==='automatic_reset');
    assert.equal(card.state,'observed');assert.equal(card.completedDisplay,true);assert.equal(card.title,'额度已重置');
    assert.equal(card.publicationId,'observed-reset');assert.equal(card.timeAt,observedAt);assert.equal(card.clockText,'01:40');
    assert.equal(card.metric,'1小时53分钟');assert.equal(card.metricLabel,'距本轮最早观测');assert.equal(card.dialStatus,'依据第三方观测');
    assert.equal(card.expectedElapsed,'');assert.equal(card.observationPublicationId,'');
    assert.doesNotMatch(card.description+card.footer,/等待.*声明|待核实|官方确认/);
    h.page.openStatusEvidence(tap());assert.equal(h.navigations[0].url,'/pages/detail/index?publicationId=observed-reset');
    assert.deepEqual(data,before,'界面状态不能把观测改写为官方事实或覆盖原预告');
    const markup=readFileSync(resolve(root,'miniprogram/pages/home/index.wxml'),'utf8');
    assert.doesNotMatch(markup,/class="last-reset-card|class="orbit-observation"/);
  }finally{h.page.onUnload();}
  assert.equal(h.timers.size,0);
});

test('已重置记录导航失败可重试，不跳到旧预告',()=>{
  const h=nativeHome();
  try{
    h.page.openStatusEvidence(tap());assert.equal(h.navigations.length,1);assert.ok(h.navigations[0].fail);
    h.navigations[0].fail!();assert.equal(h.toasts.length,1);assert.equal(h.toasts[0].title,'记录加载失败，请重试');
    h.page.openStatusEvidence(tap());assert.equal(h.navigations[1].url,'/pages/detail/index?publicationId=observed-reset');
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


test('最近消息显示来源记录时间和相对时长，不把采集时间或秒数作为主信息',()=>{
  const h=nativeHome();
  try{
    const record=h.page.data.lastReset;
    assert.equal(record.dateText,'10月24日');assert.equal(record.clockText,'01:40');
    assert.equal(record.relativeTime,'距今 1小时53分钟');assert.equal(record.badge,'第三方报告');
    assert.equal(record.sourceName,'Codex Resets');assert.match(record.note,/依据第三方观测/);
    assert.equal(record.seconds,undefined);assert.equal(record.elapsed,undefined);
    const secondPatch=h.page.resetCardsPatch(fixture(),'2026-10-23T19:33:01.000Z');
    assert.equal(Object.keys(secondPatch).some(key=>key.startsWith('lastReset')),false);
    const minutePatch=h.page.resetCardsPatch(fixture(),'2026-10-23T19:34:00.000Z');
    assert.equal(minutePatch['lastReset.relativeTime'],'距今 1小时54分钟');
    h.page.openLastReset();assert.equal(h.navigations[0].url,'/pages/detail/index?publicationId=observed-reset');
    h.navigations[0].fail!();assert.equal(h.toasts[0].title,'消息详情加载失败，请重试');
  }finally{h.page.onUnload();}
});

test('最近消息跨天后用天和小时表达，保留来源时间及跨年年份',()=>{
  const h=nativeHome();
  try{
    const dayPatch=h.page.resetCardsPatch(fixture(),'2026-10-25T18:40:00.000Z');
    assert.equal(dayPatch['lastReset.relativeTime'],'距今 2天1小时');
    const yearPatch=h.page.resetCardsPatch(fixture(),'2027-01-01T00:00:00.000Z');
    assert.equal(yearPatch['lastReset.dateText'],'2026年10月24日');
    const justNow=h.page.resetCardsPatch({...fixture(),serverTime:observedAt,evidence:fixture().evidence.map(e=>({...e,collectedAt:observedAt})),publications:fixture().publications.map(p=>p.id==='observed-reset'?{...p,publishedAt:observedAt}:p)},observedAt);
    assert.equal(justNow['lastReset.relativeTime'],'刚刚');
  }finally{h.page.onUnload();}
});

test('发卡切换使用独立完成消息，空状态不会残留另一类别的来源和时间',()=>{
  const data=fixture();const pub=data.publications[0];
  pub.event.actions[0]={...pub.event.actions[0],kind:'banked_reset',stage:'claimed_complete',statementAt:'2026-10-22T12:00:00.000Z',expectedAt:undefined};
  const h=nativeHome(data);
  try{
    h.page.selectResetKind(tap('banked_reset'));
    assert.equal(h.page.data.lastReset.badge,'公开完成声明');assert.equal(h.page.data.lastReset.timeLabel,'完成消息时间');
    assert.equal(h.page.data.lastReset.dateText,'10月22日');assert.equal(h.page.data.lastReset.clockText,'20:00');
    assert.equal(h.page.data.lastReset.sourceName,'');assert.equal(h.page.data.lastReset.publicationId,'active-announcement');
    h.page.openLastReset();assert.equal(h.navigations[0].url,'/pages/detail/index?publicationId=active-announcement');
    h.page.selectResetKind(tap());assert.equal(h.page.data.lastReset.badge,'第三方报告');
    assert.equal(h.page.resetCardsPatch({...data,publications:[],events:[],articles:[],evidence:[]},now).lastReset,null);
  }finally{h.page.onUnload();}
});


test('新预告保留下一次倒计时，旧观测只作为同卡中的上次记录',()=>{
  const data=fixture(),p=data.publications[0];p.event.actions[0].statementAt='2026-10-23T18:10:00.000Z';p.event.actions[0].expectedAt='2026-10-24T18:00:00.000Z';
  const h=nativeHome(data);
  try{
    const card=h.page.data.resetCards[0];assert.equal(card.state,'scheduled');assert.equal(card.completedDisplay,false);
    assert.equal(card.timeAt,'2026-10-24T18:00:00.000Z');assert.equal(card.lastMessage.clockText,'01:40');
    assert.equal(card.lastMessage.badge,'第三方报告');h.page.openStatusEvidence(tap());assert.equal(h.navigations[0].url,'/pages/detail/index?publicationId=active-announcement');
  }finally{h.page.onUnload();}
});

test('提前重置无需等预告到点，超过24小时仍保留已发生的重置直到出现新安排',()=>{
  const data=fixture();data.publications[0].event.actions[0].expectedAt='2026-10-24T18:00:00.000Z';
  const h=nativeHome(data);
  try{
    assert.equal(h.page.data.resetCards[0].completedDisplay,true);
    const card=h.page.resetCardsPatch(data,'2026-10-25T19:33:00.000Z').resetCards[0];
    assert.equal(card.completedDisplay,true);assert.equal(card.timeAt,observedAt);assert.equal(card.metric,'2天1小时53分钟');assert.equal(card.clockParts.length,3);
    assert.equal(card.clockParts[0].unit,'天');assert.equal(card.clockParts[0].value,'02');
  }finally{h.page.onUnload();}
});

test('无可信观测时到点仍等待，未来或已撤回观测不会确认重置，也不跨类型确认发卡',()=>{
  for(const change of ['missing','withdrawn','future']){
    const data=fixture();
    if(change==='missing')data.evidence=[];
    if(change==='withdrawn')data.articles[1].status='withdrawn';
    if(change==='future')data.evidence[0].publishedAt='2026-10-24T17:40:00.000Z';
    const h=nativeHome(data);
    try{assert.equal(h.page.data.resetCards[0].state,'overdue');assert.equal(h.page.data.resetCards[0].completedDisplay,false);assert.equal(h.page.data.resetCards[1].completedDisplay,false);}finally{h.page.onUnload();}
  }
  const data=fixture();data.publications[0].event.actions[0].kind='banked_reset';const h=nativeHome(data);
  try{assert.equal(h.page.data.resetCards[0].completedDisplay,true);assert.equal(h.page.data.resetCards[1].state,'overdue');assert.equal(h.page.data.resetCards[1].completedDisplay,false);}finally{h.page.onUnload();}
});
