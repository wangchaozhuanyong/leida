'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, type MouseEventHandler } from 'react';
import {
  captureReadingPosition, parsePublicRoute, publicLocationKey, PublicNavigationMemory,
  readingScrollTarget, replacePublicFilter, type PublicFilterKey, type ReadingPosition,
} from './public-navigation';

function readingItems() {
  return Array.from(document.querySelectorAll<HTMLElement>('#public-main [data-reading-id]')).map(element => {
    const rect = element.getBoundingClientRect();
    return { id: element.dataset.readingId!, top: rect.top, bottom: rect.bottom };
  });
}

function snapshot() { return captureReadingPosition(readingItems(), window.scrollY, window.innerHeight); }
function hrefNow() { return `${location.pathname}${location.search}${location.hash}`; }
function scrollToHash(hash: string) {
  if (!hash) return false;
  let id = hash.slice(1);
  try { id = decodeURIComponent(id); } catch { /* Use the literal ID for malformed fragments. */ }
  const element = document.getElementById(id);
  if (!element) return false;
  element.scrollIntoView({ behavior: 'instant', block: 'start' });
  return true;
}

/** Mounted once in the shared public layout. Next Link remains the only router. */
export function usePublicNavigation(pathname: string, queryString: string, contentIdentity: unknown, routeReady = true) {
  const memory = useRef(new PublicNavigationMemory());
  const href = `${pathname}${queryString ? `?${queryString}` : ''}`;
  const key = publicLocationKey(href);
  const current = useRef({ key, href, identity: contentIdentity });
  const pending = useRef<ReadingPosition | null>(null);
  const live = useRef<ReadingPosition | null>(null);
  const transitioning = useRef(false);
  const userScroll = useRef(false);
  const lastScrollIntent = useRef(0);
  const hashToRestore = useRef('');
  const locationSeen = useRef(false);
  const frame = useRef<number | null>(null);
  const ready = contentIdentity !== null && contentIdentity !== undefined || parsePublicRoute(pathname, new URLSearchParams(queryString)).readPath === null;

  const savePosition = useCallback(() => {
    const position = snapshot();
    live.current = position;
    memory.current.positions.set(current.current.key, position);
    return position;
  }, []);

  useLayoutEffect(() => {
    if (!routeReady) {
      transitioning.current = true;
      if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
      return;
    }
    const changed = current.current.key !== key;
    if (changed || !locationSeen.current) hashToRestore.current = location.hash;
    locationSeen.current = true;
    if (changed) {
      // Link/filter handlers captured the old DOM; popstate uses the last scroll snapshot.
      if (live.current) memory.current.positions.set(current.current.key, live.current);
      pending.current = memory.current.positions.get(key) ?? { y: 0, ids: [] };
      userScroll.current = false;
    } else if (current.current.identity !== contentIdentity && !pending.current && !transitioning.current) {
      pending.current = live.current;
    }
    current.current = { key, href, identity: contentIdentity };
    memory.current.visit(hrefNow());
    transitioning.current = false;
    userScroll.current = false;

    const restore = () => {
      if (userScroll.current) { pending.current = null; savePosition(); return; }
      // Explicit fragments outrank a cached list position, including after async content arrives.
      if (hashToRestore.current && scrollToHash(hashToRestore.current)) {
        pending.current = null;
        hashToRestore.current = '';
      }
      else if (ready && pending.current) {
        const top = readingScrollTarget(pending.current, readingItems(), window.scrollY);
        window.scrollTo({ top, behavior: 'instant' });
        pending.current = null;
      } else if (changed && !ready) window.scrollTo({ top: 0, behavior: 'instant' });
      if (ready) savePosition();
    };
    restore();
    // The same position is applied after Next commits its own layout bookkeeping.
    // Keep that target immutable: a programmatic scroll event from route/history
    // restoration must not replace it between this layout effect and the frame.
    const restorePosition = live.current;
    if (ready && frame.current !== null) cancelAnimationFrame(frame.current);
    if (ready) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (current.current.key === key && !transitioning.current && !userScroll.current && restorePosition) {
        if (hashToRestore.current && scrollToHash(hashToRestore.current)) hashToRestore.current = '';
        else window.scrollTo({ top: readingScrollTarget(restorePosition, readingItems(), window.scrollY), behavior: 'instant' });
        savePosition();
      }
    });
  }, [key, href, contentIdentity, ready, routeReady, savePosition]);

  useEffect(() => {
    const previous = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    const onScroll = () => { if (!pending.current && !transitioning.current && frame.current === null) savePosition(); };
    const onIntent = () => {
      userScroll.current = true;
      lastScrollIntent.current = performance.now();
      pending.current = null;
      hashToRestore.current = '';
      if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    };
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) onIntent();
    };
    const onHash = () => { onIntent(); scrollToHash(location.hash); savePosition(); };
    const main = document.getElementById('public-main');
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (transitioning.current || pending.current || frame.current !== null || !live.current) return;
      if (performance.now() - lastScrollIntent.current < 150) { savePosition(); return; }
      // Images, expanded details and font changes may change layout without new data.
      const top = readingScrollTarget(live.current, readingItems(), window.scrollY);
      if (Math.abs(top - window.scrollY) > 1) window.scrollTo({ top, behavior: 'instant' });
      savePosition();
    });
    if (main) observer?.observe(main);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('wheel', onIntent, { passive: true });
    window.addEventListener('touchstart', onIntent, { passive: true });
    window.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    return () => {
      history.scrollRestoration = previous;
      observer?.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('wheel', onIntent);
      window.removeEventListener('touchstart', onIntent);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onHash);
    };
  }, [savePosition]);

  const onNavigateCapture: MouseEventHandler = useCallback(event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const element = event.target instanceof Element ? event.target.closest('a') : null;
    if (!(element instanceof HTMLAnchorElement) || element.target === '_blank' || element.hasAttribute('download')) return;
    const url = new URL(element.href, location.href);
    if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) return;
    savePosition();
    const destination = `${url.pathname}${url.search}${url.hash}`;
    memory.current.navigate(hrefNow(), destination);
    if (publicLocationKey(destination) !== current.current.key) transitioning.current = true;
    else if (url.hash) requestAnimationFrame(() => { scrollToHash(url.hash); savePosition(); });
  }, [savePosition]);

  const changeFilter = useCallback((name: PublicFilterKey, value: string | null) => {
    const previousHref = hrefNow();
    const next = replacePublicFilter(previousHref, name, value);
    if (next === previousHref) return;
    savePosition();
    // A filtered activity remains a child of its original source, rather than itself.
    const source = memory.current.sources.get(publicLocationKey(previousHref));
    if (source) memory.current.sources.set(publicLocationKey(next), source);
    transitioning.current = true;
    history.replaceState(null, '', next);
  }, [savePosition]);

  return {
    // The current selection must be visible during this render, before visit's layout effect.
    navHref: (target: string) => routeReady && target === pathname ? href : memory.current.navHref(target),
    backHref: memory.current.backHref(href),
    changeFilter,
    onNavigateCapture,
  };
}
