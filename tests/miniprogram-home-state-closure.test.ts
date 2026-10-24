import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';
import type {PublicData,Publication,ActionKind,ActionStage} from '../src/lib/types';
const require=createRequire(import.meta.url);
const {homeResetStatus,selectedHomeStatus}=require('../miniprogram/utils/home-reset-status');
const {statusPosterInput,statusPosterAvailable,createStatusPosterLayout}=require('../miniprogram/packages/poster/status-poster');
const NOW='2026-10-24T03:00:00Z',T='2026-10-24T02:00:00Z',START='2026-10-23T14:00:00Z';
function fixture():PublicData{return{serverTime:NOW,events:[],articles:[],publications:[],evidence:[],sources:[{id:'test-public',name:'public',status:'healthy',lastSuccessAt:NOW}],activities:[],notices:[],site:{name:'隔离闭环测试',description:'',version:1,autoPublish:false}};}
function action(data:PublicData,id:string,stage:ActionStage='promised',at=START,expectedAt:string|undefined=T,kind:ActionKind='automatic_reset',round=id,publishedAt=at){
 const eventId='event-'+round,articleId='article-'+id,pubId='pub-'+id;
 const article:Publication['article']={id:articleId,eventId,publicationId:pubId,title:id,summary:'隔离闭环数据',translation:'',category:'reset',status:'published',version:1,evidenceIds:[],publishedAt,updatedAt:publishedAt};
 const event:Publication['event']={id:eventId,publicationId:pubId,title:id,status:'published',version:1,updatedAt:publishedAt,evidenceIds:[],actions:[{id:'action-'+round,kind,stage,statementAt:at,expectedAt,scope:'public',eligibility:'公开用户',evidenceIds:[],timeNote:'最晚之前'}]};
 const p:Publication={id:pubId,eventId,articleId,article,event,publishedAt,cutoffAt:publishedAt,reason:'隔离回归',mode:'state_change'};
 data.publications.push(p);data.events=data.events.filter(e=>e.id!==eventId).concat(structuredClone(event));data.articles.push(structuredClone(article));return p;
}
function observation(data:PublicData,id:string,at:string,tweet='2113162413008884099'){
 const eid='e-'+id,url='https://x.com/thsottiaux/status/'+tweet;
 data.evidence.push({id:eid,sourceId:'reset-archive',messageId:'observed-'+tweet,url,text:'Codex 使用限额已重置。查看你的限额。',publishedAt:at,collectedAt:data.serverTime,contextComplete:false,historical:false,hash:id,provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'reset'}});
 const p=action(data,id,'promised',at,undefined,'automatic_reset',id,data.serverTime);p.mode='news_only';p.article.publicationMode='news_only';p.article.evidenceIds=[eid];p.event.actions=[];p.event.evidenceIds=[eid];data.events.find(e=>e.id===p.eventId)!.actions=[];return {eid,url,p};
}
const card=(data:PublicData,at=data.serverTime,kind='automatic_reset')=>selectedHomeStatus(data,kind,at);

