/**
 * A source-time, empirical forecast of the next public reset announcement.
 * Inputs must be actual reset progress/completion announcements, never promises,
 * scheduled deadlines, personal delivery records, or fabricated reference seeds.
 * Historical source times support retrospective evaluation only: the caller must
 * separately establish when each record first became available in real time.
 */
export interface CadenceObservation {
 id:string;
 evidenceIds:string[];
 at:string;
 url:string;
 kind:'automatic_reset'|'banked_reset'|'unspecified';
}

export interface CadenceInterval {
 fromId:string;
 toId:string;
 fromAt:string;
 toAt:string;
 hours:number;
}

export interface CadenceBacktestEntry {
 anchorAt:string;
 generatedAt:string;
 trainingCount:number;
 predictedAt:string;
 windowStart:string;
 windowEnd:string;
 actualAt:string;
 hit:boolean;
 absoluteErrorHours:number;
 trainingObservationIds:string[];
}

export interface CadenceBacktestSummary {
 tests:number;
 hits:number;
 hitRate:number|null;
 medianAbsoluteErrorHours:number|null;
}

export interface CadenceBacktest extends CadenceBacktestSummary {
 mode:'retrospective';
 entries:CadenceBacktestEntry[];
 recent:CadenceBacktestSummary;
 explanation:string;
}

export interface ResetCadenceForecast {
 status:'ready'|'insufficient'|'out_of_range'|'paused';
 id:string;
 modelVersion:string;
 inputFingerprint:string;
 generatedAt:string;
 cutoffAt:string;
 validUntil:string;
 anchorAt:string|null;
 sampleCount:number;
 lookbackIntervals:CadenceLookback;
 eligibleCount:number;
 p24:number|null;
 p48:number|null;
 predictedAt:string|null;
 windowStart:string|null;
 windowEnd:string|null;
 observations:CadenceObservation[];
 trainingObservationIds:string[];
 trainingIntervals:CadenceInterval[];
 historicalIntervals:CadenceInterval[];
 rejectedCount:number;
 mergedCount:number;
 method:string;
 backtest:CadenceBacktest;
 explanation:string;
 calibrated:false;
}

export interface ResetCadenceInput {
 observations:CadenceObservation[];
 generatedAt:string;
 /** Caller supplies a stable digest of complete input plus the generation bucket. */
 inputFingerprint:string;
 lookbackIntervals?:CadenceLookback;
 paused?:boolean;
 pauseReason?:string;
}

export type CadenceLookback=8|12|20|30;
export const RESET_CADENCE_MODEL_VERSION='conditional-empirical-reset-cadence-20261012-3';
export const RESET_CADENCE_MIN_INTERVALS=8;
export const RESET_CADENCE_MAX_INTERVALS=30;
// Fixed recent window balances several months of cadence and historical support.
// This is not automatic tuning against the current next reset or live accuracy.
export const RESET_CADENCE_DEFAULT_LOOKBACK:CadenceLookback=20;
export const RESET_CADENCE_MIN_ELIGIBLE=4;
export const RESET_CADENCE_VALID_HOURS=6;
const HOUR=3_600_000;
const SAME_RESET_HOURS=24;
const method=(lookback:CadenceLookback)=>`最近最多${lookback}个公开重置动态的实际间隔；按当前已等待时间条件化的经验分布；无固定种子或先验；不按间隔长短删除记录。`;

function iso(time:number):string {return new Date(time).toISOString();}
function sourceTime(value:string):number {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN;
 const year=Number(value.slice(0,4)),month=Number(value.slice(5,7)),day=Number(value.slice(8,10));
 if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())return NaN;
 return Date.parse(value);
}
function canonicalUrl(value:string):string|undefined {
 try {
  const url=new URL(value);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return;
  url.hash='';
  url.pathname=url.pathname.replace(/\/+$/,'')||'/';
  return url.href;
 }catch {return;}
}
function mergeObservation(first:CadenceObservation,next:CadenceObservation):CadenceObservation {
 return {...first,evidenceIds:[...new Set([...first.evidenceIds,...next.evidenceIds])].sort(),kind:first.kind===next.kind?first.kind:'unspecified'};
}

