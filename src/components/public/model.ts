import type { Article, BenefitAction, Notice, PublicData, Publication, RadarEvent } from '@/lib/types';
import { pendingPublicActions, publicActions, completedPublicActions } from '@/lib/public-facts';
export {recentCompletedBenefits} from '@/lib/public-facts';
export { currentPublication, isNewsOnly, statePublication, publicActions, publicationSourceTime, publicationWithdrawn, sortedPublications, sortedStatePublications } from '@/lib/public-facts';

export const zone = 'Asia/Shanghai';
export const dateKey = (value: string | number | Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
export const displayTime = (value?: string) => {
  if (!value || !Number.isFinite(Date.parse(value))) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
};
export const briefTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
export const completionTime = (value: string) => {
  if (!Number.isFinite(Date.parse(value))) return '暂无记录';
  const time = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  return `${dateKey(value).replaceAll('-', '/')} ${time}`;
};
/** Keep one current public completion per benefit, ordered by its original statement time. */
export function latestCompletedBenefits(data: PublicData) {
  const seen = new Set<BenefitAction['kind']>();
  return completedPublicActions(data)
    .filter(({ action }) => { if (seen.has(action.kind)) return false; seen.add(action.kind); return true; });
}
/** The 24-hour display expires from the public completion statement, never from page refresh. */
export function completionElapsed(action: Pick<BenefitAction, 'kind' | 'stage' | 'statementAt'> | null | undefined, now: string) {
  if (action?.stage !== 'claimed_complete') return undefined;
  const age = Date.parse(now) - Date.parse(action.statementAt);
  if (!Number.isFinite(age) || age < 0 || age >= 24 * 3600_000) return undefined;
  const minutes = Math.floor(age / 60000), hours = Math.floor(minutes / 60), remainder = minutes % 60;
  const parts: { value: number; unit: string }[] = [];
  if (hours) parts.push({ value: hours, unit: '小时' });
  if (remainder) parts.push({ value: remainder, unit: '分钟' });
  return { parts, label: parts.length ? `${parts.map(part => `${part.value}${part.unit}`).join('')}前` : '刚刚',
    lead: action.kind === 'banked_reset' ? '距最近一次确认发放重置卡' : '距最近一次确认重置' };
}
export const articleSourceTime = (article: Article) => article.sourcePublishedAt ?? article.publishedAt;
export const sortedArticles = (articles: Article[]) => articles.slice().sort((a, b) => Date.parse(articleSourceTime(b)) - Date.parse(articleSourceTime(a)));
/** Client navigation keeps a detail page in its parent section. */
export const publicNavSection = (route: string) => ({ events: 'history', sources: 'history', articles: 'news', activities: 'news', notices: 'settings', more: 'settings', methodology: 'home' }[route] ?? route);
/** Source polling and the server clock must not masquerade as new published content. */
export function publicContentRevision(data: PublicData): string {
  const sorted = (rows: string[]) => rows.sort();
  return JSON.stringify([
    sorted(data.articles.map(a => `${a.id}:${a.publicationId}:${a.status}`)),
    sorted(data.events.map(e => `${e.id}:${e.publicationId}:${e.status}:${e.mergedInto ?? ''}`)),
    sorted(data.activities.map(a => `${a.id}:${a.version}`)),
    sorted(data.notices.map(n => `${n.id}:${n.status}`)),
  ]);
}
export const latestSourceSuccess = (sources: PublicData['sources']) => sources
  .map(source => source.lastSuccessAt).filter((at): at is string => !!at && Number.isFinite(Date.parse(at)))
  .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
/** Group presentation updates without deleting or rewriting any original notice/version. */
export function groupedNoticeUpdates(notices: Notice[]): { latest: Notice; updates: Notice[] }[] {
  const groups = new Map<string, Notice[]>();
  for (const notice of notices.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    const updates = groups.get(notice.eventId) ?? [];
    updates.push(notice); groups.set(notice.eventId, updates);
  }
  return [...groups.values()].map(updates => ({ latest: updates[0], updates }));
}
/** Remove known template process copy only; never rewrite manually edited summaries or evidence. */
export function publicArticleSummary(article: Article): string {
  if (article.contentOrigin !== 'template' || article.manualFields?.includes('summary')) return article.summary;
  return article.summary
    .replace('已保存发布说明；完整中文改动会在智能服务可用后自动补充。', '更新细节请查看官方发布说明。')
    .replace(/^公开归档收录(?:产品动态|消息)：[“「]([\s\S]*?)[”」]。此条仅作(?:产品)?消息记录，完整细节请查看原文。$/, '$1')
    .replace(/^根据(?:公开归档保存的原帖|公开原文)，/, '')
    .replace(/\s*原文发布时间：[^。\n]*。这是中文事实摘要，/g, ' ')
    .trim();
}
/** Compare displayed content without treating layout-only whitespace as another article. */
export function publicArticleContent(article: Article): { summary: string; body: string; hasAdditionalContent: boolean } {
  const translation = article.translation?.trim() ?? '';
  const summary = publicArticleSummary(article).trim() || translation;
  const body = translation || summary;
  const comparable = (value: string) => value.replace(/[\s\u200b\ufeff]+/g, '');
  const hasAdditionalContent = !!translation && comparable(translation) !== comparable(summary)
    && comparable(translation) !== comparable(article.summary);
  return { summary, body, hasAdditionalContent };
}
export const safeUrl = (url: string) => { try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; } };
export function elapsed(value: string, now: string) {
  const minutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(value)) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时前`;
  return `${Math.floor(minutes / 1440)}天前`;
}
/** Historical promises remain in history; only a future deadline makes them a current upcoming item. */
export const upcomingActions = pendingPublicActions;
/** Advance an authoritative server clock by browser monotonic elapsed time, never its wall clock. */
export function announcementClock(serverTime: string, elapsedMs: number): string {
  const baseline = Date.parse(serverTime);
  if (!Number.isFinite(baseline)) return serverTime;
  return new Date(baseline + (Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0)).toISOString();
}

/** The countdown describes time remaining until the published deadline, not an exact reset time. */
export function announcementCountdown(action: Pick<BenefitAction, 'expectedAt' | 'timeNote'>, now: string): { status: 'upcoming' | 'expired' | 'unknown'; label: string } {
  const deadline = Date.parse(action.expectedAt ?? ''), current = Date.parse(now);
  if (!Number.isFinite(deadline) || !Number.isFinite(current)) return { status: 'unknown', label: '时间待明确' };
  if (deadline <= current) return { status: 'expired', label: '已过预计时间 · 等待确认' };
  const minutes = Math.ceil((deadline - current) / 60000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), remainder = minutes % 60;
  const duration = `${days ? `${days}天` : ''}${hours ? `${hours}小时` : ''}${remainder ? `${remainder}分钟` : ''}`;
  const approximate = /^原文近似时间/.test(action.timeNote ?? '');
  const point = /^原文预计时刻/.test(action.timeNote ?? '');
  return { status: 'upcoming', label: approximate ? `约${duration}后` : point ? `预计${duration}后` : `预计${duration}内` };
}

export const stageText = (action: BenefitAction, now: string) => ['promised', 'in_progress'].includes(action.stage) && announcementCountdown(action, now).status === 'expired' ? '已过预计时间 · 等待确认' : ({ promised: '发放预告', in_progress: '进行中', claimed_complete: '公告称已完成', cancelled: '已取消' }[action.stage]);
export function calendarDays(now: string) {
  const end = new Date(`${dateKey(now)}T12:00:00+08:00`);
  const monday = (end.getUTCDay() + 6) % 7;
  const start = end.getTime() - (25 * 7 + monday) * 86400000;
  return Array.from({ length: 182 }, (_, index) => dateKey(start + index * 86400000));
}
export const preferenceDefaults = { announcement: true, result: true, activity: false, correction: true };
/** The built-in manual source is not an automatic collector. Freshness is projected server-side using each configured interval. */
export function sourceStatus(sources: PublicData['sources']) {
  const automated=sources.filter(s=>s.id!=='manual');
  if(!automated.length)return {label:'自动更新暂未启用',warning:true};
  if(automated.every(s=>s.status==='paused'))return {label:'自动更新已暂停',warning:true};
  const active=automated.filter(s=>s.status!=='paused');
  if(active.every(s=>s.status==='unconnected'))return {label:'等待首次更新',warning:true};
  if(active.some(s=>['failed','delayed','unconnected'].includes(s.status)))return {label:'部分消息更新延迟',warning:true};
  if(active.every(s=>s.status==='healthy'&&Number.isFinite(Date.parse(s.lastSuccessAt??''))))return {label:'自动检查公开消息',warning:false};
  return {label:'等待首次更新',warning:true};
}
export type Preferences = typeof preferenceDefaults;
