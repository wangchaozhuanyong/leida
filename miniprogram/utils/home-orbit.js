const { countdownParts } = require('./status-timeline');

// Homepage presentation only. Evidence classification remains in reset-state-cards.
function elapsedClock(at, now) {
  const start = Date.parse(at), end = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return { parts: [], metric: '' };
  const elapsed = countdownParts(now, at);
  if (!elapsed.length) return { parts: [], metric: '刚刚' };
  const units = elapsed.some(part => part.unit === '天') ? ['天', '小时', '分钟'] : ['小时', '分钟'];
  return {
    parts: units.map(unit => ({ unit, value: String(elapsed.find(part => part.unit === unit)?.value || 0).padStart(2, '0') })),
    metric: elapsed.map(part => part.value + part.unit).join('')
  };
}

function homeOrbitPresentation(card, now) {
  const banked = card.kind === 'banked_reset';
  const subject = banked ? '重置卡发放' : '额度重置';
  const view = { title: '等待下一次预告', label: '公开消息追踪', badge: '等待新消息', tone: 'slate',
    description: '暂无新的明确安排，有可靠消息后更新。', footnote: '个人账户请以实际显示为准。',
    parts: [], metric: '', long: false, animated: true, timeLabel: card.timeLabel || '', symbol: '◎' };
  switch (card.state) {
    case 'signal':
      Object.assign(view, { title: '安排待明确', label: '发现公开线索', badge: '信号观察', tone: 'violet', symbol: '◎',
        description: card.description, footnote: '公开线索不等于明确预告。' });
      break;
    case 'estimated':
      Object.assign(view, { title: card.window || '近期可能更新', label: '信号发布时推测', badge: '推测 · 非明确预告', tone: 'violet',
        description: card.description, footnote: '保留信号发布时的推测范围，不作为发放倒计时。' });
      break;
    case 'announced':
      Object.assign(view, { title: '时间待公布', label: '已有' + subject + '预告', badge: '已发布预告', tone: 'blue',
        description: '已公布相关安排，具体时间仍待说明。', footnote: '有明确时间后，将展示预计安排。' });
      break;
    case 'scheduled':
    case 'revised':
      Object.assign(view, { title: '', label: card.metricLabel, badge: card.state === 'revised' ? '安排已调整' : '时间已公布',
        tone: 'blue', parts: card.clockParts || [], metric: card.metric || '', symbol: '◷',
        description: card.state === 'revised' ? '公开安排已更新，按最新时间持续关注。' : '已有' + subject + '预告，正在持续关注。',
        footnote: '预计时间仅供参考，请以实际发放为准。' });
      break;
    case 'progress':
      Object.assign(view, { title: banked ? '重置卡正在发放' : '额度重置进行中', label: '收到公开进展', badge: '等待完成声明', tone: 'teal',
        description: '公开消息称已开始，正在持续核对完成消息。', footnote: '实际到账进度请查看个人账户。' });
      break;
    case 'overdue': {
      const clock = elapsedClock(card.timeAt, now);
      Object.assign(view, { title: '', label: clock.metric === '刚刚' ? '已到原预计时间' : '原预计时间已过',
        parts: clock.parts, metric: clock.metric === '刚刚' ? '刚到预计时间' : clock.metric || '时间待核对',
        badge: '完成消息待确认', tone: 'amber', symbol: '◷',
        description: '已有重置预告，正在持续核对完成消息。',
        footnote: banked ? '重置卡可能已到账，请以实际账户为准。' : '账户额度可能已恢复，请以实际额度为准。' });
      break;
    }
    case 'observed':
      Object.assign(view, elapsedClock(card.timeAt, now), { title: banked ? '已有发卡观测' : '已有重置观测', label: '距观测记录',
        badge: '第三方报告', tone: 'teal', animated: false, symbol: '◎', timeLabel: '来源记录时间',
        description: '第三方来源记录了' + subject + '，持续关注后续消息。', footnote: '第三方观测不等于官方完成声明。' });
      break;
    case 'completed':
      Object.assign(view, elapsedClock(card.timeAt, now), { title: banked ? '重置卡发放已确认' : '额度重置已确认', label: '距完成声明',
        badge: '公开完成声明', tone: 'green', animated: false, symbol: '✓', timeLabel: '完成消息时间',
        description: '本轮已有公开完成声明，持续关注下一次安排。', footnote: '个人账户请以实际到账为准。' });
      break;
    case 'cancelled':
      Object.assign(view, { title: '本轮安排已取消', label: subject, badge: '公开取消声明', animated: false, symbol: '—',
        description: '原安排已取消；如有新安排，将另行更新。', footnote: '原预计时间不再参与倒计时。' });
      break;
  }
  if (card.observationPublicationId && ['overdue', 'progress'].includes(card.state)) {
    view.description = '已有第三方重置观测，本轮完成声明仍待核实。';
    view.footnote = '下方可查看独立观测，暂不将其视为本轮完成依据。';
  }
  view.long = view.parts.some(part => part.value.length > 2);
  return view;
}
module.exports = { homeOrbitPresentation };
