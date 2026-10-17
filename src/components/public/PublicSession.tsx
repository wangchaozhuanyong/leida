'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PublicClock, PublicSession, idlePublicQuery, initialWechatAvailability } from './public-session';

const SessionContext = createContext<PublicSession | null>(null);
const noopSubscribe = () => () => {};

export function PublicSessionProvider({ children }: { children: ReactNode }) {
  const [session] = useState(() => new PublicSession());
  useEffect(() => {
    const stop = session.start();
    document.addEventListener('visibilitychange', session.resume);
    window.addEventListener('online', session.resume);
    window.addEventListener('offline', session.offline);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', session.resume);
      window.removeEventListener('online', session.resume);
      window.removeEventListener('offline', session.offline);
    };
  }, [session]);
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function usePublicQuery(endpoint: string | null, navigationKey = endpoint ?? '') {
  const session = useContext(SessionContext);
  if (!session) throw new Error('Public query requires PublicSessionProvider');
  const subscribe = useCallback((listener: () => void) => endpoint ? session.subscribe(endpoint, listener) : noopSubscribe(), [endpoint, session]);
  const snapshot = useCallback(() => endpoint ? session.snapshot(endpoint) : idlePublicQuery, [endpoint, session]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => endpoint ? session.activate(endpoint) : undefined, [endpoint, navigationKey, session]);
  useEffect(() => {
    if (!value.data || endpoint !== '/api/v1/bootstrap?view=home') return;
    const timer = window.setTimeout(() => { if (document.visibilityState === 'visible') void session.ensure('/api/v1/bootstrap?view=calendar'); }, 800);
    return () => window.clearTimeout(timer);
  }, [endpoint, !!value.data, session]);
  const refresh = useCallback(() => endpoint ? session.refresh(endpoint) : Promise.resolve(), [endpoint, session]);
  const applyUpdates = useCallback(() => { if (endpoint) session.applyUpdates(endpoint); }, [endpoint, session]);
  const more = useCallback(() => endpoint ? session.more(endpoint) : Promise.resolve(), [endpoint, session]);
  return { ...value, navigationLoading: !value.data && value.initialLoading, refresh, more, applyUpdates, currentTime: () => session.clock.current(value.data?.serverTime ?? '') };
}

export function useWechatAvailability(enabled: boolean) {
  const session = useContext(SessionContext);
  if (!session) throw new Error('Wechat availability requires PublicSessionProvider');
  const value = useSyncExternalStore(session.subscribeAvailability, session.getAvailability, () => initialWechatAvailability);
  useEffect(() => { if (enabled) void session.ensureAvailability(); }, [enabled, session]);
  const retry = useCallback(() => { void session.ensureAvailability(true); }, [session]);
  return { ...value, retry };
}

export function usePublicContentVersion(): string | null {
  const session = useContext(SessionContext);
  return useSyncExternalStore(session?.subscribeContentVersion ?? noopSubscribe, session?.getContentVersion ?? (() => null), () => null);
}

/** Static-rendered components remain usable without a session (including existing fixture tests). */
export function usePublicClock(serverTime: string): string {
  const session = useContext(SessionContext);
  const fallback = useRef<PublicClock | null>(null);
  if (!fallback.current) fallback.current = new PublicClock();
  const [fallbackTime, setFallbackTime] = useState(serverTime);
  useSyncExternalStore(session?.subscribeClock ?? noopSubscribe, session?.getClockSnapshot ?? (() => ''), () => serverTime);
  useEffect(() => {
    if (session) { session.observeClock(serverTime); return; }
    fallback.current!.receive(serverTime);
    const tick = () => setFallbackTime(fallback.current!.current(serverTime));
    tick();
    const timer = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [session, serverTime]);
  return session ? session.clock.current(serverTime) : fallbackTime;
}
