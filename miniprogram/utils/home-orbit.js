const { countdownParts } = require('./status-timeline');

function homeClock(at, now, down = false) {
  const start = Date.parse(at), current = Date.parse(now);
  const duration = down ? start - current : current - start;
  if (!Number.isFinite(duration) || duration < 0) return {parts: [], metric: ''};
  if (duration < 60000) {
    const seconds = down ? Math.min(59, Math.ceil(duration / 1000)) : Math.floor(duration / 1000);
    return {parts: [{unit: '秒', value: String(seconds).padStart(2, '0')}], metric: seconds + '秒'};
  }
  const durationParts = down ? countdownParts(at, now) : countdownParts(now, at);
  const units = durationParts.some(part => part.unit === '天') ? ['天', '小时', '分钟'] : ['小时', '分钟'];
  return {
    parts: units.map(unit => ({unit, value: String(durationParts.find(part => part.unit === unit)?.value || 0).padStart(2, '0')})),
    metric: durationParts.map(({unit, value}) => value + unit).join(''),
  };
}

// The same clock displays time until a deadline and time since it or an occurrence.
function homeOrbitPresentation(card, now) {
  const banked = card.kind === 'banked_reset';
  const subject = banked ? '发卡' : '重置';
  const view = {title: '暂无新消息', label: '', badge: '', tone: 'slate',
    description: '', footnote: '', parts: [], metric: '', long: false, animated: true,
    timeLabel: card.timeLabel || '', symbol: '◎'};
  switch (card.state) {
    case 'signal':
      Object.assign(view, {title: '发现' + subject + '线索', badge: '公开线索', tone: 'violet'});
      break;
    case 'estimated':
      Object.assign(view, {title: card.window || '近期可能' + subject, label: card.metricLabel || '',
        badge: '信号推测', tone: 'violet', description: '推测时间仅供参考。',
        ...(card.metricLabel && homeClock(card.timeAt, now, true))});
      break;
    case 'announced':
    case 'progress':
      Object.assign(view, {title: subject + '时间待公布', badge: '公开消息', tone: 'blue'});
      break;
    case 'scheduled':
    case 'revised':
      Object.assign(view, homeClock(card.expectedAt || card.timeAt, now, true), {title: '',
        label: card.metricLabel, badge: card.state === 'revised' ? '时间已更新' : '公开预告',
        tone: 'blue', symbol: '◷'});
      break;
    case 'overdue': {
      const guess = card.evidenceType === 'signal';
      Object.assign(view, homeClock(card.timeAt, now), {title: '',
        label: guess ? '推测窗口已过' : '原预计时间已过',
        badge: guess ? '信号推测' : '公开预告', tone: 'amber', symbol: '◷',
        description: '暂无' + subject + '结果记录。'});
      break;
    }
    case 'observed':
    case 'completed': {
      const observed = card.state === 'observed';
      Object.assign(view, homeClock(card.timeAt, now), {
        title: '距离上次' + subject + (observed ? '（观测）' : ''), label: '已经过去',
        badge: observed ? '第三方报告' : banked ? '已发放 · 发布者确认' : '发布者已确认',
        tone: observed ? 'teal' : 'green', symbol: observed ? '◎' : '✓',
        description: observed && card.sourceName ? '来源：' + card.sourceName : '',
        timeLabel: card.timeLabel || (observed ? '来源观测时间' : '完成消息时间'),
      });
      break;
    }
    case 'cancelled':
      Object.assign(view, {title: '暂无' + subject + '记录', animated: false, symbol: '—'});
      break;
  }
  view.long = view.parts.some(part => part.value.length > 2);
  return view;
}

module.exports = { homeClock, homeOrbitPresentation };
