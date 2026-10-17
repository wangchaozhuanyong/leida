const { createPage } = require('../../utils/page');
const m = require('../../utils/model');
Page(createPage((data, query, page) => {
  if (!data) return { items: [], count: 0, hasMore: false };
  const all = page.category === 'reset' ? m.sortedStatePublications(data).filter(item=>item.event.actions.length && (page.kind==='all'||item.event.actions.some(action=>action.kind===page.kind))) : m.sortedArticles(data.articles.filter(item => page.category === 'all' || item.category === page.category)).map(article => data.publications.find(item => item.id === article.publicationId)).filter(Boolean);
  return { items: all.map(item => m.publicationCard(data, item)), count: page.pagination?.total ?? all.length, hasMore: !!page.pagination?.nextCursor };
}, { preserveReading:true, view:(query,page)=>({view:page.category==='reset'?'history':'news',filter:page.category==='reset'?page.kind:page.category}), title:page=>page.connected?`动态 · 共${page.count}${page.category==='reset'?'个事件':'篇'}`:'动态', data: { kind:'all', kinds:[{value:'all',label:'全部'},{value:'automatic_reset',label:'额度重置'},{value:'banked_reset',label:'重置卡'}], category: 'all', limit: 10, items: [], count: 0, hasMore: false, categories: [{ value: 'all', label: '全部' }, { value: 'reset', label: '重置' }, { value: 'activity', label: '活动' }, { value: 'product', label: '产品' }] }, methods: {
  selectCategory(event) { this.setData({ category: event.currentTarget.dataset.value, limit: 10 }); this.reloadView(); },
  selectKind(event) { this.setData({kind:event.currentTarget.dataset.value});this.reloadView(); },
  more() { void getApp().client.more(); }
} }));
