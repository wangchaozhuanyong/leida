import test from 'node:test';
import assert from 'node:assert/strict';
import type {Evidence,Source} from '../src/lib/types';
import {buildResetCadenceForecast} from '../src/lib/reset-cadence';
import {extractCadenceObservations} from '../src/server/reset-cadence-evidence';

const cutoff='2026-10-16T15:38:39.617Z',known='2026-10-15T19:16:56.447Z';
const timeline:Source={id:'tibo-public',name:'Saved public originals',kind:'timeline',url:'https://api.fxtwitter.com/2/profile/thsottiaux/statuses',enabled:true,validated:true,status:'healthy',intervalMinutes:10,version:1};
const calendar:Source={...timeline,id:'activity-archive',kind:'activity',url:'https://codex-resets.com/tibo-28'};
// Seven saved public statements from the 10/15 completion's detail response.
// The calendar's article body is not a reset; only its verified date is context.
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
const extract=(rows:Evidence[],sources:Source[]=[timeline,calendar],at=cutoff)=>extractCadenceObservations(rows,sources,at);
const change=(rows:Evidence[],id:string,patch:Partial<Evidence>)=>rows.map(row=>row.id===id?{...row,...patch}:row);

test('10/15完整七条公开依据通过共享活动上下文识别完成，起点精确且不改原文',()=>{
 const rows=fixture(),before=structuredClone(rows),observations=extract(rows);
 assert.equal(observations.length,1);
 const [observation]=observations;assert.equal(observation.kind,'automatic_reset');assert.equal(observation.at,'2026-10-15T06:28:13.000Z');assert.equal(observation.timePrecision,'exact');assert.equal(observation.firstKnownAt,known);
 assert.deepEqual(observation.evidenceIds,['day10','done','landing'],'同轮身份不包含各轮共用的规则和日历');
 const forecast=buildResetCadenceForecast({observations,target:'automatic_reset',generatedAt:cutoff,inputFingerprint:'campaign-completion'});
 assert.equal(forecast.anchorAt,observation.at);assert.equal(forecast.sampleCount,0,'单次完成不凭空造历史间隔');assert.deepEqual(rows,before);
});

test('缺规则、Day1、日历、显式父帖或活动时区日期不匹配时不能借首页标签造样本',()=>{
 for(const id of ['rule','day1','calendar','landing','day10'])assert.deepEqual(extract(fixture().filter(row=>row.id!==id)),[],id);
 const rows=fixture(),entry=rows.find(row=>row.id==='calendar')!;
 for(const patch of [{startsOn:'2026-10-06'},{startsOn:'2026-10-17'},{timezone:'Asia/Shanghai'},{days:9}]){
  assert.deepEqual(extract(change(rows,'calendar',{metadata:{...entry.metadata,activity:{...entry.metadata!.activity!,...patch}}})),[],JSON.stringify(patch));
 }
 assert.deepEqual(extract(change(rows,'done',{parentId:undefined})),[]);
});

test('活动日历仅允许固定已启用已验证适配器，冒名、跨账号和手工依据拒绝',()=>{
 for(const patch of [{enabled:false},{validated:false},{id:'another-project'},{kind:'archive' as const},{url:'https://codex-resets.com/tibo-29'},{url:'https://example.com/tibo-28'}])assert.deepEqual(extract(fixture(),[timeline,{...calendar,...patch}]),[],JSON.stringify(patch));
 const rows=fixture();
 for(const patch of [{sourceId:'another-project'},{provenance:'manual' as const},{metadata:{sourceGroup:'unknown'}},{url:'https://x.com/another_project/status/2107548725359104441'},{messageId:'unrelated'}])assert.deepEqual(extract(change(rows,'calendar',patch)),[],JSON.stringify(patch));
 assert.deepEqual(extract(change(rows,'rule',{url:'https://x.com/another_project/status/2106845241357824205'})),[]);
 const day1=rows.find(row=>row.id==='day1')!,proof=rows.find(row=>row.id==='calendar')!;
 assert.deepEqual(extract(change(rows.filter(row=>row.id!=='calendar'),'day1',{metadata:{...day1.metadata,activity:proof.metadata!.activity}})),[],'可信原帖上的附带元数据也不能冒充固定适配器日历');
 for(const text of ['Done and dusted for some users.','Done and dusted for accounts in China.','Done and dusted in my account only.'])assert.deepEqual(extract(change(rows,'done',{text})),[],text);
});

test('证明的首次可知时间包括日历，截止后的原文/规则/日历不提前可用',()=>{
 const rows=fixture(),later='2026-10-16T12:00:00.000Z';
 for(const id of ['done','rule','day1','calendar']){
  const delayed=change(rows,id,{collectedAt:later});
  assert.deepEqual(extract(delayed,[timeline,calendar],'2026-10-16T11:59:59.999Z'),[],id);
  assert.equal(extract(delayed)[0]?.firstKnownAt,later,id);
  assert.deepEqual(extract(change(rows,id,{publishedAt:'2026-10-17T00:00:00.000Z',collectedAt:'2026-10-17T01:00:00.000Z'})),[],id);
 }
 const proof=rows.find(row=>row.id==='calendar')!;
 const oldWrong={...proof,id:'old-calendar',collectedAt:'2026-10-14T12:00:00.000Z',metadata:{...proof.metadata,activity:{...proof.metadata!.activity!,startsOn:'2026-10-06'}}};
 assert.equal(extract([...rows,oldWrong])[0]?.firstKnownAt,known,'旧日历正文相同但日期元数据不同，不能提前为新证明提供可知时间');
});

