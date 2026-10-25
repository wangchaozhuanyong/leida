const HOME = 'pages/home/index';
// Only app-level entrances. Message cards, notifications and in-app links keep
// their explicit destination. See WeChat's LaunchShowOption scene definitions.
const homeScenes = new Set([1001,1017,1023,1024,1027,1054,1089,1090,1103,1104,1256,1257,1271,1273]);
const codeScenes = new Set([1011,1012,1013,1047,1048,1049]);
const queryKey=query=>JSON.stringify(Object.entries(query||{}).sort(([a],[b])=>a.localeCompare(b)));
function createEntryNavigation(wxApi) {
  let pendingHome=false, nativeReturn=null,entryKey='',entryScene;
  return {
    show(options={}) {
      const returning=nativeReturn;nativeReturn=null;
      const nextKey=JSON.stringify([options.scene,options.path,options.query||{}]);
      const path=(options.path||'').replace(/^\//,'');
      // Share-sheet returns may report the triggering page, not the original
      // launch path. Match its exact route/query and original scene only.
      const ownerReturn=returning?.owner&&returning.scene===options.scene&&path===returning.owner.route&&queryKey(options.query)===queryKey(returning.owner._params);
      // Native UI can reuse the original entrance scene. Consume this protection
      // once, before interpreting that scene as another launch from Recents.
      entryKey=nextKey;entryScene=options.scene;
      if(returning?.hidden&&(returning.entryKey===nextKey||ownerReturn)){pendingHome=false;return;}
      pendingHome=homeScenes.has(options.scene)||
        (codeScenes.has(options.scene)&&path==='pages/detail/index'&&typeof options.query?.scene==='string');
    },
    hide(){if(nativeReturn)nativeReturn.hidden=true;pendingHome=false;},
    preserveNativeReturn(owner){
      const token={hidden:false,owner,pageHidden:false,entryKey,scene:entryScene};nativeReturn=token;
      return {
        finish(){if(nativeReturn===token&&!token.hidden)nativeReturn=null;},
        cancel(){if(nativeReturn===token)nativeReturn=null;}
      };
    },
    // A new touch in our own page proves native UI is no longer on top, including
    // clients where opening/closing the image viewer causes no App lifecycle.
    touched(){nativeReturn=null;},
    pageHidden(page){if(nativeReturn?.owner===page)nativeReturn.pageHidden=true;},
    pageUnloaded(page){if(nativeReturn?.owner===page)nativeReturn=null;},
    enterPage(page,resume){
      if(nativeReturn?.owner&&(nativeReturn.owner!==page||nativeReturn.pageHidden&&!nativeReturn.hidden))nativeReturn=null;
      if(!pendingHome)return false;
      pendingHome=false;
      if(page.route===HOME)return false;
      try{wxApi.switchTab({url:'/'+HOME,fail(){
        wxApi.showToast?.({title:'返回首页失败，请点击底部首页',icon:'none'});resume();
      }});}catch(_){return false;}
      return true;
    }
  };
}
function preserveNativeReturn(){
  const navigation=typeof getApp==='function'&&getApp().entryNavigation;
  const pages=typeof getCurrentPages==='function'?getCurrentPages():[];
  return navigation?navigation.preserveNativeReturn(pages[pages.length-1]):{finish(){},cancel(){}};
}
function enterPage(page,resume){
  const generation=page._entryGeneration=(page._entryGeneration||0)+1;
  return getApp().entryNavigation?.enterPage(page,()=>{if(page._entryGeneration===generation)resume();})||false;
}
function suspendEntry(page,unload=false){
  page._entryGeneration=(page._entryGeneration||0)+1;
  const navigation=getApp().entryNavigation;
  if(unload)navigation?.pageUnloaded(page);else navigation?.pageHidden(page);
}
module.exports={createEntryNavigation,preserveNativeReturn,enterPage,suspendEntry};
