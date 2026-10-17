import { mergePublicPage, type PublicPage, type PublicReadEnvelope } from '../../lib/public-read';
import type { PublicData } from '../../lib/types';

export interface PublicQuerySnapshot {
  data: PublicData | null;
  page?: PublicPage;
  initialLoading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: string;
  moreError: string;
  updateAvailable?: boolean;
}
export interface WechatAvailability {
  status: 'checking' | 'ready' | 'unavailable' | 'error';
  codeAvailable: boolean;
}
type Listener = () => void;
type Revision = Pick<PublicReadEnvelope, 'version' | 'contentVersion'>;
type Timer = ReturnType<typeof setTimeout>;
export const PUBLIC_POLL_MS = 300_000;
interface SessionOptions {
  fetch?: typeof fetch;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  isVisible?: () => boolean;
}
interface Entry {
  snapshot: PublicQuerySnapshot;
  revision?: Revision;
  pages: number;
  active: number;
  listeners: Set<Listener>;
  validatedAt: number;
  touched: number;
  candidate?: {result: PublicReadEnvelope; pages: number};
  errorKind?: 'body' | 'connection' | 'state';
  pending?: { kind: 'refresh' | 'more'; promise: Promise<void> };
}
class SessionStoppedError extends Error {}
const emptySnapshot = (): PublicQuerySnapshot => ({ data: null, initialLoading: true, refreshing: false, loadingMore: false, error: '', moreError: '' });
export const idlePublicQuery: PublicQuerySnapshot = { ...emptySnapshot(), initialLoading: false };
export const initialWechatAvailability: WechatAvailability = { status: 'checking', codeAvailable: false };

/** Server time advances from a monotonic arrival anchor, including while no dial is mounted. */
export class PublicClock {
  private anchor?: { server: number; received: number };
  constructor(private readonly now: () => number = () => performance.now()) {}
  receive(serverTime: string): void {
    const parsed = Date.parse(serverTime);
    if (!Number.isFinite(parsed)) return;
    const received = this.now();
    const previous = this.anchor ? this.anchor.server + Math.max(0, received - this.anchor.received) : parsed;
    this.anchor = { server: Math.max(parsed, previous), received };
  }
  current(fallback: string): string {
    return this.anchor ? new Date(this.anchor.server + Math.max(0, this.now() - this.anchor.received)).toISOString() : fallback;
  }
}

/** One in-memory store per public layout; no page bodies are persisted to browser storage. */
export class PublicSession {
  private readonly entries = new Map<string, Entry>();
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly later: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;
  private readonly visible: () => boolean;
  private revision?: Revision;
  private stateRequest?: Promise<void>;
  private versionRequest?: Promise<boolean>;
  private pollTimer?: Timer;
  private clockTimer?: Timer;
  private running = false;
  private failures = 0;
  private lastForegroundCheckAt = -Infinity;
  private epoch = 0;
  private readonly controllers = new Set<AbortController>();
  private availability = initialWechatAvailability;
  private availabilityAt = -Infinity;
  private availabilityRequest?: Promise<void>;
  private readonly availabilityListeners = new Set<Listener>();
  private readonly clockListeners = new Set<Listener>();
  private readonly revisionListeners = new Set<Listener>();
  private clockValue = '';
  readonly clock: PublicClock;

  constructor(options: SessionOptions = {}) {
    this.fetcher = options.fetch ?? ((...args) => fetch(...args));
    this.now = options.now ?? (() => performance.now());
    this.later = ((...args: Parameters<typeof setTimeout>) => options.setTimeout ? options.setTimeout(...args) : globalThis.setTimeout(...args)) as typeof setTimeout;
    this.cancel = ((...args: Parameters<typeof clearTimeout>) => options.clearTimeout ? options.clearTimeout(...args) : globalThis.clearTimeout(...args)) as typeof clearTimeout;
    this.visible = options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible');
    this.clock = new PublicClock(this.now);
  }

