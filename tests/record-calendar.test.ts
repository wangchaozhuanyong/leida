import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { PublicData, BenefitAction, Publication } from '../src/lib/types';
import { recordCalendar, recordRange, completedRecords } from '../miniprogram/utils/record-calendar';
import { parsePublicRoute } from '../src/components/public/public-navigation';
const require=createRequire(import.meta.url);
const { createClient }=require('../miniprogram/utils/client');
const { createRecordPage }=require('../miniprogram/utils/record-page');
const now='2026-10-17T08:00:00Z';
function fixture(): PublicData {
  const data: PublicData={site:{name:'测试雷达',description:'',autoPublish:true,version:1},events:[],articles:[],publications:[],evidence:[],notices:[],activities:[],sources:[],serverTime:now};
  function add(id:string,kind:BenefitAction['kind'],at:string,extra:Partial<BenefitAction>={}) {
    const action:BenefitAction={id,kind,statementAt:at,scope:'public',stage:'claimed_complete',eligibility:'公开',evidenceIds:[],...extra};
    const event={id,publicationId:`p-${id}`,title:id,version:1,status:'published' as const,evidenceIds:[],updatedAt:at,actions:[action]};
    const article={id:`a-${id}`,eventId:id,publicationId:event.publicationId,title:`测试${id}`,summary:'测试摘要',translation:'',category:'reset' as const,version:1,status:'published' as const,evidenceIds:[],publishedAt:at,updatedAt:at};
    const publication:Publication={id:event.publicationId,eventId:id,articleId:article.id,event:structuredClone(event),article:structuredClone(article),publishedAt:at,cutoffAt:at,reason:'测试'};
    data.events.push(event);data.articles.push(article);data.publications.push(publication);return publication;
  }
  add('oct15','automatic_reset','2026-10-15T06:28:00Z');
  add('oct13','automatic_reset','2026-10-13T05:06:00Z');
  add('oct8','banked_reset','2026-10-08T03:44:00Z');
  add('midnight','automatic_reset','2026-04-16T16:00:00Z');
  add('outside','automatic_reset','2026-04-16T15:59:59Z');
  add('ongoing','automatic_reset','2026-10-16T05:00:00Z',{stage:'in_progress'});
  add('targeted','banked_reset','2026-10-16T05:00:00Z',{scope:'targeted'});
  add('future','automatic_reset','2026-10-18T05:00:00Z');
  return data;
}
const envelope=(data=fixture(),version='c1')=>({data,version,contentVersion:version});
const config={mode:'https',baseUrl:'https://public.example.org',pollMs:300000};
function network() {
  const calls:any[]=[];const wx={request(o:any){calls.push(o);return {abort(){}};}};
  return {calls,wx,reply(index:number,data=envelope()){calls[index].success({statusCode:200,data});}};
}

