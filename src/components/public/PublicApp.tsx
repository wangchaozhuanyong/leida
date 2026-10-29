'use client';
import {resetObservations,observedEvidence} from '@/lib/reset-observations';

import Link from 'next/link';
import { useSearchParams, usePathname } from 'next/navigation';
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {WechatEntryGuide} from './WechatEntryGuide';
import {LoadingContent} from './LoadingContent';
import {useContentEntrance} from './useContentEntrance';
import {openPublicDialog} from './dialog-lifecycle';
import {sourceStatus, uniqueDisplayEvidence} from './model';
import { publicNewsGroups, homeNewsGroups, type NewsGroup } from '@/lib/public-feed';
import { publicReviewMessage, publicSourceNotes, publicEligibility, publicNoticeSummary } from '@/lib/public-content';
import { customerNotice, compareNotices } from '@/lib/notice-display';
import type { Activity, Article, BenefitAction, Evidence, Notice, PublicData, Publication } from '@/lib/types';
import { usePublicClock, usePublicQuery, useWechatAvailability } from './PublicSession';
import { RecordCalendar, RecordKindFilter } from './RecordCalendar';
import { parsePublicRoute } from './public-navigation';
import { usePublicNavigation } from './usePublicNavigation';
import { useFixedSnapshot } from './useFixedSnapshot';
import type {ForecastSnapshot} from '@/lib/forecast';
import {ForecastPanel} from './ForecastPanel';
import {statusPosterSnapshot} from '@/lib/status-timeline';
import {ResetStateCards,ResetStatePending,LastResetElapsed} from './ResetStateCards';
import { actionLabels } from '@/lib/labels';
import { activityDayNumber, activityHomeVisible } from '@/lib/activity-display';
import { publicationUrl, isLocalShareUrl } from '@/lib/share';
import { createPosterFromEndpoint, savePosterImage, type PosterImage } from './poster-image';
import { statusPosterStyles, statusPosterVariant, type StatusPosterStyle } from '@/lib/status-poster-style';
import { activityPublicationUrl, activityShareQuery, buildActivityShare, parseActivityShare, resolveActivityShare, type ActivityDayShare } from '@/lib/activity-share';
import { briefTime, articleSourceTime, publicationSourceTime, publicationWithdrawn, sortedArticles, sortedStatePublications, currentPublication, dateKey, displayTime, elapsed, publicActions, safeUrl, statePublication, isNewsOnly, stageText } from './model';
import { latestSourceSuccess, publicArticleSummary, publicArticleContent, publicNavSection, latestCompletedBenefits, recentCompletedBenefits, completionTime } from './model';

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
function PageSymbol({route}:{route:string}) {
  const icon:Record<string,string>={news:'news',history:'history',settings:'reminder',more:'more',notices:'inbox',activities:'activity',methodology:'methodology'};
  return <img className="pub-page-symbol" src={`/icons/${icon[route]||'document'}.svg`} alt="" width="34" height="34"/>;
}
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
  return <LoadingContent />;
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
  const contentMotion=useContentEntrance(readPath||pathname,queryReady&&(!!data||!readPath));
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
    try { await navigator.clipboard.writeText(url); if (stillHere()) setToast('消息链接已复制'); }
    catch { if (stillHere()) setShareLink(url); }
  };
  const share = async (publication?: Publication) => shareUrl(publication ? publicationUrl(location.origin, publication) : `${location.origin}${location.pathname}`, publication?.article.title);
  const subpage = !['home', 'settings', 'history', 'news'].includes(route);
  const navItems: { href: string; route: string; icon: IconName; label: string }[] = [{ href: '/', route: 'home', icon: 'radar', label: '首页' }, { href: '/news', route: 'news', icon: 'news', label: '动态' }, { href: '/history', route: 'history', icon: 'calendar', label: '记录' }, { href: '/settings', route: 'settings', icon: 'bell', label: '提醒' }];
  const navSection = publicNavSection(route);
  const navigation = navItems.map(item => <Link scroll={false} key={item.route} href={navHref(item.href)} prefetch={true} className={navSection === item.route ? 'active' : ''} aria-current={navSection === item.route ? route === item.route ? 'page' : 'location' : undefined}><Icon name={item.icon} /><span>{item.label}</span></Link>);
  const collectedAt = data ? latestSourceSuccess(data.sources) : undefined;
  const latestArticle = data && sortedArticles(data.articles)[0];
  const visibleNotices = data?.notices.filter(customerNotice).sort(compareNotices) || [];
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
    catch (cause) { dayPosterError = cause instanceof Error ? cause.message : '这条消息暂时无法分享。'; }
  }
  const newsArticles = route === 'news' && data ? sortedArticles(data.articles.filter(article => newsCategory === 'all' || article.category === newsCategory)) : [];
  const historyPublications = route === 'news' && newsCategory === 'reset' && data ? sortedStatePublications(data).filter(p => (p.event.actions.length>0 && (historyFilter === 'all' || p.event.actions.some(action => action.kind === historyFilter)) || ['all','automatic_reset'].includes(historyFilter) && resetObservations(data).some(o=>o.publicationId===p.id))) : [];
  const pageTitle = ({ history: '重置记录', news: '动态', settings: '提醒', more: '关于与隐私', notices: '站内信', methodology: '观察记录', events: '事件详情', articles: '动态详情', sources: '原文来源', activities: '活动动态' } as Record<string, string>)[route] ?? '重置雷达';
  const failure = <div className="pub-empty" role="alert"><Icon name="info" /><h2>资料暂时无法加载</h2><p>{error || '请稍后重试。'}</p><button className="pub-button primary" onClick={() => void refresh()} disabled={loading}>{loading ? '正在重试…' : '重新加载'}</button></div>;
  const pending = error ? failure : <LoadingContent variant={route==='history'?'calendar':['events','articles','sources','methodology'].includes(route)?'detail':'list'}/>;
  let content: React.ReactNode;
  if (route === 'settings') content = <Settings notices={visibleNotices} read={read} markRead={markRead} storageError={storageError} data={data} codeAvailable={posterCodeAvailable} pending={!data ? error ? <div className="pub-inbox-empty" role="alert"><p>消息暂时无法加载，请稍后重试。</p><button className="pub-text-button" onClick={() => void refresh()} disabled={loading}>重新加载</button></div> : pending : undefined}/>;
  else if (route === 'more') content = <MorePage />;
  else if (route === 'news') content = <News resetContent={newsCategory === 'reset' ? <History publications={historyPublications} filter={historyFilter} onFilter={setHistoryFilter} data={data} hasMore={!!page?.nextCursor} onMore={() => void more()} loading={loadingMore} pending={!data ? pending : undefined} /> : undefined} groups={data ? publicNewsGroups(data).filter(group => newsCategory === 'all' || group.category === newsCategory) : []} category={newsCategory} onCategoryChange={setNewsCategory} hasMore={!!page?.nextCursor} onMore={() => void more()} loading={loadingMore} pending={!data ? pending : undefined} />;
  else if (route === 'history') content = data ? <RecordCalendar data={data} date={query.get('date') || ''} kind={historyFilter} onDate={value=>changeFilter('date',value)} onKind={setHistoryFilter}/> : pending;
  else if (route === 'activities' && path[1]) content = <ActivityPage data={data} activity={data ? currentActivity : activityCache.current.get(path[1])} id={path[1]} query={query} onDay={value => changeFilter('day', value === null ? null : String(value))} pending={!data ? pending : undefined} onPoster={setPoster} onDayPoster={value => { setPoster(null); setDayPoster(value); }} />;
  else if (!readPath) content = <><Empty title="暂时没有这条记录" detail="链接可能已变化，请返回首页查看公开动态。" /><TextLink href="/">返回首页</TextLink></>;
  else if (!data) content = route==='home'?(error?<ResetStatePending failed busy={loading} onRetry={()=>void refresh()}/>:<LoadingContent variant="home"/>):pending;
  else if (route === 'home') content = <Home data={data} onWechatReminders={() => setWechatReminders(true)} onPoster={() => {const at=currentTime()||data.serverTime;setStatusPoster({actionId:'',round:statusPosterSnapshot(data,at).round,generatedAt:at});}} onShare={share} historical={historical} wechatEntry={wechatEntry} />;
  else if (route === 'events' && path[1]) content = <EventPage data={data} id={path[1]} onPoster={setPoster} onShare={share} />;
  else if (route === 'articles' && path[1]) content = <ArticlePage data={data} id={path[1]} onPoster={setPoster} />;
  else if (route === 'sources' && path[1]) content = <EvidencePage data={data} id={path[1]} />;
  else if (route === 'notices') content = <Notices publications={data.publications} notices={visibleNotices} read={read} markRead={markRead} storageError={storageError} selectedId={query.get('message')} />;
  else if (route === 'methodology') content = <Methodology data={data} snapshotId={query.get('snapshot')} cadenceId={query.get('cadence')} target={query.get('target')==='banked_reset'?'banked_reset':'automatic_reset'} onPoster={setForecastPoster} onShare={s=>shareUrl(`${location.origin}/methodology?snapshot=${encodeURIComponent(s.id)}`,'重置实验预测记录')} />;
  else content = <><Empty title="暂时没有这条记录" detail="链接可能已变化，请返回首页查看公开动态。" /><TextLink href="/">返回首页</TextLink></>;
  return <div className={`pub-shell route-${route} ${subpage ? 'is-detail' : ''}`} onClickCapture={onNavigateCapture}>
    <Suspense fallback={null}><PublicRouteReader onChange={onLocation} /></Suspense>
    <a className="pub-skip" href="#public-main">跳到主要内容</a>
    <header className="pub-topbar">
      <div className="pub-topbar-identity">{route === 'home' ? <Link scroll={false} href="/" className="pub-brand-home" aria-label="模钥重置雷达首页"><Brand name={data?.site.name} /></Link> : <div className="pub-topbar-heading">{subpage && <Link scroll={false} className="pub-header-back" href={backHref} aria-label="返回上级"><Icon name="back" /></Link>}<PageSymbol route={route}/>{['news', 'history', 'settings', 'more', 'notices'].includes(route) ? <h1 className="pub-topbar-title">{pageTitle}</h1> : <span className="pub-topbar-title">{pageTitle}</span>}{!navigationLoading && data && ['news', 'history'].includes(route) && <span className="pub-context-count" role="status" aria-live="polite" aria-atomic="true">{route === 'history' ? '近半年' : newsCategory === 'reset' ? `共${page?.total ?? historyPublications.length}个事件` : `共${page?.total ?? newsArticles.length}篇`}</span>}</div>}</div>
      <nav className="pub-desktop-nav" aria-label="主导航">{navigation}</nav><div className="pub-sidebar-note"><span className="pub-status-dot" /> 公开消息追踪<small>所有时间 · 北京时间</small></div><Link scroll={false} className="pub-icon-button pub-more-button" href="/more" aria-label="关于与隐私"><Icon name="more" /></Link>
    </header>
    <div className={`pub-refresh-track${refreshing ? " is-active" : ""}`} role={refreshing ? "status" : undefined} aria-label={refreshing ? "正在更新" : undefined}><span/></div>
    {subpage && <nav className="pub-page-back" aria-label="返回上级"><Link scroll={false} className="pub-back-link" href={backHref}><Icon name="back" />返回</Link></nav>}
    {route === 'home' && <div className="pub-home-heading">
      <div className="pub-home-atmosphere" aria-hidden="true"><img src="/skin/codex-reset-hero.jpg" alt="" width="1672" height="941" fetchPriority="high" /></div>
      <div className="pub-home-heading-copy"><h1><span className="pub-home-heading-topic"><span className="pub-home-heading-product">Codex</span>重置</span><span className="pub-home-heading-accent">一目了然</span></h1><p>不要错过每一次重置。</p></div>
      {!navigationLoading && data && <details className="pub-freshness"><summary><span className={`pub-status-dot${error || sourceStatus(data.sources).warning ? ' is-delayed' : ''}`} />{error ? '连接中断，保留已有资料' : sourceStatus(data.sources).label}<Icon name="info" /></summary><div><p>来源最近更新：<time dateTime={collectedAt}>{collectedAt ? `${briefTime(collectedAt)} · 北京时间` : '暂无记录'}</time></p><p>最新消息发布于：<time dateTime={latestArticle ? articleSourceTime(latestArticle) : undefined}>{latestArticle ? `${briefTime(articleSourceTime(latestArticle))} · 北京时间` : '暂无记录'}</time></p><p>来源分别更新；具体重置时间请查看对应消息。</p></div></details>}
    </div>}
    <main className={`pub-main ${contentMotion}`} id="public-main" tabIndex={-1} aria-busy={initialLoading}>
      {!navigationLoading && data && error && <div className="pub-warning" role="alert">连接暂时中断，保留上次成功获取的资料。<button className="pub-text-button" onClick={() => void refresh()}>重试</button></div>}
      {!navigationLoading && data && !error && sourceStatus(data.sources).warning && <div className="pub-warning" role="status">{sourceStatus(data.sources).label}，以下保留最近收录的资料。</div>}
      {updateAvailable && <button className="pub-update-prompt" onClick={applyUpdates}>有新内容 · 点击更新</button>}
      <Suspense fallback={<ContentPlaceholder />}>{content}</Suspense>
      {!navigationLoading && moreError && <div className="pub-pagination-error" role="alert">{moreError}<button className="pub-text-button" disabled={loadingMore} onClick={() => void more()}>重试加载更多</button></div>}
    </main>
    <footer className={`pub-footer ${subpage ? 'subpage' : ''}`}>{navigationLoading ? null : route==='methodology'&&query.get('snapshot') ? <p>预测资料截至时间见历史记录</p> : cutoff && !['home', 'events', 'articles', 'sources'].includes(route) ? <p>{historical ? '历史资料' : '资料截至'} · {displayTime(cutoff)}</p> : null}<p>所有时间均为北京时间</p><Link scroll={false} href="/more#privacy">隐私说明</Link></footer>
    <nav className="pub-bottom-nav" aria-label="手机主导航">{navigation}</nav>
    {statusPoster && <PosterModal statusDesign codeAvailable={posterCodeAvailable} target={{ validUntil:data?statusPosterSnapshot(data,statusPoster.generatedAt).validUntil:undefined,id: `${statusPoster.publication?.id??'current'}:${statusPoster.actionId}`, cutoffAt: statusPoster.publication?.cutoffAt??statusPoster.generatedAt, title: '公开重置状态', endpoint: `/api/v1/posters/${encodeURIComponent(statusPoster.publication?.id??'current')}?${new URLSearchParams({ layout: 'status', action: statusPoster.actionId,round:statusPoster.round,at:statusPoster.generatedAt })}`, filename: `模钥重置雷达-重置状态-${dateKey(data?.serverTime || new Date().toISOString())}.png` }} name={data?.site.name || '模钥重置雷达'} blocked={data && statusPoster.round!==statusPosterSnapshot(data,currentTime()||data.serverTime).round ? '公开状态已变化，请关闭后重新生成海报。' : ''} onClose={() => setStatusPoster(null)} onShare={() => share(statusPoster.publication)} />}
    {poster && <PosterModal target={{ id: poster.id, cutoffAt: poster.cutoffAt, title: poster.article.title, endpoint: `/api/v1/posters/${encodeURIComponent(poster.id)}`, filename: `模钥重置雷达-${dateKey(poster.cutoffAt)}-${poster.id}.png` }} name={data?.site.name || '模钥重置雷达'} blocked={posterWithdrawn ? '此内容已撤回，已停止生成海报。' : ''} onClose={() => setPoster(null)} onShare={() => share(poster)} />}
    {!poster && dayPoster && <PosterModal target={{ id: `${dayPoster.activityId}:${dayPoster.day}:${dayPoster.publicationIds.join(',')}`, cutoffAt: dayPosterCutoff, title: `活动第${dayPoster.day}天整合海报`, endpoint: `/api/v1/activity-posters/${encodeURIComponent(dayPoster.activityId)}?${activityShareQuery(dayPoster)}`, filename: `模钥重置雷达-活动第${dayPoster.day}天.png` }} name={data?.site.name || '模钥重置雷达'} blocked={dayPosterError} onClose={() => setDayPoster(null)} onShare={() => shareUrl(activityPublicationUrl(location.origin, dayPoster), `活动第${dayPoster.day}天进展`)} />}
    {!poster && !dayPoster && forecastPoster && <PosterModal target={{id:forecastPoster.id,cutoffAt:forecastPoster.evidenceCutoffAt,title:'重置实验预测记录',endpoint:`/api/v1/forecast-posters/${encodeURIComponent(forecastPoster.id)}`,filename:`模钥重置雷达-实验预测-${forecastPoster.id}.png`}} name={data?.site.name||'模钥重置雷达'} blocked={forecastPosterState.unavailable ? '此固定预测记录已不可用，已停止生成与分享海报。' : ''} onClose={()=>setForecastPoster(null)} onShare={()=>shareUrl(`${location.origin}/methodology?snapshot=${encodeURIComponent(forecastPoster.id)}`,'重置实验预测记录')} />}
    {shareLink && <ShareLinkModal url={shareLink} onClose={() => setShareLink(null)} />}
    {wechatReminders && <WechatReminderModal data={data} dataError={error} onRetryData={() => void refresh()} entry={wechatEntry} codeAvailable={posterCodeAvailable} onRetryEntry={retryWechat} onClose={() => setWechatReminders(false)} />}
    {toast && <div className="pub-toast" role="status">{toast}</div>}
  </div>;
}

