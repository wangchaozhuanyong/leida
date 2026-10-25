const { createPage } = require('../../utils/page');
const { activityModel } = require('../../utils/model');
Page(createPage((data, query, page) => data ? { activity: activityModel(data, query.id, page.day) } : { activity: null }, { view:query=>({view:'activity',id:query.id}), data: { day: null, activity: null, rulesOpen:false },
  load(query){const day=Number(query.day);if(Number.isInteger(day)&&day>0)this.setData({day});},
  show(){if(!this._dayTimer)this._dayTimer=setInterval(()=>{if(this._visible)this.redraw();},60000);},
  hide(){if(this._dayTimer)clearInterval(this._dayTimer);this._dayTimer=null;},
  unload(){if(this._dayTimer)clearInterval(this._dayTimer);this._dayTimer=null;},
  methods: {
  selectDay(event) { const day=Number(event.currentTarget.dataset.day);if(!Number.isInteger(day)||day<1||day>this.data.activity?.days.length||day===this.data.activity?.selected)return;this.setData({ day });this.redraw(); },
  adjacentDay(event){const day=this.data.activity?.selected+Number(event.currentTarget.dataset.step);this.selectDay({currentTarget:{dataset:{day}}});},
  today(){this.setData({day:null});this.redraw();},
  toggleRules(){this.setData({rulesOpen:!this.data.rulesOpen});}
} }));
