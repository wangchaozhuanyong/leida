import type { AdminData, Candidate, Job } from './types';

export type AutomationState = 'waiting' | 'waiting_evidence' | 'deferred' | 'cooldown' | 'configuration' | 'processing' | 'review' | 'failed' | 'published' | 'ignored';
export interface CandidateFlow {
  state: AutomationState;
  label: string;
  reason: string;
  actionPath: string;
  actionLabel: string;
  job?: Job;
  resumeAt?: string;
}
export const automationLabels: Record<AutomationState, string> = {
  waiting: '待自动处理', configuration: '等待配置', processing: '处理中',
  waiting_evidence: '等待补证', deferred: '暂缓收录', cooldown: '等待恢复',
  review: '需人工审核', failed: '处理失败', published: '已发布', ignored: '不收录',
};
export const automaticStates: AutomationState[] = ['waiting', 'waiting_evidence', 'deferred', 'cooldown', 'configuration', 'processing', 'failed'];
/** A fresh heartbeat proves liveness, but must not hide a reported processing failure. */
export function workerRuntimeStatus(heartbeat:{heartbeatAt?:string;error?:string}|undefined,timestamp=Date.now()):'healthy'|'stale'|'unobserved'|'failed' {
  if(!heartbeat?.heartbeatAt)return 'unobserved';
  const age=timestamp-Date.parse(heartbeat.heartbeatAt);
  if(!Number.isFinite(age)||age<0||age>=180_000)return 'stale';
  return heartbeat.error?'failed':'healthy';
}
const evidenceReason = /缺少|缺失|不完整|截断|歧义|上下文|父帖|明确动作|资格待|missing_context|context_missing|ambiguous_time|time_ambiguity|no_explicit_action|truncated/;
const conflictReason = /冲突|关联不明|无法对应|manual_review|evidence_conflict|qualification_conflict|human_edited/;
const machineReasonNames: Record<string, string> = {
  missing_context: '等待补齐上下文', context_missing: '等待补齐上下文', missing_parent: '等待补齐父帖',
  truncated_text: '正文不完整，等待补证', ambiguous_time: '时间尚不明确，等待补证',
  no_explicit_action: '尚无明确福利动作证据', ai_unconfigured: '智能服务尚未配置',
  source_unvalidated: '来源尚未验证', source_paused: '来源发布已暂停',
  evidence_conflict: '来源证据冲突', qualification_conflict: '资格范围冲突',
  historical_import: '历史补录', budget: '达到今日调用上限', transient: '接口暂时不可用',
  input_capacity: '完整资料超过智能接口容量，输入或配置变化后自动恢复',
};

export function aiReady(ai: AdminData['ai']): boolean {
  return !!(ai.enabled && ai.hasKey && ai.baseUrl && ai.model && ai.testedAt &&
    ai.dailyCallLimit > 0 && ai.dailyBudget > 0 && ai.inputPrice > 0 && ai.outputPrice > 0);
}

