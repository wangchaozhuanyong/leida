import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createAppUpdate}=require('../miniprogram/utils/app-update.js');
function fixture(){
  let downloaded=()=>{},applied=0;
  const dialogs:any[]=[];
  const update=createAppUpdate({getUpdateManager(){return{onUpdateReady(callback:()=>void){downloaded=callback;},applyUpdate(){applied++;}};},showModal(options:any){dialogs.push(options);}});
  return {update,dialogs,downloaded(){downloaded();},get applied(){return applied;}};
}
test('新包未准备好不提示，准备好后仅由用户确认触发更新',()=>{
  const h=fixture();h.update.show();assert.equal(h.dialogs.length,0);
  h.downloaded();assert.equal(h.dialogs.length,1);assert.equal(h.applied,0);
  h.dialogs[0].success({confirm:true});assert.equal(h.applied,1);
});
test('后台下载不弹窗，回前台后提示，取消后切页不重复打扰',()=>{
  const h=fixture();h.update.show();h.update.hide();h.downloaded();assert.equal(h.dialogs.length,0);
  h.update.show();assert.equal(h.dialogs.length,1);h.dialogs[0].success({confirm:false});
  h.downloaded();h.update.hide();h.update.show();assert.equal(h.dialogs.length,1);assert.equal(h.applied,0);
});
test('进入后台后的迟到确认不得重启隐藏的小程序',()=>{
  const h=fixture();h.update.show();h.downloaded();h.update.hide();h.dialogs[0].success({confirm:true});assert.equal(h.applied,0);
});
test('旧微信或SDK异常不影响前后台导航',()=>{
  for(const wx of [{},{getUpdateManager(){throw Error('unsupported');}},{getUpdateManager(){return{};}}]){
    const update=createAppUpdate(wx);assert.doesNotThrow(()=>{update.show();update.hide();});
  }
});
