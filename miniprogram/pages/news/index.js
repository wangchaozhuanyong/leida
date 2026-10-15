const { createPage } = require('../../utils/page');
const m = require('../../utils/model');
Page(createPage((data, query, page) => {
  if (!data) return { items: [], count: 0, hasMore: false };
  const all = m.sortedArticles(data.articles.filter(item => page.category === 'all' || item.category === page.category)).map(article => data.publications.find(item => item.id === article.publicationId)).filter(Boolean);
  return { items: all.map(item => m.publicationCard(data, item)), count: page.pagination?.total ?? all.length, hasMore: !!page.pagination?.nextCursor };
}, { preserveReading:true, view:(query,page)=>({view:'news',filter:page.category}), title:page=>page.connected?`动态 · 共${page.count}篇`:'动态', data: { category: 'all', limit: 10, items: [], count: 0, hasMore: false, categories: [{ value: 'all', label: '全部' }, { value: 'reset', label: '重置' }, { value: 'activity', label: '活动' }, { value: 'product', label: '产品' }] }, methods: {
  selectCategory(event) { this.setData({ category: event.currentTarget.dataset.value, limit: 10 }); this.reloadView(); },
  more() { void getApp().client.more(); }
} }));
