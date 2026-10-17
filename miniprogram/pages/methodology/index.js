const m = require('../../utils/model');
const { cadenceModel, cadenceSnapshotId, validateCadenceSnapshot } = require('../../utils/cadence');
const horizonRows = (data, id) => (data && data.cadenceHorizonOutcomes || []).filter(row => id ? row.snapshotId === id : Object.values(data.cadenceByKind || {}).some(snapshot=>snapshot.id===row.snapshotId)).map(row => ({ id:row.id, label:row.target==='banked_reset'?'重置卡发放':'用量重置', horizon:row.horizonHours, result:row.result==='occurred'?'已找到对应公开动态':row.result==='not_occurred'?'覆盖已核验，未发现对应动态':'暂不能判断', end:m.displayTime(row.windowEnd), actual:row.actualAt?m.displayTime(row.actualAt):'', note:row.scorable?'已加入可评分记录':'资料不完整或消息晚采，未计入预测成绩' }));
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(value);
Page({
  data: { navigationLoading: true, fixed: false, forecast: null, reference: null, outcomes: null, fixedLoading: false, fixedError: '', currentUnavailable: '暂无观察记录。', showCadenceStats:false },
  onLoad(params) {
    this._cadenceId = params && params.cadence || '';
    this._snapshotId = this._cadenceId || params && params.snapshot || '';
    this._visible = true;
    this.setData({ fixed: !!this._snapshotId, isCadence:!!this._cadenceId, target:params && params.target==='banked_reset'?'banked_reset':'automatic_reset' });
    if (this._snapshotId && !(this._cadenceId ? cadenceSnapshotId(this._snapshotId) : validId(this._snapshotId))) this.setData({ fixedError: '记录链接无效，请返回查看其他记录。' });
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
      const cadenceHistory=current && current.forecasts && current.forecasts.cadenceHistory || [];
      const evaluation=current && current.forecasts && current.forecasts.cadenceEvaluationByKind;
      this.setData({ cadenceData:current && current.forecasts || null, cadenceNow:current && current.serverTime || '', cadenceHistory:cadenceHistory.slice(0,8).map(row=>({id:row.id,label:row.target==='banked_reset'?'重置卡发放':row.target==='automatic_reset'?'用量重置':'历史混合模型',time:m.displayTime(row.generatedAt)})), evaluations:evaluation?['automatic_reset','banked_reset'].filter(key=>evaluation[key]).map(key=>({target:key,label:key==='banked_reset'?'重置卡发放':'用量重置',samples:evaluation[key].maturedSamples,positive:evaluation[key].positiveSamples,unknown:evaluation[key].unknownSamples})):[], forecast, reference: current ? m.forecastReferenceModel(current.forecasts) : null, currentUnavailable: state.error ? '观察记录暂时无法加载，请稍后重试。' : !current || !current.forecasts ? '暂时没有可展示的观察记录。' : current.forecasts.status === 'unavailable' ? '观察记录暂时无法加载，请稍后重试。' : '暂无可展示的当前实验预测；明确公告优先。' });
      this.updateOutcomes();
    });
    void Promise.resolve(work).catch(()=>{}).finally(()=>{
      if(this._visible && this._navigationGeneration === generation)this.setData({ navigationLoading:false });
    });
    if (validId(this._snapshotId) && !this.data.forecast && !this.data.cadenceSnapshot && !this.data.fixedLoading && !this.data.fixedError) void this.loadFixed();
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
    this.setData({ horizonRecords:this._snapshotId&&!this._cadenceId?[]:horizonRows(data,this._cadenceId||undefined) });
    const snapshot = this._snapshotId ? this._fixedSnapshot : data && this.data.forecast && data.cases.find(item => item.snapshot && item.snapshot.id === this.data.forecast.id)?.snapshot;
    this.setData({ outcomes: snapshot ? m.forecastOutcomeModel(snapshot, data) : null });
  },
  async loadFixed() {
    if (!(this._cadenceId ? cadenceSnapshotId(this._snapshotId) : validId(this._snapshotId)) || this.data.fixedLoading) return;
    const epoch = this._fixedEpoch = (this._fixedEpoch || 0) + 1;
    this._fixedSnapshot = null;
    this.setData({ fixedLoading: true, fixedError: '', forecast: null, reference: null, outcomes: null });
    try {
      this._fixedTask = getApp().publicApi(`/api/v1/forecasts/${this._cadenceId?'cadence/':''}${this._snapshotId}`);
      const result = await this._fixedTask.promise;
      if (epoch !== this._fixedEpoch || !this._visible) return;
      if(this._cadenceId){
        const snapshot=result.data;
        if(!validateCadenceSnapshot(snapshot) || snapshot.id!==this._snapshotId)throw new Error('预测记录格式不完整，请稍后重新读取。');
        const view=cadenceModel(null,snapshot.generatedAt,snapshot.target||'automatic_reset',snapshot);
        this.setData({ cadenceSnapshot:snapshot,cadenceNow:snapshot.generatedAt,cadenceNote:view.legacy?'此旧记录仅用于复盘，不作为当前预测。':'这份记录固定保留生成时的概率和窗口，后续资料不会重写。' });
        return;
      }
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
  toggleCadenceStats() { this.setData({showCadenceStats:!this.data.showCadenceStats}); },
  openCadence(event) { const id=event.currentTarget.dataset.id;if(cadenceSnapshotId(id))wx.navigateTo({url:`/pages/methodology/index?cadence=${encodeURIComponent(id)}`}); },
  openReplay() { wx.navigateTo({url:'/pages/replay/index'}); },
  openForecast() { const forecast = this.data.forecast; if (forecast) wx.navigateTo({ url: forecast.path }); },
  copySignal() { const url = this.data.forecast && this.data.forecast.url; if (url) wx.setClipboardData({ data: url }); },
  onShareAppMessage() {
    return { title: this.data.forecast ? `模钥重置雷达：${this.data.forecast.title}` : '模钥重置雷达：观察记录', path: this._snapshotId ? `/pages/methodology/index?${this._cadenceId?'cadence':'snapshot'}=${encodeURIComponent(this._snapshotId)}` : '/pages/methodology/index' };
  }
});
