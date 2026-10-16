import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResetCadenceForecast,RESET_CADENCE_MAX_INTERVALS,RESET_CADENCE_MODEL_VERSION,type CadenceObservation,type CadenceLookback} from '../src/lib/reset-cadence';

const HOUR=3_600_000;
const start=Date.parse('2026-01-01T00:00:00Z');
function history(gaps:number[]):CadenceObservation[] {
 let time=start;
 return [0,...gaps].map((gap,index)=>{
  time+=gap*HOUR;
  return {id:`reset-${index}`,evidenceIds:[`evidence-${index}`],at:new Date(time).toISOString(),url:`https://example.test/resets/${index}`,kind:'automatic_reset',timePrecision:'exact',firstKnownAt:new Date(time).toISOString()};
 });
}
function run(observations:CadenceObservation[],elapsedHours=0){return buildResetCadenceForecast({observations,generatedAt:new Date(Date.parse(observations.at(-1)!.at)+elapsedHours*HOUR).toISOString(),inputFingerprint:'test-history'});}

test('少于8个实际间隔不输出固定种子或先验，回测为空',()=>{
 const result=run(history([48,60,72,84,96,108,120]));
 assert.equal(result.status,'insufficient');assert.equal(result.sampleCount,7);assert.equal(result.p24,null);assert.equal(result.p48,null);assert.equal(result.predictedAt,null);assert.equal(result.backtest.tests,0);assert.equal(result.calibrated,false);
});

test('模型使用实际间隔且按当前等待时间条件化，概率和未来区间可复算',()=>{
 const observations=history([48,60,72,84,96,108,120,132]),result=run(observations,70),anchor=Date.parse(observations.at(-1)!.at);
 assert.equal(result.status,'ready');assert.equal(result.sampleCount,8);assert.equal(result.eligibleCount,6);assert.equal(result.p24,4/10);assert.equal(result.p48,6/10);assert.equal(result.rawP24,2/6);assert.equal(result.rawP48,4/6);
 assert.equal(result.predictedAt,new Date(anchor+102*HOUR).toISOString());assert.equal(result.windowStart,new Date(anchor+84*HOUR).toISOString());assert.equal(result.windowEnd,new Date(anchor+120*HOUR).toISOString());assert.ok(Date.parse(result.windowStart!)>Date.parse(result.generatedAt));
 assert.equal(result.validUntil,new Date(Date.parse(result.generatedAt)+6*HOUR).toISOString());assert.equal(result.cutoffAt,result.generatedAt);assert.equal(result.modelVersion,RESET_CADENCE_MODEL_VERSION);
});

test('同样输入稳定可复现，不改变调用方数据；改变历史会改变预测',()=>{
 const observations=history([48,60,72,84,96,108,120,132]),before=structuredClone(observations),first=run(observations);
 assert.deepEqual(run(observations),first);assert.deepEqual(observations,before);
 const changed=run(history([96,120,144,168,192,216,240,264]));assert.notEqual(first.predictedAt,changed.predictedAt);assert.notEqual(first.p48,changed.p48);
});

test('等待过久不外推；剩余支持不足不输出小分母概率',()=>{
 const observations=history([48,60,72,84,96,108,120,132]);
 const thin=run(observations,109);assert.equal(thin.status,'insufficient');assert.equal(thin.eligibleCount,2);assert.equal(thin.p24,null);assert.equal(thin.predictedAt,null);
 const beyond=run(observations,132);assert.equal(beyond.status,'out_of_range');assert.equal(beyond.eligibleCount,0);assert.equal(beyond.p48,null);assert.equal(beyond.windowEnd,null);
});

test('暂停保留可查历史与回测，隐藏当前概率和时间',()=>{
 const observations=history([48,60,72,84,96,108,120,132,144]),result=buildResetCadenceForecast({observations,generatedAt:observations.at(-1)!.at,inputFingerprint:'paused',paused:true,pauseReason:'近期采集失败'});
 assert.equal(result.status,'paused');assert.equal(result.p24,null);assert.equal(result.predictedAt,null);assert.equal(result.explanation,'近期采集失败');assert.equal(result.backtest.tests,1);assert.equal(result.trainingObservationIds.length,10);
});