test('规则与日历最新版本更正、同刻冲突不能保留旧资格',()=>{
 const rows=fixture(),proof=rows.find(row=>row.id==='calendar')!,rule=rows.find(row=>row.id==='rule')!;
 const corrected={...proof,id:'corrected-calendar',collectedAt:'2026-10-16T12:00:00.000Z',metadata:{...proof.metadata,activity:{...proof.metadata!.activity!,startsOn:'2026-10-06'}}};
 assert.deepEqual(extract([...rows,corrected]),[]);
 assert.deepEqual(extract([...rows,{...corrected,collectedAt:known}]),[],'同刻不同日历不得择优');
 assert.deepEqual(extract([...rows,{...rule,id:'corrected-rule',collectedAt:'2026-10-16T12:00:00.000Z',text:'The reset campaign was cancelled.'}]),[]);
});

test('同一活动的两次完成不因共用规则和日历合并成一轮',()=>{
 const rows=fixture(),base=rows.find(row=>row.id==='day10')!,done=rows.find(row=>row.id==='done')!;
 const day11={...base,id:'day11',messageId:'2111000000000000011',url:'https://x.com/thsottiaux/status/2111000000000000011',text:'Day 11/ Reset',publishedAt:'2026-10-16T04:55:51.000Z',collectedAt:'2026-10-16T08:00:00.000Z'};
 const second={...done,id:'second-done',messageId:'2111000000000000012',url:'https://x.com/thsottiaux/status/2111000000000000012',parentId:day11.messageId,publishedAt:'2026-10-16T06:28:13.000Z',collectedAt:'2026-10-16T08:00:00.000Z'};
 const observations=extract([...rows,day11,second]);assert.equal(observations.length,2);
 const forecast=buildResetCadenceForecast({observations,target:'automatic_reset',generatedAt:cutoff,inputFingerprint:'distinct-campaign-rounds'});
 assert.equal(forecast.observations.length,2);assert.equal(forecast.trainingIntervals[0]?.hours,24);
});

test('同URL较新calendar只作上下文，不抹除原始正文或制造训练声明；正文更正仍生效',()=>{
 const rows=fixture(),proof=rows.find(row=>row.id==='calendar')!;
 const direct:Evidence={...rows[0],id:'direct-original',messageId:'2111000000000000020',url:'https://x.com/thsottiaux/status/2111000000000000020',text:'We have reset usage limits for all paid Codex accounts.',parentId:undefined,publishedAt:'2026-10-16T01:00:00.000Z',collectedAt:'2026-10-16T02:00:00.000Z'};
 const excerpt:Evidence={...proof,id:'same-url-calendar',messageId:direct.messageId,url:direct.url,text:'We have reset usage limits for all paid Codex accounts.',publishedAt:direct.publishedAt,collectedAt:'2026-10-16T03:00:00.000Z'};
 const result=extract([direct,excerpt]);assert.equal(result.length,1);assert.deepEqual(result[0].evidenceIds,[direct.id]);assert.equal(result[0].firstKnownAt,direct.collectedAt);
 assert.deepEqual(extract([excerpt]),[],'日历正文即使声称完成，也不能直接训练');
 const corrected={...direct,id:'corrected-direct',collectedAt:'2026-10-16T04:00:00.000Z',text:'Correction: we have not reset usage limits for all paid Codex accounts.'};
 assert.deepEqual(extract([direct,excerpt,corrected]),[]);
 const day1=rows.find(row=>row.id==='day1')!,sameDay1={...proof,id:'same-day1-calendar',messageId:day1.messageId,url:day1.url,publishedAt:day1.publishedAt,collectedAt:'2026-10-16T03:00:00.000Z'};
 assert.equal(extract([...rows,sameDay1])[0]?.at,'2026-10-15T06:28:13.000Z','日历也不能遮蔽验证活动日期所需的原始Day1');
});

test('较新归档译文不遮蔽10/15原帖完成链，保留精确锚点与首次可知时间',()=>{
 const rows=fixture(),done=rows.find(row=>row.id==='done')!,day1=rows.find(row=>row.id==='day1')!;
 const archive:Source={...calendar,id:'reset-archive',kind:'archive',url:'https://codex-resets.com/zh-CN'};
 const excerpt=(original:Evidence,text:string):Evidence=>({...original,id:`excerpt-${original.id}`,sourceId:archive.id,text,textOrigin:'archive_excerpt',parentId:undefined,collectedAt:'2026-10-16T12:00:00.000Z',metadata:{sourceGroup:'codex-resets',category:'reset'}});
 const translated=[excerpt(done,'搞定了'),excerpt(day1,'第一天，速度已经提高。')];
 for(const evidence of [[...rows,...translated],[...translated,...rows]]){
  const before=structuredClone(evidence),observations=extract(evidence,[timeline,calendar,archive]);
  assert.equal(observations.length,1);assert.equal(observations[0].at,'2026-10-15T06:28:13.000Z');
  assert.equal(observations[0].timePrecision,'exact');assert.equal(observations[0].firstKnownAt,known);
  assert.deepEqual(observations[0].evidenceIds,['day10','done','landing']);
  const forecast=buildResetCadenceForecast({observations,target:'automatic_reset',generatedAt:cutoff,inputFingerprint:'original-with-later-translation'});
  assert.equal(forecast.anchorAt,done.publishedAt);assert.deepEqual(evidence,before);
 }
 const correction={...done,id:'done-corrected',collectedAt:'2026-10-16T13:00:00.000Z',text:'Correction: no reset occurred. The previous statement was withdrawn.'};
 assert.deepEqual(extract([...rows,...translated,correction],[timeline,calendar,archive]),[],'原文实际更正仍取消旧样本');
 const conflict={...done,id:'same-time-conflict',text:'No reset occurred.'};
 assert.deepEqual(extract([...rows,...translated,conflict],[timeline,calendar,archive]),[],'同刻原文冲突不能由归档译文解围');
});
