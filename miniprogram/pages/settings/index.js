const { createPage } = require('../../utils/page');
const { noticeModel } = require('../../utils/model');
// Bundled client version; keep this aligned with the development-tool upload.
const buildVersion = '1.0.8';
Page(createPage((data, query, page, app) => {
  const stored=app.preferences.snapshot(),notices=data?noticeModel(data,stored.preferences,stored.read):[];
  return { notices:notices.slice(0,3),unread:notices.filter(n=>!n.read).length,storageError:stored.error };
}, { view:()=>({view:'notices'}),data: { notices:[],unread:0,storageError: '', clientVersion:buildVersion, wechat:{label:'点击后连接微信提醒',busy:false,ready:false,canPrepare:true,canRevoke:false,error:'',privacyNeeded:false} },
  load(){
    try {
      const info=typeof wx.getAccountInfoSync==='function' ? wx.getAccountInfoSync().miniProgram : null;
      const channel=info && ({develop:'开发版',trial:'体验版',release:'正式版'})[info.envVersion];
      if(channel)this.setData({clientVersion:`${buildVersion} · ${channel}`});
    }catch(_){ /* Version information is optional and never blocks settings. */ }
  },
  show(){const reader=getApp().wechat;if(reader){this._wechatUnsubscribe=reader.subscribe(state=>this.setData({wechat:state}));if(reader.refreshConnected){void reader.refreshConnected();if(typeof setInterval==='function')this._wechatRefreshTimer=setInterval(()=>void reader.refreshConnected(),30000);}}},
  hide(){if(this._wechatUnsubscribe)this._wechatUnsubscribe();this._wechatUnsubscribe=null;if(typeof clearInterval==='function')clearInterval(this._wechatRefreshTimer);this._wechatRefreshTimer=null;},
  unload(){if(this._wechatUnsubscribe)this._wechatUnsubscribe();this._wechatUnsubscribe=null;if(typeof clearInterval==='function')clearInterval(this._wechatRefreshTimer);this._wechatRefreshTimer=null;},
  methods: {
  openNotice(event){const notice=this.data.notices.find(n=>n.id===event.currentTarget.dataset.id);if(!notice)return;getApp().preferences.markRead([notice.id]);this.redraw();const url=notice.origin==='admin'?`/pages/notices/index?id=${encodeURIComponent(notice.id)}`:notice.path;if(url)wx.navigateTo({url});},
  prepareWechat(){if(getApp().wechat)void getApp().wechat.prepare({userInitiated:true});},
  authorizeWechat(){if(getApp().wechat)void getApp().wechat.authorize({userInitiated:true});},
  refreshWechat(){if(getApp().wechat)void getApp().wechat.refresh({userInitiated:true});},
  addWechat(){this._wechatPrivacyAction='add';const reader=getApp().wechat;if(!reader)return;const state=reader.getState();if(state.confirmNeeded)void reader.retryConfirmation({userInitiated:true});else if(state.ready)void reader.authorize({userInitiated:true});else void reader.prepare({userInitiated:true});},
  async revokeWechat(){this._wechatPrivacyAction='close';const reader=getApp().wechat;if(reader)await reader.revoke({userInitiated:true});},
  agreeWechatPrivacy(){if(this._wechatPrivacyAction==='close')void this.revokeWechat();else this.addWechat();},
  openPrivacyContract(){if(typeof wx.openPrivacyContract==='function')wx.openPrivacyContract({fail(){wx.showToast({title:'隐私指引暂不可用',icon:'none'});}});}
} }));
