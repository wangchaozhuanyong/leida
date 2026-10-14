import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResetCadenceForecast,RESET_CADENCE_MAX_INTERVALS,RESET_CADENCE_MODEL_VERSION,type CadenceObservation,type CadenceLookback} from '../src/lib/reset-cadence';

const HOUR=3_600_000;
const start=Date.parse('2026-01-01T00:00:00Z');
function history(gaps:number[]):CadenceObservation[] {
 let time=start;
 return [0,...gaps].map((gap,index)=>{
  time+=gap*HOUR;
  return {id:`reset-${index}`,evidenceIds:[`evidence-${index}`],at:new Date(time).toISOString(),url:`https://example.test/resets/${index}`,kind:index%2?'banked_reset':'automatic_reset'};
 });
}
function run(observations:CadenceObservation[],elapsedHours=0){return buildResetCadenceForecast({observations,generatedAt:new Date(Date.parse(observations.at(-1)!.at)+elapsedHours*HOUR).toISOString(),inputFingerprint:'test-history'});}

test('少于8个实际间隔不输出固定种子或先验，回测为空',()=>{
 const result=run(history([48,60,72,84,96,108,120]));
 assert.equal(result.status,'insufficient');assert.equal(result.sampleCount,7);assert.equal(result.p24,null);assert.equal(result.p48,null);assert.equal(result.predictedAt,null);assert.equal(result.backtest.tests,0);assert.equal(result.calibrated,false);
});

test('模型使用实际间隔且按当前等待时间条件化，概率和未来区间可复算',()=>{
 const observations=history([48,60,72,84,96,108,120,132]),result=run(observations,70),anchor=Date.parse(observations.at(-1)!.at);
 assert.equal(result.status,'ready');assert.equal(result.sampleCount,8);assert.equal(result.eligibleCount,6);assert.equal(result.p24,2/6);assert.equal(result.p48,4/6);
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

test('同ID、原帖URL、共有证据及24小时内进展完成去重；保留最早源时间',()=>{
 const observations=history([48,60,72,84,96,108,120,132]);
 const last=observations.at(-1)!;
 const duplicate:CadenceObservation={...last,id:'later-progress',at:new Date(Date.parse(last.at)+6*HOUR).toISOString(),url:'https://example.test/new-completion',evidenceIds:['new-evidence'],kind:'banked_reset'};
 const shared:CadenceObservation={...observations[2],id:'re-collected',at:new Date(Date.parse(last.at)+2*HOUR).toISOString(),url:'https://example.test/re-collected'};
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

test('24小时聚类只看首条锚点，不把连续进展链式吞到多天后',()=>{
 const observations=history([48,60,72,84,96,108,120,132]),last=observations.at(-1)!;
 const updates=[12,23,36].map((hours,index)=>({...last,id:`followup-${index}`,evidenceIds:[`followup-evidence-${index}`],url:`https://example.test/followup/${index}`,at:new Date(Date.parse(last.at)+hours*HOUR).toISOString()}));
 const result=run([...observations,...updates]);
 assert.equal(result.observations.length,10);assert.equal(result.mergedCount,2);assert.equal(result.observations.at(-2)!.at,last.at);assert.equal(result.observations.at(-1)!.at,updates[2].at);assert.equal(result.trainingIntervals.at(-1)!.hours,36);
});

test('滚动回测每个起点只训练此前间隔，追加未来极端结果不改变旧预测',()=>{
 const observations=history([48,60,72,84,96,108,120,132,96,72,120,84]);
 const result=run(observations),extended=run([...observations,{id:'future-tail',evidenceIds:['future-tail-evidence'],at:new Date(Date.parse(observations.at(-1)!.at)+600*HOUR).toISOString(),url:'https://example.test/future-tail',kind:'unspecified'}]);
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
 assert.equal(result.sampleCount,RESET_CADENCE_MAX_INTERVALS);assert.equal(result.observations.length,43);assert.equal(result.trainingObservationIds.length,31);assert.ok(result.trainingIntervals.every(record=>record.hours===48));assert.equal(result.p48,1);
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
