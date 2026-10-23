const {enterPage,suspendEntry,preserveNativeReturn}=require('../../utils/entry-navigation');
Page({
  onShow(){enterPage(this,()=>this.onShow());},
  onHide(){suspendEntry(this);},
  onUnload(){suspendEntry(this,true);},
  nativeReturnTouched(){getApp().entryNavigation?.touched();},
  openPrivacyContract(){
    if(typeof wx.openPrivacyContract!=='function'){wx.showToast({title:'请更新微信后查看',icon:'none'});return;}
    const guard=preserveNativeReturn();
    try{wx.openPrivacyContract({fail(){guard.cancel();wx.showToast({title:'隐私指引暂不可用',icon:'none'});}});}catch(_){guard.cancel();}
  }
});