// Execute the actual native page and its local modules with a controlled wall clock.
// Intervals are deliberately throttled: the explicit boundary timer must still work.
function nativeHome(data:PublicData|null,at:number,kind='automatic_reset') {
 let definition:any,time=at,id=0,refreshes=0;
 const receivedAt=at,root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const timeouts=new Map<number,{at:number;fn:()=>void}>(),intervals=new Map<number,()=>void>(),cache=new Map<string,{exports:any}>();
 const navigations:string[]=[],tabs:string[]=[];
 class Clock extends Date {static now(){return time;}}
 const state=()=>({data,receivedAt,loading:!data,unconfigured:false,error:''});
 const app={client:{getState:state,subscribe(fn:(value:ReturnType<typeof state>)=>void){fn(state());return()=>{};},refresh(){refreshes++;return Promise.resolve();}}};
 function load(filename:string):any {
  if(cache.has(filename))return cache.get(filename)!.exports;
  const module={exports:{}};cache.set(filename,module);
  new Script(readFileSync(filename,'utf8'),{filename}).runInNewContext({module,exports:module.exports,Date:Clock,Page(value:unknown){definition=value;},getApp:()=>app,
   wx:{navigateTo({url}:{url:string}){navigations.push(url);},switchTab({url}:{url:string}){tabs.push(url);},showToast(){}},
   setTimeout(fn:()=>void,delay:number){timeouts.set(++id,{at:time+delay,fn});return id;},clearTimeout(timer:number){timeouts.delete(timer);},
   setInterval(fn:()=>void){intervals.set(++id,fn);return id;},clearInterval(timer:number){intervals.delete(timer);},
   require(path:string){const file=resolve(dirname(filename),path.endsWith('.js')?path:path+'.js');assert.ok(file.startsWith(resolve(root,'miniprogram')+'/'));return load(file);}});
  return module.exports;
 }
 load(resolve(root,'miniprogram/pages/home/index.js'));
 const page={...definition,data:structuredClone(definition.data),setData(patch:Record<string,unknown>,done?:()=>void){for(const [key,value] of Object.entries(patch)){const parts=key.split('.');let target=this.data;for(const part of parts.slice(0,-1))target=target[part];target[parts.at(-1)!]=value;}done?.();}};
 page.onLoad({kind});page.onShow();
 return {page,navigations,tabs,timeouts,intervals,get refreshes(){return refreshes;},advanceTo(target:number){
  for(let count=0;count<10;count++){const next=[...timeouts].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next){time=target;return;}timeouts.delete(next[0]);time=next[1].at;next[1].fn();}throw new Error('重复调度边界计时器');
 }};
}

