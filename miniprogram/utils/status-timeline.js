const { announcementCountdown, completionElapsed, displayTime } = require('./model');

// Keep the native presentation aligned with StatusTimeline; no inferred past stages.
function statusTimelineModel(outlook, now, completion = outlook.latestCompletion) {
  const active = outlook.active;
  const countdown = active ? announcementCountdown(active, now) : null;
  const completed = active ? null : completionElapsed(completion, now);
  const scheduled = !!countdown && countdown.status === 'upcoming';
  const overdue = !!countdown && countdown.status === 'expired';
  const banked = (active || completion || {}).kind === 'banked_reset';
  const minutes = scheduled ? Math.ceil((Date.parse(active.expectedAt) - Date.parse(now)) / 60000) : 0;
  return {
    scheduled, completed: !!completed,
    lead: scheduled ? /^原文近似时间/.test(active.timeNote || '') ? '预计约' : /^原文预计时刻/.test(active.timeNote || '') ? '预计剩余' : '距离预计最晚时间' : completed ? '公开完成声明' : outlook.status === 'cancelled' ? '上轮安排已取消' : '公开动态追踪',
    title: scheduled ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : overdue ? '等待确认' : active ? active.stage === 'in_progress' ? banked ? '发卡进行中' : '重置进行中' : '时间待明确' : completed ? banked ? '已确认发放重置卡' : '已确认重置' : '等待预告',
    note: scheduled ? `预计 ${displayTime(active.expectedAt)}` : overdue ? '已过预计时间，待公开确认' : active ? '有明确安排后，自动更新' : completed ? `${completed.label} · 以公开完成公告为准` : '暂无下一次明确时间',
    currentStage: overdue ? -1 : active ? active.stage === 'in_progress' ? 1 : 0 : completed ? 2 : -1,
    stages: ['公开预告', banked ? '发卡进行' : '重置进行', '完成确认'],
  };
}
module.exports = { statusTimelineModel };
