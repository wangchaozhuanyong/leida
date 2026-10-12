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
  evidenceCutoffAt?: string;
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
  // An older unresolved announcement remains in its own event history. It
  // must not replace a newer resolved statement in the latest-status card.
  // A schedule extending past that statement remains visible, including overdue
  // status. Older expired schedules stay unresolved in history; they do not
  // become the current headline or imply another benefit completed them.
  const pending = pendingPublicActions(data).find(item => !resolved ||
    Date.parse(item.action.statementAt) >= Date.parse(resolved.action.statementAt) ||
    Date.parse(item.action.expectedAt ?? '') >= Date.parse(resolved.action.statementAt));
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
  const base = { ...(completed ? { latestCompletion: round(completed) } : {}), ...(lastResolved ? { lastResolved } : {}), ...(collected[0] ? { evidenceCutoffAt: collected[0] } : {}) };
  if (pending) {
    const deadline = Date.parse(pending.action.expectedAt ?? '');
    const status = Number.isFinite(deadline) && deadline <= now ? 'overdue' : pending.action.stage === 'in_progress' ? 'in_progress' : Number.isFinite(deadline) ? 'scheduled' : 'announced';
    return { ...base, status, active: round(pending) };
  }
  return { ...base, status: resolved ? resolved.action.stage === 'claimed_complete' ? 'completed' : 'cancelled' : 'monitoring' };
}
