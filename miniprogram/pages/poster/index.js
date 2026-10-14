const {createPage}=require('../../utils/page');
const {statusPosterInput,statusPosterAvailable,renderStatusPoster}=require('../../utils/status-poster');
const poster=require('../../utils/poster');
const {privacyRequired}=require('../../utils/wechat');
function canvasNode(page){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('海报画布暂未准备好，请重试。')),10000);try{wx.createSelectorQuery().in(page).select('#status-poster-canvas').fields({node:true},result=>{clearTimeout(timer);result&&result.node?resolve(result.node):reject(new Error('海报画布暂不可用。'));}).exec();}catch(_){clearTimeout(timer);reject(new Error('海报画布暂不可用。'));}});}
function stop(page){page._active=false;page._generation=(page._generation||0)+1;if(page._codeRequest)page._codeRequest.abort();}
Page(createPage(data=>({available:!!data}),{
  view:()=>({view:'home'}),
  data:{available:false,theme:'precision',preview:'',posterBusy:false,posterSaving:false,posterError:'',codeNote:'',blocked:'',privacyNeeded:false},
  show(){this._active=true;if(this._snapshot&&!this.data.preview)void this.generate();},hide(){stop(this);},unload(){stop(this);},
  afterRender(){
    const state=getApp().client.getState(),data=state.data;
    if(this._snapshot&&data&&!statusPosterAvailable(this._snapshot,data)){this._artifact=null;this.setData({preview:'',blocked:'这条公开记录已不可分享，请返回首页重新生成。'});return;}
    if(this._active&&!this.data.navigationLoading&&data&&!this._snapshot){this._snapshot=statusPosterInput({...data,serverTime:new Date(Date.parse(data.serverTime)+Math.max(0,Date.now()-state.receivedAt)).toISOString()});void this.generate();}
  },
  methods:{
    selectTheme(event){const theme=event.currentTarget.dataset.theme;if(!['precision','editorial'].includes(theme)||theme===this.data.theme)return;this.setData({theme});void this.generate();},
    async generate(){
      if(!this._active||!this._snapshot||this.data.blocked)return;
      if(this._codeRequest)this._codeRequest.abort();
      const generation=(this._generation||0)+1;this._generation=generation;
      const current=()=>this._active&&generation===this._generation,theme=this.data.theme;let asset;
      this._artifact=null;this.setData({posterBusy:true,posterError:'',preview:'',codeNote:''});
      try{
        if(this._snapshot.publicationId){
          try{this._codeRequest=getApp().publicApi(`/api/v1/wechat/code/${encodeURIComponent(this._snapshot.publicationId)}`);const response=await this._codeRequest.promise;if(!current())return;asset=await poster.writeCodeAsset(wx,response.data,this._snapshot.publicationId);}
          catch(error){if(!current())return;if([404,409,410].includes(error.status))throw error;this.setData({codeNote:'小程序码暂不可用，已生成无圆码版。'});}
        }else this.setData({codeNote:'暂无关联公告，本张海报不带小程序码。'});
        if(!current())return;const canvas=await canvasNode(this);if(!current())return;
        const work=()=>current()?renderStatusPoster({wxApi:wx,canvas,page:this,input:this._snapshot,theme,code:asset,isCurrent:current}):null;
        this._renderQueue=(this._renderQueue||Promise.resolve()).catch(()=>{}).then(work);
        const artifact=await this._renderQueue;
        if(current()&&artifact){this._artifact=artifact;this.setData({preview:artifact.tempFilePath});}
      }catch(error){if(current())this.setData({posterError:error.message||'海报生成失败，请重试。'});}
      finally{if(asset)await asset.dispose();if(current())this.setData({posterBusy:false});}
    },
    previewImage(){if(this.data.preview)wx.previewImage({current:this.data.preview,urls:[this.data.preview]});},
    async save(){
      if(!this._artifact||this.data.posterSaving||!statusPosterAvailable(this._snapshot,getApp().client.getState().data))return;
      this.setData({posterSaving:true,posterError:'',privacyNeeded:false});
      try{if(await privacyRequired(wx)){this.setData({privacyNeeded:true});return;}await poster.savePoster(wx,this._artifact,{userInitiated:true});wx.showToast({title:'已保存到相册',icon:'success'});}
      catch(error){this.setData({posterError:error.message||'保存失败，请重试。'});}
      finally{this.setData({posterSaving:false});}
    },
    openPrivacyContract(){if(typeof wx.openPrivacyContract==='function')wx.openPrivacyContract({fail(){wx.showToast({title:'隐私指引暂不可用',icon:'none'});}});},
    onShareAppMessage(){return{title:this._snapshot?this._snapshot.title:'模钥重置雷达',path:this._snapshot&&this._snapshot.publicationId?`/pages/detail/index?publicationId=${encodeURIComponent(this._snapshot.publicationId)}`:'/pages/home/index'};}
  }
}));
