// Keep old saved paths usable without exposing the developer replay UI.
const {enterPage,suspendEntry}=require('../../utils/entry-navigation');
Page({
  onShow() { if(!enterPage(this,()=>this.openRecords()))this.openRecords(); },
  onHide(){suspendEntry(this);},
  onUnload(){suspendEntry(this,true);},
  openRecords() { wx.switchTab({ url: '/pages/announcements/index' }); }
});
