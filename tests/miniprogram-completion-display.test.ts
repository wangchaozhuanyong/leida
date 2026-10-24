import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {Script} from 'node:vm';
import type {BenefitAction,Publication,PublicData} from '../src/lib/types';
import * as web from '../src/components/public/model';
const require=createRequire(import.meta.url),mini=require('../miniprogram/utils/model.js');
const root=resolve(import.meta.dirname,'..'),now='2026-10-13T08:00:00.000Z';
function publication(id:string,kind:BenefitAction['kind'],statementAt:string):Publication {
 const eventId=`event-${id}`,articleId=`article-${id}`;
 return {id,eventId,articleId,publishedAt:now,cutoffAt:now,mode:'state_change',reason:'隔离测试',
  event:{id:eventId,title:'测试公告',status:'published',version:1,publicationId:id,updatedAt:now,evidenceIds:[],actions:[{id:`action-${id}`,kind,statementAt,stage:'claimed_complete',scope:'public',eligibility:'公开用户',evidenceIds:[]}]},
  article:{id:articleId,eventId,publicationId:id,title:'测试公告',summary:'隔离输入',translation:'',category:'reset',status:'published',version:1,evidenceIds:[],historical:false,publishedAt:now,updatedAt:now}};
}
function fixture(publications:Publication[]):PublicData {
 return {serverTime:now,events:publications.map(p=>structuredClone(p.event)),articles:publications.map(p=>structuredClone(p.article)),publications,evidence:[],notices:[],activities:[],sources:[],site:{name:'测试雷达',description:'',autoPublish:true,version:1}};
}
function nativeHome(data:PublicData) {
 let advance=0,definition:any,listener:(state:any)=>void=()=>{},timerId=0;
 const timers=new Map<number,()=>void>(),cache=new Map<string,any>(),navigations:string[]=[];
 class Clock extends Date { static now(){return 1000000+advance;} }
 const state=()=>({data,receivedAt:1000000,loading:false,unconfigured:false,error:''});
 const app={client:{subscribe(fn:(state:any)=>void){listener=fn;fn(state());return()=>{listener=()=>{};};},getState:state}};
 function load(filename:string):any {
  if(cache.has(filename))return cache.get(filename).exports;
  const module={exports:{}};cache.set(filename,module);
  new Script(readFileSync(filename,'utf8'),{filename}).runInNewContext({module,exports:module.exports,Date:Clock,wx:{navigateTo:({url}:{url:string})=>navigations.push(url)},getApp:()=>app,Page:(value:any)=>{definition=value;},setInterval:(fn:()=>void)=>{timers.set(++timerId,fn);return timerId;},clearInterval:(id:number)=>timers.delete(id),setTimeout:()=>++timerId,clearTimeout(){},require:(path:string)=>load(resolve(dirname(filename),path.endsWith('.js')?path:`${path}.js`))});
  return module.exports;
 }
 load(resolve(root,'miniprogram/pages/home/index.js'));
 const page={...definition,data:structuredClone(definition.data),setData(patch:object){for(const [key,value] of Object.entries(patch)){const path=key.split('.');let target:any=this.data;for(const part of path.slice(0,-1)){target[part]??={};target=target[part];}target[path.at(-1)!]=value;}}};
 page.onLoad({});page.onShow();
 return {page,timers,navigations,advance(ms:number){advance+=ms;[...timers.values()].forEach(fn=>fn());},refresh(){listener(state());}};
}
test('小程序与网站采用相同的两类完成记录和24小时规则，保持原输入',()=>{
 const data=fixture([publication('old','automatic_reset','2026-10-10T04:00:00Z'),publication('reset','automatic_reset','2026-10-13T05:45:00Z'),publication('card','banked_reset','2026-10-13T07:25:00Z')]);
 const before=structuredClone(data),native=mini.latestCompletedBenefits(data);
 assert.deepEqual(native.map((row:any)=>row.action.id),web.latestCompletedBenefits(data).map(row=>row.action.id));
 assert.equal(native.length,2);
 for(const row of native){assert.deepEqual(mini.completionElapsed(row.action,now),web.completionElapsed(row.action,now));assert.equal(mini.completionTime(row.action.statementAt),web.completionTime(row.action.statementAt));}
 assert.deepEqual(data,before);
});
test('首页最近完成按事件列出，连续同类型的11日和13日不会被15日覆盖',()=>{
 const data=fixture([publication('card','banked_reset','2026-10-08T03:44:55Z'),publication('eleven','automatic_reset','2026-10-11T04:01:09Z'),publication('thirteen','automatic_reset','2026-10-13T05:06:06Z'),publication('fifteen','automatic_reset','2026-10-15T06:28:13Z')]);
 data.serverTime='2026-10-17T04:00:00Z';
 const before=structuredClone(data),expected=['action-fifteen','action-thirteen','action-eleven','action-card'];
 assert.deepEqual(web.recentCompletedBenefits(data).map(row=>row.action.id),expected);
 assert.deepEqual(mini.recentCompletedBenefits(data).map((row:any)=>row.action.id),expected);
 const home=nativeHome(data);
 assert.deepEqual(Array.from(home.page.data.completions,(row:any)=>row.id),expected);
 assert.equal(home.page.data.completions[1].shortTime,'10月13日 13:06');assert.equal(home.page.data.completions[2].shortTime,'10月11日 12:01');
 assert.equal(mini.latestCompletedBenefits(data).length,2,'按类型最新仅用于当前状态和海报，不是最近事件列表');
 assert.deepEqual(data,before);home.page.onUnload();
});
test('最近完成有五条上限，按原始完成时间排序，不把同轮快照重复计数',()=>{
 const data=fixture(Array.from({length:8},(_,i)=>publication(`r${i}`,'automatic_reset',`2026-10-${String(i+1).padStart(2,'0')}T01:00:00Z`)));
 data.publications.push(structuredClone(data.publications[7]));
 const expected=['action-r7','action-r6','action-r5','action-r4','action-r3'];
 assert.deepEqual(web.recentCompletedBenefits(data).map(row=>row.action.id),expected);
 assert.deepEqual(mini.recentCompletedBenefits(data).map((row:any)=>row.action.id),expected);
});
test('未来、个人、仅新闻、撤回和未完成公告不作为小程序完成依据',()=>{
 const reset=publication('reset','automatic_reset','2026-10-13T05:45:00Z');
 for(const kind of ['future','private','news','withdrawn','pending','invalid-publication']){
  const p=publication(kind,'banked_reset','2026-10-13T07:25:00Z');
  if(kind==='future')p.event.actions[0].statementAt='2026-10-13T08:00:01Z';
  if(kind==='private')p.event.actions[0].scope='private';
  if(kind==='news')p.mode='news_only';
  if(kind==='withdrawn')p.article.status='withdrawn';
  if(kind==='pending')p.event.actions[0].stage='promised';
  if(kind==='invalid-publication')p.publishedAt='invalid';
  assert.deepEqual(mini.latestCompletedBenefits(fixture([reset,p])).map((row:any)=>row.action.id),['action-reset']);
 }
});
test('跨24小时主状态恢复等待，最近消息保留日期并更新相对时长',()=>{
 const data=fixture([publication('reset','automatic_reset','2026-10-12T08:00:01Z'),publication('card','banked_reset','2026-10-10T04:00:00Z')]);
 const h=nativeHome(data);
 assert.equal(h.page.data.timeline.completed,true);assert.equal(h.timers.size,1);assert.equal(h.page.data.completions.length,2);
 h.advance(1000);
 assert.equal(h.page.data.timeline.completed,false);assert.equal(h.page.data.timeline.title,'等待下一次 Reset');assert.equal(h.timers.size,1);assert.equal(h.page.data.lastReset.relativeTime,'距今 1天');assert.equal(h.page.data.completions.length,2);
 assert.equal(h.page.data.completions[0].time,'2026/10/12 16:00');
 h.refresh();assert.equal(h.page.data.timeline.completed,false,'刷新不重开24小时');
 h.page.onUnload();assert.equal(h.timers.size,0);
});
test('最近发卡与重置独立计时，分享原文绑定最近完成；隐藏页面停止并在显示时恢复',()=>{
 const h=nativeHome(fixture([publication('reset','automatic_reset','2026-10-13T05:45:00Z'),publication('card','banked_reset','2026-10-13T07:25:00Z')]));
 assert.equal(h.page.data.lastReset.relativeTime,'距今 2小时15分钟');assert.equal(h.page.data.timeline.title,'已确认发放重置卡');
 assert.equal(h.page.data.completions[1].time,'2026/10/13 13:45');
 assert.match(h.page.onShareAppMessage().path,/^\/pages\/detail\/index\?publicationId=reset&kind=automatic_reset&revision=home-[a-f0-9]{16}$/);
 h.page.onHide();assert.equal(h.timers.size,0);
 h.advance(60000);h.page.onShow();assert.equal(h.page.data.lastReset.relativeTime,'距今 2小时16分钟');assert.equal(h.timers.size,1);
 h.page.onUnload();assert.equal(h.timers.size,0);
});
test('首页公告入口有预告时对应当前轮次，无预告时对应最近完成，无记录时进入历史',()=>{
 const complete=publication('complete','automatic_reset','2026-10-13T05:45:00Z');
 const waiting=nativeHome(fixture([complete]));
 assert.equal(waiting.page.data.evidenceLabel,'查看最近公告');
 assert.equal(waiting.page.data.evidencePath,'/pages/detail/index?publicationId=complete');waiting.page.onUnload();
 const next=publication('next','automatic_reset','2026-10-13T07:45:00Z');
 next.event.actions[0].stage='promised';next.event.actions[0].expectedAt='2026-10-13T09:00:00Z';
 const scheduled=nativeHome(fixture([complete,next]));
 assert.equal(scheduled.page.data.evidenceLabel,'查看本次公告');
 assert.equal(scheduled.page.data.evidencePath,'/pages/detail/index?publicationId=next');
 assert.equal(scheduled.page.data.completions.length,1,'新预告不清空最近完成事实');scheduled.page.onUnload();
 const empty=nativeHome(fixture([]));
 assert.equal(empty.page.data.evidenceLabel,'浏览历史记录');
 assert.equal(empty.page.data.evidencePath,'/pages/announcements/index');empty.page.onUnload();
});
test('首页紧凑完成记录使用北京时间，跨年保留年份且不冒充个人到账',()=>{
 const h=nativeHome(fixture([publication('new','automatic_reset','2026-10-12T18:30:00Z'),publication('old','banked_reset','2025-12-31T07:25:00Z')]));
 assert.equal(h.page.data.completions[0].label,'用量重置');
 assert.equal(h.page.data.completions[0].shortTime,'10月13日 02:30');
 assert.equal(h.page.data.completions[1].label,'重置卡发放');
 assert.equal(h.page.data.completions[1].shortTime,'2025年12月31日 15:25');
 assert.equal(h.page.data.completions[0].title,'公告称已重置用量');h.page.onUnload();
});

