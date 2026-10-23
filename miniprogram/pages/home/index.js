const { createPage } = require('../../utils/page');
const m = require('../../utils/model');
const { resetStateCards } = require('../../utils/reset-state-cards');
const { statusTimelineModel } = require('../../utils/status-timeline');
function completionDate(value, now) {
  const full = m.completionTime(value);
  if (full === '暂无记录') return full;
  const year = full.slice(0, 4) === m.dateKey(now).slice(0, 4) ? '' : `${full.slice(0, 4)}年`;
  return `${year}${full.slice(5, 7)}月${full.slice(8, 10)}日 ${full.slice(11, 16)}`;
}
Page(createPage((data, query, page, app) => {
  if (!data) return { name: '模钥重置雷达', latest: null, completions: [], pending: null, forecast: null, recent: [], activity: null, sharePath: '', timeline: null, posterPath: '', posterDescription: '' };
  const states = resetStateCards(data);
  const selectedResetKind=page.selectedResetKind||'automatic_reset';
  const outlook = m.resetOutlookModel(data), completed = m.latestCompletedBenefits(data), latestItem = completed[0], pending = outlook.active;
  const latestPublication = latestItem && latestItem.publication;
  const latestAction = latestItem && latestItem.action;
  const latest = latestItem ? { ...latestAction, publicationId: latestPublication.id } : null;
  const pendingPublication = pending && data.publications.find(item => item.id === pending.publicationId);
  const countdown = pending && m.announcementCountdown(pending, data.serverTime);
  const pathFor = item => item ? `/pages/detail/index?publicationId=${encodeURIComponent(item.publicationId)}` : '';
  const shareTarget = pending || latest;
  const activity = data.activities.find(item => m.activityHomeVisible(item, data.serverTime));
  const recentSuccess = data.sources.map(item => item.lastSuccessAt).filter(at => Number.isFinite(Date.parse(at))).sort().pop();
  const articles = m.sortedArticles(data.articles), latestArticle = articles[0];
  const shareable = publication => publication && m.resolveDetail(data, { publicationId: publication.id }).canShare;
  const posterPublication = shareable(latestPublication) ? latestPublication : articles.map(article => data.publications.find(item => item.id === article.publicationId)).find(shareable);
  const posterPath = posterPublication ? pathFor({ publicationId: posterPublication.id }) : '';
  const posterDescription = '选择黑金或水墨，分享当前公开状态';
  return {
    name: data.site.name || '模钥重置雷达',
    resetCards:states.cards,untypedSignal:states.untyped,stateWarning:states.sourceWarning,signalExpiredNote:states.expiredNote,selectedResetKind,
    historicalProbability: m.referenceCadenceView(data.forecasts?.referenceCadence,data.serverTime),
    lastReset: selectedResetKind==='banked_reset'?states.lastCard:states.lastReset,
    latest: latest ? { title: latest.kind === 'banked_reset' ? '公告称已发放重置卡' : '公告称已重置用量', elapsed: m.elapsed(latest.statementAt, data.serverTime), time: m.completionTime(latest.statementAt), eligibility: latestAction.eligibility, path: pathFor(latest) } : null,
    completions: m.recentCompletedBenefits(data).map(item => ({ id:item.action.id, kind: item.action.kind, title: item.action.kind === 'banked_reset' ? '公告称已发放重置卡' : '公告称已重置用量', label: item.action.kind === 'banked_reset' ? '重置卡发放' : '用量重置', time: m.completionTime(item.action.statementAt), shortTime: completionDate(item.action.statementAt, data.serverTime), path: pathFor({ publicationId: item.publication.id }) })),
    evidencePath: pathFor(pending || latest) || '/pages/announcements/index',
    evidenceLabel: pending ? '查看本次公告' : latest ? '查看最近公告' : '浏览历史记录',
    pending: pending ? { label: m.actionLabels[pending.kind], stage: m.stageText(pending, data.serverTime), countdown: countdown.label, timed: countdown.status !== 'unknown', counting: countdown.status === 'upcoming', time: pending.expectedAt ? m.displayTime(pending.expectedAt) : '', timeNote: pending.timeNote || '', path: pathFor(pending) } : null,
    forecast: null, outlookStatus: outlook.status,
    timeline: statusTimelineModel(outlook, data.serverTime, latestAction || null, data.forecasts), posterPath, posterDescription,
    sourceDelayed: m.sourceStatus(data.sources).warning, sourceStatusLabel:m.sourceStatus(data.sources).label,
    collectedAt: m.displayTime(recentSuccess), latestSourceTime: latestArticle ? m.displayTime(m.articleSourceTime(latestArticle)) : '暂无记录',
    waitingText: outlook.status === 'completed' ? '本次已有公开完成声明，等待下一次预告。' : outlook.status === 'cancelled' ? '本次安排已取消，等待下一次预告。' : '等待下一次预告，暂无新的时间依据。',
    activity: activity ? { title: activity.title, rules: activity.rules, phase: m.activityModel(data, activity.id).phase, entries: activity.items.length, path: `/pages/activity/index?id=${encodeURIComponent(activity.id)}` } : null,
    recent: m.homeNewsGroups(data).map(group=>group.latest).map(item => m.publicationCard(data, item)),
    recentDays: m.calendarModel(data).recentDays, sharePath: pathFor(shareTarget), shareTitle: pendingPublication ? pendingPublication.article.title : latestPublication ? latestPublication.article.title : data.site.name,
    shareLabel: '分享这条公告给朋友',
    historical: data.articles.length > 0 && data.articles.every(article => m.isHistoricalArticle(article, data.evidence))
  };
}, { view:()=>({view:'home'}), data: { name: '模钥重置雷达', freshnessOpen: false }, afterRender() { this.queueCalendarPrefetch(); this.syncCountdown(); this.syncForecastExpiry(); }, hide() { this.cancelCalendarPrefetch(); this.stopCountdown(); this.stopForecastExpiry(); }, unload() { this.cancelCalendarPrefetch(); this.stopCountdown(); this.stopForecastExpiry(); }, methods: {
  queueCalendarPrefetch() {
    if(!this.data.connected || this._calendarPrefetched || this._calendarPrefetchTimer || !getApp().client.prefetchCalendar)return;
    this._calendarPrefetchTimer=setTimeout(()=>{this._calendarPrefetchTimer=null;if(this._visible){this._calendarPrefetched=true;void getApp().client.prefetchCalendar();}},800);
  },
  cancelCalendarPrefetch() { if(this._calendarPrefetchTimer)clearTimeout(this._calendarPrefetchTimer);this._calendarPrefetchTimer=null; },
  toggleFreshness() { this.setData({ freshnessOpen: !this.data.freshnessOpen }); },
  openPoster() { if (this.data.connected) wx.navigateTo({ url:'/packages/poster/index',fail(){wx.showToast({title:'海报页面加载失败，请重试。',icon:'none'});} }); },
  syncCountdown() {
    if (!this.data.lastReset && !this.data.resetCards?.some(card=>['scheduled','revised','completed','overdue'].includes(card.state)) && !(this.data.pending && this.data.pending.counting) && !(this.data.timeline && (this.data.timeline.completed || this.data.timeline.scheduled))) { this.stopCountdown(); return; }
    if (!this._countdownTimer) this._countdownTimer = setInterval(() => this.tickCountdown(), 1000);
  },
  tickCountdown() {
    if(!this._visible)return;
    const state=getApp().client.getState();if(!state.data)return;
    const now=new Date(Date.parse(state.data.serverTime)+Math.max(0,Date.now()-state.receivedAt)).toISOString();
    const outlook=m.resetOutlookModel(state.data),completed=m.latestCompletedBenefits(state.data)[0];
    const timeline=statusTimelineModel(outlook,now,completed?.action||null,state.data.forecasts);
    // Only the clock region crosses the native bridge; lists and page layout stay untouched.
    if(JSON.stringify(timeline)!==JSON.stringify(this.data.timeline))this.setData({timeline});
    if(outlook.active && this.data.pending){
      const count=m.announcementCountdown(outlook.active,now);
      if(count.label!==this.data.pending.countdown)this.setData({pending:{...this.data.pending,countdown:count.label,counting:count.status==='upcoming'}});
    }
    const cardPatch=this.resetCardsPatch(state.data,now);if(Object.keys(cardPatch).length)this.setData(cardPatch);
    this.syncCountdown();
  },
  stopCountdown() { if (this._countdownTimer) clearInterval(this._countdownTimer); this._countdownTimer = null; },
  syncForecastExpiry() {
    if (!this._visible) { this.stopForecastExpiry(); return; }
    const state=getApp().client.getState(),forecasts=state.data && state.data.forecasts;
    if (!forecasts) { this.stopForecastExpiry(); return; }
    const now=Date.parse(state.data.serverTime)+Math.max(0,Date.now()-state.receivedAt);
    const dates=[];
    if(forecasts.referenceCadence?.status==='ready')dates.push(forecasts.referenceCadence.validUntil);
    if (forecasts.watch && forecasts.watch.status==='active' && forecasts.watch.signal) dates.push(forecasts.watch.signal.expiresAt);
    const next=dates.map(Date.parse).filter(at=>Number.isFinite(at)&&at>now).sort((a,b)=>a-b)[0];
    if (!next) { this.stopForecastExpiry(); return; }
    if (this._forecastExpiryAt===next && this._forecastExpiryTimer) return;
    this.stopForecastExpiry();this._forecastExpiryAt=next;
    // One boundary update, not a new polling or per-second rendering loop.
    this._forecastExpiryTimer=setTimeout(()=>{this._forecastExpiryTimer=null;this.tickForecastExpiry();},Math.min(2147483647,Math.max(1,next-now+20)));
  },
  tickForecastExpiry() {
    if(!this._visible)return;
    const state=getApp().client.getState();if(!state.data)return;
    const now=new Date(Date.parse(state.data.serverTime)+Math.max(0,Date.now()-state.receivedAt)).toISOString();
    const outlook=m.resetOutlookModel(state.data),completed=m.latestCompletedBenefits(state.data)[0];
    const timeline=statusTimelineModel(outlook,now,completed?.action||null,state.data.forecasts);
    const patch={};
    const historicalProbability=m.referenceCadenceView(state.data.forecasts?.referenceCadence,now);
    if(JSON.stringify(historicalProbability)!==JSON.stringify(this.data.historicalProbability))patch.historicalProbability=historicalProbability;
    if(JSON.stringify(timeline)!==JSON.stringify(this.data.timeline))patch.timeline=timeline;
    Object.assign(patch,this.resetCardsPatch(state.data,now));
    if(Object.keys(patch).length)this.setData(patch);
    this.syncCountdown();this.syncForecastExpiry();
  },
  stopForecastExpiry() { if(this._forecastExpiryTimer)clearTimeout(this._forecastExpiryTimer);this._forecastExpiryTimer=null;this._forecastExpiryAt=null; },
  resetCardsPatch(data, now) {
    const states=resetStateCards(data,now),patch={};
    for(const [key,value] of Object.entries({resetCards:states.cards,untypedSignal:states.untyped,stateWarning:states.sourceWarning,signalExpiredNote:states.expiredNote}))if(JSON.stringify(this.data[key])!==JSON.stringify(value))patch[key]=value;
    const history=this.data.selectedResetKind==='banked_reset'?states.lastCard:states.lastReset;
    if(!history||!this.data.lastReset){if(JSON.stringify(history)!==JSON.stringify(this.data.lastReset))patch.lastReset=history;}
    else for(const [key,value] of Object.entries(history))if(value!==this.data.lastReset[key])patch['lastReset.'+key]=value;
    return patch;
  },
  selectResetKind(event) { const kind=event.currentTarget.dataset.kind;if(['automatic_reset','banked_reset'].includes(kind)){this.setData({selectedResetKind:kind,expandedSourceKind:''});this.tickCountdown();this.syncCountdown();} },
  openStatusEvidence(event) {
    const kind=event.currentTarget.dataset.kind,card=kind==='untyped'?this.data.untypedSignal:this.data.resetCards.find(item=>item.kind===kind);
    if(!card)return;
    if(card.sourceName){this.setData({expandedSourceKind:this.data.expandedSourceKind===kind?'':kind});return;}
    if(card.publicationId)wx.navigateTo({url:'/pages/detail/index?publicationId='+encodeURIComponent(card.publicationId)});
    else wx.switchTab({url:'/pages/news/index'});
  },
  openLastReset() { if(this.data.lastReset?.publicationId)wx.navigateTo({url:'/pages/detail/index?publicationId='+encodeURIComponent(this.data.lastReset.publicationId)}); },
  openObservation(event) {
    const card=this.data.resetCards?.find(item=>item.kind===event.currentTarget.dataset.kind);
    if(card?.observationPublicationId)wx.navigateTo({url:'/pages/detail/index?publicationId='+encodeURIComponent(card.observationPublicationId),fail(){wx.showToast({title:'观测详情加载失败，请重试',icon:'none'});}});
  },
  copyStatusSource(event) { const url=event.currentTarget.dataset.url;if(typeof url==='string'&&url.startsWith('https://')&&m.safeUrl(url))wx.setClipboardData({data:url,fail(){wx.showToast({title:'复制失败，请稍后重试',icon:'none'});}}); },
  copyWatchSource() {
    const url=this.data.timeline && this.data.timeline.sourceUrl;
    if(typeof url==='string' && url.startsWith('https://') && !!m.safeUrl(url))wx.setClipboardData({data:url,fail(){wx.showToast({title:'复制失败，请稍后重试',icon:'none'});}});
  },
  copyWatchProvider() { wx.setClipboardData({data:this.data.timeline?.sourceName==='AIPlanWatch'?'https://codex-reset.aiplanwatch.com/':'https://codex-resets.com/',fail(){wx.showToast({title:'复制失败，请稍后重试',icon:'none'});}}); },
  openWechatSettings() { wx.switchTab({ url: '/pages/settings/index' }); },
  openDay(event) { wx.navigateTo({ url: `/pages/schedule/index?date=${event.currentTarget.dataset.date}` }); },
  onShareAppMessage() { return { title: this.data.shareTitle || '模钥重置雷达', path: this.data.sharePath || '/pages/home/index' }; }
} }));
