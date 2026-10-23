/** @typedef {import('../../src/lib/types').Evidence} Evidence */

/** Presentation identity only: keep original evidence and publication history untouched. */
function displayEvidenceKey(item) {
  const text = item.text.replace(/\s+/g, ' ').trim();
  const url = item.url.trim();
  // A source observation has its own time and meaning even when it links to a post.
  if (/^observed-\d+$/.test(item.messageId) || item.metadata?.referenceReset) {
    return JSON.stringify(['observation', item.sourceId, item.messageId, item.publishedAt, url, text]);
  }
  // Post identity survives archive precision, URL aliases and share parameters.
  const post = url.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/(?:[a-z0-9_]{1,15}|i\/web)\/status\/(\d{1,20})(?:\/(?:photo|video)\/\d+)?\/?(?:[?#].*)?$/i);
  if (post) return JSON.stringify(['post', post[1], text]);
  // Other URLs may be updated in place; do not collapse distinct dated records.
  const at = Date.parse(item.publishedAt);
  return JSON.stringify(['source', /^https?:\/\//i.test(url) ? url : item.id, Number.isFinite(at) ? at : item.publishedAt, text]);
}

/** Prefer an official copy without reordering the caller's source list or changing it.
 * @param {Evidence[]} rows
 * @returns {Evidence[]}
 */
function uniqueDisplayEvidence(rows) {
  const grouped = new Map();
  for (const item of rows) {
    const key = displayEvidenceKey(item), previous = grouped.get(key);
    if (!previous || (previous.provenance !== 'official' && item.provenance === 'official')) grouped.set(key, item);
  }
  return [...grouped.values()];
}

module.exports = { uniqueDisplayEvidence };
