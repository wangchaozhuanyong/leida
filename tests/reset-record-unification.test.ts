import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {BenefitAction,Evidence,Publication,PublicData} from '../src/lib/types';
import {resetObservationSources as serverObservationSources} from '../src/lib/reset-observations';
const require=createRequire(import.meta.url);
const {observationDayGroups,observationSources}=require('../miniprogram/utils/reset-records.js');
const {recordCalendar}=require('../miniprogram/utils/record-calendar.js');
const {activityModel,homeNewsGroups,publicActions}=require('../miniprogram/utils/model.js');
const {resetObservations}=require('../miniprogram/utils/reset-observations.js');
const {selectedHomeStatus}=require('../miniprogram/utils/home-reset-status.js');
const {statusPosterInput,statusPosterAvailable}=require('../miniprogram/packages/poster/status-poster.js');
const now='2026-10-26T13:30:00.000Z';
function fixture():PublicData{return {events:[],articles:[],publications:[],evidence:[],notices:[],sources:[],serverTime:now,
 site:{name:'隔离一致性验证',description:'',autoPublish:false,version:1},
 activities:[{id:'challenge',title:'28天',startsOn:'2026-10-05',timezone:'America/Los_Angeles',days:28,rules:'仅测试',version:1,items:[]}]};}
function evidence(source:'limits'|'archive'|'reference',at:string):Evidence{
 const id=source+at,summary='Codex usage limits have been reset. Check your limits.';
 const base:Evidence={id,sourceId:'',messageId:'',url:'',text:summary,publishedAt:at,collectedAt:now,hash:id,contextComplete:false,historical:false,provenance:'archive',textOrigin:'archive_excerpt'};
 if(source==='limits'){
  const d=new Date(at),text=`Third-party observation on Oct ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC.`,url='https://codexlimits.com/reset-history';
  return {...base,sourceId:'codexlimits-observations',messageId:'observed-codexlimits-'+d.getTime(),url,text:'Usage reset landed\n'+text,
   metadata:{sourceGroup:'codexlimits',category:'reset',benefitKind:'automatic_reset',referenceReset:{referenceUrl:url,eventId:'codexlimits:automatic_reset:'+at,occurredAt:at,snapshotAt:now,summary:text}}};
 }
 const post=String((BigInt(Date.parse(at))-1288834974657n)<<22n),url='https://x.com/thsottiaux/status/'+post;
 return {...base,url,messageId:'observed-'+post,sourceId:source==='archive'?'reset-archive':'aiplanwatch-reference',
  metadata:source==='archive'?{sourceGroup:'codex-resets',category:'reset'}:{sourceGroup:'aiplanwatch',category:'reset',benefitKind:'automatic_reset',referenceReset:{eventId:id,occurredAt:at,snapshotAt:now,summary,referenceUrl:'https://raw.githubusercontent.com/gdutxiaoxu/codex-reset-radar/master/data/latest.json'}}};
}
function publish(data:PublicData,id:string,at:string,ev?:Evidence,actions:BenefitAction[]=[],day?:number){
 const event:Publication['event']={id:'event-'+id,title:id,status:'published',version:1,updatedAt:now,publicationId:id,evidenceIds:ev?[ev.id]:[],actions};
 const article:Publication['article']={id:'article-'+id,eventId:event.id,publicationId:id,title:id,summary:'隔离测试',translation:'',category:'reset',status:'published',version:1,evidenceIds:event.evidenceIds,publishedAt:now,updatedAt:now,sourcePublishedAt:at,publicationMode:actions.length?'state_change':'news_only'};
 const p:Publication={id,eventId:event.id,articleId:article.id,event,article,publishedAt:now,cutoffAt:now,reason:'isolated test',mode:article.publicationMode};
 data.events.push(structuredClone(event));data.articles.push(structuredClone(article));data.publications.push(p);if(ev)data.evidence.push(ev);
 if(day)data.activities[0].items.push({day,eventId:event.id,articleId:article.id});return p;
}
function add(data:PublicData,source:'limits'|'archive'|'reference',at:string,day?:number){return publish(data,source+at,at,evidence(source,at),[],day);}
function action(id:string,at:string,kind:BenefitAction['kind']='automatic_reset',stage:BenefitAction['stage']='claimed_complete'):BenefitAction{return {id,kind,stage,statementAt:at,evidenceIds:[],eligibility:'公开',scope:'public'};}

test('26日两条来源跨过活动午夜，三处只展示一个北京时间观测汇总，所有依据可追溯',()=>{
 const data=fixture();add(data,'limits','2026-10-26T06:08:00.000Z',21);add(data,'reference','2026-10-26T07:00:00.000Z',22);const before=structuredClone(data);
 const calendar=recordCalendar(data),activity=activityModel(data,'challenge',21),news=homeNewsGroups(data);
 assert.equal(calendar.selectedItems.length,1);assert.equal(calendar.recentTotal,1);assert.equal(calendar.observationEvidenceCount,2);assert.equal(calendar.observedDateCount,1);
 assert.equal(calendar.selectedItems[0].time,'14:08');assert.equal(calendar.selectedItems[0].timeRange,'14:08–15:00');assert.equal(calendar.selectedItems[0].sourceCount,2);
 assert.deepEqual(calendar.selectedItems[0].sources.map((s:any)=>s.time),['2026-10-26 14:08','2026-10-26 15:00']);
 assert.equal(activity.days[20].label,'重置');assert.equal(activity.days[21].label,'观测补充');assert.equal(activity.entries.length,1);
 const supplement=activityModel(data,'challenge',22);assert.equal(supplement.entries.length,1);assert.equal(supplement.entries[0].types[0].completed,false);assert.match(supplement.entries[0].path,/date=2026-10-26/);assert.match(supplement.entries[0].summary,/不据此另计一次重置/);
 assert.deepEqual(activity.entries[0].sources,calendar.selectedItems[0].sources);assert.match(activity.entries[0].summary,/不据此认定又重置一次/);
 assert.equal(activity.selectedBeijingRange,'2026-10-25 15:00 — 2026-10-26 15:00（不含）');
 assert.equal(news.length,1);assert.equal(news[0].observation.id,calendar.selectedItems[0].id);assert.equal(news[0].updates.length,2);
 const home=selectedHomeStatus(data,'automatic_reset'),poster=statusPosterInput(data);
 assert.equal(home.clockAt,calendar.selectedItems[0].at);assert.equal(home.hero.timeLabel,'当日最早观测');assert.match(home.hero.footnote,/14:08–15:00/);
 assert.match(home.sharePath,/^\/pages\/schedule\/index\?date=2026-10-26&kind=automatic_reset&revision=/);
 assert.equal(poster.statementAt,home.clockAt);assert.equal(poster.sharePath,home.sharePath);assert.equal(poster.codePublicationId,'');assert.match(poster.nextNote,/轮次仍待核对/);assert.equal(statusPosterAvailable(poster,data),true);
 assert.deepEqual(publicActions(data),[]);assert.equal(resetObservations(data).length,2);assert.deepEqual(data,before);
});

