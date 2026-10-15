import {list,one} from '../db';
import {validReplayId,type ReplayRun,type ReplayStep} from '../lib/historical-replay';
import {publicCached} from './public-cache';

const isRun=(row:ReplayRun)=>row?.recordType==='historical_replay_run'&&validReplayId(row.runId)&&row.status==='complete'&&Number.isSafeInteger(row.totalSteps)&&row.totalSteps>0&&row.completedSteps===row.totalSteps;
export async function publicReplayRuns(){
  return publicCached('historical-replay:runs',async()=>(await list<ReplayRun>('settings')).filter(isRun).sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt)).map(({runId,window,recordedAt,messageCount,totalSteps,coverage})=>({runId,window,recordedAt,messageCount,totalSteps,coverage})));
}
export async function publicReplayStep(runId:string,index?:string){
  if(!validReplayId(runId))throw Object.assign(new Error('回放记录链接无效'),{status:400});
  if(index!==undefined&&!/^(?:0|[1-9]\d{0,6})$/.test(index))throw Object.assign(new Error('回放步骤无效'),{status:400});
  return publicCached(`historical-replay:${runId}:${index??'last'}`,async()=>{
    const stored=await one<ReplayRun>('settings','history_'+runId);
    if(!stored||!isRun(stored))throw Object.assign(new Error('未找到已完成的历史回放'),{status:404});
    const at=index===undefined?stored.totalSteps-1:Number(index);
    if(at>=stored.totalSteps)throw Object.assign(new Error('回放步骤超出范围'),{status:404});
    const step=await one<ReplayStep>('forecast_snapshots',`replay_step_${runId}_${at}`);
    if(step?.recordType!=='historical_replay_step'||step.runId!==runId||step.index!==at)throw Object.assign(new Error('回放记录暂不可用'),{status:503});
    // Earlier steps do not return final outcomes or final scores.
    const {runId:id,window,recordedAt,messageCount,totalSteps,coverage}=stored;
    const run={runId:id,window,recordedAt,messageCount,totalSteps,coverage,...(at===stored.totalSteps-1?{scores:stored.scores,announcement:stored.announcement,announcementCases:stored.announcementCases}:{})};
    return {run,step};
  });
}
