const { displayTime } = require('./model');
function setWindowBackground() {
  // iOS has separate native top/bottom backdrops outside the page's CSS surface.
  if (typeof wx.setBackgroundColor !== 'function') return;
  try {
    wx.setBackgroundColor({ backgroundColor: '#0b1113', backgroundColorTop: '#0b1113', backgroundColorBottom: '#0b1113', fail() {} });
  } catch (_) { /* An unavailable appearance API must never block page data. */ }
}
function createPage(build, extra = {}) {
  function render(page, state) {
    const data = state.data;
    const clockData = data ? { ...data, serverTime: new Date(Date.parse(data.serverTime) + Math.max(0, Date.now() - state.receivedAt)).toISOString() } : null;
    const cutoff = data && data.publications.reduce((latest, item) => item.cutoffAt > latest ? item.cutoffAt : latest, '');
    const pagination=state.page||null;
    page.setData({ loading: state.loading, connected: !!data, unconfigured: state.unconfigured, error: state.error, cutoff: displayTime(cutoff), pagination, ...(build(clockData, page._params || {}, {...page.data,pagination}, getApp()) || {}) });
    if(extra.title&&typeof wx.setNavigationBarTitle==='function'){
      const title=extra.title(page.data);
      if(title&&title!==page._navigationTitle){page._navigationTitle=title;wx.setNavigationBarTitle({title});}
    }
    if (extra.afterRender) extra.afterRender.call(page);
  }
  return {
    data: { loading: false, connected: false, unconfigured: false, error: '', cutoff: '暂无记录', ...(extra.data || {}) },
    onLoad(params) { setWindowBackground(); this._params = params || {}; if (extra.load) extra.load.call(this, params || {}); },
    onShow() { setWindowBackground(); const app = getApp(); if(app.client.setView)void app.client.setView(this.readView()); this._unsubscribe = app.client.subscribe(state => render(this, state)); if (extra.show) extra.show.call(this); },
    onHide() { if (this._unsubscribe) this._unsubscribe(); this._unsubscribe = null; if(extra.hide)extra.hide.call(this); },
    onUnload() { if (this._unsubscribe) this._unsubscribe(); this._unsubscribe = null; if(extra.unload)extra.unload.call(this); },
    async onPullDownRefresh() { try { await getApp().client.refresh(false); } finally { wx.stopPullDownRefresh(); } },
    readView() { return extra.view ? extra.view(this._params||{},this.data) : {view:'home'}; },
    reloadView() { const client=getApp().client; if(client.setView)void client.setView(this.readView());else this.redraw(); },
    retry() { void getApp().client.refresh(false); },
    redraw() { render(this, getApp().client.getState()); },
    navigate(event) {
      const path = event.currentTarget.dataset.path;
      if (typeof path !== 'string' || !/^\/pages\/(home|settings|announcements|news|schedule|detail|activity|notices|methodology|privacy)\/index(?:\?|$)/.test(path)) return;
      const route = path.split('?')[0];
      if (['/pages/home/index', '/pages/settings/index', '/pages/news/index', '/pages/announcements/index'].includes(route)) wx.switchTab({ url: route });
      else wx.navigateTo({ url: path });
    },
    ...(extra.methods || {})
  };
}
module.exports = { createPage };
