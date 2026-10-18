const { createPage } = require('../../utils/page');
const { noticeModel } = require('../../utils/model');
// Bundled client version; keep this aligned with the development-tool upload.
const buildVersion = '1.0.37';
Page(createPage((data, query, page, app) => {
  const stored=app.preferences.snapshot(),notices=data?noticeModel(data,stored.preferences,stored.read):[];
  return { notices:notices.slice(0,3),unread:notices.filter(n=>!n.read).length,storageError:stored.error };
}, { view:()=>({view:'notices'}),data: { notices:[],unread:0,storageError: '', clientVersion:buildVersion, wechat:{safe:null,label:'加载中',busy:true,ready:false,canPrepare:false,canRevoke:false,error:'',privacyNeeded:false} },
  load(){
    try {
      const info=typeof wx.getAccountInfoSync==='function' ? wx.getAccountInfoSync().miniProgram : null;
      const channel=info && ({develop:'开发版',trial:'体验版',release:'正式版'})[info.envVersion];
      if(channel)this.setData({clientVersion:`${buildVersion} · ${channel}`});
    }catch(_){ /* Version information is optional and never blocks settings. */ }
  },
  show(){const reader=getApp().wechat;if(reader){this._wechatUnsubscribe=reader.subscribe(state=>{const patch={};for(const key of Object.keys(state))if(JSON.stringify(this.data.wechat?.[key])!==JSON.stringify(state[key]))patch['wechat.'+key]=state[key];if(Object.keys(patch).length)this.setData(patch);});void this.loadWechat();}},
  hide(){if(this._wechatUnsubscribe)this._wechatUnsubscribe();this._wechatUnsubscribe=null;clearTimeout(this._wechatRefreshTimer);this._wechatRefreshTimer=null;},
  unload(){if(this._wechatUnsubscribe)this._wechatUnsubscribe();this._wechatUnsubscribe=null;clearTimeout(this._wechatRefreshTimer);this._wechatRefreshTimer=null;},
  methods: {
  openNotice(event){const notice=this.data.notices.find(n=>n.id===event.currentTarget.dataset.id);if(!notice)return;getApp().preferences.markRead([notice.id]);this.redraw();const url=notice.origin==='admin'?`/pages/notices/index?id=${encodeURIComponent(notice.id)}`:notice.path;if(url)wx.navigateTo({url});},
  async loadWechat(){
    clearTimeout(this._wechatRefreshTimer);
    const reader=getApp().wechat;if(!reader)return;
    await reader.loadForPage();
    clearTimeout(this._wechatRefreshTimer);
    if(this._visible&&!reader.getState().privacyNeeded)this._wechatRefreshTimer=setTimeout(()=>void this.loadWechat(),reader.nextRefreshDelay());
  },
  addWechat(){
    this._wechatPrivacyAction='add';const reader=getApp().wechat;if(!reader)return;const state=reader.getState();if(state.busy)return;
    // Keep the WeChat prompt synchronous with this tap; page entry has prepared it.
    if(!state.ready&&!state.confirmNeeded)return this.loadWechat();
    const work=state.confirmNeeded?reader.retryConfirmation({userInitiated:true}):reader.authorize({userInitiated:true});
    return work.then(()=>{if(this._visible&&!reader.getState().error)return this.loadWechat();});
  },
  async revokeWechat(){this._wechatPrivacyAction='close';const reader=getApp().wechat;if(reader){await reader.revoke({userInitiated:true});if(this._visible&&!reader.getState().privacyNeeded&&!reader.getState().error)await this.loadWechat();}},
  changeWechatPreference(event){
    const key=event.currentTarget.dataset.kind,reader=getApp().wechat;
    if(!reader||!['announcement','result','correction'].includes(key)||typeof event.detail?.value!=='boolean')return;
    const state=reader.getState();if(!state.canChooseTypes)return;
    return this.saveWechatPreferences({...state.reminderPreferences,[key]:event.detail.value});
  },
  async saveWechatPreferences(preferences){
    this._wechatPrivacyAction='preferences';this._wechatPendingPreferences=preferences;
    const reader=getApp().wechat;if(!reader)return;
    await reader.savePreferences(preferences,{userInitiated:true});
    if(!reader.getState().privacyNeeded)this._wechatPendingPreferences=null;
  },
  agreeWechatPrivacy(){if(this._wechatPrivacyAction==='close')return this.revokeWechat();if(this._wechatPrivacyAction==='preferences'&&this._wechatPendingPreferences)return this.saveWechatPreferences(this._wechatPendingPreferences);return this.loadWechat();},
  openPrivacyContract(){if(typeof wx.openPrivacyContract==='function')wx.openPrivacyContract({fail(){wx.showToast({title:'隐私指引暂不可用',icon:'none'});}});}
} }));
