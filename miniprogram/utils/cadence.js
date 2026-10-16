const validTime = value => typeof value === 'string' ? Date.parse(value) : NaN;
const validProbability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const displayTime = value => Number.isFinite(validTime(value)) ? new Date(validTime(value) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '';

function cadenceModel(forecasts, now, target = 'automatic_reset', fixedSnapshot) {
  const snapshot = fixedSnapshot || (forecasts && forecasts.status === 'ready' && (forecasts.cadenceByKind && forecasts.cadenceByKind[target] || target === 'automatic_reset' && forecasts.cadence));
  const current = validTime(now), generated = validTime(snapshot && snapshot.generatedAt), expires = validTime(snapshot && snapshot.validUntil);
  const legacy = !!snapshot && (!snapshot.target || snapshot.modelVersion !== 'conditional-beta-reset-cadence-20261016-1');
  const expired = !!snapshot && (!Number.isFinite(current) || !Number.isFinite(generated) || !Number.isFinite(expires) || generated > current || expires <= current);
  const valid = !legacy && !!snapshot && snapshot.target === target && snapshot.calibrated === false && Number.isInteger(snapshot.sampleCount) && snapshot.sampleCount >= 8 && Number.isInteger(snapshot.eligibleCount) && snapshot.eligibleCount >= 5 && validProbability(snapshot.p24) && validProbability(snapshot.p48) && snapshot.p24 <= snapshot.p48;
  const ready = !!snapshot && snapshot.status === 'ready' && !expired && valid;
  const announced = !fixedSnapshot && !!(forecasts && forecasts.outlook && forecasts.outlook.active && forecasts.outlook.active.kind === target);
  const state = announced ? '已有公开安排' : legacy ? '历史模型' : expired ? '等待更新' : snapshot && snapshot.status === 'paused' ? '暂停估算' : snapshot && snapshot.status === 'out_of_range' ? '超出样本范围' : ready ? '历史估算' : '积累记录中';
  const message = announced ? '已有明确公开安排，请以上方公告进展和原文为准。' : legacy ? '这份旧模型记录仅供历史复盘，不作为当前预测。' : expired ? '上一次估算已过有效时间，等待后台更新。' : snapshot && snapshot.status === 'paused' ? '来源资料暂时不足，恢复后自动更新。' : snapshot && snapshot.status === 'out_of_range' ? '本次等待已超出历史可比范围，暂不估算。' : ready ? '根据同类型历史间隔估算，不是发放承诺。' : '可核验的同类型历史记录还不足，暂不估算。';
  return { target, ready: ready && !announced, state, message, id: snapshot && snapshot.id || '', sampleCount: snapshot && snapshot.sampleCount || 0, eligibleCount: snapshot && snapshot.eligibleCount || 0, generatedAt: displayTime(snapshot && snapshot.generatedAt), window24: Number.isFinite(generated) ? displayTime(new Date(generated + 24 * 3600000).toISOString()) : '', window48: Number.isFinite(generated) ? displayTime(new Date(generated + 48 * 3600000).toISOString()) : '', p24: ready ? `${Math.round(snapshot.p24 * 100)}%` : '—', p48: ready ? `${Math.round(snapshot.p48 * 100)}%` : '—', hasSnapshot: !!snapshot, legacy, announced };
}
module.exports = { cadenceModel };
