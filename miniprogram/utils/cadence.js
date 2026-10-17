const validTime = value => typeof value === 'string' ? Date.parse(value) : NaN;
const validProbability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const displayTime = value => Number.isFinite(validTime(value)) ? new Date(validTime(value) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '';
const shortTime = value => { const full=displayTime(value); return full ? `${full.slice(5,7)}月${full.slice(8,10)}日 ${full.slice(11,16)}` : ''; };
const cadenceSnapshotId = value => typeof value === 'string' && /^forecast_cadence_[a-f0-9]{64}$/.test(value);
const currentModel = 'conditional-beta-reset-cadence-20261017-1';
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && !!value.trim();
const count = value => Number.isSafeInteger(value) && value >= 0;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const year=Number(value.slice(0,4)),month=Number(value.slice(5,7)),day=Number(value.slice(8,10));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year,month,0)).getUTCDate() || Number(value.slice(11,13)) > 23 || Number(value.slice(14,16)) > 59 || Number(value.slice(17,19)) > 59) return NaN;
  return Date.parse(value);
}
const time = value => Number.isFinite(timestamp(value));
const nullableTime = value => value === null || time(value);
const nullableProbability = value => value === null || validProbability(value);
const strings = value => Array.isArray(value) && value.every(text);
function backtestSummary(value) {
  return record(value) && count(value.tests) && count(value.hits) && value.hits <= value.tests
    && nullableProbability(value.hitRate) && (value.medianAbsoluteErrorHours === null || nonnegative(value.medianAbsoluteErrorHours));
}
/** Fixed records may be expired or use the previous model, but never malformed or from the future. */
function validateCadenceSnapshot(value, now = Date.now()) {
  if (!record(value) || !cadenceSnapshotId(value.id) || value.recordType !== 'reset_cadence' || !text(value.modelVersion) || !text(value.inputFingerprint)
    || !['ready','insufficient','out_of_range','paused'].includes(value.status) || value.calibrated !== false
    || value.target !== undefined && !['automatic_reset','banked_reset'].includes(value.target)
    || value.modelVersion === currentModel && !value.target
    || value.summaryOnly !== undefined && typeof value.summaryOnly !== 'boolean') return false;
  const generated=timestamp(value.generatedAt),cutoff=timestamp(value.cutoffAt),expires=timestamp(value.validUntil);
  if (![generated,cutoff,expires,now].every(Number.isFinite) || generated > now || cutoff > generated || expires <= generated || expires > generated + 6*3600000
    || !nullableTime(value.anchorAt) || value.anchorAt !== null && timestamp(value.anchorAt) > cutoff
    || !count(value.sampleCount) || ![8,12,20,30].includes(value.lookbackIntervals) || value.sampleCount > value.lookbackIntervals
    || !count(value.eligibleCount) || value.eligibleCount > value.sampleCount || !count(value.rejectedCount) || !count(value.mergedCount)
    || !nullableProbability(value.p24) || !nullableProbability(value.p48) || value.p24 !== null && value.p48 !== null && value.p24 > value.p48
    || ['rawP24','rawP48'].some(key => value[key] !== undefined && !nullableProbability(value[key]))
    || value.rawP24 != null && value.rawP48 != null && value.rawP24 > value.rawP48
    || !['predictedAt','windowStart','windowEnd'].every(key => nullableTime(value[key]))
    || !text(value.method) || !text(value.explanation) || !strings(value.sourceIds) || !strings(value.trainingObservationIds)) return false;
  if (value.status === 'ready') {
    if (!validProbability(value.p24) || !validProbability(value.p48) || value.anchorAt === null || value.sampleCount < 8 || value.eligibleCount < (value.modelVersion === currentModel ? 5 : 4)
      || !['predictedAt','windowStart','windowEnd'].every(key => time(value[key]) && timestamp(value[key]) > generated)
      || timestamp(value.windowStart) > timestamp(value.predictedAt) || timestamp(value.predictedAt) > timestamp(value.windowEnd)) return false;
  } else if (['p24','p48','predictedAt','windowStart','windowEnd'].some(key => value[key] !== null)) return false;
  if (!Array.isArray(value.observations) || !value.observations.every(row => {
    if (!record(row) || !text(row.id) || !strings(row.evidenceIds) || !row.evidenceIds.length || !text(row.url) || !/^https?:\/\/\S+$/.test(row.url) || !['automatic_reset','banked_reset','unspecified'].includes(row.kind)
      || row.timePrecision !== undefined && !['exact','date','unknown'].includes(row.timePrecision)) return false;
    const observed=timestamp(row.timePrecision === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(row.at) ? `${row.at}T00:00:00Z` : row.at);
    return Number.isFinite(observed) && observed <= cutoff && (row.firstKnownAt === undefined || time(row.firstKnownAt) && timestamp(row.firstKnownAt) >= observed && timestamp(row.firstKnownAt) <= cutoff);
  })) return false;
  const validInterval = row => record(row) && text(row.fromId) && text(row.toId) && time(row.fromAt) && time(row.toAt)
    && timestamp(row.toAt) <= cutoff && timestamp(row.toAt) > timestamp(row.fromAt) && nonnegative(row.hours) && row.hours > 0
    && Math.abs(row.hours - (timestamp(row.toAt)-timestamp(row.fromAt))/3600000) < 1e-8;
  if (!['trainingIntervals','historicalIntervals'].every(key => Array.isArray(value[key]) && value[key].every(validInterval))) return false;
  const backtest=value.backtest;
  return backtestSummary(backtest) && backtest.mode === 'retrospective' && backtestSummary(backtest.recent) && text(backtest.explanation)
    && Array.isArray(backtest.entries) && backtest.entries.every(row => record(row) && ['anchorAt','generatedAt','predictedAt','windowStart','windowEnd','actualAt'].every(key => time(row[key]))
      && timestamp(row.anchorAt) <= timestamp(row.generatedAt) && timestamp(row.generatedAt) < timestamp(row.actualAt) && timestamp(row.actualAt) <= cutoff
      && timestamp(row.windowStart) <= timestamp(row.predictedAt) && timestamp(row.predictedAt) <= timestamp(row.windowEnd)
      && count(row.trainingCount) && typeof row.hit === 'boolean' && nonnegative(row.absoluteErrorHours) && strings(row.trainingObservationIds));
}

