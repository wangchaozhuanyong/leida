import test from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import assert from 'node:assert/strict';
import type {BenefitAction,Evidence,Publication,PublicData} from '../src/lib/types';
import {recordCalendar,completedRecords} from '../miniprogram/utils/record-calendar';
import {resetObservations} from '../src/lib/reset-observations';
import {publicActions} from '../src/lib/public-facts';
import {referenceResetPoints} from '../src/lib/reference-cadence';

const now='2026-10-24T04:00:00.000Z',oldAt='2026-10-22T17:00:00.000Z',newAt='2026-10-23T17:40:00.000Z';
const collectedAt='2026-10-24T02:00:00.000Z',limitsUrl='https://codexlimits.com/reset-history';
function empty():PublicData{return {site:{name:'隔离日历验证',description:'',autoPublish:false,version:1},serverTime:now,events:[],articles:[],publications:[],evidence:[],notices:[],activities:[],sources:[]};}
function limits(at=newAt,id='limits'):Evidence {
  const date=new Date(at),stamp=`${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getUTCMonth()]} ${date.getUTCDate()}, ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')} UTC.`,summary=`Third-party observation on ${stamp}`;
  return {id,sourceId:'codexlimits-observations',messageId:`observed-codexlimits-${date.getTime()}`,url:limitsUrl,text:`Usage reset landed\n${summary}`,publishedAt:at,collectedAt,contextComplete:false,historical:false,hash:id,provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codexlimits',category:'reset',benefitKind:'automatic_reset',referenceReset:{referenceUrl:limitsUrl,eventId:`codexlimits:automatic_reset:${at}`,occurredAt:at,snapshotAt:collectedAt,summary}}};
}
function archive(at=oldAt,id='archive'):Evidence{return {id,sourceId:'reset-archive',messageId:'observed-2113162413008884099',url:'https://x.com/thsottiaux/status/2113162413008884099',text:'Codex 使用限额已重置。查看你的限额。',publishedAt:at,collectedAt,contextComplete:false,historical:false,hash:id,provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'reset'}};}
function addPublication(data:PublicData,id:string,at:string,actions:BenefitAction[],evidence:Evidence[]=[],eventId=`event-${id}`):Publication {
  const mode=actions.length?'state_change' as const:'news_only' as const;
  const event:Publication['event']={id:eventId,title:id,version:1,status:'published',actions,evidenceIds:evidence.map(e=>e.id),publicationId:id,updatedAt:at};
  const article:Publication['article']={id:`article-${id}`,eventId,publicationId:id,title:`隔离资料 ${id}`,summary:'仅测试日历展示，不代表个人账户到账',translation:'',category:'reset',status:'published',version:1,evidenceIds:evidence.map(e=>e.id),publishedAt:at,sourcePublishedAt:evidence[0]?.publishedAt??at,updatedAt:at,publicationMode:mode};
  const p:Publication={id,eventId,articleId:article.id,event,article,mode,publishedAt:at,cutoffAt:at,reason:'isolated calendar regression'};
  data.events=data.events.filter(e=>e.id!==eventId).concat(structuredClone(event));data.articles.push(structuredClone(article));data.publications.push(p);data.evidence.push(...evidence.filter(e=>!data.evidence.some(existing=>existing.id===e.id)));
  return p;
}
function addObservation(data:PublicData,e=limits(),id=`p-${e.id}`){return addPublication(data,id,e.collectedAt,[],[e]);}
function addCompletion(data:PublicData,id='confirmed',at='2026-10-23T18:10:00.000Z',kind:BenefitAction['kind']='automatic_reset',evidence:Evidence[]=[],actionEvidenceIds=evidence.map(e=>e.id),eventId=`event-${id}`){return addPublication(data,id,at,[{id:`action-${id}`,kind,stage:'claimed_complete',scope:'public',statementAt:at,eligibility:'公开',evidenceIds:actionEvidenceIds}],evidence,eventId);}
function fixture(){const data=empty();addObservation(data,archive());addObservation(data);return data;}