export function Home({ data, onWechatReminders, onPoster, onShare, historical, wechatEntry = 'checking' }: { data: PublicData; onWechatReminders: () => void; onPoster: (p?: Publication, actionId?: string) => void; onShare: (p?: Publication) => Promise<void>; historical: boolean; wechatEntry?: WechatEntryState }) {
  const [resetKind,setResetKind]=useState<'automatic_reset'|'banked_reset'>('automatic_reset');
  const completions = recentCompletedBenefits(data), latest = latestCompletedBenefits(data)[0];
  const recent = homeNewsGroups(data).map(group => group.latest);
  const activity = data.activities.find(item => activityHomeVisible(item, data.serverTime));
  const activityDay = activity ? activityDayNumber(activity, data.serverTime) : undefined;
  const activityPhase = activityDay === undefined ? '活动动态' : activityDay < 1 ? '尚未开始' : activity && activityDay > activity.days ? '活动已结束' : `第${activityDay}天 / 共${activity?.days}天`;
  const latestRecord = completions.length ? <section className="pub-home-completions" aria-label="最近五条公开完成公告">
    <div className="pub-home-completions-heading"><h2>最近完成公告</h2><Link scroll={false} href="/history">全部记录 →</Link></div>
    {completions.map(item => <Link scroll={false} className="pub-home-completion" key={item.action.id} href={`/events/${encodeURIComponent(item.event.id)}`} aria-label={`公告称已${item.action.kind === 'banked_reset' ? '发放重置卡' : '重置用量'}，${completionTime(item.action.statementAt)}，查看公开依据`}>
      <Icon name="check"/><span className="pub-home-completion-name">{item.action.kind === 'banked_reset' ? '重置卡发放' : '用量重置'}</span>
      <time dateTime={item.action.statementAt} title={`${displayTime(item.action.statementAt)} · 北京时间`}>{completionTime(item.action.statementAt).replace(/^(\d{4})\/(\d{2})\/(\d{2}) /, (_, year: string, month: string, day: string) => `${year === dateKey(data.serverTime).slice(0, 4) ? '' : `${year}年`}${Number(month)}月${Number(day)}日 `)}</time>
    </Link>)}
  </section> : null;
  return <>
    {historical && <p className="pub-warning">当前展示历史收录资料。</p>}
    <div className="pub-home-dashboard">
      <div className="pub-home-current"><ResetStateCards data={data} selectedKind={resetKind} onKindChange={setResetKind}/></div>
      <LastResetElapsed data={data} selectedKind={resetKind}/>
      <div className="pub-home-card-actions">
        <button onClick={onWechatReminders} className="pub-button pub-home-reminder"><Icon name="bell"/><span>微信提醒</span>{wechatEntry === 'unavailable' && <small>待开放</small>}</button>
        <button className="pub-button secondary" onClick={()=>onPoster(latest?.publication,latest?.action.id)}>分享重置动态</button>
      </div>
      {latestRecord&&<div className="pub-home-records">{latestRecord}</div>}
      {activity && <Link scroll={false} className="pub-home-activity-card" href={`/activities/${encodeURIComponent(activity.id)}`}><div><h2>{activity.title}</h2><p>{activityPhase}</p></div><Icon name="calendar"/></Link>}
    </div>
    <section className="pub-recent"><div className="pub-section-heading"><div><h2>重置动态</h2></div><TextLink href="/news">全部动态</TextLink></div><div className="pub-recent-grid">{recent.length ? recent.map(p => <Announcement key={p.id} publication={p} withdrawn={publicationWithdrawn(data,p)} />) : <Empty title="暂无公开公告" detail="有新的重置或发卡消息时，会显示在这里。" />}</div></section>
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
  return <><RecordKindFilter value={filter as import('./public-navigation').HistoryFilter} onChange={onFilter}/>{pending ?? (publications.length ? [...months].map(([month, rows]) => <section className="pub-history-month" key={month}><h2>{month.replace('-', '年')}月</h2><div className="pub-history-list">{rows.map(publication => <article className={`pub-history-item${publicationWithdrawn(data!, publication) ? ' is-withdrawn' : ''}`} key={publication.id} data-reading-id={publication.eventId}><time dateTime={publicationSourceTime(publication)}>{briefTime(publicationSourceTime(publication))}</time><div><h3><Link scroll={false} href={`/events/${encodeURIComponent(publication.eventId)}`}>{publication.article.title}</Link></h3><div className="pub-history-status">{resetObservations(data!).some(o=>o.publicationId===publication.id)&&<Badge tone="cyan">重置观测</Badge>}{publication.event.actions.map(action => <Badge key={action.id} tone={action.stage === 'claimed_complete' ? 'cyan' : 'amber'}>{actionLabels[action.kind]} · {stageText(action, data!.serverTime)}</Badge>)}{publicationWithdrawn(data!, publication) && <Badge>已撤回</Badge>}{publication.article.historical && <span>历史收录</span>}</div><p>{publicArticleSummary(publication.article)}</p><TextLink href={`/events/${encodeURIComponent(publication.eventId)}`}>查看依据与进展</TextLink></div></article>)}</div></section>) : <Empty title="暂无相关公告" detail="这个分类还没有已发布的事件。" />)}{hasMore && <button className="pub-button full" disabled={loading} onClick={onMore}>{loading ? '正在加载…' : '加载更多'}</button>}</>;
}

