import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {PublicData,Publication,ActionKind} from '../src/lib/types';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {gatherEvidenceContext} from '../src/server/source-context';
import {statusTimelineModel} from '../src/lib/status-timeline';
const require=createRequire(import.meta.url);
const {selectedHomeStatus}=require('../miniprogram/utils/home-reset-status');
const {resetStateCards}=require('../miniprogram/utils/reset-state-cards');
const nativeTimeline=require('../miniprogram/utils/status-timeline');
const {statusPosterInput,createStatusPosterLayout}=require('../miniprogram/packages/poster/status-poster');
const at='2026-11-01T00:00:00Z',now='2026-11-01T01:00:00Z';
function dataFor(text:string):PublicData{
 const evidence={id:'qualifier-evidence',sourceId:'tibo-public',messageId:'qualifier-fixture',url:'https://x.com/thsottiaux/status/qualifier-fixture',text,hash:'qualifier-fixture',publishedAt:at,collectedAt:at,textOrigin:'original' as const,provenance:'archive' as const,contextComplete:true,historical:false};
 const d=buildAutomaticTemplate(gatherEvidenceContext(evidence,[evidence]))!;assert.ok(d?.actions.length);
 const event:Publication['event']={id:'qualifier-event',title:d.title,status:'published',version:1,evidenceIds:d.evidenceIds,actions:d.actions,publicationId:'qualifier-pub',updatedAt:at};
 const article:Publication['article']={id:'qualifier-article',eventId:event.id,title:d.title,summary:d.summary,translation:'',category:'reset',status:'published',version:1,evidenceIds:d.evidenceIds,publicationId:event.publicationId,publishedAt:at,updatedAt:at};
 const publication:Publication={id:event.publicationId,eventId:event.id,articleId:article.id,event,article,publishedAt:at,cutoffAt:at,reason:'synthetic qualifier regression',mode:'state_change'};
 return {serverTime:now,events:[event],articles:[article],publications:[publication],evidence:[evidence],sources:[],activities:[],notices:[],site:{name:'本地时间限定回归',description:'',version:1,autoPublish:false}};
}
for(const kind of ['automatic_reset','banked_reset'] as ActionKind[]){
 for(const [wording,qualifier,label] of [['in 2 hours','','距离预计安排'],['in about 2 hours','左右','距离预计时间（约）'],['within 2 hours','前','距离预计最晚时间']]){
  test(`${kind}: ${wording} preserves point/approximate/deadline in home, timeline and both posters`,()=>{
   const verb=kind==='automatic_reset'?'reset usage limits':'grant a banked reset';
   const data=dataFor(`We will ${verb} for all paid users ${wording}.`),action=data.events[0].actions[0];
   const card=selectedHomeStatus(data,kind);assert.equal(card.timeQualifier,qualifier);assert.equal(card.metricLabel,label);
   const shared=resetStateCards(data).cards.find((c:any)=>c.kind===kind);assert.equal(shared.metricLabel,label);assert.equal(/ 前$/.test(shared.time),qualifier==='前');
   const active={...action,actionId:action.id,eventId:data.events[0].id,publicationId:data.publications[0].id};
   const web=statusTimelineModel({status:'scheduled',active},now),native=nativeTimeline.statusTimelineModel({status:'scheduled',active},now);
   assert.equal(native.lead,web.lead);assert.equal(/最晚/.test(native.lead),qualifier==='前');assert.equal(/ 左右$/.test(native.note),qualifier==='左右');
   const input=statusPosterInput(data,kind);assert.equal(input.label,card.hero.label);assert.equal(/ 前$/.test(input.time),qualifier==='前');assert.equal(/ 左右$/.test(input.time),qualifier==='左右');
   for(const theme of ['precision','editorial']){const layout=createStatusPosterLayout(input,(s:string,n:number)=>s.length*n,theme);assert.ok(layout.commands.some((c:any)=>c.value===input.label));}
  });
 }
}
