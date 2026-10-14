const { createPage } = require('../../utils/page');
const { calendarModel, dateKey } = require('../../utils/model');
Page(createPage((data, query, page) => data ? calendarModel(data, page.selected || dateKey(data.serverTime)) : {}, { view:()=>({view:'calendar'}), data: { selected: '', selectedItems: [], weeks: [], completedCount: 0 }, load(query) { if (/^\d{4}-\d{2}-\d{2}$/.test(query.date || '')) this.setData({ selected: query.date }); }, methods: {
  selectDay(event) { this.setData({ selected: event.currentTarget.dataset.date }); this.redraw(); }
} }));
