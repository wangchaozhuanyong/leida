const {configurationError,createWechatTransport}=require('./transport');
const labels={unavailable:'尚未配置微信提醒',none:'尚未选择订阅',challenged:'等待本次订阅选择',available:'已记录本次订阅选择，实际发送以微信结果为准',reserved:'本次提醒正在处理',consumed:'本次提醒额度已使用，可重新选择订阅',rejected:'本次订阅未获准，可重新选择',revoked:'本站微信提醒已关闭',unknown:'发送结果待核，不会自动重新授权或重发'};
const safeState=value=>({configured:value.configured,enabled:value.enabled,state:value.state,templateId:value.templateId,acceptedAt:value.acceptedAt,lastResult:value.lastResult});
function privacyRequired(wxApi){
  if(typeof wxApi.getPrivacySetting!=='function')return Promise.resolve(false);
  return new Promise((resolve,reject)=>wxApi.getPrivacySetting({success(result){resolve(!!result.needAuthorization);},fail(){reject(new Error('暂时无法读取隐私授权状态，请重试。'));}}));
}
/** Reader identity is obtained only through an explicit tap. Session stays in this closure. */
function createWechatReader({wxApi,config,now=()=>Date.now()}){
  const request=createWechatTransport(wxApi,config),listeners=new Set();
  let session,challenge,pending,state={safe:null,busy:false,ready:false,error:'',privacyNeeded:false};
  const emit=patch=>{state={...state,...patch};listeners.forEach(fn=>fn(view()));};
  function view(){return{...state,label:state.safe?labels[state.safe.state]:'点击后连接微信提醒',canPrepare:!state.busy&&!state.ready&&(!state.safe||!['available','reserved','unknown'].includes(state.safe.state)),canRevoke:!state.busy&&!!state.safe&&state.safe.state!=='unavailable'&&state.safe.state!=='revoked'};}
  async function login(){
    if(session&&Date.parse(session.expiresAt)>now())return;
    session=undefined;challenge=undefined;
    if(typeof wxApi.login!=='function')throw new Error('当前微信不支持登录，请更新微信。');
    const code=await new Promise((resolve,reject)=>wxApi.login({timeout:10000,success(result){result&&typeof result.code==='string'&&result.code?resolve(result.code):reject(new Error('微信登录暂时不可用，请重试。'));},fail(){reject(new Error('微信登录暂时不可用，请重试。'));}}));
    const result=await request('/api/wechat/login',{method:'POST',data:{code}}).promise;session=result.data;
  }
  async function rpc(path,options={}){const result=await request(path,{...options,sessionToken:session&&session.sessionToken}).promise;return result.data;}
  function failed(error){if(error.status===401){session=undefined;challenge=undefined;}emit({busy:false,ready:false,error:error.message||'微信提醒暂时无法读取。'});}
  function action(work,userInitiated){
    if(!userInitiated){emit({error:'请点击微信提醒按钮后操作。'});return Promise.resolve();}
    if(pending)return pending;
    const problem=configurationError(config);if(problem){emit({error:problem});return Promise.resolve();}
    emit({busy:true,error:'',privacyNeeded:false});
    const promise=(async()=>{try{if(await privacyRequired(wxApi)){emit({busy:false,privacyNeeded:true,error:'请先阅读并同意隐私指引。'});return;}await login();await work();}catch(error){failed(error);}finally{emit({busy:false});}})();
    pending=promise;promise.finally(()=>{if(pending===promise)pending=undefined;});return promise;
  }
  async function refreshWork(){const safe=safeState(await rpc('/api/wechat/subscription'));challenge=undefined;emit({safe,ready:false});return safe;}
  return{
    subscribe(fn){listeners.add(fn);fn(view());return()=>listeners.delete(fn);},getState:view,
    prepare({userInitiated=false}={}){return action(async()=>{const safe=await refreshWork();if(!safe.configured||!safe.enabled||['available','reserved','unknown'].includes(safe.state))return;
      const result=await rpc('/api/wechat/subscription/challenge',{method:'POST'});
      const next=typeof result.state==='object'?safeState(result.state):{...safe,state:result.state};
      challenge=result.nonce?{nonce:result.nonce,templateId:result.templateId,expiresAt:result.expiresAt}:undefined;
      emit({safe:next,ready:!!challenge});
    },userInitiated);},
    refresh({userInitiated=false}={}){return action(refreshWork,userInitiated);},
    revoke({userInitiated=false}={}){return action(async()=>{const safe=safeState(await rpc('/api/wechat/subscription',{method:'DELETE'}));challenge=undefined;emit({safe,ready:false});},userInitiated);},
    authorize({userInitiated=false}={}){
      if(!userInitiated||!challenge||state.busy){emit({error:'请先点击开启微信提醒，准备本次订阅。'});return Promise.resolve();}
      if(Date.parse(challenge.expiresAt)<=now()){challenge=undefined;emit({ready:false,error:'本次订阅准备已过期，请重新开启。'});return Promise.resolve();}
      if(typeof wxApi.requestSubscribeMessage!=='function'){emit({error:'当前微信不支持订阅消息，请更新微信。'});return Promise.resolve();}
      const selected=challenge;challenge=undefined;emit({busy:true,ready:false,error:''});
      // Invoke authorization synchronously in this tap, before any network await.
      const choice=new Promise((resolve,reject)=>wxApi.requestSubscribeMessage({tmplIds:[selected.templateId],success(result){const value=result&&result[selected.templateId];['accept','reject','ban','filter'].includes(value)?resolve(value):reject(new Error('微信未返回明确订阅选择，请重新准备。'));},fail(){reject(new Error('微信订阅未完成，请稍后重新准备。'));}}));
      const work=(async()=>{let chosen=false;try{const result=await choice;chosen=true;const safe=safeState(await rpc('/api/wechat/subscription/confirm',{method:'POST',data:{nonce:selected.nonce,templateId:selected.templateId,result}}));emit({safe});}
        catch(error){if(chosen&&error.status!==401)emit({error:'本站尚未确认本次选择，请刷新授权状态。'});else failed(error);}finally{emit({busy:false});}})();
      pending=work;work.finally(()=>{if(pending===work)pending=undefined;});return work;
    },
    clearSession(){session=undefined;challenge=undefined;emit({safe:null,ready:false,error:'',privacyNeeded:false});}
  };
}
module.exports={privacyRequired,createWechatReader};
