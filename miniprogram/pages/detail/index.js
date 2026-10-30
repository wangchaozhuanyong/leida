const {preserveNativeReturn}=require('../../utils/entry-navigation');
const { createPage } = require('../../utils/page');
const m = require('../../utils/model');
const poster=require('../../utils/poster');
const {privacyRequired}=require('../../utils/wechat');
function stopPage(page){clearTimeout(page._posterTimeout);page._active=false;page._sceneGeneration=(page._sceneGeneration||0)+1;page._posterGeneration=(page._posterGeneration||0)+1;if(page._sceneRequest)page._sceneRequest.abort();}
function canvasNode(page){return new Promise((resolve,reject)=>{
  if(typeof wx.createSelectorQuery!=='function'){reject(new Error('当前微信不支持生成海报，请更新微信。'));return;}
  const timer=setTimeout(()=>reject(new Error('海报尚未准备好，请重试。')),10000);
  try{wx.createSelectorQuery().in(page).select('#poster-canvas').fields({node:true},result=>{clearTimeout(timer);result&&result.node?resolve(result.node):reject(new Error('海报尚未准备好，请重试。'));}).exec();}
  catch(_){clearTimeout(timer);reject(new Error('海报尚未准备好，请重试。'));}
});}
Page(createPage((data, query, page) => data && !page.sceneLoading && !page.sceneError && query.publicationId ? { detail: m.resolveDetail(data, query) } : { detail:null }, {
  view:query=>query.publicationId?({view:'detail',entity:'publications',id:query.publicationId}):({view:'home'}),
  data: { detail: null,sceneLoading:false,sceneError:'',sceneCanRetry:false,posterBusy:false,posterSaving:false,posterError:'',posterPreview:'',posterReady:false,posterPrivacyNeeded:false,bodyOpen:false,evidenceOpen:false,progressOpen:false,posterTheme:'precision' },
  load(query){this._wantPoster=query.poster==='1';if(query.scene){this._params={};try{const scene=decodeURIComponent(query.scene).toLowerCase();if(!/^[a-f0-9]{32}$/.test(scene))throw new Error();this._scene=scene;this.setData({sceneLoading:true,sceneCanRetry:true});}catch(_){this.setData({sceneError:'这个小程序码无效，请返回查看最新消息。'});}}
    else if(!query.publicationId)this.setData({sceneError:'消息链接不完整，请返回查看最新消息。'});},
  show(){this._active=true;this.setData({posterBusy:false});if(this._scene&&!this._sceneResolved)void this.resolveScene();if(this.invalidateExpiredPoster())this._wantPoster=true;this.maybeGeneratePoster();},hide(){stopPage(this);},unload(){stopPage(this);this.clearPosters();},
  afterRender() {
    const canShare = this.data.detail && this.data.detail.canShare;
    if (canShare && typeof wx.showShareMenu === 'function') wx.showShareMenu({ menus: ['shareAppMessage'] });
    else if (typeof wx.hideShareMenu === 'function') wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    if(this.data.detail&&!canShare){this.clearPosters();this.setData({posterPreview:'',posterReady:false,posterError:'此内容已撤回或合并，不能继续分享海报。'});}
    this.maybeGeneratePoster();
  },
  methods: {
    invalidateExpiredPoster(){
      if(!Object.keys(this._posterCache||{}).length||poster.posterCacheFresh(this._posterAt))return false;
      this.clearPosters();
      this.setData({posterPreview:'',posterReady:false});return true;
    },
    clearPosters(){
      for(const artifact of Object.values(this._posterCache||{}))if(typeof wx.getFileSystemManager==='function')wx.getFileSystemManager().unlink({filePath:artifact.tempFilePath,success(){},fail(){}});
      this._posterCache={};this._posterArtifact=null;this._posterAt=undefined;
    },
    toggleSection(event){const key=event.currentTarget.dataset.section;if(['bodyOpen','evidenceOpen','progressOpen'].includes(key))this.setData({[key]:!this.data[key]});},
    maybeGeneratePoster(){if(this._active&&this._wantPoster&&this.data.detail&&this.data.detail.canShare){this._wantPoster=false;void this.generatePoster();}},
    selectPosterTheme(event){
      const theme=event.currentTarget.dataset.theme;
      if(!['precision','editorial'].includes(theme)||this.data.posterBusy||this.data.posterSaving||theme===this.data.posterTheme)return;
      this.setData({posterTheme:theme,posterError:''});
      // Choosing a style before the first generation should not make a network request.
      if(this.data.posterPreview)void this.generatePoster();
    },
    async resolveScene(){
      const generation=(this._sceneGeneration||0)+1;this._sceneGeneration=generation;this.setData({sceneLoading:true,sceneError:''});
      try{this._sceneRequest=getApp().publicApi(`/api/v1/wechat/scene/${this._scene}`);const result=await this._sceneRequest.promise;
        if(!this._active||generation!==this._sceneGeneration)return;this._params={publicationId:result.data.publicationId};this._sceneResolved=true;const client=getApp().client;await (client.setView?client.setView(this.readView()):client.refresh(false));
        if(this._active&&generation===this._sceneGeneration){this.setData({sceneLoading:false});this.redraw();}}
      catch(error){if(this._active&&generation===this._sceneGeneration)this.setData({sceneLoading:false,sceneError:error.message||'此小程序码暂时无法读取，请重试。'});}
    },
    retryScene(){if(this._scene)void this.resolveScene();},
    async generatePoster(){
      if(this.data.posterBusy||this.data.posterSaving||!this.data.detail||!this.data.detail.canShare)return;
      this.invalidateExpiredPoster();
      const id=this.data.detail.publicationId,generation=(this._posterGeneration||0)+1;this._posterGeneration=generation;
      this._posterCache=this._posterCache||{};const theme=this.data.posterTheme,cached=this._posterCache[theme];
      if(cached){this._posterArtifact=cached;this.setData({posterPreview:cached.tempFilePath,posterReady:true,posterError:'',posterBusy:false});return;}
      this._posterArtifact=null;this.setData({posterBusy:true,posterReady:false,posterError:'',posterPrivacyNeeded:false});
      this._posterTimeout=setTimeout(()=>{if(this._active&&generation===this._posterGeneration){this._posterGeneration++;this.setData({posterBusy:false,posterError:'海报生成超时，请重试。'});}},20000);
      try{const canvas=await canvasNode(this);if(!this._active||generation!==this._posterGeneration)return;
        const current=()=>this._active&&generation===this._posterGeneration;
        const work=()=>current()?poster.renderPoster({wxApi:wx,canvas,data:getApp().client.getState().data,publicationId:id,page:this,options:{theme},isCurrent:current}):null;
        this._renderQueue=(this._renderQueue||Promise.resolve()).catch(()=>{}).then(work);
        const artifact=await this._renderQueue;
        if(artifact&&current()&&m.resolveDetail(getApp().client.getState().data,{publicationId:id}).canShare){this._posterArtifact=artifact;this._posterCache[theme]=artifact;if(!Number.isFinite(this._posterAt))this._posterAt=Date.now();this.setData({posterPreview:artifact.tempFilePath,posterReady:true});}}
      catch(error){if(this._active&&generation===this._posterGeneration)this.setData({posterError:error.message||'海报暂时无法生成，请重试。'});}
      finally{if(this._active&&generation===this._posterGeneration){clearTimeout(this._posterTimeout);this.setData({posterBusy:false});}}
    },
    previewPoster(){if(this.data.posterPreview&&typeof wx.previewImage==='function'){const guard=preserveNativeReturn();try{wx.previewImage({urls:[this.data.posterPreview],current:this.data.posterPreview,fail:()=>guard.cancel()});}catch(_){guard.cancel();}}},
    async savePoster(){
      if(this._savingPoster||this.data.posterBusy)return;
      if(this.invalidateExpiredPoster()){const work=this.generatePoster(),generation=this._posterGeneration;await work;if(this._active&&generation===this._posterGeneration)this.setData({posterError:this.data.posterError||'海报已更新，请确认后再次保存。'});return;}
      if(!this._posterArtifact||!m.resolveDetail(getApp().client.getState().data,{publicationId:this._posterArtifact.publicationId}).canShare){this.setData({posterError:'请先生成仍可公开分享的海报。'});return;}
      this._savingPoster=true;this.setData({posterSaving:true});
      try{if(await privacyRequired(wx)){this.setData({posterPrivacyNeeded:true,posterError:'请先阅读并同意隐私指引。'});return;}
        if(this.invalidateExpiredPoster()){this.setData({posterError:'海报已过期，请重新生成后保存。'});return;}
        const guard=preserveNativeReturn();try{await poster.savePoster(wx,this._posterArtifact,{userInitiated:true});}finally{guard.finish();}this.setData({posterPrivacyNeeded:false,posterError:''});wx.showToast({title:'已保存到相册',icon:'success'});}
      catch(error){this.setData({posterError:error.message||'保存失败，请重试。'});}
      finally{this._savingPoster=false;this.setData({posterSaving:false});}
    },
    agreePosterPrivacy(){void this.savePoster();},
    openPrivacyContract(){if(typeof wx.openPrivacyContract==='function'){const guard=preserveNativeReturn();try{wx.openPrivacyContract({fail(){guard.cancel();wx.showToast({title:'隐私指引暂不可用',icon:'none'});}});}catch(_){guard.cancel();}}},
    copySource(event) { const url = m.safeUrl(event.currentTarget.dataset.url); if (url) wx.setClipboardData({ data: url, fail() { wx.showToast({ title: '复制失败，请稍后重试', icon: 'none' }); } }); },
    onShareAppMessage() {
      const data = getApp().client.getState().data;
      const detail = data && m.resolveDetail(data, this._params || {});
      return detail && detail.canShare ? { title: detail.title, path: `/pages/detail/index?publicationId=${encodeURIComponent(detail.publicationId)}` } : { title: '模钥重置雷达', path: '/pages/home/index' };
    }
  }
}));
