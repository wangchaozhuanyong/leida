import type { PublicData, Publication, RadarEvent } from './types';
import { isHistoricalArticle } from './history';
export type PublicFactsData = Pick<PublicData, 'events' | 'articles' | 'publications' | 'evidence' | 'serverTime'>;

export const currentPublication = (data: PublicFactsData, event: RadarEvent) => data.publications.find(p => p.id === event.publicationId);
export const isNewsOnly = (publication: Publication) => publication.mode === 'news_only' || publication.article.publicationMode === 'news_only';
export const publicationWithdrawn = (data: PublicFactsData, publication: Publication) => publication.event.status === 'withdrawn'
  || publication.article.status === 'withdrawn' || data.events.some(event => event.id === publication.eventId && event.status === 'withdrawn')
  || data.articles.some(article => article.id === publication.articleId && article.status === 'withdrawn');
export const statePublication = (data: PublicFactsData, event: RadarEvent) => {
  const current = currentPublication(data, event);
  if (current && !isNewsOnly(current)) return current;
  // Old imported data may have pointed the event at a news-only article. Keep its last factual snapshot.
  return data.publications.filter(p => p.eventId === event.id && !isNewsOnly(p))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
};
export function publicActions(data: PublicFactsData) {
  const seen = new Set<string>();
  return data.events.filter(e => e.status === 'published').flatMap(event => {
    const publication = statePublication(data, event);
    if (!publication || publicationWithdrawn(data, publication)) return [];
    return publication.event.actions.filter(action => {
      const key = action.id;
      if (action.scope !== 'public' || seen.has(key)) return false;
      seen.add(key); return true;
    }).map(action => ({ action, event: publication.event, publication }));
  });
}

/** Current published rounds only; an elapsed deadline never proves completion. */
export function pendingPublicActions(data: PublicFactsData, currentTime = data.serverTime) {
  const now = Date.parse(currentTime);
  if (!Number.isFinite(now)) return [];
  return publicActions(data).filter(({ action, publication }) => {
    if (!['promised', 'in_progress'].includes(action.stage) || !Number.isFinite(Date.parse(action.statementAt)) || Date.parse(action.statementAt) > now || !Number.isFinite(Date.parse(publication.publishedAt)) || Date.parse(publication.publishedAt) > now) return false;
    return !isHistoricalArticle(publication.article, data.evidence) || (!!action.expectedAt && Date.parse(action.expectedAt) > now);
  }).sort((a, b) => Date.parse(b.action.statementAt) - Date.parse(a.action.statementAt));
}

/** Import and rewording time must not move an old benefit announcement above new evidence. */
export function publicationSourceTime(publication: Publication): string {
  if (isNewsOnly(publication)) return publication.article.sourcePublishedAt ?? publication.article.publishedAt;
  const times = [publication.article.sourcePublishedAt, ...publication.event.actions.map(action => action.statementAt)]
    .filter((value): value is string => !!value && Number.isFinite(Date.parse(value)));
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? publication.article.publishedAt;
}
const comparePublications = (a: Publication, b: Publication) => Date.parse(publicationSourceTime(b)) - Date.parse(publicationSourceTime(a))
  || Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id);

export const sortedPublications = (data: PublicData) => data.events.filter(e => e.status !== 'merged').map(e => currentPublication(data, e)).filter((p): p is Publication => !!p).sort(comparePublications);
export const sortedStatePublications = (data: PublicData) => data.events.filter(e => e.status !== 'merged').map(e => statePublication(data, e)).filter((p): p is Publication => !!p).sort(comparePublications);
