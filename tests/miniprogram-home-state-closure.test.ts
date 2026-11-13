import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {publicResetOutlook,announcementNeedsReview} from '../src/lib/reset-outlook';
import {reminderContentCurrent} from '../src/lib/reminder-lifecycle';
import {statusShareUrl} from '../src/lib/share';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';
import type {PublicData,Publication,ActionKind,ActionStage} from '../src/lib/types';
const require=createRequire(import.meta.url);
const {homeResetStatus,selectedHomeStatus}=require('../miniprogram/utils/home-reset-status');
const {createHomeTabNotices}=require('../miniprogram/utils/home-tab-notice');
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
function limitsObservation(data:PublicData,id:string,at:string){
 const o=observation(data,id,at),e=data.evidence.find(e=>e.id===o.eid)!,date=new Date(at),url='https://codexlimits.com/reset-history';
 const summary=`Third-party observation on ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getUTCMonth()]} ${date.getUTCDate()}, ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')} UTC.`;
 Object.assign(e,{url,sourceId:'codexlimits-observations',messageId:'observed-codexlimits-'+date.getTime(),publishedAt:date.toISOString(),text:'Usage reset landed\n'+summary,metadata:{sourceGroup:'codexlimits',category:'reset',benefitKind:'automatic_reset',referenceReset:{referenceUrl:url,eventId:'codexlimits:automatic_reset:'+date.toISOString(),occurredAt:date.toISOString(),snapshotAt:e.collectedAt,summary}}});
 return o;
}
const card=(data:PublicData,at=data.serverTime,kind='automatic_reset')=>selectedHomeStatus(data,kind,at);
function untimedAction(data:PublicData,id:string,stage:ActionStage,at:string,kind:ActionKind='automatic_reset'){
 const p=action(data,id,stage,at,undefined,kind);
 for(const event of [p.event,data.events.find(e=>e.id===p.eventId)!])delete event.actions[0].expectedAt;
 return p;
}

test('完整历史的旧进展与已经观测的旧预告不争抢下一轮观测，首页和海报选择一致',()=>{
 const data=fixture();data.serverTime='2026-11-04T04:00:00Z';
 untimedAction(data,'old-progress','in_progress','2026-07-14T19:34:00Z');
 untimedAction(data,'known-completion','claimed_complete','2026-10-20T06:33:00Z');
 untimedAction(data,'previous-promise','promised','2026-10-26T05:21:00Z');
 limitsObservation(data,'previous-observation','2026-10-26T06:08:00Z');
 untimedAction(data,'next-promise','promised','2026-10-28T02:42:00Z');
 limitsObservation(data,'next-observation','2026-10-28T06:35:00Z');
 untimedAction(data,'latest-card','claimed_complete','2026-11-01T23:27:00Z','banked_reset');
 const projection=structuredClone(data),keep=new Set(['pub-next-promise','pub-next-observation','pub-latest-card']);
 projection.publications=projection.publications.filter(p=>keep.has(p.id));
 projection.articles=projection.articles.filter(a=>keep.has(a.publicationId));
 projection.events=projection.events.filter(e=>keep.has(e.publicationId));
 const before=structuredClone(data),full=homeResetStatus(data),home=homeResetStatus(projection);
 assert.equal(full.primary.kind,'banked_reset');assert.equal(full.primary.revision,home.primary.revision);
 assert.equal(card(data).state,'observed');assert.equal(card(data).clockAt,'2026-10-28T06:35:00.000Z');
 assert.equal(statusPosterInput(data).round,statusPosterInput(projection).round);
 assert.deepEqual(data,before,'展示不能改写历史事实');
});

test('两个都尚无完成依据的重叠预告仍保持待核对，不能仅按先后顺序认定后一轮完成',()=>{
 const data=fixture();data.serverTime='2026-11-04T04:00:00Z';
 untimedAction(data,'first-open','promised','2026-10-26T05:00:00Z');
 untimedAction(data,'second-open','promised','2026-10-28T02:00:00Z');
 limitsObservation(data,'ambiguous-proof','2026-10-28T06:35:00Z');
 const result=card(data);assert.equal(result.state,'announced');assert.equal(result.completedDisplay,false);
 assert.equal(result.observationPublicationId,'pub-ambiguous-proof');
});

test('额度和重置卡共用倒计时、超时和完成计时，开始消息不单独占首页',()=>{
 const cases:[ActionStage,string,boolean,string][]=[
  ['promised','2026-10-24T01:00:00Z',false,'announced'],
  ['promised','2026-10-24T01:00:00Z',true,'scheduled'],
  ['in_progress','2026-10-24T01:00:00Z',false,'announced'],
  ['in_progress','2026-10-24T03:00:00Z',true,'overdue'],
  ['promised','2026-10-25T02:00:00Z',true,'cancelled'],
  ['claimed_complete','2026-10-23T15:00:00Z',false,'completed'],
 ];
 for(const [stage,now,timed,expected] of cases){
  const cards=(['automatic_reset','banked_reset'] as ActionKind[]).map(kind=>{
   const data=fixture();data.serverTime=now;
   const p=action(data,'same',stage,START,T,kind);
   for(const event of [p.event,data.events[0]]){
    if(!timed)delete event.actions[0].expectedAt;
    event.actions[0].timeNote=kind==='banked_reset'&&stage==='in_progress'?'发布者报告重置卡发放进度 1/2，后续批次待更新':'最晚之前';
   }
   const c=card(data,now,kind);assert.equal(c.state,expected);
   assert.doesNotMatch(JSON.stringify(c.hero),/1\/2|正在发放|进行中|完成待确认/);
   const input=statusPosterInput(data,kind,now);
   assert.equal(input.label,c.hero.label);assert.equal(input.title,c.hero.title||c.title);
   return c;
  });
  const clock=(c:any)=>({state:c.state,completed:c.completedDisplay,anchor:c.clockAt,parts:c.clockParts,metric:c.metric,expires:c.validUntil});
  assert.deepEqual(clock(cards[1]),clock(cards[0]),`${stage} at ${now}`);
 }
});