test('同ID、原帖URL、共有证据进展完成去重；保留最早精确源时间',()=>{
 const observations=history([48,60,72,84,96,108,120,132]);
 const last=observations.at(-1)!;
 const duplicate:CadenceObservation={...last,id:'later-progress',at:new Date(Date.parse(last.at)+6*HOUR).toISOString(),url:'https://example.test/new-completion',evidenceIds:[...last.evidenceIds,'new-evidence'],firstKnownAt:new Date(Date.parse(last.at)+6*HOUR).toISOString()};
 const shared:CadenceObservation={...observations[2],id:'re-collected',at:new Date(Date.parse(last.at)+2*HOUR).toISOString(),firstKnownAt:new Date(Date.parse(last.at)+2*HOUR).toISOString(),url:'https://example.test/re-collected'};
 const variant:CadenceObservation={...observations[3],id:'same-original',url:`${observations[3].url}/#fragment`,evidenceIds:['additional-version']};
 const result=run([...observations,shared,duplicate,variant].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)));
 assert.equal(result.observations.length,9);assert.equal(result.mergedCount,3);assert.equal(result.anchorAt,last.at);assert.equal(result.sampleCount,8);assert.deepEqual(result.observations.at(-1)!.evidenceIds,[last.evidenceIds[0],'new-evidence'].sort());
 assert.ok(result.observations[3].evidenceIds.includes('additional-version'));
});

test('未来记录、无效日期、无源证据和非法URL不得进入训练',()=>{
 const observations=history([48,60,72,84,96,108,120,132]),generatedAt=observations.at(-1)!.at;
 const invalid:CadenceObservation[]=[{...observations[0],id:'future',at:'2027-01-01T00:00:00Z'},{...observations[0],id:'bad-date',at:'nonsense'},{...observations[0],id:'without-evidence',evidenceIds:[]},{...observations[0],id:'bad-url',url:'file:///private/record'},{...observations[0],id:'rollover-date',at:'2026-02-30T00:00:00Z'},{...observations[0],id:'timezone-missing',at:'2026-01-01T00:00:00'}];
 const before=run(observations),after=buildResetCadenceForecast({observations:[...observations,...invalid],generatedAt,inputFingerprint:'test-history'});
 assert.equal(after.rejectedCount,6);assert.equal(after.sampleCount,before.sampleCount);assert.equal(after.predictedAt,before.predictedAt);assert.deepEqual(after.backtest,before.backtest);
});

test('24小时内的独立原帖不按时间邻近合并',()=>{
 const observations=history([48,60,72,84,96,108,120,132]),last=observations.at(-1)!;
 const updates=[12,23,36].map((hours,index)=>({...last,id:`followup-${index}`,evidenceIds:[`followup-evidence-${index}`],url:`https://example.test/followup/${index}`,at:new Date(Date.parse(last.at)+hours*HOUR).toISOString(),firstKnownAt:new Date(Date.parse(last.at)+hours*HOUR).toISOString()}));
 const result=run([...observations,...updates]);
 assert.equal(result.observations.length,12);assert.equal(result.mergedCount,0);assert.equal(result.observations.at(-1)!.at,updates[2].at);assert.equal(result.trainingIntervals.at(-1)!.hours,13);
});

test('滚动回测每个起点只训练此前间隔，追加未来极端结果不改变旧预测',()=>{
 const observations=history([48,60,72,84,96,108,120,132,96,72,120,84]);
 const result=run(observations),extended=run([...observations,{id:'future-tail',evidenceIds:['future-tail-evidence'],at:new Date(Date.parse(observations.at(-1)!.at)+600*HOUR).toISOString(),url:'https://example.test/future-tail',kind:'automatic_reset',timePrecision:'exact',firstKnownAt:new Date(Date.parse(observations.at(-1)!.at)+600*HOUR).toISOString()}]);
 assert.equal(result.backtest.tests,4);assert.deepEqual(extended.backtest.entries.slice(0,result.backtest.tests),result.backtest.entries);
 for(const entry of result.backtest.entries){
  assert.equal(entry.anchorAt,entry.generatedAt);
  const known=result.observations.filter(record=>Date.parse(record.at)<=Date.parse(entry.generatedAt)),fold=buildResetCadenceForecast({observations:known,generatedAt:entry.generatedAt,inputFingerprint:'fold'});
  assert.equal(entry.predictedAt,fold.predictedAt);assert.equal(entry.windowStart,fold.windowStart);assert.equal(entry.windowEnd,fold.windowEnd);assert.equal(entry.trainingCount,fold.sampleCount);
  assert.ok(entry.trainingObservationIds.every(id=>known.some(record=>record.id===id)));
 }
 assert.equal(result.backtest.hits,result.backtest.entries.filter(entry=>entry.hit).length);assert.equal(result.backtest.hitRate,result.backtest.hits/result.backtest.tests);assert.equal(result.backtest.mode,'retrospective');assert.match(result.backtest.explanation,/事后回填/);
});