  private entry(endpoint: string): Entry {
    let entry = this.entries.get(endpoint);
    if (!entry) {
      entry = { snapshot: emptySnapshot(), pages: 0, active: 0, listeners: new Set(), validatedAt: -Infinity, touched: this.now() };
      this.entries.set(endpoint, entry);
    }
    entry.touched = this.now();
    return entry;
  }
  snapshot = (endpoint: string): PublicQuerySnapshot => this.entry(endpoint).snapshot;
  subscribe(endpoint: string, listener: Listener): () => void {
    const entry = this.entry(endpoint);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }
  activate(endpoint: string): () => void {
    const entry = this.entry(endpoint);
    entry.active++;
    this.prune();
    void this.ensure(endpoint);
    return () => { entry.active = Math.max(0, entry.active - 1); this.prune(); };
  }
  private prune(): void {
    const pinned = (endpoint: string) => {
      const query = new URL(endpoint, 'https://local.invalid').searchParams;
      return ['home','notices'].includes(query.get('view') || '') || ['news','history'].includes(query.get('view') || '') && (!query.get('filter') || query.get('filter') === 'all');
    };
    for (const [key, entry] of [...this.entries].sort((a,b) => a[1].touched-b[1].touched)) {
      if (this.entries.size <= 20) break;
      if (!entry.active && !entry.pending && !entry.listeners.size && !pinned(key)) this.entries.delete(key);
    }
  }
  applyUpdates(endpoint: string): void {
    const entry = this.entry(endpoint), candidate = entry.candidate;
    if (!candidate) return;
    entry.candidate = undefined;
    entry.revision = candidate.result;
    entry.pages = candidate.pages;
    this.update(entry, {data:candidate.result.data, page:candidate.result.page, updateAvailable:false});
  }
  private observed(entry: Entry): Revision | undefined { return entry.candidate?.result ?? entry.revision; }
  private update(entry: Entry, patch: Partial<PublicQuerySnapshot>): void {
    entry.snapshot = { ...entry.snapshot, ...patch };
    entry.listeners.forEach(listener => listener());
  }
  getContentVersion = (): string | null => this.revision?.contentVersion ?? null;
  subscribeContentVersion = (listener: Listener): (() => void) => {
    this.revisionListeners.add(listener);
    return () => { this.revisionListeners.delete(listener); };
  };
  private setRevision(revision: Revision): void {
    const previous = this.revision?.contentVersion;
    this.revision = revision;
    if (previous !== revision.contentVersion) this.revisionListeners.forEach(listener => listener());
  }
  private async request<T>(endpoint: string, consume: (response: Response) => Promise<T>, timeout = 10000, headers?: HeadersInit): Promise<T> {
    const controller = new AbortController();
    const epoch = this.epoch;
    let timedOut = false;
    this.controllers.add(controller);
    const timer = this.later(() => { timedOut = true; controller.abort(); }, timeout);
    try {
      const result = await consume(await this.fetcher(endpoint, { cache: 'no-store', signal: controller.signal, headers:{...headers,'X-Radar-Watch-Contract':'2'} }));
      if (epoch !== this.epoch) throw new SessionStoppedError();
      if (timedOut) throw new Error('加载超时，请重试');
      return result;
    } catch (cause) {
      if (epoch !== this.epoch) throw new SessionStoppedError();
      if (cause instanceof SessionStoppedError) throw cause;
      if (timedOut) throw new Error('加载超时，请重试');
      if (cause instanceof TypeError) throw new Error('连接暂时中断，请重试');
      if (cause instanceof SyntaxError) throw new Error('资料暂时不可用，请重试');
      throw cause;
    } finally { this.cancel(timer); this.controllers.delete(controller); }
  }
  private async read(endpoint: string): Promise<PublicReadEnvelope> {
    return this.request(endpoint, async response => {
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.data?.events) || typeof result.version !== 'string' || typeof result.contentVersion !== 'string') throw new Error('暂时无法获取资料，请重试');
      return result as PublicReadEnvelope;
    });
  }
  private cursorEndpoint(endpoint: string, cursor: string): string {
    return `${endpoint}${endpoint.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;
  }
  private receiveTime(serverTime: string): void {
    this.clock.receive(serverTime);
    this.tickClock();
  }
  private tickClock = (): void => {
    const value = this.clock.current(this.clockValue);
    if (value !== this.clockValue) { this.clockValue = value; this.clockListeners.forEach(listener => listener()); }
  };
  private scheduleClock(): void {
    if(this.clockTimer || !this.clockListeners.size || !this.visible())return;
    this.clockTimer=this.later(()=>{this.clockTimer=undefined;if(this.visible())this.tickClock();this.scheduleClock();},1000);
  }
  getClockSnapshot = (): string => this.clockValue;
  observeClock(serverTime: string): void { this.receiveTime(serverTime); }
  subscribeClock = (listener: Listener): (() => void) => {
    this.clockListeners.add(listener);
    this.tickClock();this.scheduleClock();
    return () => {
      this.clockListeners.delete(listener);
      if (!this.clockListeners.size && this.clockTimer) { this.cancel(this.clockTimer); this.clockTimer = undefined; }
    };
  };

  async ensure(endpoint: string): Promise<void> {
    const entry = this.entry(endpoint);
    if (!entry.snapshot.data) return this.refresh(endpoint);
    if (this.revision && this.observed(entry)?.contentVersion !== this.revision.contentVersion) return this.refresh(endpoint, true);
    if (this.revision && this.observed(entry)?.version !== this.revision.version) {
      await this.refreshSources();
      if (entry.revision?.contentVersion !== this.revision?.contentVersion) await this.refresh(endpoint);
    }
    if (this.now()-entry.validatedAt>=PUBLIC_POLL_MS) {
      await this.checkVersion(true);
      if(this.revision && this.observed(entry)?.contentVersion !== this.revision.contentVersion)await this.refresh(endpoint,true);
    }
  }

  refresh(endpoint: string, background = false): Promise<void> {
    const entry = this.entry(endpoint);
    if (entry.pending) return entry.pending.kind === 'refresh' ? entry.pending.promise : entry.pending.promise.then(() => this.refresh(endpoint));
    if (!background) this.applyUpdates(endpoint);
    const previousRevision = this.revision;
    const epoch = this.epoch;
    const pageCount = Math.max(1, entry.pages);
    this.update(entry, { initialLoading: !entry.snapshot.data, refreshing: !!entry.snapshot.data });
    const promise = Promise.resolve().then(async () => {
      let stopped = false;
      try {
        if (epoch !== this.epoch) throw new SessionStoppedError();
        let result = await this.read(endpoint);
        const contentVersion = result.contentVersion;
        let pages = 1;
        while (pages < pageCount && result.page?.nextCursor) {
          const next = await this.read(this.cursorEndpoint(endpoint, result.page.nextCursor));
          if (next.contentVersion !== contentVersion || !next.page) throw new Error('资料正在更新，已保留原内容，请重试');
          result = { ...next, data: mergePublicPage(result.data, next.data), page: { ...next.page, ids: [...new Set([...result.page.ids, ...next.page.ids])] } };
          pages++;
        }
        if (this.revision !== previousRevision && this.revision?.contentVersion !== contentVersion) throw new Error('资料正在更新，已保留原内容，请重试');
        const before = entry.snapshot.data;
        const view = new URL(endpoint, 'https://local.invalid').searchParams.get('view');
        const onlyAdditions = background && before && ['news','history'].includes(view || '') && result.data.publications.length > before.publications.length &&
          (['publications','articles','events','evidence','notices'] as const).every(key => before[key].every(item => result.data[key].some(next => next.id === item.id && JSON.stringify(next) === JSON.stringify(item))));
        if (onlyAdditions) entry.candidate = {result, pages};
        else { entry.candidate = undefined; entry.revision = result; entry.pages = pages; }
        entry.validatedAt = this.now();
        this.lastForegroundCheckAt = this.now();
        if (this.revision === previousRevision) this.setRevision(result);
        this.receiveTime(result.data.serverTime);
        entry.errorKind = undefined;
        this.update(entry, { ...(onlyAdditions ? {} : {data:result.data,page:result.page}), updateAvailable:!!onlyAdditions, error:'', moreError:'' });
      } catch (cause) {
        stopped = cause instanceof SessionStoppedError;
        if (!stopped) { entry.errorKind = 'body'; this.update(entry, { error: cause instanceof Error ? cause.message : '连接暂时中断，请重试' }); }
      } finally {
        entry.pending = undefined;
        this.update(entry, { initialLoading: false, refreshing: false });
        if (stopped && this.running && entry.active) void this.ensure(endpoint);
      }
    });
    entry.pending = { kind: 'refresh', promise };
    return promise;
  }

  more(endpoint: string): Promise<void> {
    this.applyUpdates(endpoint);
    const entry = this.entry(endpoint), cursor = entry.snapshot.page?.nextCursor;
    if (entry.pending) return entry.pending.promise;
    if (!cursor || !entry.snapshot.data) return Promise.resolve();
    this.update(entry, { loadingMore: true, moreError: '' });
    const epoch = this.epoch;
    const promise = Promise.resolve().then(async () => {
      try {
        if (epoch !== this.epoch) throw new SessionStoppedError();
        const result = await this.read(this.cursorEndpoint(endpoint, cursor));
        if (result.contentVersion !== entry.revision?.contentVersion || !result.page) throw new Error('资料已更新，请先刷新列表后继续加载');
        entry.pages++;
        entry.revision = { version: result.version, contentVersion: result.contentVersion };
        this.receiveTime(result.data.serverTime);
        this.update(entry, { data: mergePublicPage(entry.snapshot.data!, result.data), page: { ...result.page, ids: [...new Set([...entry.snapshot.page!.ids, ...result.page.ids])] }, moreError: '' });
      } catch (cause) { if (!(cause instanceof SessionStoppedError)) this.update(entry, { moreError: cause instanceof Error ? cause.message : '加载更多失败，请重试' }); }
      finally { entry.pending = undefined; this.update(entry, { loadingMore: false }); }
    });
    entry.pending = { kind: 'more', promise };
    return promise;
  }

  private refreshSources(): Promise<void> {
    if (this.stateRequest) return this.stateRequest;
    const previousRevision = this.revision;
    const epoch = this.epoch;
    this.stateRequest = Promise.resolve().then(async () => {
      try {
        if (epoch !== this.epoch) throw new SessionStoppedError();
        const state = await this.read('/api/v1/bootstrap?view=state');
        if (this.revision !== previousRevision && this.revision?.contentVersion !== state.contentVersion) return;
        this.receiveTime(state.data.serverTime);
        this.setRevision({ version: state.version, contentVersion: state.contentVersion });
        for (const entry of this.entries.values()) {
          if(entry.candidate?.result.contentVersion===state.contentVersion){entry.candidate.result={...entry.candidate.result,version:state.version,data:{...entry.candidate.result.data,sources:state.data.sources,serverTime:state.data.serverTime}};entry.validatedAt=this.now();}
          if (entry.snapshot.data && entry.revision?.contentVersion === state.contentVersion) {
            entry.revision = this.revision;
            entry.validatedAt = this.now();
            const patch: Partial<PublicQuerySnapshot> = { data: { ...entry.snapshot.data, sources: state.data.sources, serverTime: state.data.serverTime } };
            if (entry.errorKind === 'state') { entry.errorKind = undefined; patch.error = ''; }
            this.update(entry, patch);
          }
        }
      } catch (cause) {
        if (!(cause instanceof SessionStoppedError)) this.markConnectionError('来源状态暂时无法更新，请重试', 'state');
      } finally { this.stateRequest = undefined; }
    });
    return this.stateRequest;
  }
  private markConnectionError(message: string, kind: 'connection' | 'state' = 'connection'): void {
    for (const entry of this.entries.values()) if (entry.active && (!entry.snapshot.error || entry.errorKind === 'connection')) {
      entry.errorKind = kind;
      this.update(entry, { error: message });
    }
  }
  offline = (): void => { this.markConnectionError('网络已断开，已保留当前内容'); };

  private async synchronizeActive(): Promise<boolean> {
    const active = [...this.entries].filter(([, entry]) => entry.active);
    if (active.some(([, entry]) => entry.snapshot.data && this.observed(entry)?.contentVersion === this.revision?.contentVersion && this.observed(entry)?.version !== this.revision?.version)) await this.refreshSources();
    await Promise.all(active.filter(([, entry]) => !entry.snapshot.data || this.observed(entry)?.contentVersion !== this.revision?.contentVersion).map(([endpoint]) => this.refresh(endpoint, true)));
    const success = active.every(([, entry]) => !!entry.snapshot.data && this.observed(entry)?.version === this.revision?.version);
    for (const entry of this.entries.values()) if (this.observed(entry)?.version === this.revision?.version) entry.validatedAt = this.now();
    if (success) for (const [, entry] of active) if (entry.errorKind === 'connection') { entry.errorKind = undefined; this.update(entry, { error: '' }); }
    return success;
  }

  checkVersion = (force = false): Promise<boolean> => {
    if (this.versionRequest) return this.versionRequest;
    if (!this.visible() || !force && ![...this.entries.values()].some(entry => entry.active)) return Promise.resolve(true);
    this.lastForegroundCheckAt = this.now();
    const epoch = this.epoch;
    this.versionRequest = Promise.resolve().then(async () => {
      try {
        if (epoch !== this.epoch) throw new SessionStoppedError();
        const result = await this.request('/api/v1/version?light=1', async response => ({ status: response.status, ok: response.ok, data: response.status === 304 ? null : (await response.json()).data }), 10000, this.revision ? { 'If-None-Match': `"${this.revision.version}"` } : {});
        if (result.status === 304) return await this.synchronizeActive();
        if (!result.ok) throw new Error();
        const { data } = result;
        if (typeof data?.version !== 'string' || typeof data?.contentVersion !== 'string') throw new Error();
        this.setRevision({ version: data.version, contentVersion: data.contentVersion });
        return await this.synchronizeActive();
      } catch (cause) { if (cause instanceof SessionStoppedError) return true; this.markConnectionError('连接暂时中断，已保留当前内容'); return false; }
      finally { this.versionRequest = undefined; }
    });
    return this.versionRequest;
  };
  private schedule(): void {
    if (!this.running || !this.visible()) return;
    if (this.pollTimer) this.cancel(this.pollTimer);
    this.pollTimer = this.later(async () => {
      this.pollTimer = undefined;
      const success = await this.checkVersion();
      this.failures = success ? 0 : Math.min(4, this.failures + 1);
      this.schedule();
    }, Math.min(900000, PUBLIC_POLL_MS * 2 ** this.failures));
  }
  start(): () => void { this.running = true; this.schedule(); return () => this.stop(); }
  stop(): void {
    this.running = false;
    this.epoch++;
    if (this.pollTimer) { this.cancel(this.pollTimer); this.pollTimer = undefined; }
    if(this.clockTimer){this.cancel(this.clockTimer);this.clockTimer=undefined;}
    for (const controller of this.controllers) controller.abort();
  }
  resume = (): void => {
    if(!this.visible()){
      if(this.clockTimer){this.cancel(this.clockTimer);this.clockTimer=undefined;}
      if(this.pollTimer){this.cancel(this.pollTimer);this.pollTimer=undefined;}
      return;
    }
    this.tickClock();this.scheduleClock();
    if (!this.running) return;
    if (this.pollTimer) this.cancel(this.pollTimer);
    if (this.now()-this.lastForegroundCheckAt<60000) { this.schedule(); return; }
    void this.checkVersion().then(success => { this.failures = success ? 0 : Math.min(4, this.failures + 1); this.schedule(); });
  };

  getAvailability = (): WechatAvailability => this.availability;
  subscribeAvailability = (listener: Listener): (() => void) => {
    this.availabilityListeners.add(listener);
    return () => { this.availabilityListeners.delete(listener); };
  };
  private setAvailability(value: WechatAvailability): void { this.availability = value; this.availabilityListeners.forEach(listener => listener()); }
  ensureAvailability(force = false): Promise<void> {
    if (this.availabilityRequest) return this.availabilityRequest;
    if (!force && this.now() - this.availabilityAt < 60000) return Promise.resolve();
    this.setAvailability({ status: 'checking', codeAvailable: this.availability.codeAvailable });
    const epoch = this.epoch;
    this.availabilityRequest = Promise.resolve().then(async () => {
      let stopped = false;
      try {
        if (epoch !== this.epoch) throw new SessionStoppedError();
        const result = await this.request('/api/v1/wechat/availability', async response => ({ ok: response.ok, data: (await response.json()).data }), 10000);
        if (!result.ok || typeof result.data?.available !== 'boolean') throw new Error();
        this.setAvailability({ status: result.data.available ? 'ready' : 'unavailable', codeAvailable: result.data.codeAvailable === true });
      } catch (cause) {
        stopped = cause instanceof SessionStoppedError;
        if (!stopped) this.setAvailability({ status: 'error', codeAvailable: false });
      } finally {
        this.availabilityAt = stopped ? -Infinity : this.now();
        this.availabilityRequest = undefined;
        if (stopped && this.running && this.availabilityListeners.size) void this.ensureAvailability();
      }
    });
    return this.availabilityRequest;
  }
}
