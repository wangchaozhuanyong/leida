import test from 'node:test';
import assert from 'node:assert/strict';
import type {Evidence,Source} from '../src/lib/types';
import {gatherEvidenceContext,evidenceBenefitClaims} from '../src/server/source-context';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
const known='2026-10-18T02:00:00.000Z';
const timeline:Source={id:'tibo-public',name:'Saved public originals',kind:'timeline',url:'https://api.fxtwitter.com/2/profile/thsottiaux/statuses',enabled:true,validated:true,status:'healthy',intervalMinutes:10,version:1};
const calendar:Source={...timeline,id:'activity-archive',kind:'activity',url:'https://codex-resets.com/tibo-28'};
function fixture():Evidence[]{
 const original=(id:string,messageId:string,text:string,publishedAt:string,parentId?:string):Evidence=>({id,sourceId:timeline.id,messageId,url:`https://x.com/thsottiaux/status/${messageId}`,text,publishedAt,collectedAt:known,hash:id,historical:true,contextComplete:false,provenance:'archive',textOrigin:'original',metadata:{sourceGroup:'fxembed:thsottiaux'},...(parentId?{parentId}:{})});
 return [
  original('done','2110618732666257557','Done and dusted','2026-10-15T06:28:13.000Z','2110595554036400151'),
  original('landing','2110595554036400151','Landing within the next 2 hours','2026-10-15T04:56:07.000Z','2110595484180214059'),
  original('day10','2110595484180214059','The reports of my reset button being lost are greatly exaggerated\n\nDay 10/ Reset','2026-10-15T04:55:51.000Z'),
  original('product-root','2106610099720720811','All right, we’re locking in. Only things being worked on are simplifications, more efficiency for more usage, groundbreaking features or new models.\n\nSometimes you have to invest ahead of the curve, but feedback is clear that you all want things to get simpler. On it.','2026-10-04T04:59:21.000Z'),
  original('rule','2106845241357824205','Over the next 28 days, each day we’ll either ship one thing that is a clear improvement and relevant for most codex/work users or ship a full reset. Let the improvements begin.','2026-10-04T20:33:43.000Z','2106610099720720811'),
  {...original('day1','2107158998495748264','Day 1/\n\nWe have optimized the default speed to be ~50% faster across GPT-6 Astra and GPT-6.1 Sol through the subscription across all our products and partners using Sign in With ChatGPT (including OpenCode, Pi, Amp, Devin, ...).\n\nNo changes needed on your end and this should be felt within the next two hours.','2026-10-05T17:20:29.000Z','2106845241357824205'),contextComplete:true},
  {...original('calendar','2107548725359104441','OpenAI API 的付费使用层级从五档减为三档：Build、Launch 和 Grow。新的最高档 Grow 现在累计 API 付费满 $500 即可达到，此前最高档需要 $1,000。','2026-10-06T19:09:07.144Z'),sourceId:calendar.id,textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'product',activityDay:2,activity:{id:'challenge-28',title:'Tibo 的 28 天挑战',startsOn:'2026-10-05',days:28,timezone:'America/Los_Angeles',rules:'每天改进或完整重置'}}},
 ];
}
function announcement(){
 const rows=fixture().filter(e=>!['done','landing','day10'].includes(e.id));
 const day:Evidence={...rows[0],id:'day13',messageId:'2111492673890824348',url:'https://x.com/thsottiaux/status/2111492673890824348',text:'Day 13/ Le limit reset https://t.co/zXd2DIH5xf',parentId:undefined,publishedAt:'2026-10-17T16:20:57.000Z',historical:false,contextComplete:false};
 const reply:Evidence={...day,id:'landing13',messageId:'2111492738025959922',url:'https://x.com/thsottiaux/status/2111492738025959922',text:'Landing sometime today by EOD PST',parentId:day.messageId,publishedAt:'2026-10-17T16:21:13.000Z'};
 return {rows:[reply,day,...rows],reply,day};
}
test('已验证活动的 Le limit reset 父帖与明确时间回复进入正常预告发布通道',()=>{
 const {rows,reply,day}=announcement(),before=structuredClone(rows);
 const context=gatherEvidenceContext(reply,rows),draft=buildAutomaticTemplate(context)!;
 assert.equal(draft.publicationMode,'state_change');assert.equal(draft.actions.length,1);
 assert.equal(draft.actions[0].stage,'promised');assert.equal(draft.actions[0].kind,'automatic_reset');
 assert.equal(draft.actions[0].expectedAt,'2026-10-18T08:00:00.000Z'); // PST is UTC-8, not PDT.
 assert.match(draft.actions[0].timeNote!,/PST/);assert.match(draft.actions[0].eligibility,/原帖未列明/);
 assert.equal(buildAutomaticTemplate(gatherEvidenceContext(day,rows))?.publicationMode,'news_only','活动简写本身不作为完成或推送承诺');
 assert.deepEqual(rows,before);
});
test('缺父帖、活动证据不足、日期不匹配或消息被否定时不会制造预告',()=>{
 const {rows,reply,day}=announcement();
 for(const input of [rows.filter(e=>e.id!==day.id),rows.filter(e=>e.id!=='rule'),rows.filter(e=>e.id!=='calendar'),rows.map(e=>e.id===day.id?{...e,text:'Day 13/ Maybe Le limit reset'}:e),rows.map(e=>e.id===day.id?{...e,publishedAt:'2026-10-16T16:20:57Z'}:e)]){
  assert.equal(evidenceBenefitClaims(reply,gatherEvidenceContext(reply,input)).length,0);
 }
});