function NewsProgress({ updates, currentId }: { updates: Publication[]; currentId: string }) {
  const previous = updates.filter(p => p.id !== currentId);
  if (!previous.length) return null;
  return <details className="pub-news-progress"><summary>查看其他进展 · {previous.length}条</summary><ol>{previous.map(p => <li key={p.id}><time dateTime={publicationSourceTime(p)}>{briefTime(publicationSourceTime(p))}</time><Link scroll={false} href={`/events/${encodeURIComponent(p.eventId)}?version=${encodeURIComponent(p.id)}`}>{p.article.title}</Link></li>)}</ol></details>;
}
export function News({ resetContent, groups, category, onCategoryChange, hasMore, onMore, loading, pending }: { resetContent?: React.ReactNode; groups: NewsGroup[]; category: NewsCategory; onCategoryChange: (category: NewsCategory) => void; hasMore:boolean; onMore:()=>void; loading:boolean; pending?: React.ReactNode }) {
  return <><div className="pub-filter" role="group" aria-label="动态分类">{([['all', '全部'], ['reset', '重置'], ['activity', '活动'], ['product', '产品']] as const).map(([value, label]) => <button key={value} aria-pressed={category === value} className={category === value ? 'active' : ''} onClick={() => onCategoryChange(value)}>{label}</button>)}</div>{category === 'reset' ? resetContent : <>{pending ?? (groups.length ? groups.map(group => {
    const publication = group.latest, article = publication.article;
    const href = isNewsOnly(publication) ? `/articles/${encodeURIComponent(article.id)}` : `/events/${encodeURIComponent(publication.eventId)}`;
    return <article className="pub-card pub-announcement pub-news-item" key={group.id} data-reading-id={article.id}>
      <div className="pub-card-top"><Badge tone={group.withdrawn ? '' : 'cyan'}>{group.withdrawn ? '已撤回' : group.incident ? '服务状态' : article.reviewStatus === 'pending' ? '消息待确认' : { reset:'重置动态', activity:'活动动态', product:'产品更新' }[group.category]}</Badge><time dateTime={publicationSourceTime(publication)}>{briefTime(publicationSourceTime(publication))}</time></div>
      <h3><Link scroll={false} href={href}>{article.title}</Link></h3><p>{publicArticleSummary(article)}</p>
      {article.reviewStatus && <div className="pub-news-context"><span>{publicReviewMessage(article)}</span></div>}
      <TextLink href={href}>查看详情与来源</TextLink><NewsProgress updates={group.updates} currentId={publication.id}/>
    </article>;
  }) : <Empty title="暂无相关内容" detail="有新的公开消息时，会显示在这里。" />)}{hasMore && <button className="pub-button full" disabled={loading} onClick={onMore}>{loading ? '正在加载…' : '加载更多'}</button>}</>}</>;
}
function PublicationNote({ publication }: { publication: Publication }) {
  return isNewsOnly(publication) ? <>{publication.article.reviewStatus && <p className="pub-warning">{publicReviewMessage(publication.article)}</p>}</> : null;
}
function Notices({publications,notices,read,markRead,storageError,selectedId}:{publications:Publication[];notices:Notice[];read:string[];markRead:(ids:string[])=>void;storageError:string;selectedId?:string|null}) {
  const unread=notices.filter(n=>!read.includes(n.id)).length,selected=selectedId?notices.find(n=>n.id===selectedId):null;
  if(selectedId)return selected?<article className="pub-card">{selected.pinned&&<Badge>置顶</Badge>}<h2>{selected.title}</h2><p className="pub-muted">{displayTime(selected.createdAt)}</p><p className="pub-prose">{selected.body||publicNoticeSummary(selected,publications)}</p><TextLink href="/notices">查看全部站内信</TextLink></article>:<Empty title="消息暂不可用" detail="这条消息已撤回或暂时无法读取。"/>;
  return <>{storageError&&<p className="pub-warning">{storageError}</p>}<div className="pub-section-heading"><span>{unread} 条未读</span><button className="pub-text-button" disabled={!unread} onClick={()=>markRead(notices.map(n=>n.id))}>全部标为已读</button></div>
    {notices.length?notices.map(n=><article key={n.id} className={`pub-card pub-notice${read.includes(n.id)?' is-read':''}`}><div className="pub-card-top">{n.pinned&&<Badge>置顶</Badge>}<Badge tone={read.includes(n.id)?'muted':''}>{read.includes(n.id)?'已读':'未读'}</Badge><time>{displayTime(n.createdAt)}</time></div><h2>{n.title}</h2><p>{publicNoticeSummary(n,publications)}</p>{n.origin==='admin'?<Link scroll={false} className="pub-text-link" href={`/notices?message=${encodeURIComponent(n.id)}`} onClick={()=>markRead([n.id])}>查看详情<Icon name="arrow"/></Link>:publications.some(p=>p.id===n.publicationId)?<Link scroll={false} className="pub-text-link" href={`/events/${encodeURIComponent(n.eventId)}?version=${encodeURIComponent(n.publicationId)}`} onClick={()=>markRead([n.id])}>查看关联公告<Icon name="arrow"/></Link>:<p className="pub-muted">关联记录暂不可用</p>}</article>):<Empty title="暂无站内信" detail="有新消息会显示在这里。"/>}
  </>;
}
function ActionCard({ action, now }: { action: BenefitAction; now: string }) {
  return <section className="pub-action-card">
    <div className="pub-card-top"><h3>{actionLabels[action.kind]}</h3><Badge tone={action.stage === 'claimed_complete' ? 'cyan' : action.stage === 'cancelled' ? '' : 'amber'}>{stageText(action, now)}</Badge></div>
    <dl className="pub-facts">
      <div><dt>声明时间</dt><dd><time dateTime={action.statementAt}>{displayTime(action.statementAt)}</time></dd></div>
      {action.expectedAt && <div><dt>预计时间</dt><dd><time dateTime={action.expectedAt}>{displayTime(action.expectedAt)}</time></dd></div>}
      <div className="pub-fact-eligibility"><dt>适用对象</dt><dd>{publicEligibility(action)}</dd></div>
      <div><dt>发放类型</dt><dd>{{ public: '公开发放', targeted: '定向补偿', private: '个人记录' }[action.scope]}</dd></div>
    </dl>
    {action.timeNote && <p className="pub-muted">{action.expectedAt ? "预计时间仅供参考，以实际发放为准。" : "预计时间暂未明确，请等待后续公告。"}</p>}
    {action.scope !== 'public' && <p className="pub-muted">仅适用于公告中说明的账户。</p>}
  </section>;
}
function useVersion() {
  return useSearchParams().get('version');
}
export function EventPage({ data, id, onPoster, onShare }: { data: PublicData; id: string; onPoster: (p: Publication) => void; onShare: (p: Publication) => Promise<void> }) {
  const version = useVersion();
  const current = data.events.find(event => event.id === id);
  const publication = version ? data.publications.find(p => p.id === version && p.eventId === id) : current && currentPublication(data, current);
  if (!version && current?.status === 'merged' && current.mergedInto) return <><Empty title="本条进展已并入其他消息" detail="请前往查看后续进展与来源。" /><TextLink href={`/events/${encodeURIComponent(current.mergedInto)}`}>查看后续进展</TextLink></>;
  if (!publication) return <Empty title="未找到这条公开记录" detail="这条消息暂不可用，请返回查看最新消息。" />;
  const historicalVersion = !!current && (current.publicationId !== publication.id || current.status === 'merged');
  const withdrawn = publicationWithdrawn(data, publication);
  const currentArticle = data.articles.find(article => article.id === publication.articleId);
  const currentReason = publication.event.status === 'withdrawn' || publication.article.status === 'withdrawn' ? publication.reason : currentArticle?.status === 'withdrawn' ? data.publications.find(p => p.id === currentArticle.publicationId)?.reason : current ? currentPublication(data, current)?.reason : publication.reason;
  const actions = isNewsOnly(publication) ? [] : publication.event.actions;
  const evidenceIds = new Set([...(isNewsOnly(publication) ? publication.article.evidenceIds : publication.event.evidenceIds), ...actions.flatMap(action => action.evidenceIds)]);
  return <>
    {historicalVersion && <div className="pub-warning">此消息已有更新，以下为原内容。<TextLink href={`/events/${encodeURIComponent(id)}`}>查看最新消息</TextLink></div>}
    {withdrawn && <div className="pub-warning">此内容已撤回，不再作为当前发放依据。{currentReason}</div>}
    <div className="pub-page-heading"><p className="pub-eyebrow">{publication.article.historical ? '历史收录 · ' : ''}{publication.article.category === 'activity' ? '活动动态' : publication.article.category === 'product' ? '产品更新' : '重置动态'}</p><h1>{publication.article.title}</h1><p>{actions.length ? '公开声明 · 所有时间均为北京时间' : `${displayTime(articleSourceTime(publication.article))} · 北京时间`}</p></div>
    {actions.length ? <>
      {actions.map(action => <ActionCard action={action} now={historicalVersion ? publication.cutoffAt : data.serverTime} key={action.id} />)}
      <p className="pub-event-boundary"><Icon name="info"/>依据公开声明，实际到账以账户显示为准。</p>
    </> : null}
    <section className="pub-card pub-summary"><ArticleContent article={publication.article} heading /><PublicationNote publication={publication} /></section>
    <EvidenceList collapsed evidence={data.evidence.filter(e => evidenceIds.has(e.id))} actions={actions} sources={data.sources} notes={publicSourceNotes(publication.article, actions)} />
    <NewsProgress updates={publicNewsGroups(data).find(group => group.updates.some(p => p.id === publication.id))?.updates ?? []} currentId={publication.id}/>
    <div className="pub-share-row"><button className="pub-button" onClick={() => void onShare(publication)}>分享这条公告<Icon name="link" /></button><button className="pub-button" disabled={withdrawn} onClick={() => onPoster(publication)}>生成海报<Icon name="share" /></button></div><TextLink href="/news?category=reset">查看全部公告</TextLink>
  </>;
}
export function ArticlePage({ data, id, onPoster }: { data: PublicData; id: string; onPoster: (p: Publication) => void }) {
  const article = data.articles.find(a => a.id === id);
  const publication = article && data.publications.find(p => p.id === article.publicationId);
  if (!article || !publication) return <Empty title="未找到这篇新闻" detail="该内容可能尚未发布。" />;
  return <>{article.status === 'withdrawn' && <p className="pub-warning">这篇新闻已撤回，不能作为当前发放依据。</p>}<div className="pub-page-heading"><h1>{publication.article.title}</h1><p>{publication.article.historical ? '历史收录 · ' : ''}{displayTime(articleSourceTime(publication.article))}</p></div><section className="pub-card pub-summary"><ArticleContent article={publication.article} heading /><PublicationNote publication={publication} /></section><EvidenceList collapsed evidence={data.evidence.filter(e => publication.article.evidenceIds.includes(e.id))} sources={data.sources} notes={publicSourceNotes(publication.article)} /><div className="pub-share-row"><Link scroll={false} className="pub-button" href={`/events/${encodeURIComponent(article.eventId)}`}>查看事件进展<Icon name="arrow" /></Link><button className="pub-button" disabled={article.status === 'withdrawn' || data!.events.find(event => event.id === article.eventId)?.status === 'withdrawn'} onClick={() => onPoster(publication)}>生成海报<Icon name="share" /></button></div></>;
}
function ArticleContent({ article, heading = false }: { article: Article; heading?: boolean }) {
  const { summary, body, hasAdditionalContent } = publicArticleContent(article);
  return <>{heading && <h2>{hasAdditionalContent ? '中文摘要' : '公告内容'}</h2>}<p className="pub-prose">{summary || '暂无可展示的公告内容，请查看来源。'}</p>{hasAdditionalContent && <details className="pub-disclosure"><summary>阅读全文</summary><p className="pub-prose">{body}</p></details>}</>;
}
const evidenceKind = (evidence: Evidence) => evidence.provenance === 'official' ? '官方原文' : evidence.provenance === 'archive' ? '第三方收录' : '补充来源';
const evidenceSourceName = (evidence: Evidence, sources: PublicData['sources']) => (sources.find(source => source.id === evidence.sourceId)?.name || '原文记录').replace('（辅助来源）', '').replace('（免费）', '');
function EvidenceList({ evidence, collapsed = false, actions = [], sources = [], notes = [] }: { evidence: Evidence[]; collapsed?: boolean; actions?: BenefitAction[]; sources?: PublicData['sources']; notes?: string[] }) {
  const priority = (item: Evidence) => actions.some(action => action.stage === 'claimed_complete' && action.evidenceIds.includes(item.id) && Date.parse(action.statementAt) === Date.parse(item.publishedAt)) ? 1 : 0;
  const rows = evidence.slice().sort((a, b) => priority(b) - priority(a) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || Number(b.provenance === 'official') - Number(a.provenance === 'official'));
  const contents = rows.length ? uniqueDisplayEvidence(rows).map(item => {
    const observation=observedEvidence(item,item.collectedAt);
    return <div className="pub-source-row" key={item.id}><div><strong>{observation?.sourceName??evidenceSourceName(item,sources)}</strong><span>{observation?'观测时间：':''}{briefTime(item.publishedAt)} · 北京时间 · {observation?'来源观测':evidenceKind(item)}</span><p className="pub-source-excerpt" dir="auto">{item.text}</p>{observation?<p className="pub-muted">第三方观测，实际额度以账户显示为准。</p>:(!item.contextComplete || item.textOrigin==='archive_excerpt')&&<p className="pub-muted">这里只收录了部分原文，请打开来源查看完整内容。</p>}<ExternalLink url={observation?.sourceUrl??item.url}>{observation?'查看观测来源':'打开原文'}</ExternalLink>{observation&&<ExternalLink url={observation.referenceUrl}>查看关联原帖</ExternalLink>}</div></div>;
  }) : <p className="pub-muted">暂未提供可展示的原文。</p>;
  return collapsed ? <details className="pub-card pub-disclosure"><summary><span>查看来源{rows[0] && <small className="pub-source-preview">{evidenceSourceName(rows[0],sources)} · {briefTime(rows[0].publishedAt)}</small>}</span></summary>{contents}{notes.length > 0 && <div className="pub-source-notes"><h3>来源补充说明</h3>{notes.map(note => <p key={note}>{note}</p>)}</div>}</details> : <section className="pub-card"><h2>来源</h2>{contents}</section>;
}

