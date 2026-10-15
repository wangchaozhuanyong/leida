'use client';

import Link from 'next/link';
import { useSearchParams, usePathname } from 'next/navigation';
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {WechatEntryGuide} from './WechatEntryGuide';
import {sourceStatus} from './model';
import { customerNotice } from '@/lib/notice-display';
import type { Activity, BenefitAction, Evidence, Notice, PublicData, Publication } from '@/lib/types';
import { usePublicClock, usePublicQuery, useWechatAvailability } from './PublicSession';
import { parsePublicRoute } from './public-navigation';
import { usePublicNavigation } from './usePublicNavigation';
import { useFixedSnapshot } from './useFixedSnapshot';
import type {ForecastSnapshot} from '@/lib/forecast';
import {HistoricalReplayPanel} from './HistoricalReplayPanel';
import {ForecastPanel} from './ForecastPanel';
import {InstrumentDial} from './InstrumentDial';
import {StatusTimeline} from './StatusTimeline';
import {ResetOutlookPanel} from './ResetOutlookPanel';
import {publicResetOutlook} from '@/lib/reset-outlook';
import { actionLabels } from '@/lib/labels';
import { activityDayNumber, activityHomeVisible } from '@/lib/activity-display';
import { publicationUrl, isLocalShareUrl } from '@/lib/share';
import { createPosterFromEndpoint, savePosterImage, type PosterImage } from './poster-image';
import { statusPosterStyles, statusPosterVariant, type StatusPosterStyle } from '@/lib/status-poster-style';
import { activityPublicationUrl, activityShareQuery, buildActivityShare, parseActivityShare, resolveActivityShare, type ActivityDayShare } from '@/lib/activity-share';
import { briefTime, articleSourceTime, publicationSourceTime, publicationWithdrawn, sortedArticles, sortedStatePublications, currentPublication, dateKey, displayTime, elapsed, publicActions, safeUrl, statePublication, isNewsOnly, stageText } from './model';
import { latestSourceSuccess, publicArticleSummary, publicNavSection, latestCompletedBenefits, completionTime } from './model';