test('最近消息不为秒数跨原生桥发更新，分钟变化只传主卡与相对时长',()=>{
 const h=nativeHome(fixture([publication('reset','automatic_reset','2026-10-13T05:45:00Z')]));
 const changes:Record<string,unknown>[]=[],original=h.page.setData.bind(h.page),before=h.page.data.completions;
 h.page.setData=(patch:Record<string,unknown>)=>{changes.push(patch);original(patch);};
 h.advance(1000);assert.equal(changes.length,0);assert.equal(h.page.data.lastReset.relativeTime,'距今 2小时15分钟');
 h.advance(59000);assert.equal(changes.length,1);assert.deepEqual(Object.keys(changes[0]),['resetCards','lastReset.relativeTime']);assert.equal(h.page.data.resetCards[0].metric,'2小时16分钟');
 assert.equal(h.page.data.completions,before);assert.equal(h.page.data.lastReset.relativeTime,'距今 2小时16分钟');h.page.onUnload();
});

test('跨天相对时长进位时不更换消息日期和公告起点',()=>{
 const h=nativeHome(fixture([publication('reset','automatic_reset','2026-10-12T08:00:01Z')]));
 assert.equal(h.page.data.lastReset.relativeTime,'距今 23小时59分钟');
 assert.equal(h.page.data.lastReset.dateText,'10月12日');assert.equal(h.page.data.lastReset.clockText,'16:00');
 h.advance(1000);
 assert.equal(h.page.data.lastReset.relativeTime,'距今 1天');
 assert.equal(h.page.data.lastReset.dateText,'10月12日');assert.equal(h.page.data.lastReset.clockText,'16:00');
 assert.equal(h.page.data.lastReset.publicationId,'reset');h.page.onUnload();
});