export function EvidencePage({ data, id }: { data: PublicData; id: string }) {
  const evidence = data.evidence.find(e => e.id === id);
  if (!evidence) return <Empty title="未找到这条来源" detail="只展示与公开发布内容关联的原文资料。" />;
  const parent = evidence.parentId ? data.evidence.find(e => e.id === evidence.parentId || e.messageId === evidence.parentId) : undefined;
  const articles = data.articles.filter(a => a.evidenceIds.includes(id));
  return <><div className="pub-page-heading"><h1>原文与来源</h1><p>{displayTime(evidence.publishedAt)} · 北京时间</p></div><section className="pub-card"><div className="pub-card-top"><h2>{evidenceSourceName(evidence, data.sources)}</h2><Badge tone={evidence.provenance === 'official' ? 'cyan' : ''}>{evidenceKind(evidence)}</Badge></div>{evidence.provenance === 'archive' && <p className="pub-muted">由第三方收录，可打开原文核对。</p>}<ExternalLink url={evidence.url}>打开原文</ExternalLink></section>{(!evidence.contextComplete || evidence.textOrigin === 'archive_excerpt') && <p className="pub-warning">这里只收录了部分原文，请打开来源查看完整内容。</p>}<section className="pub-card"><h2>{evidence.provenance === 'official' && evidence.textOrigin !== 'structured' && evidence.textOrigin !== 'archive_excerpt' ? '原文内容' : '收录内容'}</h2><blockquote className="pub-original" dir="auto">{evidence.text}</blockquote></section>{parent && <section className="pub-card"><h2>相关上文</h2><p className="pub-prose">{parent.text}</p><TextLink href={`/sources/${encodeURIComponent(parent.id)}`}>查看上文来源</TextLink></section>}{articles.length > 0 && <section className="pub-card"><h2>对应中文内容</h2>{articles.map(article => <TextLink key={article.id} href={`/articles/${encodeURIComponent(article.id)}`}>{article.title}</TextLink>)}</section>}</>;
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
    catch (cause) { return <><Empty title="分享链接无效" detail={cause instanceof Error ? cause.message : '无法打开分享内容。'} /><TextLink href={`/activities/${encodeURIComponent(id)}`}>查看当前每日进展</TextLink></>; }
    const fixed = resolveActivityShare(data, selection);
    if (!fixed.available) return <><Empty title="分享内容暂不可用" detail={fixed.blockedReason} /><TextLink href={`/activities/${encodeURIComponent(id)}`}>查看当前每日进展</TextLink></>;
    return <><div className="pub-page-heading"><p className="pub-eyebrow">分享时的活动进展 · 第{fixed.manifest.day}天</p><h1>{fixed.activity.title}</h1><p>{fixed.date} · {fixed.items.length}条进展</p></div><p className="pub-warning">{fixed.rulesNotice}以下为分享时的内容，可查看最新进展。</p><div className="pub-share-row"><button className="pub-button" onClick={() => onDayPoster(fixed.manifest)}>生成整日海报<Icon name="share" /></button><Link scroll={false} className="pub-button" href={`/activities/${encodeURIComponent(id)}?day=${fixed.manifest.day}`}>查看当前进展<Icon name="arrow" /></Link></div>{fixed.items.map(({ publication, sourceTime }) => <article className="pub-card" key={publication.id} data-reading-id={publication.id}><div className="pub-card-top"><Badge tone="purple">分享记录</Badge><time>{briefTime(sourceTime)}</time></div><h2>{publication.article.title}</h2><ArticleContent article={publication.article} /><p className="pub-muted">此条资料截至 {displayTime(publication.cutoffAt)}</p><TextLink href={`/events/${encodeURIComponent(publication.eventId)}?version=${encodeURIComponent(publication.id)}`}>查看消息与来源</TextLink></article>)}</>;
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
    {entries.map(article => { const publication = data!.publications.find(p => p.id === article.publicationId); return <article className="pub-card" key={article.id} data-reading-id={article.id}><div className="pub-card-top"><Badge tone="purple">{article.historical ? '历史收录 · ' : ''}活动动态</Badge><time dateTime={articleSourceTime(article)} title={`${displayTime(articleSourceTime(article))} · 北京时间`}>{briefTime(articleSourceTime(article))}</time></div><h2>{article.title}</h2><ArticleContent article={article} /><div className="pub-card-top"><TextLink href={`/articles/${encodeURIComponent(article.id)}`}>查看详情与来源</TextLink>{publication && <button className="pub-text-button" disabled={article.status === 'withdrawn' || data!.events.find(event => event.id === article.eventId)?.status === 'withdrawn'} onClick={() => onPoster(publication)}>分享海报<Icon name="share" /></button>}</div></article>; })}
    </>}
  </div>;

}
export function Settings({notices,read,markRead,storageError,pending,data,codeAvailable=false}:{notices:Notice[];read:string[];markRead:(ids:string[])=>void;storageError:string;pending?:React.ReactNode;data?:PublicData|null;codeAvailable?:boolean}) {
  const unread=notices.filter(n=>!read.includes(n.id)).length;
  return <>
    <section className="pub-card pub-inbox-card"><div className="pub-section-heading"><h2>站内信 {unread>0&&<span className="pub-inbox-unread">{unread} 未读</span>}</h2><TextLink href="/notices">查看全部站内信</TextLink></div>
      {pending ?? <>{notices.slice(0,3).map(n=><Link scroll={false} key={n.id} className="pub-inbox-preview" href={n.origin==='admin'?`/notices?message=${encodeURIComponent(n.id)}`:`/events/${encodeURIComponent(n.eventId)}?version=${encodeURIComponent(n.publicationId)}`} onClick={()=>markRead([n.id])}><div><strong>{n.pinned&&<span className="pub-inbox-pin">置顶 · </span>}{n.title}</strong>{!read.includes(n.id)&&<span className="pub-status-dot"/>}</div><p>{publicNoticeSummary(n,data?.publications)}</p><small>{displayTime(n.createdAt)}</small></Link>)}
      {!notices.length&&<p className="pub-inbox-empty">暂无站内信，有新消息会显示在这里。</p>}</>}
    </section>
    <section className="pub-card pub-reminder-pending"><div className="pub-section-heading"><h2>微信提醒</h2><Badge tone="muted">小程序内开启</Badge></div><p>请在小程序的提醒页开启微信提醒，每次成功授权增加一次提醒机会。</p><p className="pub-muted">可分别选择重置预告、重置完成提醒和重要更正。每成功发送一条使用一次，未开启的类型不使用次数。</p><WechatEntryGuide publicationId={data?.publications.find(p=>!publicationWithdrawn(data,p))?.id} codeAvailable={codeAvailable}/></section>
    {storageError&&<p className="pub-warning">{storageError}</p>}

  </>;
}
function MorePage() {
  return <><section className="pub-card"><h2>关于模钥重置雷达</h2><p>关注 Codex 额度重置、重置卡发放和公开活动安排。</p><p>本站整理公开消息，具体适用范围和到账情况以发布方及你的账户为准。</p></section>
    <section className="pub-card"><h2>微信客服</h2><p>在微信中打开“模钥重置雷达”小程序，进入底部“提醒”，点击“联系小程序客服”即可打开微信客服会话。</p><p className="pub-muted">客服用于网站使用与信息反馈，无法代查你的 Codex 账户或办理额度发放。请勿在会话中发送密码或密钥。</p></section>
    <section className="pub-card" id="privacy"><h2>隐私说明</h2><p>查看公开消息无需提供手机号、通讯录或位置。已读状态保存在当前设备，清除浏览器数据后可能重置。</p><p>微信提醒使用微信提供的用户标识管理接收状态，可以在小程序提醒页关闭。保存海报由你主动操作，我们不读取或上传你的相册。</p><p>小程序内可查看平台提供的完整隐私指引。</p></section></>;
}
export function Methodology({data,snapshotId,cadenceId,target='automatic_reset',onPoster,onShare}:{data:PublicData;snapshotId:string|null;cadenceId:string|null;target?:'automatic_reset'|'banked_reset';onPoster:(s:ForecastSnapshot)=>void;onShare:(s:ForecastSnapshot)=>Promise<void>}) {
  if(cadenceId)return <><div className="pub-page-heading"><h1>历史间隔实验记录</h1></div><ForecastPanel data={data.forecasts} snapshotId={null} cadenceId={cadenceId} onPoster={onPoster} onShare={onShare}/></>;
  if(snapshotId)return <><div className="pub-page-heading"><h1>固定预测记录</h1><p>初始预测与后续结局分别保留。</p></div><ForecastPanel data={data.forecasts} snapshotId={snapshotId} onPoster={onPoster} onShare={onShare}/></>;
  return <><div className="pub-page-heading"><h1>观察记录</h1></div><ForecastPanel data={data.forecasts} snapshotId={snapshotId} target={target} onPoster={onPoster} onShare={onShare}/></>;
}
function WechatReminderModal({onClose,data,codeAvailable}:{data:PublicData|null;dataError:string;onRetryData:()=>void;entry:WechatEntryState;codeAvailable:boolean;onRetryEntry:()=>void;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current ? openPublicDialog(dialog.current) : undefined, []);
  return <dialog className="pub-dialog" ref={dialog} onClose={onClose} onCancel={onClose}><div className="pub-dialog-heading"><h2>微信提醒</h2><button className="pub-icon-button" aria-label="关闭窗口" onClick={onClose}><Icon name="close"/></button></div><div className="pub-dialog-body"><p>在小程序的提醒页开启，每次成功授权增加一次提醒机会。</p><p>可分别选择重置预告、重置完成提醒和重要更正。每成功发送一条使用一次，也可以随时关闭。</p><WechatEntryGuide publicationId={data?.publications.find(p=>!publicationWithdrawn(data,p))?.id} codeAvailable={codeAvailable}/><TextLink href="/notices">查看全部站内信</TextLink><button className="pub-button full" onClick={onClose}>知道了</button></div></dialog>;
}
function ShareLinkModal({ url, onClose }: { url: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('复制链接后发送给朋友。');
  useEffect(() => dialog.current ? openPublicDialog(dialog.current) : undefined, []);
  const copy = async () => { try { await navigator.clipboard.writeText(url); setMessage('链接已复制'); } catch { input.current?.select(); setMessage('请长按或选中链接复制。'); } };
  return <dialog className="pub-dialog" ref={dialog} onClose={onClose} onCancel={onClose} aria-labelledby="pub-share-title"><div className="pub-dialog-heading"><h2 id="pub-share-title">转发给朋友</h2><button className="pub-icon-button" aria-label="关闭分享" onClick={onClose}><Icon name="close" /></button></div><div className="pub-dialog-body"><label className="pub-share-link-label" htmlFor="pub-share-url">消息链接</label><input className="pub-share-link-input" id="pub-share-url" ref={input} value={url} readOnly onClick={event => event.currentTarget.select()} /><button className="pub-button primary full" onClick={() => void copy()}>复制链接</button><p className="pub-dialog-note" role="status">{message}</p>{isLocalShareUrl(url) && <p className="pub-dialog-note">当前为本机链接，其他设备需通过正式网站地址访问。</p>}</div></dialog>;
}
interface PosterTarget { validUntil?:string; id: string; cutoffAt: string; title: string; endpoint: string; filename: string; }
function PosterModal({ target, name, blocked:externalBlocked, note, statusDesign = false, codeAvailable = false, onClose, onShare }: { target: PosterTarget; name: string; blocked: string; note?: string; statusDesign?: boolean; codeAvailable?: boolean; onClose: () => void; onShare: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cache = useRef(new Map<string, PosterImage>());
  const [result, setResult] = useState<{ image: PosterImage; key: string } | null>(null);
  const [style, setStyle] = useState<StatusPosterStyle>('precision');
  const [includeCode, setIncludeCode] = useState(true);
  const [generating, setGenerating] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const variant = statusDesign ? statusPosterVariant(target.endpoint, target.filename, style, includeCode && codeAvailable) : target;
  const requestKey = `${variant.endpoint}:${target.cutoffAt}:${variant.filename}`;
  const image = cache.current.get(requestKey) ?? (result?.key === requestKey ? result.image : null);
  const preview = image ?? result?.image;
  const selectedStyle = statusPosterStyles.find(option => option.id === style)!;
  const [expired,setExpired]=useState(false);
  const blocked=externalBlocked||(expired?'公开状态已变化，请关闭后重新生成海报。':'');
  useEffect(()=>{setExpired(false);if(!target.validUntil)return;const remaining=Date.parse(target.validUntil)-Date.parse(target.cutoffAt);if(remaining<=0){setExpired(true);return;}const timer=window.setTimeout(()=>setExpired(true),Math.min(2147483647,remaining+20));return()=>clearTimeout(timer);},[target.id,target.cutoffAt,target.validUntil]);
  useEffect(() => dialog.current ? openPublicDialog(dialog.current) : undefined, []);
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
  const linkBlocked = !!blocked || /^(此内容已撤回|公开状态已变化)/.test(error);
  return <dialog className={`pub-dialog${statusDesign ? ' pub-poster-dialog' : ''}`} ref={dialog} onClose={onClose} onCancel={onClose} aria-labelledby="pub-poster-title">
    <div className="pub-dialog-heading"><h2 id="pub-poster-title">分享海报</h2><button className="pub-icon-button" aria-label="关闭海报" onClick={onClose}><Icon name="close" /></button></div>
    <div className="pub-dialog-body">
      {statusDesign && <div className="pub-poster-options">
        <div className="pub-poster-styles" role="group" aria-label="海报风格">{statusPosterStyles.map(option => <button key={option.id} type="button" className={`pub-poster-style${style === option.id ? ' is-selected' : ''}`} aria-pressed={style === option.id} disabled={sharing || !!blocked} onClick={() => { if (style !== option.id) { setGenerating(true); setError(''); setStyle(option.id); } }}><span className={`pub-poster-swatch ${option.id}`} aria-hidden="true" /><span>{option.label}</span>{style === option.id && <Icon name="check" />}</button>)}</div>
        <label className="pub-poster-code-option"><input type="checkbox" checked={includeCode && codeAvailable} disabled={!codeAvailable || sharing || !!blocked} onChange={event => { setGenerating(true); setError(''); setIncludeCode(event.target.checked); }} /><span>带微信官方小程序码</span>{!codeAvailable && <small>小程序码暂未启用，本张海报不带扫码入口</small>}</label>
      </div>}
      <div className={`pub-poster-preview${!preview || blocked ? ' pub-poster-preview-empty' : ''}`} aria-busy={generating}>
        {blocked ? <p className="pub-warning" role="alert">{blocked}</p> : <>
          {preview && <img className="pub-poster-image" src={preview.url} alt={`${name}分享海报：${target.title}`} />}
          {generating && <div className="pub-poster-loading" role="status"><span className="pub-loading-bar" aria-hidden="true"/><p>正在生成{statusDesign ? selectedStyle.label : ''}海报…</p></div>}
        </>}
        {error && <div className="pub-warning" role="alert"><p>{error}</p>{!image && !blocked && <button className="pub-text-button" onClick={() => setAttempt(value => value + 1)}>重新生成</button>}</div>}
      </div>
      <div className="pub-share-row"><button className="pub-button" disabled={sharing || linkBlocked || (canShareImage && generating)} onClick={() => void (canShareImage ? shareImage() : onShare())}>{sharing ? '正在打开分享…' : canShareImage ? '转发海报' : '分享公告链接'}<Icon name="share" /></button><button className="pub-button primary" disabled={generating || !image || !!blocked} onClick={() => image && savePosterImage(image)}>保存海报</button></div>
      <p className="pub-dialog-note" role="status">{statusDesign ? image?.codeState === 'unavailable' ? '小程序码暂不可用，可直接分享消息。' : '海报记录生成时的公开状态，所有时间均为北京时间。' : note || (image ? '长按图片可保存，扫码可查看这条消息。' : '海报展示这条消息，最新进展请查看小程序。')}{local && '当前为本机预览，手机暂时无法扫码访问。'}</p>
    </div>
  </dialog>;
}
