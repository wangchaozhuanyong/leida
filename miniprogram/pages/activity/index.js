const { createPage } = require('../../utils/page');
const { activityModel } = require('../../utils/model');
Page(createPage((data, query, page) => data ? { activity: activityModel(data, query.id, page.day) } : { activity: null }, { view:(query,page)=>({view:'activity',id:query.id,day:page.day}), data: { day: null, activity: null }, methods: {
  selectDay(event) { this.setData({ day: Number(event.currentTarget.dataset.day) }); this.reloadView(); }
} }));
