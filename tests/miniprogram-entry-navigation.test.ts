import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const miniRoot=resolve(root,'miniprogram');
const HOME='pages/home/index',DETAIL='pages/detail/index',SCENE='a'.repeat(32);
type Options=Record<string,any>;
const ordinary={scene:1001,path:HOME,query:{}};
const plain=(value:unknown)=>JSON.parse(JSON.stringify(value));
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred(){let resolve!:(value?:unknown)=>void,reject!:(error:Error)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

// All modules and page/App lifecycle hooks are the production JavaScript.
// wx, transport results and timers are isolated; this fixture never contacts WeChat.
function harness(wxOverrides:Options={}){
  const requests:Options[]=[],switches:Options[]=[],toasts:Options[]=[],previews:Options[]=[],privacy:Options[]=[],calls:string[]=[],views:Options[]=[];
  const listeners=new Set<(state:Options)=>void>(),cache=new Map<string,{exports:Options}>(),definitions=new Map<string,Options>();
  const timers=new Map<object,()=>void>();let appDefinition:Options={},pages:Options[]=[];
  const stamp='2026-10-24T00:00:00Z';
  const article={id:'fixture-article',eventId:'fixture-event',title:'固定记录',summary:'隔离测试',translation:'',category:'product',version:1,status:'published',publicationId:'fixture-old',evidenceIds:[],publishedAt:stamp,updatedAt:stamp};
  const event={id:'fixture-event',title:'固定记录',version:1,status:'published',publicationId:'fixture-old',actions:[],evidenceIds:[],updatedAt:stamp};
  const data={publications:[{id:'fixture-old',articleId:article.id,eventId:event.id,publishedAt:stamp,cutoffAt:stamp,reason:'隔离测试',mode:'news_only',article,event}],events:[event],articles:[article],activities:[],evidence:[],notices:[],sources:[],site:{name:'测试雷达',description:'',version:1,autoPublish:true},serverTime:stamp};
  const state:Options={data,receivedAt:Date.now(),loading:false,unconfigured:false,error:''};
  const app:Options={};
  const wx:Options={
    getStorageSync(){},setStorageSync(){},setBackgroundColor(){},showShareMenu(){},hideShareMenu(){},setNavigationBarTitle(){},
    switchTab(options:Options){switches.push(options);},showToast(options:Options){toasts.push(options);},navigateTo(){},
    previewImage(options:Options){previews.push(options);},openPrivacyContract(options:Options){privacy.push(options);},
    getPrivacySetting(options:Options){options.success({needAuthorization:false});},
    getFileSystemManager(){return{unlink(options:Options){options.success?.({});}};},...wxOverrides
  };
  function load(filename:string):Options{
    const existing=cache.get(filename);if(existing)return existing.exports;
    assert.ok(filename.startsWith(miniRoot+'/'));
    const module={exports:{}};cache.set(filename,module);
    new Script(readFileSync(filename,'utf8'),{filename}).runInNewContext({
      module,exports:module.exports,wx,Date,console,getApp:()=>app,getCurrentPages:()=>pages,
      App(value:Options){appDefinition=value;},Page(value:Options){definitions.set(filename,value);},
      setTimeout(callback:()=>void){const id={unref(){}};timers.set(id,callback);return id;},clearTimeout(id:object){timers.delete(id);},
      setInterval(){return 1;},clearInterval(){},
      require(path:string){return load(resolve(dirname(filename),path.endsWith('.js')?path:path+'.js'));}
    });return module.exports;
  }
  load(resolve(miniRoot,'app.js'));Object.assign(app,appDefinition);app.onLaunch();
  app.client={start(){calls.push('start');return Promise.resolve();},stop(){calls.push('stop');},getState(){return state;},
    setView(view:Options){views.push(plain(view));return Promise.resolve();},
    subscribe(fn:(state:Options)=>void){listeners.add(fn);fn(state);return()=>listeners.delete(fn);},refresh(){return Promise.resolve();}};
  app.publicApi=(path:string)=>{const work=deferred();const request={path,...work,aborted:0};requests.push(request);return{promise:work.promise,abort(){request.aborted++;}};};
  const readerState={ready:true,busy:false,privacyNeeded:false,safe:{configured:true,enabled:true,state:'available'},remainingCount:2};
  app.wechat={warmup:()=>Promise.resolve(),getState:()=>readerState,loadForPage:()=>Promise.resolve(),nextRefreshDelay:()=>300000,
    subscribe(fn:(state:Options)=>void){fn(readerState);return()=>{};},authorize(){calls.push('authorize');return Promise.resolve();},retryConfirmation(){calls.push('confirm');return Promise.resolve();}};
  function instantiate(definition:Options,route:string,params:Options={}){
    const instance:Options={...definition,route,data:structuredClone(definition.data||{}),setData(patch:Options,done?:()=>void){
      for(const[key,value]of Object.entries(patch)){const parts=key.split('.');let target=this.data;for(const part of parts.slice(0,-1)){target[part]??={};target=target[part];}target[parts.at(-1)!]=structuredClone(value);}done?.();
    }};
    pages=[instance];instance.onLoad?.(params);return instance;
  }
  function page(route:string,params:Options={}){const file=resolve(miniRoot,route+'.js');load(file);return instantiate(definitions.get(file)!,route,params);}
  function common(route:string,view:Options={view:'home'},methods:Options={}){const {createPage}=load(resolve(miniRoot,'utils/page.js'));return instantiate(createPage(()=>({}),{view:()=>view,methods}),route);}
  function startAtHome(){app.onShow(ordinary);const home=common(HOME);home.onShow();home.onHide();}
  return{app,wx,state,load,page,common,startAtHome,requests,switches,toasts,previews,privacy,calls,views,readers:readerState,
    get subscriptions(){return listeners.size;},get timerCount(){return timers.size;}};
}

function installRealReader(h:ReturnType<typeof harness>,options:{throwNative?:boolean}={}){
  const native:Options[]=[],confirmations:Options[]=[],requests:Options[]=[],confirmed=new Set<string>();let count=2,challenge=0;
  const clock=Date.now(),template='fixture-template';
  const safe=()=>({configured:true,enabled:true,state:'available',templateId:template,remainingCount:count,pendingCount:0});
  h.wx.login=(input:Options)=>queueMicrotask(()=>input.success({code:'isolated-login-code'}));
  h.wx.requestSubscribeMessage=(input:Options)=>{native.push(input);if(options.throwNative)throw new Error('isolated native throw');};
  h.wx.request=(input:Options)=>{
    requests.push(input);const path=new URL(input.url).pathname;
    if(path.endsWith('/confirm'))confirmations.push(input);
    else queueMicrotask(()=>{
      const data=path==='/api/wechat/login'?{sessionToken:'isolated-reader-session',expiresAt:new Date(clock+3600000).toISOString()}
        :path.endsWith('/challenge')?{state:safe(),templateId:template,nonce:`isolated-nonce-${++challenge}`,expiresAt:new Date(clock+300000).toISOString()}:safe();
      input.success({statusCode:200,data:{data}});
    });
    return{abort(){}};
  };
  const {createWechatReader}=h.load(resolve(miniRoot,'utils/wechat.js'));
  h.app.wechat=createWechatReader({wxApi:h.wx,config:{mode:'https',baseUrl:'https://isolated.invalid',timeoutMs:10000},now:()=>clock});
  return{native,confirmations,requests,template,
    confirm(index:number,fail=false){const request=confirmations[index];assert.ok(request,'必须已发起隔离确认请求');if(fail){request.fail({errMsg:'isolated network failure'});return;}
      if(request.data.result==='accept'&&!confirmed.has(request.data.nonce)){count++;confirmed.add(request.data.nonce);}
      request.success({statusCode:200,data:{data:safe()}});
    }
  };
}

test('实际 App 冷启动延迟到页面显示再判断路由，首页不重复切页并保留启动停止',()=>{
  const h=harness();h.app.onShow(ordinary);assert.equal(h.switches.length,0);
  const home=h.common(HOME);home.onShow();assert.equal(h.switches.length,0);assert.equal(h.subscriptions,1);
  home.onHide();h.app.onHide();assert.deepEqual(h.calls,['start','stop']);assert.equal(h.subscriptions,0);
});

test('明确主入口重入非首页只切一次，旧页面不订阅或发起详情加载',()=>{
  for(const scene of [1001,1017,1023,1024,1027,1054,1089,1090,1103,1104,1256,1257,1271,1273]){
    const h=harness();h.app.onShow({scene,path:DETAIL,query:{publicationId:'fixture-old'}});
    const page=h.page(DETAIL,{publicationId:'fixture-old'});page.onShow();
    assert.equal(h.switches.length,1,`scene ${scene}`);assert.equal(h.switches[0].url,'/'+HOME);assert.equal(h.subscriptions,0);assert.equal(h.views.length,0);
    const home=h.common(HOME);home.onShow();assert.equal(h.switches.length,1);home.onUnload();
  }
});

test('六类旧海报码进入真实详情页直接回首页，不调用 scene 解析或详情请求',()=>{
  for(const scene of [1011,1012,1013,1047,1048,1049]){
    const h=harness();h.app.onShow({scene,path:'/'+DETAIL,query:{scene:SCENE}});
    const detail=h.page(DETAIL,{scene:SCENE});detail.onShow();
    assert.equal(h.switches.length,1,`scene ${scene}`);assert.equal(h.requests.length,0);assert.equal(h.views.length,0);assert.equal(h.subscriptions,0);
    detail.onUnload();
  }
});

test('通知、分享卡片、另一小程序返回及未知入口保留真实详情目标',()=>{
  for(const scene of [1014,1107,1007,1008,1038,1000]){
    const h=harness();h.app.onShow({scene,path:DETAIL,query:{publicationId:'fixture-old'}});
    const detail=h.page(DETAIL,{publicationId:'fixture-old'});detail.onShow();
    assert.equal(h.switches.length,0,`scene ${scene}`);assert.equal(detail.data.detail.publicationId,'fixture-old');
    assert.equal(detail.onShareAppMessage().path,'/pages/detail/index?publicationId=fixture-old');
    assert.deepEqual(h.views.at(-1),{view:'detail',entity:'publications',id:'fixture-old'});detail.onUnload();
  }
});

test('站内普通详情参数及站内导航不被最近一次首页入口重新覆盖',()=>{
  const h=harness();h.startAtHome();const detail=h.page(DETAIL,{publicationId:'fixture-old'});detail.onShow();
  assert.equal(h.switches.length,0);assert.equal(detail.data.detail.publicationId,'fixture-old');detail.onHide();detail.onShow();
  assert.equal(h.switches.length,0);assert.equal(h.subscriptions,1);detail.onUnload();assert.equal(h.subscriptions,0);
});

for(const route of ['pages/privacy/index','pages/methodology/index'])test(`${route} 自定义页面从普通主入口再入也回首页`,()=>{
  const h=harness();h.startAtHome();const page=h.page(route);page.onShow?.();page.onHide?.();h.app.onHide();
  h.app.onShow(ordinary);page.onShow?.();
  assert.equal(h.switches.length,1,'自定义页面必须参与统一入口决策');assert.equal(h.switches[0].url,'/'+HOME);page.onUnload?.();
});

test('旧 replay 路径从主入口打开回首页，显式历史链接仍进入记录',()=>{
  for(const scene of [1001,1007]){
    const h=harness();h.app.onShow({scene,path:'pages/replay/index',query:{month:'2026-10'}});
    const page=h.page('pages/replay/index',{month:'2026-10'});page.onShow?.();
    assert.equal(h.switches.length,1);assert.equal(h.switches[0].url,scene===1001?'/'+HOME:'/pages/announcements/index');page.onUnload?.();
  }
});

test('回首页异步失败时恢复当前真实页面，并显示一次可理解的提示',()=>{
  const h=harness();h.app.onShow(ordinary);const detail=h.page(DETAIL,{publicationId:'fixture-old'});detail.onShow();
  assert.equal(h.subscriptions,0);h.switches[0].fail({errMsg:'switchTab:fail'});
  assert.equal(h.toasts.length,1);assert.match(h.toasts[0].title,/返回首页失败/);assert.equal(h.subscriptions,1);assert.equal(detail.data.detail.publicationId,'fixture-old');detail.onUnload();
});

test('回首页同步抛错时当前页仍可显示，不留下永久加载状态',()=>{
  const h=harness({switchTab(){throw new Error('isolated native failure');}});h.app.onShow(ordinary);
  const detail=h.page(DETAIL,{publicationId:'fixture-old'});detail.onShow();assert.equal(h.subscriptions,1);assert.equal(detail.data.detail.publicationId,'fixture-old');detail.onUnload();
});

for(const route of [DETAIL,'packages/poster/index'])test(`${route} 真实预览返回保留页面，保护只消费一次`,()=>{
  const h=harness();h.startAtHome();h.state.data=null;
  const page=h.page(route,{publicationId:'fixture-old'});page.onShow();
  page.setData(route===DETAIL?{posterPreview:'wxfile://isolated.png'}:{preview:'wxfile://isolated.png'});
  (route===DETAIL?page.previewPoster:page.previewImage).call(page);assert.equal(h.previews.length,1);
  page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();assert.equal(h.switches.length,0);assert.equal(h.subscriptions,1);
  page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();assert.equal(h.switches.length,1);page.onUnload();
});

for(const route of [DETAIL,'packages/poster/index'])test(`${route} 原生转发取消或完成返回原页，下一次主入口仍回首页`,()=>{
  const h=harness();h.startAtHome();h.state.data=null;
  const page=h.page(route,{publicationId:'fixture-old'});page.onShow();
  const share=page.onShareAppMessage();assert.equal(typeof share.title,'string');assert.equal(typeof share.path,'string');
  page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();
  assert.equal(h.switches.length,0,'原生转发使用原入口参数恢复时必须留在触发页');assert.equal(h.subscriptions,1);
  page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();
  assert.equal(h.switches.length,1,'保护仅消费一次，不能吞掉真正的主入口重入');page.onUnload();assert.equal(h.subscriptions,0);
});

for(const route of [DETAIL,'packages/poster/index'])test(`${route} 转发只触发Page生命周期时不残留保护`,()=>{
  const h=harness();h.startAtHome();h.state.data=null;
  const page=h.page(route,{publicationId:'fixture-old'});page.onShow();page.onShareAppMessage();
  page.onHide();page.onShow();assert.equal(h.switches.length,0);
  page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();assert.equal(h.switches.length,1);page.onUnload();
});

for(const route of [DETAIL,'packages/poster/index'])test(`${route} 转发返回携带触发页路径参数时保留原页，保护不延续`,()=>{
  const h=harness();h.startAtHome();h.state.data=null;
  const params=route===DETAIL?{publicationId:'fixture-old'}:{kind:'banked_reset',revision:'home-isolated'};
  const page=h.page(route,params);page.onShow();page.onShareAppMessage();page.onHide();h.app.onHide();
  h.app.onShow({scene:ordinary.scene,path:route,query:Object.fromEntries(Object.entries(params).reverse())});page.onShow();
  assert.equal(h.switches.length,0,'微信可以把原入口路径改为当前触发页路径');assert.equal(h.subscriptions,1);
  page.onHide();h.app.onHide();h.app.onShow({scene:ordinary.scene,path:route,query:params});page.onShow();
  assert.equal(h.switches.length,1,'原生返回保护只能消费一次');page.onUnload();
});

test('转发返回保护拒绝相同页面但不同参数的新主入口',()=>{
  const h=harness();h.startAtHome();h.state.data=null;
  const page=h.page(DETAIL,{publicationId:'fixture-old'});page.onShow();page.onShareAppMessage();page.onHide();h.app.onHide();
  h.app.onShow({scene:ordinary.scene,path:DETAIL,query:{publicationId:'fixture-new'}});page.onShow();
  assert.equal(h.switches.length,1);page.onUnload();
});

test('转发保护不吞掉新扫码入口或通知详情',()=>{
  for(const notification of [false,true]){
    const h=harness();h.startAtHome();h.state.data=null;
    const page=h.page(DETAIL,{publicationId:'fixture-old'});page.onShow();page.onShareAppMessage();page.onHide();h.app.onHide();
    h.app.onShow(notification?{scene:1107,path:DETAIL,query:{publicationId:'fixture-new'}}:{scene:1047,path:DETAIL,query:{scene:SCENE}});
    const target=h.page(DETAIL,notification?{publicationId:'fixture-new'}:{scene:SCENE});target.onShow();
    assert.equal(h.switches.length,notification?0:1);target.onUnload();
  }
});

test('转发构建同步抛错时释放原生保护，并保留原错误',()=>{
  const h=harness();h.startAtHome();const error=new Error('isolated share build failure');
  const page=h.common(DETAIL,{view:'home'},{onShareAppMessage(){throw error;}});page.onShow();
  assert.throws(()=>page.onShareAppMessage(),(actual:unknown)=>actual===error);
  page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();assert.equal(h.switches.length,1);page.onUnload();
});

test('只有 Page 隐藏显示的原生返回会清除保护，下次真正再入回首页',()=>{
  const h=harness();h.startAtHome();const page=h.page(DETAIL,{publicationId:'fixture-old'});page.onShow();page.setData({posterPreview:'wxfile://isolated.png'});page.previewPoster();
  page.onHide();page.onShow();assert.equal(h.switches.length,0);
  page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();assert.equal(h.switches.length,1);page.onUnload();
});

test('无生命周期预览后的页面触控清除旧保护，不吞掉下次主入口',()=>{
  const h=harness();h.startAtHome();const page=h.page(DETAIL,{publicationId:'fixture-old'});page.onShow();page.setData({posterPreview:'wxfile://isolated.png'});page.previewPoster();page.nativeReturnTouched();
  page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();assert.equal(h.switches.length,1);page.onUnload();
});

test('跨页面或卸载清除旧预览保护，不能保护另一个页面的再入',()=>{
  for(const unload of [false,true]){
    const h=harness();h.startAtHome();const page=h.page(DETAIL,{publicationId:'fixture-old'});page.onShow();page.setData({posterPreview:'wxfile://isolated.png'});page.previewPoster();
    if(unload)page.onUnload();else page.onHide();
    const other=h.common('pages/news/index',{view:'news'});other.onShow();other.onHide();h.app.onHide();h.app.onShow(ordinary);other.onShow();
    assert.equal(h.switches.length,1);other.onUnload();
  }
});

test('原生预览调用失败释放保护，后续主入口正常回首页',()=>{
  const h=harness();h.startAtHome();const page=h.page(DETAIL,{publicationId:'fixture-old'});page.onShow();page.setData({posterPreview:'wxfile://isolated.png'});page.previewPoster();h.previews[0].fail({errMsg:'previewImage:fail'});
  page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();assert.equal(h.switches.length,1);page.onUnload();
});

test('原生保护不吞掉新的扫码入口，也不覆盖新的通知详情',()=>{
  for(const notification of [false,true]){
    const h=harness();h.startAtHome();const page=h.page(DETAIL,{publicationId:'fixture-old'});page.onShow();page.setData({posterPreview:'wxfile://isolated.png'});page.previewPoster();page.onHide();h.app.onHide();
    h.app.onShow(notification?{scene:1107,path:DETAIL,query:{publicationId:'fixture-old'}}:{scene:1047,path:DETAIL,query:{scene:SCENE}});
    const target=h.page(DETAIL,notification?{publicationId:'fixture-old'}:{scene:SCENE});target.onShow();
    assert.equal(h.switches.length,notification?0:1);assert.equal(h.requests.length,0);target.onUnload();
  }
});

test('真实 reader 在点击中同步授权，隐藏期间完成仍保护一次原页恢复',async()=>{
  const h=harness();h.startAtHome();const native=installRealReader(h),page=h.page('pages/settings/index');page.onShow();await flush();
  assert.equal(h.app.wechat.getState().ready,true);
  const pending=page.addWechat();assert.equal(native.native.length,1,'requestSubscribeMessage 必须在点击返回前发生');assert.equal(page.data.wechatAction,'add');
  page.onHide();h.app.onHide();native.native[0].success({[native.template]:'accept'});await flush();native.confirm(0);await pending;
  h.app.onShow(ordinary);page.onShow();
  assert.equal(h.switches.length,0);assert.equal(page.data.wechatAction,'');page.onUnload();assert.equal(h.timerCount,0);
});

test('真实授权拒绝、失败回调或同步异常均清除保护，之后主入口返回首页',async()=>{
  for(const outcome of ['reject','fail','throw']){
    const h=harness();h.startAtHome();const native=installRealReader(h,{throwNative:outcome==='throw'}),page=h.page('pages/settings/index');page.onShow();await flush();
    const pending=page.addWechat();assert.equal(native.native.length,1);
    if(outcome==='reject'){native.native[0].success({[native.template]:'reject'});await flush();native.confirm(0);}
    else if(outcome==='fail')native.native[0].fail({errMsg:'isolated subscribe denied'});
    await pending;
    assert.equal(page.data.wechatAction,'');page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();assert.equal(h.switches.length,1);page.onUnload();
  }
});

test('原生授权已返回但确认 HTTP 仍慢时，普通重新进入必须回首页',async()=>{
  const h=harness();h.startAtHome();const native=installRealReader(h),page=h.page('pages/settings/index');page.onShow();await flush();
  const pending=page.addWechat();native.native[0].success({[native.template]:'accept'});await flush();
  assert.equal(native.confirmations.length,1);assert.equal(h.app.wechat.getState().busy,true);
  page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();
  assert.equal(h.switches.length,1,'原生回调已结束，HTTP 等待不得延长原生返回保护');
  native.confirm(0);await pending;assert.equal(native.native.length,1);assert.equal(h.app.wechat.getState().remainingCount,3);page.onUnload();
});

test('结果不确定后的纯 HTTP 重确认期间再入回首页，不重复原生授权或计数',async()=>{
  const h=harness();h.startAtHome();const native=installRealReader(h),page=h.page('pages/settings/index');page.onShow();await flush();
  const first=page.addWechat();native.native[0].success({[native.template]:'accept'});await flush();native.confirm(0,true);await first;
  assert.equal(h.app.wechat.getState().confirmNeeded,true);assert.equal(native.native.length,1);
  const retry=page.addWechat();await flush();assert.equal(native.confirmations.length,2);assert.equal(native.native.length,1);
  page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();
  assert.equal(h.switches.length,1,'retryConfirmation 没有原生界面，不应创建恢复保护');
  native.confirm(1);await retry;assert.equal(native.native.length,1);assert.equal(h.app.wechat.getState().remainingCount,3);page.onUnload();
});

test('真实详情保存隐藏期间成功或失败均回原页，且保存状态可释放',async()=>{
  for(const failed of [false,true]){
    const h=harness();h.startAtHome();const page=h.page(DETAIL,{publicationId:'fixture-old'});page.onShow();page._posterArtifact={publicationId:'fixture-old'};
    const work=deferred();h.load(resolve(miniRoot,'utils/poster.js')).savePoster=()=>work.promise;
    const pending=page.savePoster();await flush();page.onHide();h.app.onHide();
    if(failed)work.reject(new Error('isolated denied save'));else work.resolve();await pending;
    h.app.onShow(ordinary);page.onShow();assert.equal(h.switches.length,0);assert.equal(page.data.posterSaving,false);
    if(failed)assert.match(page.data.posterError,/isolated denied/);page.onUnload();
  }
});

test('隐私原生页面返回保留详情，打开失败不污染下一次进入',()=>{
  for(const failed of [false,true]){
    const h=harness();h.startAtHome();const page=h.page(DETAIL,{publicationId:'fixture-old'});page.onShow();page.openPrivacyContract();assert.equal(h.privacy.length,1);
    if(failed)h.privacy[0].fail({errMsg:'isolated privacy failure'});
    page.onHide();h.app.onHide();h.app.onShow(ordinary);page.onShow();assert.equal(h.switches.length,failed?1:0);page.onUnload();
  }
});

test('客服返回保留提醒页，失败或未隐藏结束不会留下保护',async()=>{
  for(const outcome of ['hidden-return','failed','completed']){
    const h=harness();h.startAtHome();const page=h.page('pages/settings/index');page.onShow();await flush();page.contactStart();
    if(outcome==='failed')page.contactError();if(outcome==='completed')page.contactReturn();
    page.onHide();h.app.onHide();if(outcome==='hidden-return')page.contactReturn();
    h.app.onShow(ordinary);page.onShow();assert.equal(h.switches.length,outcome==='hidden-return'?0:1);page.onUnload();
  }
});

test('连续十次正常进入和原生返回不会累积页面订阅',()=>{
  const h=harness();h.startAtHome();const page=h.page(DETAIL,{publicationId:'fixture-old'});page.onShow();
  for(let index=0;index<10;index++){
    page.setData({posterPreview:'wxfile://isolated.png'});page.previewPoster();page.onHide();h.app.onHide();assert.equal(h.subscriptions,0);
    h.app.onShow(ordinary);page.onShow();assert.equal(h.subscriptions,1);assert.equal(h.switches.length,0);
  }
  page.onUnload();assert.equal(h.subscriptions,0);assert.equal(h.timerCount,0);
});

test('已卸载页面的迟到 switchTab 失败回调不得重新订阅或覆盖新页面',()=>{
  const h=harness();h.app.onShow(ordinary);const detail=h.page(DETAIL,{publicationId:'fixture-old'});detail.onShow();
  const pending=h.switches[0];detail.onUnload();const home=h.common(HOME);home.onShow();const before=h.views.length;
  pending.fail({errMsg:'isolated delayed failure'});
  assert.equal(h.views.length,before,'已卸载详情不得在失败回调中重新 setView');assert.equal(h.subscriptions,1);home.onUnload();
});

test('已隐藏页面的迟到 switchTab 失败回调不得抢走当前页面的数据视图',()=>{
  const h=harness();h.app.onShow(ordinary);const detail=h.page(DETAIL,{publicationId:'fixture-old'});detail.onShow();
  const pending=h.switches[0];detail.onHide();const news=h.common('pages/news/index',{view:'news'});news.onShow();const before=h.views.length;
  pending.fail({errMsg:'isolated delayed failure'});
  assert.equal(h.views.length,before,'后台详情不得在失败回调中重新 setView');assert.equal(h.subscriptions,1);news.onUnload();
});