test('近期模型只取最后30个完整间隔，同时保留全部可查记录和回测',()=>{
 const observations=history([...Array(12).fill(300),...Array(30).fill(48)]),result=buildResetCadenceForecast({observations,generatedAt:observations.at(-1)!.at,inputFingerprint:'full-lookback',lookbackIntervals:30});
 assert.equal(result.sampleCount,RESET_CADENCE_MAX_INTERVALS);assert.equal(result.observations.length,43);assert.equal(result.trainingObservationIds.length,31);assert.ok(result.trainingIntervals.every(record=>record.hours===48));assert.equal(result.p48,32/34);assert.equal(result.rawP48,1);
 assert.equal(result.backtest.tests,34);assert.ok(result.backtest.entries.every(entry=>entry.trainingCount<=30));assert.equal(result.backtest.entries.at(-1)!.absoluteErrorHours,0);
});

test('固定近期窗口在每个回测起点一致使用，不按未来长短筛选历史',()=>{
 const observations=history([480,600,360,720,400,550,800,900,250,300,170,130,90,100,150,120,95,200,300,100,150,120,80,130]);
 const current=run(observations);assert.equal(current.sampleCount,20);assert.equal(current.lookbackIntervals,20);assert.equal(current.historicalIntervals.length,24);assert.equal(current.historicalIntervals[0].hours,480);assert.equal(current.historicalIntervals[7].hours,900);
 for(const lookbackIntervals of [8,12,20,30] as CadenceLookback[]){
  const result=buildResetCadenceForecast({observations,generatedAt:observations.at(-1)!.at,inputFingerprint:`lookback-${lookbackIntervals}`,lookbackIntervals});
  assert.equal(result.lookbackIntervals,lookbackIntervals);assert.equal(result.sampleCount,Math.min(lookbackIntervals,24));assert.equal(result.observations.length,25);assert.equal(result.backtest.tests,16);assert.deepEqual(result.historicalIntervals,current.historicalIntervals);
  for(const entry of result.backtest.entries){
   const fold=buildResetCadenceForecast({observations:observations.filter(record=>Date.parse(record.at)<=Date.parse(entry.generatedAt)),generatedAt:entry.generatedAt,inputFingerprint:'fold',lookbackIntervals});
   assert.equal(entry.predictedAt,fold.predictedAt);assert.equal(entry.windowStart,fold.windowStart);assert.equal(entry.windowEnd,fold.windowEnd);assert.equal(entry.trainingCount,fold.sampleCount);
  }
 }
});

test('最近8起点摘要可从完整回测复算，旧fold仍保留可查',()=>{
 const observations=history([...Array(12).fill(300),48,60,72,84,96,108,120,132,144,80,70,60,120,180,96,48]);
 const result=run(observations),recent=result.backtest.entries.slice(-8),errors=recent.map(entry=>entry.absoluteErrorHours).sort((a,b)=>a-b);
 assert.ok(result.backtest.tests>8);assert.equal(result.backtest.recent.tests,8);assert.equal(result.backtest.recent.hits,recent.filter(entry=>entry.hit).length);assert.equal(result.backtest.recent.hitRate,result.backtest.recent.hits/8);assert.equal(result.backtest.recent.medianAbsoluteErrorHours,(errors[3]+errors[4])/2);
});

test('没有历史也安全返回，非法生成时间和空输入指纹拒绝执行',()=>{
 const result=buildResetCadenceForecast({observations:[],generatedAt:'2026-10-11T00:00:00Z',inputFingerprint:'empty'});
 assert.equal(result.status,'insufficient');assert.equal(result.anchorAt,null);assert.equal(result.p24,null);assert.equal(result.backtest.hitRate,null);assert.equal(result.backtest.medianAbsoluteErrorHours,null);
 assert.throws(()=>buildResetCadenceForecast({observations:[],generatedAt:'invalid',inputFingerprint:'empty'}),/时间无效/);
 assert.throws(()=>buildResetCadenceForecast({observations:[],generatedAt:'2026-10-11T00:00:00Z',inputFingerprint:''}),/指纹不能为空/);
});

test('Beta(2,2)平滑与原始基线均可复算，且24小时概率不大于48小时',()=>{
 const result=run(history([24,30,35,36,40,44,46,48,60,72]));
 assert.equal(result.eligibleCount,10);assert.equal(result.p48,10/14);assert.equal(result.rawP48,8/10);
 assert.equal(result.p24,3/14);assert.equal(result.rawP24,1/10);assert.ok(result.p24!<=result.p48!);
 assert.match(result.method,/Beta\(2,2\)/);assert.equal(result.target,'automatic_reset');
});

