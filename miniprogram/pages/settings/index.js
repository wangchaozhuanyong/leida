const { createPage } = require('../../utils/page');
const { noticeModel } = require('../../utils/model');
// Bundled client version; keep this aligned with the development-tool upload.
const buildVersion = '1.0.5';
Page(createPage((data, query, page, app) => {
  const stored=app.preferences.snapshot(),notices=data?noticeModel(data,stored.preferences,stored.read):[];
  return { notices:notices.slice(0,3),unread:notices.filter(n=>!n.read).length,storageError:stored.error };
}, { view:()=>({view:'notices'}),data: { notices:[],unread:0,closeMessage:'',storageError: '', clientVersion:buildVersion, wechat:{label:'点击后连接微信提醒',busy:false,ready:false,canPrepare:true,canRevoke:false,error:'',privacyNeeded:false} },
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
  openNotice(event){const notice=this.data.notices.find(n=>n.id===event.currentTarget.dataset.id);if(!notice)return;getApp().preferences.markRead([notice.id]);this.redraw();const url=notice.origin==='admin'?`/pages/notices/index?id=${encodeURIComponent(notice.id)}`:notice.path;if(url)wx.navigateTo({url});},
  prepareWechat(){if(getApp().wechat)void getApp().wechat.prepare({userInitiated:true});},
  authorizeWechat(){if(getApp().wechat)void getApp().wechat.authorize({userInitiated:true});},
  refreshWechat(){if(getApp().wechat)void getApp().wechat.refresh({userInitiated:true});},
  async revokeWechat(){const reader=getApp().wechat;if(!reader)return;await reader.revoke({userInitiated:true});if(reader.getState().safe?.state==='revoked')this.setData({closeMessage:'微信提醒已关闭'});},
  agreeWechatPrivacy(){void this.revokeWechat();},
  openPrivacyContract(){if(typeof wx.openPrivacyContract==='function')wx.openPrivacyContract({fail(){wx.showToast({title:'隐私指引暂不可用',icon:'none'});}});}
} }));