test('近半年按北京时间与自然月边界，月底和闰年正确截断',()=>{
  assert.deepEqual(recordRange(now),{start:'2026-04-17',end:'2026-10-17'});
  assert.deepEqual(recordRange('2024-08-31T12:00:00Z'),{start:'2024-02-29',end:'2024-08-31'});
  assert.deepEqual(recordRange('2025-08-31T12:00:00Z'),{start:'2025-02-28',end:'2025-08-31'});
});
test('默认最新完成、北京时间归档；排除未完成、定向、未来及半年以外',()=>{
  const data=fixture(),before=structuredClone(data),model=recordCalendar(data);
  assert.equal(model.selected,'2026-10-15');assert.equal(model.days.length,35);
  assert.deepEqual(completedRecords(data).map(item=>item.action.id),['oct15','oct13','oct8','midnight']);
  assert.equal(model.automaticCount,2);assert.equal(model.bankedCount,1);
  assert.equal(model.confirmedCount,3);assert.equal(model.observedCount,0);assert.equal(model.selectedConfirmedCount,1);assert.equal(model.selectedObservedCount,0);
  assert.equal(model.selectedItems[0].evidenceType,'confirmed');assert.equal(model.selectedItems[0].statusLabel,'完成确认');assert.equal(model.selectedItems[0].sourceName,'');
  assert.equal(recordCalendar(data,{date:'2026-04-17'}).selectedItems[0].id,'midnight');
  assert.equal(recordCalendar(data,{date:'2026-10-08'}).selectedItems[0].time,'11:44');
  assert.deepEqual(data,before);
});
test('月历只保留有日期的完整周，四至六周均不裁掉月底',()=>{
  const data=fixture();
  for(const [serverTime,date,cells,last] of [
    ['2026-10-17T08:00:00Z','2026-10-15',35,'31'],
    ['2026-10-17T08:00:00Z','2026-08-01',42,'31'],
    ['2027-02-28T08:00:00Z','2027-02-01',28,'28']
  ] as const) {
    data.serverTime=serverTime;
    const days=recordCalendar(data,{date}).days;
    assert.equal(days.length,cells);
    assert.equal(days.filter(day=>!day.blank).at(-1)?.day,last);
    assert.ok(days.slice(-7).some(day=>!day.blank));
  }
});
test('日历不重复计同一动作，撤回和合并从标记与计数同步撤下',()=>{
  const data=fixture();const duplicate=structuredClone(data.publications[0]);duplicate.id='dup';duplicate.eventId='dup';duplicate.event.id='dup';duplicate.event.publicationId='dup';data.publications.push(duplicate);data.events.push(duplicate.event);
  assert.equal(completedRecords(data).filter(item=>item.action.id==='oct15').length,1);
  data.articles[0].status='withdrawn';assert.equal(completedRecords(data).some(item=>item.action.id==='oct15'),false);
  data.events[1].status='merged';assert.equal(recordCalendar(data).automaticCount,0);
});
test('按类型过滤、同日双标记、月份选择与无记录月份均使用同份资料',()=>{
  const data=fixture();const card=data.publications.find(item=>item.eventId==='oct8')!;card.event.actions[0].statementAt='2026-10-15T07:00:00Z';
  const model=recordCalendar(data);const day=model.days.find(item=>item.date==='2026-10-15')!;
  assert.equal(day.automatic,true);assert.equal(day.banked,true);assert.equal(day.count,2);
  assert.equal(recordCalendar(data,{kind:'banked_reset'}).selectedItems.length,1);
  const empty=recordCalendar(data,{month:'2026-09'});assert.equal(empty.selected,'2026-09-01');assert.equal(empty.selectedItems.length,0);
  assert.equal(recordCalendar(data,{month:'2026-04'}).selected,'2026-04-17');
  assert.equal(recordCalendar(data,{date:'2026-04-16'}).selected,'2026-10-15');
  assert.equal(recordCalendar(data,{date:'2026-02-31'}).selected,'2026-10-15');
  assert.ok(model.days.filter(item=>!item.blank&&item.date>'2026-10-17').every(item=>item.disabled));
});
test('记录页日期月份类型均不改变读取身份，动态重置通过服务端类型筛选完整分页',()=>{
  for(const query of ['','date=2026-10-08','date=2026-04-17&target=banked','target=automatic'])assert.equal(parsePublicRoute('/history',new URLSearchParams(query)).readPath,'/api/v1/bootstrap?view=calendar');
  assert.equal(parsePublicRoute('/news',new URLSearchParams('category=reset&target=banked')).readPath,'/api/v1/bootstrap?view=history&filter=banked_reset');
  assert.equal(parsePublicRoute('/news',new URLSearchParams('category=reset')).readPath,'/api/v1/bootstrap?view=history&filter=all');
});
test('小程序预取只写日历缓存；进入时共享在途请求、返回页面无需再次读取',async()=>{
  const n=network(),client=createClient({wxApi:n.wx,config,now:()=>1000});
  const home=client.setView({view:'home'});n.reply(0);await home;const current=client.getState(),seen:any[]=[];
  client.subscribe((s:any)=>seen.push(s));const prefetch=client.prefetchCalendar();client.prefetchCalendar();
  assert.equal(n.calls.length,2);assert.equal(client.getState(),current);assert.equal(seen.length,1);
  const enter=client.setView({view:'calendar'});assert.equal(n.calls.length,2);
  n.reply(1);await prefetch;await enter;assert.equal(client.getState().loading,false);assert.equal(client.getState().data.serverTime,now);
  await client.setView({view:'home'});await client.setView({view:'calendar'});assert.equal(n.calls.length,2);client.stop();
});
test('预取失败不污染首页，进入记录可以重试',async()=>{
  const n=network(),client=createClient({wxApi:n.wx,config,now:()=>1000});const home=client.setView({view:'home'});n.reply(0);await home;
  const original=client.getState().data,prefetch=client.prefetchCalendar();n.calls[1].fail({errMsg:'timeout'});await prefetch;
  assert.equal(client.getState().data,original);assert.equal(client.getState().error,'');
  const enter=client.setView({view:'calendar'});n.reply(2);await enter;assert.equal(client.getState().error,'');
  await client.setView({view:'home'});client.stop();
});
test('小程序连续选日切月切类型不发请求，旧日程链接定位且返回保留选择',()=>{
  const definition=createRecordPage(true),data=fixture();let reads=0;
  const client={setView(){reads++;return Promise.resolve();},getState(){return {data,receivedAt:Date.now(),loading:false};},subscribe(fn:any){fn(this.getState());return()=>{};}};
  const previous=(globalThis as any).getApp,previousWx=(globalThis as any).wx;(globalThis as any).wx={};(globalThis as any).getApp=()=>({client});
  const page:any={...definition,data:structuredClone(definition.data),setData(patch:any,callback?:()=>void){Object.assign(this.data,patch);callback?.();}};
  try {
    page.onLoad({date:'2026-10-08'});page.onShow();assert.equal(page.data.selected,'2026-10-08');assert.equal(page.data.calendarBack,true);
    for(let i=0;i<60;i++)page.selectDay({currentTarget:{dataset:{date:i%2?'2026-10-15':'2026-10-08'}}});
    page.selectKind({currentTarget:{dataset:{value:'banked_reset'}}});page.moveToMonth(1);assert.equal(page.data.month,'2026-09');assert.equal(page.data.selectedItems.length,0);
    page.recentRecord();assert.equal(page.data.selected,'2026-10-08');assert.equal(reads,1);page.onHide();page.onShow();assert.equal(page.data.selected,'2026-10-08');assert.equal(page.data.kind,'banked_reset');
  } finally {page.onUnload();(globalThis as any).getApp=previous;(globalThis as any).wx=previousWx;}
});