// Execute the actual native page and its local modules with a controlled wall clock.
// Intervals are deliberately throttled: the explicit boundary timer must still work.
function nativeHome(data:PublicData|null,at:number,kind='automatic_reset',options:{notices?:any;snapshotPending?:boolean;nextTick?:(fn:()=>void)=>void}={}) {
 let definition:any,time=at,id=0,refreshes=0;
 const receivedAt=at,root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const timeouts=new Map<number,{at:number;fn:()=>void}>(),intervals=new Map<number,()=>void>(),cache=new Map<string,{exports:any}>();
 const navigations:string[]=[],tabs:string[]=[];
 class Clock extends Date {static now(){return time;}}
 const state=()=>({data,receivedAt,loading:!data,unconfigured:false,error:'',snapshotPending:!!options.snapshotPending});
 const app={homeTabNotices:options.notices,client:{getState:state,subscribe(fn:(value:ReturnType<typeof state>)=>void){fn(state());return()=>{};},refresh(){refreshes++;return Promise.resolve();}}};
 function load(filename:string):any {
  if(cache.has(filename))return cache.get(filename)!.exports;
  const module={exports:{}};cache.set(filename,module);
  new Script(readFileSync(filename,'utf8'),{filename}).runInNewContext({module,exports:module.exports,Date:Clock,Page(value:unknown){definition=value;},getApp:()=>app,
   wx:{nextTick:options.nextTick,navigateTo({url}:{url:string}){navigations.push(url);},switchTab({url}:{url:string}){tabs.push(url);},showToast(){}},
   setTimeout(fn:()=>void,delay:number){timeouts.set(++id,{at:time+delay,fn});return id;},clearTimeout(timer:number){timeouts.delete(timer);},
   setInterval(fn:()=>void){intervals.set(++id,fn);return id;},clearInterval(timer:number){intervals.delete(timer);},
   require(path:string){const file=resolve(dirname(filename),path.endsWith('.js')?path:path+'.js');assert.ok(file.startsWith(resolve(root,'miniprogram')+'/'));return load(file);}});
  return module.exports;
 }
 load(resolve(root,'miniprogram/pages/home/index.js'));
 const patches:Record<string,unknown>[]=[];
 const page={...definition,data:structuredClone(definition.data),setData(patch:Record<string,unknown>,done?:()=>void){patches.push(structuredClone(patch));for(const [key,value] of Object.entries(patch)){const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');let target=this.data;for(const part of parts.slice(0,-1))target=target[part];target[parts.at(-1)!]=value;}done?.();}};
 page.onLoad({kind});page.onShow();
 return {page,navigations,tabs,timeouts,intervals,patches,get refreshes(){return refreshes;},advanceTo(target:number){
  for(let count=0;count<10;count++){const next=[...timeouts].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next){time=target;return;}timeouts.delete(next[0]);time=next[1].at;next[1].fn();}throw new Error('重复调度边界计时器');
 }};
}

test('提前完成结束倒计时；同轮补采更早的完成声明只升级确认、沿用观测计时',()=>{
 const d=fixture();action(d,'promise');observation(d,'observation','2026-10-24T01:40:00Z');
 const observed=card(d);assert.equal(observed.state,'observed');assert.equal(observed.early,true);assert.equal(observed.hero.title,'距离上次重置（观测）');assert.equal(observed.hero.badge,'第三方报告');assert.equal(observed.clockAt,'2026-10-24T01:40:00Z');assert.match(observed.hero.description,/来源：Codex Resets/);assert.equal(observed.evidenceType,'observation');
 action(d,'declared','claimed_complete','2026-10-24T01:30:00Z',undefined,'automatic_reset','promise',NOW);
 const declared=card(d);assert.equal(declared.state,'completed');assert.equal(declared.hero.badge,'发布者已确认');assert.equal(declared.clockAt,observed.clockAt);assert.equal(declared.hero.metric,observed.hero.metric);assert.equal(declared.publicationId,'pub-declared');assert.match(declared.declarationTime,/09:30/);assert.notEqual(declared.revision,observed.revision);
 const later=card(d,'2026-10-25T03:00:00Z');assert.equal(later.state,'completed');assert.equal(later.clockAt,observed.clockAt);assert.equal(later.hero.badge,'发布者已确认');assert.equal(statusPosterInput({...d,serverTime:'2026-10-25T03:00:00Z'}).sourceLabel,'依据：发布者公开完成声明');
 const afterCycle=card(d,'2026-10-31T02:00:00Z');
 assert.equal(afterCycle.hero.title,'距离上次重置','完成声明的确认等级不能因为沿用观测计时而降级');
 assert.equal(afterCycle.clockAt,observed.clockAt);assert.equal(afterCycle.timeAt,observed.clockAt);
 assert.equal(afterCycle.hero.timeLabel,'来源观测时间');
 assert.equal(statusPosterInput({...d,serverTime:'2026-10-31T02:00:00Z'}).sourceLabel,'依据：发布者公开完成声明');
});

test('纯观测超过7天仍保留经过时长及来源，两款海报与首页同步',()=>{
 const d=fixture();observation(d,'last-observation','2026-10-24T01:40:00Z');d.serverTime='2026-10-31T02:00:00Z';
 const c=card(d),input=statusPosterInput(d);
 assert.equal(c.state,'observed');assert.equal(c.hero.title,'距离上次重置（观测）');assert.equal(c.hero.badge,'第三方报告');
 assert.equal(c.clockAt,'2026-10-24T01:40:00Z');assert.equal(c.timeAt,c.clockAt);assert.equal(c.hero.metric,'7天0小时20分钟0秒');
 assert.equal(input.value,c.hero.metric);assert.equal(input.statementAt,c.clockAt);assert.match(input.sourceLabel,/第三方观测/);
 for(const theme of ['precision','editorial']){
  const layout=createStatusPosterLayout(input,(text:string,size:number)=>text.length*size*.55,theme,false);
  const copy=layout.commands.filter((c:any)=>c.type==='text').map((c:any)=>c.value).join(' ');
  assert.match(copy,/距离上次重置（观测）/);assert.doesNotMatch(copy,/周期时间已到|7天周期推算/);
 }
 const previousRevision=c.revision;
 action(d,'new-arrangement','promised','2026-10-31T01:50:00Z','2026-10-31T04:00:00Z');
 assert.equal(card(d).state,'scheduled');assert.notEqual(card(d).revision,previousRevision);assert.equal(statusPosterAvailable(input,d),false);
});
test('同轮两个来源采用最早有效观测计时，较晚采集和刷新不把计时推迟',()=>{
 const d=fixture();action(d,'promise');observation(d,'later','2026-10-24T01:40:00Z','2113492502355562875');observation(d,'earlier','2026-10-24T01:00:00Z');
 const view=card(d);assert.equal(view.clockAt,'2026-10-24T01:00:00Z');assert.equal(view.hero.label,'已经过去');assert.equal(view.hero.title,'距离上次重置（观测）');assert.equal(view.publicationId,'pub-earlier');assert.match(view.hero.metric,/2小时/);
 const poster=statusPosterInput(d);assert.equal(poster.publicationId,view.publicationId);assert.equal(poster.value,view.hero.metric);assert.equal(poster.sharePath,view.sharePath);
 d.evidence.forEach(e=>e.collectedAt='2026-10-24T02:59:00Z');assert.equal(card(d).clockAt,view.clockAt);
 action(d,'declared','claimed_complete','2026-10-24T01:30:00Z',undefined,'automatic_reset','promise',NOW);
 assert.equal(card(d).clockAt,view.clockAt);assert.equal(card(d).hero.badge,'发布者已确认');assert.equal(card(d).hero.title,'距离上次重置');
});
test('旧轮已有最早观测，不阻挡匹配窗口之外的新独立重置；首页、海报与转发一起接替',()=>{
 const d=fixture();d.serverTime='2026-10-25T06:43:39Z';
 action(d,'old-promise','promised','2026-10-23T04:47:34Z','2026-10-23T18:00:00Z');
 observation(d,'old-first','2026-10-23T17:00:00Z');observation(d,'old-second','2026-10-23T17:40:00Z','2113492502355562875');
 const old=card(d),snapshot=statusPosterInput(d);assert.equal(old.clockAt,'2026-10-23T17:00:00Z');
 observation(d,'new-reset','2026-10-25T06:10:00Z','2114200291319124163');
 const current=card(d),poster=statusPosterInput(d);
 assert.equal(current.clockAt,'2026-10-25T06:10:00Z');assert.equal(current.publicationId,'pub-new-reset');
 assert.equal(current.hero.title,'距离上次重置（观测）');assert.equal(current.hero.label,'已经过去');assert.equal(current.expectedAt,'');assert.equal(current.early,false);
 assert.notEqual(current.roundKey,old.roundKey);assert.notEqual(current.revision,old.revision);assert.equal(statusPosterAvailable(snapshot,d),false);
 assert.equal(poster.statementAt,current.clockAt);assert.equal(poster.publicationId,current.publicationId);assert.equal(poster.sharePath,current.sharePath);
 for(const theme of ['precision','editorial'])assert.ok(createStatusPosterLayout(poster,(s:string,n:number)=>s.length*n,theme).commands.some((c:any)=>c.value===(poster.clockParts?.length?poster.clockParts.filter((part:any)=>['小时','分钟','秒'].includes(part.unit)).map((part:any)=>part.value).join(' : '):poster.value)));
 assert.match(current.sharePath,/publicationId=pub-new-reset/);
 const h=nativeHome(d,Date.parse(d.serverTime));try{assert.equal(h.page.data.resetCards[0].clockAt,current.clockAt);assert.equal(h.page.onShareAppMessage().path,current.sharePath);}finally{h.page.onUnload();}
});
test('连续多轮独立观测按发生时间接替，采集乱序、旧声明补采与数组顺序不能复活旧轮',()=>{
 const d=fixture();d.serverTime='2026-10-28T03:00:00Z';action(d,'promise');observation(d,'first','2026-10-24T01:00:00Z');
 for(const [index,[id,at]] of [['second','2026-10-25T03:00:00Z'],['third','2026-10-26T03:00:00Z'],['fourth','2026-10-27T03:00:00Z']].entries()){
  observation(d,id,at,String(2113492502355562875n+BigInt(index)));assert.equal(card(d).clockAt,at);assert.equal(card(d).publicationId,'pub-'+id);
 }
 action(d,'late-declaration','claimed_complete','2026-10-24T01:30:00Z',undefined,'automatic_reset','promise',d.serverTime);
 d.evidence[0].collectedAt=d.serverTime;
 for(const key of ['publications','articles','events','evidence'] as const)d[key].reverse();
 assert.equal(card(d).clockAt,'2026-10-27T03:00:00Z');assert.equal(card(d).publicationId,'pub-fourth');
});
test('新独立观测撤回后恢复上一条有效依据，不保留失效结论',()=>{
 const d=fixture();d.serverTime='2026-10-26T03:00:00Z';action(d,'promise');observation(d,'first','2026-10-24T01:00:00Z');
 observation(d,'second','2026-10-25T03:00:00Z','2113492502355562875');assert.equal(card(d).publicationId,'pub-second');
 d.articles.find(a=>a.id==='article-second')!.status='withdrawn';assert.equal(card(d).publicationId,'pub-first');
});
test('存在竞争轮次的未归属观测不能替换已绑定的同轮依据',()=>{
 const d=fixture();action(d,'older');const newest=action(d,'newest','promised','2026-10-23T15:00:00Z','2026-10-24T04:00:00Z');
 const owned=observation(d,'owned','2026-10-24T01:00:00Z');newest.event.actions[0].evidenceIds=[owned.eid];
 observation(d,'ambiguous','2026-10-24T01:40:00Z','2113492502355562875');
 assert.equal(card(d).clockAt,'2026-10-24T01:00:00Z');assert.equal(card(d).publicationId,'pub-owned');
});
test('新独立额度观测不覆盖重置卡，也不挤掉更新的待执行预告',()=>{
 const d=fixture();d.serverTime='2026-10-26T03:00:00Z';action(d,'old');observation(d,'first','2026-10-24T01:00:00Z');
 action(d,'banked','claimed_complete','2026-10-23T00:00:00Z',undefined,'banked_reset');
 observation(d,'second','2026-10-25T03:00:00Z','2113492502355562875');assert.equal(card(d).publicationId,'pub-second');assert.equal(card(d,d.serverTime,'banked_reset').publicationId,'pub-banked');
 action(d,'next','promised','2026-10-25T04:00:00Z','2026-10-27T02:00:00Z');
 assert.equal(card(d).publicationId,'pub-next');assert.equal(card(d).state,'scheduled');
});
test('来源历史页网址相同只是出处相同，不能把下一次观测永久归入旧轮',()=>{
 const d=fixture();d.serverTime='2026-10-26T03:00:00Z';const promise=action(d,'promise');
 const first=limitsObservation(d,'limits-first','2026-10-24T01:00:00Z');promise.event.actions[0].evidenceIds=[first.eid];
 assert.equal(card(d).clockAt,'2026-10-24T01:00:00.000Z');
 limitsObservation(d,'limits-new','2026-10-25T03:00:00Z');
 assert.equal(card(d).clockAt,'2026-10-25T03:00:00.000Z');assert.equal(card(d).publicationId,'pub-limits-new');
});
test('同轮匹配窗口的24小时边界包含等值，超过边界的新独立观测另行显示',()=>{
 for(const offset of [0,1]){
  const d=fixture();d.serverTime='2026-10-25T03:00:00Z';action(d,'promise');observation(d,'first','2026-10-24T01:00:00Z');
  const at=new Date(Date.parse(T)+86400000+offset).toISOString();observation(d,'later',at,'2113492502355562875');
  assert.equal(card(d).clockAt,offset?at:'2026-10-24T01:00:00Z');
 }
});
test('旧观测、不同类别及竞争轮次不冒充当前预告的完成；原帖关联优先',()=>{
 const d=fixture(),oldPromise=action(d,'one'),old=observation(d,'old','2026-10-23T13:00:00Z');assert.equal(card(d).state,'overdue');oldPromise.event.actions[0].evidenceIds=[old.eid];assert.equal(card(d).state,'overdue','引用同一原帖也不能把预告之前的旧观测当成提前完成');
 const e=fixture();action(e,'banked','promised',START,T,'banked_reset');observation(e,'regular','2026-10-24T01:40:00Z');assert.equal(card(e,NOW,'banked_reset').state,'overdue');
 const c=fixture();const p=action(c,'one');action(c,'two','promised','2026-10-23T15:00:00Z','2026-10-24T04:00:00Z');const o=observation(c,'unmatched','2026-10-24T01:40:00Z');assert.equal(card(c).state,'scheduled');assert.equal(card(c).observationPublicationId,'pub-unmatched');
 p.event.actions[0].evidenceIds=[o.eid];assert.equal(card(c).state,'scheduled','明确属于旧轮次的观测不能结束更新的未来预告');
});
test('开始消息沿用倒计时，到点正计，满24小时回到上次发生计时',()=>{
 const d=fixture();action(d,'older','claimed_complete','2026-10-22T04:00:00Z',undefined);action(d,'promise');action(d,'started','in_progress','2026-10-24T00:00:00Z',T,'automatic_reset','promise');
 const before=card(d,'2026-10-24T01:59:59Z');assert.equal(before.state,'scheduled');assert.equal(before.hero.metric,'0小时0分钟1秒');
 const overdue=card(d,T);assert.equal(overdue.state,'overdue');assert.equal(overdue.hero.metric,'0小时0分钟0秒');assert.equal(overdue.validUntil,'2026-10-25T02:00:00.000Z');
 assert.equal(card(d,'2026-10-24T02:00:29Z').hero.metric,'0小时0分钟29秒');
 assert.equal(card(d,'2026-10-25T01:59:59Z').state,'overdue');
 for(const at of ['2026-10-25T02:00:00Z','2026-10-26T03:00:00Z']){
  const expired=card(d,at);
  assert.equal(expired.state,'completed');assert.equal(expired.hero.title,'距离上次重置');
  assert.equal(expired.publicationId,'pub-older');assert.equal(expired.clockAt,'2026-10-22T04:00:00Z');
  assert.equal(expired.roundNotice.label,'本轮重置等待确认已结束');assert.match(expired.roundNotice.basis,/超时 24 小时，暂未确认/);
  assert.match(expired.sharePath,/home\/index/);
  assert.match(statusPosterInput({...d,serverTime:at},'automatic_reset').nextNote,/本轮重置等待确认已结束/);
 }
});
test('24小时内新安排、调整、取消与完成取代旧状态；无关动态不覆盖',()=>{
 for(const stage of ['promised','cancelled','claimed_complete'] as const){const d=fixture();action(d,'old');const p=action(d,'new',stage,'2026-10-24T02:30:00Z',stage==='promised'?'2026-10-25T02:00:00Z':undefined);const v=card(d);assert.equal(v.state,stage==='promised'?'scheduled':stage==='cancelled'?'cancelled':'completed');assert.equal(v.publicationId,p.id);}
 const d=fixture();action(d,'v1');action(d,'v2','promised','2026-10-24T02:30:00Z','2026-10-24T06:00:00Z','automatic_reset','v1');assert.equal(card(d).state,'revised');assert.match(card(d).oldTime,/10:00/);
 const unrelated=action(d,'product','promised','2026-10-24T02:50:00Z');unrelated.mode='news_only';unrelated.article.category='product';assert.equal(card(d).publicationId,'pub-v2');
});
test('来源故障不改完成事实或预告窗口；完成24小时后持续显示真实计时',()=>{
 const d=fixture();action(d,'promise');const before=card(d);d.sources[0].status='failed';const after=card(d);assert.equal(after.state,before.state);assert.equal(after.validUntil,before.validUntil);assert.match(homeResetStatus(d).sourceWarning,/来源更新延迟/);assert.equal(card(d,'2026-10-25T02:00:00Z').state,'cancelled');
 const c=fixture();action(c,'completed','claimed_complete','2026-10-20T00:00:00Z',undefined);assert.equal(card(c).state,'completed');assert.equal(card(c).clockAt,'2026-10-20T00:00:00Z');assert.equal(card(c).expectedAt,T);assert.equal(card(c).validUntil,'');
});
test('首页精简数据只保留服务端outlook时，同样执行进行中超时和24小时退出',()=>{
 const d=fixture(),active={actionId:'projected',eventId:'projected-event',publicationId:'projected-publication',kind:'automatic_reset',stage:'in_progress',statementAt:START,expectedAt:T,timeNote:'最晚之前'};
 d.forecasts={outlook:{status:'in_progress',active}} as PublicData['forecasts'];
 assert.equal(card(d).state,'overdue');assert.equal(card(d).timeQualifier,'前');assert.equal(card(d).publicationId,active.publicationId);
 assert.equal(card(d,'2026-10-25T02:00:00Z').expiredRound,true);
 const before=card(d,'2026-10-24T01:00:00Z');assert.equal(before.state,'scheduled');assert.equal(before.validUntil,'2026-10-24T02:00:00.000Z');
});
test('首页、两种海报、分享与类别一致；按分钟走时不失效，事实变化或24小时边界使旧快照失效',()=>{
 const d=fixture();action(d,'regular');action(d,'banked','claimed_complete','2026-10-23T00:00:00Z',undefined,'banked_reset');observation(d,'observed','2026-10-24T01:40:00Z');const before=JSON.stringify(d);
 for(const kind of ['automatic_reset','banked_reset']){const home=card(d,NOW,kind),poster=statusPosterInput(d,kind);assert.equal(poster.title,home.hero.title||home.title);assert.equal(poster.value,home.hero.metric||home.hero.title);assert.equal(poster.sharePath,home.sharePath);assert.equal(poster.shareTitle,home.shareTitle);assert.equal(poster.publicationId,['cycle','history'].includes(home.evidenceType)?'':home.publicationId);assert.equal(poster.round,home.revision);for(const theme of ['precision','editorial']){const layout=createStatusPosterLayout(poster,(s:string,n:number)=>s.length*n,theme);assert.ok(layout.commands.some((c:any)=>c.value===(poster.clockParts?.length?poster.clockParts.filter((part:any)=>['小时','分钟','秒'].includes(part.unit)).map((part:any)=>part.value).join(' : '):poster.value)));}assert.equal(statusPosterAvailable(poster,{...d,serverTime:'2026-10-24T03:01:00Z'}),true);}
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
  h.advanceTo(Date.parse(T)+86400000+100);assert.equal(h.page.data.resetCards[0].state,'cancelled');assert.equal(h.refreshes,2);
  assert.equal(h.page.data.primaryCard.roundNotice.label,'本轮重置等待确认已结束');
  assert.match(h.page.onShareAppMessage().path,/home\/index\?kind=automatic_reset/);
  h.page.openStatusEvidence({currentTarget:{dataset:{kind:'automatic_reset'}}});assert.deepEqual(h.navigations,['/pages/detail/index?publicationId=pub-promise']);
  h.page.redraw();assert.equal(h.page.data.resetCards[0].state,'cancelled');assert.equal(h.refreshes,2);assert.equal(h.timeouts.size,0);
 } finally {h.page.onUnload();}
 assert.equal(h.timeouts.size,0);assert.equal(h.intervals.size,0);
});
test('仅有推测信号时也开启原生倒计时，新发卡完成消息接替海报和首页',()=>{
 const start=Date.parse(NOW),d=fixture();
 d.forecasts={status:'ready',ruleVersion:'test',modelVersion:'test',generatedAt:NOW,cases:[],reference:{} as any,
  referenceSignal:{id:'fixture',sourceUrl:'https://x.com/thsottiaux/status/2120410480204525936',text:'Maybe a banked reset Saturday.',sourceName:'AIPlanWatch',publishedAt:START,recordedAt:START,
   hint:{kind:'banked_reset',dayLabel:'周六',expiresAt:'2026-10-25T07:00:00Z'}}};
 const h=nativeHome(d,start,'');
 try {
  assert.equal(h.page.data.lastReset,null);
  assert.equal(h.page.data.primaryCard.state,'estimated');
  assert.equal(h.page.data.primaryCard.hero.metric,'1天4小时0分钟0秒');
  const poster=statusPosterInput(d);
  assert.equal(poster.value,h.page.data.primaryCard.hero.metric);
  assert.equal(poster.statementLabel,'推测窗口结束');
  assert.equal(h.intervals.size,1);
  h.advanceTo(start+60_000);
  for(const tick of h.intervals.values())tick();
  assert.equal(h.page.data.primaryCard.hero.metric,'1天3小时59分钟0秒');
  action(d,'actual-banked','claimed_complete',new Date(start+30_000).toISOString(),undefined,'banked_reset');
  h.page.redraw();
  assert.equal(h.page.data.primaryCard.state,'completed');
  assert.match(h.page.data.primaryCard.hero.badge,/已发放/);
  assert.equal(statusPosterAvailable(poster,{...d,serverTime:new Date(start+60_000).toISOString()}),false);
 }finally{h.page.onUnload();}
 assert.equal(h.intervals.size,0);
});
test('后台跨越24小时、重新进入和无数据首次加载不会恢复旧预告或泄漏计时器',()=>{
 const start=Date.parse(T)+100,d=fixture();d.serverTime=new Date(start).toISOString();action(d,'promise');
 const h=nativeHome(d,start);
 try {
  assert.equal(h.page.data.resetCards[0].state,'overdue');h.page.onHide();assert.equal(h.timeouts.size,0);assert.equal(h.intervals.size,0);
  h.advanceTo(Date.parse(T)+86400000+100);h.page.onShow();assert.equal(h.page.data.resetCards[0].state,'cancelled');
  assert.equal(h.page.currentHomeStatus().expiredRound,true);h.page.onHide();h.page.onShow();assert.equal(h.page.data.resetCards[0].state,'cancelled');
 } finally {h.page.onUnload();}
 const reopenedAt=Date.parse(T)+86400000+100;
 const fresh=nativeHome({...d,serverTime:new Date(reopenedAt).toISOString()},reopenedAt);try{assert.equal(fresh.page.data.resetCards[0].state,'cancelled');}finally{fresh.page.onUnload();}
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


const newsConfig={mode:'cloud',cloudEnv:'isolated-public-env',serviceName:'isolated-radar'};
function noticeStorage(fail=false){let value:any;const writes:any[]=[];return {writes,api:{getStorageSync(){return value;},setStorageSync(_key:string,next:any){if(fail)throw new Error('isolated storage unavailable');value=structuredClone(next);writes.push(value);}}};}
function bankedFixture(stage:ActionStage='promised',at=START){const d=fixture();action(d,'card-news',stage,at,stage==='promised'?T:undefined,'banked_reset','card-round');return d;}

test('首页重置卡预告提示、查看后消除、返回及重新打开保持已读；真实进展再次提示',()=>{
 const d=bankedFixture(),store=noticeStorage(),notices=createHomeTabNotices(store.api,newsConfig);
 const h=nativeHome(d,Date.parse(NOW),'automatic_reset',{notices});
 assert.equal(h.page.data.bankedResetUnread,true);assert.equal(store.writes.length,0);
 h.page.selectResetKind({currentTarget:{dataset:{kind:'banked_reset'}}});assert.equal(h.page.data.bankedResetUnread,false);assert.equal(store.writes.length,1);
 h.page.selectResetKind({currentTarget:{dataset:{kind:'automatic_reset'}}});assert.equal(h.page.data.bankedResetUnread,false);
 const reopened=nativeHome(d,Date.parse(NOW),'automatic_reset',{notices:createHomeTabNotices(store.api,newsConfig)});assert.equal(reopened.page.data.bankedResetUnread,false);
 action(d,'card-complete','claimed_complete','2026-10-24T02:30:00Z',undefined,'banked_reset','card-round');reopened.page.redraw();assert.equal(reopened.page.data.bankedResetUnread,true);
 for(const page of [h.page,reopened.page])page.onHide();
});

test('卡片提示依据真实消息版本；倒计时跨点、来源刷新和普通产品消息不重新提示',()=>{
 const d=bankedFixture(),store=noticeStorage(),notices=createHomeTabNotices(store.api,newsConfig);
 notices.markRead(homeResetStatus(d,START).cards,d);
 for(const at of ['2026-10-24T01:59:00Z','2026-10-24T02:00:00Z','2026-10-24T03:00:00Z']){
  d.serverTime=at;assert.equal(notices.unread(homeResetStatus(d,at).cards,d),false);
 }
 d.sources[0].lastSuccessAt=NOW;d.notices.push({id:'ordinary-news'} as any);assert.equal(notices.unread(homeResetStatus(d).cards,d),false);assert.equal(store.writes.length,1);
});

test('重置卡时间调整与取消属于新消息；同一预告的重复发布不属于新消息',()=>{
 const d=bankedFixture(),notices=createHomeTabNotices(noticeStorage().api,newsConfig);
 notices.markRead(homeResetStatus(d).cards,d);
 action(d,'card-duplicate','promised',START,T,'banked_reset','card-round');assert.equal(notices.unread(homeResetStatus(d).cards,d),false);
 action(d,'card-adjust','promised','2026-10-24T00:00:00Z','2026-10-24T04:00:00Z','banked_reset','card-round');assert.equal(notices.unread(homeResetStatus(d).cards,d),true);
 notices.markRead(homeResetStatus(d).cards,d);action(d,'card-cancel','cancelled','2026-10-24T01:00:00Z',undefined,'banked_reset','card-round');assert.equal(notices.unread(homeResetStatus(d).cards,d),true);
});

test('无消息、旧完成记录、历史补采不提示；近期完成与仍有效预告可提示',()=>{
 const notices=createHomeTabNotices(noticeStorage().api,newsConfig),empty=fixture();assert.equal(notices.unread(homeResetStatus(empty).cards,empty),false);
 const old=bankedFixture('claimed_complete','2026-10-08T03:44:55Z');assert.equal(notices.unread(homeResetStatus(old).cards,old),false);
 const recent=bankedFixture('claimed_complete','2026-10-24T01:00:00Z');assert.equal(notices.unread(homeResetStatus(recent).cards,recent),true);
 for(const a of recent.articles)a.historical=true;for(const p of recent.publications)p.article.historical=true;assert.equal(notices.unread(homeResetStatus(recent).cards,recent),false);
 const pending=bankedFixture('promised','2026-10-20T01:00:00Z');pending.publications[0].event.actions[0].expectedAt='2026-10-25T02:00:00Z';pending.events[0].actions[0].expectedAt='2026-10-25T02:00:00Z';assert.equal(notices.unread(homeResetStatus(pending).cards,pending),true);
});

test('晚到旧缓存不恢复已读提示；本地存储故障不影响本次已读及页面导航',()=>{
 const older=bankedFixture(),fresh=bankedFixture('claimed_complete','2026-10-24T02:30:00Z'),notices=createHomeTabNotices(noticeStorage(true).api,newsConfig);
 notices.markRead(homeResetStatus(fresh).cards,fresh);assert.equal(notices.unread(homeResetStatus(older).cards,older),false);assert.equal(notices.markRead(homeResetStatus(older).cards,older),false);
 const h=nativeHome(fresh,Date.parse(NOW),'automatic_reset',{notices});assert.equal(h.page.data.bankedResetUnread,false);h.page.selectResetKind({currentTarget:{dataset:{kind:'banked_reset'}}});h.page.onHide();
});

test('只有实际可见的新内容才确认已读：缓存等待、隐藏和快速切回不能误清提示',()=>{
 const d=bankedFixture(),store=noticeStorage(),notices=createHomeTabNotices(store.api,newsConfig),ticks:Array<()=>void>=[];
 const cached=nativeHome(d,Date.parse(NOW),'banked_reset',{notices,snapshotPending:true});assert.equal(store.writes.length,0);cached.page.onHide();
 const h=nativeHome(d,Date.parse(NOW),'automatic_reset',{notices,nextTick:fn=>ticks.push(fn)});
 h.page.selectResetKind({currentTarget:{dataset:{kind:'banked_reset'}}});h.page.selectResetKind({currentTarget:{dataset:{kind:'automatic_reset'}}});ticks.splice(0).forEach(fn=>fn());assert.equal(store.writes.length,0);assert.equal(h.page.data.bankedResetUnread,true);
 h.page.selectResetKind({currentTarget:{dataset:{kind:'banked_reset'}}});h.page.onHide();ticks.splice(0).forEach(fn=>fn());assert.equal(store.writes.length,0);
});

test('已读只存公共消息身份并按环境隔离，不包含登录、次数或提醒授权',()=>{
 const d=bankedFixture(),store=noticeStorage(),notices=createHomeTabNotices(store.api,newsConfig);notices.markRead(homeResetStatus(d).cards,d);
 const raw=JSON.stringify(store.writes);assert.doesNotMatch(raw,/token|session|remaining|templateId|openid|secret/i);
 const other=createHomeTabNotices(store.api,{...newsConfig,cloudEnv:'another-isolated-env'});assert.equal(other.unread(homeResetStatus(d).cards,d),true);
});

// Native lifecycle must retain the recorded reset anchor across long absences.
test('原生首页跨过24小时和7天、后台恢复及重新进入仍保持原始计时',()=>{
 const start=Date.parse(START),d=fixture();d.serverTime=START;action(d,'done','claimed_complete',START,undefined);
 const h=nativeHome(d,start);try{
  assert.equal(h.page.data.resetCards[0].state,'completed');
  h.advanceTo(start+86400000+100);h.page.onHide();h.page.onShow();assert.equal(h.page.data.resetCards[0].state,'completed');
  h.page.onHide();h.advanceTo(start+7*86400000+100);h.page.onShow();
  assert.equal(h.page.data.resetCards[0].state,'completed');assert.equal(h.page.data.resetCards[0].clockAt,START);
  assert.equal(h.page.data.resetCards[0].expectedAt,T);
  assert.equal(h.page.data.resetCards[0].hero.title,'距离上次重置');assert.equal(h.page.data.resetCards[0].timeAt,START);
  h.page.openStatusEvidence({currentTarget:{dataset:{kind:'automatic_reset'}}});
  assert.equal(h.navigations.at(-1),'/pages/detail/index?publicationId=pub-done');
 }finally{h.page.onUnload();}
});


test('两类预告并存取最近期限，换主卡后旧海报失效，另一类预告保留',()=>{
 const data=fixture();
 action(data,'automatic','promised',START,'2026-10-26T10:00:00Z');
 const saved=statusPosterInput(data);
 assert.equal(saved.kind,'automatic_reset');
 const other=action(data,'banked','promised','2026-10-24T02:10:00Z','2026-10-25T02:00:00Z','banked_reset');
 const {primary,secondary}=homeResetStatus(data),current=statusPosterInput(data);
 assert.equal(primary.publicationId,other.id);
 assert.equal(secondary.publicationId,'pub-automatic');
 assert.equal(statusPosterAvailable(saved,data),false);
 assert.equal(current.round,primary.revision);
 assert.equal(current.sharePath,primary.sharePath);
 assert.equal(statusShareUrl('https://example.test',data.publications,current),'https://example.test/events/event-banked?version=pub-banked');
});

test('完成旧轮不能撤下已识别的另一轮预告，也不能拦截对应提醒',()=>{
 const data=fixture();
 action(data,'old-promise','promised','2026-10-21T02:00:00Z',T,'automatic_reset','old');
 const next=action(data,'next','promised','2026-10-22T02:00:00Z','2026-10-25T02:00:00Z');
 next.article.evidenceIds=['proof-next'];
 next.event.actions[0].evidenceIds=['proof-next'];
 data.events.find(e=>e.id===next.eventId)!.actions[0].evidenceIds=['proof-next'];
 action(data,'old-done','claimed_complete',T,undefined,'automatic_reset','old');
 const outlook=publicResetOutlook(data,'automatic_reset');
 const native=require('../miniprogram/utils/model').resetOutlookModel;
 assert.equal(native(data,'automatic_reset').active?.publicationId,next.id);
 assert.equal(outlook.active?.publicationId,next.id);
 assert.equal(homeResetStatus(data).primary.publicationId,next.id);
 const notice={status:'active',categories:['announcement']} as Parameters<typeof reminderContentCurrent>[0];
 assert.equal(reminderContentCurrent(notice,next,next.event,NOW,outlook.latestResolutions),true);
 // Removing the earlier promise removes proof of an independent previous round.
 data.publications=data.publications.filter(p=>p.id!=='pub-old-promise');
 const ambiguous=publicResetOutlook(data,'automatic_reset');
 assert.equal(ambiguous.active,undefined);
 assert.equal(native(data,'automatic_reset').active,null);
 assert.equal(reminderContentCurrent(notice,next,next.event,NOW,ambiguous.latestResolutions),false);
});

test('观测汇总分享保留实际日期和类别，空状态回首页',()=>{
 const url=(sharePath:string)=>statusShareUrl('https://example.test',[],{sharePath});
 assert.equal(url('/pages/schedule/index?date=2026-10-24&kind=automatic_reset&revision=one'),'https://example.test/history?date=2026-10-24&target=automatic');
 assert.equal(url('/pages/home/index?kind=banked_reset'),'https://example.test/');
});

test('同一事件内有独立动作身份也要核对旧批次的原预告',()=>{
 assert.equal(readFileSync(new URL('../src/lib/round-evidence.cjs',import.meta.url),'utf8'),
   readFileSync(new URL('../miniprogram/utils/round-evidence.js',import.meta.url),'utf8'),'服务器与小程序的观测归属规则同步');
 const native=require('../miniprogram/utils/round-evidence').announcementNeedsReview;
 const prior={actionId:'batch-1',eventId:'event-series',publicationId:'pub-complete',kind:'banked_reset',stage:'claimed_complete',statementAt:T,resolvedAt:T,announcedAt:'2026-10-21T02:00:00Z'} as const;
 for(const guard of [announcementNeedsReview,native]){
  const next={id:'batch-2',kind:'banked_reset',statementAt:START} as const;
  assert.equal(guard(next,prior,prior.eventId),false);
  assert.equal(guard({...next,id:'batch-1'},prior,prior.eventId),true);
  assert.equal(guard(next,{...prior,announcedAt:undefined},prior.eventId),true);
 }
});

test('两批都已发卡时按完成时间选择，补回第二批更早的预告也不能切回第一批',()=>{
 const data=fixture();data.serverTime='2026-11-03T12:00:00Z';
 const grantOne=action(data,'first-done','claimed_complete','2026-11-01T00:43:20Z',undefined,'banked_reset','one');
 const grantTwo=action(data,'second-done','claimed_complete','2026-11-01T23:27:20Z',undefined,'banked_reset','two');
 const compact=structuredClone(data);
 const full=fixture();full.serverTime=data.serverTime;
 action(full,'second-early-promise','promised','2026-10-31T05:42:26Z',undefined,'banked_reset','two');
 full.publications.push(...data.publications);full.events=data.events;full.articles.push(...data.articles);
 for(const sample of [compact,full]){
  const current=homeResetStatus(sample).primary,poster=statusPosterInput(sample);
  assert.equal(current.publicationId,grantTwo.id);
  assert.notEqual(current.publicationId,grantOne.id);
  assert.equal(current.clockAt,'2026-11-01T23:27:20Z');
  assert.equal(poster.publicationId,current.publicationId);
  assert.equal(poster.round,homeResetStatus(compact).primary.revision);
 }
});

test('每秒只更新计时字段，不替换首页卡片或列表，后台停止并按真实经过时间恢复',()=>{
 const d=fixture();observation(d,'observed-seconds','2026-10-24T01:40:00Z');
 const start=Date.parse(NOW),h=nativeHome(d,start);
 try{
  h.advanceTo(start+1000);h.patches.length=0;for(const tick of h.intervals.values())tick();
  assert.equal(h.page.data.primaryCard.hero.timeParts[2].value,'01');
  const keys=h.patches.flatMap(p=>Object.keys(p));
  assert(keys.includes('primaryCard.hero.timeParts'));
  assert(!keys.some(k=>['primaryCard','resetCards','recent','motionActive','pageEntrance'].includes(k)),keys.join(','));
  const revision=h.page.data.primaryCard.revision,anchor=h.page.data.primaryCard.clockAt;
  h.page.onHide();assert.equal(h.intervals.size,0);
  h.advanceTo(start+61000);h.page.onShow();for(const tick of h.intervals.values())tick();
  assert.equal(h.page.data.primaryCard.hero.metric,'1小时21分钟1秒');
  assert.equal(h.page.data.primaryCard.revision,revision);assert.equal(h.page.data.primaryCard.clockAt,anchor);
  const poster=statusPosterInput({...d,serverTime:new Date(start+61000).toISOString()});
  assert.equal(poster.value,h.page.data.primaryCard.hero.metric);assert.equal(poster.statementAt,anchor);
 }finally{h.page.onUnload();}assert.equal(h.intervals.size,0);
});
