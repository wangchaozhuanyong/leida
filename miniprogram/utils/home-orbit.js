const BEIJING = 8 * 3600000;
const DAY = 86400000;

// Calendar units are display-only. Deadlines and occurrence anchors stay unchanged.
function addMonths(at, months) {
  const date = new Date(at + BEIJING), day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime() - BEIJING;
}

function homeClock(at, now, down = false) {
  const start = Date.parse(at), current = Date.parse(now);
  const duration = down ? start - current : current - start;
  if (!Number.isFinite(duration) || duration < 0) return {parts: [], calendarParts: [], timeParts: [], metric: ''};
  const from = down ? current : start;
  const end = from + (down ? Math.ceil(duration / 1000) : Math.floor(duration / 1000)) * 1000;
  const a = new Date(from + BEIJING), b = new Date(end + BEIJING);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
  if (addMonths(from, months) > end) months--;
  const years = Math.floor(months / 12), month = months % 12;
  let rest = end - addMonths(from, months);
  const days = Math.floor(rest / DAY); rest %= DAY;
  const hours = Math.floor(rest / 3600000); rest %= 3600000;
  const minutes = Math.floor(rest / 60000), seconds = Math.floor(rest % 60000 / 1000);
  const calendarParts = [];
  if (years) calendarParts.push({unit: '年', value: String(years)});
  if (months) calendarParts.push({unit: '个月', value: String(month)});
  if (months || days) calendarParts.push({unit: '天', value: String(days)});
  const timeParts = [{unit: '小时', value: hours}, {unit: '分钟', value: minutes}, {unit: '秒', value: seconds}]
    .map(part => ({unit: part.unit, value: String(part.value).padStart(2, '0')}));
  const parts = [...calendarParts, ...timeParts];
  return {parts, calendarParts, timeParts, metric: parts.map(({unit, value}) => Number(value) + unit).join('')};
}

// The same clock displays time until a deadline and time since it or an occurrence.
function homeOrbitPresentation(card, now) {
  const banked = card.kind === 'banked_reset';
  const subject = banked ? '发卡' : '重置';
  const view = {title: '暂无新消息', label: '', badge: '', tone: 'slate',
    description: '', footnote: '', parts: [], calendarParts: [], timeParts: [], metric: '', long: false, animated: true,
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