test('同日新来源不会重启计时，依据变化使旧海报失效；新日期独立开始计时',()=>{
 const data=fixture();add(data,'limits','2026-10-25T06:08:00.000Z');
 const first=selectedHomeStatus(data,'automatic_reset'),poster=statusPosterInput(data);
 add(data,'archive','2026-10-25T06:40:00.000Z');
 assert.equal(selectedHomeStatus(data,'automatic_reset').clockAt,first.clockAt);assert.equal(statusPosterAvailable(poster,data),false);
 add(data,'limits','2026-10-26T06:08:00.000Z');assert.equal(selectedHomeStatus(data,'automatic_reset').clockAt,'2026-10-26T06:08:00.000Z');
});

test('23和24日的多来源合列但不能跨日合并；16天待核对、17天预告仍不是完成',()=>{
 const data=fixture();for(const date of ['22','23']){add(data,'archive',`2026-10-${date}T17:00:00.000Z`);add(data,'limits',`2026-10-${date}T17:40:00.000Z`);}
 publish(data,'promise','2026-10-22T06:55:00.000Z',undefined,[action('promise','2026-10-22T06:55:00.000Z','automatic_reset','promised')],17);
 const view=recordCalendar(data,{recentLimit:20}),activity=activityModel(data,'challenge',17);
 assert.equal(view.recentTotal,2);assert.equal(view.observationEvidenceCount,4);assert.equal(view.days.find((d:any)=>d.date==='2026-10-23').count,1);
 assert.equal(view.days.find((d:any)=>d.date==='2026-10-24').count,1);assert.equal(recordCalendar(data,{date:'2026-10-21'}).selectedItems.length,0);assert.equal(recordCalendar(data,{date:'2026-10-22'}).selectedItems.length,0);
 assert.equal(activity.days[15].label,'待核对');assert.equal(activity.days[16].label,'重置预告');assert.equal(activity.days[17].label,'重置');assert.equal(activity.days[18].label,'重置');
});

test('同一来源同日两条独立记录和两次明确完成不能被一天一次规则抹掉',()=>{
 const data=fixture();add(data,'limits','2026-10-26T06:08:00.000Z');add(data,'limits','2026-10-26T08:08:00.000Z');
 assert.equal(observationDayGroups(data).length,2);assert.equal(recordCalendar(data).recentTotal,2);
 add(data,'archive','2026-10-26T08:08:00.000Z');
 assert.equal(observationDayGroups(data).length,2);assert.equal(recordCalendar(data).recentTotal,2);
 assert.equal(selectedHomeStatus(data,'automatic_reset').hero.timeLabel,'本条观测时间');assert.match(selectedHomeStatus(data,'automatic_reset').hero.footnote,/本条来源记录/);
 const complete=fixture();publish(complete,'first','2026-10-26T03:00:00.000Z',undefined,[action('first','2026-10-26T03:00:00.000Z')]);publish(complete,'second','2026-10-26T09:00:00.000Z',undefined,[action('second','2026-10-26T09:00:00.000Z')]);
 assert.equal(recordCalendar(complete).confirmedCount,2);assert.equal(recordCalendar(complete).recentTotal,2);
});

test('相同分钟的两个来源依据仍完整保留，重复采集不增加来源数；撤回来源不参与汇总',()=>{
 const data=fixture(),at='2026-10-26T06:08:00.000Z';const p=add(data,'limits',at);add(data,'archive',at);
 data.evidence.push({...data.evidence[0],id:'duplicate',collectedAt:now});
 assert.equal(observationSources(data).length,2);assert.equal(observationDayGroups(data)[0].sources.length,2);assert.equal(recordCalendar(data).recentTotal,1);
 assert.deepEqual(observationSources(data),serverObservationSources(data));
 assert.match(selectedHomeStatus(data,'automatic_reset').hero.footnote,/2个来源/);assert.equal(homeNewsGroups(data)[0].observation.sourceCount,2);
 data.events.find(e=>e.id===p.eventId)!.status='withdrawn';assert.equal(observationSources(data).length,1);assert.equal(recordCalendar(data).selectedItems[0].sourceCount,1);
});

test('夏令时切换日对应北京时间范围为23小时，不使用固定时差挪动日期',()=>{
 const data=fixture();data.activities[0].startsOn='2026-03-07';
 assert.equal(activityModel(data,'challenge',2).selectedBeijingRange,'2026-03-08 16:00 — 2026-03-09 15:00（不含）');
});
