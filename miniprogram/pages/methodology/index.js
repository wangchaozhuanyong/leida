const m = require('../../utils/model');
const rules = [{ title: '预告与完成分别判断', text: '明确承诺显示发放预告；对应完成声明显示“公告称已完成”。预计时间到期只显示等待确认。' }, { title: '用量重置与重置卡分开记录', text: '不同福利动作可以处于不同状态；定向补偿和私人结转不计入普发次数。' }, { title: '新闻不等于发放依据', text: '可准确复述的消息可以独立收录，但证据不足时不改变福利状态和次数。' }, { title: '同一件事不重复计数', text: '重复采集、多个回复与措辞更新不会生成一次新的发放；日程中同一福利动作只计一次。' }, { title: '历史与更正保留版本', text: '补录旧消息标为历史收录。撤回、合并和重要更正有说明，分享固定对应发布版本。' }, { title: '个人是否到账未观测', text: '公开声明不能证明你的账户已到账，个人到账状态保持未观测。' }];
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(value);
Page({
  data: { rules, fixed: false, forecast: null, reference: null, outcomes: null, fixedLoading: false, fixedError: '', currentUnavailable: '尚未读取预测资料。', cardNote: '重置卡缺少可比样本，暂不显示概率；个人到账未观测。' },
  onLoad(params) {
    this._snapshotId = params && params.snapshot || '';
    this._visible = true;
    this.setData({ fixed: !!this._snapshotId });
    if (this._snapshotId && !validId(this._snapshotId)) this.setData({ fixedError: '预测记录链接无效，请返回查看判断规则。' });
    else if (this._snapshotId) void this.loadFixed();
  },
  onShow() {
    this._visible = true;
    const app = getApp();
    if(app.client.setView)void app.client.setView({view:'methodology'});
    this._unsubscribe = app.client.subscribe(state => {
      this._latestState = state;
      if (this._snapshotId) { this.updateOutcomes(); return; }
      const data = state.data;
      const current = data ? { ...data, serverTime: new Date(Date.parse(data.serverTime) + Math.max(0, Date.now() - state.receivedAt)).toISOString() } : null;
      const forecast = !state.error && current ? m.currentForecast(current) : null;
      this.setData({ forecast, reference: current ? m.forecastReferenceModel(current.forecasts) : null, currentUnavailable: state.error ? '当前预测资料暂时无法读取，请稍后重试。' : !current || !current.forecasts ? '尚未接入实验预测。' : current.forecasts.status === 'unavailable' ? '预测资料暂不可用。' : '暂无可展示的当前实验预测；明确公告优先。' });
      this.updateOutcomes();
    });
    if (validId(this._snapshotId) && !this.data.forecast && !this.data.fixedLoading && !this.data.fixedError) void this.loadFixed();
  },
  suspend() {
    this._visible = false;
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
    return { title: this.data.forecast ? `模钥重置雷达：${this.data.forecast.title}` : '模钥重置雷达：判断规则', path: this._snapshotId ? `/pages/methodology/index?snapshot=${encodeURIComponent(this._snapshotId)}` : '/pages/methodology/index' };
  }
});
