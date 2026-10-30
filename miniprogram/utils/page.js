const { displayTime } = require('./model');
const {enterPage,suspendEntry,preserveNativeReturn}=require('./entry-navigation');
// The native pull surface belongs to one gesture, not to the network request.
// An old page's timer/finally must never close a newer page's gesture.
let activePull = null;
let lastShownPage = null;
function endPull(page, gesture = activePull) {
  if (!gesture || gesture.page !== page || activePull !== gesture) return;
  clearTimeout(gesture.timer);
  activePull = null;
  if (page.data.pullRefreshing) page.setData({ pullRefreshing:false });
  try { if (typeof wx.stopPullDownRefresh === 'function') wx.stopPullDownRefresh({ fail() {} }); }
  catch (_) { /* Native feedback cannot block data or navigation. */ }
}
function setWindowBackground() {
  // iOS has separate native top/bottom backdrops outside the page's CSS surface.
  if (typeof wx === 'undefined' || typeof wx.setBackgroundColor !== 'function') return;
  try {
    wx.setBackgroundColor({ backgroundColor: '#f2f5fb', backgroundColorTop: '#f2f5fb', backgroundColorBottom: '#f2f5fb', fail() {} });
  } catch (_) { /* An unavailable appearance API must never block page data. */ }
}
function createPage(build, extra = {}) {
  function stopEntrance(page) {
    if(page._entranceTimer)clearTimeout(page._entranceTimer);
    page._entranceTimer=null;
    if(page.data.contentMotion)page.setData({contentMotion:''});
  }
  function entrance(page, patch) {
    // Content is committed immediately. Motion never waits for a timer or network.
    if(!patch.connected||(extra.presentable&&!extra.presentable.call(page,patch))){
      if(page._entranceTimer)clearTimeout(page._entranceTimer);
      page._entranceTimer=null;
      patch.contentMotion='';
      return;
    }
    const key=page._viewKey||'home';
    const seen=page._presentedViews||(page._presentedViews=new Set());
    if(seen.has(key))return;
    seen.add(key);
    if(seen.size>20)seen.delete(seen.values().next().value);
    if(page._entranceTimer)clearTimeout(page._entranceTimer);
    // The old page is primed while hidden, before native tab presentation resumes.
    patch.contentMotion='content-enter';
    page._entranceTimer=setTimeout(()=>{
      page._entranceTimer=null;
      if(page._visible&&page._viewKey===key)page.setData({contentMotion:''});
    },1000);
  }
  function foreground(page, work) {
    const generation=(page._navigationGeneration||0)+1;page._navigationGeneration=generation;
    // Request state, rather than navigation, owns the content loader.
    const finish=()=>{if(page._visible&&generation===page._navigationGeneration){if(page.data.navigationLoading)page.setData({navigationLoading:false});if(extra.afterRender)extra.afterRender.call(page);}};
    const pending=typeof work==='function'?work():work;
    if(pending&&typeof pending.then==='function')return Promise.resolve(pending).catch(()=>{}).finally(finish);
    finish();
  }
  function render(page, state) {
    const data = state.data;
    const elapsed=Date.now()-state.receivedAt;
    const clockUntrusted=!!state.snapshotPending&&(!Number.isFinite(elapsed)||elapsed<0||elapsed>=86400000);
    const clockData = data&&!clockUntrusted ? { ...data, serverTime: new Date(Date.parse(data.serverTime) + Math.max(0, elapsed)).toISOString() } : null;
    const cutoff = data && data.publications.reduce((latest, item) => item.cutoffAt > latest ? item.cutoffAt : latest, '');
    const pagination=state.page||null;
    const patch={ snapshotPending:!!state.snapshotPending,clockUntrusted,snapshotReadAt:state.snapshotPending?displayTime(new Date(state.receivedAt).toISOString()):'',navigationLoading: !data && !!state.loading, initialLoading: !data && !!state.loading, refreshing: !!data && !!state.loading && !state.loadingMore, loadingMore: !!state.loadingMore, moreError: state.moreError || '', updateAvailable: !!state.updateAvailable, loading: state.loading, connected: !!data&&!clockUntrusted, unconfigured: state.unconfigured, error: state.error, cutoff: displayTime(cutoff), pagination, ...(build(clockData, page._params || {}, {...page.data,pagination}, getApp()) || {}) };
    if(extra.title)patch.navigationTitle=extra.title({...page.data,...patch}) || '';
    const generation=(page._renderGeneration||0)+1;page._renderGeneration=generation;
    const current=()=>page._visible&&generation===page._renderGeneration;
    const measure=callback=>{
      try { const query=typeof page.createSelectorQuery==='function'?page.createSelectorQuery():wx.createSelectorQuery().in(page);
        query.selectAll('.reading-item').boundingClientRect();query.selectViewport().scrollOffset();query.exec(callback);
      } catch (_) { callback(null); }
    };
    const commit=before=>{
      if(!current())return;
      const anchor=before?.[0]?.find(rect=>rect.bottom>0&&patch.items?.some(item=>item.id===rect.dataset.readingId));
      page._renderedData=data;
      entrance(page,patch);
      const changed=Object.fromEntries(Object.entries(patch).filter(([key,value])=>JSON.stringify(page.data[key])!==JSON.stringify(value)));
      const afterCommit=()=>{
        if(current() && data && page._restoreScroll!==undefined && typeof wx.pageScrollTo==='function'){
          const scrollTop=page._restoreScroll;page._restoreScroll=undefined;wx.pageScrollTo({scrollTop,duration:0});return;
        }
        if(!anchor||!current()||page.data.navigationLoading)return;
        measure(after=>{
          if(!current()||!after?.[0]||!after[1]||!before[1]||Math.abs(after[1].scrollTop-before[1].scrollTop)>4)return;
          const rect=after[0].find(item=>item.dataset.readingId===anchor.dataset.readingId);
          if(rect)wx.pageScrollTo({scrollTop:Math.max(0,after[1].scrollTop+rect.top-anchor.top),duration:0});
        });
      };
      if(Object.keys(changed).length)page.setData(changed,afterCommit);else afterCommit();
      if(extra.title&&typeof wx.setNavigationBarTitle==='function'){
        const title=patch.navigationTitle;
        if(title&&title!==page._navigationTitle){page._navigationTitle=title;wx.setNavigationBarTitle({title});}
      }
      if (extra.afterRender) extra.afterRender.call(page);
    };
    if(extra.preserveReading&&data&&page._renderedData&&data!==page._renderedData&&!page.data.navigationLoading&&typeof wx.createSelectorQuery==='function'&&typeof wx.pageScrollTo==='function')measure(commit);
    else commit(null);

  }
  return {
    data: { contentMotion:'', pullRefreshing:false, navigationLoading:true, loading: true, connected: false, unconfigured: false, error: '', cutoff: '暂无记录', ...(extra.data || {}) },
    onLoad(params) { setWindowBackground(); this._params = params || {}; if (extra.load) extra.load.call(this, params || {}); },
    // Keep native appearance setup on initial load. Retained tabs only need to
    // resume their subscriptions; their background is also declared in page-meta.
    onShow() { if(enterPage(this,()=>this.onShow()))return;const app=getApp();this._visible=true;this._viewKey=JSON.stringify(this.readView());if(lastShownPage!==this){const previous=lastShownPage;if(previous&&!previous._visible&&!previous._unloaded&&previous.data.connected)previous.setData({contentMotion:'content-primed'});this._presentedViews?.delete(this._viewKey);}lastShownPage=this;const work=app.client.setView&&app.client.setView(this.readView());this._unsubscribe = app.client.subscribe(state => render(this, state));if(extra.show)extra.show.call(this);foreground(this,work); },
    nativeReturnTouched(){getApp().entryNavigation?.touched();},
    onPageScroll(event) { if(this._viewKey){this._positions=this._positions||{};this._positions[this._viewKey]=event.scrollTop;} },
    onHide() { endPull(this);this._pullRefreshWork=null;stopEntrance(this);suspendEntry(this);this._visible=false;this._renderGeneration=(this._renderGeneration||0)+1;this._navigationGeneration=(this._navigationGeneration||0)+1;if (this._unsubscribe) this._unsubscribe(); this._unsubscribe = null; if(extra.hide)extra.hide.call(this); },
    onUnload() { this._unloaded=true;endPull(this);this._pullRefreshWork=null;stopEntrance(this);suspendEntry(this,true);this._visible=false;this._navigationGeneration=(this._navigationGeneration||0)+1;if (this._unsubscribe) this._unsubscribe(); this._unsubscribe = null; if(extra.unload)extra.unload.call(this); },
    onPullDownRefresh() {
      if (!this._visible) return Promise.resolve();
      if (activePull?.page === this) return activePull.work;
      if (activePull) {
        clearTimeout(activePull.timer);
        if (activePull.page.data.pullRefreshing) activePull.page.setData({ pullRefreshing:false });
      }
      const gesture = { page:this, timer:null, work:null };
      activePull = gesture;
      this.setData({ pullRefreshing:true });
      // Keep the native pull area until this refresh settles. The header's
      // fixed title masks the native dots, so mirror dots only in that gap.
      // Navigation and background refresh never enable this gesture flag.
      // Independent of the request deadline: a stalled SDK cannot pin the page.
      gesture.timer = setTimeout(() => endPull(this, gesture), 12000);
      let work = this._pullRefreshWork;
      if (!work) {
        try { work = foreground(this, () => getApp().client.refresh(false)); }
        catch (_) { work = Promise.resolve(); }
      }
      const settled = Promise.resolve(work).finally(() => {
        if (this._pullRefreshWork === settled) this._pullRefreshWork = null;
        endPull(this, gesture);
      });
      this._pullRefreshWork = gesture.work = settled;
      return settled;
    },
    readView() { return extra.view ? extra.view(this._params||{},this.data) : {view:'home'}; },
    reloadView() { this._viewKey=JSON.stringify(this.readView());this._restoreScroll=this._positions?.[this._viewKey]||0;const client=getApp().client; if(client.setView)return foreground(this,()=>client.setView(this.readView()));this.redraw(); },
    applyUpdates() { const client=getApp().client;if(client.applyUpdates)client.applyUpdates(); },
    retry() { return foreground(this,()=>getApp().client.refresh(false)); },
    redraw() { render(this, getApp().client.getState()); },
    navigate(event) {
      const path = event.currentTarget.dataset.path;
      if (typeof path !== 'string' || !/^\/pages\/(home|settings|announcements|news|schedule|detail|activity|notices|methodology|privacy|poster)\/index(?:\?|$)/.test(path)) return;
      const route = path.split('?')[0];
      if (['/pages/home/index', '/pages/settings/index', '/pages/news/index', '/pages/announcements/index'].includes(route)) wx.switchTab({ url: route });
      else wx.navigateTo({ url: path });
    },
    ...(extra.methods || {}),
    ...(typeof extra.methods?.onShareAppMessage==='function'?{
      onShareAppMessage(...args) {
        // The native share sheet can restore the original launch scene. Preserve
        // this page once, just as for native image/authorization windows.
        const guard=preserveNativeReturn();
        try{return extra.methods.onShareAppMessage.apply(this,args);}
        catch(error){guard.cancel();throw error;}
      }
    }:{})
  };
}
module.exports = { createPage };