/** All input is copied. Same identities and announcements within 24 hours count once. */
function normalizeObservations(input:CadenceObservation[],cutoff:number):{observations:CadenceObservation[];rejectedCount:number;mergedCount:number} {
 let rejectedCount=0;
 const valid:CadenceObservation[]=[];
 for(const record of input){
  const at=sourceTime(record?.at),url=canonicalUrl(record?.url);
  if(typeof record?.id!=='string'||!record.id.trim()||!Number.isFinite(at)||at>cutoff||!url||!['automatic_reset','banked_reset','unspecified'].includes(record.kind)||!Array.isArray(record.evidenceIds)||!record.evidenceIds.some(id=>typeof id==='string'&&id.trim())){
   rejectedCount++;continue;
  }
  valid.push({id:record.id.trim(),evidenceIds:[...new Set(record.evidenceIds.filter(id=>typeof id==='string'&&id.trim()).map(id=>id.trim()))].sort(),at:iso(at),url,kind:record.kind});
 }
 valid.sort((a,b)=>sourceTime(a.at)-sourceTime(b.at)||a.id.localeCompare(b.id));
 // Union fact-support identities before temporal grouping. The extractor keeps
 // unrelated conversational ancestors out of evidenceIds; a second collected
 // version of the same statement must never become another reset interval.
 const parents=valid.map((_,i)=>i);
 const find=(index:number):number=>{
  let root=index;
  while(parents[root]!==root)root=parents[root];
  while(parents[index]!==index){const next=parents[index];parents[index]=root;index=next;}
  return root;
 };
 const identities=new Map<string,number>();
 for(let i=0;i<valid.length;i++){
  const record=valid[i],keys=[`id:${record.id}`,`url:${record.url}`,...record.evidenceIds.map(id=>`evidence:${id}`)];
  for(const key of keys){
   const previous=identities.get(key);
   if(previous!==undefined){const a=find(previous),b=find(i);if(a!==b)parents[Math.max(a,b)]=Math.min(a,b);}
   else identities.set(key,i);
  }
 }
 const groups=new Map<number,CadenceObservation>();
 for(let i=0;i<valid.length;i++){
  const key=find(i),previous=groups.get(key);
  groups.set(key,previous?mergeObservation(previous,valid[i]):{...valid[i],evidenceIds:[...valid[i].evidenceIds]});
 }
 const observations:CadenceObservation[]=[];
 for(const record of [...groups.values()].sort((a,b)=>sourceTime(a.at)-sourceTime(b.at)||a.id.localeCompare(b.id))){
  const previous=observations.at(-1);
  if(previous&&sourceTime(record.at)-sourceTime(previous.at)<=SAME_RESET_HOURS*HOUR)observations[observations.length-1]=mergeObservation(previous,record);
  else observations.push(record);
 }
 return {observations,rejectedCount,mergedCount:valid.length-observations.length};
}

function allIntervals(observations:CadenceObservation[]):CadenceInterval[] {
 return observations.slice(1).map((record,index)=>({fromId:observations[index].id,toId:record.id,fromAt:observations[index].at,toAt:record.at,hours:(sourceTime(record.at)-sourceTime(observations[index].at))/HOUR}));
}
function intervals(observations:CadenceObservation[],lookback:CadenceLookback):CadenceInterval[] {
 return allIntervals(observations).slice(-lookback);
}

/** Inverse empirical CDF (nearest rank). No extrapolation beyond observed values. */
function quantile(sorted:number[],probability:number):number {
 return sorted[Math.max(0,Math.min(sorted.length-1,Math.ceil(probability*sorted.length)-1))];
}
function median(sorted:number[]):number {
 const middle=Math.floor(sorted.length/2);
 return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}
interface Estimate {
 status:'ready'|'insufficient'|'out_of_range';
 eligibleCount:number;
 p24:number|null;
 p48:number|null;
 predictedAt:string|null;
 windowStart:string|null;
 windowEnd:string|null;
}
function estimate(training:CadenceInterval[],anchor:number,generated:number):Estimate {
 const empty={eligibleCount:0,p24:null,p48:null,predictedAt:null,windowStart:null,windowEnd:null};
 if(training.length<RESET_CADENCE_MIN_INTERVALS)return {status:'insufficient',...empty};
 const elapsed=(generated-anchor)/HOUR;
 const support=training.map(record=>record.hours).filter(hours=>hours>elapsed).sort((a,b)=>a-b);
 if(!support.length)return {status:'out_of_range',...empty};
 if(support.length<RESET_CADENCE_MIN_ELIGIBLE)return {status:'insufficient',...empty,eligibleCount:support.length};
 return {status:'ready',eligibleCount:support.length,p24:support.filter(hours=>hours<=elapsed+24).length/support.length,p48:support.filter(hours=>hours<=elapsed+48).length/support.length,predictedAt:iso(anchor+median(support)*HOUR),windowStart:iso(anchor+quantile(support,.2)*HOUR),windowEnd:iso(anchor+quantile(support,.8)*HOUR)};
}
function trainingIds(training:CadenceInterval[]):string[] {
 return [...new Set(training.flatMap(record=>[record.fromId,record.toId]))];
}

