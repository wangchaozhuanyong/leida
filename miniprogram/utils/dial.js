const { announcementCountdown, completionElapsed } = require('./model');

// A display model of the existing announcement clock, not a second prediction engine.
function dialModel(outlook, now, completion = outlook && outlook.latestCompletion) {
  const active = outlook && outlook.active;
  const completed = active ? null : completionElapsed(completion, now);
  const countdown = active ? announcementCountdown(active, now) : null;
  const scheduled = countdown && countdown.status === 'upcoming';
  const minutes = scheduled ? Math.ceil((Date.parse(active.expectedAt) - Date.parse(now)) / 60000) : 0;
  const beijingAngle = at => {
    const time = new Date(Date.parse(at) + 8 * 3600000);
    return (time.getUTCHours() + time.getUTCMinutes() / 60) * 15;
  };
  const state = countdown && countdown.status === 'expired' ? '等待确认' : active ? active.stage === 'in_progress' ? '重置进行中' : '时间待明确' : '等待预告';
  const time = scheduled ? new Date(Date.parse(active.expectedAt) + 8 * 3600000).toISOString().slice(11, 16) : '';
  return {
    scheduled: !!scheduled,
    completed: !!completed,
    bankedCompleted: !!completed && completion.kind === 'banked_reset',
    elapsedParts: completed ? completed.parts : [],
    elapsedLabel: completed ? completed.label : '',
    elapsedLong: !!completed && completed.parts.reduce((length, part) => length + String(part.value).length, 0) > 3,
    digits: scheduled ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : '',
    long: minutes >= 6000,
    state,
    lead: scheduled ? /^原文近似时间/.test(active.timeNote || '') ? '预计约' : /^原文预计时刻/.test(active.timeNote || '') ? '预计剩余' : '距离预计最晚时间' : completed ? completed.lead : outlook && outlook.status === 'cancelled' ? '上轮安排已取消' : '公开动态追踪',
    note: scheduled ? '小时 : 分钟' : completed ? '以公开完成公告为准' : countdown && countdown.status === 'expired' ? '已过预计时间，待公开确认' : active ? '有明确安排后，自动更新' : '暂无下一次明确时间',
    startAngle: Number.isFinite(Date.parse(now)) ? beijingAngle(now) : 0,
    endAngle: scheduled ? beijingAngle(active.expectedAt) : 0,
    sweep: Math.min(359.9, minutes / 4),
    time,
    accessible: scheduled ? `公开预告：${countdown.label}，北京时间${time}` : completed ? `${completed.lead}：${completed.label}` : `重置雷达：${state}`
  };
}

function drawDial(ctx, size, model) {
  if (!ctx || !size || !model) return;
  const scale = size / 600;
  ctx.clearRect(0, 0, size, size);
  ctx.save(); ctx.scale(scale, scale);
  const circle = (r, color, width) => { ctx.beginPath(); ctx.arc(300, 300, r, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); };
  circle(283, '#343e40', .6); circle(271, '#343e40', .6); circle(255, model.completed ? '#b39151' : '#8b9592', 1); circle(204, '#677472', .8);
  if (model.scheduled) {
    ctx.beginPath(); ctx.arc(300, 300, 255, (model.startAngle - 90) * Math.PI / 180, (model.startAngle + model.sweep - 90) * Math.PI / 180);
    ctx.strokeStyle = '#6a5731'; ctx.lineWidth = 20; ctx.stroke();
  }
  const point = (a, r) => [300 + Math.sin(a * Math.PI / 180) * r, 300 - Math.cos(a * Math.PI / 180) * r];
  const line = (a, r, end, color, width) => { const p = point(a, r), q = point(a, end); ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); };
  for (let i = 0; i < 240; i++) line(i * 1.5, 254, i % 20 === 0 ? 231 : i % 5 === 0 ? 242 : 248, i % 20 === 0 ? '#e6e7df' : '#a8b1ac', i % 20 === 0 ? 1.6 : 1);
  ctx.fillStyle = '#d4d9d4'; ctx.font = '18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  [['00', 0], ['06', 90], ['12', 180], ['18', 270]].forEach(([label, a]) => { const p = point(a, 219); ctx.fillText(label, p[0], p[1]); line(a, 266, 290, '#e9bb5c', 1.2); });
  if (model.scheduled) { const p = point(model.endAngle, 255); ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, Math.PI * 2); ctx.fillStyle = '#f4c15c'; ctx.fill(); }
  ctx.restore();
}
module.exports = { dialModel, drawDial };
