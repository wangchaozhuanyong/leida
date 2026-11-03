import type { Publication } from './types';

/** Share the selected immutable publication, rather than whichever version is current. */
export function publicationUrl(origin: string, publication: Pick<Publication, 'eventId' | 'id'>): string {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('无效的网站地址');
  const url = new URL(`/events/${encodeURIComponent(publication.eventId)}`, base.origin);
  url.searchParams.set('version', publication.id);
  return url.href;
}

/** A grouped source observation opens its date, while a single publication opens its fixed version. */
export function statusShareUrl(origin: string, publications: Publication[], snapshot: {publicationId?: string; sharePath: string}): string {
  const item = publications.find(publication => publication.id === snapshot.publicationId);
  if (item) return publicationUrl(origin, item);
  const url = new URL('/', origin);
  const [page, params] = snapshot.sharePath.split('?');
  if (page === '/pages/schedule/index') {
    const query = new URLSearchParams(params);
    const date = query.get('date');
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      url.pathname = '/history';
      url.searchParams.set('date', date);
      const kind = query.get('kind');
      if (kind === 'automatic_reset' || kind === 'banked_reset') url.searchParams.set('target', kind === 'banked_reset' ? 'banked' : 'automatic');
    }
  }
  return url.href;
}

export function isLocalShareUrl(value: string): boolean {
  const host = new URL(value).hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Next's internal request URL may use localhost; preserve the browser-facing Host. */
export function requestShareOrigin(request: Request): string {
  const internal = new URL(request.url);
  const authority = request.headers.get('host') || internal.host;
  if (/[\s,/?#@\\]/.test(authority)) throw new Error('无效的网站地址');
  const forwardedProtocol = request.headers.get('x-forwarded-proto');
  const protocol = forwardedProtocol === 'https' || forwardedProtocol === 'http' ? `${forwardedProtocol}:` : internal.protocol;
  const external = new URL(`${protocol}//${authority}`);
  if (!['http:', 'https:'].includes(external.protocol)) throw new Error('无效的网站地址');
  return external.origin;
}