test('提前完成结束倒计时；同轮补采更早的完成声明只升级确认、沿用观测计时',()=>{
 const d=fixture();action(d,'promise');observation(d,'observation','2026-10-24T01:40:00Z');
 const observed=card(d);assert.equal(observed.state,'observed');assert.equal(observed.early,true);assert.equal(observed.hero.title,'额度已提前重置');assert.equal(observed.hero.badge,'第三方报告');assert.equal(observed.clockAt,'2026-10-24T01:40:00Z');
 action(d,'declared','claimed_complete','2026-10-24T01:30:00Z',undefined,'automatic_reset','promise',NOW);
 const declared=card(d);assert.equal(declared.state,'completed');assert.equal(declared.hero.badge,'发布者已确认');assert.equal(declared.clockAt,observed.clockAt);assert.equal(declared.hero.metric,observed.hero.metric);assert.equal(declared.publicationId,'pub-declared');assert.match(declared.declarationTime,/09:30/);assert.notEqual(declared.revision,observed.revision);
});
test('旧观测、不同类别及竞争轮次不冒充当前预告的完成；原帖关联优先',()=>{
 const d=fixture(),oldPromise=action(d,'one'),old=observation(d,'old','2026-10-23T13:00:00Z');assert.equal(card(d).state,'overdue');oldPromise.event.actions[0].evidenceIds=[old.eid];assert.equal(card(d).state,'overdue','引用同一原帖也不能把预告之前的旧观测当成提前完成');
 const e=fixture();action(e,'banked','promised',START,T,'banked_reset');observation(e,'regular','2026-10-24T01:40:00Z');assert.equal(card(e,NOW,'banked_reset').state,'overdue');
 const c=fixture();const p=action(c,'one');action(c,'two','promised','2026-10-23T15:00:00Z','2026-10-24T04:00:00Z');const o=observation(c,'unmatched','2026-10-24T01:40:00Z');assert.equal(card(c).state,'scheduled');assert.equal(card(c).observationPublicationId,'pub-unmatched');
 p.event.actions[0].evidenceIds=[o.eid];assert.equal(card(c).state,'scheduled','明确属于旧轮次的观测不能结束更新的未来预告');
});
test('进行中跨截止时间统一转超时，24小时边界退出且刷新不复活旧记录',()=>{
 const d=fixture();action(d,'older','claimed_complete','2026-10-22T04:00:00Z',undefined);action(d,'promise');action(d,'started','in_progress','2026-10-24T00:00:00Z',T,'automatic_reset','promise');
 assert.equal(card(d,'2026-10-24T01:59:59Z').state,'progress');const overdue=card(d,T);assert.equal(overdue.state,'overdue');assert.match(overdue.hero.description,/已宣布开始/);assert.equal(overdue.validUntil,'2026-10-25T02:00:00.000Z');
 assert.equal(card(d,'2026-10-25T01:59:59Z').state,'overdue');
 for(const at of ['2026-10-25T02:00:00Z','2026-10-26T03:00:00Z']){const expired=card(d,at);assert.equal(expired.state,'waiting');assert.equal(expired.hero.title,'暂无新消息');assert.equal(expired.publicationId,'');assert.equal(expired.clockAt,'');assert.equal(expired.hero.metric,'');assert.equal(expired.expiredRound,true);assert.match(expired.sharePath,/home\/index/);}
});
test('24小时内新安排、调整、取消与完成取代旧状态；无关动态不覆盖',()=>{
 for(const stage of ['promised','cancelled','claimed_complete'] as const){const d=fixture();action(d,'old');const p=action(d,'new',stage,'2026-10-24T02:30:00Z',stage==='promised'?'2026-10-25T02:00:00Z':undefined);const v=card(d);assert.equal(v.state,stage==='promised'?'scheduled':stage==='cancelled'?'cancelled':'completed');assert.equal(v.publicationId,p.id);}
 const d=fixture();action(d,'v1');action(d,'v2','promised','2026-10-24T02:30:00Z','2026-10-24T06:00:00Z','automatic_reset','v1');assert.equal(card(d).state,'revised');assert.match(card(d).oldTime,/10:00/);
 const unrelated=action(d,'product','promised','2026-10-24T02:50:00Z');unrelated.mode='news_only';unrelated.article.category='product';assert.equal(card(d).publicationId,'pub-v2');
});
test('来源故障不改完成事实、不延长窗口；完成记录本身不受24小时退出规则影响',()=>{
 const d=fixture();action(d,'promise');const before=card(d);d.sources[0].status='failed';const after=card(d);assert.equal(after.state,before.state);assert.equal(after.validUntil,before.validUntil);assert.match(homeResetStatus(d).sourceWarning,/来源更新延迟/);assert.equal(card(d,'2026-10-25T02:00:00Z').state,'waiting');
 const c=fixture();action(c,'completed','claimed_complete','2026-10-20T00:00:00Z',undefined);assert.equal(card(c).state,'completed');assert.match(card(c).metric,/4天/);assert.equal(card(c).validUntil,'');
});
test('首页精简数据只保留服务端outlook时，同样执行进行中超时和24小时退出',()=>{
 const d=fixture(),active={actionId:'projected',eventId:'projected-event',publicationId:'projected-publication',kind:'automatic_reset',stage:'in_progress',statementAt:START,expectedAt:T,timeNote:'最晚之前'};
 d.forecasts={outlook:{status:'in_progress',active}} as PublicData['forecasts'];
 assert.equal(card(d).state,'overdue');assert.equal(card(d).timeQualifier,'前');assert.equal(card(d).publicationId,active.publicationId);
 assert.equal(card(d,'2026-10-25T02:00:00Z').expiredRound,true);
 const before=card(d,'2026-10-24T01:00:00Z');assert.equal(before.state,'progress');assert.equal(before.validUntil,'2026-10-24T02:00:00.000Z');
});
test('首页、两种海报、分享与类别一致；按分钟走时不失效，事实变化或24小时边界使旧快照失效',()=>{
 const d=fixture();action(d,'regular');action(d,'banked','claimed_complete','2026-10-23T00:00:00Z',undefined,'banked_reset');observation(d,'observed','2026-10-24T01:40:00Z');const before=JSON.stringify(d);
 for(const kind of ['automatic_reset','banked_reset']){const home=card(d,NOW,kind),poster=statusPosterInput(d,kind);assert.equal(poster.title,home.hero.title||home.title);assert.equal(poster.value,home.hero.metric||home.hero.title);assert.equal(poster.sharePath,home.sharePath);assert.equal(poster.shareTitle,home.shareTitle);assert.equal(poster.publicationId,home.publicationId);assert.equal(poster.round,home.revision);for(const theme of ['precision','editorial']){const layout=createStatusPosterLayout(poster,(s:string,n:number)=>s.length*n,theme);assert.ok(layout.commands.some((c:any)=>c.value===poster.value));}assert.equal(statusPosterAvailable(poster,{...d,serverTime:'2026-10-24T03:01:00Z'}),true);}
 assert.equal(JSON.stringify(d),before,'所有状态与分享推导不得改写输入');
 const e=fixture();action(e,'promise');const snap=statusPosterInput(e);assert.equal(statusPosterAvailable(snap,{...e,serverTime:'2026-10-25T02:00:00Z'}),false);const waiting=statusPosterInput({...e,serverTime:'2026-10-25T02:00:00Z'});assert.equal(waiting.codePublicationId,'');assert.match(waiting.sharePath,/home\/index/);
 const linked=statusPosterInput(d);d.articles.find(a=>a.id==='article-observed')!.status='withdrawn';assert.equal(statusPosterAvailable(linked,d),false);
});

