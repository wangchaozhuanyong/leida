const { createPage } = require('../../utils/page');
const m = require('../../utils/model');
const {resetNewsRecords}=require('../../utils/record-calendar');
Page(createPage((data, query, page) => {
  if (!data) return { items: [], count: 0, hasMore: false };
  if(page.category==='reset'){
    const all=resetNewsRecords(data,page.kind);
    const items=all.slice(0,page.limit).map(({id,at,publication,fact})=>{
      const card={...m.publicationCard(data,publication),id,time:m.displayTime(at)};
      if(!fact)return card;
      if(fact.evidenceType==='confirmed')return {...card,label:fact.kind==='banked_reset'?'重置卡发放':'额度重置',note:'完成确认'};
      return {...card,label:'来源观测',title:fact.title,summary:fact.summary||'已观测到额度重置，实际额度以账户显示为准。',note:fact.evidenceCount>1?`最早观测 · ${fact.evidenceCount}条来源报告`:fact.sourceName,
        progressLabel:'查看来源依据',updates:fact.sources.map(source=>({id:source.id,title:source.title,time:source.time,path:source.path}))};
    });
    return {items,count:all.length,hasMore:items.length<all.length};
  }
  const all=m.publicNewsGroups(data).filter(group => page.category === 'all' || group.category === page.category);
  return { items: all.map(item => ({...m.publicationCard(data, item.latest), id:item.id, label:item.incident ? '服务状态' : m.publicationCard(data,item.latest).label, updates:item.updates.filter(p=>p.id!==item.latest.id).map(p=>({id:p.id,title:p.article.title,time:m.displayTime(m.publicationSourceTime(p)),path:m.sharePath(p)}))})), count: page.pagination?.total ?? all.length, hasMore: !!page.pagination?.nextCursor };
}, { preserveReading:true, deferAdditions:true, afterRender(){this.queueCategoryPrefetch();}, hide(){this._categoryPrefetchKey='';}, view:(query,page)=>page.category==='reset'?({view:'calendar'}):({view:'news',filter:page.category}), title:page=>page.connected?`动态 · 共${page.count}${page.category==='reset'?'条动态':'篇'}`:'动态', data: { kind:'all', kinds:[{value:'all',label:'全部'},{value:'automatic_reset',label:'额度重置'},{value:'banked_reset',label:'重置卡'}], category: 'all', limit: 10, items: [], count: 0, hasMore: false, categories: [{ value: 'all', label: '全部' }, { value: 'reset', label: '重置' }, { value: 'activity', label: '活动' }, { value: 'product', label: '产品' }] }, methods: {
  queueCategoryPrefetch() {
    const key=this.data.category+':'+this.data.kind,client=getApp().client;
    if(!this._visible||!this.data.connected||this.data.snapshotPending||this.data.loading||this.data.error||this._categoryPrefetchKey===key||!client.prefetchNewsViews)return;
    this._categoryPrefetchKey=key;client.prefetchNewsViews();
  },
  selectCategory(event) { const category=event.currentTarget.dataset.value;if(category===this.data.category||!this.data.categories.some(item=>item.value===category))return;this.setData({category,limit:10});this.reloadView(); },
  selectKind(event) { const kind=event.currentTarget.dataset.value;if(kind===this.data.kind||!this.data.kinds.some(item=>item.value===kind))return;this.setData({kind,limit:10});this.redraw(); },
  more() { if(this.data.category==='reset'){this.setData({limit:this.data.limit+20});this.redraw();return;}void getApp().client.more(); }
} }));
