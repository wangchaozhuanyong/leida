const { createPage } = require('../../utils/page');
const m = require('../../utils/model');
const {resetObservations}=require('../../utils/reset-observations');
Page(createPage((data, query, page) => {
  if (!data) return { items: [], count: 0, hasMore: false };
  const all = page.category === 'reset' ? m.sortedStatePublications(data).filter(item=>(item.event.actions.length>0 && (page.kind==='all'||item.event.actions.some(action=>action.kind===page.kind)) || ['all','automatic_reset'].includes(page.kind)&&resetObservations(data).some(o=>o.publicationId===item.id))) : m.publicNewsGroups(data).filter(group => page.category === 'all' || group.category === page.category);
  return { items: all.map(item => page.category === 'reset' ? ({...m.publicationCard(data,item),...(resetObservations(data).some(o=>o.publicationId===item.id)?{label:'来源观测',summary:'第三方已观测到额度重置，实际额度以账户显示为准。'}:{})}) : ({...m.publicationCard(data, item.latest), id:item.id, label:item.incident ? '服务状态' : m.publicationCard(data,item.latest).label, updates:item.updates.filter(p=>p.id!==item.latest.id).map(p=>({id:p.id,title:p.article.title,time:m.displayTime(m.publicationSourceTime(p)),path:m.sharePath(p)}))})), count: page.pagination?.total ?? all.length, hasMore: !!page.pagination?.nextCursor };
}, { preserveReading:true, view:(query,page)=>({view:page.category==='reset'?'history':'news',filter:page.category==='reset'?page.kind:page.category}), title:page=>page.connected?`动态 · 共${page.count}${page.category==='reset'?'个事件':'篇'}`:'动态', data: { kind:'all', kinds:[{value:'all',label:'全部'},{value:'automatic_reset',label:'额度重置'},{value:'banked_reset',label:'重置卡'}], category: 'all', limit: 10, items: [], count: 0, hasMore: false, categories: [{ value: 'all', label: '全部' }, { value: 'reset', label: '重置' }, { value: 'activity', label: '活动' }, { value: 'product', label: '产品' }] }, methods: {
  selectCategory(event) { this.setData({ category: event.currentTarget.dataset.value, limit: 10 }); this.reloadView(); },
  selectKind(event) { this.setData({kind:event.currentTarget.dataset.value});this.reloadView(); },
  more() { void getApp().client.more(); }
} }));
