const { displayTime } = require('./model');
function setWindowBackground() {
  // iOS has separate native top/bottom backdrops outside the page's CSS surface.
  if (typeof wx === 'undefined' || typeof wx.setBackgroundColor !== 'function') return;
  try {
    wx.setBackgroundColor({ backgroundColor: '#0b1113', backgroundColorTop: '#0b1113', backgroundColorBottom: '#0b1113', fail() {} });
  } catch (_) { /* An unavailable appearance API must never block page data. */ }
}
function createPage(build, extra = {}) {
  function foreground(page, work) {
    const generation=(page._navigationGeneration||0)+1;page._navigationGeneration=generation;
    page.setData({navigationLoading:true});
    const finish=()=>{if(page._visible&&generation===page._navigationGeneration){page.setData({navigationLoading:false});if(extra.afterRender)extra.afterRender.call(page);}};
    const pending=typeof work==='function'?work():work;
    if(pending&&typeof pending.then==='function')return Promise.resolve(pending).catch(()=>{}).finally(finish);
    finish();
  }
  function render(page, state) {
    const data = state.data;
    const clockData = data ? { ...data, serverTime: new Date(Date.parse(data.serverTime) + Math.max(0, Date.now() - state.receivedAt)).toISOString() } : null;
    const cutoff = data && data.publications.reduce((latest, item) => item.cutoffAt > latest ? item.cutoffAt : latest, '');
    const pagination=state.page||null;
    const patch={ loading: state.loading, connected: !!data, unconfigured: state.unconfigured, error: state.error, cutoff: displayTime(cutoff), pagination, ...(build(clockData, page._params || {}, {...page.data,pagination}, getApp()) || {}) };
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
      page.setData(patch,()=>{
        if(!anchor||!current()||page.data.navigationLoading)return;
        measure(after=>{
          if(!current()||!after?.[0]||!after[1]||!before[1]||Math.abs(after[1].scrollTop-before[1].scrollTop)>4)return;
          const rect=after[0].find(item=>item.dataset.readingId===anchor.dataset.readingId);
          if(rect)wx.pageScrollTo({scrollTop:Math.max(0,after[1].scrollTop+rect.top-anchor.top),duration:0});
        });
      });
      if(extra.title&&typeof wx.setNavigationBarTitle==='function'){
        const title=extra.title(page.data);
        if(title&&title!==page._navigationTitle){page._navigationTitle=title;wx.setNavigationBarTitle({title});}
      }
      if (extra.afterRender) extra.afterRender.call(page);
    };
    if(extra.preserveReading&&data&&page._renderedData&&data!==page._renderedData&&!page.data.navigationLoading&&typeof wx.createSelectorQuery==='function'&&typeof wx.pageScrollTo==='function')measure(commit);
    else commit(null);

  }
  return {
    data: { navigationLoading:true, loading: false, connected: false, unconfigured: false, error: '', cutoff: '暂无记录', ...(extra.data || {}) },
    onLoad(params) { setWindowBackground(); this._params = params || {}; if (extra.load) extra.load.call(this, params || {}); },
    onShow() { setWindowBackground();this._visible=true;this.setData({navigationLoading:true});const app = getApp();const work=app.client.setView&&app.client.setView(this.readView());this._unsubscribe = app.client.subscribe(state => render(this, state));if(extra.show)extra.show.call(this);foreground(this,work); },
    onHide() { this._visible=false;this._renderGeneration=(this._renderGeneration||0)+1;this._navigationGeneration=(this._navigationGeneration||0)+1;this.setData({navigationLoading:true});if (this._unsubscribe) this._unsubscribe(); this._unsubscribe = null; if(extra.hide)extra.hide.call(this); },
    onUnload() { this._visible=false;this._navigationGeneration=(this._navigationGeneration||0)+1;if (this._unsubscribe) this._unsubscribe(); this._unsubscribe = null; if(extra.unload)extra.unload.call(this); },
    async onPullDownRefresh() { try { await foreground(this,()=>getApp().client.refresh(false)); } finally { wx.stopPullDownRefresh(); } },
    readView() { return extra.view ? extra.view(this._params||{},this.data) : {view:'home'}; },
    reloadView() { const client=getApp().client; if(client.setView)return foreground(this,()=>client.setView(this.readView()));this.redraw(); },
    retry() { return foreground(this,()=>getApp().client.refresh(false)); },
    redraw() { render(this, getApp().client.getState()); },
    navigate(event) {
      const path = event.currentTarget.dataset.path;
      if (typeof path !== 'string' || !/^\/pages\/(home|settings|announcements|news|schedule|detail|activity|notices|methodology|privacy|poster)\/index(?:\?|$)/.test(path)) return;
      const route = path.split('?')[0];
      if (['/pages/home/index', '/pages/settings/index', '/pages/news/index', '/pages/announcements/index'].includes(route)) wx.switchTab({ url: route });
      else wx.navigateTo({ url: path });
    },
    ...(extra.methods || {})
  };
}
module.exports = { createPage };