test('三条来源观测覆盖两个日期，条数与日期数分别表达且最近列表保留全部依据',()=>{
 const data=fixture();addObservation(data,limits('2026-10-22T17:10:00.000Z','old-limits'));
 const view=recordCalendar(data);
 assert.equal(view.observedCount,3);assert.equal(view.observedDateCount,2);assert.equal(view.days.filter(d=>d.observed).length,2);
 assert.equal(view.days.find(d=>d.date==='2026-10-23')!.observedCount,2);
 assert.equal(view.recentRecords.length,3);assert.deepEqual(view.recentRecords.map(r=>r.time),['01:40','01:10','01:00']);
 assert.ok(view.recentRecords.every(r=>r.evidenceType==='observed'&&r.timeLabel==='观测时间'&&r.recordTitle==='额度重置'));
 assert.equal(view.recentRecords[0].path,view.selectedItems[0].path);
});

test('半年列表首屏十条，混排额度、重置卡和观测；切月不丢近期记录，切类型同步筛选',()=>{
 const data=fixture();addCompletion(data,'banked-recent','2026-10-23T19:00:00.000Z','banked_reset');
 for(let i=0;i<12;i++)addCompletion(data,'history-'+i,new Date(Date.parse('2026-10-22T12:00:00Z')-i*3600000).toISOString());
 const before=structuredClone(data),view=recordCalendar(data);
 assert.equal(view.recentRecords.length,10);assert.equal(view.recentRecords[0].recordTitle,'重置卡发放');assert.equal(view.recentRecords[0].timeLabel,'声明时间');
 assert.equal(view.recentTotal,15);assert.equal(view.recentHasMore,true);
 const expanded=recordCalendar(data,{recentLimit:20});
 assert.equal(expanded.recentRecords.length,15);assert.equal(expanded.recentHasMore,false);
 assert.equal(new Set(expanded.recentRecords.map(r=>r.id)).size,15);
 assert.deepEqual(expanded.recentRecords.slice(0,10),view.recentRecords);
 assert.deepEqual(expanded.days,view.days,'展开列表不改变日历和统计');
 assert.equal(view.recentRecords.filter(r=>r.evidenceType==='observed').length,2);
 assert.ok(view.recentRecords.every((r,i,all)=>!i||Date.parse(all[i-1].at)>=Date.parse(r.at)));
 assert.deepEqual(recordCalendar(data,{month:'2026-09'}).recentRecords,view.recentRecords);
 const banked=recordCalendar(data,{kind:'banked_reset'});assert.equal(banked.recentRecords.length,1);assert.equal(banked.recentRecords[0].kind,'banked_reset');
 assert.ok(recordCalendar(data,{kind:'automatic_reset'}).recentRecords.every(r=>r.kind==='automatic_reset'));
 assert.deepEqual(data,before);
});

test('逐批展开可以到达半年起点，半年外资料保留但不进入当前展示',()=>{
 const data=empty();
 for(let i=0;i<27;i++)addCompletion(data,'six-month-'+i,new Date(Date.parse('2026-10-23T12:00:00Z')-i*6*86400000).toISOString(),i%3?'automatic_reset':'banked_reset');
 addCompletion(data,'boundary','2026-04-23T16:00:00.000Z');
 addCompletion(data,'outside','2026-04-23T15:59:59.000Z');
 addObservation(data);
 const before=structuredClone(data),first=recordCalendar(data),second=recordCalendar(data,{recentLimit:20}),last=recordCalendar(data,{recentLimit:30});
 assert.deepEqual([first.recentRecords.length,second.recentRecords.length,last.recentRecords.length],[10,20,29]);
 assert.equal(last.recentTotal,29);assert.equal(last.recentHasMore,false);
 assert.equal(last.recentRecords.at(-1)!.id,'action-boundary');
 assert.deepEqual(second.recentRecords.slice(0,10),first.recentRecords);
 assert.deepEqual(last.recentRecords.slice(0,20),second.recentRecords);
 assert.equal(new Set(last.recentRecords.map(r=>r.id)).size,29);
 assert.equal(last.recentRecords.some(r=>r.id==='action-outside'),false);
 assert.equal(data.events.some(e=>e.id==='event-outside'),true);
 for(const limit of [-1,0,NaN,Infinity,1.5])assert.equal(recordCalendar(data,{recentLimit:limit}).recentRecords.length,10);
 assert.deepEqual(data,before);
});

