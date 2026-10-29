const {preserveNativeReturn}=require('../../utils/entry-navigation');
const {createPage}=require('../../utils/page');
const {statusPosterInput,statusPosterAvailable,renderStatusPoster}=require('./status-poster');
const poster=require('../../utils/poster');
const {privacyRequired}=require('../../utils/wechat');
// Public codes only. Keep a small, short-lived cache across page entries; the
// selected publication and current public status are still checked on every use.
const publicCodes=new Map();
function cachedCode(id){const value=publicCodes.get(id);if(value&&poster.posterCacheFresh(value.at))return value;publicCodes.delete(id);return null;}
function rememberCode(id,data,at){publicCodes.delete(id);if(poster.posterCacheFresh(at))publicCodes.set(id,{at,data});while(publicCodes.size>2)publicCodes.delete(publicCodes.keys().next().value);}
function canvasNode(page){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('海报尚未准备好，请重试。')),10000);try{wx.createSelectorQuery().in(page).select('#status-poster-canvas').fields({node:true},result=>{clearTimeout(timer);result&&result.node?resolve(result.node):reject(new Error('海报暂不可用，请重试。'));}).exec();}catch(_){clearTimeout(timer);reject(new Error('海报暂不可用，请重试。'));}});}
function currentData(){const state=getApp().client.getState(),data=state.data;if(!data)return data;const age=Number.isFinite(state.receivedAt)?Math.max(0,Date.now()-state.receivedAt):0;return {...data,serverTime:new Date(Date.parse(data.serverTime)+age).toISOString()};}
function stop(page){clearTimeout(page._stateExpiryTimer);clearTimeout(page._posterTimeout);page._active=false;page._generation=(page._generation||0)+1;if(page._codeRequest)page._codeRequest.abort();page._codeFlight=null;}
Page(createPage(data=>({available:!!data}),{
  view:()=>({view:'home'}),
  load(query){this._selectedKind=query.kind==='banked_reset'?'banked_reset':'automatic_reset';this._expectedRevision=typeof query.revision==='string'?query.revision:'';},
  data:{available:false,theme:'precision',preview:'',posterReady:false,posterBusy:false,posterSaving:false,posterError:'',codeNote:'',blocked:'',privacyNeeded:false},
  show(){this._active=true;if(this._snapshot)void this.generate();},hide(){stop(this);},unload(){stop(this);this.clearPosters();this._codeData=null;},
  afterRender(){
    const data=currentData();
    if(this._snapshot&&data&&!statusPosterAvailable(this._snapshot,data)){stop(this);this.clearPosters();this.setData({preview:'',posterBusy:false,blocked:'公开状态已变化，请返回首页重新生成。'});return;}
    if(this._active&&!this.data.navigationLoading&&data&&!this._snapshot){const snapshot=statusPosterInput(data,this._selectedKind);if(this._expectedRevision&&snapshot.round!==this._expectedRevision){this.setData({blocked:'公开状态已变化，请返回首页重新生成。'});return;}this._snapshot=snapshot;void this.generate();}
    clearTimeout(this._stateExpiryTimer);
    if(this._active&&data&&this._snapshot&&this._snapshot.validUntil){const remaining=Date.parse(this._snapshot.validUntil)-Date.parse(data.serverTime);if(remaining>0){this._stateExpiryTimer=setTimeout(()=>this.afterRender(),Math.min(2147483647,remaining+20));this._stateExpiryTimer.unref?.();}}
  },
  methods:{
    invalidateExpiredPoster(){
      const codeExpired=this._codeData&&!poster.posterCacheFresh(this._codeAt);
      const imageExpired=Object.values(this._artifacts||{}).some(value=>!poster.posterCacheFresh(value.at));
      if(!codeExpired&&!imageExpired)return false;
      this.clearPosters();this._codeData=null;this._codeAt=undefined;
      this.setData({preview:'',posterReady:false});return true;
    },
    clearPosters(){
      const paths=new Set([...Object.values(this._artifacts||{}).map(value=>value.artifact.tempFilePath),...(this._previewPaths||[])]);
      this._previewPaths=[];
      this._artifacts={};this._artifact=null;
      if(typeof wx.getFileSystemManager==='function')for(const filePath of paths)wx.getFileSystemManager().unlink({filePath,success(){},fail(){}});
    },
    selectTheme(event){const theme=event.currentTarget.dataset.theme;if(!['precision','editorial'].includes(theme)||theme===this.data.theme)return;this.setData({theme});void this.generate();},
    async generate(){
      if(!this._active||!this._snapshot||this.data.blocked)return;
      if(!statusPosterAvailable(this._snapshot,currentData())){stop(this);this.clearPosters();this.setData({preview:'',posterBusy:false,blocked:'公开状态已变化，请返回首页重新生成。'});return;}
      this.invalidateExpiredPoster();
      clearTimeout(this._posterTimeout);
      const generation=(this._generation||0)+1;this._generation=generation;
      const current=()=>this._active&&generation===this._generation,theme=this.data.theme;let asset;
      this._artifacts=this._artifacts||{};
      const cached=this._artifacts[theme];
      if(cached){this._artifact=cached.artifact;this.setData({preview:cached.artifact.tempFilePath,posterReady:true,posterBusy:false,posterError:'',codeNote:cached.note});return;}
      this._artifact=null;this.setData({posterReady:false,posterBusy:true,posterError:'',codeNote:''});
      this._posterTimeout=setTimeout(()=>{if(!current())return;stop(this);this._active=true;this.setData({posterBusy:false,posterError:'海报生成超时，请重试。'});},20000);
      try{
        const codePublicationId=this._snapshot.codePublicationId||this._snapshot.publicationId;
        let codeSettled=!codePublicationId,codeError;
        let codeWork=Promise.resolve();
        if(codePublicationId){
          if(!this._codeData){const cached=cachedCode(codePublicationId);if(cached){this._codeData=cached.data;this._codeAt=cached.at;}}
          if(!this._codeData){
            try{
              if(!this._codeFlight){this._codeRequest=getApp().publicApi(`/api/v1/wechat/code/${encodeURIComponent(codePublicationId)}`);const flight=this._codeRequest.promise.then(response=>response.data);this._codeFlight=flight;flight.finally(()=>{if(this._codeFlight===flight)this._codeFlight=null;}).catch(()=>{});}
              codeWork=this._codeFlight.then(data=>{if(current()){this._codeData=data;this._codeAt=Date.now();}},error=>{codeError=error;}).finally(()=>{codeSettled=true;});
            }catch(error){codeError=error;codeSettled=true;}
          }else codeSettled=true;
        }
        const canvas=await canvasNode(this);if(!current())return;
        const render=(code)=>{
          const work=()=>current()?renderStatusPoster({wxApi:wx,canvas,page:this,input:this._snapshot,theme,code,isCurrent:current}):null;
          this._renderQueue=(this._renderQueue||Promise.resolve()).catch(()=>{}).then(work);return this._renderQueue;
        };
        // Show the factual artwork while the optional public code is loading.
        // This draft cannot be saved; it is replaced by the final validated image.
        if(!codeSettled){const draft=await render();if(!current())return;if(draft){(this._previewPaths||(this._previewPaths=[])).push(draft.tempFilePath);this.setData({preview:draft.tempFilePath});}}
        await codeWork;if(!current())return;
        if(codePublicationId){
          try{if(codeError)throw codeError;asset=await poster.writeCodeAsset(wx,this._codeData,codePublicationId);}
          catch(error){if(!current())return;if([404,409,410].includes(error.status))throw error;this.setData({codeNote:'小程序码暂不可用，本张海报无法扫码，可直接转发小程序。'});}
        }else this.setData({codeNote:'本张海报未附小程序码，可直接转发小程序。'});
        if(!current())return;const artifact=await render(asset);
        if(current()&&artifact){if(asset)rememberCode(codePublicationId,this._codeData,this._codeAt);this._artifact=artifact;this._artifacts[theme]={artifact,note:this.data.codeNote,at:this._codeData?this._codeAt:Date.now()};this.setData({preview:artifact.tempFilePath,posterReady:true});}
      }catch(error){if(current()){if([404,409,410].includes(error.status)){this.clearPosters();this.setData({preview:'',posterReady:false,blocked:'这条消息暂不可用，请返回首页核对。'});}this.setData({posterError:error.message||'海报生成失败，请重试。'});}}
      finally{if(asset)await asset.dispose();if(current()){clearTimeout(this._posterTimeout);this.setData({posterBusy:false});}}
    },
    previewImage(){if(this.data.preview&&!this.data.posterBusy){const guard=preserveNativeReturn();try{wx.previewImage({current:this.data.preview,urls:[this.data.preview],fail:()=>guard.cancel()});}catch(_){guard.cancel();}}},
    async save(){
      if(this.data.posterBusy||this.data.posterSaving)return;
      if(this.invalidateExpiredPoster()){const work=this.generate(),generation=this._generation;await work;if(this._active&&generation===this._generation)this.setData({posterError:this.data.posterError||'海报已更新，请确认后再次保存。'});return;}
      if(!this._artifact||this.data.posterBusy||this.data.posterSaving||!statusPosterAvailable(this._snapshot,currentData()))return;
      this.setData({posterSaving:true,posterError:'',privacyNeeded:false});
      try{if(await privacyRequired(wx)){this.setData({privacyNeeded:true});return;}if(this.invalidateExpiredPoster()){const work=this.generate(),generation=this._generation;await work;if(this._active&&generation===this._generation)this.setData({posterError:this.data.posterError||'海报已更新，请确认后再次保存。'});return;}const guard=preserveNativeReturn();try{await poster.savePoster(wx,this._artifact,{userInitiated:true});}finally{guard.finish();}wx.showToast({title:'已保存到相册',icon:'success'});}
      catch(error){this.setData({posterError:error.message||'保存失败，请重试。'});}
      finally{this.setData({posterSaving:false});}
    },
    openPrivacyContract(){if(typeof wx.openPrivacyContract==='function'){const guard=preserveNativeReturn();try{wx.openPrivacyContract({fail(){guard.cancel();wx.showToast({title:'隐私指引暂不可用',icon:'none'});}});}catch(_){guard.cancel();}}},
    onShareAppMessage(){const available=this._snapshot&&!this.data.blocked&&statusPosterAvailable(this._snapshot,currentData());if(!available&&this._snapshot)this.afterRender();return{title:available?this._snapshot.shareTitle:'模钥重置雷达',path:available?this._snapshot.sharePath:'/pages/home/index'};}
  }
}));
