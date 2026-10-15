const m = require('../../utils/model');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(value);
Page({
  data: { navigationLoading: true, fixed: false, forecast: null, reference: null, outcomes: null, fixedLoading: false, fixedError: '', currentUnavailable: '暂无观察记录。' },
  onLoad(params) {
    this._snapshotId = params && params.snapshot || '';
    this._visible = true;
    this.setData({ fixed: !!this._snapshotId });
    if (this._snapshotId && !validId(this._snapshotId)) this.setData({ fixedError: '记录链接无效，请返回查看其他记录。' });
    else if (this._snapshotId) void this.loadFixed();
  },
  onShow() {
    this._visible = true;
    const generation = this._navigationGeneration = (this._navigationGeneration || 0) + 1;

    const app = getApp();
    const work = app.client.setView && app.client.setView({view:'methodology'});
    this._unsubscribe = app.client.subscribe(state => {
      this._latestState = state;
      this.setData({navigationLoading: !state.data && !!state.loading});
      if (this._snapshotId) { this.updateOutcomes(); return; }
      const data = state.data;
      const current = data ? { ...data, serverTime: new Date(Date.parse(data.serverTime) + Math.max(0, Date.now() - state.receivedAt)).toISOString() } : null;
      const forecast = !state.error && current ? m.currentForecast(current) : null;
      this.setData({ forecast, reference: current ? m.forecastReferenceModel(current.forecasts) : null, currentUnavailable: state.error ? '观察记录暂时无法加载，请稍后重试。' : !current || !current.forecasts ? '暂时没有可展示的观察记录。' : current.forecasts.status === 'unavailable' ? '观察记录暂时无法加载，请稍后重试。' : '暂无可展示的当前实验预测；明确公告优先。' });
      this.updateOutcomes();
    });
    void Promise.resolve(work).catch(()=>{}).finally(()=>{
      if(this._visible && this._navigationGeneration === generation)this.setData({ navigationLoading:false });
    });
    if (validId(this._snapshotId) && !this.data.forecast && !this.data.fixedLoading && !this.data.fixedError) void this.loadFixed();
  },
  suspend() {
    this._visible = false;
    this._navigationGeneration = (this._navigationGeneration || 0) + 1;
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
    this._fixedEpoch = (this._fixedEpoch || 0) + 1;
    if (this._fixedTask) this._fixedTask.abort();
    this._fixedTask = null;
    this.setData({ fixedLoading: false });
  },
  onHide() { this.suspend(); },
  onUnload() { this.suspend(); },
  updateOutcomes() {
    const state = this._latestState;
    const data = state && !state.error && state.data && state.data.forecasts;
    const snapshot = this._snapshotId ? this._fixedSnapshot : data && this.data.forecast && data.cases.find(item => item.snapshot && item.snapshot.id === this.data.forecast.id)?.snapshot;
    this.setData({ outcomes: snapshot ? m.forecastOutcomeModel(snapshot, data) : null });
  },
  async loadFixed() {
    if (!validId(this._snapshotId) || this.data.fixedLoading) return;
    const epoch = this._fixedEpoch = (this._fixedEpoch || 0) + 1;
    this._fixedSnapshot = null;
    this.setData({ fixedLoading: true, fixedError: '', forecast: null, reference: null, outcomes: null });
    try {
      this._fixedTask = getApp().publicApi(`/api/v1/forecasts/${this._snapshotId}`);
      const result = await this._fixedTask.promise;
      if (epoch !== this._fixedEpoch || !this._visible) return;
      if (!m.validateForecastSnapshot(result.data) || result.data.id !== this._snapshotId) throw new Error('预测记录格式不完整，请稍后重新读取。');
      // Bootstrap/current cases never replace the immutable snapshot endpoint.
      this._fixedSnapshot = result.data;
      this.setData({ forecast: m.forecastSnapshotModel(result.data, result.data.generatedAt) });
      this.updateOutcomes();
    } catch (error) {
      if (epoch === this._fixedEpoch && this._visible) this.setData({ fixedError: error.message || '这条预测记录暂时无法读取，请稍后重试。', forecast: null });
    } finally {
      if (epoch === this._fixedEpoch && this._visible) { this._fixedTask = null; this.setData({ fixedLoading: false }); }
    }
  },
  retryFixed() { void this.loadFixed(); },
  openForecast() { const forecast = this.data.forecast; if (forecast) wx.navigateTo({ url: forecast.path }); },
  copySignal() { const url = this.data.forecast && this.data.forecast.url; if (url) wx.setClipboardData({ data: url }); },
  onShareAppMessage() {
    return { title: this.data.forecast ? `模钥重置雷达：${this.data.forecast.title}` : '模钥重置雷达：观察记录', path: this._snapshotId ? `/pages/methodology/index?snapshot=${encodeURIComponent(this._snapshotId)}` : '/pages/methodology/index' };
  }
});
