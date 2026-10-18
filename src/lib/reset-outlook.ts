import type { ActionKind, ActionStage } from './types';
import { pendingPublicActions, publicActions, isNewsOnly, type PublicFactsData } from './public-facts';

export interface ResetOutlookRound {
  actionId: string; eventId: string; publicationId: string; kind: ActionKind; stage: ActionStage;
  statementAt: string; expectedAt?: string; timeNote?: string;
}
export interface ResolvedResetRound extends ResetOutlookRound {
  resolvedAt: string; announcedAt?: string; announcedDeadline?: string; announcedDeadlineNote?: string;
}
export interface ResetOutlook {
  status: 'scheduled' | 'announced' | 'in_progress' | 'overdue' | 'completed' | 'cancelled' | 'monitoring';
  active?: ResetOutlookRound; latestCompletion?: ResetOutlookRound; lastResolved?: ResolvedResetRound;
  evidenceCutoffAt?: string; latestGlobalCompletionAt?: string;
  latestResolutions?: Partial<Record<ActionKind, ResolvedResetRound>>;
  pendingReview?: ResetOutlookRound[];
}

/** Consumer forecast follows one published round, never a historical interval or another round's completion. */
export function publicResetOutlook(data: PublicFactsData): ResetOutlook {
  const now = Date.parse(data.serverTime);
  const facts = publicActions(data).filter(({ action, publication }) => Number.isFinite(Date.parse(action.statementAt)) && Date.parse(action.statementAt) <= now && Date.parse(publication.publishedAt) <= now)
    .sort((a, b) => Date.parse(b.action.statementAt) - Date.parse(a.action.statementAt));
  const round = (item: typeof facts[number]): ResetOutlookRound => ({
    actionId: item.action.id, eventId: item.event.id, publicationId: item.publication.id,
    kind: item.action.kind, stage: item.action.stage, statementAt: item.action.statementAt,
    ...(item.action.expectedAt && Number.isFinite(Date.parse(item.action.expectedAt)) ? { expectedAt: item.action.expectedAt } : {}), ...(item.action.timeNote ? { timeNote: item.action.timeNote } : {}),
  });
  const completed = facts.find(item => item.action.stage === 'claimed_complete');
  const resolved = facts.find(item => ['claimed_complete', 'cancelled'].includes(item.action.stage));
  const globalCompleted=facts.find(item=>item.action.kind==='automatic_reset'&&item.action.stage==='claimed_complete');
  const latestResolutions: NonNullable<ResetOutlook['latestResolutions']> = {};
  for (const item of facts.filter(item=>['claimed_complete','cancelled'].includes(item.action.stage))) {
    latestResolutions[item.action.kind] ??= {...round(item),resolvedAt:item.action.statementAt};
  }
  // A later same-kind completion does not prove which older promise it fulfilled.
  // Retain that promise for review, without using it as the current countdown.
  const pendingAll=pendingPublicActions(data);
  const needsReview=(item:typeof pendingAll[number])=>announcementNeedsReview(item.action,latestResolutions[item.action.kind]);
  const pendingReview=pendingAll.filter(needsReview).map(round);
  const pending=pendingAll.find(item=>!needsReview(item)&&(!resolved||Date.parse(item.action.statementAt)>=Date.parse(resolved.action.statementAt)||Date.parse(item.action.expectedAt??'')>=Date.parse(resolved.action.statementAt)));
  let lastResolved: ResolvedResetRound | undefined;
  if (resolved) {
    // Only matching immutable versions of this same action establish its preannouncement.
    const prior = data.publications.filter(p => p.eventId === resolved.event.id && !isNewsOnly(p) && Date.parse(p.publishedAt) <= Date.parse(resolved.publication.publishedAt))
      .flatMap(p => p.event.actions.filter(a => a.id === resolved.action.id && a.kind === resolved.action.kind && a.scope === 'public' && ['promised', 'in_progress'].includes(a.stage) && Date.parse(a.statementAt) <= Date.parse(resolved.action.statementAt)))
      .sort((a, b) => Date.parse(a.statementAt) - Date.parse(b.statementAt));
    const timed = prior.filter(a => a.expectedAt && Number.isFinite(Date.parse(a.expectedAt))).at(-1);
    lastResolved = { ...round(resolved), resolvedAt: resolved.action.statementAt,
      ...(prior[0] ? { announcedAt: prior[0].statementAt } : {}),
      ...(timed ? { announcedDeadline: timed.expectedAt, announcedDeadlineNote: timed.timeNote } : {}),
    };
  }
  const relevant = [pending, completed, resolved].filter((item): item is typeof facts[number] => !!item);
  const evidenceIds = new Set(relevant.flatMap(item => item.action.evidenceIds));
  const collected = data.evidence.filter(item => evidenceIds.has(item.id) && Number.isFinite(Date.parse(item.collectedAt)) && Date.parse(item.collectedAt) <= now).map(item => item.collectedAt).sort((a, b) => Date.parse(b) - Date.parse(a));
  const base = { ...(Object.keys(latestResolutions).length?{latestResolutions}:{}), ...(pendingReview.length?{pendingReview}:{}), ...(globalCompleted?{latestGlobalCompletionAt:globalCompleted.action.statementAt}:{}), ...(completed ? { latestCompletion: round(completed) } : {}), ...(lastResolved ? { lastResolved } : {}), ...(collected[0] ? { evidenceCutoffAt: collected[0] } : {}) };
  if (pending) {
    const deadline = Date.parse(pending.action.expectedAt ?? '');
    const status = Number.isFinite(deadline) && deadline <= now ? 'overdue' : pending.action.stage === 'in_progress' ? 'in_progress' : Number.isFinite(deadline) ? 'scheduled' : 'announced';
    return { ...base, status, active: round(pending) };
  }
  return { ...base, status: resolved ? resolved.action.stage === 'claimed_complete' ? 'completed' : 'cancelled' : 'monitoring' };
}

/** Shared by page selection and delivery checks; it never mutates the old event. */
export function announcementNeedsReview(action: Pick<ResetOutlookRound,'kind'|'statementAt'>, resolution: Pick<ResolvedResetRound,'kind'|'statementAt'>|undefined): boolean {
  return !!resolution && action.kind===resolution.kind && Number.isFinite(Date.parse(action.statementAt)) && Date.parse(resolution.statementAt)>Date.parse(action.statementAt);
}
