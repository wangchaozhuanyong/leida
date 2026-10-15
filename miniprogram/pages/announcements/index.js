const { createPage } = require('../../utils/page');
const m = require('../../utils/model');
Page(createPage((data, query, page) => {
  if (!data) return { items: [], count: 0, hasMore: false };
  const all = m.sortedStatePublications(data).filter(item => item.event.actions.length && (page.filter === 'all' || item.event.actions.some(action => action.kind === page.filter)));
  return { items: all.map((item,index) => {const month=m.dateKey(m.publicationSourceTime(item)).slice(0,7);return {...m.publicationCard(data,item),month:!index||month!==m.dateKey(m.publicationSourceTime(all[index-1])).slice(0,7)?month.replace('-','年')+'月':''};}), count: page.pagination?.total ?? all.length, hasMore: !!page.pagination?.nextCursor };
}, { preserveReading:true, view:(query,page)=>({view:'history',filter:page.filter}), title:page=>page.connected?`重置公告 · ${page.count}个事件`:'重置公告', data: { filter: 'all', limit: 10, count: 0, items: [], hasMore: false, filters: [{ value: 'all', label: '全部' }, { value: 'automatic_reset', label: '用量重置' }, { value: 'banked_reset', label: '重置卡' }] }, methods: {
  selectFilter(event) { this.setData({ filter: event.currentTarget.dataset.value, limit: 10 }); this.reloadView(); },
  more() { void getApp().client.more(); }
} }));
