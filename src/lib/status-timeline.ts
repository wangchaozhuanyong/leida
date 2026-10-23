import {publicationWithdrawn} from './public-facts';
import type {ResetOutlook} from './reset-outlook';
import type {BenefitAction,PublicData} from './types';
import type {ForecastPublicData} from './forecast';
import {activeResetWatch,activeResetSchedule,resetWatchWindow} from './reset-watch';
import {announcementCountdown,completionElapsed,latestCompletedBenefits} from '../components/public/model';
import {publicResetOutlook} from './reset-outlook';
import {timelineObservation} from './reset-observations';
const beijing=(value:string)=>new Date(Date.parse(value)+8*3600_000).toISOString().slice(0,16).replace('T',' ');

export type Completion = Pick<BenefitAction, 'kind' | 'stage' | 'statementAt'> | null | undefined;

/** Display whole minutes without suggesting second-level precision. */
export function countdownParts(expectedAt:string, now:string): {value:number;unit:string}[] {
  const minutes = Math.max(0, Math.floor((Date.parse(expectedAt) - Date.parse(now)) / 60000));
  if (minutes < 1) return [];
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return [...(days ? [{value: days, unit: '天'}] : []), ...(days || hours ? [{value: hours, unit: '小时'}] : []), {value: minutes % 60, unit: '分钟'}];
}

/** Only the current evidenced stage is marked; the line is not a history of inferred steps. */
function resolveStatusTimeline(outlook: ResetOutlook, now: string, completion: Completion = outlook.latestCompletion, forecasts?: ForecastPublicData) {
  const resolvedAt=outlook.lastResolved?.kind==='automatic_reset'?(outlook.lastResolved.resolvedAt??outlook.lastResolved.statementAt):outlook.latestGlobalCompletionAt??(completion?.kind==='automatic_reset'?completion.statementAt:undefined);
  const candidate=activeResetSchedule(forecasts?.watch,now);
  const resolution=candidate?(outlook.latestResolutions?.[candidate.kind]??(outlook.lastResolved?.kind===candidate.kind?outlook.lastResolved:undefined)??(completion?.kind===candidate.kind?completion:undefined)):undefined;
  const sameResolved=candidate&&resolution&&Date.parse(candidate.announcedAt)<=Date.parse(resolution.statementAt);
  const remote=candidate&&!sameResolved&&(!outlook.active||Date.parse(candidate.announcedAt)>Date.parse(outlook.active.statementAt))?candidate:undefined;
  const active = remote?{kind:remote.kind,stage:'promised' as const,statementAt:remote.announcedAt,expectedAt:remote.scheduledFor??undefined,timeNote:'',publicationId:''}:outlook.active;
  const countdown = active ? announcementCountdown(active, now) : undefined;
  const completed = active || Date.parse(now)-Date.parse(completion?.statementAt??'')>=24*3600000 ? undefined : completionElapsed(completion, now);
  const scheduled = countdown?.status === 'upcoming';
  const overdue = countdown?.status === 'expired';
  const banked = (active ?? completion)?.kind === 'banked_reset';
  const duration = scheduled ? countdownParts(active!.expectedAt!, now) : [];
  const signal=!active?activeResetWatch(forecasts?.watch,now,resolvedAt):undefined;
  const referenceSignal=!active&&forecasts?.referenceSignal&&Date.parse(forecasts.referenceSignal.publishedAt)<=Date.parse(now)&&(!resolvedAt||Date.parse(forecasts.referenceSignal.publishedAt)>Date.parse(resolvedAt))?forecasts.referenceSignal:undefined;
  const deadlineNote=active?.timeNote??'';
  const timing=/(?:日终|最晚|之前|以内|截止|\bby\b|\bwithin\b)/i.test(deadlineNote)?'deadline':/^原文近似时间/.test(deadlineNote)?'approximate':'point';
  const timingLabel=timing==='deadline'?'预计最晚':timing==='approximate'?'预计约':'预计';
  const base = {
    sourceName:'Codex Resets',watching:false,estimating:false,detail:overdue?'预计时间已到，等待公开完成确认。':scheduled?'预计时间仅供参考，以实际发放为主。':'',sourceUrl:remote?.sourceUrl??'',sourceType:remote?.sourceType??'x_post',sourceCredit:!!remote,sourceId:remote?.id??'',forecastWindow:'',chanceLabel:'',observedLabel:'',expiresAt:'',
    publicationId:active?.publicationId??'',statementAt:active?.statementAt??(completed?completion?.statementAt??'':''),expectedAt:active?.expectedAt??'',kind:(active??completion)?.kind??'automatic_reset',
    scheduled, overdue, countdownParts: duration, completed: !!completed,
    lead: scheduled ? timing==='deadline'?'距离预计最晚时间':timing==='approximate'?'距离预计时间（约）':'距离预计安排时间' : completed ? '公开完成声明' : outlook.status === 'cancelled' ? '上轮安排已取消' : '公开动态追踪',
    title: scheduled ? duration.length ? duration.map(part => `${part.value}${part.unit}`).join('') : '不足1分钟' : overdue ? '等待确认' : active ? active.stage === 'in_progress' ? banked ? '发卡进行中' : '重置进行中' : '时间待明确' : completed ? banked ? '已确认发放重置卡' : '已确认重置' : '等待下一次 Reset',
    note: scheduled || overdue ? `${overdue ? '原'+timingLabel : timingLabel} ${beijing(active!.expectedAt!)}${timing==='deadline'?' 前':timing==='approximate'?' 左右':''}` : active ? active.stage==='in_progress'?'公开消息称已开始，完成情况等待后续声明。':'已公布相关安排，具体时间仍待说明。' : completed ? '本轮已有公开完成声明，等待下一次预告' : forecasts?.status==='unavailable'||forecasts?.watch?.status==='unavailable'?'信号来源暂不可用，恢复后自动检查':'有新的重置信号后更新',
    currentStage: overdue ? -1 : active ? active.stage === 'in_progress' ? 1 : 0 : completed ? 2 : -1,
    stages: ['公开预告', banked ? '发卡进行' : '重置进行', '完成确认'],
  };
  if(referenceSignal)return {...base,sourceName:referenceSignal.sourceName,watching:true,completed:false,lead:'公开信号观察',title:'发现公开重置信号',note:`信号发布于 ${beijing(referenceSignal.publishedAt)}`,detail:'来源已收录这条公开暗示，发放安排尚未明确。',sourceUrl:referenceSignal.sourceUrl,sourceType:'x_post',sourceCredit:true,statementAt:referenceSignal.publishedAt,observedLabel:`来源收录于 ${beijing(referenceSignal.recordedAt)}`,forecastWindow:'',currentStage:-1};
  if(signal)return {...base,watching:true,completed:false,lead:'重置信号观察',title:'发现重置信号',note:`观察有效至 ${beijing(signal.expiresAt)}`,detail:signal.sourceType==='observed'?'来源观察记录，尚无明确预告':'AI 信号推测，尚无明确预告',sourceUrl:signal.sourceUrl??'',sourceType:signal.sourceType??'x_post',sourceCredit:true,statementAt:signal.observedAt,observedLabel:`信号时间 ${beijing(signal.observedAt)}`,expiresAt:signal.expiresAt,forecastWindow:resetWatchWindow(signal.forecastWindow),chanceLabel:typeof signal.chancePercent==='number'?`上游信号概率 ${signal.chancePercent}%`:'',currentStage:-1};
  // Historical cadence is not evidence that a new reset is approaching.
  // Keep it in the experimental records, never as a current homepage fallback.
  return base;
}