test('原生首页切换类型同时切换最近消息和链接，返回与刷新保持所选类别',()=>{
 const h=nativeHome(fixture([publication('reset','automatic_reset','2026-10-11T19:14:52Z'),publication('card','banked_reset','2026-10-13T07:25:00Z')]));
 assert.equal(h.page.data.dial,undefined);assert.equal(h.page.data.lastReset.relativeTime,'距今 1天12小时');
 h.page.selectResetKind({currentTarget:{dataset:{kind:'banked_reset'}}});
 assert.equal(h.page.data.selectedResetKind,'banked_reset');assert.equal(h.page.data.lastReset.relativeTime,'距今 35分钟');
 h.page.openLastReset();assert.equal(h.navigations.at(-1),'/pages/detail/index?publicationId=card');
 const changes:Record<string,unknown>[]=[],original=h.page.setData.bind(h.page);h.page.setData=(patch:Record<string,unknown>)=>{changes.push(patch);original(patch);};
 h.advance(1000);assert.equal(h.page.data.lastReset.relativeTime,'距今 35分钟');assert.equal(changes.length,0);
 h.page.onHide();h.advance(60000);h.page.onShow();
 assert.equal(h.page.data.selectedResetKind,'banked_reset');assert.equal(h.page.data.lastReset.relativeTime,'距今 36分钟');
 h.refresh();assert.equal(h.page.data.lastReset.publicationId,'card');assert.equal(h.page.data.lastReset.relativeTime,'距今 36分钟');
 h.page.selectResetKind({currentTarget:{dataset:{kind:'automatic_reset'}}});
 assert.equal(h.page.data.lastReset.relativeTime,'距今 1天12小时');
 h.page.openLastReset();assert.equal(h.navigations.at(-1),'/pages/detail/index?publicationId=reset');
 h.page.onUnload();assert.equal(h.timers.size,0);
});

