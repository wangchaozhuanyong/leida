const { createPage } = require('../../utils/page');
const { noticeModel } = require('../../utils/model');
// Bundled client version; keep this aligned with the development-tool upload.
const buildVersion = '1.0.41';
Page(createPage((data, query, page, app) => {
  const stored=app.preferences.snapshot(),notices=data?noticeModel(data,stored.preferences,stored.read):[];
  return { notices:notices.slice(0,3),unread:notices.filter(n=>!n.read).length,storageError:stored.error };
}, { view:()=>({view:'notices'}),data: { settingsReady:false,wechatAction:'',notices:[],unread:0,storageError: '', clientVersion:buildVersion, wechat:{safe:null,label:'加载中',busy:true,ready:false,canPrepare:false,canRevoke:false,error:'',privacyNeeded:false} },
  load(){
    try {
      const info=typeof wx.getAccountInfoSync==='function' ? wx.getAccountInfoSync().miniProgram : null;
      const channel=info && ({develop:'开发版',trial:'体验版',release:'正式版'})[info.envVersion];
      if(channel)this.setData({clientVersion:`${buildVersion} · ${channel}`});
    }catch(_){ /* Version information is optional and never blocks settings. */ }
  },
  afterRender(){this.revealSettings();},
  show(){
    const reader=getApp().wechat;
    if(!reader){this._wechatSettled=true;this.setData({'wechat.busy':false,'wechat.error':'微信提醒暂时无法读取，请重新打开小程序。'});this.revealSettings();return;}
    this._wechatUnsubscribe=reader.subscribe(state=>{
      const displayed={...state};
      // Keep the tapped native switch in place while saving; an uncertain result
      // then restores the last confirmed choice through an actual checked change.
      if(this.data.wechatAction==='preferences'&&state.busy&&this._wechatPendingPreferences)displayed.reminderPreferences=this._wechatPendingPreferences;
      const patch={};for(const key of Object.keys(displayed))if(JSON.stringify(this.data.wechat?.[key])!==JSON.stringify(displayed[key]))patch['wechat.'+key]=displayed[key];
      this._wechatSettled=!state.busy&&!state.refreshing&&!!(state.safe||state.error||state.privacyNeeded);
      if(this.settingsCanReveal())patch.settingsReady=true;
      if(Object.keys(patch).length)this.setData(patch);
    });
    void this.loadWechat();
  },
  hide(){if(this._wechatUnsubscribe)this._wechatUnsubscribe();this._wechatUnsubscribe=null;clearTimeout(this._wechatRefreshTimer);this._wechatRefreshTimer=null;},
  unload(){if(this._wechatUnsubscribe)this._wechatUnsubscribe();this._wechatUnsubscribe=null;clearTimeout(this._wechatRefreshTimer);this._wechatRefreshTimer=null;},
  methods: {
  contactError(){wx.showToast({title:'客服会话暂不可用，请稍后重试',icon:'none'});},
  settingsCanReveal(){return !this.data.settingsReady&&this._wechatSettled&&!!(this.data.connected||this.data.error||this.data.unconfigured);},
  revealSettings(){if(this.settingsCanReveal())this.setData({settingsReady:true});},
  runWechatAction(action,work){
    this.setData({wechatAction:action});
    // Invoke work synchronously so WeChat subscription still belongs to the tap.
    let pending;try{pending=work();}catch(error){this.setData({wechatAction:''});throw error;}
    return Promise.resolve(pending).finally(()=>this.setData({wechatAction:''}));
  },
  openNotice(event){const notice=this.data.notices.find(n=>n.id===event.currentTarget.dataset.id);if(!notice)return;getApp().preferences.markRead([notice.id]);this.redraw();const url=notice.origin==='admin'?`/pages/notices/index?id=${encodeURIComponent(notice.id)}`:notice.path;if(url)wx.navigateTo({url});},
  async loadWechat(){
    clearTimeout(this._wechatRefreshTimer);
    const reader=getApp().wechat;if(!reader)return;
    await reader.loadForPage();
    clearTimeout(this._wechatRefreshTimer);
    if(this._visible&&!reader.getState().privacyNeeded)this._wechatRefreshTimer=setTimeout(()=>void this.loadWechat(),reader.nextRefreshDelay());
  },
  addWechat(){
    const reader=getApp().wechat;if(!reader)return;const state=reader.getState();if(state.busy||this.data.wechatAction)return;
    this._wechatPrivacyAction='add';
    // Keep the WeChat prompt synchronous with this tap; page entry has prepared it.
    if(!state.ready&&!state.confirmNeeded)return this.runWechatAction('reload',()=>this.loadWechat());
    return this.runWechatAction('add',()=>{
      const work=state.confirmNeeded?reader.retryConfirmation({userInitiated:true}):reader.authorize({userInitiated:true});
      return work.then(()=>{if(this._visible&&!reader.getState().error)return this.loadWechat();});
    });
  },
  revokeWechat(){
    const reader=getApp().wechat;if(!reader||reader.getState().busy||this.data.wechatAction)return;
    this._wechatPrivacyAction='close';
    return this.runWechatAction('revoke',async()=>{await reader.revoke({userInitiated:true});if(this._visible&&!reader.getState().privacyNeeded&&!reader.getState().error)await this.loadWechat();});
  },
  changeWechatPreference(event){
    const key=event.currentTarget.dataset.kind,reader=getApp().wechat;
    if(!reader||!['announcement','result','correction'].includes(key)||typeof event.detail?.value!=='boolean')return;
    const state=reader.getState();if(!state.canChooseTypes||this.data.wechatAction)return;
    return this.saveWechatPreferences({...state.reminderPreferences,[key]:event.detail.value});
  },
  saveWechatPreferences(preferences){
    const reader=getApp().wechat;if(!reader||reader.getState().busy||this.data.wechatAction)return;
    this._wechatPrivacyAction='preferences';this._wechatPendingPreferences=preferences;
    return this.runWechatAction('preferences',async()=>{
      await reader.savePreferences(preferences,{userInitiated:true});
      if(!reader.getState().privacyNeeded)this._wechatPendingPreferences=null;
    });
  },
  agreeWechatPrivacy(){if(this._wechatPrivacyAction==='close')return this.revokeWechat();if(this._wechatPrivacyAction==='preferences'&&this._wechatPendingPreferences)return this.saveWechatPreferences(this._wechatPendingPreferences);return this.loadWechat();},
  openPrivacyContract(){if(typeof wx.openPrivacyContract==='function')wx.openPrivacyContract({fail(){wx.showToast({title:'隐私指引暂不可用',icon:'none'});}});}
} }));