/** Raw collection is not human review. Only completed validation and human intervention are. */
export function candidateFlow(candidate: Candidate, data: AdminData): CandidateFlow {
  const jobs = data.jobs.filter(j => j.kind === 'generate' && j.candidateId === candidate.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const job = jobs.find(j => j.status === 'running' || j.status === 'queued') || jobs[0];
  const primary = data.evidence.find(e => e.id === candidate.evidenceId);
  const source = data.sources.find(s => s.id === primary?.sourceId);
  const detailPath = `review/${candidate.id}`;
  const result = (state: AutomationState, reason: string, actionPath = detailPath, actionLabel = '查看详情', resumeAt?: string): CandidateFlow =>
    ({ state, label: automationLabels[state], reason, actionPath, actionLabel, job, resumeAt });

  const automation = candidate.automation;
  const enrichmentPending = candidate.status === 'published' && automation?.templatePublished && automation.state !== 'ready';
  if (candidate.status === 'published' && !enrichmentPending) return result('published', '已同步到客户端，后续更正在事件与新闻中管理。');
  if (candidate.status === 'ignored') return result('ignored', candidate.reasons.join('；') || '原文与处理记录已保留。');
  if (candidate.humanEdited) return result('review', candidate.reasons.join('；') || '已人工修正，等待核对后发布。', detailPath, '核对');
  if (primary?.provenance === 'manual') return result('review', candidate.reasons.join('；') || '人工补充的原文需要核对。', detailPath, '核对');
  if (primary) {
    // The API returns newest evidence first; collectedAt also supports unsorted fixtures/imports.
    const revisions = data.evidence.map((evidence, index) => ({ evidence, index }))
      .filter(({ evidence }) => evidence.sourceId === primary.sourceId && evidence.messageId === primary.messageId)
      .sort((a, b) => {
        const difference = Date.parse(b.evidence.collectedAt) - Date.parse(a.evidence.collectedAt);
        return Number.isFinite(difference) && difference !== 0 ? difference : a.index - b.index;
      });
    const currentIndex = revisions.findIndex(({ evidence }) => evidence.id === primary.id);
    const successor = revisions.slice(0, currentIndex)
      .map(({ evidence }) => data.candidates.find(other => other.id !== candidate.id && other.evidenceId === evidence.id))
      .find(Boolean);
    if (successor) return result('ignored', '原文已有新版本，已由新版接续。', `review/${successor.id}`, '查看新版');
  }
  const publishedPrefix = enrichmentPending ? '中文模板已发布；' : '';
  if (automation?.state === 'conflict') return result('review', candidate.reasons.join('；') || '证据或人工保护字段存在冲突，需要核对。', detailPath, '核对');
  if (job?.status === 'running') return result('processing', `${publishedPrefix}正在补充上下文、生成中文内容并核验证据。`, 'sources/jobs', '查看任务');
  if (job?.status === 'queued') return result('waiting', job.error ? `自动重试：${job.error}` : '已进入自动队列，完成校验后发布。', 'sources/jobs', '查看任务', job.availableAt);

  if (automation) {
    const reasons = automation.reasonCodes.map(code => machineReasonNames[code] || (/^[a-z_]+$/.test(code) ? '' : code)).filter(Boolean).join('；');
    if (automation.state === 'waiting_evidence') return result('waiting_evidence', `${publishedPrefix}${reasons || '系统等待补齐父帖、完整正文或资格依据，补齐后自动重新判断。'}`, detailPath, '查看证据', automation.resumeAt);
    if (automation.state === 'deferred') return result('deferred', `${publishedPrefix}${reasons || '长期缺少必要证据，已暂缓；后续补齐仍会自动恢复。'}`, detailPath, '查看证据', automation.resumeAt);
    if (automation.state === 'cooldown') return result('cooldown', `${publishedPrefix}${job?.error || reasons || '接口故障或额度不足，恢复后自动继续。'}`, 'sources/jobs', '查看任务', automation.resumeAt);
    if (automation.state === 'configuration') {
      const sourceBlocked = automation.reasonCodes.some(code => /source/.test(code)) || !source?.enabled || !source.validated || source.publicationPaused;
      return result('configuration', `${publishedPrefix}${reasons || (sourceBlocked ? '来源恢复后自动继续。' : '完成智能服务配置后，自动补充中文内容。')}`, sourceBlocked ? 'sources' : 'settings/ai', '前往配置', automation.resumeAt);
    }
    if (automation.state === 'ready') {
      if (!source?.enabled || !source.validated || source.publicationPaused) return result('configuration', '来源尚未恢复发布，系统会在恢复后继续。', 'sources', '查看来源');
      return result(data.site.autoPublish ? 'waiting' : 'configuration', data.site.autoPublish ? '已通过规则校验，等待自动发布。' : '已通过规则校验，等待开启自动发布。', data.site.autoPublish ? 'sources/jobs' : 'settings/publishing', data.site.autoPublish ? '查看任务' : '开启自动发布');
    }
  }

  if (job?.status === 'failed') {
    const blocked = job.payload.blockedReason;
    if (blocked === 'budget') return result('cooldown', job.error || '已达到今日调用上限，额度恢复后自动继续。', 'settings/ai', '查看额度', typeof job.payload.resumeAfter === 'string' ? job.payload.resumeAfter : undefined);
    if (blocked === 'configuration' || blocked === 'source') return result('configuration', job.error || (blocked === 'source' ? '来源暂停或未验证，恢复后自动继续。' : '完成智能服务配置后自动继续。'), blocked === 'source' ? 'sources' : 'settings/ai', '前往配置');
    if (blocked === 'cooldown' || (job.payload.failureKind === 'transient' && typeof job.payload.resumeAfter === 'string')) return result('cooldown', job.error || '临时故障，冷却后自动重试。', 'sources/jobs', '查看任务', typeof job.payload.resumeAfter === 'string' ? job.payload.resumeAfter : undefined);
    return result('failed', job.error || '自动处理失败，原文已保留。请查看任务原因并重试。', 'sources/jobs', '查看任务');
  }

  const generated = job?.payload.generated === true || job?.status === 'succeeded';
  if (candidate.reasons.some(r => conflictReason.test(r))) return result('review', candidate.reasons.join('；'), detailPath, '核对');
  if (generated && candidate.reasons.some(r => evidenceReason.test(r))) return result('waiting_evidence', '必要证据尚未补齐；系统会继续补证，输入变化后重新核验。', detailPath, '查看证据');
  if (generated && candidate.reasons.length > 0) return result('waiting', '等待自动重新核验原文变化。', 'sources/jobs', '查看任务');
  if (generated && !data.site.autoPublish) return result('configuration', '内容已通过校验，等待开启自动发布。', 'settings/publishing', '开启自动发布');
  if (generated) return result('waiting', '内容已通过校验，等待自动发布。', 'sources/jobs', '查看任务');
  if (!source?.enabled || !source.validated || source.publicationPaused) return result('configuration', source?.pauseReason === 'structure' ? '来源结构异常，系统定期探测，恢复并通过校验后继续。' : '来源尚未启用或通过验证，恢复后自动处理积压。', 'sources', '配置来源');
  if (data.site.autoPublish && (source.kind === 'status' || source.kind === 'releases' || (primary && /[\u4e00-\u9fff]/.test(primary.text)))) return result('waiting', '等待规则核验与中文模板发布；完整中文内容可在智能服务恢复后补充。', 'sources/jobs', '查看任务');
  if (!aiReady(data.ai)) {
    const reason = !data.ai.hasKey || !data.ai.baseUrl || !data.ai.model ? '智能服务尚未配置，完成后自动处理积压。'
      : !data.ai.testedAt ? '智能服务尚未通过连接测试，通过后自动继续。'
      : !data.ai.enabled ? '自动智能处理已关闭，开启后自动继续。' : '调用与费用上限尚未配置，完成后自动继续。';
    return result('configuration', reason, 'settings/ai', '配置智能服务');
  }
  return result('waiting', primary?.contextComplete ? '等待自动生成中文内容并校验。' : '等待自动补充上下文；缺证时暂缓，补齐后自动恢复。', 'sources/jobs', '查看任务');
}

export function automationRows(data: AdminData) {
  return data.candidates.map(candidate => ({ candidate, flow: candidateFlow(candidate, data) }));
}

export function canAutoRefreshAdmin(section: string, parts: string[]): boolean {
  if (!section) return true;
  if (section === 'review') return !parts[1] || parts[1] === 'queue';
  if (section === 'events') return !parts[1] || (parts[1] === 'articles' && !parts[2]);
  if (section === 'activities') return !parts[1];
  if (section === 'sources') return true;
  return section === 'settings' && ['notices', 'logs'].includes(parts[1] || '');
}
