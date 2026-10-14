import { DomainError } from './domain';

/** Warm the serving process, rather than the worker's separate memory cache. */
export function createNotificationPrewarmer(options: { fetcher?: typeof fetch; origin?: () => string; clock?: () => number } = {}) {
  const request = options.fetcher ?? fetch, clock = options.clock ?? Date.now;
  const flights = new Map<string, { until: number; promise: Promise<void> }>();
  return async function prepare(publicationId: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,180}$/.test(publicationId)) throw new DomainError('通知对应页面参数无效');
    const base = new URL(options.origin?.() ?? process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:5190');
    if (base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) throw new DomainError('通知页面服务地址不可用');
    const key = `${base.origin}:${publicationId}`, previous = flights.get(key);
    if (previous && previous.until > clock()) return previous.promise;
    if (flights.size >= 32) {
      for (const [id, item] of flights) if (item.until <= clock()) flights.delete(id);
      if (flights.size >= 32) flights.delete(flights.keys().next().value!);
    }
    const entry = { until: Infinity, promise: Promise.resolve() as Promise<void> };
    entry.promise = (async () => {
      const paths = ['/api/v1/bootstrap?view=home', `/api/v1/bootstrap?view=detail&entity=publications&id=${encodeURIComponent(publicationId)}`];
      const [home, detail] = await Promise.all(paths.map(async path => {
        const response = await request(new URL(path, base.origin), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw new DomainError('通知对应公开页面暂不可用');
        return response.json();
      }));
      const publication = detail?.data?.publications?.find((row: { id: string }) => row.id === publicationId);
      if (!home?.data || !publication || publication.event?.status !== 'published' || publication.article?.status !== 'published') throw new DomainError('通知对应公开版本尚未准备好');
      const event = detail.data.events?.find((row: { id: string }) => row.id === publication.eventId);
      const article = detail.data.articles?.find((row: { id: string }) => row.id === publication.articleId);
      if (event?.status !== 'published' || article?.status !== 'published') throw new DomainError('通知对应内容已撤回或不可分享');
    })();
    flights.set(key, entry);
    entry.promise.then(() => { entry.until = clock() + 2000; }, () => { entry.until = clock() + 5000; });
    return entry.promise;
  };
}

export const prepareNotificationPublicPage = createNotificationPrewarmer();
