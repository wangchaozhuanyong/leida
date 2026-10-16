'use client';
import type {ResetOutlook} from '@/lib/reset-outlook';
import type {BenefitAction} from '@/lib/types';
import {announcementCountdown, completionElapsed} from './model';
import {usePublicClock} from './PublicSession';
import {NeuralNetworkArt} from './NeuralNetworkArt';

type Completion = Pick<BenefitAction, 'kind' | 'stage' | 'statementAt'> | null | undefined;

/** Only the current evidenced stage is marked; the line is not a history of inferred steps. */
export function statusTimelineModel(outlook: ResetOutlook, now: string, completion: Completion = outlook.latestCompletion) {
  const active = outlook.active;
  const countdown = active ? announcementCountdown(active, now) : undefined;
  const completed = active ? undefined : completionElapsed(completion, now);
  const scheduled = countdown?.status === 'upcoming';
  const overdue = countdown?.status === 'expired';
  const banked = (active ?? completion)?.kind === 'banked_reset';
  const minutes = scheduled ? Math.ceil((Date.parse(active!.expectedAt!) - Date.parse(now)) / 60000) : 0;
  return {
    scheduled, completed: !!completed,
    lead: scheduled ? /^原文近似时间/.test(active?.timeNote ?? '') ? '预计约' : /^原文预计时刻/.test(active?.timeNote ?? '') ? '预计剩余' : '距离预计最晚时间' : completed ? '公开完成声明' : outlook.status === 'cancelled' ? '上轮安排已取消' : '公开动态追踪',
    title: scheduled ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : overdue ? '等待确认' : active ? active.stage === 'in_progress' ? banked ? '发卡进行中' : '重置进行中' : '时间待明确' : completed ? banked ? '已确认发放重置卡' : '已确认重置' : '等待预告',
    note: scheduled ? `预计 ${new Date(Date.parse(active!.expectedAt!) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')}` : overdue ? '已过预计时间，待公开确认' : active ? '有明确安排后，自动更新' : completed ? `${completed.label} · 以公开完成公告为准` : '暂无下一次明确时间',
    currentStage: overdue ? -1 : active ? active.stage === 'in_progress' ? 1 : 0 : completed ? 2 : -1,
    stages: ['公开预告', banked ? '发卡进行' : '重置进行', '完成确认'],
  };
}

export function StatusTimeline({outlook, serverTime, completion = outlook.latestCompletion}: {outlook: ResetOutlook; serverTime: string; completion?: Completion}) {
  const now = usePublicClock(serverTime);
  const model = statusTimelineModel(outlook, now, completion);
  return <section className={`pub-status-timeline${model.completed ? ' is-completed' : ''}${model.scheduled ? ' is-scheduled' : ''}`} aria-label="公开重置进展">
    <NeuralNetworkArt/>
    <div className="pub-timeline-head"><span>{model.lead}</span><span>北京时间</span></div>
    <div className="pub-timeline-row"><h1>{model.title}{model.scheduled && <small>小时 : 分钟</small>}</h1><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19V5M3 15l5-5 4 3 8-9M15 4h5v5"/></svg></div>
    <p className="pub-timeline-note">{model.note}</p>
    <ol className="pub-timeline-stages" aria-label="公开进展阶段">{model.stages.map((stage, i) => <li key={stage} className={model.currentStage === i ? 'current' : undefined} aria-current={model.currentStage === i ? 'step' : undefined}>{stage}</li>)}</ol>
  </section>;
}