/** Presentation only: use the resolved event state, never infer a new prediction or type. */
function statusPresentation(model:ReturnType<typeof resolveStatusTimeline>) {
  const kind=model.kind==='banked_reset'?'重置卡':'额度重置';
  if(model.watching)return {tone:model.forecastWindow?'purple':'blue',badge:model.forecastWindow?'信号推测':'信号观察',heading:'发现重置相关信号',kind:'公开线索'};
  if(model.scheduled)return {tone:'blue',badge:'时间已公布',heading:model.kind==='banked_reset'?'预计发放重置卡':'预计额度重置',kind};
  if(model.overdue)return {tone:'amber',badge:'等待确认',heading:'预计时间已到，等待确认',kind};
  if(model.completed)return {tone:'green',badge:'公开完成',heading:model.kind==='banked_reset'?'重置卡发放已确认':'额度重置已确认',kind};
  if(model.currentStage===1)return {tone:'green',badge:'进行中',heading:model.kind==='banked_reset'?'重置卡发放进行中':'额度重置进行中',kind};
  if(model.currentStage===0)return {tone:'blue',badge:'已预告',heading:model.kind==='banked_reset'?'已预告发放重置卡':'已预告额度重置',kind};
  if(model.lead==='上轮安排已取消')return {tone:'muted',badge:'已取消',heading:'本轮安排已取消',kind:'公开动态'};
  return {tone:'muted',badge:'等待新消息',heading:'等待下一次 Reset',kind:'公开动态追踪'};
}
export function statusTimelineModel(outlook:ResetOutlook,now:string,completion:Completion=outlook.latestCompletion,forecasts?:ForecastPublicData) {
  const observation=timelineObservation(outlook,now,completion);
  if(observation&&!activeResetSchedule(forecasts?.watch,now)){
    const model=resolveStatusTimeline(outlook,now,{kind:'automatic_reset',stage:'claimed_complete',statementAt:observation.observedAt},forecasts?{...forecasts,referenceSignal:undefined,watch:undefined}:undefined);
    return {...model,sourceName:observation.sourceName,sourceUrl:observation.sourceUrl,sourceType:'observed' as const,sourceCredit:true,publicationId:observation.publicationId,statementAt:observation.observedAt,note:'第三方来源记录了用量重置；个人到账尚未核验。',presentation:{tone:'green',badge:'来源观测',heading:'来源观测：用量已重置',kind:'额度重置'}};
  }
  const model=resolveStatusTimeline(outlook,now,completion,forecasts);
  return {...model,presentation:statusPresentation(model)};
}

