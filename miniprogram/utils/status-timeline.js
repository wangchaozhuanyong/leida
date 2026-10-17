const { announcementCountdown, completionElapsed, displayTime, activeResetWatch } = require('./model');
const { cadenceModel } = require('./cadence');

// Keep the native presentation aligned with StatusTimeline; no inferred past stages.
function statusTimelineModel(outlook, now, completion = outlook.latestCompletion, forecasts) {
  const active = outlook.active;
  const countdown = active ? announcementCountdown(active, now) : null;
  const completed = active ? null : completionElapsed(completion, now);
  const scheduled = !!countdown && countdown.status === 'upcoming';
  const overdue = !!countdown && countdown.status === 'expired';
  const banked = (active || completion || {}).kind === 'banked_reset';
  const minutes = scheduled ? Math.ceil((Date.parse(active.expectedAt) - Date.parse(now)) / 60000) : 0;
  const resolvedAt=outlook.lastResolved && (outlook.lastResolved.resolvedAt || outlook.lastResolved.statementAt) || completion && completion.statementAt;
  const signal=!active && activeResetWatch(forecasts && forecasts.watch,now,resolvedAt);
  const estimate=!active && !signal && !completed ? cadenceModel(forecasts,now) : null;
  const estimating=!!estimate && estimate.ready;
  const base = {
    scheduled, completed: !!completed && !signal, watching:!!signal, estimating, detail:'', sourceUrl:'',
    lead: scheduled ? /^原文近似时间/.test(active.timeNote || '') ? '预计约' : /^原文预计时刻/.test(active.timeNote || '') ? '预计剩余' : '距离预计最晚时间' : completed ? '公开完成声明' : outlook.status === 'cancelled' ? '上轮安排已取消' : '公开动态追踪',
    title: scheduled ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : overdue ? '等待确认' : active ? active.stage === 'in_progress' ? banked ? '发卡进行中' : '重置进行中' : '时间待明确' : completed ? banked ? '已确认发放重置卡' : '已确认重置' : forecasts ? '等待新消息' : '等待预告',
    note: scheduled ? `预计 ${displayTime(active.expectedAt)}` : overdue ? '已过预计时间，待公开确认' : active ? '有明确安排后，自动更新' : completed ? `${completed.label} · 以公开完成公告为准` : forecasts && forecasts.watch && forecasts.watch.status==='unavailable' ? '信号来源暂不可用，稍后自动检查' : '暂无明确预告，持续关注公开消息',
    currentStage: overdue ? -1 : active ? active.stage === 'in_progress' ? 1 : 0 : completed ? 2 : -1,
    stages: ['公开预告', banked ? '发卡进行' : '重置进行', '完成确认'],
  };
  if(signal)return {...base,lead:'重置信号观察',title:'发现重置信号',note:`观察截至 ${displayTime(signal.expiresAt)}`,detail:'AI 信号推测，尚无明确预告',sourceUrl:signal.sourceUrl,currentStage:-1};
  if(estimating)return {...base,lead:'下一次重置参考',title:'预计重置时间',note:estimate.rangeLabel,detail:'根据历史间隔估算，非官方安排',currentStage:-1};
  return base;
}
module.exports = { statusTimelineModel };