type IconName = 'radar' | 'home' | 'settings' | 'arrow' | 'back' | 'bell' | 'link' | 'share' | 'card' | 'clock' | 'check' | 'close' | 'external' | 'info' | 'refresh' | 'calendar' | 'news' | 'more';
function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4m10-4v4M3 11h18m-13 4h3m3 0h3" /></>,
    news: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h8M8 15h5" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    radar: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><path d="m12 12 7-7" /><circle cx="12" cy="12" r="1" /></>,
    home: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    settings: <><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    back: <path d="m14 5-7 7 7 7" />,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    link: <><path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></>,
    share: <><rect x="4" y="8" width="16" height="13" rx="2" /><path d="M12 15V2m-4 4 4-4 4 4" /></>,
    card: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18m-13 5h3m5-1v3m-1.5-1.5h3" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6l4 2" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    external: <><path d="M14 4h6v6m0-6-9 9M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-11v1" /></>,
    refresh: <><path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5" /></>,
  };
  return <svg className={`pub-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function Badge({ children, tone = '' }: { children: React.ReactNode; tone?: string }) { return <span className={`pub-badge ${tone}`}>{children}</span>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <div className="pub-empty"><Icon name="radar" /><h2>{title}</h2><p>{detail}</p></div>; }
function Brand({ name = '模钥重置雷达', subtitle }: { name?: string; subtitle?: string }) { return <div className="pub-brand"><span className="pub-brand-mark" aria-hidden="true"><img src="/brand/MOYAO_AI_Icon_Transparent.svg" alt="" width="40" height="40" /></span><div className="pub-brand-copy"><strong>{name}</strong>{subtitle && <p>{subtitle}</p>}</div></div>; }
function TextLink({ href, children }: { href: string; children: React.ReactNode }) { return <Link scroll={false} className="pub-text-link" href={href}>{children}<Icon name="arrow" /></Link>; }
function ExternalLink({ url, children }: { url: string; children: React.ReactNode }) {
  const href = safeUrl(url);
  return href ? <a href={href} className="pub-text-link" target="_blank" rel="noopener noreferrer">{children}<Icon name="external" /></a> : <span className="pub-muted">原始链接不可用</span>;
}
const readKey = 'moyao-read-notices-v1';
type NewsCategory = 'all' | PublicData['articles'][number]['category'];
type WechatEntryState = 'checking' | 'ready' | 'unavailable' | 'error';

// Only this reader can suspend on URL query hydration. The navigation shell stays mounted.
function PublicRouteReader({ onChange }: { onChange: (pathname: string, search: string) => void }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useLayoutEffect(() => { onChange(pathname, search); }, [pathname, search, onChange]);
  return null;
}
function ContentPlaceholder() {
  return <div className="pub-page-loading" role="status"><span className="pub-loading-ring" aria-hidden="true"/><span>加载中</span></div>;
}

export default function PublicApp() {
  const pathname = usePathname();
  const [locationState, setLocationState] = useState<{ pathname: string; search: string } | null>(null);
  const onLocation = useCallback((nextPath: string, search: string) => setLocationState(old => old?.pathname === nextPath && old.search === search ? old : { pathname: nextPath, search }), []);
  const queryReady = locationState?.pathname === pathname;
  const queryString = queryReady ? locationState.search : '';
  const query = useMemo(() => new URLSearchParams(queryString), [queryString]);
  const { path, route, newsCategory, historyFilter, readPath } = parsePublicRoute(pathname, query);
  const [read, setRead] = useState<string[]>([]);
  const [storageError, setStorageError] = useState('');
  const [poster, setPoster] = useState<Publication | null>(null);
  const [statusPoster, setStatusPoster] = useState<{ publication?: Publication; actionId: string; round: string; generatedAt: string } | null>(null);
  const [forecastPoster,setForecastPoster]=useState<ForecastSnapshot|null>(null);
  const forecastPosterState = useFixedSnapshot<ForecastSnapshot>(forecastPoster ? `/api/v1/forecasts/${encodeURIComponent(forecastPoster.id)}` : null, forecastPoster?.id ?? null);
  const [dayPoster, setDayPoster] = useState<ActivityDayShare | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [wechatReminders, setWechatReminders] = useState(false);
  const [toast, setToast] = useState('');
  const endpoint = queryReady ? readPath : null;
  const { data, page, initialLoading, refreshing, navigationLoading, loadingMore, error, moreError, refresh, more, applyUpdates, updateAvailable, currentTime } = usePublicQuery(endpoint, `${pathname}?${queryString}:${queryReady}`);
  const loading = initialLoading || refreshing;
  const { status: wechatEntry, codeAvailable: posterCodeAvailable, retry: retryWechat } = useWechatAvailability(route === 'home' || route === 'settings' || !!poster || !!statusPoster || !!dayPoster || wechatReminders);
  const { navHref, backHref, changeFilter, onNavigateCapture } = usePublicNavigation(pathname, queryString, data, queryReady && !navigationLoading);
  const setNewsCategory = (value: NewsCategory) => changeFilter('category', value === 'all' ? null : value);
  const setHistoryFilter = (value: string) => changeFilter('target', value === 'banked_reset' ? 'banked' : value === 'automatic_reset' ? 'automatic' : null);
  const activityCache = useRef(new Map<string, Activity>());
  const currentActivity = data?.activities.find(item => item.id === path[1]);
  useEffect(() => { if (currentActivity) activityCache.current.set(currentActivity.id, currentActivity); }, [currentActivity]);
  useEffect(() => {
    setPoster(null); setStatusPoster(null); setForecastPoster(null); setDayPoster(null);
    setShareLink(null); setWechatReminders(false); setToast('');
  }, [pathname, queryString]);
  useEffect(() => {
    try {
      const seen: unknown = JSON.parse(localStorage.getItem(readKey) || '[]');
      if (Array.isArray(seen)) setRead(seen.filter((value): value is string => typeof value === 'string'));
    } catch { setStorageError('暂时无法读取已读记录，本次打开仍可查看提醒。'); }
  }, []);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);
  const markRead = (ids: string[]) => { const next = Array.from(new Set([...read, ...ids])); setRead(next); try { localStorage.setItem(readKey, JSON.stringify(next)); } catch { setStorageError('已读记录只在本次打开期间生效。'); } };
  const shareUrl = async (url: string, title?: string) => {
    const originPage = location.pathname + location.search;
    const stillHere = () => location.pathname + location.search === originPage;
    if (navigator.share) {
      try { await navigator.share({ title: title || data?.site.name || '模钥重置雷达', url }); return; }
      catch (cause) { if (cause instanceof DOMException && cause.name === 'AbortError') return; }
    }
    if (!stillHere()) return;
    try { await navigator.clipboard.writeText(url); if (stillHere()) setToast('此版本链接已复制'); }
    catch { if (stillHere()) setShareLink(url); }
  };
  const share = async (publication?: Publication) => shareUrl(publication ? publicationUrl(location.origin, publication) : `${location.origin}${location.pathname}`, publication?.article.title);
  const subpage = !['home', 'settings', 'history', 'news'].includes(route);
  const navItems: { href: string; route: string; icon: IconName; label: string }[] = [{ href: '/', route: 'home', icon: 'radar', label: '首页' }, { href: '/news', route: 'news', icon: 'news', label: '动态' }, { href: '/history', route: 'history', icon: 'clock', label: '记录' }, { href: '/settings', route: 'settings', icon: 'bell', label: '提醒' }];
  const navSection = publicNavSection(route);
  const navigation = navItems.map(item => <Link scroll={false} key={item.route} href={navHref(item.href)} prefetch={true} className={navSection === item.route ? 'active' : ''} aria-current={navSection === item.route ? route === item.route ? 'page' : 'location' : undefined}><Icon name={item.icon} /><span>{item.label}</span></Link>);
  const collectedAt = data ? latestSourceSuccess(data.sources) : undefined;
  const latestArticle = data && sortedArticles(data.articles)[0];
  const visibleNotices = data?.notices.filter(customerNotice).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) || [];
  const selectedEvent = data?.events.find(event => event.id === path[1]);
  const selectedArticle = data?.articles.find(article => article.id === path[1]);
  const selectedVersion = route === 'events' ? query.get('version') || selectedEvent?.publicationId : route === 'articles' ? selectedArticle?.publicationId : undefined;
  const selectedPublication = data?.publications.find(publication => publication.id === selectedVersion);
  let cutoff = route === 'sources' ? data?.evidence.find(evidence => evidence.id === path[1])?.collectedAt : selectedVersion ? selectedPublication?.cutoffAt : data?.publications.reduce((latest, p) => p.cutoffAt > latest ? p.cutoffAt : latest, '');
  if (route === 'activities' && path[1] && query.getAll('publication').length && data) {
    try { const fixed = resolveActivityShare(data, parseActivityShare(path[1], new URLSearchParams(query.toString()))); cutoff = fixed.available ? fixed.cutoffAt : undefined; } catch { cutoff = undefined; }
  }
  const historical = !!data?.articles.length && data.articles.every(article => article.historical);
  const posterWithdrawn = !!poster && !!data && publicationWithdrawn(data, poster);
  let dayPosterCutoff = '', dayPosterError = '';
  if (dayPoster && data) {
    try { const resolved = resolveActivityShare(data, dayPoster); if (!resolved.available) throw new Error(resolved.blockedReason); dayPosterCutoff = resolved.cutoffAt; }
    catch (cause) { dayPosterError = cause instanceof Error ? cause.message : '所选版本暂时不可分享。'; }
  }
  const newsArticles = route === 'news' && data ? sortedArticles(data.articles.filter(article => newsCategory === 'all' || article.category === newsCategory)) : [];
  const historyPublications = route === 'history' && data ? sortedStatePublications(data).filter(p => p.event.actions.length && (historyFilter === 'all' || p.event.actions.some(action => action.kind === historyFilter))) : [];
  const pageTitle = ({ history: '重置公告', news: '动态', settings: '提醒', more: '更多', notices: '站内提醒', methodology: '观察记录', events: '事件详情', articles: '动态详情', sources: '原文来源', activities: '活动动态' } as Record<string, string>)[route] ?? '重置雷达';
  const failure = <div className="pub-empty" role="alert"><Icon name="info" /><h2>资料暂时无法加载</h2><p>{error || '请稍后重试。'}</p><button className="pub-button primary" onClick={() => void refresh()} disabled={loading}>{loading ? '正在重试…' : '重新加载'}</button></div>;
  const pending = error ? failure : <ContentPlaceholder />;
  let content: React.ReactNode;
  if (route === 'settings') content = <Settings notices={visibleNotices} read={read} markRead={markRead} storageError={storageError} data={data} codeAvailable={posterCodeAvailable} pending={!data ? error ? <div className="pub-inbox-empty" role="alert"><p>消息暂时无法加载，请稍后重试。</p><button className="pub-text-button" onClick={() => void refresh()} disabled={loading}>重新加载</button></div> : pending : undefined}/>;
  else if (route === 'more') content = <MorePage />;
  else if (route === 'news') content = <News articles={newsArticles} category={newsCategory} onCategoryChange={setNewsCategory} hasMore={!!page?.nextCursor} onMore={() => void more()} loading={loadingMore} pending={!data ? pending : undefined} />;
  else if (route === 'history') content = <History publications={historyPublications} filter={historyFilter} onFilter={setHistoryFilter} data={data} hasMore={!!page?.nextCursor} onMore={() => void more()} loading={loadingMore} pending={!data ? pending : undefined} />;
  else if (route === 'activities' && path[1]) content = <ActivityPage data={data} activity={data ? currentActivity : activityCache.current.get(path[1])} id={path[1]} query={query} onDay={value => changeFilter('day', value === null ? null : String(value))} pending={!data ? pending : undefined} onPoster={setPoster} onDayPoster={value => { setPoster(null); setDayPoster(value); }} />;
  else if (!readPath) content = <><Empty title="暂时没有这条记录" detail="链接可能已变化，请返回首页查看公开动态。" /><TextLink href="/">返回首页</TextLink></>;
  else if (!data) content = pending;
  else if (route === 'home') content = <Home data={data} onWechatReminders={() => setWechatReminders(true)} onPoster={(publication, actionId='') => setStatusPoster({ publication, actionId,round:(data.forecasts?.outlook??publicResetOutlook(data)).active?.publicationId??'waiting',generatedAt:currentTime()||data.serverTime })} onShare={share} historical={historical} wechatEntry={wechatEntry} />;
  else if (route === 'events' && path[1]) content = <EventPage data={data} id={path[1]} onPoster={setPoster} onShare={share} />;
  else if (route === 'articles' && path[1]) content = <ArticlePage data={data} id={path[1]} onPoster={setPoster} />;
  else if (route === 'sources' && path[1]) content = <EvidencePage data={data} id={path[1]} />;
  else if (route === 'notices') content = <Notices publications={data.publications} notices={visibleNotices} read={read} markRead={markRead} storageError={storageError} selectedId={query.get('message')} />;
  else if (route === 'methodology') content = <Methodology data={data} snapshotId={query.get('snapshot')} cadenceId={query.get('cadence')} onPoster={setForecastPoster} onShare={s=>shareUrl(`${location.origin}/methodology?snapshot=${encodeURIComponent(s.id)}`,'重置实验预测快照')} />;
  else content = <><Empty title="暂时没有这条记录" detail="链接可能已变化，请返回首页查看公开动态。" /><TextLink href="/">返回首页</TextLink></>;
  return <div className={`pub-shell route-${route} ${subpage ? 'is-detail' : ''}`} onClickCapture={onNavigateCapture}>
    <Suspense fallback={null}><PublicRouteReader onChange={onLocation} /></Suspense>
    <a className="pub-skip" href="#public-main">跳到主要内容</a>
    <header className="pub-topbar">
      <div className="pub-topbar-identity">{route === 'home' ? <Link scroll={false} href="/" className="pub-brand-home" aria-label="模钥重置雷达首页"><Brand name={data?.site.name} /></Link> : <div className="pub-topbar-heading">{subpage && <Link scroll={false} className="pub-header-back" href={backHref} aria-label="返回上级"><Icon name="back" /></Link>}{['news', 'history', 'settings', 'more', 'notices'].includes(route) ? <h1 className="pub-topbar-title">{pageTitle}</h1> : <span className="pub-topbar-title">{pageTitle}</span>}{!navigationLoading && data && ['news', 'history'].includes(route) && <span className="pub-context-count" role="status" aria-live="polite" aria-atomic="true">共{route === 'news' ? `${page?.total ?? newsArticles.length}篇` : `${page?.total ?? historyPublications.length}个事件`}</span>}</div>}</div>
      <nav className="pub-desktop-nav" aria-label="主导航">{navigation}</nav><div className="pub-sidebar-note"><span className="pub-status-dot" /> 公开消息追踪<small>所有时间 · 北京时间</small></div><Link scroll={false} className="pub-icon-button pub-more-button" href="/more" aria-label="更多"><Icon name="more" /></Link>
    </header>
    {subpage && <nav className="pub-page-back" aria-label="返回上级"><Link scroll={false} className="pub-back-link" href={backHref}><Icon name="back" />返回</Link></nav>}
    {route === 'home' && <div className="pub-home-heading">
      <div className="pub-home-heading-copy"><strong>Codex重置</strong><p>不要错过每一次重置。</p></div>
      {!navigationLoading && data && <details className="pub-freshness"><summary><span className={`pub-status-dot${error || sourceStatus(data.sources).warning ? ' is-delayed' : ''}`} />{error ? '连接中断，保留已有资料' : sourceStatus(data.sources).label}<Icon name="info" /></summary><div><p>最近采集成功：<time dateTime={collectedAt}>{collectedAt ? `${briefTime(collectedAt)} · 北京时间` : '暂无记录'}</time></p><p>最新消息发布于：<time dateTime={latestArticle ? articleSourceTime(latestArticle) : undefined}>{latestArticle ? `${briefTime(articleSourceTime(latestArticle))} · 北京时间` : '暂无记录'}</time></p><p>采集成功时间来自最近成功的来源，不代表所有来源同时更新。</p></div></details>}
    </div>}
    <main className="pub-main" id="public-main" tabIndex={-1}>
      {!navigationLoading && data && error && <div className="pub-warning" role="alert">连接暂时中断，保留上次成功获取的资料。<button className="pub-text-button" onClick={() => void refresh()}>重试</button></div>}
      {!navigationLoading && data && !error && sourceStatus(data.sources).warning && <div className="pub-warning" role="status">{sourceStatus(data.sources).label}，以下保留最近收录的资料。</div>}
      {updateAvailable && <button className="pub-update-prompt" onClick={applyUpdates}>有新内容 · 点击更新</button>}
      <Suspense fallback={<ContentPlaceholder />}>{content}</Suspense>
      {!navigationLoading && moreError && <div className="pub-pagination-error" role="alert">{moreError}<button className="pub-text-button" disabled={loadingMore} onClick={() => void more()}>重试加载更多</button></div>}
    </main>
    <footer className={`pub-footer ${subpage ? 'subpage' : ''}`}>{navigationLoading ? null : route==='methodology'&&query.get('snapshot') ? <p>预测资料截止时间见固定快照</p> : cutoff && !['home', 'events', 'articles', 'sources'].includes(route) ? <p>{historical ? '历史资料' : '资料截至'} · {displayTime(cutoff)}</p> : !data && !loading && !error && readPath ? <p>暂无已发布资料</p> : null}<p>所有时间均为北京时间</p><Link scroll={false} href="/more#privacy">隐私说明</Link></footer>
    <nav className="pub-bottom-nav" aria-label="手机主导航">{navigation}</nav>
    {statusPoster && <PosterModal statusDesign codeAvailable={posterCodeAvailable} target={{ id: `${statusPoster.publication?.id??'current'}:${statusPoster.actionId}`, cutoffAt: statusPoster.publication?.cutoffAt??statusPoster.generatedAt, title: '公开重置状态', endpoint: `/api/v1/posters/${encodeURIComponent(statusPoster.publication?.id??'current')}?${new URLSearchParams({ layout: 'status', action: statusPoster.actionId,round:statusPoster.round,at:statusPoster.generatedAt })}`, filename: `模钥重置雷达-重置状态-${dateKey(data?.serverTime || new Date().toISOString())}.png` }} name={data?.site.name || '模钥重置雷达'} blocked={data && statusPoster.publication && publicationWithdrawn(data, statusPoster.publication) ? '此内容已撤回，已停止生成海报。' : ''} onClose={() => setStatusPoster(null)} onShare={() => share(statusPoster.publication)} />}
    {poster && <PosterModal target={{ id: poster.id, cutoffAt: poster.cutoffAt, title: poster.article.title, endpoint: `/api/v1/posters/${encodeURIComponent(poster.id)}`, filename: `模钥重置雷达-${dateKey(poster.cutoffAt)}-${poster.id}.png` }} name={data?.site.name || '模钥重置雷达'} blocked={posterWithdrawn ? '此内容已撤回，已停止生成海报。' : ''} onClose={() => setPoster(null)} onShare={() => share(poster)} />}
    {!poster && dayPoster && <PosterModal target={{ id: `${dayPoster.activityId}:${dayPoster.day}:${dayPoster.publicationIds.join(',')}`, cutoffAt: dayPosterCutoff, title: `活动第${dayPoster.day}天整合海报`, endpoint: `/api/v1/activity-posters/${encodeURIComponent(dayPoster.activityId)}?${activityShareQuery(dayPoster)}`, filename: `模钥重置雷达-活动第${dayPoster.day}天.png` }} name={data?.site.name || '模钥重置雷达'} blocked={dayPosterError} onClose={() => setDayPoster(null)} onShare={() => shareUrl(activityPublicationUrl(location.origin, dayPoster), `活动第${dayPoster.day}天进展`)} />}
    {!poster && !dayPoster && forecastPoster && <PosterModal target={{id:forecastPoster.id,cutoffAt:forecastPoster.evidenceCutoffAt,title:'重置实验预测快照',endpoint:`/api/v1/forecast-posters/${encodeURIComponent(forecastPoster.id)}`,filename:`模钥重置雷达-实验预测-${forecastPoster.id}.png`}} name={data?.site.name||'模钥重置雷达'} blocked={forecastPosterState.unavailable ? '此固定预测记录已不可用，已停止生成与分享海报。' : ''} onClose={()=>setForecastPoster(null)} onShare={()=>shareUrl(`${location.origin}/methodology?snapshot=${encodeURIComponent(forecastPoster.id)}`,'重置实验预测快照')} />}
    {shareLink && <ShareLinkModal url={shareLink} onClose={() => setShareLink(null)} />}
    {wechatReminders && <WechatReminderModal data={data} dataError={error} onRetryData={() => void refresh()} entry={wechatEntry} codeAvailable={posterCodeAvailable} onRetryEntry={retryWechat} onClose={() => setWechatReminders(false)} />}
    {toast && <div className="pub-toast" role="status">{toast}</div>}
  </div>;
}

export function Home({ data, onWechatReminders, onPoster, onShare, historical, wechatEntry = 'checking' }: { data: PublicData; onWechatReminders: () => void; onPoster: (p?: Publication, actionId?: string) => void; onShare: (p?: Publication) => Promise<void>; historical: boolean; wechatEntry?: WechatEntryState }) {
  const outlook = data.forecasts?.outlook ?? publicResetOutlook(data);
  const completions = latestCompletedBenefits(data), latest = completions[0];
  const recent = sortedArticles(data.articles).map(article => data.publications.find(p => p.id === article.publicationId)).filter((p): p is Publication => !!p).slice(0, 3);
  const activity = data.activities.find(item => activityHomeVisible(item, data.serverTime));
  const activityDay = activity ? activityDayNumber(activity, data.serverTime) : undefined;
  const activityPhase = activityDay === undefined ? '活动动态' : activityDay < 1 ? '尚未开始' : activity && activityDay > activity.days ? '活动已结束' : `第${activityDay}天 / 共${activity?.days}天`;
  const latestRecord = <section className={`pub-instrument-last${outlook.active ? '' : ' is-featured'}`} aria-label="各类福利最近完成公告">
    {completions.length ? completions.map(item => <div className="pub-record-detail" key={item.action.kind}>
      <h2><Link scroll={false} href={`/events/${encodeURIComponent(item.event.id)}`} aria-label={`查看最近${item.action.kind === 'banked_reset' ? '重置卡发放' : '用量重置'}的公开依据`}>公告称已{item.action.kind === 'banked_reset' ? '发放重置卡' : '重置用量'}</Link></h2>
      <p className="pub-record-time"><time dateTime={item.action.statementAt}>{completionTime(item.action.statementAt)}</time><span> · 北京时间</span></p>
    </div>) : <div className="pub-record-detail pub-record-empty"><h2>暂无公开完成记录</h2><p className="pub-record-time">收录后将在这里更新</p></div>}
  </section>;
  return <>
    {historical && <p className="pub-warning">当前展示历史收录资料。</p>}
    <div className={`pub-instrument-layout${outlook.active ? '' : ' is-idle'}`}>
      <div className="pub-home-dial"><InstrumentDial outlook={outlook} serverTime={data.serverTime} completion={latest?.action ?? null}/></div>
      <StatusTimeline outlook={outlook} serverTime={data.serverTime} completion={latest?.action ?? null}/>
      <aside className="pub-instrument-summary" aria-label="重置状态与操作">
        {outlook.active?.timeNote && <details className="pub-home-time-note"><summary>预告时间说明</summary><p>{outlook.active.timeNote}</p></details>}
        {outlook.active ? <ResetOutlookPanel outlook={outlook} serverTime={data.serverTime} instrument /> : latestRecord}
        <div className="pub-instrument-actions">
          <Link scroll={false} href={outlook.active ? `/events/${encodeURIComponent(outlook.active.eventId)}` : latest ? `/events/${encodeURIComponent(latest.event.id)}` : '/history'} className="pub-button full pub-evidence-action"><Icon name="news"/><span className="pub-evidence-desktop">{outlook.active ? '查看原文依据' : '查看最近发放依据'}</span><span className="pub-evidence-mobile">查看依据</span><Icon name="arrow"/></Link>
          <button onClick={onWechatReminders} className="pub-button full pub-subscribe"><Icon name="bell"/><span>微信提醒</span>{wechatEntry === 'unavailable' && <small>待开放</small>}<Icon name="arrow"/></button>
        </div>
        <section className="pub-share-panel pub-share-compact" aria-labelledby="home-share-title">
          <div><h2 id="home-share-title">分享重置动态</h2><p>黑金 / 水墨 · 两款固定海报</p></div>
          <button className="pub-button" onClick={() => onPoster(latest?.publication, latest?.action.id)}>生成分享海报<Icon name="arrow"/></button>
        </section>
        {outlook.active && latestRecord}
        {activity && <Link scroll={false} className="pub-instrument-activity" href={`/activities/${encodeURIComponent(activity.id)}`}><Icon name="calendar"/><div><h2>{activity.title}</h2><p>{activityPhase} · 已收录{activity.items.length}项进展</p></div><span>查看进展 <Icon name="arrow"/></span></Link>}
      </aside>
    </div>
    <section className="pub-recent"><div className="pub-section-heading"><div><h2>最近动态</h2></div><TextLink href="/news">全部动态</TextLink></div><div className="pub-recent-grid">{recent.length ? recent.map(p => <Announcement key={p.id} publication={p} withdrawn={publicationWithdrawn(data,p)} />) : <Empty title="暂无公开公告" detail="采集并核验后的重置记录会显示在这里。" />}</div></section>
  </>;
}

function Announcement({ publication, withdrawn }: { publication: Publication; withdrawn: boolean }) {
  const { article, event } = publication;
  const actions = isNewsOnly(publication) ? [] : event.actions;
  const kinds = [...new Set(actions.map(a => actionLabels[a.kind]))];
  return <article className="pub-card pub-announcement" data-reading-id={article.id}><div className="pub-card-top"><Badge tone={actions.some(a => a.kind === 'banked_reset') ? 'purple' : 'cyan'}>{article.historical ? '历史收录 · ' : ''}{isNewsOnly(publication) ? '来源消息' : kinds.join('＋') || (article.category === 'activity' ? '活动动态' : '产品更新')}</Badge><time dateTime={publicationSourceTime(publication)} title={`${displayTime(publicationSourceTime(publication))} · 北京时间`}>{briefTime(publicationSourceTime(publication))}</time></div><h3><Link scroll={false} href={isNewsOnly(publication) ? `/articles/${encodeURIComponent(article.id)}` : `/events/${encodeURIComponent(event.id)}`}>{article.title}</Link></h3><p>{publicArticleSummary(article)}</p><div className="pub-card-top"><span className="pub-muted">{withdrawn ? '已撤回' : isNewsOnly(publication) ? '来源消息' : actions.some(a => a.stage === 'in_progress') ? '含进行中动作' : '公开公告'}</span><TextLink href={isNewsOnly(publication) ? `/articles/${encodeURIComponent(article.id)}` : `/events/${encodeURIComponent(event.id)}`}>查看详情</TextLink></div></article>;
}
function History({ publications, filter, onFilter, data, hasMore, onMore, loading, pending }: { publications: Publication[]; filter: string; onFilter: (value: string) => void; data: PublicData | null; hasMore:boolean; onMore:()=>void; loading:boolean; pending?: React.ReactNode }) {
  const months = new Map<string, Publication[]>();
  for (const publication of publications) {
    const month = dateKey(publicationSourceTime(publication)).slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), publication]);
  }
  return <><div className="pub-filter" role="group" aria-label="公告类型">{[['all', '全部'], ['automatic_reset', '用量重置'], ['banked_reset', '重置卡']].map(([value, label]) => <button key={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => onFilter(value)}>{label}</button>)}</div>{pending ?? (publications.length ? [...months].map(([month, rows]) => <section className="pub-history-month" key={month}><h2>{month.replace('-', '年')}月</h2><div className="pub-history-list">{rows.map(publication => <article className={`pub-history-item${publicationWithdrawn(data!, publication) ? ' is-withdrawn' : ''}`} key={publication.id} data-reading-id={publication.eventId}><time dateTime={publicationSourceTime(publication)}>{briefTime(publicationSourceTime(publication))}</time><div><h3><Link scroll={false} href={`/events/${encodeURIComponent(publication.eventId)}`}>{publication.article.title}</Link></h3><div className="pub-history-status">{publication.event.actions.map(action => <Badge key={action.id} tone={action.stage === 'claimed_complete' ? 'cyan' : 'amber'}>{actionLabels[action.kind]} · {stageText(action, data!.serverTime)}</Badge>)}{publicationWithdrawn(data!, publication) && <Badge>已撤回</Badge>}{publication.article.historical && <span>历史收录</span>}</div><p>{publicArticleSummary(publication.article)}</p><TextLink href={`/events/${encodeURIComponent(publication.eventId)}`}>查看依据与进展</TextLink></div></article>)}</div></section>) : <Empty title="暂无相关公告" detail="这个分类还没有已发布的事件。" />)}{hasMore && <button className="pub-button full" disabled={loading} onClick={onMore}>{loading ? '正在加载…' : '加载更多'}</button>}</>;
}

function News({ articles, category, onCategoryChange, hasMore, onMore, loading, pending }: { articles: PublicData['articles']; category: NewsCategory; onCategoryChange: (category: NewsCategory) => void; hasMore:boolean; onMore:()=>void; loading:boolean; pending?: React.ReactNode }) {
  return <><div className="pub-filter" role="group" aria-label="新闻分类">{([['all', '全部'], ['reset', '重置'], ['activity', '活动'], ['product', '产品']] as const).map(([value, label]) => <button key={value} aria-pressed={category === value} className={category === value ? 'active' : ''} onClick={() => { onCategoryChange(value); }}>{label}</button>)}</div>{pending ?? (articles.length ? articles.map(article => <article className="pub-card pub-announcement pub-news-item" key={article.id} data-reading-id={article.id}><div className="pub-card-top"><Badge tone={article.status === 'withdrawn' ? '' : 'cyan'}>{article.historical && article.status !== 'withdrawn' ? '历史收录 · ' : ''}{article.status === 'withdrawn' ? '已撤回' : article.publicationMode === 'news_only' ? '来源消息' : { reset: '重置公告', activity: '活动动态', product: '产品更新' }[article.category]}</Badge><time dateTime={articleSourceTime(article)} title={`${displayTime(articleSourceTime(article))} · 北京时间`}>{briefTime(articleSourceTime(article))}</time></div><h3><Link scroll={false} href={`/articles/${encodeURIComponent(article.id)}`}>{article.title}</Link></h3><p>{publicArticleSummary(article)}</p><TextLink href={`/articles/${encodeURIComponent(article.id)}`}>查看全文与来源</TextLink></article>) : <Empty title="暂无相关内容" detail="核验后的中文新闻将在这里发布。" />)}{hasMore && <button className="pub-button full" disabled={loading} onClick={onMore}>{loading ? '正在加载…' : '加载更多'}</button>}<TextLink href="/history">按事件查看重置公告</TextLink></>;
}
function PublicationNote({ publication }: { publication: Publication }) {
  return isNewsOnly(publication) ? <p className="pub-muted">{publication.article.category === 'reset' ? '此条仅作消息记录，不代表已确认发放。' : '完整更新内容请以原文为准。'}</p> : null;
}
function Notices({publications,notices,read,markRead,storageError,selectedId}:{publications:Publication[];notices:Notice[];read:string[];markRead:(ids:string[])=>void;storageError:string;selectedId?:string|null}) {
  const unread=notices.filter(n=>!read.includes(n.id)).length,selected=selectedId?notices.find(n=>n.id===selectedId):null;
  if(selectedId)return selected?<article className="pub-card"><h2>{selected.title}</h2><p className="pub-muted">{displayTime(selected.createdAt)}</p><p className="pub-prose">{selected.body||selected.summary}</p><TextLink href="/notices">查看全部提醒</TextLink></article>:<Empty title="消息暂不可用" detail="这条消息已撤回或暂时无法读取。"/>;
  return <>{storageError&&<p className="pub-warning">{storageError}</p>}<div className="pub-section-heading"><span>{unread} 条未读</span><button className="pub-text-button" disabled={!unread} onClick={()=>markRead(notices.map(n=>n.id))}>全部标为已读</button></div>
    {notices.length?notices.map(n=><article key={n.id} className={`pub-card pub-notice${read.includes(n.id)?' is-read':''}`}><div className="pub-card-top"><Badge tone={read.includes(n.id)?'muted':''}>{read.includes(n.id)?'已读':'未读'}</Badge><time>{displayTime(n.createdAt)}</time></div><h2>{n.title}</h2><p>{n.summary}</p>{n.origin==='admin'?<Link scroll={false} className="pub-text-link" href={`/notices?message=${encodeURIComponent(n.id)}`} onClick={()=>markRead([n.id])}>查看详情<Icon name="arrow"/></Link>:publications.some(p=>p.id===n.publicationId)?<Link scroll={false} className="pub-text-link" href={`/events/${encodeURIComponent(n.eventId)}?version=${encodeURIComponent(n.publicationId)}`} onClick={()=>markRead([n.id])}>查看关联公告<Icon name="arrow"/></Link>:<p className="pub-muted">关联记录暂不可用</p>}</article>):<Empty title="暂无提醒" detail="有新消息会显示在这里。"/>}
  </>;
}
function ActionCard({ action, now }: { action: BenefitAction; now: string }) {
  return <section className="pub-action-card">
    <div className="pub-card-top"><h3>{actionLabels[action.kind]}</h3><Badge tone={action.stage === 'claimed_complete' ? 'cyan' : action.stage === 'cancelled' ? '' : 'amber'}>{stageText(action, now)}</Badge></div>
    <dl className="pub-facts">
      <div><dt>声明时间</dt><dd><time dateTime={action.statementAt}>{displayTime(action.statementAt)}</time></dd></div>
      {action.expectedAt && <div><dt>预计时间</dt><dd><time dateTime={action.expectedAt}>{displayTime(action.expectedAt)}</time></dd></div>}
      <div><dt>适用范围</dt><dd>{action.eligibility}</dd></div>
      <div><dt>发放类型</dt><dd>{{ public: '公开发放', targeted: '定向补偿', private: '个人记录' }[action.scope]}</dd></div>
    </dl>
    {action.timeNote && <p className="pub-warning">{action.timeNote}</p>}
    {action.scope !== 'public' && <p className="pub-muted">不计入公开发放次数。</p>}
  </section>;
}
function useVersion() {
  return useSearchParams().get('version');
}
export function EventPage({ data, id, onPoster, onShare }: { data: PublicData; id: string; onPoster: (p: Publication) => void; onShare: (p: Publication) => Promise<void> }) {
  const version = useVersion();
  const current = data.events.find(event => event.id === id);
  const publication = version ? data.publications.find(p => p.id === version && p.eventId === id) : current && currentPublication(data, current);
  if (!version && current?.status === 'merged' && current.mergedInto) return <><Empty title="这条记录已合并" detail="后续进展已统一到同一个事件，原始证据和版本仍被保留。" /><TextLink href={`/events/${encodeURIComponent(current.mergedInto)}`}>查看合并后的事件</TextLink></>;
  if (!publication) return <Empty title="未找到这条公开记录" detail="记录可能尚未发布，或指定版本不可用。" />;
  const historicalVersion = !!current && (current.publicationId !== publication.id || current.status === 'merged');
  const withdrawn = publicationWithdrawn(data, publication);
  const currentArticle = data.articles.find(article => article.id === publication.articleId);
  const currentReason = publication.event.status === 'withdrawn' || publication.article.status === 'withdrawn' ? publication.reason : currentArticle?.status === 'withdrawn' ? data.publications.find(p => p.id === currentArticle.publicationId)?.reason : current ? currentPublication(data, current)?.reason : publication.reason;
  const translation = publication.article.translation?.trim();
  const hasAdditionalContent = !!translation && translation !== publication.article.summary.trim();
  const actions = isNewsOnly(publication) ? [] : publication.event.actions;
  const evidenceIds = new Set([...(isNewsOnly(publication) ? publication.article.evidenceIds : publication.event.evidenceIds), ...actions.flatMap(action => action.evidenceIds)]);
  return <>
    {historicalVersion && <div className="pub-warning">正在查看历史发布版本。<TextLink href={`/events/${encodeURIComponent(id)}`}>查看当前版本</TextLink></div>}
    {withdrawn && <div className="pub-warning">此内容已撤回，不再作为当前发放依据。{currentReason}</div>}
    <div className="pub-page-heading"><p className="pub-eyebrow">{publication.article.historical ? '历史收录 · ' : ''}{publication.article.category === 'activity' ? '活动动态' : publication.article.category === 'product' ? '产品更新' : '重置动态'}</p><h1>{publication.article.title}</h1><p>{actions.length ? '公开声明 · 所有时间均为北京时间' : `${displayTime(articleSourceTime(publication.article))} · 北京时间`}</p></div>
    {actions.length ? <>
      {actions.map(action => <ActionCard action={action} now={historicalVersion ? publication.cutoffAt : data.serverTime} key={action.id} />)}
      <p className="pub-event-boundary"><Icon name="info"/>完成状态依据公开声明，个人账户是否到账尚未观测。</p>
    </> : <section className="pub-card pub-summary"><h2>消息摘要</h2><p>{publicArticleSummary(publication.article)}</p><PublicationNote publication={publication} /></section>}
    <EvidenceList collapsed evidence={data.evidence.filter(e => evidenceIds.has(e.id))} actions={actions} sources={data.sources} />
    {actions.length > 0 ? <details className="pub-card pub-disclosure"><summary>公告补充</summary><p className="pub-prose">{publicArticleSummary(publication.article)}</p>{hasAdditionalContent && <><h3>完整内容</h3><p className="pub-prose">{translation}</p></>}</details> : hasAdditionalContent && <details className="pub-card pub-disclosure"><summary>完整内容</summary><p className="pub-prose">{translation}</p></details>}
    <details className="pub-card pub-disclosure"><summary>记录信息</summary><dl className="pub-facts"><div><dt>发布版本</dt><dd>第{isNewsOnly(publication) ? publication.article.version : publication.event.version}版</dd></div><div><dt>资料截止</dt><dd>{displayTime(publication.cutoffAt)}</dd></div><div><dt>本站发布</dt><dd>{displayTime(publication.publishedAt)}</dd></div><div><dt>版本说明</dt><dd>{publication.reason || '公开资料核验发布'}</dd></div></dl></details>
    <div className="pub-share-row"><button className="pub-button" onClick={() => void onShare(publication)}>分享此版本<Icon name="link" /></button><button className="pub-button" disabled={withdrawn} onClick={() => onPoster(publication)}>生成海报<Icon name="share" /></button></div><TextLink href="/history">查看全部公告</TextLink>
  </>;
}
function ArticlePage({ data, id, onPoster }: { data: PublicData; id: string; onPoster: (p: Publication) => void }) {
  const article = data.articles.find(a => a.id === id);
  const publication = article && data.publications.find(p => p.id === article.publicationId);
  if (!article || !publication) return <Empty title="未找到这篇新闻" detail="该内容可能尚未发布。" />;
  return <>{article.status === 'withdrawn' && <p className="pub-warning">这篇新闻已撤回，不能作为当前发放依据。</p>}<div className="pub-page-heading"><h1>{publication.article.title}</h1><p>{publication.article.historical ? '历史收录 · ' : ''}{displayTime(articleSourceTime(publication.article))}</p></div><section className="pub-card pub-summary"><h2>中文摘要</h2><p>{publicArticleSummary(publication.article)}</p><PublicationNote publication={publication} /></section>{publication.article.translation?.trim() && publication.article.translation.trim() !== publication.article.summary.trim() && <details className="pub-card pub-disclosure"><summary>完整内容</summary><p className="pub-prose">{publication.article.translation}</p></details>}<EvidenceList collapsed evidence={data.evidence.filter(e => publication.article.evidenceIds.includes(e.id))} sources={data.sources} /><div className="pub-share-row"><Link scroll={false} className="pub-button" href={`/events/${encodeURIComponent(article.eventId)}`}>查看事件进展<Icon name="arrow" /></Link><button className="pub-button" disabled={article.status === 'withdrawn' || data!.events.find(event => event.id === article.eventId)?.status === 'withdrawn'} onClick={() => onPoster(publication)}>生成海报<Icon name="share" /></button></div><details className="pub-card pub-disclosure"><summary>记录信息</summary><dl className="pub-facts"><div><dt>发布版本</dt><dd>第{publication.article.version}版</dd></div><div><dt>资料截止</dt><dd>{displayTime(publication.cutoffAt)}</dd></div><div><dt>本站发布</dt><dd>{displayTime(publication.publishedAt)}</dd></div></dl></details></>;
}
function EvidenceList({ evidence, collapsed = false, actions = [], sources = [] }: { evidence: Evidence[]; collapsed?: boolean; actions?: BenefitAction[]; sources?: PublicData['sources'] }) {
  const priority = (item: Evidence) => actions.some(action => action.stage === 'claimed_complete' && action.evidenceIds.includes(item.id) && Date.parse(action.statementAt) === Date.parse(item.publishedAt)) ? 1 : 0;
  const rows = evidence.slice().sort((a, b) => priority(b) - priority(a) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const grouped = new Map<string, Evidence[]>();
  for (const item of rows) {
    const key = `${item.publishedAt}:${item.text.replace(/\s+/g, ' ').trim()}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  const row = (item: Evidence, excerpt: boolean) => <Link scroll={false} className="pub-source-row" key={item.id} href={`/sources/${encodeURIComponent(item.id)}`}><div><strong>{(sources.find(source => source.id === item.sourceId)?.name || '原文记录').replace('（辅助来源）', '').replace('（免费）', '')}</strong><span>{briefTime(item.publishedAt)} · 北京时间 · {item.provenance === 'official' ? '官方资料' : item.provenance === 'archive' ? '辅助归档' : '人工补充'}{item.historical ? ' · 历史收录' : ''}</span>{excerpt && <p className="pub-source-excerpt" dir="auto">{item.text}</p>}{excerpt && item.metadata?.title && <span className="pub-source-description">{item.provenance === 'archive' ? '归档标题' : '附加标题'}：{item.metadata.title}</span>}</div><Icon name="arrow" /></Link>;
  const contents = rows.length ? [...grouped.values()].map(items => <div className="pub-source-group" key={items[0].id}>{row(items[0], true)}{items.length > 1 && <details className="pub-source-copies"><summary>相同内容的另外{items.length - 1}份来源记录</summary>{items.slice(1).map(item => row(item, false))}</details>}</div>) : <p className="pub-muted">暂未提供可展示的原文。</p>;

  return collapsed ? <details className="pub-card pub-disclosure"><summary>原文依据（{evidence.length}条）</summary>{contents}</details> : <section className="pub-card"><h2>原文依据</h2>{contents}</section>;
}