test('原生首页无预测数据也能前台到点和24小时退出，每个边界只复用一次刷新',()=>{
 const start=Date.parse(T)-100,d=fixture();d.serverTime=new Date(start).toISOString();action(d,'promise');
 const h=nativeHome(d,start);
 try {
  assert.equal(h.page.data.resetCards[0].state,'scheduled');
  h.advanceTo(Date.parse(T)+100);assert.equal(h.page.data.resetCards[0].state,'overdue');assert.equal(h.refreshes,1);
  h.page.syncForecastExpiry();assert.equal(h.refreshes,1);
  h.advanceTo(Date.parse(T)+86400000-1);assert.equal(h.page.data.resetCards[0].state,'overdue');
  h.advanceTo(Date.parse(T)+86400000+100);assert.equal(h.page.data.resetCards[0].state,'waiting');assert.equal(h.refreshes,2);
  assert.match(h.page.onShareAppMessage().path,/home\/index\?kind=automatic_reset/);
  h.page.openStatusEvidence({currentTarget:{dataset:{kind:'automatic_reset'}}});assert.deepEqual(h.tabs,['/pages/announcements/index']);
  h.page.redraw();assert.equal(h.page.data.resetCards[0].state,'waiting');assert.equal(h.refreshes,2);assert.equal(h.timeouts.size,0);
 } finally {h.page.onUnload();}
 assert.equal(h.timeouts.size,0);assert.equal(h.intervals.size,0);
});
test('后台跨越24小时、重新进入和无数据首次加载不会恢复旧预告或泄漏计时器',()=>{
 const start=Date.parse(T)+100,d=fixture();d.serverTime=new Date(start).toISOString();action(d,'promise');
 const h=nativeHome(d,start);
 try {
  assert.equal(h.page.data.resetCards[0].state,'overdue');h.page.onHide();assert.equal(h.timeouts.size,0);assert.equal(h.intervals.size,0);
  h.advanceTo(Date.parse(T)+86400000+100);h.page.onShow();assert.equal(h.page.data.resetCards[0].state,'waiting');
  assert.equal(h.page.currentHomeStatus().expiredRound,true);h.page.onHide();h.page.onShow();assert.equal(h.page.data.resetCards[0].state,'waiting');
 } finally {h.page.onUnload();}
 const reopenedAt=Date.parse(T)+86400000+100;
 const fresh=nativeHome({...d,serverTime:new Date(reopenedAt).toISOString()},reopenedAt);try{assert.equal(fresh.page.data.resetCards[0].state,'waiting');}finally{fresh.page.onUnload();}
 const empty=nativeHome(null,start);try{assert.equal(empty.page.data.initialLoading,true);assert.equal(empty.timeouts.size,0);assert.equal(empty.intervals.size,0);}finally{empty.page.onUnload();}
});
test('原生类别切换和海报入口携带同一状态版本，转发不会使用另一类别旧记录',()=>{
 const d=fixture();action(d,'regular');action(d,'banked','claimed_complete','2026-10-23T00:00:00Z',undefined,'banked_reset');const h=nativeHome(d,Date.parse(NOW),'banked_reset');
 try {
  const selected=card(d,NOW,'banked_reset');assert.equal(h.page.data.selectedResetKind,'banked_reset');assert.equal(h.page.onShareAppMessage().path,selected.sharePath);
  h.page.openPoster();const entry=new URL(h.navigations[0],'https://isolated.test');assert.equal(entry.searchParams.get('kind'),'banked_reset');assert.equal(entry.searchParams.get('revision'),selected.revision);
  h.page.selectResetKind({currentTarget:{dataset:{kind:'automatic_reset'}}});assert.equal(h.page.onShareAppMessage().title,card(d).shareTitle);assert.equal(h.page.data.sharePath,card(d).sharePath);
 } finally {h.page.onUnload();}
});