/** Rolling origins: each prediction sees only intervals completed at its anchor. */
function backtestSummary(entries:CadenceBacktestEntry[]):CadenceBacktestSummary {
 const hits=entries.filter(record=>record.hit).length,errors=entries.map(record=>record.absoluteErrorHours).sort((a,b)=>a-b);
 return {tests:entries.length,hits,hitRate:entries.length?hits/entries.length:null,medianAbsoluteErrorHours:errors.length?median(errors):null};
}
function backtest(observations:CadenceObservation[],lookback:CadenceLookback):CadenceBacktest {
 const entries:CadenceBacktestEntry[]=[];
 for(let index=RESET_CADENCE_MIN_INTERVALS;index<observations.length-1;index++){
  const known=observations.slice(0,index+1),training=intervals(known,lookback),anchor=sourceTime(known.at(-1)!.at),predicted=estimate(training,anchor,anchor);
  if(predicted.status!=='ready'||!predicted.predictedAt||!predicted.windowStart||!predicted.windowEnd)continue;
  const actual=observations[index+1],actualTime=sourceTime(actual.at);
  entries.push({anchorAt:iso(anchor),generatedAt:iso(anchor),trainingCount:training.length,predictedAt:predicted.predictedAt,windowStart:predicted.windowStart,windowEnd:predicted.windowEnd,actualAt:actual.at,hit:actualTime>=sourceTime(predicted.windowStart)&&actualTime<=sourceTime(predicted.windowEnd),absoluteErrorHours:Math.abs(actualTime-sourceTime(predicted.predictedAt))/HOUR,trainingObservationIds:trainingIds(training)});
 }
 return {...backtestSummary(entries),mode:'retrospective',entries,recent:backtestSummary(entries.slice(-8)),explanation:`按历史原帖时间逐点回测，每个起点固定取此前最近最多${lookback}个已完成间隔；完整回测及最近8个起点分别报告。历史记录可能事后回填，区间命中率不是实时前瞻实测准确率，个人到账未观测。`};
}

/**
 * Execute the next-announcement forecast using the supplied history as of cutoff.
 * Null probabilities/times are deliberate for insufficient support or a pause.
 * validUntil is a freshness bound, never the reset deadline or an outcome claim.
 */
export function buildResetCadenceForecast(input:ResetCadenceInput):ResetCadenceForecast {
 const generated=sourceTime(input.generatedAt);
 if(!Number.isFinite(generated))throw new Error('预测生成时间无效');
 if(!input.inputFingerprint?.trim())throw new Error('预测输入指纹不能为空');
 const lookback=input.lookbackIntervals??RESET_CADENCE_DEFAULT_LOOKBACK;
 if(![8,12,20,30].includes(lookback))throw new Error('预测近期窗口无效');
 const normalized=normalizeObservations(input.observations,generated),observations=normalized.observations,historical=allIntervals(observations),training=historical.slice(-lookback),anchor=observations.at(-1)?.at??null;
 const result=estimate(training,anchor?sourceTime(anchor):generated,generated);
 const status=input.paused?'paused':result.status;
 const explanation=input.paused?(input.pauseReason?.trim()||'采集来源暂不可用，停止输出新的预测。'):!anchor?'没有可用的公开重置历史，不输出纯先验预测。':training.length<RESET_CADENCE_MIN_INTERVALS?`只有${training.length}个可用间隔，至少需要${RESET_CADENCE_MIN_INTERVALS}个。`:status==='out_of_range'?'本次等待已超过近期全部历史间隔，历史分布没有剩余支持，不延长旧预测。':status==='insufficient'?`超过当前等待时长的历史间隔仅${result.eligibleCount}个，至少需要${RESET_CADENCE_MIN_ELIGIBLE}个，不输出样本不足的概率。`:'根据近期真实公开动态的历史间隔，估计下一次公开重置动态的时间；20%–80%为经验时间范围，24/48小时比例按当前等待时长条件化。不是官方预告或个人到账时间，尚未校准。';
 return {status,id:`forecast_cadence_${input.inputFingerprint.trim()}`,modelVersion:RESET_CADENCE_MODEL_VERSION,inputFingerprint:input.inputFingerprint.trim(),generatedAt:iso(generated),cutoffAt:iso(generated),validUntil:iso(generated+RESET_CADENCE_VALID_HOURS*HOUR),anchorAt:anchor,sampleCount:training.length,lookbackIntervals:lookback,eligibleCount:result.eligibleCount,p24:status==='ready'?result.p24:null,p48:status==='ready'?result.p48:null,predictedAt:status==='ready'?result.predictedAt:null,windowStart:status==='ready'?result.windowStart:null,windowEnd:status==='ready'?result.windowEnd:null,trainingObservationIds:trainingIds(training),trainingIntervals:training,historicalIntervals:historical,...normalized,method:method(lookback),backtest:backtest(observations,lookback),explanation,calibrated:false};
}
