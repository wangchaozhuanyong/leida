import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {BenefitAction,Evidence,Publication,PublicData} from '../src/lib/types';

const require=createRequire(import.meta.url);
const {activityModel}=require('../miniprogram/utils/model.js');
const {resetObservations}=require('../miniprogram/utils/reset-observations.js');
const now='2026-10-26T00:00:00.000Z';
const observedAt='2026-10-23T17:40:00.000Z';
function fixture():PublicData {
 return {events:[],articles:[],publications:[],evidence:[],notices:[],site:{name:'隔离活动验证',description:'',autoPublish:false,version:1},serverTime:now,
  sources:[{id:'activity-archive',name:'活动归档',status:'healthy',lastSuccessAt:now}],
  activities:[{id:'challenge-28',title:'隔离28天活动',startsOn:'2026-10-05',timezone:'America/Los_Angeles',days:28,rules:'每日公开资料',version:1,items:[]}]};
}
function observation(id:string,at=observedAt):Evidence {
 const date=new Date(at),collectedAt='2026-10-25T21:00:00.000Z';
 const stamp=`${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getUTCMonth()]} ${date.getUTCDate()}, ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')} UTC.`;
 const summary=`Third-party observation on ${stamp}`,url='https://codexlimits.com/reset-history';
 return {id,sourceId:'codexlimits-observations',messageId:`observed-codexlimits-${date.getTime()}`,url,text:`Usage reset landed\n${summary}`,publishedAt:at,collectedAt,hash:id,provenance:'archive',textOrigin:'archive_excerpt',contextComplete:false,historical:true,
  metadata:{sourceGroup:'codexlimits',category:'reset',benefitKind:'automatic_reset',referenceReset:{eventId:`codexlimits:automatic_reset:${at}`,occurredAt:at,snapshotAt:collectedAt,referenceUrl:url,summary}}};
}
function add(data:PublicData,id:string,options:{at?:string;actions?:BenefitAction[];evidence?:Evidence;day?:number;product?:boolean}={}):Publication {
 const at=options.at||observedAt,actions=options.actions||[];
 const event:Publication['event']={id:'event-'+id,title:id,status:'published',version:1,publicationId:id,evidenceIds:options.evidence?[options.evidence.id]:[],actions,updatedAt:now};
 const article:Publication['article']={id:'article-'+id,eventId:event.id,publicationId:id,status:'published',version:1,title:id,summary:'仅隔离夹具',translation:'',category:options.product?'product':'reset',evidenceIds:event.evidenceIds,publishedAt:now,updatedAt:now,sourcePublishedAt:at,publicationMode:actions.length?'state_change':'news_only'};
 const publication:Publication={id,eventId:event.id,articleId:article.id,event,article,publishedAt:now,cutoffAt:now,reason:'isolated activity priority',mode:article.publicationMode};
 data.events.push(structuredClone(event));data.articles.push(structuredClone(article));data.publications.push(publication);
 if(options.evidence)data.evidence.push(options.evidence);
 if(options.day)data.activities[0].items.push({day:options.day,eventId:event.id,articleId:article.id});
 return publication;
}
const action=(id:string,kind:BenefitAction['kind']='automatic_reset',at=observedAt):BenefitAction=>({id,kind,stage:'claimed_complete',scope:'public',eligibility:'公开',statementAt:at,evidenceIds:[]});

test('改进同日有未关联活动的来源观测时，主标签为重置并保留观测依据和原文入口',()=>{
 const data=fixture();add(data,'product',{product:true,day:19});const e=observation('observed');add(data,'observed',{evidence:e});
 const before=structuredClone(data),view=activityModel(data,'challenge-28',19);
 assert.equal(view.days[18].label,'重置');assert.equal(view.days[18].tone,'teal');assert.deepEqual(view.days[18].types.map((t:any)=>t.label),['额度重置','改进']);
 assert.equal(view.entries.length,2);assert.equal(view.entries[0].id,'observed');assert.equal(view.entries[0].stage,'来源观测');assert.equal(view.entries[0].timeLabel,'观测时间');assert.equal(view.entries[0].time,'2026-10-24 01:40');
 assert.equal(view.entries[0].path,'/pages/detail/index?publicationId=observed');assert.equal(view.entries[1].id,'product');
 assert.equal(view.days[20].label,'待公布','补采发生在第21天，不能将观测记到采集日');assert.deepEqual(data,before);
});

