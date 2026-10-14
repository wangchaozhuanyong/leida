export type NewsCategory = 'all' | 'reset' | 'activity' | 'product';
export type HistoryFilter = 'all' | 'automatic_reset' | 'banked_reset';
export type PublicFilterKey = 'category' | 'target' | 'day';

export function parsePublicRoute(pathname: string, query: URLSearchParams) {
  const path = pathname.split('/').filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const route = path[0] || 'home';
  const category = query.get('category');
  const newsCategory: NewsCategory = category === 'reset' || category === 'activity' || category === 'product' ? category : 'all';
  const target = query.get('target');
  const historyFilter: HistoryFilter = target === 'automatic' ? 'automatic_reset' : target === 'banked' ? 'banked_reset' : 'all';
  const view = route==='settings' ? 'notices' : ['history', 'news', 'methodology', 'notices'].includes(route) ? route
    : route === 'activities' ? 'activity'
    : ['events', 'articles', 'sources'].includes(route) ? 'detail'
    : route === 'home' ? 'home' : null;
  const params = view ? new URLSearchParams({ view }) : null;
  if (params) {
    if (view === 'detail' || view === 'activity') {
      if (path[1]) params.set('id', path[1]);
      if (view === 'detail') params.set('entity', route);
      for (const value of query.getAll('version')) params.append('version', value);
    }
    if (view === 'activity') {
      for (const key of ['day', 'publication']) for (const value of query.getAll(key)) params.append(key, value);
    }
    if (route === 'history') params.set('filter', historyFilter);
    if (route === 'news') params.set('filter', newsCategory);
  }
  return { path, route, newsCategory, historyFilter, readPath: params ? `/api/v1/bootstrap?${params}` : null };
}

/** Preserve fixed publication parameters and anchors when changing one filter. */
export function replacePublicFilter(href: string, key: PublicFilterKey, value: string | null) {
  const url = new URL(href, 'https://public.invalid');
  if (value === null || value === '' || value === 'all') url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function publicLocationKey(href: string) {
  const url = new URL(href, 'https://public.invalid');
  // Search parameter order is irrelevant; repeated fixed publication IDs remain intact.
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}

const mainPaths = new Set(['/', '/news', '/history', '/settings']);
export function isPublicMainPath(pathname: string) { return mainPaths.has(pathname); }

export function defaultPublicBackHref(pathname: string) {
  const route = pathname.split('/').filter(Boolean)[0] || 'home';
  return route === 'more' || route === 'notices' ? '/settings'
    : route === 'events' || route === 'sources' ? '/history'
    : route === 'articles' ? '/news' : '/';
}

export interface ReadingItem { id: string; top: number; bottom: number; }
export interface ReadingPosition { y: number; anchorId?: string; offset?: number; ids: string[]; }

export function captureReadingPosition(items: ReadingItem[], y: number, viewportHeight: number): ReadingPosition {
  // The first item whose readable body extends below the fixed mobile header.
  const anchor = items.find(item => item.bottom > 80 && item.top < viewportHeight);
  return { y, ids: items.map(item => item.id), ...(anchor ? { anchorId: anchor.id, offset: anchor.top } : {}) };
}

/** If an item was withdrawn, use the nearest surviving neighbor from the old list. */
export function readingScrollTarget(position: ReadingPosition, items: ReadingItem[], currentY: number) {
  if (!position.anchorId) return position.y;
  const available = new Map(items.map(item => [item.id, item]));
  let anchor = available.get(position.anchorId);
  const oldIndex = position.ids.indexOf(position.anchorId);
  for (let distance = 1; !anchor && distance < position.ids.length; distance++) {
    anchor = available.get(position.ids[oldIndex + distance]) ?? available.get(position.ids[oldIndex - distance]);
  }
  return anchor ? Math.max(0, currentY + anchor.top - (position.offset ?? 0)) : position.y;
}

/** Per-layout memory: never persists content, URL history or reading position to disk. */
export class PublicNavigationMemory {
  readonly positions = new Map<string, ReadingPosition>();
  readonly sources = new Map<string, string>();
  readonly sections = new Map<string, string>();

  visit(href: string) {
    const url = new URL(href, 'https://public.invalid');
    if (isPublicMainPath(url.pathname)) this.sections.set(url.pathname, href);
  }

  navHref(href: string) { return this.sections.get(href) ?? href; }

  backHref(href: string) {
    return this.sources.get(publicLocationKey(href)) ?? this.navHref(defaultPublicBackHref(href.split('?')[0].split('#')[0]));
  }

  navigate(from: string, to: string) {
    const fromKey = publicLocationKey(from), toKey = publicLocationKey(to);
    if (fromKey === toKey) return;
    const target = new URL(to, 'https://public.invalid');
    if (isPublicMainPath(target.pathname)) return;
    const ancestors = new Set([fromKey]);
    let ancestor = this.backHref(from);
    while (!ancestors.has(publicLocationKey(ancestor))) {
      const ancestorKey = publicLocationKey(ancestor);
      if (ancestorKey === toKey) return;
      ancestors.add(ancestorKey);
      const next = this.sources.get(ancestorKey);
      if (!next) break;
      ancestor = next;
    }
    this.sources.set(toKey, from);
  }
}
