const {preserveNativeReturn}=require('../../utils/entry-navigation');
const {createPage}=require('../../utils/page');
const {statusPosterInput,statusPosterAvailable,renderStatusPoster}=require('./status-poster');
const poster=require('../../utils/poster');
const {privacyRequired}=require('../../utils/wechat');
function canvasNode(page){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('海报画布暂未准备好，请重试。')),10000);try{wx.createSelectorQuery().in(page).select('#status-poster-canvas').fields({node:true},result=>{clearTimeout(timer);result&&result.node?resolve(result.node):reject(new Error('海报画布暂不可用。'));}).exec();}catch(_){clearTimeout(timer);reject(new Error('海报画布暂不可用。'));}});}
function currentData(){const state=getApp().client.getState(),data=state.data;if(!data)return data;const age=Number.isFinite(state.receivedAt)?Math.max(0,Date.now()-state.receivedAt):0;return {...data,serverTime:new Date(Date.parse(data.serverTime)+age).toISOString()};}
function stop(page){clearTimeout(page._stateExpiryTimer);clearTimeout(page._posterTimeout);page._active=false;page._generation=(page._generation||0)+1;if(page._codeRequest)page._codeRequest.abort();}
Page(createPage(data=>({available:!!data}),{
  view:()=>({view:'home'}),
  data:{available:false,theme:'precision',preview:'',posterBusy:false,posterSaving:false,posterError:'',codeNote:'',blocked:'',privacyNeeded:false},
  show(){this._active=true;if(this._snapshot)void this.generate();},hide(){stop(this);},unload(){stop(this);this.clearPosters();this._codeData=null;},
  afterRender(){
    const data=currentData();
    if(this._snapshot&&data&&!statusPosterAvailable(this._snapshot,data)){stop(this);this.clearPosters();this.setData({preview:'',posterBusy:false,blocked:'公开状态已变化，请返回首页重新生成。'});return;}
    if(this._active&&!this.data.navigationLoading&&data&&!this._snapshot){this._snapshot=statusPosterInput(data);void this.generate();}
    clearTimeout(this._stateExpiryTimer);
    if(this._active&&data&&this._snapshot&&this._snapshot.validUntil){const remaining=Date.parse(this._snapshot.validUntil)-Date.parse(data.serverTime);if(remaining>0){this._stateExpiryTimer=setTimeout(()=>this.afterRender(),Math.min(2147483647,remaining+20));this._stateExpiryTimer.unref?.();}}
  },
  methods:{
    clearPosters(){
      const paths=new Set(Object.values(this._artifacts||{}).map(value=>value.artifact.tempFilePath));
      this._artifacts={};this._artifact=null;
      if(typeof wx.getFileSystemManager==='function')for(const filePath of paths)wx.getFileSystemManager().unlink({filePath,success(){},fail(){}});
    },
    selectTheme(event){const theme=event.currentTarget.dataset.theme;if(!['precision','editorial'].includes(theme)||theme===this.data.theme)return;this.setData({theme});void this.generate();},
    async generate(){
      if(!this._active||!this._snapshot||this.data.blocked)return;
      if(!statusPosterAvailable(this._snapshot,currentData())){stop(this);this.clearPosters();this.setData({preview:'',posterBusy:false,blocked:'公开状态已变化，请返回首页重新生成。'});return;}
      if(this._codeRequest)this._codeRequest.abort();clearTimeout(this._posterTimeout);
      const generation=(this._generation||0)+1;this._generation=generation;
      const current=()=>this._active&&generation===this._generation,theme=this.data.theme;let asset;
      this._artifacts=this._artifacts||{};
      const cached=this._artifacts[theme];
      if(cached){this._artifact=cached.artifact;this.setData({preview:cached.artifact.tempFilePath,posterBusy:false,posterError:'',codeNote:cached.note});return;}
      this._artifact=null;this.setData({posterBusy:true,posterError:'',codeNote:''});
      this._posterTimeout=setTimeout(()=>{if(!current())return;stop(this);this._active=true;this.setData({posterBusy:false,posterError:'海报生成超时，请重试。'});},20000);
      try{
        const codePublicationId=this._snapshot.codePublicationId||this._snapshot.publicationId;
        if(codePublicationId){
          try{if(!this._codeData){this._codeRequest=getApp().publicApi(`/api/v1/wechat/code/${encodeURIComponent(codePublicationId)}`);const response=await this._codeRequest.promise;if(!current())return;this._codeData=response.data;}asset=await poster.writeCodeAsset(wx,this._codeData,codePublicationId);}
          catch(error){if(!current())return;if([404,409,410].includes(error.status))throw error;this.setData({codeNote:'微信官方小程序码暂不可用，本张海报未附扫码入口，可直接分享小程序。'});}
        }else this.setData({codeNote:'暂无关联公告，本张海报不带小程序码。'});
        if(!current())return;const canvas=await canvasNode(this);if(!current())return;
        const work=()=>current()?renderStatusPoster({wxApi:wx,canvas,page:this,input:this._snapshot,theme,code:asset,isCurrent:current}):null;
        this._renderQueue=(this._renderQueue||Promise.resolve()).catch(()=>{}).then(work);
        const artifact=await this._renderQueue;
        if(current()&&artifact){this._artifact=artifact;this._artifacts[theme]={artifact,note:this.data.codeNote};this.setData({preview:artifact.tempFilePath});}
      }catch(error){if(current())this.setData({posterError:error.message||'海报生成失败，请重试。'});}
      finally{if(asset)await asset.dispose();if(current()){clearTimeout(this._posterTimeout);this.setData({posterBusy:false});}}
    },
    previewImage(){if(this.data.preview&&!this.data.posterBusy){const guard=preserveNativeReturn();try{wx.previewImage({current:this.data.preview,urls:[this.data.preview],fail:()=>guard.cancel()});}catch(_){guard.cancel();}}},
    async save(){
      if(!this._artifact||this.data.posterBusy||this.data.posterSaving||!statusPosterAvailable(this._snapshot,currentData()))return;
      this.setData({posterSaving:true,posterError:'',privacyNeeded:false});
      try{if(await privacyRequired(wx)){this.setData({privacyNeeded:true});return;}const guard=preserveNativeReturn();try{await poster.savePoster(wx,this._artifact,{userInitiated:true});}finally{guard.finish();}wx.showToast({title:'已保存到相册',icon:'success'});}
      catch(error){this.setData({posterError:error.message||'保存失败，请重试。'});}
      finally{this.setData({posterSaving:false});}
    },
    openPrivacyContract(){if(typeof wx.openPrivacyContract==='function'){const guard=preserveNativeReturn();try{wx.openPrivacyContract({fail(){guard.cancel();wx.showToast({title:'隐私指引暂不可用',icon:'none'});}});}catch(_){guard.cancel();}}},
    onShareAppMessage(){return{title:this._snapshot&&!this.data.blocked?this._snapshot.title:'模钥重置雷达',path:!this.data.blocked&&this._snapshot&&this._snapshot.publicationId?`/pages/detail/index?publicationId=${encodeURIComponent(this._snapshot.publicationId)}`:'/pages/home/index'};}
  }
}));
