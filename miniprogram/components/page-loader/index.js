Component({
  properties:{variant:{type:String,value:'list'},inset:Boolean},
  data:{visible:false},
  lifetimes:{
    attached(){this._attached=true;this._showTimer=setTimeout(()=>{this._showTimer=null;if(this._attached)this.setData({visible:true});},180);},
    detached(){this._attached=false;if(this._showTimer!=null)clearTimeout(this._showTimer);this._showTimer=null;}
  }
});
