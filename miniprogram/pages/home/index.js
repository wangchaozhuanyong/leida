const { createPage } = require('../../utils/page');
const m = require('../../utils/model');
const { homeResetStatus: homeStateCards, selectedHomeStatus, validKind } = require('../../utils/home-reset-status');
const { statusTimelineModel, countdownParts } = require('../../utils/status-timeline');
function completionDate(value, now) {
  const full = m.completionTime(value);
  if (full === '暂无记录') return full;
  const year = full.slice(0, 4) === m.dateKey(now).slice(0, 4) ? '' : `${full.slice(0, 4)}年`;
  return `${year}${full.slice(5, 7)}月${full.slice(8, 10)}日 ${full.slice(11, 16)}`;
}
// History is a dated message, not a second countdown to another reset.
function recentMessage(record) {
  if (!record) return null;
  const days = Number(record.days), hours = Number(record.hours), minutes = Number(record.minutes);
  const duration = days ? `${days}天${hours ? hours + '小时' : ''}`
    : hours ? `${hours}小时${minutes ? minutes + '分钟' : ''}` : minutes ? `${minutes}分钟` : '';
  const [dateText, clockText] = record.displayTime.split(' ');
  return {
    publicationId: record.publicationId, sourceType: record.sourceType, sourceName: record.sourceName,
    dateText, clockText, relativeTime: duration ? `距今 ${duration}` : '刚刚',
    timeLabel: record.sourceType === 'observed' ? '来源记录时间' : '完成消息时间',
    badge: record.sourceType === 'observed' ? '第三方报告' : '公开完成声明',
    note: record.sourceType === 'observed' ? '依据第三方观测，个人额度以账户为准。' : '依据公开完成消息，个人到账以账户为准。'
  };
}
Page(createPage((data, query, page, app) => {
  if (!data) return { name: '模钥重置雷达', latest: null, completions: [], pending: null, forecast: null, recent: [], activity: null, sharePath: '', timeline: null, posterPath: '', posterDescription: '' };
  const states = homeStateCards(data);
  const selectedResetKind=validKind(page.selectedResetKind||query.kind);
  const selected=states.cards.find(card=>card.kind===selectedResetKind);
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
    lastReset: recentMessage(selectedResetKind==='banked_reset'?states.lastCard:states.lastReset),
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
    recent: m.homeNewsGroups(data).map(group=>{
      const card=m.publicationCard(data,group.latest),summary=group.observation;
      return summary?{...card,id:summary.id,title:summary.title,summary:summary.summary,time:summary.date,label:'观测汇总',
        note:'按北京时间汇总来源依据，不按来源数计算重置次数。',updates:summary.sources,progressLabel:'查看来源依据'}:card;
    }),
    recentDays: m.calendarModel(data).recentDays, sharePath: selected.sharePath, shareTitle: selected.shareTitle,
    shareLabel: '分享这条公告给朋友',
    historical: data.articles.length > 0 && data.articles.every(article => m.isHistoricalArticle(article, data.evidence))
  };
}, { view:()=>({view:'home'}), load(query) { this.setData({selectedResetKind:validKind(query.kind)}); }, data: { name: '模钥重置雷达', freshnessOpen: false, motionActive: false }, show() { this.setData({motionActive: true}); }, afterRender() { this.queueCalendarPrefetch(); this.syncCountdown(); this.syncForecastExpiry(); }, hide() { this.setData({motionActive: false}); this.cancelCalendarPrefetch(); this.stopCountdown(); this.stopForecastExpiry(); }, unload() { this.setData({motionActive: false}); this.cancelCalendarPrefetch(); this.stopCountdown(); this.stopForecastExpiry(); }, methods: {
  queueCalendarPrefetch() {
    if(!this.data.connected || this.data.snapshotPending || this.data.loading || this.data.error || this._calendarPrefetched || this._calendarPrefetchTimer || !getApp().client.prefetchCalendar)return;
    this._calendarPrefetchTimer=setTimeout(()=>{this._calendarPrefetchTimer=null;if(this._visible){this._calendarPrefetched=true;void getApp().client.prefetchCalendar();}},800);
  },
  cancelCalendarPrefetch() { if(this._calendarPrefetchTimer)clearTimeout(this._calendarPrefetchTimer);this._calendarPrefetchTimer=null; },
  toggleFreshness() { this.setData({ freshnessOpen: !this.data.freshnessOpen }); },
  currentHomeStatus() { const state=getApp().client.getState();if(!state.data||state.snapshotPending)return null;const now=new Date(Date.parse(state.data.serverTime)+Math.max(0,Date.now()-(state.receivedAt||Date.now()))).toISOString();return selectedHomeStatus(state.data,this.data.selectedResetKind,now); },
  openPoster() { if(this.data.snapshotPending){wx.showToast({title:'核对最新消息后可分享',icon:'none'});return;}const card=this.data.connected&&this.currentHomeStatus();if(card)wx.navigateTo({url:'/packages/poster/index?kind='+card.kind+'&revision='+encodeURIComponent(card.revision),fail(){wx.showToast({title:'海报页面加载失败，请重试。',icon:'none'});} }); },
  syncCountdown() {
    if (!this.data.lastReset && !this.data.resetCards?.some(card=>['scheduled','revised','overdue'].includes(card.state)||(card.kind===this.data.selectedResetKind&&['completed','observed'].includes(card.state))) && !(this.data.pending && this.data.pending.counting) && !(this.data.timeline && (this.data.timeline.completed || this.data.timeline.scheduled))) { this.stopCountdown(); return; }
    if (!this._countdownTimer) this._countdownTimer = setInterval(() => this.tickCountdown(), 1000);
  },
  tickCountdown() {
    if(!this._visible)return;
    const state=getApp().client.getState();if(!state.data)return;
    if(state.snapshotPending&&(Date.now()<state.receivedAt||Date.now()-state.receivedAt>=86400000)){this.redraw();this.stopCountdown();return;}
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
    if(!state.data){this.stopForecastExpiry();return;}
    const now=Date.parse(state.data.serverTime)+Math.max(0,Date.now()-state.receivedAt);
    const dates=(this.data.resetCards||[]).map(card=>card.validUntil).filter(Boolean);
    if(forecasts?.referenceCadence?.status==='ready')dates.push(forecasts.referenceCadence.validUntil);
    if (forecasts?.watch && forecasts.watch.status==='active' && forecasts.watch.signal) dates.push(forecasts.watch.signal.expiresAt);
    const next=dates.map(Date.parse).filter(at=>Number.isFinite(at)&&at>now).sort((a,b)=>a-b)[0];
    if (!next) { this.stopForecastExpiry(); return; }
    if (this._forecastExpiryAt===next && this._forecastExpiryTimer) return;
    this.stopForecastExpiry();this._forecastExpiryAt=next;
    // One boundary update, not a new polling or per-second rendering loop.
    this._forecastExpiryTimer=setTimeout(()=>{this._forecastExpiryTimer=null;this.tickForecastExpiry();if(this._visible&&this._lastBoundaryRefreshAt!==next&&dates.some(at=>Date.parse(at)===next)&&typeof getApp().client.refresh==='function'){this._lastBoundaryRefreshAt=next;Promise.resolve(getApp().client.refresh(false)).catch(()=>{});}},Math.min(2147483647,Math.max(1,next-now+20)));
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
    const states=homeStateCards(data,now),patch={};
    for(const [key,value] of Object.entries({resetCards:states.cards,untypedSignal:states.untyped,stateWarning:states.sourceWarning,signalExpiredNote:states.expiredNote}))if(JSON.stringify(this.data[key])!==JSON.stringify(value))patch[key]=value;
    const selected=states.cards.find(card=>card.kind===validKind(this.data.selectedResetKind));
    for(const [key,value] of Object.entries({shareTitle:selected.shareTitle,sharePath:selected.sharePath}))if(this.data[key]!==value)patch[key]=value;
    const history=recentMessage(this.data.selectedResetKind==='banked_reset'?states.lastCard:states.lastReset);
    if(!history||!this.data.lastReset){if(JSON.stringify(history)!==JSON.stringify(this.data.lastReset))patch.lastReset=history;}
    else for(const [key,value] of Object.entries(history))if(value!==this.data.lastReset[key])patch['lastReset.'+key]=value;
    return patch;
  },
  selectResetKind(event) { const kind=event.currentTarget.dataset.kind;if(['automatic_reset','banked_reset'].includes(kind)){this.setData({selectedResetKind:kind,expandedSourceKind:''});this.tickCountdown();this.syncCountdown();} },
  openStatusEvidence(event) {
    const kind=event.currentTarget.dataset.kind,card=kind==='untyped'?this.data.untypedSignal:this.data.resetCards.find(item=>item.kind===kind);
    if(!card)return;
    if(card.observationSummaryDate){wx.navigateTo({url:'/pages/schedule/index?date='+encodeURIComponent(card.observationSummaryDate)+'&kind='+card.kind});return;}
    if(card.expiredRound||card.state==='waiting'&&!card.publicationId){wx.switchTab({url:'/pages/announcements/index'});return;}
    if(card.completedDisplay&&card.publicationId){wx.navigateTo({url:'/pages/detail/index?publicationId='+encodeURIComponent(card.publicationId),fail(){wx.showToast({title:'记录加载失败，请重试',icon:'none'});}});return;}
    if(card.sourceName){this.setData({expandedSourceKind:this.data.expandedSourceKind===kind?'':kind});return;}
    if(card.publicationId)wx.navigateTo({url:'/pages/detail/index?publicationId='+encodeURIComponent(card.publicationId)});
    else wx.switchTab({url:'/pages/news/index'});
  },
  openLastReset() { if(this.data.lastReset?.publicationId)wx.navigateTo({url:'/pages/detail/index?publicationId='+encodeURIComponent(this.data.lastReset.publicationId),fail(){wx.showToast({title:'消息详情加载失败，请重试',icon:'none'});}}); },
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
  onShareAppMessage() { const card=this.currentHomeStatus();return {title:card?.shareTitle||'模钥重置雷达',path:card?.sharePath||'/pages/home/index'}; }
} }));