test('预取期间离开日历或进入后台，迟到响应不能改写当前页面',async()=>{
  const n=network(),client=createClient({wxApi:n.wx,config,now:()=>1000});const home=client.setView({view:'home'});n.reply(0);await home;
  const prefetch=client.prefetchCalendar(),calendar=client.setView({view:'calendar'});
  await client.setView({view:'home'});n.reply(1);await Promise.all([prefetch,calendar]);assert.equal(client.getState().data.serverTime,now);assert.equal(n.calls.length,2);
  // A later failed prefetch is cancelled on app hide; its delayed success has no effect.
  client.stop();assert.equal(client.getState().loading,false);
});

test('展开半年记录不请求网络，返回和刷新保留展开数量，切换类型恢复首批',()=>{
  const data=fixture();
  for(let i=0;i<24;i++){
    const p=structuredClone(data.publications[0]),id=`expanded-${i}`,at=new Date(Date.parse('2026-10-10T01:00:00Z')-i*86400000).toISOString();
    p.id=`pub-${id}`;p.eventId=id;p.articleId=`article-${id}`;p.publishedAt=at;
    Object.assign(p.event,{id,publicationId:p.id});Object.assign(p.article,{id:p.articleId,eventId:id,publicationId:p.id});
    Object.assign(p.event.actions[0],{id:`action-${id}`,statementAt:at});
    data.events.push(structuredClone(p.event));data.articles.push(structuredClone(p.article));data.publications.push(p);
  }
  let reads=0;const definition=createRecordPage(),previous=(globalThis as any).getApp,previousWx=(globalThis as any).wx;
  const client={setView(){reads++;return Promise.resolve();},getState(){return {data,receivedAt:Date.now(),loading:false};},subscribe(fn:any){fn(this.getState());return()=>{};}};
  (globalThis as any).wx={};(globalThis as any).getApp=()=>({client});
  const page:any={...definition,data:structuredClone(definition.data),setData(patch:any,callback?:()=>void){Object.assign(this.data,patch);callback?.();}};
  try{
    page.onLoad({});page.onShow();assert.equal(page.data.recentTotal,28);assert.equal(page.data.recentRecords.length,10);
    page.moreRecords();assert.equal(page.data.recentRecords.length,20);assert.equal(reads,1);
    page.moveToMonth(1);assert.equal(page.data.recentRecords.length,20);
    page.onHide();page.onShow();assert.equal(page.data.recentRecords.length,20);
    page.redraw();assert.equal(page.data.recentRecords.length,20);
    page.moreRecords();page.moreRecords();assert.equal(page.data.recentRecords.length,28);assert.equal(page.data.recentLimit,30);assert.equal(page.data.recentHasMore,false);
    page.selectKind({currentTarget:{dataset:{value:'all'}}});assert.equal(page.data.recentRecords.length,28,'重复点击当前类型不折叠');
    page.selectKind({currentTarget:{dataset:{value:'banked_reset'}}});assert.equal(page.data.recentLimit,10);assert.equal(page.data.recentTotal,1);assert.equal(page.data.recentHasMore,false);
    page.selectKind({currentTarget:{dataset:{value:'automatic_reset'}}});assert.equal(page.data.recentTotal,27);assert.equal(page.data.recentRecords.length,10);
    page.moreRecords();page.moreRecords();assert.equal(page.data.recentRecords.length,27);
    assert.ok(page.data.recentRecords.every((r:any)=>r.kind==='automatic_reset'));
  }finally{page.onUnload();(globalThis as any).getApp=previous;(globalThis as any).wx=previousWx;}
});
