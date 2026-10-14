const { createPage } = require('../../utils/page');
// Bundled client version; keep this aligned with the development-tool upload.
const buildVersion = '1.0.3';
const labels = [{ key: 'announcement', title: '发放预告', description: '明确的重置或发卡安排' }, { key: 'result', title: '完成声明', description: '公告称重置或发卡已完成' }, { key: 'activity', title: '活动进展', description: '关联活动与产品更新' }, { key: 'correction', title: '重要更正', description: '资格、状态变更或内容撤回' }];
Page(createPage((data, query, page, app) => {
  const stored = app.preferences.snapshot();
  return { choices: labels.map(item => ({ ...item, checked: stored.preferences[item.key] })), storageError: stored.error };
}, { data: { choices: [], storageError: '', clientVersion:buildVersion, wechat:{label:'点击后连接微信提醒',busy:false,ready:false,canPrepare:true,canRevoke:false,error:'',privacyNeeded:false} },
  load(){
    try {
      const info=typeof wx.getAccountInfoSync==='function' ? wx.getAccountInfoSync().miniProgram : null;
      const channel=info && ({develop:'开发版',trial:'体验版',release:'正式版'})[info.envVersion];
      if(channel)this.setData({clientVersion:`${buildVersion} · ${channel}`});
    }catch(_){ /* Version information is optional and never blocks settings. */ }
  },
  show(){if(getApp().wechat)this._wechatUnsubscribe=getApp().wechat.subscribe(state=>this.setData({wechat:state}));},
  hide(){if(this._wechatUnsubscribe)this._wechatUnsubscribe();this._wechatUnsubscribe=null;},
  unload(){if(this._wechatUnsubscribe)this._wechatUnsubscribe();this._wechatUnsubscribe=null;},
  methods: {
  changePreference(event) { getApp().preferences.set(event.currentTarget.dataset.key, event.detail.value); this.redraw(); },
  prepareWechat(){if(getApp().wechat)void getApp().wechat.prepare({userInitiated:true});},
  authorizeWechat(){if(getApp().wechat)void getApp().wechat.authorize({userInitiated:true});},
  refreshWechat(){if(getApp().wechat)void getApp().wechat.refresh({userInitiated:true});},
  revokeWechat(){if(getApp().wechat)void getApp().wechat.revoke({userInitiated:true});},
  agreeWechatPrivacy(){this.prepareWechat();},
  openPrivacyContract(){if(typeof wx.openPrivacyContract==='function')wx.openPrivacyContract({fail(){wx.showToast({title:'隐私指引暂不可用',icon:'none'});}});}
} }));
