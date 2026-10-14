import type { PublicData } from './types';
export type PublicView = 'home' | 'history' | 'news' | 'detail' | 'activity' | 'notices' | 'methodology' | 'state' | 'calendar';
export interface PublicReadOptions { view: PublicView; id?: string; entity?: 'events' | 'articles' | 'sources' | 'publications'; version?: string; day?: number; publications?: string[]; filter?: string; cursor?: string; }
export interface PublicPage { ids: string[]; nextCursor: string | null; total: number; }
export interface PublicReadEnvelope { data: PublicData; version: string; contentVersion: string; page?: PublicPage; }
export function mergePublicPage(old: PublicData, next: PublicData): PublicData {
  const merge = <T extends { id: string }>(a: T[], b: T[]) => [...new Map([...a, ...b].map(item => [item.id, item])).values()];
  return { ...next, events: merge(old.events, next.events), articles: merge(old.articles, next.articles), publications: merge(old.publications, next.publications), evidence: merge(old.evidence, next.evidence), notices: merge(old.notices, next.notices) };
}