test('23日01:00与24日01:40独立按北京时间归档，默认定位最近观测',()=>{
  const data=fixture(),before=structuredClone(data),latest=recordCalendar(data);
  assert.equal(resetObservations(data).length,2);assert.equal(latest.selected,'2026-10-24');assert.equal(latest.recentDate,'2026-10-24');
  assert.equal(latest.selectedItems[0].time,'01:40');assert.equal(latest.selectedItems[0].at,newAt);assert.equal(latest.selectedItems[0].evidenceType,'observed');assert.equal(latest.selectedItems[0].statusLabel,'来源观测');assert.equal(latest.selectedItems[0].sourceName,'Codex Limits');
  assert.equal(latest.selectedItems[0].path,'/pages/detail/index?publicationId=p-limits');assert.equal(latest.selectedItems[0].href,'/events/event-p-limits?version=p-limits');
  const older=recordCalendar(data,{date:'2026-10-23'});assert.equal(older.selectedItems[0].time,'01:00');assert.equal(older.selectedItems[0].sourceName,'Codex Resets');
  assert.equal(latest.confirmedCount,0);assert.equal(latest.observedCount,2);assert.equal(latest.automaticCount,2);assert.equal(latest.bankedCount,0);
  assert.deepEqual(completedRecords(data),[]);assert.deepEqual(publicActions(data),[]);assert.deepEqual(referenceResetPoints(data),[]);assert.deepEqual(data,before);
});

test('日标记分别记录确认与观测，同日观测不会伪装第二个完成标记',()=>{
  const data=fixture();addCompletion(data,'banked','2026-10-23T18:10:00.000Z','banked_reset');
  const view=recordCalendar(data),day=view.days.find(d=>d.date==='2026-10-24')!;
  assert.equal(day.count,2);assert.equal(day.confirmedCount,1);assert.equal(day.observedCount,1);assert.equal(day.observed,true);
  assert.equal(day.confirmedAutomatic,false);assert.equal(day.confirmedBanked,true);assert.equal(day.automatic,true);assert.equal(day.banked,true);
  assert.equal(view.selectedConfirmedCount,1);assert.equal(view.selectedObservedCount,1);assert.equal(view.confirmedCount,1);assert.equal(view.observedCount,2);
});

test('类型筛选只改变所选条目与日标记，月摘要仍统计全类型条数',()=>{
  const data=fixture();addCompletion(data,'banked','2026-10-22T18:10:00.000Z','banked_reset');
  const banked=recordCalendar(data,{kind:'banked_reset'}),automatic=recordCalendar(data,{kind:'automatic_reset'});
  assert.equal(banked.selected,'2026-10-23');assert.equal(banked.selectedItems.length,1);assert.equal(banked.selectedItems[0].evidenceType,'confirmed');assert.equal(banked.selectedObservedCount,0);
  assert.ok(banked.days.every(d=>!d.observed));assert.equal(banked.confirmedCount,1);assert.equal(banked.observedCount,2);assert.equal(banked.automaticCount,2);assert.equal(banked.bankedCount,1);
  assert.equal(automatic.selected,'2026-10-24');assert.equal(automatic.selectedConfirmedCount,0);assert.equal(automatic.selectedObservedCount,1);
  assert.equal(recordCalendar(data,{month:'2026-09'}).observedCount,0);
});

test('严格观测合同拒绝来源伪造、未来、缺证明、错误时间和重置卡伪投影',()=>{
  const mutations:Array<(d:PublicData)=>void>=[
    d=>{d.evidence[0].sourceId='manual';},d=>{d.evidence[0].metadata=undefined;},
    d=>{d.evidence[0].text='重置似乎完成了';},d=>{d.evidence[0].publishedAt='2026-10-24T05:00:00.000Z';},
    d=>{d.evidence[0].collectedAt='2026-10-24T05:00:00.000Z';},d=>{d.evidence[0].publishedAt='invalid';},
    d=>{d.evidence[0].metadata!.benefitKind='banked_reset';},d=>{d.publications[0].publishedAt='2026-10-24T05:00:00.000Z';},
    d=>{d.publications[0].article.evidenceIds=[];},d=>{d.publications=[];},
  ];
  for(const mutate of mutations){const data=empty();addObservation(data);mutate(data);const view=recordCalendar(data);assert.equal(view.observedCount,0);assert.equal(view.selectedItems.length,0);assert.equal(view.bankedCount,0);}
});

