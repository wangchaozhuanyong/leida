// Keep old saved paths usable without exposing the developer replay UI.
Page({
  onLoad() { this.openRecords(); },
  openRecords() { wx.switchTab({ url: '/pages/announcements/index' }); }
});
