const {configurationError,createWechatTransport}=require('./transport');
const {preserveNativeReturn}=require('./entry-navigation');
const labels={unavailable:'微信提醒暂不可用',none:'开启后接收重置消息',challenged:'开启后接收重置消息',available:'微信提醒已开启',reserved:'微信提醒已开启',consumed:'提醒次数已用完，可继续增加',rejected:'微信暂未允许提醒，可重新开启',revoked:'微信提醒已关闭',unknown:'上次发送未确认，可重新授权增加提醒'};
const reminderKeys=['announcement','result','correction'];
const reminderPreferences=value=>Object.fromEntries(reminderKeys.map(key=>[key,value?.[key]!==false]));
const safeState=value=>({configured:value.configured,enabled:value.enabled,state:value.state,templateId:value.templateId,acceptedAt:value.acceptedAt,lastResult:value.lastResult,remainingCount:value.remainingCount,pendingCount:value.pendingCount,preferencesSupported:value.preferencesSupported===true,reminderPreferences:reminderPreferences(value.reminderPreferences)});
function privacyRequired(wxApi){
  if(typeof wxApi.getPrivacySetting!=='function')return Promise.resolve(false);
  return new Promise((resolve,reject)=>wxApi.getPrivacySetting({success(result){resolve(!!result.needAuthorization);},fail(){reject(new Error('暂时无法读取隐私授权状态，请重试。'));}}));
}
/** Opening the reminder page may connect its reader; only an explicit tap may subscribe. */
function createWechatReader({wxApi,config,now=()=>Date.now()}){
  const request=createWechatTransport(wxApi,config),listeners=new Set();
  let lastConnectedCheck=-Infinity, generation=0;
  let session,challenge,confirmation,pending,state={safe:null,busy:false,refreshing:false,ready:false,error:'',privacyNeeded:false,preferencesMessage:'',preferencesUncertain:false};
  const emit=patch=>{state={...state,...patch};listeners.forEach(fn=>fn(view()));};
  const sessionValid=()=>!!session&&Date.parse(session.expiresAt)>now();
  const challengeValid=(margin=0)=>sessionValid()&&!!challenge&&Date.parse(challenge.expiresAt)>now()+margin&&challenge.templateId===state.safe?.templateId;
  function view(){const remainingCount=state.safe?(state.safe.remainingCount??(['available','reserved'].includes(state.safe.state)?1:0)):null;const preferences=reminderPreferences(state.safe?.reminderPreferences);return{...state,reminderPreferences:preferences,allTypesOff:!!state.safe&&reminderKeys.every(key=>!preferences[key]),canChooseTypes:!!state.safe?.preferencesSupported&&!state.busy&&!state.privacyNeeded&&!state.preferencesUncertain,ready:state.ready&&challengeValid(),remainingCount,confirmNeeded:!!confirmation,label:state.safe?labels[state.safe.state]:'加载中',canPrepare:!state.busy&&!state.ready,canRevoke:!!state.safe&&(remainingCount>0||state.safe.state==='unknown')};}
  async function login(){
    if(session&&Date.parse(session.expiresAt)>now())return;
    session=undefined;challenge=undefined;
    if(typeof wxApi.login!=='function')throw new Error('当前微信不支持登录，请更新微信。');
    const code=await new Promise((resolve,reject)=>wxApi.login({timeout:10000,success(result){result&&typeof result.code==='string'&&result.code?resolve(result.code):reject(new Error('微信登录暂时不可用，请重试。'));},fail(){reject(new Error('微信登录暂时不可用，请重试。'));}}));
    const result=await request('/api/wechat/login',{method:'POST',data:{code}}).promise;session=result.data;
  }
  async function rpc(path,options={}){const version=generation,result=await request(path,{...options,sessionToken:session&&session.sessionToken}).promise;if(version!==generation){const stale=new Error('旧读取已失效');stale.obsolete=true;throw stale;}return result.data;}
  function failed(error){if(error.obsolete)return;if(error.status===401){session=undefined;challenge=undefined;}emit({busy:false,ready:false,error:error.message||'微信提醒暂时无法读取。'});}
  function action(work,userInitiated,connectedOnly=false,background=false){
    if(!userInitiated){emit({error:'请点击微信提醒按钮后操作。'});return Promise.resolve();}
    if(pending)return !background&&state.refreshing?pending.then(()=>action(work,userInitiated,connectedOnly,background)):pending;
    const problem=configurationError(config);if(problem){emit({error:problem});return Promise.resolve();}
    const version=generation;emit(background?{busy:!state.safe,refreshing:!!state.safe,error:''}:{busy:true,error:'',privacyNeeded:false});
    const promise=(async()=>{try{const privacy=await privacyRequired(wxApi);if(version!==generation)return;if(privacy){emit({busy:false,privacyNeeded:true,error:'请先阅读并同意隐私指引。'});return;}if(!connectedOnly)await login();if(version!==generation)return;await work();}catch(error){if(version===generation)failed(error);}finally{if(version===generation)emit({refreshing:false,busy:false});}})();
    pending=promise;promise.finally(()=>{if(pending===promise)pending=undefined;});return promise;
  }
  function displayState(safe){
    // Preparing a nonce must not make a closed or declined reminder appear enabled.
    if(['none','challenged'].includes(safe.state)&&!safe.remainingCount&&['revoked','rejected'].includes(state.safe?.state))return{...safe,state:state.safe.state};
    return safe;
  }
  function acceptState(safe,patch={}){
    const blocked=!safe.configured||!safe.enabled||safe.state==='unknown';
    if(blocked)challenge=undefined;
    emit({safe,preferencesUncertain:false,preferencesMessage:'',...patch,...(blocked?{ready:false}:{})});
  }
  async function refreshWork(){const safe=displayState(safeState(await rpc('/api/wechat/subscription')));lastConnectedCheck=now();acceptState(safe);return safe;}
  async function prime(safe){
    if(!safe.configured||!safe.enabled)return;
    const result=await rpc('/api/wechat/subscription/challenge',{method:'POST'});
    const next=displayState(typeof result.state==='object'?safeState(result.state):{...safe,state:result.state});
    challenge=result.nonce?{nonce:result.nonce,templateId:result.templateId,expiresAt:result.expiresAt}:undefined;
    emit({safe:next,ready:!!challenge,...(!challenge&&next.state==='unknown'?{error:'暂时无法准备授权，请稍后重试。'}:!challenge&&['available','reserved'].includes(next.state)?{error:'服务正在更新，暂时不能增加提醒次数。'}:{})});
  }
  async function confirmChoice(){
    const selected=confirmation;if(!selected)return;
    let safe;
    try{safe=safeState(await rpc('/api/wechat/subscription/confirm',{method:'POST',data:selected}));}
    catch(error){if(error.status===409)confirmation=undefined;throw error;}
    confirmation=undefined;acceptState(safe);
    if(selected.result==='accept')try{await prime(safe);}catch(_){emit({ready:false,error:'本次次数已记录，稍后可继续增加。'});}
  }
  return{
    subscribe(fn){listeners.add(fn);fn(view());return()=>listeners.delete(fn);},getState:view,
    loadForPage(){
      // Only the visible reminder page calls this. Never request subscription or
      // retry an uncertain confirmation here, including after a page re-entry.
      if(pending)return pending;
      if(confirmation)return Promise.resolve();
      const refresh=!sessionValid()||!state.safe||!!state.error||state.preferencesUncertain||now()-lastConnectedCheck>=300000;
      if(!refresh&&!state.privacyNeeded&&(challengeValid(30000)||!state.safe.configured||!state.safe.enabled))return Promise.resolve();
      return action(async()=>{
        const prepared=challenge,safe=refresh?await refreshWork():state.safe;
        if(safe.configured&&safe.enabled&&!['unknown','revoked'].includes(safe.state)&&prepared&&prepared.templateId===safe.templateId&&Date.parse(prepared.expiresAt)>now()+30000){challenge=prepared;emit({ready:true});}
        else await prime(safe);
      },true,false,true);
    },
    nextRefreshDelay(){
      if(state.error||state.privacyNeeded||confirmation||!session)return 300000;
      const deadline=Math.min(lastConnectedCheck+300000,Date.parse(session.expiresAt),challenge?Date.parse(challenge.expiresAt)-30000:Infinity);
      return Math.max(1000,Math.min(300000,deadline-now()));
    },
    prepare({userInitiated=false}={}){return action(async()=>{if(confirmation){await confirmChoice();return;}await prime(await refreshWork());},userInitiated);},
    refresh({userInitiated=false}={}){return action(refreshWork,userInitiated);},
    refreshConnected(){if(now()-lastConnectedCheck<300000||!session||Date.parse(session.expiresAt)<=now()||pending)return Promise.resolve();lastConnectedCheck=now();return action(async()=>{const prepared=challenge,safe=await refreshWork();if(confirmation||safe.state==='revoked')return;if(safe.state!=='unknown'&&prepared&&Date.parse(prepared.expiresAt)>now()&&prepared.templateId===safe.templateId){challenge=prepared;emit({ready:true});}else await prime(safe);},true,true,true);},
    retryConfirmation({userInitiated=false}={}){return action(confirmChoice,userInitiated);},
    savePreferences(preferences,{userInitiated=false}={}){
      return action(async()=>{
        if(!state.safe?.preferencesSupported)throw new Error('提醒类型暂不可设置，请稍后重新加载。');
        if(!preferences||reminderKeys.some(key=>typeof preferences[key]!=='boolean')||Object.keys(preferences).some(key=>!reminderKeys.includes(key)))throw new Error('请选择有效的提醒类型。');
        emit({preferencesMessage:''});
        try {
          const safe=safeState(await rpc('/api/wechat/subscription/preferences',{method:'POST',data:reminderPreferences(preferences)}));
          if(!safe.preferencesSupported)throw new Error('提醒类型设置未得到确认。');
          acceptState(safe,{preferencesMessage:'已保存'});
        } catch(error) {
          emit({preferencesUncertain:true});
          const failure=new Error('提醒类型是否保存尚未确认，请重新加载后核对。');failure.status=error.status;throw failure;
        }
      },userInitiated);
    },
    revoke({userInitiated=false}={}){return action(async()=>{const safe=safeState(await rpc('/api/wechat/subscription',{method:'DELETE'}));challenge=undefined;confirmation=undefined;acceptState(safe,{ready:false});},userInitiated);},
    authorize({userInitiated=false}={}){
      if(state.preferencesUncertain||!state.safe?.configured||!state.safe?.enabled){challenge=undefined;emit({ready:false,error:'请重新加载提醒状态后再开启。'});return Promise.resolve();}
      if(!userInitiated||!challenge||state.busy){emit({error:'请先点击开启微信提醒，准备本次订阅。'});return Promise.resolve();}
      if(Date.parse(challenge.expiresAt)<=now()){challenge=undefined;emit({ready:false,error:'本次订阅准备已过期，请重新开启。'});return Promise.resolve();}
      if(typeof wxApi.requestSubscribeMessage!=='function'){emit({error:'当前微信不支持订阅消息，请更新微信。'});return Promise.resolve();}
      const selected=challenge;++generation;challenge=undefined;emit({busy:true,refreshing:false,ready:false,error:''});
      // Invoke authorization synchronously in this tap, before any network await.
      const choice=new Promise((resolve,reject)=>{
        const guard=preserveNativeReturn();
        try{wxApi.requestSubscribeMessage({tmplIds:[selected.templateId],success(result){guard.finish();const value=result&&result[selected.templateId];['accept','reject','ban','filter'].includes(value)?resolve(value):reject(new Error('微信未返回明确订阅选择，请重新准备。'));},fail(){guard.cancel();reject(new Error('微信订阅未完成，请稍后重新准备。'));}});}catch(error){guard.cancel();reject(error);}
      });
      const work=(async()=>{let chosen=false;try{const result=await choice;chosen=true;confirmation={nonce:selected.nonce,templateId:selected.templateId,result};await confirmChoice();}
        catch(error){if(chosen&&error.status!==401)emit({error:'这次提醒次数尚未确认，请点击重试。'});else failed(error);}finally{emit({busy:false});}})();
      pending=work;work.finally(()=>{if(pending===work)pending=undefined;});return work;
    },
    clearSession(){++generation;session=undefined;challenge=undefined;confirmation=undefined;emit({safe:null,busy:false,refreshing:false,ready:false,error:'',privacyNeeded:false,preferencesMessage:'',preferencesUncertain:false});}
  };
}
module.exports={privacyRequired,createWechatReader};