test('观测发布或当前事件被撤回、合并时条目、计数和标记同步撤下',()=>{
  const mutations:Array<(d:PublicData)=>void>=[d=>{d.events[0].status='withdrawn';},d=>{d.events[0].status='merged';},d=>{d.articles[0].status='withdrawn';},d=>{d.publications[0].event.status='withdrawn';},d=>{d.publications[0].article.status='withdrawn';}];
  for(const mutate of mutations){const data=empty();addObservation(data);mutate(data);const view=recordCalendar(data);assert.equal(view.observedCount,0);assert.equal(view.selectedObservedCount,0);assert.ok(view.days.every(d=>!d.observed&&d.observedCount===0));}
});

test('半年边界按北京时间保留首日零点观测并排除前一分钟',()=>{
  const data=empty();addObservation(data,limits('2026-04-23T16:00:00.000Z','boundary'));addObservation(data,limits('2026-04-23T15:59:00.000Z','outside'));
  const view=recordCalendar(data,{month:'2026-04'});assert.equal(view.start,'2026-04-24');assert.equal(view.selected,'2026-04-24');assert.equal(view.observedCount,1);assert.equal(view.selectedItems[0].time,'00:00');assert.equal(view.selectedItems[0].path,'/pages/detail/index?publicationId=p-boundary');
});

test('重复采集和多来源同一观测只呈现一条，输入快照不修改',()=>{
  const data=empty(),one=limits();addObservation(data,one);addObservation(data,{...one,id:'limits-repeat'},'p-repeat');addObservation(data,archive(newAt,'archive-same'));
  const before=structuredClone(data),view=recordCalendar(data);
  assert.equal(resetObservations(data).length,1);assert.equal(view.observedCount,1);assert.equal(view.selectedItems.length,1);assert.equal(view.days.find(d=>d.date==='2026-10-24')!.count,1);assert.deepEqual(data,before);
});

test('后续完成动作直接引用观测证据时仅显示确认记录，原观测事实不改写',()=>{
  const data=empty(),e=limits();addObservation(data,e);addCompletion(data,'confirmed','2026-10-24T03:00:00.000Z','automatic_reset',[],[e.id]);
  const before=structuredClone(data),view=recordCalendar(data);assert.equal(view.selectedItems.length,1);assert.equal(view.selectedItems[0].id,'action-confirmed');assert.equal(view.selectedItems[0].evidenceType,'confirmed');assert.equal(view.observedCount,0);assert.equal(view.confirmedCount,1);
  assert.equal(resetObservations(data).length,1);assert.equal(data.publications[0].event.actions.length,0);assert.deepEqual(data,before);
});

test('同事件完成发布正文引用观测但动作未直接引用时仍独立展示',()=>{
  const data=empty(),e=limits(),observed=addObservation(data,e);addCompletion(data,'confirmed','2026-10-24T03:00:00.000Z','automatic_reset',[e],[],observed.eventId);
  const view=recordCalendar(data);assert.equal(view.selectedItems.length,2);assert.equal(view.confirmedCount,1);assert.equal(view.observedCount,1);assert.equal(view.selectedItems[0].path,'/pages/detail/index?publicationId=confirmed');
});

test('同事件新发布保留旧完成动作并引用新观测时旧动作不吞掉新观测',()=>{
  const data=empty(),old=addCompletion(data,'older-completed','2026-10-22T17:05:00.000Z');
  addPublication(data,'newer-observation','2026-10-24T02:00:00.000Z',structuredClone(old.event.actions),[limits()],old.eventId);
  const before=structuredClone(data),view=recordCalendar(data);
  assert.equal(publicActions(data)[0].publication.id,'newer-observation','当前发布保留了前一轮完成动作');
  assert.equal(view.confirmedCount,1);assert.equal(view.observedCount,1);assert.equal(view.automaticCount,2);
  assert.equal(view.selected,'2026-10-24');assert.equal(view.selectedItems.length,1);assert.equal(view.selectedItems[0].evidenceType,'observed');assert.equal(view.selectedItems[0].at,newAt);
  const older=recordCalendar(data,{date:'2026-10-23'});assert.equal(older.selectedConfirmedCount,1);assert.equal(older.selectedObservedCount,0);assert.equal(older.selectedItems[0].id,'action-older-completed');
  assert.deepEqual(data,before);
});

