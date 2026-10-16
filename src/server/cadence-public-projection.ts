import {createHash} from 'node:crypto';
import type {StoredCadenceForecast} from './reset-cadence-runtime';
import type {CadenceHorizonOutcome,CadenceEvaluation} from '../lib/forecast';
import {RESET_CADENCE_MODEL_VERSION} from '../lib/reset-cadence';

export const CADENCE_PUBLIC_PROJECTION_VERSION='cadence-public-20261016-1';
export interface CadencePublicProjection {version:typeof CADENCE_PUBLIC_PROJECTION_VERSION;digest:string;snapshots:StoredCadenceForecast[];horizonOutcomes:CadenceHorizonOutcome[];}
const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid public cadence projection');return value as Record<string,unknown>;};
const text=(value:unknown,max=2000):string=>{if(typeof value!=='string'||value.length>max)throw new Error('invalid public cadence text');return value;};
const date=(value:unknown):string=>{const valueText=text(value,60);if(!Number.isFinite(Date.parse(valueText)))throw new Error('invalid public cadence time');return valueText;};
const count=(value:unknown):number=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error('invalid public cadence count');return value;};
const probability=(value:unknown):number|null=>{if(value===null)return null;if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)throw new Error('invalid public cadence probability');return value;};
const nullableNumber=(value:unknown):number|null=>{if(value===null)return null;if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('invalid public cadence number');return value;};
const strings=(value:unknown,max:number):string[]=>{if(!Array.isArray(value)||value.length>max)throw new Error('invalid public cadence identifiers');return value.map(v=>text(v,200));};
const nullableDate=(value:unknown)=>value===null?null:date(value);
const summary=(value:unknown)=>{const row=record(value);return {tests:count(row.tests),hits:count(row.hits),hitRate:probability(row.hitRate),medianAbsoluteErrorHours:nullableNumber(row.medianAbsoluteErrorHours)};};
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Explicit field selection: original evidence, credentials and arbitrary JSON never enter this sidecar. */
function snapshotSummary(value:unknown):StoredCadenceForecast {
 const row=record(value),id=text(row.id,100),target=row.target;
 if(!/^forecast_cadence_[a-f0-9]{64}$/.test(id)||row.recordType!=='reset_cadence'||target!==undefined&&!['automatic_reset','banked_reset'].includes(String(target))||!['ready','paused','insufficient','out_of_range'].includes(String(row.status))||row.calibrated!==false)throw new Error('invalid public cadence snapshot');
 const generatedAt=date(row.generatedAt),cutoffAt=date(row.cutoffAt),validUntil=date(row.validUntil),p24=probability(row.p24),p48=probability(row.p48);
 if(Date.parse(cutoffAt)>Date.parse(generatedAt)||Date.parse(validUntil)<=Date.parse(generatedAt)||Date.parse(validUntil)>Date.parse(generatedAt)+6*3600_000||p24!==null&&p48!==null&&p24>p48)throw new Error('invalid public cadence validity');
 const backtest=record(row.backtest);
 return {id,recordType:'reset_cadence',...(target?{target:target as 'automatic_reset'|'banked_reset'}:{}),status:row.status as StoredCadenceForecast['status'],modelVersion:text(row.modelVersion,100),inputFingerprint:text(row.inputFingerprint,128),generatedAt,cutoffAt,validUntil,anchorAt:nullableDate(row.anchorAt),sampleCount:count(row.sampleCount),lookbackIntervals:count(row.lookbackIntervals) as StoredCadenceForecast['lookbackIntervals'],eligibleCount:count(row.eligibleCount),p24,p48,...(row.rawP24!==undefined?{rawP24:probability(row.rawP24)}:{}),...(row.rawP48!==undefined?{rawP48:probability(row.rawP48)}:{}),predictedAt:nullableDate(row.predictedAt),windowStart:nullableDate(row.windowStart),windowEnd:nullableDate(row.windowEnd),observations:[],trainingObservationIds:[],trainingIntervals:[],historicalIntervals:[],rejectedCount:count(row.rejectedCount),mergedCount:count(row.mergedCount),method:text(row.method),backtest:{...summary(backtest),mode:'retrospective',entries:[],recent:summary(backtest.recent),explanation:text(backtest.explanation)},explanation:text(row.explanation),calibrated:false,sourceIds:strings(row.sourceIds,16),summaryOnly:true};
}
function horizonSummary(value:unknown):CadenceHorizonOutcome {
 const row=record(value),id=text(row.id,100),snapshotId=text(row.snapshotId,100);
 if(!/^forecast_cadence_horizon_[a-f0-9]{64}$/.test(id)||!/^forecast_cadence_[a-f0-9]{64}$/.test(snapshotId)||row.recordType!=='reset_cadence_horizon_outcome'||row.modelVersion!==RESET_CADENCE_MODEL_VERSION||!['automatic_reset','banked_reset'].includes(String(row.target))||![24,48].includes(Number(row.horizonHours))||!['occurred','not_occurred','unknown'].includes(String(row.result))||typeof row.scorable!=='boolean')throw new Error('invalid public cadence outcome');
 const windowStart=date(row.windowStart),windowEnd=date(row.windowEnd),observedAt=date(row.observedAt),actualAt=row.actualAt!==undefined?date(row.actualAt):undefined,evidenceIds=strings(row.evidenceIds,100);
 if(Date.parse(windowEnd)!==Date.parse(windowStart)+Number(row.horizonHours)*3600_000||Date.parse(observedAt)<Date.parse(windowEnd)||actualAt!==undefined&&(Date.parse(actualAt)<=Date.parse(windowStart)||Date.parse(actualAt)>Date.parse(windowEnd))||row.result==='occurred'&&(!actualAt||!evidenceIds.length)||row.result!=='occurred'&&actualAt!==undefined||row.result==='unknown'&&row.scorable)throw new Error('invalid public cadence horizon');
 return {id,recordType:'reset_cadence_horizon_outcome',snapshotId,modelVersion:RESET_CADENCE_MODEL_VERSION,target:row.target as CadenceHorizonOutcome['target'],horizonHours:row.horizonHours as 24|48,windowStart,windowEnd,observedAt,result:row.result as CadenceHorizonOutcome['result'],scorable:row.scorable,...(actualAt!==undefined?{actualAt}:{}),evidenceIds,reason:text(row.reason),...(row.supersedes!==undefined?{supersedes:text(row.supersedes,100)}:{})};
}
export function createCadencePublicProjection(snapshots:unknown[],horizonOutcomes:unknown[]):CadencePublicProjection {
 if(snapshots.length>14||horizonOutcomes.length>28)throw new Error('public cadence capacity');
 const safe={version:CADENCE_PUBLIC_PROJECTION_VERSION as typeof CADENCE_PUBLIC_PROJECTION_VERSION,snapshots:snapshots.map(snapshotSummary).sort((a,b)=>a.id.localeCompare(b.id)),horizonOutcomes:horizonOutcomes.map(horizonSummary).sort((a,b)=>a.id.localeCompare(b.id))};
 if(Buffer.byteLength(JSON.stringify(safe))>128*1024)throw new Error('public cadence capacity');
 return {...safe,digest:fingerprint(safe)};
}
export function parseCadencePublicProjection(value:unknown,timestamp:string):CadencePublicProjection {
 const row=record(value);if(row.version!==CADENCE_PUBLIC_PROJECTION_VERSION||!Array.isArray(row.snapshots)||!Array.isArray(row.horizonOutcomes))throw new Error('unsupported public cadence projection');
 const safe=createCadencePublicProjection(row.snapshots,row.horizonOutcomes),now=Date.parse(timestamp);
 if(row.digest!==safe.digest||!Number.isFinite(now)||safe.snapshots.some(s=>Date.parse(s.generatedAt)>now)||safe.horizonOutcomes.some(o=>Date.parse(o.observedAt)>now||o.actualAt!==undefined&&Date.parse(o.actualAt)>now))throw new Error('stale public cadence projection');
 return safe;
}
export function publicCadenceEvaluation(value:unknown):CadenceEvaluation {
 const row=record(value);if(row.modelVersion!==RESET_CADENCE_MODEL_VERSION||row.calibrated!==false||row.externalWeight!==0)throw new Error('invalid public cadence evaluation');
 const maturedSamples=count(row.maturedSamples),positiveSamples=count(row.positiveSamples),unknownSamples=count(row.unknownSamples);
 if(positiveSamples>maturedSamples||row.skill!==null&&(typeof row.skill!=='number'||!Number.isFinite(row.skill)||row.skill>1))throw new Error('invalid public cadence score');
 return {modelVersion:RESET_CADENCE_MODEL_VERSION,maturedSamples,positiveSamples,unknownSamples,brierScore:probability(row.brierScore),baselineBrierScore:probability(row.baselineBrierScore),skill:row.skill as number|null,calibrated:false,externalWeight:0,explanation:text(row.explanation)};
}
