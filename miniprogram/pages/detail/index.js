const { createPage } = require('../../utils/page');
const m = require('../../utils/model');
const poster=require('../../utils/poster');
const {privacyRequired}=require('../../utils/wechat');
function stopPage(page){page._active=false;page._sceneGeneration=(page._sceneGeneration||0)+1;page._posterGeneration=(page._posterGeneration||0)+1;if(page._sceneRequest)page._sceneRequest.abort();if(page._codeRequest)page._codeRequest.abort();}
function canvasNode(page){return new Promise((resolve,reject)=>{
  if(typeof wx.createSelectorQuery!=='function'){reject(new Error('当前微信不支持海报画布，请更新微信。'));return;}
  const timer=setTimeout(()=>reject(new Error('海报画布尚未准备好，请重试。')),10000);
  try{wx.createSelectorQuery().in(page).select('#poster-canvas').fields({node:true},result=>{clearTimeout(timer);result&&result.node?resolve(result.node):reject(new Error('海报画布尚未准备好，请重试。'));}).exec();}
  catch(_){clearTimeout(timer);reject(new Error('海报画布尚未准备好，请重试。'));}
});}
Page(createPage((data, query, page) => data && !page.sceneLoading && !page.sceneError && query.publicationId ? { detail: m.resolveDetail(data, query) } : { detail:null }, {
  view:query=>query.publicationId?({view:'detail',entity:'publications',id:query.publicationId}):({view:'home'}),
  data: { detail: null,sceneLoading:false,sceneError:'',sceneCanRetry:false,posterBusy:false,posterSaving:false,posterError:'',posterPreview:'',posterPrivacyNeeded:false,bodyOpen:false,evidenceOpen:false,recordOpen:false,posterTheme:'precision' },
  load(query){this._wantPoster=query.poster==='1';if(query.scene){this._params={};try{const scene=decodeURIComponent(query.scene).toLowerCase();if(!/^[a-f0-9]{32}$/.test(scene))throw new Error();this._scene=scene;this.setData({sceneLoading:true,sceneCanRetry:true});}catch(_){this.setData({sceneError:'这个小程序码场景无效，请返回公开公告。'});}}
    else if(!query.publicationId)this.setData({sceneError:'缺少指定发布版本，请返回公开公告。'});},
  show(){this._active=true;this.setData({posterBusy:false});if(this._scene&&!this._sceneResolved)void this.resolveScene();this.maybeGeneratePoster();},hide(){stopPage(this);},unload(){stopPage(this);},
  afterRender() {
    const canShare = this.data.detail && this.data.detail.canShare;
    if (canShare && typeof wx.showShareMenu === 'function') wx.showShareMenu({ menus: ['shareAppMessage'] });
    else if (typeof wx.hideShareMenu === 'function') wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    if(this.data.detail&&!canShare&&this._posterArtifact){this._posterArtifact=null;this.setData({posterPreview:'',posterError:'此内容已撤回或合并，不能继续分享海报。'});}
    this.maybeGeneratePoster();
  },
  methods: {
    toggleSection(event){const key=event.currentTarget.dataset.section;if(['bodyOpen','evidenceOpen','recordOpen'].includes(key))this.setData({[key]:!this.data[key]});},
    maybeGeneratePoster(){if(this._active&&this._wantPoster&&this.data.detail&&this.data.detail.canShare){this._wantPoster=false;void this.generatePoster();}},
    selectPosterTheme(event){const theme=event.currentTarget.dataset.theme;if(!['precision','editorial'].includes(theme)||this.data.posterBusy||theme===this.data.posterTheme)return;this.setData({posterTheme:theme});this._posterArtifact=null;this.setData({posterPreview:''});},
    async resolveScene(){
      const generation=(this._sceneGeneration||0)+1;this._sceneGeneration=generation;this.setData({sceneLoading:true,sceneError:''});
      try{this._sceneRequest=getApp().publicApi(`/api/v1/wechat/scene/${this._scene}`);const result=await this._sceneRequest.promise;
        if(!this._active||generation!==this._sceneGeneration)return;this._params={publicationId:result.data.publicationId};this._sceneResolved=true;const client=getApp().client;await (client.setView?client.setView(this.readView()):client.refresh(false));
        if(this._active&&generation===this._sceneGeneration){this.setData({sceneLoading:false});this.redraw();}}
      catch(error){if(this._active&&generation===this._sceneGeneration)this.setData({sceneLoading:false,sceneError:error.message||'此小程序码暂时无法读取，请重试。'});}
    },
    retryScene(){if(this._scene)void this.resolveScene();},
    async generatePoster(){
      if(this.data.posterBusy||!this.data.detail||!this.data.detail.canShare)return;
      const id=this.data.detail.publicationId,generation=(this._posterGeneration||0)+1;this._posterGeneration=generation;let asset;
      this._posterArtifact=null;this.setData({posterBusy:true,posterError:'',posterPreview:'',posterPrivacyNeeded:false});
      try{this._codeRequest=getApp().publicApi(`/api/v1/wechat/code/${encodeURIComponent(id)}`);const response=await this._codeRequest.promise;
        if(!this._active||generation!==this._posterGeneration)return;
        asset=await poster.writeCodeAsset(wx,response.data,id);const canvas=await canvasNode(this);
        if(!this._active||generation!==this._posterGeneration)return;
        const artifact=await poster.renderPoster({wxApi:wx,canvas,data:getApp().client.getState().data,publicationId:id,code:asset,page:this,options:{theme:this.data.posterTheme}});
        if(this._active&&generation===this._posterGeneration&&m.resolveDetail(getApp().client.getState().data,{publicationId:id}).canShare){this._posterArtifact=artifact;this.setData({posterPreview:artifact.tempFilePath});}}
      catch(error){if(this._active&&generation===this._posterGeneration)this.setData({posterError:error.message||'海报暂时无法生成，请重试。'});}
      finally{if(asset)await asset.dispose();if(this._active&&generation===this._posterGeneration)this.setData({posterBusy:false});}
    },
    previewPoster(){if(this.data.posterPreview&&typeof wx.previewImage==='function')wx.previewImage({urls:[this.data.posterPreview],current:this.data.posterPreview});},
    async savePoster(){
      if(this._savingPoster)return;
      if(!this._posterArtifact||!m.resolveDetail(getApp().client.getState().data,{publicationId:this._posterArtifact.publicationId}).canShare){this.setData({posterError:'请先生成仍可公开分享的海报。'});return;}
      this._savingPoster=true;this.setData({posterSaving:true});
      try{if(await privacyRequired(wx)){this.setData({posterPrivacyNeeded:true,posterError:'请先阅读并同意隐私指引。'});return;}
        await poster.savePoster(wx,this._posterArtifact,{userInitiated:true});this.setData({posterPrivacyNeeded:false,posterError:''});wx.showToast({title:'已保存到相册',icon:'success'});}
      catch(error){this.setData({posterError:error.message||'保存失败，请重试。'});}
      finally{this._savingPoster=false;this.setData({posterSaving:false});}
    },
    agreePosterPrivacy(){void this.savePoster();},
    openPrivacyContract(){if(typeof wx.openPrivacyContract==='function')wx.openPrivacyContract({fail(){wx.showToast({title:'隐私指引暂不可用',icon:'none'});}});},
    copySource(event) { const url = m.safeUrl(event.currentTarget.dataset.url); if (url) wx.setClipboardData({ data: url, fail() { wx.showToast({ title: '复制失败，请稍后重试', icon: 'none' }); } }); },
    onShareAppMessage() {
      const data = getApp().client.getState().data;
      const detail = data && m.resolveDetail(data, this._params || {});
      return detail && detail.canShare ? { title: detail.title, path: `/pages/detail/index?publicationId=${encodeURIComponent(detail.publicationId)}` } : { title: '模钥重置雷达', path: '/pages/home/index' };
    }
  }
}));