test('同日重置卡高于额度重置与改进，所有条目仍可打开，不再显示多项',()=>{
 const data=fixture();add(data,'product',{product:true,day:19});add(data,'observed',{evidence:observation('observed')});add(data,'card',{actions:[action('card','banked_reset')]});
 const view=activityModel(data,'challenge-28',19);
 assert.equal(view.days[18].label,'重置卡');assert.equal(view.days[18].tone,'violet');assert.deepEqual(view.entries.map((e:any)=>e.id),['card','observed','product']);
 assert.match(view.days[18].accessibility,/额度重置/);assert.match(view.days[18].accessibility,/重置卡/);assert.equal(view.recordedDays,1);
});

test('未关联的公开完成声明补入对应活动日；同一公开版本已有活动关联时不重复',()=>{
 const data=fixture();add(data,'reset',{actions:[action('reset')]});
 assert.equal(activityModel(data,'challenge-28',19).days[18].label,'重置');
 data.activities[0].items.push({day:19,eventId:'event-reset',articleId:'article-reset'});
 const view=activityModel(data,'challenge-28',19);assert.equal(view.entries.length,1);assert.equal(view.entries[0].stage,'发布者完成声明');
});

test('同一个发布保留跨日完成动作时按声明时间归日，不能全记到最后更新日期',()=>{
 const data=fixture();add(data,'two-days',{at:'2026-10-24T17:40:00.000Z',actions:[action('day19'),action('day20','automatic_reset','2026-10-24T17:40:00.000Z')]});
 const day19=activityModel(data,'challenge-28',19),day20=activityModel(data,'challenge-28',20);
 assert.equal(day19.days[18].label,'重置');assert.equal(day19.days[19].label,'重置');assert.equal(day19.entries[0].time,'2026-10-24 01:40');assert.equal(day20.entries[0].time,'2026-10-25 01:40');
 assert.equal(day19.entries[0].timeLabel,'声明时间');assert.equal(day19.entries.length,1);assert.equal(day20.entries.length,1);
});

test('按活动时区划分午夜边界；活动外的真实观测不混入28天',()=>{
 const data=fixture();
 for(const [id,at] of [['before','2026-10-05T06:59:00.000Z'],['day18','2026-10-23T06:59:00.000Z'],['day19','2026-10-23T07:00:00.000Z']] as const)add(data,id,{evidence:observation(id,at)});
 const view=activityModel(data,'challenge-28',19);
 assert.equal(view.days[17].label,'重置');assert.equal(view.days[18].label,'重置');assert.deepEqual(view.entries.map((e:any)=>e.id),['day19']);assert.equal(view.recordedDays,2);
 assert.equal(activityModel(data,'challenge-28',1).entries.length,0);
});

test('来源断网不清除已有观测，撤回、错误证明、未来和私人完成不能标为当天重置',()=>{
 const data=fixture();const valid=add(data,'valid',{evidence:observation('valid')});
 data.sources[0].status='failed';assert.equal(activityModel(data,'challenge-28',19).days[18].label,'重置');
 data.events.find(e=>e.id===valid.eventId)!.status='withdrawn';
 const forged=observation('forged');forged.text='无证明的重置传言';add(data,'forged',{evidence:forged});
 add(data,'private',{actions:[{...action('private'),scope:'private'}]});
 add(data,'future',{actions:[action('future','automatic_reset','2026-10-26T01:00:00.000Z')]});
 assert.equal(resetObservations(data).length,0);const view=activityModel(data,'challenge-28',19);assert.equal(view.entries.length,0);assert.equal(view.days[18].label,'待核对');
});

test('没有完成事实的未关联预告、取消和待核对消息，不填充成重置完成',()=>{
 const data=fixture();add(data,'promise',{actions:[{...action('promise'),stage:'promised'}]});add(data,'cancelled',{actions:[{...action('cancelled'),stage:'cancelled'}]});
 add(data,'pending',{day:19});const view=activityModel(data,'challenge-28',19);
 assert.equal(view.entries.length,1);assert.equal(view.days[18].label,'重置消息');assert.equal(view.entries[0].stage,'完成情况待核对');
});

test('重复采集同一个观测不会生成重复条目，纯改进日仍显示改进',()=>{
 const data=fixture(),e=observation('first');add(data,'observed',{evidence:e});add(data,'duplicate',{evidence:{...e,id:'second'}});
 const view=activityModel(data,'challenge-28',19);assert.equal(view.entries.length,1);assert.equal(view.days[18].label,'重置');
 add(data,'product',{day:18,product:true});assert.equal(activityModel(data,'challenge-28',18).days[17].label,'改进');
});
