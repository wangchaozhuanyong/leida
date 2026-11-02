import type { BenefitAction, PublicData, Publication, RadarEvent } from './types';
import { isHistoricalArticle } from './history';
import {resetObservations} from './reset-observations';
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
/** A series snapshot retains every batch; an article describes its own batch. */
export function publicationActions(publication:Publication):BenefitAction[] {
  const actions=publication.event.actions,primary=publication.article.evidenceIds[0],at=publication.article.sourcePublishedAt;
  if(!at||actions.filter(a=>a.kind==='banked_reset'&&a.scope==='public').length<2)return actions;
  const own=actions.filter(a=>a.kind==='banked_reset'&&a.scope==='public'&&a.evidenceIds.includes(primary)&&Date.parse(a.statementAt)===Date.parse(at));
  return own.length?actions.filter(a=>a.kind!=='banked_reset'||a.scope!=='public'||own.includes(a)):actions;
}
/** Separate batches may share an event, but each record opens its own current
 * source article. A later batch does not turn an earlier batch into old news. */
export function actionPublication(data:PublicFactsData,event:RadarEvent,action:BenefitAction,current:Publication):Publication {
  if(action.kind!=='banked_reset'||event.actions.filter(a=>a.kind==='banked_reset'&&a.scope==='public').length<2)return current;
  const facts=(a:BenefitAction)=>JSON.stringify([a.id,a.kind,a.scope,a.stage,a.statementAt,a.eligibility,a.expectedAt,a.timeNote,a.evidenceQuote]);
  return data.publications.filter(p=>p.eventId===event.id&&!publicationWithdrawn(data,p)&&data.articles.some(a=>a.id===p.articleId&&a.publicationId===p.id)&&data.evidence.some(e=>e.id===p.article.evidenceIds[0]&&action.evidenceIds.includes(e.id)&&Date.parse(e.publishedAt)===Date.parse(action.statementAt))&&p.event.actions.some(a=>facts(a)===facts(action)))
    .sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0]??current;
}
export function publicActions(data: PublicFactsData) {
  const seen = new Set<string>();
  return data.events.filter(e => e.status === 'published').flatMap(event => {
    const publication = statePublication(data, event);
    if (!publication || publicationWithdrawn(data, publication)) return [];
    return publication.event.actions.filter(action => {
      const key = action.id;
      if (action.scope !== 'public' || seen.has(key)) return false;
      seen.add(key); return true;
    }).map(action => ({ action, event: publication.event, publication:actionPublication(data,publication.event,action,publication) }));
  });
}

/** Every completed public round counts; benefit type is not an event identity. */
export function completedPublicActions(data: PublicFactsData) {
  const now=Date.parse(data.serverTime);
  if(!Number.isFinite(now))return [];
  return publicActions(data).filter(({action,publication})=>action.stage==='claimed_complete'
    && Number.isFinite(Date.parse(action.statementAt))&&Date.parse(action.statementAt)<=now
    && Number.isFinite(Date.parse(publication.publishedAt))&&Date.parse(publication.publishedAt)<=now)
    .sort((a,b)=>Date.parse(b.action.statementAt)-Date.parse(a.action.statementAt)||a.action.id.localeCompare(b.action.id));
}
export const recentCompletedBenefits=(data:PublicFactsData)=>completedPublicActions(data).slice(0,5);

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
  const times = [publication.article.sourcePublishedAt, ...publicationActions(publication).map(action => action.statementAt)]
    .filter((value): value is string => !!value && Number.isFinite(Date.parse(value)));
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? publication.article.publishedAt;
}
const comparePublications = (a: Publication, b: Publication) => Date.parse(publicationSourceTime(b)) - Date.parse(publicationSourceTime(a))
  || Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id);

export const sortedPublications = (data: PublicData) => data.events.filter(e => e.status !== 'merged').map(e => currentPublication(data, e)).filter((p): p is Publication => !!p).sort(comparePublications);
export const sortedStatePublications = (data: PublicData) => {
  const observed=new Set(resetObservations(data).map(o=>o.publicationId));
  return data.events.filter(e=>e.status!=='merged').map(e=>data.publications.find(p=>p.id===e.publicationId&&(observed.has(p.id)||!isNewsOnly(p)))??data.publications.filter(p=>p.eventId===e.id&&(observed.has(p.id)||!isNewsOnly(p))).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0]).filter((p):p is Publication=>!!p).sort(comparePublications);
};