function EvidencePage({ data, id }: { data: PublicData; id: string }) {
  const evidence = data.evidence.find(e => e.id === id);
  if (!evidence) return <Empty title="未找到这条来源" detail="只展示与公开发布内容关联的原文资料。" />;
  const parent = evidence.parentId ? data.evidence.find(e => e.id === evidence.parentId || e.messageId === evidence.parentId) : undefined;
  const articles = data.articles.filter(a => a.evidenceIds.includes(id));
  return <><div className="pub-page-heading"><h1>原文与来源</h1><p>{displayTime(evidence.publishedAt)}</p></div><section className="pub-card"><div className="pub-card-top"><h2>来源说明</h2><Badge tone={evidence.provenance === 'official' ? 'cyan' : ''}>{evidence.provenance === 'official' ? '官方资料' : evidence.provenance === 'archive' ? '公开归档' : '人工补充'}</Badge></div><p>{evidence.provenance === 'archive' ? '内容由公开归档收录，属于辅助来源，不代表本站已直接获取官方原帖。' : evidence.provenance === 'manual' ? '由站长补充的来源资料，可通过原始链接核对。' : '从官方公开渠道采集的资料，具体资格和表述以原文为准。'}</p>{evidence.historical && <p className="pub-muted">此条为历史导入资料。</p>}<ExternalLink url={evidence.url}>打开原始链接</ExternalLink></section>{!evidence.contextComplete && <p className="pub-warning">上下文尚不完整，请结合相关事件的核验说明阅读。</p>}<section className="pub-card"><h2>{evidence.textOrigin === 'archive_excerpt' ? '归档收录正文' : evidence.textOrigin === 'structured' ? '来源结构化内容' : '原始内容'}</h2>{(evidence.metadata?.title || evidence.metadata?.summary) && <div className="pub-muted"><strong>{evidence.provenance === 'archive' ? '辅助归档描述' : '来源附加信息'}</strong>{evidence.metadata.title && <p>{evidence.metadata.title}</p>}{evidence.metadata.summary && <p>{evidence.metadata.summary}</p>}<p>标题与摘要不是原帖正文，不作为原文引用。</p></div>}<blockquote className="pub-original" dir="auto">{evidence.text}</blockquote><dl className="pub-facts"><div><dt>原文发布</dt><dd>{displayTime(evidence.publishedAt)}</dd></div><div><dt>本站采集</dt><dd>{displayTime(evidence.collectedAt)}</dd></div></dl></section>{parent && <section className="pub-card"><h2>上文</h2><p className="pub-prose">{parent.text}</p><TextLink href={`/sources/${encodeURIComponent(parent.id)}`}>查看上文来源</TextLink></section>}{articles.length > 0 && <section className="pub-card"><h2>对应中文内容</h2>{articles.map(article => <TextLink key={article.id} href={`/articles/${encodeURIComponent(article.id)}`}>{article.title}</TextLink>)}</section>}</>;
}
function ActivityPage({ data, activity, id, query, onDay: setDay, pending, onPoster, onDayPoster }: { data: PublicData | null; activity?: Activity; id: string; query: URLSearchParams; onDay: (value: number | null) => void; pending?: React.ReactNode; onPoster: (p: Publication) => void; onDayPoster: (selection: ActivityDayShare) => void }) {
  const requestedDay = query.get('day');
  const day = requestedDay && /^[1-9]\d{0,2}$/.test(requestedDay) ? Number(requestedDay) : null;
  if (!activity && pending) return pending;
  if (!activity) return <Empty title="暂无这项活动" detail="活动规则和进展发布后，会统一收录在这里。" />;
  if (query.getAll('publication').length) {
    if (!data) return pending;
    let selection: ActivityDayShare;
    try { selection = parseActivityShare(id, new URLSearchParams(query.toString())); }
    catch (cause) { return <><Empty title="分享版本参数无效" detail={cause instanceof Error ? cause.message : '无法读取所选版本。'} /><TextLink href={`/activities/${encodeURIComponent(id)}`}>查看当前每日进展</TextLink></>; }
    const fixed = resolveActivityShare(data, selection);
    if (!fixed.available) return <><Empty title="这组分享版本暂不可用" detail={fixed.blockedReason} /><TextLink href={`/activities/${encodeURIComponent(id)}`}>查看当前每日进展</TextLink></>;
    return <><div className="pub-page-heading"><p className="pub-eyebrow">指定发布版本 · 第{fixed.manifest.day}天</p><h1>{fixed.activity.title}</h1><p>{fixed.date} · {fixed.items.length}条进展</p></div><p className="pub-warning">{fixed.rulesNotice}下方保持分享时选择的条目；没有自动替换为最新版本。</p><div className="pub-share-row"><button className="pub-button" onClick={() => onDayPoster(fixed.manifest)}>生成整日海报<Icon name="share" /></button><Link scroll={false} className="pub-button" href={`/activities/${encodeURIComponent(id)}?day=${fixed.manifest.day}`}>查看当前进展<Icon name="arrow" /></Link></div>{fixed.items.map(({ publication, sourceTime }) => <article className="pub-card" key={publication.id} data-reading-id={publication.id}><div className="pub-card-top"><Badge tone="purple">固定发布版本</Badge><time>{briefTime(sourceTime)}</time></div><h2>{publication.article.title}</h2><p>{publicArticleSummary(publication.article)}</p><details><summary>查看完整内容</summary><p className="pub-prose">{publication.article.translation || publication.article.summary}</p></details><p className="pub-muted">此条资料截至 {displayTime(publication.cutoffAt)}</p><TextLink href={`/events/${encodeURIComponent(publication.eventId)}?version=${encodeURIComponent(publication.id)}`}>查看此版本与来源</TextLink></article>)}<p className="pub-muted">各条目保留独立资料截止时间。</p></>;
  }
  if (day !== null && (day < 1 || day > activity.days)) return <><Empty title="活动日期超出范围" detail="请选择这项活动内的日期。" /><button className="pub-button" onClick={() => setDay(null)}>查看当前日期</button></>;
  return <ActivityContent activity={activity} data={data} pending={pending} day={day} onDay={setDay} onPoster={onPoster} onDayPoster={onDayPoster} />;
}
function ActivityContent({ activity, data, pending, day, onDay, onPoster, onDayPoster }: { activity: Activity; data: PublicData | null; pending?: React.ReactNode; day: number | null; onDay: (n: number) => void; onPoster: (p: Publication) => void; onDayPoster: (selection: ActivityDayShare) => void }) {
  const [shareError, setShareError] = useState('');
  const now = usePublicClock(data?.serverTime ?? '');
  const actualDay = activityDayNumber(activity, now) ?? 1;
  const selected = day ?? Math.max(1, Math.min(activity.days, actualDay));
  const entries = activity.items.filter(item => item.day === selected).map(item => data?.articles.find(a => a.id === item.articleId)).filter(a => !!a);
  const publishedDays = new Set(activity.items.map(item => item.day));
  const timezoneName = activity.timezone === 'Asia/Shanghai' ? '北京时间' : activity.timezone === 'America/Los_Angeles' ? '美国西部时间' : '活动指定时区';
  const selectedDate = new Date(Date.parse(`${activity.startsOn}T00:00:00Z`) + (selected - 1) * 86400000).toISOString().slice(0, 10);
  const latestDay = [...publishedDays].filter(n => n <= actualDay).sort((a, b) => b - a)[0];
  return <div className="pub-activity-content">
    <div className="pub-page-heading"><div className="pub-activity-heading"><h1>{activity.title}</h1><span className="pub-activity-phase">{actualDay < 1 ? '尚未开始' : actualDay > activity.days ? '活动已结束' : `第${actualDay}天 / 共${activity.days}天`}</span></div><p>{activity.rules}</p></div>
    <section className="pub-card pub-activity-calendar"><div className="pub-card-top"><h2>每日进展</h2><Badge tone="purple">已收录{publishedDays.size}天</Badge></div>
      <div className="pub-activity-days" role="group" aria-label="选择活动日期">{Array.from({ length: activity.days }, (_, index) => index + 1).map(n => <button key={n} className={`${selected === n ? 'active' : ''} ${publishedDays.has(n) ? 'has-entry' : ''} ${n === actualDay ? 'is-today' : ''} ${n > actualDay ? 'is-future' : ''}`} aria-label={`第${n}天${publishedDays.has(n) ? '，有已收录进展' : n > actualDay ? '，尚未到来' : '，暂无记录'}`} title={n === actualDay ? '今天' : n > actualDay ? '未来日期' : publishedDays.has(n) ? '已有进展' : '待收录'} aria-pressed={selected === n} onClick={() => onDay(n)}>{n}{publishedDays.has(n) && <i />}</button>)}</div>
      <div className="pub-activity-legend"><span className="today">今天</span><span className="recorded">已收录</span><span>待收录</span><span className="future">未来</span></div>
      <p className="pub-muted">活动日期按{timezoneName}划分，记录时间显示为北京时间。</p>
    </section>
    <div className="pub-section-heading pub-activity-day-heading"><div><h2>第{selected}天</h2><p>{selectedDate} · {timezoneName}</p></div><span className="pub-muted">{entries.length}条进展</span></div>
    {pending ?? <>{!entries.length && <div className="pub-empty pub-activity-empty"><Icon name="calendar" /><h2>{selected > actualDay ? '这一天尚未开始' : '暂无已收录进展'}</h2><p>{selected > actualDay ? '有公开进展后，会在对应日期更新。' : '尚未收录这一天的公开进展，不代表活动没有发生。'}</p>{latestDay && latestDay !== selected && <button className="pub-button" onClick={() => onDay(latestDay)}>查看最近有进展的第{latestDay}天<Icon name="arrow" /></button>}</div>}
    <button className="pub-button full pub-day-poster" disabled={!entries.length} onClick={() => { try { const selection = buildActivityShare(data!, activity.id, selected); activityPublicationUrl(location.origin, selection); setShareError(''); onDayPoster(selection); } catch (cause) { setShareError(cause instanceof Error ? cause.message : '这一天暂时不能生成整合海报。'); } }}>生成整日海报<Icon name="share" /></button>
    {shareError && <p className="pub-warning" role="alert">{shareError}</p>}
    {entries.map(article => { const publication = data!.publications.find(p => p.id === article.publicationId); return <article className="pub-card" key={article.id} data-reading-id={article.id}><div className="pub-card-top"><Badge tone="purple">{article.historical ? '历史收录 · ' : ''}活动动态</Badge><time dateTime={articleSourceTime(article)} title={`${displayTime(articleSourceTime(article))} · 北京时间`}>{briefTime(articleSourceTime(article))}</time></div><h2>{article.title}</h2><p>{publicArticleSummary(article)}</p><details><summary>查看完整内容</summary><p className="pub-prose">{article.translation || article.summary}</p></details><div className="pub-card-top"><TextLink href={`/articles/${encodeURIComponent(article.id)}`}>查看详情与来源</TextLink>{publication && <button className="pub-text-button" disabled={article.status === 'withdrawn' || data!.events.find(event => event.id === article.eventId)?.status === 'withdrawn'} onClick={() => onPoster(publication)}>分享海报<Icon name="share" /></button>}</div></article>; })}
    </>}
  </div>;

}
export function Settings({notices,read,markRead,storageError,pending,data,codeAvailable=false}:{notices:Notice[];read:string[];markRead:(ids:string[])=>void;storageError:string;pending?:React.ReactNode;data?:PublicData|null;codeAvailable?:boolean}) {
  const unread=notices.filter(n=>!read.includes(n.id)).length;
  return <>
    <section className="pub-card pub-inbox-card"><div className="pub-section-heading"><h2>站内信 {unread>0&&<span className="pub-inbox-unread">{unread} 未读</span>}</h2><TextLink href="/notices">查看全部提醒</TextLink></div>
      {pending ?? <>{notices.slice(0,3).map(n=><Link scroll={false} key={n.id} className="pub-inbox-preview" href={n.origin==='admin'?`/notices?message=${encodeURIComponent(n.id)}`:`/events/${encodeURIComponent(n.eventId)}?version=${encodeURIComponent(n.publicationId)}`} onClick={()=>markRead([n.id])}><div><strong>{n.title}</strong>{!read.includes(n.id)&&<span className="pub-status-dot"/>}</div><p>{n.summary}</p><small>{displayTime(n.createdAt)}</small></Link>)}
      {!notices.length&&<p className="pub-inbox-empty">暂无提醒，有新消息会显示在这里。</p>}</>}
    </section>
    {storageError&&<p className="pub-warning">{storageError}</p>}
    <section className="pub-card pub-reminder-pending"><div className="pub-section-heading"><h2>微信提醒</h2><Badge tone="muted">小程序内开启</Badge></div><p>请在小程序的提醒页开启微信提醒，每次成功授权增加一次提醒机会。</p><p className="pub-muted">重置预告、完成声明和重要更正各使用一次，次数用完后可继续增加，也可以随时关闭。</p><WechatEntryGuide publicationId={data?.publications.find(p=>!publicationWithdrawn(data,p))?.id} codeAvailable={codeAvailable}/></section>
    <section className="pub-card"><TextLink href="/more#privacy">隐私说明</TextLink></section>
  </>;
}
function MorePage() {
  return <><section className="pub-card"><h2>内容与记录</h2><div className="pub-link-row"><TextLink href="/history">查看重置公告</TextLink></div><div className="pub-link-row"><TextLink href="/news">查看动态</TextLink></div><div className="pub-link-row"><TextLink href="/notices">查看全部提醒</TextLink></div><div className="pub-link-row"><TextLink href="/methodology">历史预测回放与观察记录</TextLink></div></section>
    <section className="pub-card" id="privacy"><h2>隐私说明</h2><p>查看公开消息无需提供手机号、通讯录或位置。已读状态保存在当前设备，清除浏览器数据后可能重置。</p><p>微信提醒使用微信提供的用户标识管理接收状态，可以在小程序提醒页关闭。保存海报由你主动操作，我们不读取或上传你的相册。</p><p>小程序内可查看平台提供的完整隐私指引。</p></section></>;
}
export function Methodology({data,snapshotId,cadenceId,onPoster,onShare}:{data:PublicData;snapshotId:string|null;cadenceId:string|null;onPoster:(s:ForecastSnapshot)=>void;onShare:(s:ForecastSnapshot)=>Promise<void>}) {
  if(cadenceId)return <><div className="pub-page-heading"><h1>历史间隔实验记录</h1></div><ForecastPanel data={data.forecasts} snapshotId={null} cadenceId={cadenceId} onPoster={onPoster} onShare={onShare}/></>;
  if(snapshotId)return <><div className="pub-page-heading"><h1>固定预测记录</h1><p>初始预测与后续结局分别保留。</p></div><ForecastPanel data={data.forecasts} snapshotId={snapshotId} onPoster={onPoster} onShare={onShare}/></>;
  return <><div className="pub-page-heading"><h1>观察记录</h1></div><HistoricalReplayPanel/><ForecastPanel data={data.forecasts} snapshotId={snapshotId} onPoster={onPoster} onShare={onShare}/></>;
}
function WechatReminderModal({onClose,data,codeAvailable}:{data:PublicData|null;dataError:string;onRetryData:()=>void;entry:WechatEntryState;codeAvailable:boolean;onRetryEntry:()=>void;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{dialog.current?.showModal();const previous=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.body.style.overflow=previous;};},[]);
  return <dialog className="pub-dialog" ref={dialog} onClose={onClose} onCancel={onClose}><div className="pub-dialog-heading"><h2>微信提醒</h2><button className="pub-icon-button" aria-label="关闭窗口" onClick={onClose}><Icon name="close"/></button></div><div className="pub-dialog-body"><p>在小程序的提醒页开启，每次成功授权增加一次提醒机会。</p><p>重置预告、完成声明和重要更正各使用一次。可以继续增加次数，也可以关闭提醒。</p><WechatEntryGuide publicationId={data?.publications.find(p=>!publicationWithdrawn(data,p))?.id} codeAvailable={codeAvailable}/><TextLink href="/notices">查看全部站内提醒</TextLink><button className="pub-button full" onClick={onClose}>知道了</button></div></dialog>;
}
function ShareLinkModal({ url, onClose }: { url: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('复制链接后发送给朋友。');
  useEffect(() => { dialog.current?.showModal(); const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = previous; }; }, []);
  const copy = async () => { try { await navigator.clipboard.writeText(url); setMessage('链接已复制'); } catch { input.current?.select(); setMessage('请长按或选中链接复制。'); } };
  return <dialog className="pub-dialog" ref={dialog} onClose={onClose} onCancel={onClose} aria-labelledby="pub-share-title"><div className="pub-dialog-heading"><h2 id="pub-share-title">转发给朋友</h2><button className="pub-icon-button" aria-label="关闭分享" onClick={onClose}><Icon name="close" /></button></div><div className="pub-dialog-body"><label className="pub-share-link-label" htmlFor="pub-share-url">此版本链接</label><input className="pub-share-link-input" id="pub-share-url" ref={input} value={url} readOnly onClick={event => event.currentTarget.select()} /><button className="pub-button primary full" onClick={() => void copy()}>复制链接</button><p className="pub-dialog-note" role="status">{message}</p>{isLocalShareUrl(url) && <p className="pub-dialog-note">当前为本机链接，其他设备需通过正式网站地址访问。</p>}</div></dialog>;
}
interface PosterTarget { id: string; cutoffAt: string; title: string; endpoint: string; filename: string; }
function PosterModal({ target, name, blocked, note, statusDesign = false, codeAvailable = false, onClose, onShare }: { target: PosterTarget; name: string; blocked: string; note?: string; statusDesign?: boolean; codeAvailable?: boolean; onClose: () => void; onShare: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cache = useRef(new Map<string, PosterImage>());
  const [result, setResult] = useState<{ image: PosterImage; key: string } | null>(null);
  const [style, setStyle] = useState<StatusPosterStyle>('precision');
  const [includeCode, setIncludeCode] = useState(false);
  const [generating, setGenerating] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const variant = statusDesign ? statusPosterVariant(target.endpoint, target.filename, style, includeCode && codeAvailable) : target;
  const requestKey = `${variant.endpoint}:${target.cutoffAt}:${variant.filename}`;
  const image = cache.current.get(requestKey) ?? (result?.key === requestKey ? result.image : null);
  const preview = image ?? result?.image;
  const selectedStyle = statusPosterStyles.find(option => option.id === style)!;
  useEffect(() => { dialog.current?.showModal(); const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = previous; }; }, []);
  useEffect(() => () => {
    for (const image of cache.current.values()) URL.revokeObjectURL(image.url);
    cache.current.clear();
  }, [target.id, target.cutoffAt]);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    if (blocked) {
      for (const image of cache.current.values()) URL.revokeObjectURL(image.url);
      cache.current.clear();setResult(null);setGenerating(false);return;
    }
    const cached = cache.current.get(requestKey);
    if (cached) { setResult({image:cached,key:requestKey});setGenerating(false);return; }
    setGenerating(true);
    const timer = window.setTimeout(() => { controller.abort(); setGenerating(false); setError('海报生成超时，请重新生成。'); }, 20_000);
    void createPosterFromEndpoint(variant.endpoint, variant.filename, controller.signal)
      .then(image => {
        window.clearTimeout(timer);
        if (controller.signal.aborted) URL.revokeObjectURL(image.url);
        else { cache.current.set(requestKey,image);setResult({image,key:requestKey});setGenerating(false); }
      })
      .catch(cause => { window.clearTimeout(timer);if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : '海报生成失败，请重试。');setGenerating(false); } });
    return () => { window.clearTimeout(timer);controller.abort(); };
  }, [target.id, target.cutoffAt, variant.endpoint, variant.filename, requestKey, blocked, attempt]);
  const file = image ? new File([image.blob], image.filename, { type: 'image/png' }) : null;
  const canShareImage = !!file && !!navigator.canShare?.({ files: [file] });
  const shareImage = async () => {
    if (!file || !canShareImage || blocked) return;
    setSharing(true); setError('');
    try {
      await navigator.share({ title: name, files: [file] });
    } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError('暂时无法转发图片，请保存海报后发送。'); }
    finally { setSharing(false); }
  };
  const local = typeof location !== 'undefined' && isLocalShareUrl(location.origin);
  return <dialog className={`pub-dialog${statusDesign ? ' pub-poster-dialog' : ''}`} ref={dialog} onClose={onClose} onCancel={onClose} aria-labelledby="pub-poster-title">
    <div className="pub-dialog-heading"><h2 id="pub-poster-title">分享海报</h2><button className="pub-icon-button" aria-label="关闭海报" onClick={onClose}><Icon name="close" /></button></div>
    <div className="pub-dialog-body">
      {statusDesign && <div className="pub-poster-options">
        <div className="pub-poster-styles" role="group" aria-label="海报风格">{statusPosterStyles.map(option => <button key={option.id} type="button" className={`pub-poster-style${style === option.id ? ' is-selected' : ''}`} aria-pressed={style === option.id} disabled={sharing || !!blocked} onClick={() => { if (style !== option.id) { setGenerating(true); setError(''); setStyle(option.id); } }}><span className={`pub-poster-swatch ${option.id}`} aria-hidden="true" /><span>{option.label}</span>{style === option.id && <Icon name="check" />}</button>)}</div>
        <label className="pub-poster-code-option"><input type="checkbox" checked={includeCode && codeAvailable} disabled={!codeAvailable || sharing || !!blocked} onChange={event => { setGenerating(true); setError(''); setIncludeCode(event.target.checked); }} /><span>带圆形小程序码</span>{!codeAvailable && <small>待接入 · 可保存无圆码版</small>}</label>
      </div>}
      <div className="pub-poster-preview" aria-busy={generating}>
        {blocked ? <p className="pub-warning" role="alert">{blocked}</p> : <>
          {preview && <img className="pub-poster-image" src={preview.url} alt={`${name}分享海报：${target.title}`} />}
          {generating && <div className="pub-poster-loading" role="status"><Icon name="radar" /><p>正在生成{statusDesign ? selectedStyle.label : ''}海报…</p></div>}
        </>}
        {error && <div className="pub-warning" role="alert"><p>{error}</p>{!image && !blocked && <button className="pub-text-button" onClick={() => setAttempt(value => value + 1)}>重新生成</button>}</div>}
      </div>
      <div className="pub-share-row"><button className="pub-button" disabled={sharing || generating || !image || !!blocked} onClick={() => void (canShareImage ? shareImage() : onShare())}>{sharing ? '正在打开分享…' : canShareImage ? '转发海报' : '分享此版本链接'}<Icon name="share" /></button><button className="pub-button primary" disabled={generating || !image || !!blocked} onClick={() => image && savePosterImage(image)}>保存海报</button></div>
      <p className="pub-dialog-note" role="status">{statusDesign ? image?.codeState === 'unavailable' ? '圆码暂时获取失败，本次生成不带码的海报。' : '海报记录生成时的公开状态，所有时间均为北京时间。' : note || (image ? '长按图片可保存，海报与扫码链接固定对应此版本。' : '海报固定使用这一发布版本。')}{!statusDesign && local && '当前为本机预览，手机扫码需正式网站地址。'}</p>
    </div>
  </dialog>;
}
