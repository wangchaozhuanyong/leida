const { createPage } = require('./page');
const { recordCalendar } = require('./record-calendar');
const kinds = [{value:'all',label:'全部'},{value:'automatic_reset',label:'额度重置'},{value:'banked_reset',label:'重置卡'}];
function createRecordPage(back = false) {
  return createPage((data, query, page) => data ? recordCalendar(data,{date:page.selected,kind:page.kind,recentLimit:page.recentLimit}) : {}, {
    view:()=>({view:'calendar'}), title:()=> '重置记录',
    data:{calendarBack:back,recordNotesOpen:false,expandedRecord:'',kind:'all',kinds,selected:'',selectedItems:[],recentRecords:[],recentLimit:10,recentTotal:0,recentHasMore:false,days:[],months:[],monthIndex:0},
    load(query) { if (query.date) this.setData({selected:query.date});if(kinds.some(k=>k.value===query.kind))this.setData({kind:query.kind}); },
    methods:{
      toggleRecordNotes() { this.setData({recordNotesOpen:!this.data.recordNotesOpen}); },
      toggleRecordSources(event) {const id=event.currentTarget.dataset.id;if([...this.data.selectedItems,...this.data.recentRecords].some(r=>r.id===id&&r.sources.length>1))this.setData({expandedRecord:this.data.expandedRecord===id?'':id});},
      selectDay(event) { const date=event.currentTarget.dataset.date;if(this.data.days.some(day=>day.date===date&&!day.disabled)){this.setData({selected:date});this.redraw();} },
      selectKind(event) { const kind=event.currentTarget.dataset.value;if(kind!==this.data.kind&&kinds.some(item=>item.value===kind)){this.setData({kind,recentLimit:10});this.redraw();} },
      moreRecords() { if(this.data.recentHasMore){this.setData({recentLimit:this.data.recentLimit+10});this.redraw();} },
      selectMonth(event) { this.moveToMonth(Number(event.detail.value)); },
      previousMonth() { this.moveToMonth(this.data.monthIndex+1); },
      nextMonth() { this.moveToMonth(this.data.monthIndex-1); },
      moveToMonth(index) { const month=this.data.months[index];if(!month)return;const data=getApp().client.getState().data;if(!data)return;const next=recordCalendar(data,{kind:this.data.kind,month:month.value});this.setData({selected:next.selected});this.redraw(); },
      recentRecord() { if(this.data.recentDate){this.setData({selected:this.data.recentDate});this.redraw();} }
    }
  });
}
module.exports={createRecordPage};
