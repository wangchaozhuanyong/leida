import type { Article, Evidence, PublicData, Publication } from './types';

export const PUBLIC_HISTORY_RULE_VERSION = 'history-compat-1';
const day = 24 * 3600_000;

/** Old flags can be false even when the first saved source was already historical. */
export function isHistoricalEvidence(evidence: Pick<Evidence, 'historical' | 'publishedAt' | 'collectedAt'>): boolean {
  if (evidence.historical) return true;
  const published = Date.parse(evidence.publishedAt), collected = Date.parse(evidence.collectedAt);
  return !Number.isFinite(published) || !Number.isFinite(collected) || collected - published > day;
}

/** Evaluate against first publication, never today's clock or a later Chinese wording update. */
export function isHistoricalContent(evidence: Evidence[], firstPublishedAt: string): boolean {
  const published = Date.parse(firstPublishedAt);
  return evidence.length > 0 && evidence.every(item => isHistoricalEvidence(item) ||
    !Number.isFinite(published) || published - Date.parse(item.publishedAt) > day);
}

export function isHistoricalArticle(article: Article, evidence: Evidence[]): boolean {
  if (article.historical) return true;
  const cited = evidence.filter(item => article.evidenceIds.includes(item.id));
  if (cited.length && cited.length === new Set(article.evidenceIds).size) return isHistoricalContent(cited, article.publishedAt);
  const source = Date.parse(article.sourcePublishedAt ?? ''), published = Date.parse(article.publishedAt);
  return Number.isFinite(source) && Number.isFinite(published) && published - source > day;
}

export function projectArticleHistory(article: Article, evidence: Evidence[]): Article {
  const times = evidence.filter(item => article.evidenceIds.includes(item.id)).map(item => Date.parse(item.publishedAt)).filter(Number.isFinite);
  const sourcePublishedAt = Number.isFinite(Date.parse(article.sourcePublishedAt ?? '')) ? article.sourcePublishedAt :
    times.length ? new Date(Math.max(...times)).toISOString() : article.sourcePublishedAt;
  return { ...article, historical: isHistoricalArticle(article, evidence), sourcePublishedAt };
}

/** Response projection only: immutable evidence and publication rows stay unchanged. */
export function projectPublicHistory(data: PublicData): PublicData {
  const evidence = data.evidence.map(item => ({ ...item, historical: isHistoricalEvidence(item) }));
  const articles = data.articles.map(article => projectArticleHistory(article, evidence));
  const publications: Publication[] = data.publications.map(publication => ({ ...publication,
    article: projectArticleHistory(publication.article, evidence) }));
  const historical = new Set(publications.filter(item => item.article.historical).map(item => item.id));
  // Keep important corrections, including manual corrections of historical material.
  const notices = data.notices.filter(notice => !historical.has(notice.publicationId) || notice.categories.includes('correction'));
  return { ...data, evidence, articles, publications, notices };
}
