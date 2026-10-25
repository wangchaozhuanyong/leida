const { createPage } = require('./page');
const { recordCalendar } = require('./record-calendar');
const kinds = [{value:'all',label:'全部'},{value:'automatic_reset',label:'额度重置'},{value:'banked_reset',label:'重置卡'}];
function createRecordPage(back = false) {
  return createPage((data, query, page) => data ? recordCalendar(data,{date:page.selected,kind:page.kind}) : {}, {
    view:()=>({view:'calendar'}), title:()=> '重置记录',
    data:{calendarBack:back,recordNotesOpen:false,kind:'all',kinds,selected:'',selectedItems:[],recentRecords:[],days:[],months:[],monthIndex:0},
    load(query) { if (query.date) this.setData({selected:query.date}); },
    methods:{
      toggleRecordNotes() { this.setData({recordNotesOpen:!this.data.recordNotesOpen}); },
      selectDay(event) { const date=event.currentTarget.dataset.date;if(this.data.days.some(day=>day.date===date&&!day.disabled)){this.setData({selected:date});this.redraw();} },
      selectKind(event) { const kind=event.currentTarget.dataset.value;if(kinds.some(item=>item.value===kind)){this.setData({kind});this.redraw();} },
      selectMonth(event) { this.moveToMonth(Number(event.detail.value)); },
      previousMonth() { this.moveToMonth(this.data.monthIndex+1); },
      nextMonth() { this.moveToMonth(this.data.monthIndex-1); },
      moveToMonth(index) { const month=this.data.months[index];if(!month)return;const data=getApp().client.getState().data;if(!data)return;const next=recordCalendar(data,{kind:this.data.kind,month:month.value});this.setData({selected:next.selected});this.redraw(); },
      recentRecord() { if(this.data.recentDate){this.setData({selected:this.data.recentDate});this.redraw();} }
    }
  });
}
module.exports={createRecordPage};
