const {announcementCountdown,completionElapsed,activeResetWatch,activeResetSchedule,resetWatchWindow}=require('./model');
const beijing=value=>new Date(Date.parse(value)+8*3600_000).toISOString().slice(0,16).replace('T',' ');

/** Only the current evidenced stage is marked; the line is not a history of inferred steps. */
function statusTimelineModel(outlook, now, completion = outlook.latestCompletion, forecasts) {
  const resolvedAt=outlook.lastResolved?.resolvedAt??outlook.lastResolved?.statementAt??completion?.statementAt;
  const candidate=activeResetSchedule(forecasts?.watch,now);
  const remote=candidate&&(!outlook.active||Date.parse(candidate.announcedAt)>Date.parse(outlook.active.statementAt))?candidate:undefined;
  const active = remote?{kind:remote.kind,stage:'promised',statementAt:remote.announcedAt,expectedAt:remote.scheduledFor??undefined,timeNote:'',publicationId:''}:outlook.active;
  const countdown = active ? announcementCountdown(active, now) : undefined;
  const completed = active ? undefined : completionElapsed(completion, now);
  const scheduled = countdown?.status === 'upcoming';
  const overdue = countdown?.status === 'expired';
  const banked = (active ?? completion)?.kind === 'banked_reset';
  const minutes = scheduled ? Math.ceil((Date.parse(active.expectedAt) - Date.parse(now)) / 60000) : 0;
  const signal=!active?activeResetWatch(forecasts?.watch,now,resolvedAt):undefined;
  const base = {
    watching:false,estimating:false,detail:remote?(remote.sourceType==='observed'?'来源观察记录 · 尚待执行确认':'公开预告 · 尚待执行确认'):'',sourceUrl:remote?.sourceUrl??'',sourceType:remote?.sourceType??'x_post',sourceCredit:!!remote,sourceId:remote?.id??'',forecastWindow:'',chanceLabel:'',observedLabel:'',expiresAt:'',
    publicationId:active?.publicationId??'',statementAt:active?.statementAt??(completed?completion?.statementAt??'':''),expectedAt:active?.expectedAt??'',kind:(active??completion)?.kind??'automatic_reset',
    scheduled, completed: !!completed,
    lead: scheduled ? remote?'距离预计安排时间':/^原文近似时间/.test(active?.timeNote ?? '') ? '预计约' : /^原文预计时刻/.test(active?.timeNote ?? '') ? '预计剩余' : '距离预计最晚时间' : completed ? '公开完成声明' : outlook.status === 'cancelled' ? '上轮安排已取消' : '公开动态追踪',
    title: scheduled ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : overdue ? '等待确认' : active ? active.stage === 'in_progress' ? banked ? '发卡进行中' : '重置进行中' : '时间待明确' : completed ? banked ? '已确认发放重置卡' : '已确认重置' : '等待下一次 Reset',
    note: scheduled ? `预计 ${new Date(Date.parse(active.expectedAt) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')}` : overdue ? '已过预计时间，待公开确认' : active ? '有明确安排后，自动更新' : completed ? `${completed.label} · 以公开完成公告为准` : forecasts?.watch?.status==='unavailable'?'信号来源暂不可用，恢复后自动检查':'有新的重置信号后更新',
    currentStage: overdue ? -1 : active ? active.stage === 'in_progress' ? 1 : 0 : completed ? 2 : -1,
    stages: ['公开预告', banked ? '发卡进行' : '重置进行', '完成确认'],
  };
  if(signal)return {...base,watching:true,completed:false,lead:'重置信号观察',title:'发现重置信号',note:`观察有效至 ${beijing(signal.expiresAt)}`,detail:signal.sourceType==='observed'?'来源观察记录，尚无明确预告':'AI 信号推测，尚无明确预告',sourceUrl:signal.sourceUrl??'',sourceType:signal.sourceType??'x_post',sourceCredit:true,statementAt:signal.observedAt,observedLabel:`信号时间 ${beijing(signal.observedAt)}`,expiresAt:signal.expiresAt,forecastWindow:resetWatchWindow(signal.forecastWindow),chanceLabel:typeof signal.chancePercent==='number'?`上游信号概率 ${signal.chancePercent}%`:'',currentStage:-1};
  // Historical cadence is not evidence that a new reset is approaching.
  // Keep it in the experimental records, never as a current homepage fallback.
  return base;
}


/** Stable during a countdown; changes on state, source, round or expiry transitions. */
function statusTimelineRevision(model) {
  return 'state:'+JSON.stringify([model.publicationId,model.sourceId,model.kind,model.statementAt,model.expectedAt,model.sourceUrl,model.sourceType,model.sourceCredit,model.watching,model.currentStage,model.scheduled,model.completed,model.forecastWindow,model.chanceLabel,model.expiresAt,model.scheduled||model.completed?'':model.title,model.completed?'':model.note]);
}
module.exports={statusTimelineModel,statusTimelineRevision};