function cadenceModel(forecasts, now, target = 'automatic_reset', fixedSnapshot) {
  const snapshot = fixedSnapshot || (forecasts && forecasts.status === 'ready' && (forecasts.cadenceByKind && forecasts.cadenceByKind[target] || target === 'automatic_reset' && forecasts.cadence));
  const current = validTime(now), generated = validTime(snapshot && snapshot.generatedAt), expires = validTime(snapshot && snapshot.validUntil);
  const legacy = !!snapshot && (!snapshot.target || snapshot.modelVersion !== 'conditional-beta-reset-cadence-20261017-1');
  const expired = !!snapshot && (!Number.isFinite(current) || !Number.isFinite(generated) || !Number.isFinite(expires) || generated > current || expires <= current);
  const valid = !legacy && !!snapshot && snapshot.target === target && snapshot.calibrated === false && Number.isInteger(snapshot.sampleCount) && snapshot.sampleCount >= 8 && Number.isInteger(snapshot.eligibleCount) && snapshot.eligibleCount >= 5 && validProbability(snapshot.p24) && validProbability(snapshot.p48) && snapshot.p24 <= snapshot.p48;
  const start=validTime(snapshot && snapshot.windowStart),end=validTime(snapshot && snapshot.windowEnd),predicted=validTime(snapshot && snapshot.predictedAt);
  const validRange=[start,end,predicted].every(Number.isFinite) && start>generated && start<=predicted && predicted<=end && end>current;
  const ready = !!snapshot && snapshot.status === 'ready' && !expired && valid && validRange;
  const missingAnchor=!!snapshot && snapshot.status==='insufficient' && snapshot.sampleCount>=8 && !Number.isFinite(validTime(snapshot.anchorAt));
  const limitedComparable=!!snapshot && snapshot.status==='insufficient' && snapshot.sampleCount>=8 && !missingAnchor;
  const rangeLabel=ready ? start===end ? `${shortTime(snapshot.windowStart)}附近` : `${shortTime(snapshot.windowStart)} — ${shortTime(snapshot.windowEnd)}` : '';
  const predictedLabel=ready ? shortTime(snapshot.predictedAt) : '';
  const announced = !fixedSnapshot && !!(forecasts && forecasts.outlook && forecasts.outlook.active && forecasts.outlook.active.kind === target);
  const state = announced ? '已有公开安排' : legacy ? '历史模型' : expired ? '等待更新' : snapshot && snapshot.status === 'paused' ? '暂停估算' : snapshot && snapshot.status === 'out_of_range' ? '超出样本范围' : ready ? '历史估算' : missingAnchor ? '时间待核对' : snapshot && snapshot.status==='ready' ? '等待更新' : '积累记录中';
  const message = announced ? '已有明确公开安排，请以上方公告进展和原文为准。' : legacy ? '这份旧模型记录仅供历史复盘，不作为当前预测。' : expired ? '上一次估算已过有效时间，等待后台更新。' : snapshot && snapshot.status === 'paused' ? '来源资料暂时不足，恢复后自动更新。' : snapshot && snapshot.status === 'out_of_range' ? '本次等待已超出历史可比范围，暂不估算。' : ready ? '根据同类型历史间隔估算，不是发放承诺。' : missingAnchor ? '最近一次重置的时间依据待核对，暂不估算。' : limitedComparable ? '当前等待时长下的可比记录不足，暂不估算。' : snapshot && snapshot.status==='ready' ? '当前估计区间已失效或资料不完整，等待后台更新。' : '可核验的同类型历史记录还不足，暂不估算。';
  return { target, rangeLabel, predictedLabel, ready: ready && !announced, state, message, id: snapshot && snapshot.id || '', sampleCount: snapshot && snapshot.sampleCount || 0, eligibleCount: snapshot && snapshot.eligibleCount || 0, generatedAt: displayTime(snapshot && snapshot.generatedAt), window24: Number.isFinite(generated) ? displayTime(new Date(generated + 24 * 3600000).toISOString()) : '', window48: Number.isFinite(generated) ? displayTime(new Date(generated + 48 * 3600000).toISOString()) : '', p24: ready ? `${Math.round(snapshot.p24 * 100)}%` : '—', p48: ready ? `${Math.round(snapshot.p48 * 100)}%` : '—', hasSnapshot: !!snapshot, legacy, announced };
}
module.exports = { cadenceModel, cadenceSnapshotId, validateCadenceSnapshot };