test('仅同事件ID、同日或相近时间均不推断同轮确认，仍是独立观测',()=>{
  for(const sameEvent of [false,true]){
    const data=empty(),observed=addObservation(data);addCompletion(data,'unlinked','2026-10-23T17:41:00.000Z','automatic_reset',[],[],sameEvent?observed.eventId:'event-unlinked');
    const view=recordCalendar(data);assert.equal(view.selectedItems.length,2);assert.equal(view.confirmedCount,1);assert.equal(view.observedCount,1);assert.equal(view.automaticCount,2);
  }
});

test('另一种福利即使引用观测证据也不吞掉额度观测',()=>{
  const data=empty(),e=limits();addObservation(data,e);addCompletion(data,'banked','2026-10-24T03:00:00.000Z','banked_reset',[],[e.id]);
  const view=recordCalendar(data);assert.equal(view.confirmedCount,1);assert.equal(view.observedCount,1);assert.equal(view.bankedCount,1);assert.equal(view.automaticCount,1);
});

test('完成引用重复来源组的另一条证据时仍能去重，而无效证据不能供关系',()=>{
  const data=empty(),a=archive(newAt,'a-source'),b=limits(newAt,'z-source');addObservation(data,a);addObservation(data,b);
  assert.equal(resetObservations(data)[0].evidenceId,a.id);addCompletion(data,'confirmed','2026-10-24T03:00:00.000Z','automatic_reset',[],[b.id]);
  assert.equal(recordCalendar(data).observedCount,0);
  data.evidence.find(e=>e.id===b.id)!.metadata=undefined;
  assert.equal(recordCalendar(data).observedCount,1,'未通过验证的被引用证据不能吞掉另一条有效观测');
});

test('未完成、撤回或未来完成不能提前移除观测，完成撤回后观测恢复显示',()=>{
  for(const mutate of [
    (d:PublicData,p:Publication)=>{p.event.actions[0].stage='promised';},
    (d:PublicData,p:Publication)=>{d.events.find(e=>e.id===p.eventId)!.status='withdrawn';},
    (d:PublicData,p:Publication)=>{p.event.actions[0].statementAt='2026-10-24T05:00:00.000Z';},
  ]){const data=empty(),e=limits();addObservation(data,e);const p=addCompletion(data,'confirmed','2026-10-24T03:00:00.000Z','automatic_reset',[],[e.id]);mutate(data,p);const view=recordCalendar(data);assert.equal(view.confirmedCount,0);assert.equal(view.observedCount,1);}
});

test('同一观测多版本的普通列表入口选当前版本，旧分享仍能打开且保留补充提示',()=>{
 const data=empty(),e=limits(),old=addObservation(data,e,'old');
 const newer=structuredClone(old);newer.id='current';newer.publishedAt='2026-10-24T03:00:00.000Z';newer.article.publicationId=newer.id;
 const extra={...e,id:'supplement',collectedAt:'2026-10-24T02:20:00.000Z'};data.evidence.push(extra);newer.article.evidenceIds.push(extra.id);
 data.publications.push(newer);data.articles[0]={...newer.article};data.events[0].publicationId=newer.id;
 assert.equal(resetObservations(data)[0].publicationId,'current');assert.equal(recordCalendar(data).selectedItems[0].path,'/pages/detail/index?publicationId=current');
 const mini=require('../miniprogram/utils/model.js');const native=require('../miniprogram/utils/reset-observations.js');
 assert.deepEqual(native.resetObservations(data),resetObservations(data));
 const detail=mini.resolveDetail(data,{publicationId:'old'});assert.equal(detail.isOld,true);assert.equal(detail.observationSourceUpdate,true);assert.equal(detail.publicationId,'old');
 newer.article.evidenceIds=[];assert.equal(mini.resolveDetail(data,{publicationId:'old'}).observationSourceUpdate,false);
});
