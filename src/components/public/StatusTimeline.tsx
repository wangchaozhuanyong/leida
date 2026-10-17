'use client';
import type {ResetOutlook} from '@/lib/reset-outlook';
import type {BenefitAction} from '@/lib/types';
import type {ForecastPublicData} from '@/lib/forecast';
import {activeResetWatch} from '@/lib/reset-watch';
import {cadenceDisplay,cadenceForTarget} from '@/lib/cadence-display';
import {announcementCountdown, completionElapsed} from './model';
import {usePublicClock} from './PublicSession';
import {NeuralNetworkArt} from './NeuralNetworkArt';

type Completion = Pick<BenefitAction, 'kind' | 'stage' | 'statementAt'> | null | undefined;

/** Only the current evidenced stage is marked; the line is not a history of inferred steps. */
export function statusTimelineModel(outlook: ResetOutlook, now: string, completion: Completion = outlook.latestCompletion, forecasts?: ForecastPublicData) {
  const active = outlook.active;
  const countdown = active ? announcementCountdown(active, now) : undefined;
  const completed = active ? undefined : completionElapsed(completion, now);
  const scheduled = countdown?.status === 'upcoming';
  const overdue = countdown?.status === 'expired';
  const banked = (active ?? completion)?.kind === 'banked_reset';
  const minutes = scheduled ? Math.ceil((Date.parse(active!.expectedAt!) - Date.parse(now)) / 60000) : 0;
  const resolvedAt=outlook.lastResolved?.resolvedAt??outlook.lastResolved?.statementAt??completion?.statementAt;
  const signal=!active?activeResetWatch(forecasts?.watch,now,resolvedAt):undefined;
  const estimate=cadenceDisplay(cadenceForTarget(forecasts,'automatic_reset'),now,'automatic_reset');
  const base = {
    watching:false,estimating:false,detail:'',sourceUrl:'',
    scheduled, completed: !!completed,
    lead: scheduled ? /^原文近似时间/.test(active?.timeNote ?? '') ? '预计约' : /^原文预计时刻/.test(active?.timeNote ?? '') ? '预计剩余' : '距离预计最晚时间' : completed ? '公开完成声明' : outlook.status === 'cancelled' ? '上轮安排已取消' : '公开动态追踪',
    title: scheduled ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : overdue ? '等待确认' : active ? active.stage === 'in_progress' ? banked ? '发卡进行中' : '重置进行中' : '时间待明确' : completed ? banked ? '已确认发放重置卡' : '已确认重置' : forecasts ? '等待新消息' : '等待预告',
    note: scheduled ? `预计 ${new Date(Date.parse(active!.expectedAt!) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')}` : overdue ? '已过预计时间，待公开确认' : active ? '有明确安排后，自动更新' : completed ? `${completed.label} · 以公开完成公告为准` : forecasts?.watch?.status==='unavailable'?'信号来源暂不可用，稍后自动检查':'暂无明确预告，持续关注公开消息',
    currentStage: overdue ? -1 : active ? active.stage === 'in_progress' ? 1 : 0 : completed ? 2 : -1,
    stages: ['公开预告', banked ? '发卡进行' : '重置进行', '完成确认'],
  };
  if(signal)return {...base,watching:true,completed:false,lead:'重置信号观察',title:'发现重置信号',note:`观察截至 ${new Date(Date.parse(signal.expiresAt)+8*3600_000).toISOString().slice(0,16).replace('T',' ')}`,detail:'AI 信号推测，尚无明确预告',sourceUrl:signal.sourceUrl,currentStage:-1};
  if(!active&&!completed&&estimate.ready)return {...base,estimating:true,lead:'下一次重置参考',title:'预计重置时间',note:estimate.rangeLabel,detail:'根据历史间隔估算，非官方安排',currentStage:-1};
  return base;
}

export function StatusTimeline({outlook, serverTime, completion = outlook.latestCompletion, forecasts}: {outlook: ResetOutlook; serverTime: string; completion?: Completion; forecasts?: ForecastPublicData}) {
  const now = usePublicClock(serverTime);
  const model = statusTimelineModel(outlook, now, completion, forecasts);
  return <section className={`pub-status-timeline${model.completed ? ' is-completed' : ''}${model.scheduled ? ' is-scheduled' : ''}${model.watching?' is-watching':''}${model.estimating?' is-estimating':''}`} aria-label="公开重置进展">
    <div className="pub-timeline-overview">
      <div className="pub-timeline-copy">
        <div className="pub-timeline-head">{model.lead}</div>
        <div className="pub-timeline-row"><h1>{model.title}{model.scheduled && <small>小时 : 分钟</small>}</h1></div>
        <p className="pub-timeline-note">{model.note}</p>
        <p className="pub-timeline-timezone">北京时间</p>
        {model.detail&&<p className="pub-timeline-detail">{model.detail}</p>}
      </div>
      <NeuralNetworkArt/>
    </div>
    {model.watching&&<div className="pub-watch-source"><a href={model.sourceUrl} target="_blank" rel="noopener noreferrer">查看信号原帖 ↗</a><a href="https://codex-resets.com/" target="_blank" rel="noopener noreferrer">数据来自 Codex Resets ↗</a></div>}
    <ol className="pub-timeline-stages" aria-label="公开进展阶段">{model.stages.map((stage, i) => <li key={stage} className={model.currentStage === i ? 'current' : undefined} aria-current={model.currentStage === i ? 'step' : undefined}>{stage}</li>)}</ol>
  </section>;
}
