const { createPage } = require('../../utils/page');
const { noticeModel } = require('../../utils/model');
Page(createPage((data, query, page, app) => {
  const setting = app.preferences.snapshot();
  const notices = data ? noticeModel(data, setting.preferences, setting.read) : [];
  return { selected:query.id?notices.find(n=>n.id===query.id)||null:null,detailMode:!!query.id,notices, unread: notices.filter(item => !item.read).length, storageError: setting.error };
}, { view:()=>({view:'notices'}), data: { notices: [], unread: 0, storageError: '' }, methods: {
  markAll() { getApp().preferences.markRead(this.data.notices.map(item => item.id)); this.redraw(); },
  openNotice(event) { const notice = this.data.notices.find(item => item.id === event.currentTarget.dataset.id); if (!notice || notice.origin!=='admin'&&!notice.path) return; getApp().preferences.markRead([notice.id]); this.redraw(); wx.navigateTo({ url: notice.origin==='admin'?`/pages/notices/index?id=${encodeURIComponent(notice.id)}`:notice.path }); }
} }));