test('自动重置、重置卡及未分类保留可查历史，分别只训练目标类型',()=>{
 const automatic=history(Array(10).fill(48));
 const banked=history(Array(10).fill(72)).map(record=>({...record,id:`bank-${record.id}`,url:`https://example.test/bank/${record.id}`,evidenceIds:[`bank-${record.id}`],kind:'banked_reset' as const}));
 const unknown:CadenceObservation={...banked.at(-1)!,id:'unknown',url:'https://example.test/unknown',evidenceIds:['unknown'],kind:'unspecified'};
 const generatedAt=banked.at(-1)!.at,observations=[...automatic,...banked,unknown];
 const usage=buildResetCadenceForecast({observations,generatedAt,inputFingerprint:'usage'});
 const bank=buildResetCadenceForecast({observations,generatedAt,inputFingerprint:'bank',target:'banked_reset'});
 assert.equal(usage.observations.length,23);assert.equal(usage.sampleCount,10);assert.equal(usage.anchorAt,automatic.at(-1)!.at);
 assert.ok(usage.trainingIntervals.every(record=>record.hours===48));
 assert.equal(bank.sampleCount,10);assert.equal(bank.anchorAt,banked.at(-1)!.at);assert.ok(bank.trainingIntervals.every(record=>record.hours===72));
 assert.ok(!bank.trainingObservationIds.includes('unknown'));assert.ok(!usage.trainingObservationIds.some(id=>id.startsWith('bank-')));
});

test('日期、未知精度、缺首次可知元数据和旧观测均保留历史但不进入小时训练',()=>{
 const originals=history(Array(10).fill(48)),generatedAt=originals.at(-1)!.at;
 const cases:CadenceObservation[]=[
  {...originals[0],id:'date',url:'https://example.test/date',evidenceIds:['date'],at:'2026-01-01',timePrecision:'date'},
  {...originals[1],id:'unknown',url:'https://example.test/unknown',evidenceIds:['unknown'],timePrecision:'unknown'},
  {...originals[2],id:'legacy',url:'https://example.test/legacy',evidenceIds:['legacy'],timePrecision:undefined,firstKnownAt:undefined},
  {...originals[3],id:'without-known',url:'https://example.test/without-known',evidenceIds:['without-known'],firstKnownAt:undefined},
 ];
 const result=buildResetCadenceForecast({observations:cases,generatedAt,inputFingerprint:'no-inferred-time'});
 assert.equal(result.observations.length,4);assert.equal(result.observations[0].at,'2026-01-01');
 assert.equal(result.sampleCount,0);assert.equal(result.anchorAt,null);assert.equal(result.status,'insufficient');assert.equal(result.p48,null);
 const future={...originals[0],firstKnownAt:'2027-01-01T00:00:00Z'};
 assert.equal(buildResetCadenceForecast({observations:[future],generatedAt,inputFingerprint:'future-known'}).rejectedCount,1);
});

test('精确原帖能补充同身份日期精度，冲突类型仍不得训练',()=>{
 const exact=history([48])[0],date={...exact,at:exact.at.slice(0,10),timePrecision:'date' as const};
 const result=run([date,exact]);assert.equal(result.observations.length,1);assert.equal(result.anchorAt,exact.at);assert.equal(result.observations[0].timePrecision,'exact');
 const conflict=run([exact,{...exact,kind:'banked_reset'}]);
 assert.equal(conflict.observations[0].kind,'unspecified');assert.equal(conflict.anchorAt,null);
});

test('事后集中回填只能用于未来预测，不能伪造历史提前成绩',()=>{
 const observations=history(Array(14).fill(48)),knownAt=observations.at(-1)!.at;
 const late=observations.map(record=>({...record,firstKnownAt:knownAt}));
 const result=run(late);
 assert.equal(result.sampleCount,14);assert.equal(result.backtest.tests,0);
});

test('仅四个可比间隔不输出平滑概率，五个时才输出',()=>{
 const observations=history([24,30,40,50,60,70,80,90]);
 const thin=run(observations,50);assert.equal(thin.eligibleCount,4);assert.equal(thin.status,'insufficient');assert.equal(thin.p24,null);
 const supported=run(observations,49);assert.equal(supported.eligibleCount,5);assert.equal(supported.status,'ready');
});

test('不精确的同类记录打断相邻间隔，最新时间不明时不沿用旧锚点',()=>{
 const observations=history(Array(12).fill(48));
 const uncertain={...observations[5],timePrecision:'date' as const,at:observations[5].at.slice(0,10)};
 const result=run(observations.map((record,index)=>index===5?uncertain:record));
 assert.equal(result.historicalIntervals.length,10);
 assert.ok(!result.historicalIntervals.some(interval=>interval.fromId===observations[4].id&&interval.toId===observations[6].id));
 const last=observations.at(-1)!,later={...last,id:'later-date',url:'https://example.test/later-date',evidenceIds:['later-date'],at:'2026-01-26',timePrecision:'date' as const,firstKnownAt:'2026-01-26T01:00:00Z'};
 const pending=buildResetCadenceForecast({observations:[...observations,later],generatedAt:'2026-01-26T02:00:00Z',inputFingerprint:'uncertain-anchor'});
 assert.equal(pending.sampleCount,12);assert.equal(pending.anchorAt,null);assert.equal(pending.status,'insufficient');assert.equal(pending.p48,null);
});
