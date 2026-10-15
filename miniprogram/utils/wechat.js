const {configurationError,createWechatTransport}=require('./transport');
const labels={unavailable:'微信提醒暂不可用',none:'开启后接收重置消息',challenged:'点击确认开启提醒',available:'微信提醒已开启',reserved:'微信提醒已开启',consumed:'提醒次数已用完，可继续增加',rejected:'微信暂未允许提醒，可重新开启',revoked:'微信提醒已关闭',unknown:'提醒发送状态待确认，已暂停后续发送'};
const safeState=value=>({configured:value.configured,enabled:value.enabled,state:value.state,templateId:value.templateId,acceptedAt:value.acceptedAt,lastResult:value.lastResult,remainingCount:value.remainingCount,pendingCount:value.pendingCount});
function privacyRequired(wxApi){
  if(typeof wxApi.getPrivacySetting!=='function')return Promise.resolve(false);
  return new Promise((resolve,reject)=>wxApi.getPrivacySetting({success(result){resolve(!!result.needAuthorization);},fail(){reject(new Error('暂时无法读取隐私授权状态，请重试。'));}}));
}
/** Reader identity is obtained only through an explicit tap. Session stays in this closure. */
function createWechatReader({wxApi,config,now=()=>Date.now()}){
  const request=createWechatTransport(wxApi,config),listeners=new Set();
  let session,challenge,confirmation,pending,state={safe:null,busy:false,ready:false,error:'',privacyNeeded:false};
  const emit=patch=>{state={...state,...patch};listeners.forEach(fn=>fn(view()));};
  function view(){const remainingCount=state.safe?(state.safe.remainingCount??(['available','reserved'].includes(state.safe.state)?1:0)):null;return{...state,remainingCount,confirmNeeded:!!confirmation,label:state.safe?labels[state.safe.state]:'连接后查看已有提醒和剩余次数',canPrepare:!state.busy&&!state.ready&&state.safe?.state!=='unknown',canRevoke:!state.busy&&!!state.safe&&(remainingCount>0||state.safe.state==='unknown')};}
  async function login(){
    if(session&&Date.parse(session.expiresAt)>now())return;
    session=undefined;challenge=undefined;
    if(typeof wxApi.login!=='function')throw new Error('当前微信不支持登录，请更新微信。');
    const code=await new Promise((resolve,reject)=>wxApi.login({timeout:10000,success(result){result&&typeof result.code==='string'&&result.code?resolve(result.code):reject(new Error('微信登录暂时不可用，请重试。'));},fail(){reject(new Error('微信登录暂时不可用，请重试。'));}}));
    const result=await request('/api/wechat/login',{method:'POST',data:{code}}).promise;session=result.data;
  }
  async function rpc(path,options={}){const result=await request(path,{...options,sessionToken:session&&session.sessionToken}).promise;return result.data;}
  function failed(error){if(error.status===401){session=undefined;challenge=undefined;}emit({busy:false,ready:false,error:error.message||'微信提醒暂时无法读取。'});}
  function action(work,userInitiated,connectedOnly=false){
    if(!userInitiated){emit({error:'请点击微信提醒按钮后操作。'});return Promise.resolve();}
    if(pending)return pending;
    const problem=configurationError(config);if(problem){emit({error:problem});return Promise.resolve();}
    emit({busy:true,error:'',privacyNeeded:false});
    const promise=(async()=>{try{if(await privacyRequired(wxApi)){emit({busy:false,privacyNeeded:true,error:'请先阅读并同意隐私指引。'});return;}if(!connectedOnly)await login();await work();}catch(error){failed(error);}finally{emit({busy:false});}})();
    pending=promise;promise.finally(()=>{if(pending===promise)pending=undefined;});return promise;
  }
  async function refreshWork(){const safe=safeState(await rpc('/api/wechat/subscription'));challenge=undefined;emit({safe,ready:false});return safe;}
  async function prime(safe){
    if(!safe.configured||!safe.enabled||safe.state==='unknown')return;
    const result=await rpc('/api/wechat/subscription/challenge',{method:'POST'});
    const next=typeof result.state==='object'?safeState(result.state):{...safe,state:result.state};
    challenge=result.nonce?{nonce:result.nonce,templateId:result.templateId,expiresAt:result.expiresAt}:undefined;
    emit({safe:next,ready:!!challenge,...(!challenge&&['available','reserved'].includes(next.state)?{error:'服务正在更新，暂时不能增加提醒次数。'}:{})});
  }
  async function confirmChoice(){
    const selected=confirmation;if(!selected)return;
    let safe;
    try{safe=safeState(await rpc('/api/wechat/subscription/confirm',{method:'POST',data:selected}));}
    catch(error){if(error.status===409)confirmation=undefined;throw error;}
    confirmation=undefined;emit({safe});
    if(selected.result==='accept')try{await prime(safe);}catch(_){emit({ready:false,error:'本次次数已记录，稍后可继续增加。'});}
  }
  return{
    subscribe(fn){listeners.add(fn);fn(view());return()=>listeners.delete(fn);},getState:view,
    prepare({userInitiated=false}={}){return action(async()=>{if(confirmation){await confirmChoice();return;}await prime(await refreshWork());},userInitiated);},
    refresh({userInitiated=false}={}){return action(refreshWork,userInitiated);},
    refreshConnected(){if(!session||Date.parse(session.expiresAt)<=now()||pending)return Promise.resolve();return action(async()=>{const prepared=challenge,safe=await refreshWork();if(confirmation||safe.state==='revoked'||safe.state==='unknown')return;if(prepared&&Date.parse(prepared.expiresAt)>now()&&prepared.templateId===safe.templateId){challenge=prepared;emit({ready:true});}else await prime(safe);},true,true);},
    retryConfirmation({userInitiated=false}={}){return action(confirmChoice,userInitiated);},
    revoke({userInitiated=false}={}){return action(async()=>{const safe=safeState(await rpc('/api/wechat/subscription',{method:'DELETE'}));challenge=undefined;confirmation=undefined;emit({safe,ready:false});},userInitiated);},
    authorize({userInitiated=false}={}){
      if(!userInitiated||!challenge||state.busy){emit({error:'请先点击开启微信提醒，准备本次订阅。'});return Promise.resolve();}
      if(Date.parse(challenge.expiresAt)<=now()){challenge=undefined;emit({ready:false,error:'本次订阅准备已过期，请重新开启。'});return Promise.resolve();}
      if(typeof wxApi.requestSubscribeMessage!=='function'){emit({error:'当前微信不支持订阅消息，请更新微信。'});return Promise.resolve();}
      const selected=challenge;challenge=undefined;emit({busy:true,ready:false,error:''});
      // Invoke authorization synchronously in this tap, before any network await.
      const choice=new Promise((resolve,reject)=>wxApi.requestSubscribeMessage({tmplIds:[selected.templateId],success(result){const value=result&&result[selected.templateId];['accept','reject','ban','filter'].includes(value)?resolve(value):reject(new Error('微信未返回明确订阅选择，请重新准备。'));},fail(){reject(new Error('微信订阅未完成，请稍后重新准备。'));}}));
      const work=(async()=>{let chosen=false;try{const result=await choice;chosen=true;confirmation={nonce:selected.nonce,templateId:selected.templateId,result};await confirmChoice();}
        catch(error){if(chosen&&error.status!==401)emit({error:'这次提醒次数尚未确认，请点击重试。'});else failed(error);}finally{emit({busy:false});}})();
      pending=work;work.finally(()=>{if(pending===work)pending=undefined;});return work;
    },
    clearSession(){session=undefined;challenge=undefined;confirmation=undefined;emit({safe:null,ready:false,error:'',privacyNeeded:false});}
  };
}
module.exports={privacyRequired,createWechatReader};
