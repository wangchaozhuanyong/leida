const {replayView}=require('../../utils/replay');
Page({
 data:{loading:true,error:'',empty:false,view:null,showStatistics:false},
 onLoad(){this._visible=true;void this.load();},
 onShow(){this._visible=true;if(this._suspended){this._suspended=false;void this.load(this.data.view?.index);}},
 onHide(){this.suspend();},onUnload(){this.suspend();},
 suspend(){this._visible=false;this._suspended=!!this.data.loading;this._epoch=(this._epoch||0)+1;if(this._task)this._task.abort();this._task=null;this.setData({loading:false});},
 async load(index){
  const epoch=this._epoch=(this._epoch||0)+1;if(this._task)this._task.abort();this.setData({loading:true,error:'',empty:false});
  try{
   if(!this._runId){this._task=getApp().publicApi('/api/v1/replays');const result=await this._task.promise;if(!this._visible||epoch!==this._epoch)return;this._runId=result.data[0]?.runId;if(!this._runId){this.setData({empty:true});return;}}
   this._task=getApp().publicApi(`/api/v1/replays/${this._runId}${Number.isSafeInteger(index)?'?step='+index:''}`);
   const result=await this._task.promise;if(this._visible&&epoch===this._epoch)this.setData({view:replayView(result.data)});
  }catch(error){if(this._visible&&epoch===this._epoch)this.setData({error:error.message||'回放暂时无法读取，请稍后重试。'});}
  finally{if(this._visible&&epoch===this._epoch){this._task=null;this.setData({loading:false});}}
 },
 selectStep(event){const index=Number(event.currentTarget.dataset.step);if(Number.isSafeInteger(index)&&index>=0&&index<this.data.view.total)void this.load(index);},
 retry(){void this.load(this.data.view?.index);},
 toggleStatistics(){this.setData({showStatistics:!this.data.showStatistics});}
});
