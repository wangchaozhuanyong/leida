import type {Evidence,Publication} from './types';
import type {ResetCadenceForecast} from './reset-cadence';
import type {ResetOutlook} from './reset-outlook';

export const REPLAY_VERSION='message-replay-v1';
export interface ReplayRecord extends Omit<Evidence,'id'|'hash'|'historical'> {captureProvenance?:string;}
export interface ReplayInput {
  version:typeof REPLAY_VERSION; window:{start:string;end:string}; capturedAt:string;
  coverage:{complete:false;notes:string[]}; records:ReplayRecord[];
}
export interface ReplayPrediction extends Pick<ResetCadenceForecast,'id'|'status'|'generatedAt'|'cutoffAt'|'validUntil'|'modelVersion'|'p24'|'p48'|'predictedAt'|'windowStart'|'windowEnd'|'sampleCount'|'trainingObservationIds'|'explanation'> {}
export interface ReplayStep {
  id:string;recordType:'historical_replay_step';runId:string;signature:string;
  index:number;kind:'message'|'timer';phase:'warmup'|'evaluation';virtualAt:string;recordedAt:string;
  evidenceId?:string;message?:Pick<ReplayRecord,'sourceId'|'messageId'|'url'|'text'|'publishedAt'|'collectedAt'|'parentId'|'captureProvenance'>;
  prediction?:ReplayPrediction;outlook:ResetOutlook;publications:Publication[];
  inputFingerprint:string;codeFingerprint:string;
}
export interface ReplayScore {
  snapshotId:string;generatedAt:string;predictedAt:string;windowStart:string;windowEnd:string;
  outcome:'unknown'|'public_statement';actualAt?:string;url?:string;absoluteErrorHours?:number;inWindow?:boolean;windowWidthHours:number;
}
export interface ReplayRun {
  id:string;recordType:'historical_replay_run';version:typeof REPLAY_VERSION;runId:string;
  status:'running'|'complete';window:ReplayInput['window'];coverage:ReplayInput['coverage'];
  inputFingerprint:string;codeFingerprint:string;recordedAt:string;updatedAt:string;
  completedSteps:number;totalSteps:number;virtualAt:string;messageCount:number;
  scores?:ReplayScore[];announcement?:{firstTimedRounds:number;pointCases:number;pointWithinOneHour:number;deadlineCases:number;withinDeadline:number;unknownRounds:number;cancelledRounds:number};
  announcementCases?:import('./hourly-prediction-observation').HourlyPredictionCase[];
}
export const validReplayId=(id:string)=>/^replay_[a-f0-9]{24}$/.test(id);
export function replayTimeline(input:ReplayInput):{record?:ReplayRecord;at:string;phase:'warmup'|'evaluation'}[]{
  const start=Date.parse(input.window.start),end=Date.parse(input.window.end);
  if(input.version!==REPLAY_VERSION||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||!Array.isArray(input.records))throw new Error('回放输入无效');
  const keys=new Set<string>();
  const messages=input.records.map(record=>{
    const published=Date.parse(record.publishedAt),captured=Date.parse(record.collectedAt);
    const url=new URL(record.url);
    if(!Number.isFinite(published)||!Number.isFinite(captured)||published>end||!record.text.trim()||!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('回放消息时间或来源无效');
    const key=record.sourceId+':'+record.messageId;
    if(keys.has(key))throw new Error('回放输入包含重复身份');keys.add(key);
    // This is an explicit simulated discovery time; collectedAt stays factual.
    return {record,at:new Date(Math.min(end,Math.ceil(published/120_000)*120_000)).toISOString(),phase:published<start?'warmup' as const:'evaluation' as const};
  }).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||Date.parse(a.record.publishedAt)-Date.parse(b.record.publishedAt)||a.record.sourceId.localeCompare(b.record.sourceId)||a.record.messageId.localeCompare(b.record.messageId,undefined,{numeric:true}));
  const timers:{at:string;phase:'evaluation'}[]=[];
  for(let at=start;at<end;at+=6*3600_000)timers.push({at:new Date(at).toISOString(),phase:'evaluation'});
  timers.push({at:new Date(end).toISOString(),phase:'evaluation'});
  return [...messages,...timers].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||Number(!('record' in a))-Number(!('record' in b)));
}
/** One first ready prediction per next observed announcement interval. Unknown
 * tails are retained. Later, closer snapshots never replace the scored origin. */
export function scoreReplay(steps:ReplayStep[],observations:{at:string;url:string}[],window:ReplayInput['window']):ReplayScore[]{
  const result:ReplayScore[]=[],groups=new Set<string>();
  const actuals=observations.filter(row=>Date.parse(row.at)<=Date.parse(window.end)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  for(const step of [...steps].sort((a,b)=>a.index-b.index)){
    const p=step.prediction;
    if(step.phase!=='evaluation'||p?.status!=='ready'||!p.predictedAt||!p.windowStart||!p.windowEnd||Date.parse(p.generatedAt)<Date.parse(window.start))continue;
    const actual=actuals.find(o=>Date.parse(o.at)>Date.parse(p.generatedAt));
    const key=actual?.at??'unresolved-tail';if(groups.has(key))continue;groups.add(key);
    const score:ReplayScore={snapshotId:p.id,generatedAt:p.generatedAt,predictedAt:p.predictedAt,windowStart:p.windowStart,windowEnd:p.windowEnd,windowWidthHours:(Date.parse(p.windowEnd)-Date.parse(p.windowStart))/3600_000,outcome:actual?'public_statement':'unknown'};
    if(actual)Object.assign(score,{actualAt:actual.at,url:actual.url,absoluteErrorHours:Math.abs(Date.parse(actual.at)-Date.parse(p.predictedAt))/3600_000,inWindow:Date.parse(actual.at)>=Date.parse(p.windowStart)&&Date.parse(actual.at)<=Date.parse(p.windowEnd)});
    result.push(score);
  }
  return result;
}