test('原生所选类别无历史时清空旧消息，切换到有历史的类别能恢复相对时间',()=>{
 const h=nativeHome(fixture([publication('reset','automatic_reset','2026-10-11T19:14:52Z')]));
 h.page.selectResetKind({currentTarget:{dataset:{kind:'banked_reset'}}});assert.equal(h.page.data.lastReset,null);assert.equal(h.timers.size,0);
 h.page.openLastReset();assert.equal(h.navigations.length,0);
 h.advance(2000);h.page.selectResetKind({currentTarget:{dataset:{kind:'automatic_reset'}}});
 assert.equal(h.page.data.lastReset.relativeTime,'距今 1天12小时');assert.equal(h.timers.size,1);h.page.onUnload();
 const banked=nativeHome(fixture([publication('card','banked_reset','2026-10-08T03:44:55Z')]));
 assert.equal(banked.page.data.lastReset,null);assert.equal(banked.timers.size,0);
 banked.page.selectResetKind({currentTarget:{dataset:{kind:'banked_reset'}}});assert.equal(banked.page.data.lastReset.relativeTime,'距今 5天4小时');assert.equal(banked.timers.size,1);
 banked.advance(1000);assert.equal(banked.page.data.lastReset.relativeTime,'距今 5天4小时');banked.page.onUnload();
});