/** Stable during a countdown; changes on state, source, round or expiry transitions. */
export function statusTimelineRevision(model:ReturnType<typeof statusTimelineModel>):string {
  return 'state:'+JSON.stringify([model.publicationId,model.sourceId,model.kind,model.statementAt,model.expectedAt,model.sourceUrl,model.sourceType,model.sourceCredit,model.watching,model.currentStage,model.scheduled,model.completed,model.forecastWindow,model.chanceLabel,model.expiresAt,model.scheduled||model.completed?'':model.title,model.completed?'':model.note]);
}
export function currentStatusModel(data:PublicData,now=data.serverTime) {
  return statusTimelineModel(data.forecasts?.outlook??publicResetOutlook({...data,serverTime:now}),now,latestCompletedBenefits({...data,serverTime:now})[0]?.action??null,data.forecasts);
}

/** One immutable input for both fixed skins; current status agrees with the homepage. */
export function statusPosterSnapshot(data:PublicData,now=data.serverTime) {
  const model=currentStatusModel(data,now),latest=latestCompletedBenefits({...data,serverTime:now})[0];
  const publicationId=model.publicationId||(model.completed?latest?.publication.id??'':'');
  // The entry code may open a visible recent message without making that
  // message the current benefit announcement or changing the status round.
  const entry=data.publications.find(p=>!publicationWithdrawn(data,p)&&p.event.status!=='merged'&&!data.events.some(e=>e.id===p.eventId&&e.status==='merged'));
  const codePublicationId=publicationId||entry?.id||'';
  const minutes=model.completed?Math.max(0,Math.floor((Date.parse(now)-Date.parse(model.statementAt))/60000)):0;
  const value=model.completed?(minutes<1?'刚刚':String(minutes<60?minutes:minutes<1440?Math.floor(minutes/60):Math.floor(minutes/1440))):model.watching?'观察中':model.title;
  const unit=model.completed&&minutes>=1?(minutes<60?'分钟':minutes<1440?'小时':'天'):'';
  return {round:statusTimelineRevision(model),publicationId,codePublicationId,generatedAt:now,
    title:model.scheduled?(model.kind==='banked_reset'?'重置卡发放预告':'用量重置预告'):model.completed?(model.sourceType==='observed'?'来源观测：用量已重置':model.kind==='banked_reset'?'公告称已发放重置卡':'公告称已重置用量'):model.title,
    label:model.completed?(model.sourceType==='observed'?'距来源观测':'距该公告'):model.scheduled?model.lead:'当前公开状态',value,unit,statementAt:model.statementAt,statementLabel:model.completed&&model.sourceType==='observed'?'观测时间':model.watching?'信号时间':'公告时间',
    nextNote:model.watching?(model.forecastWindow?`发布时预计：${model.forecastWindow}${model.chanceLabel?` · ${model.chanceLabel}`:''}`:'公开信号记录，尚无明确发放时间。'):model.scheduled?model.note.replace(/ (\d{2}:\d{2})$/,'\n$1'):model.note,
    sourceLabel:model.sourceCredit?model.sourceType==='observed'?`来源：${model.sourceName} 观察记录`:`来源：${model.sourceName} · Tibo 公开动态`:model.completed?'依据：所选公开完成公告':'依据：当前公开状态',
    validUntil:model.scheduled?model.expectedAt:model.watching?model.expiresAt:model.completed?new Date(Date.parse(model.statementAt)+24*3600_000).toISOString():'',
  };
}
