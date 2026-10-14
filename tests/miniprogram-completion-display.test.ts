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
 const timers=new Map<number,()=>void>(),cache=new Map<string,any>();
 class Clock extends Date { static now(){return 1000000+advance;} }
 const state=()=>({data,receivedAt:1000000,loading:false,unconfigured:false,error:''});
 const app={client:{subscribe(fn:(state:any)=>void){listener=fn;fn(state());return()=>{listener=()=>{};};},getState:state}};
 function load(filename:string):any {
  if(cache.has(filename))return cache.get(filename).exports;
  const module={exports:{}};cache.set(filename,module);
  new Script(readFileSync(filename,'utf8'),{filename}).runInNewContext({module,exports:module.exports,Date:Clock,wx:{},getApp:()=>app,Page:(value:any)=>{definition=value;},setInterval:(fn:()=>void)=>{timers.set(++timerId,fn);return timerId;},clearInterval:(id:number)=>timers.delete(id),require:(path:string)=>load(resolve(dirname(filename),path.endsWith('.js')?path:`${path}.js`))});
  return module.exports;
 }
 load(resolve(root,'miniprogram/pages/home/index.js'));
 const page={...definition,data:structuredClone(definition.data),setData(patch:object){Object.assign(this.data,patch);}};
 page.onLoad({});page.onShow();
 return {page,timers,advance(ms:number){advance+=ms;[...timers.values()].forEach(fn=>fn());},refresh(){listener(state());}};
}
test('小程序与网站采用相同的两类完成记录和24小时规则，保持原输入',()=>{
 const data=fixture([publication('old','automatic_reset','2026-10-10T04:00:00Z'),publication('reset','automatic_reset','2026-10-13T05:45:00Z'),publication('card','banked_reset','2026-10-13T07:25:00Z')]);
 const before=structuredClone(data),native=mini.latestCompletedBenefits(data);
 assert.deepEqual(native.map((row:any)=>row.action.id),web.latestCompletedBenefits(data).map(row=>row.action.id));
 assert.equal(native.length,2);
 for(const row of native){assert.deepEqual(mini.completionElapsed(row.action,now),web.completionElapsed(row.action,now));assert.equal(mini.completionTime(row.action.statementAt),web.completionTime(row.action.statementAt));}
 assert.deepEqual(data,before);
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
test('真实原生首页打开期间跨24小时自动恢复等待，并停止计时器且保留两条记录',()=>{
 const data=fixture([publication('reset','automatic_reset','2026-10-12T08:00:01Z'),publication('card','banked_reset','2026-10-10T04:00:00Z')]);
 const h=nativeHome(data);
 assert.equal(h.page.data.timeline.completed,true);assert.equal(h.timers.size,1);assert.equal(h.page.data.completions.length,2);
 h.advance(1000);
 assert.equal(h.page.data.timeline.completed,false);assert.equal(h.page.data.timeline.title,'等待预告');assert.equal(h.timers.size,0);assert.equal(h.page.data.completions.length,2);
 assert.equal(h.page.data.completions[0].time,'2026/10/12 16:00');
 h.refresh();assert.equal(h.page.data.timeline.completed,false,'刷新不重开24小时');
 h.page.onUnload();assert.equal(h.timers.size,0);
});
test('最近发卡与重置独立计时，分享原文绑定最近完成；隐藏页面停止并在显示时恢复',()=>{
 const h=nativeHome(fixture([publication('reset','automatic_reset','2026-10-13T05:45:00Z'),publication('card','banked_reset','2026-10-13T07:25:00Z')]));
 assert.match(h.page.data.timeline.note,/^35分钟前/);assert.equal(h.page.data.timeline.title,'已确认发放重置卡');
 assert.equal(h.page.data.completions[1].time,'2026/10/13 13:45');
 assert.equal(h.page.onShareAppMessage().path,'/pages/detail/index?publicationId=card');
 h.page.onHide();assert.equal(h.timers.size,0);
 h.advance(60000);h.page.onShow();assert.match(h.page.data.timeline.note,/^36分钟前/);assert.equal(h.timers.size,1);
 h.page.onUnload();assert.equal(h.timers.size,0);
});
