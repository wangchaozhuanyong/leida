import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';
import type {PublicData,Publication} from '../src/lib/types';
const require=createRequire(import.meta.url);
const {createTransport,createWechatTransport}=require('../miniprogram/utils/transport.js');
const {createWechatReader,privacyRequired}=require('../miniprogram/utils/wechat.js');
const config={mode:'https',baseUrl:'https://public.example.org',cloudEnv:'',serviceName:'',timeoutMs:10000};
const now=Date.parse('2026-10-10T04:00:00Z'),scene='a'.repeat(32);
const safe=(state='none')=>({configured:true,enabled:true,state,templateId:'fixture-template'});
type Options=Record<string,any>;
function mock(options:{state?:string;challengeState?:string;result?:string;privacy?:boolean;failConfirm?:boolean;failState?:boolean;failRevoke?:boolean;codeStatus?:number;sessionMs?:number;challengeMs?:number;legacyPreferences?:boolean;failPreferencesAfterSave?:boolean;invalidPreferences?:boolean;cancelRevoke?:boolean;loginSnapshot?:boolean;invalidLoginSnapshot?:boolean}={}){
  let state=options.state||'none',login=0,subscribe=0,clock=now,count=['available','reserved'].includes(state)?1:0,challenges=0;
  let preferences={announcement:true,result:true,correction:true};
  const confirmed=new Set<string>();const current=()=>({...safe(state),remainingCount:count,pendingCount:state==='reserved'?1:0,...(options.legacyPreferences?{}:{preferencesSupported:true,reminderPreferences:options.invalidPreferences?{...preferences,result:'yes'}:preferences})});
  const requests:Options[]=[];
  const wx={
    showModal(option:Options){queueMicrotask(()=>option.success({confirm:!options.cancelRevoke,cancel:!!options.cancelRevoke}));},
    login(option:Options){login++;queueMicrotask(()=>option.success({code:'fixture-login-code'}));},
    getPrivacySetting(option:Options){queueMicrotask(()=>option.success({needAuthorization:!!options.privacy}));},
    requestSubscribeMessage(option:Options){subscribe++;queueMicrotask(()=>option.success({[option.tmplIds[0]]:options.result||'accept'}));},
    request(option:Options){requests.push(option);queueMicrotask(()=>{
      const path=option.url.replace(config.baseUrl,'');let response:unknown;
      if(path==='/api/wechat/login')response={sessionToken:'fixture-reader-session',expiresAt:new Date(clock+(options.sessionMs||60000)).toISOString(),...(options.loginSnapshot?{subscriptionState:options.invalidLoginSnapshot?{...current(),remainingCount:-1}:{...current(),extraPrivateField:'must-not-reach-ui'}}:{})};
      else if(path==='/api/wechat/subscription'){
        if(options.failState){option.success({statusCode:401,data:{error:'当前读者会话已失效，请重新连接。'}});return;}
        if(option.method==='DELETE'){if(options.failRevoke){option.fail({});return;}state='revoked';count=0;}response=current();
      }else if(path.endsWith('/preferences')){preferences={...option.data};if(options.failPreferencesAfterSave){option.fail({});return;}response=current();}
      else if(path.endsWith('/challenge')){challenges++;const s=options.challengeState;response={state:s||current(),templateId:'fixture-template',...(s&&['available','reserved','unknown'].includes(s)?{}:{nonce:`fixture-nonce-${challenges}`,expiresAt:new Date(clock+(options.challengeMs||30000)).toISOString()})};}
      else if(path.endsWith('/confirm')){if(options.failConfirm){option.fail({errMsg:'internal-detail'});return;}if(!confirmed.has(option.data.nonce)){confirmed.add(option.data.nonce);if(option.data.result==='accept')count++;}state=count?'available':'rejected';response={...current(),acceptedAt:option.data.result==='accept'?new Date(clock).toISOString():undefined,extraPrivateField:'must-not-reach-ui'};}
      else if(path.startsWith('/api/v1/wechat/scene/'))response={publicationId:'fixture-publication'};
      else if(path.startsWith('/api/v1/wechat/code/')){if(options.codeStatus){option.success({statusCode:options.codeStatus,data:{error:options.codeStatus===503?'后台尚未配置微信小程序码。':'该版本已撤回。'}});return;}response={publicationId:'fixture-publication',scene,imageBase64:'iVBORw0KGgo=',contentType:'image/png'};}
      else {option.success({statusCode:404,data:{error:'未找到接口'}});return;}
      option.success({statusCode:200,data:{data:response}});
    });return{abort(){}};}
  };
  const reader=createWechatReader({wxApi:wx,config,now:()=>clock});
  return{wx,reader,requests,get login(){return login;},get subscribe(){return subscribe;},freshReader(){return createWechatReader({wxApi:wx,config,now:()=>clock});},advance(ms:number){clock+=ms;},changeState(value:string){state=value;if(['none','consumed','revoked'].includes(value))count=0;}};
}

test('创建应用、读取本地状态和无点击调用均不登录，不保存读者会话',async()=>{
  const h=mock();let snapshot:unknown;const off=h.reader.subscribe((value:unknown)=>{snapshot=value;});
  assert.ok(snapshot);assert.equal(h.login,0);assert.equal(h.requests.length,0);
  await h.reader.prepare();assert.equal(h.login,0);assert.equal(h.requests.length,0);assert.match(h.reader.getState().error,/点击/);
  assert.doesNotMatch(JSON.stringify(h.reader.getState()),/sessionToken|nonce|fixture-reader-session|openid/);off();
});

test('准备只获取登录/状态/nonce，不弹订阅；授权点击同步调用微信，再按真实服务返回显示',async()=>{
  const h=mock();await h.reader.prepare({userInitiated:true});
  assert.equal(h.login,1);assert.equal(h.subscribe,0);assert.equal(h.reader.getState().ready,true);
  const promise=h.reader.authorize({userInitiated:true});assert.equal(h.subscribe,1,'授权在点击函数返回前同步发起');await promise;
  assert.equal(h.reader.getState().safe.state,'available');assert.equal(h.reader.getState().ready,true);assert.equal(h.reader.getState().remainingCount,1);
  assert.equal(h.reader.getState().label,'微信提醒已开启');
  assert.doesNotMatch(JSON.stringify(h.reader.getState()),/永久|已送达|sessionToken|nonce|extraPrivateField/);
  const confirm=h.requests.find(item=>item.url.endsWith('/confirm'))!;assert.deepEqual(confirm.data,{nonce:'fixture-nonce-1',templateId:'fixture-template',result:'accept'});
  assert.equal(confirm.header.Authorization,'Bearer fixture-reader-session');
});

test('同一点击进行中不重复弹窗或确认；准备下一次不会自行调用微信授权',async()=>{
  const h=mock();await Promise.all([h.reader.prepare({userInitiated:true}),h.reader.prepare({userInitiated:true})]);assert.equal(h.login,1);
  await Promise.all([h.reader.authorize({userInitiated:true}),h.reader.authorize({userInitiated:true})]);assert.equal(h.subscribe,1);
  await h.reader.prepare({userInitiated:true});assert.equal(h.subscribe,1);assert.equal(h.requests.filter(item=>item.url.endsWith('/challenge')).length,3);
  assert.equal(h.requests.filter(item=>item.url.endsWith('/confirm')).length,1);
});

test('拒绝、封禁、过滤按微信返回原样报告，不能伪造accept或仍显示授权可用',async()=>{
  for(const result of ['reject','ban','filter']){const h=mock({result});await h.reader.prepare({userInitiated:true});await h.reader.authorize({userInitiated:true});assert.equal(h.requests.find(item=>item.url.endsWith('/confirm'))!.data.result,result);assert.equal(h.reader.getState().safe.state,'rejected');assert.equal(h.reader.getState().ready,false);}
});

test('已有次数和未知结果允许新授权；旧服务器无nonce时绝不弹窗',async()=>{
  for(const state of ['available','reserved','unknown']){
    const h=mock({state});await h.reader.prepare({userInitiated:true});await h.reader.authorize({userInitiated:true});assert.equal(h.subscribe,1);assert.equal(h.requests.some(item=>item.url.endsWith('/challenge')),true);
    const race=mock({challengeState:state});await race.reader.prepare({userInitiated:true});if(state==='unknown')assert.match(race.reader.getState().error,/稍后重试/);await race.reader.authorize({userInitiated:true});assert.equal(race.subscribe,0);assert.equal(race.reader.getState().safe.state,state);
  }
});

test('unknown即使用户关闭后再次准备，也服从服务端无nonce结果，不重新创造额度',async()=>{
  const h=mock({state:'unknown',challengeState:'unknown'});await h.reader.refresh({userInitiated:true});await h.reader.revoke({userInitiated:true});await h.reader.prepare({userInitiated:true});
  assert.equal(h.reader.getState().safe.state,'unknown');assert.equal(h.reader.getState().ready,false);assert.equal(h.subscribe,0);
});

test('订阅结果网络不确定不自动重确认、不重弹，明确提示刷新核对',async()=>{
  const h=mock({failConfirm:true});await h.reader.prepare({userInitiated:true});await h.reader.authorize({userInitiated:true});
  assert.match(h.reader.getState().error,/尚未确认/);assert.equal(h.subscribe,1);assert.equal(h.requests.filter(item=>item.url.endsWith('/confirm')).length,1);
  assert.notEqual(h.reader.getState().safe.state,'available');
});

test('三次主动点击各自调用微信，累计到三次；下一次准备不自行增加次数',async()=>{
  const h=mock();await h.reader.prepare({userInitiated:true});
  for(let count=1;count<=3;count++){
    const work=h.reader.authorize({userInitiated:true});assert.equal(h.subscribe,count);await work;
    assert.equal(h.reader.getState().remainingCount,count);assert.equal(h.reader.getState().ready,true);
  }
  assert.equal(h.requests.filter(request=>request.url.endsWith('/confirm')).length,3);
  assert.equal(h.requests.filter(request=>request.url.endsWith('/challenge')).length,4);
  await h.reader.revoke({userInitiated:true});assert.equal(h.reader.getState().remainingCount,0);assert.equal(h.reader.getState().ready,false);
});

test('确认失败后主动重试同一个nonce，不能再次弹微信或重复增加次数',async()=>{
  const options={failConfirm:true},h=mock(options);await h.reader.prepare({userInitiated:true});await h.reader.authorize({userInitiated:true});
  assert.equal(h.reader.getState().confirmNeeded,true);assert.equal(h.reader.getState().remainingCount,0);
  options.failConfirm=false;await h.reader.retryConfirmation({userInitiated:true});
  assert.equal(h.reader.getState().remainingCount,1);assert.equal(h.subscribe,1);
  const requests=h.requests.filter(request=>request.url.endsWith('/confirm'));assert.equal(requests.length,2);assert.deepEqual(requests[0].data,requests[1].data);
  await h.reader.retryConfirmation({userInitiated:true});assert.equal(h.reader.getState().remainingCount,1);assert.equal(h.subscribe,1);
});

test('仅同步已连接会话的兼容入口不会在未连接或过期时自动登录或授权',async()=>{
  const h=mock({sessionMs:600000});await h.reader.refreshConnected();assert.equal(h.login,0);assert.equal(h.requests.length,0);
  await h.reader.prepare({userInitiated:true});await h.reader.authorize({userInitiated:true});
  h.changeState('consumed');const before=h.requests.length;await h.reader.refreshConnected();assert.equal(h.requests.length,before);h.advance(300000);await h.reader.refreshConnected();assert.equal(h.reader.getState().remainingCount,0);assert.equal(h.subscribe,1);assert.equal(h.login,1);
  const count=h.requests.length;h.advance(600001);await h.reader.refreshConnected();assert.equal(h.requests.length,count);assert.equal(h.login,1);
});

test('隐私未同意时停止登录与授权；模板准备过期不弹窗',async()=>{
  const blocked=mock({privacy:true});await blocked.reader.prepare({userInitiated:true});assert.equal(blocked.login,0);assert.equal(blocked.reader.getState().privacyNeeded,true);assert.equal(blocked.requests.length,0);
  const h=mock();await h.reader.prepare({userInitiated:true});h.advance(30001);await h.reader.authorize({userInitiated:true});assert.equal(h.subscribe,0);assert.match(h.reader.getState().error,/过期/);
  assert.equal(await privacyRequired({}),false);
});

test('会话过期及401后仅主动点击才重新wx.login，新实例没有持久会话',async()=>{
  const h=mock();await h.reader.refresh({userInitiated:true});await h.reader.refresh({userInitiated:true});assert.equal(h.login,1);
  h.advance(60001);assert.equal(h.login,1);await h.reader.refresh({userInitiated:true});assert.equal(h.login,2);
  h.reader.clearSession();assert.doesNotMatch(JSON.stringify(h.reader.getState()),/fixture-reader-session/);await h.reader.refresh({userInitiated:true});assert.equal(h.login,3);
  const unauthorized=mock({failState:true});await unauthorized.reader.refresh({userInitiated:true});assert.equal(unauthorized.login,1);await unauthorized.reader.refresh({userInitiated:true});assert.equal(unauthorized.login,2);
});

test('公共scene/code无需读者登录，固定pub与32hex合同核验，公私路径及bearer严格分开',async()=>{
  const h=mock(),publicRequest=createTransport(h.wx,config),privateRequest=createWechatTransport(h.wx,config);
  const resolved=await publicRequest(`/api/v1/wechat/scene/${scene}`).promise;assert.equal(resolved.data.publicationId,'fixture-publication');
  const code=await publicRequest('/api/v1/wechat/code/fixture-publication',{sessionToken:'must-not-go-public'}).promise;assert.equal(code.data.publicationId,'fixture-publication');assert.equal(h.login,0);
  assert.equal(h.requests.every(item=>!item.header.Authorization),true);
  await assert.rejects(publicRequest('/api/wechat/subscription').promise,/暂时无法打开/);
  await assert.rejects(privateRequest(`/api/v1/wechat/scene/${scene}`,{sessionToken:'fixture-reader-session'}).promise,/暂时无法打开/);
  await assert.rejects(privateRequest('/api/wechat/subscription').promise,/重新打开微信提醒/);
  await assert.rejects(publicRequest('/api/v1/wechat/scene/../latest').promise,/暂时无法打开/);
});

test('未配置和撤回真码返回具体中文提示，不自动替代为装饰码或最新版本',async()=>{
  for(const status of [503,410]){const h=mock({codeStatus:status});const request=createTransport(h.wx,config);await assert.rejects(request('/api/v1/wechat/code/fixture-publication').promise,error=>error instanceof Error&&('status'in error)&&error.status===status&&/未配置|撤回/.test(error.message));assert.equal(h.requests.length,1);assert.equal(h.subscribe,0);}
});

test('云托管读者请求也只向明确私有接口发送bearer，公共码调用不携带',async()=>{
  const calls:Options[]=[];const wx={cloud:{init(){},async callContainer(options:Options){calls.push(options);return{statusCode:200,data:{data:options.path.startsWith('/api/v1/')?{publicationId:'fixture-publication'}:safe()}};}}};
  const cloud={mode:'cloud',cloudEnv:'fixture-env',serviceName:'fixture-service'};
  await createWechatTransport(wx,cloud)('/api/wechat/subscription',{sessionToken:'fixture-reader-session'}).promise;
  await createTransport(wx,cloud)(`/api/v1/wechat/scene/${scene}`).promise;
  assert.equal(calls[0].header.Authorization,'Bearer fixture-reader-session');assert.equal(calls[1].header.Authorization,undefined);
  assert.equal(calls[0].header['X-Radar-Subscription-View'],'summary');assert.equal(calls[1].header['X-Radar-Subscription-View'],undefined);
});

test('次数读取和预备请求采用摘要，确认、关闭和登录沿用原合同',async()=>{
  const h=mock({sessionMs:600000,challengeMs:300000});await h.reader.loadForPage();
  await h.reader.authorize({userInitiated:true});await h.reader.revoke({userInitiated:true});
  for(const request of h.requests){
    const summary=request.url.endsWith('/login')||request.url.endsWith('/subscription')&&request.method==='GET'||request.url.endsWith('/challenge');
    assert.equal(request.header['X-Radar-Subscription-View'],summary?'summary':undefined);
  }
  assert.equal(h.reader.getState().remainingCount,0);assert.equal(h.subscribe,1);
});

test('页面声明真实canvas、主动授权和隐私入口，场景解析不按事件猜最新',()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const detail=readFileSync(resolve(root,'miniprogram/pages/detail/index.wxml'),'utf8');
  assert.match(detail,/<canvas type="2d"/);assert.match(detail,/bindtap="savePoster"/);assert.match(detail,/agreePrivacyAuthorization/);
  const settings=readFileSync(resolve(root,'miniprogram/pages/settings/index.wxml'),'utf8');assert.doesNotMatch(settings,/bindtap="authorizeWechat"|bindtap="prepareWechat"|bindtap="refreshWechat"/);assert.match(settings,/关闭微信提醒/);assert.match(settings,/剩余提醒/);assert.match(settings,/增加一次提醒/);
  const code=readFileSync(resolve(root,'miniprogram/pages/detail/index.js'),'utf8');assert.match(code,/publicationId:result.data.publicationId/);assert.doesNotMatch(code,/wx\.login/);
  const app=readFileSync(resolve(root,'miniprogram/app.js'),'utf8');assert.doesNotMatch(app,/wx\.login|setStorageSync\([^)]*session/);
  assert.doesNotThrow(()=>new Script(code));
});

function pageHarness(reader?:Options,initialFeed:Options={},wxOverrides:Options={}) {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const publication:Publication={id:'fixture-old',articleId:'fixture-article',eventId:'fixture-event',publishedAt:'2026-10-10T01:00:00Z',cutoffAt:'2026-10-10T01:00:00Z',reason:'隔离页面输入',mode:'news_only',article:{id:'fixture-article',eventId:'fixture-event',title:'测试旧版本标题',summary:'测试旧版本正文',translation:'',category:'product',version:1,status:'published',publicationId:'fixture-old',evidenceIds:[],publishedAt:'2026-10-10T01:00:00Z',updatedAt:'2026-10-10T01:00:00Z'},event:{id:'fixture-event',title:'测试事件',version:1,status:'published',publicationId:'fixture-old',actions:[],evidenceIds:[],updatedAt:'2026-10-10T01:00:00Z'}};
  const latest=structuredClone(publication);latest.id='fixture-new';latest.article.publicationId=latest.id;latest.article.title='测试最新版本标题';latest.article.version=2;latest.event.publicationId=latest.id;
  const data:PublicData={publications:[publication,latest],events:[latest.event],articles:[latest.article],activities:[],evidence:[],notices:[],sources:[],site:{name:'模钥重置雷达',description:'',version:1,autoPublish:true},serverTime:'2026-10-10T04:00:00Z'};
  const listeners=new Set<(value:unknown)=>void>(),requests:{path:string;abortCount:number;resolve:(value:unknown)=>void;reject:(error:Error)=>void}[]=[],calls:string[]=[],navigation:{method:string;url:string}[]=[];
  const frames:Options[]=[];
  const feedState={data,receivedAt:Date.now(),loading:false,unconfigured:false,error:'',...initialFeed};
  const app={client:{getState(){return feedState;},subscribe(fn:(value:unknown)=>void){listeners.add(fn);fn(this.getState());return()=>listeners.delete(fn);},async refresh(){calls.push('refresh');}},preferences:{snapshot(){return{preferences:{},read:[],error:''};}},publicApi(path:string){let resolve!:(value:unknown)=>void,reject!:(error:Error)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});const item={path,abortCount:0,resolve,reject};requests.push(item);return{promise,abort(){item.abortCount++;}};},wechat:{getState(){return{safe:{state:'revoked'}};},subscribe(fn:(value:unknown)=>void){calls.push('reader-subscribe');fn({label:'点击后连接',busy:false});return()=>calls.push('reader-unsubscribe');},async prepare(options:Options){assert.equal(options.userInitiated,true);calls.push('reader-prepare');},async authorize(options:Options){assert.equal(options.userInitiated,true);calls.push('reader-authorize');},async refresh(options:Options){assert.equal(options.userInitiated,true);calls.push('reader-refresh');},async revoke(options:Options){assert.equal(options.userInitiated,true);calls.push('reader-revoke');}}};
  if(reader)app.wechat=reader as typeof app.wechat;
  function page(name:string,query:Record<string,string>={}){
    let definition:Options|undefined;const cache=new Map<string,{exports:Options}>();
    function load(filename:string):Options{const existing=cache.get(filename);if(existing)return existing.exports;const module={exports:{}};cache.set(filename,module);new Script(readFileSync(filename,'utf8'),{filename}).runInNewContext({module,exports:module.exports,wx:{showModal(options:Options){options.success({confirm:true});},...wxOverrides,showShareMenu(){},hideShareMenu(){},showToast(){},switchTab(options:Options){navigation.push({method:'switchTab',url:options.url});},navigateTo(options:Options){navigation.push({method:'navigateTo',url:options.url});}},getApp(){return app;},setTimeout,clearTimeout,setInterval(){return 1;},clearInterval(){},Date,Page(value:Options){definition=value;},require(path:string){const target=resolve(dirname(filename),path.endsWith('.js')?path:`${path}.js`);assert.ok(target.startsWith(resolve(root,'miniprogram')+'/'));return load(target);}});return module.exports;}
    load(resolve(root,`miniprogram/pages/${name}/index.js`));assert.ok(definition);const instance:Options={...definition,data:structuredClone(definition.data),setData(patch:Options){for(const [key,value] of Object.entries(patch)){const path=key.split('.');let target=this.data;for(const part of path.slice(0,-1)){target[part]??={};target=target[part];}target[path.at(-1)!]=structuredClone(value);}frames.push(structuredClone(this.data));}};instance.onLoad(query);instance.onShow();return instance;
  }
  return{page,requests,calls,navigation,data,frames,feed(patch:Options){Object.assign(feedState,patch);listeners.forEach(fn=>fn(feedState));},get subscriptions(){return listeners.size;}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('类型选择保存到读者接口，保持次数和已准备授权，不额外弹出微信授权',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000});await h.reader.loadForPage();
  assert.deepEqual(h.reader.getState().reminderPreferences,{announcement:true,result:true,correction:true});
  const before=h.requests.length,choice={announcement:false,result:true,correction:false};
  await h.reader.savePreferences(choice,{userInitiated:true});
  assert.equal(h.requests.length,before+1);assert.equal(h.subscribe,0);assert.equal(h.reader.getState().remainingCount,1);assert.equal(h.reader.getState().ready,true);
  assert.deepEqual(h.reader.getState().reminderPreferences,choice);assert.equal(h.reader.getState().preferencesMessage,'已保存');
  const save=h.requests.at(-1)!;assert.equal(save.url,config.baseUrl+'/api/wechat/subscription/preferences');assert.equal(save.method,'POST');assert.equal(save.header.Authorization,'Bearer fixture-reader-session');assert.deepEqual(save.data,choice);
  const fresh=h.freshReader();await fresh.loadForPage();assert.deepEqual(fresh.getState().reminderPreferences,choice);
  await fresh.authorize({userInitiated:true});assert.deepEqual(fresh.getState().reminderPreferences,choice);assert.equal(fresh.getState().remainingCount,2);
});

test('未主动操作和旧服务不写类型设置，错误格式的状态不能显示为可编辑',async()=>{
  const h=mock();await h.reader.savePreferences({announcement:false,result:false,correction:false});assert.equal(h.login,0);assert.equal(h.requests.length,0);
  const legacy=mock({legacyPreferences:true});await legacy.reader.loadForPage();assert.equal(legacy.reader.getState().canChooseTypes,false);
  const before=legacy.requests.length;await legacy.reader.savePreferences({announcement:false,result:true,correction:false},{userInitiated:true});assert.equal(legacy.requests.length,before);assert.match(legacy.reader.getState().error,/暂不可设置/);
  const invalid=mock({invalidPreferences:true});await invalid.reader.loadForPage();assert.equal(invalid.reader.getState().safe,null);assert.equal(invalid.reader.getState().canChooseTypes,false);
});

test('真实提醒页的三个开关分别保存，全部关闭保留次数，返回页面不额外写入',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000}),page=pageHarness(h.reader).page('settings');
  try{
    await flush();
    for(const kind of ['announcement','result','correction'])await page.changeWechatPreference({currentTarget:{dataset:{kind}},detail:{value:false}});
    assert.equal(page.data.wechat.allTypesOff,true);assert.equal(page.data.wechat.remainingCount,1);assert.equal(h.subscribe,0);assert.equal(h.requests.filter(r=>r.url.endsWith('/preferences')).length,3);
    const before=h.requests.length;page.onHide();page.onShow();await flush();assert.equal(h.requests.length,before);
    await page.changeWechatPreference({currentTarget:{dataset:{kind:'result'}},detail:{value:true}});assert.equal(page.data.wechat.allTypesOff,false);assert.deepEqual(page.data.wechat.reminderPreferences,{announcement:false,result:true,correction:false});
    await page.changeWechatPreference({currentTarget:{dataset:{kind:'activity'}},detail:{value:true}});assert.equal(h.requests.filter(r=>r.url.endsWith('/preferences')).length,4);
  }finally{page.onUnload();}
});

test('保存响应丢失不伪装成功，重新读取确认服务端选择且不重复授权',async()=>{
  const options={state:'available',sessionMs:600000,challengeMs:300000,failPreferencesAfterSave:true},h=mock(options),page=pageHarness(h.reader).page('settings');
  try{
    await flush();await page.changeWechatPreference({currentTarget:{dataset:{kind:'correction'}},detail:{value:false}});
    assert.match(page.data.wechat.error,/尚未确认/);assert.equal(page.data.wechat.preferencesMessage,'');assert.equal(page.data.wechat.preferencesUncertain,true);assert.equal(page.data.wechat.canChooseTypes,false);assert.equal(page.data.wechat.reminderPreferences.correction,true);
    await page.addWechat();assert.equal(page.data.wechat.reminderPreferences.correction,false);assert.equal(page.data.wechat.preferencesUncertain,false);assert.equal(h.subscribe,0);assert.equal(page.data.wechat.remainingCount,1);
  }finally{page.onUnload();}
});

test('类型保存遇到新的隐私确认时只恢复该保存，不误触发提醒授权',async()=>{
  const options={sessionMs:600000,challengeMs:300000,privacy:false},h=mock(options),page=pageHarness(h.reader).page('settings');
  try{
    await flush();options.privacy=true;await page.changeWechatPreference({currentTarget:{dataset:{kind:'announcement'}},detail:{value:false}});assert.equal(page.data.wechat.privacyNeeded,true);assert.equal(h.subscribe,0);
    options.privacy=false;await page.agreeWechatPrivacy();assert.equal(page.data.wechat.reminderPreferences.announcement,false);assert.equal(h.subscribe,0);assert.equal(h.requests.filter(r=>r.url.endsWith('/preferences')).length,1);
  }finally{page.onUnload();}
});

test('类型保存读到发送状态未知时撤销之前准备，不能继续弹微信授权',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000});await h.reader.loadForPage();
  assert.equal(h.reader.getState().ready,true);h.changeState('unknown');
  await h.reader.savePreferences({announcement:true,result:true,correction:false},{userInitiated:true});
  assert.equal(h.reader.getState().safe.state,'unknown');assert.equal(h.reader.getState().ready,false);
  await h.reader.authorize({userInitiated:true});assert.equal(h.subscribe,0);assert.equal(h.reader.getState().remainingCount,1);
});

test('保存结果不确定后关闭提醒取得权威选择，开关恢复且次数不会凭空增加',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000,failPreferencesAfterSave:true}),page=pageHarness(h.reader).page('settings');
  try{
    await flush();await page.changeWechatPreference({currentTarget:{dataset:{kind:'correction'}},detail:{value:false}});
    assert.equal(page.data.wechat.preferencesUncertain,true);
    await page.revokeWechat();
    assert.equal(page.data.wechat.preferencesUncertain,false);assert.equal(page.data.wechat.canChooseTypes,true);assert.equal(page.data.wechat.reminderPreferences.correction,false);
    assert.equal(page.data.wechat.remainingCount,0);assert.equal(h.subscribe,0);
  }finally{page.onUnload();}
});

test('类型接口只允许读者私有POST，不能通过公开传输发送',async()=>{
  const h=mock(),privateRequest=createWechatTransport(h.wx,config),choice={announcement:true,result:false,correction:false};
  await assert.rejects(createTransport(h.wx,config)('/api/wechat/subscription/preferences').promise,/暂时无法打开/);
  await assert.rejects(privateRequest('/api/wechat/subscription/preferences',{method:'GET',sessionToken:'fixture-reader-session'}).promise,/暂时无法打开/);
  await assert.rejects(privateRequest('/api/wechat/subscription/preferences',{method:'POST',data:choice}).promise,/重新打开微信提醒/);
  assert.equal(h.requests.length,0);
});

test('进入提醒页直接读取次数并准备，首次开启点击同步授权，不需要查看或确认按钮',async()=>{
  const h=mock({sessionMs:600000,challengeMs:300000}),ui=pageHarness(h.reader),page=ui.page('settings');
  try {
    assert.equal(page.data.wechat.busy,true);assert.equal(h.subscribe,0);
    await flush();assert.equal(page.data.wechat.remainingCount,0);assert.equal(page.data.wechat.ready,true);assert.equal(h.login,1);assert.equal(h.subscribe,0);
    const work=page.addWechat();assert.equal(h.subscribe,1,'tap 返回前已经调用微信授权');await work;
    assert.equal(page.data.wechat.remainingCount,1);assert.equal(page.data.wechat.ready,true);
    const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),template=readFileSync(resolve(root,'miniprogram/pages/settings/index.wxml'),'utf8');
    assert.doesNotMatch(template,/查看我的提醒|确认开启提醒|bindtap="viewWechat"/);
    assert.match(template,/disabled="\{\{wechat.busy/);
  } finally {page.onUnload();}
});

test('已有次数原位展示；短时间切回提醒页复用准备，不重复连接或弹授权',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000}),page=pageHarness(h.reader).page('settings');
  try {
    await flush();assert.equal(page.data.wechat.remainingCount,1);const before=h.requests.length;
    page.onHide();assert.equal(page._wechatRefreshTimer,null);page.onShow();await flush();
    assert.equal(h.requests.length,before);assert.equal(h.login,1);assert.equal(h.subscribe,0);
    assert.equal(page.data.wechat.canRevoke,true);
  } finally {page.onUnload();}
});

test('首次实际次数返回后沿用全局入场，授权准备只阻止操作',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000}),request=h.wx.request;
  const held:Options[]=[];
  h.wx.request=(options:Options)=>{
    if(options.url.endsWith('/subscription')||options.url.endsWith('/challenge')){held.push(options);return{abort(){}};}
    return request(options);
  };
  const page=pageHarness(h.reader).page('settings');
  try{
    await flush();assert.equal(held.length,1);assert.equal(page.data.wechat.safe,null);assert.equal(page.data.wechat.remainingCount,null);assert.equal(page.data.awaitingWechat,true);assert.equal(page.data.contentMotion,'');
    request(held.shift()!);await flush();
    assert.equal(held.length,1);assert.match(held[0].url,/challenge$/);
    assert.equal(page.data.wechat.remainingCount,1);assert.equal(page.data.wechat.busy,true);assert.equal(page.data.contentMotion,'content-enter');
    assert.equal(page.data.wechat.ready,false);
    page.addWechat();await page.revokeWechat(true);assert.equal(h.subscribe,0);assert.equal(h.requests.some(r=>r.method==='DELETE'),false,'准备时不会新增授权或关闭提醒');
    page.onHide();page.onShow();
    assert.equal(page.data.wechat.remainingCount,1,'保留已确认次数');
    await flush();assert.equal(held.length,1,'预备未结束时不重复请求');
    request(held.shift()!);await flush();assert.equal(page.data.wechat.ready,true);assert.equal(h.subscribe,0);
  }finally{held.splice(0).forEach(request);await flush();page.onUnload();}
});

test('超过缓存时间切回仍立即保留次数，慢速核对返回后更新实际已消耗次数',async()=>{
  const h=mock({state:'available',sessionMs:900000,challengeMs:300000}),page=pageHarness(h.reader).page('settings');
  const request=h.wx.request;let held:Options|undefined;
  try{
    await flush();page.onHide();h.advance(300001);h.changeState('consumed');
    h.wx.request=(options:Options)=>{
      if(options.url.endsWith('/subscription')){held=options;return{abort(){}};}
      return request(options);
    };
    page.onShow();assert.equal(page.data.wechat.remainingCount,1);assert.equal(page.data.contentMotion,'');
    await flush();assert.ok(held);assert.equal(page.data.wechat.remainingCount,1);assert.equal(page.data.wechatAction,'');
    request(held);held=undefined;await flush();
    assert.equal(page.data.wechat.remainingCount,0);assert.equal(h.login,1);assert.equal(h.subscribe,0);
  }finally{if(held)request(held);await flush();page.onUnload();}
});

test('提醒读取不控制整页入场；站内信成功或失败不改变私人次数',async()=>{
  for(const outcome of ['success','error','unconfigured']){
    const h=mock({state:'available',sessionMs:600000,challengeMs:300000});
    const harness=pageHarness(h.reader,{data:null,loading:true}),page=harness.page('settings');
    try{
      await flush();assert.equal(page.data.wechat.ready,true);assert.equal(page.data.connected,false);assert.equal(page.data.contentMotion,'');
      harness.feed({loading:false,...(outcome==='success'?{data:harness.data}:outcome==='error'?{error:'站内信暂时无法读取'}:{unconfigured:true})});
      assert.equal(page.data.wechat.remainingCount,1);assert.equal(page.data.contentMotion,outcome==='success'?'content-enter':'');
    }finally{page.onUnload();}
  }
});

test('微信首次读取失败或需要隐私授权时显示可操作页面，不停留在整体加载',async()=>{
  for(const options of [{failState:true},{privacy:true}]){
    const h=mock(options),page=pageHarness(h.reader).page('settings');
    try{
      await flush();assert.equal(page.data.wechat.remainingCount,null);
      assert.ok(page.data.wechat.error||page.data.wechat.privacyNeeded);assert.equal(page.data.wechatAction,'');assert.equal(h.subscribe,0);
    }finally{page.onUnload();}
  }
});

test('增加和关闭各自保持操作状态，连续点击不会重复授权或交叉关闭',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000}),page=pageHarness(h.reader).page('settings');
  const request=h.wx.request;let held:Options|undefined;
  try{
    await flush();
    h.wx.request=(options:Options)=>{
      if(options.url.endsWith('/confirm')||options.method==='DELETE'){held=options;return{abort(){}};}
      return request(options);
    };
    const adding=page.addWechat();assert.equal(h.subscribe,1,'授权仍在手势同步调用栈');assert.equal(page.data.wechatAction,'add');
    await page.addWechat();await page.revokeWechat();await flush();assert.ok(held);assert.equal(h.subscribe,1);
    assert.equal(page.data.wechat.remainingCount,1);
    request(held!);held=undefined;await adding;assert.equal(page.data.wechatAction,'');assert.equal(page.data.wechat.remainingCount,2);
    const closing=page.revokeWechat();assert.equal(page.data.wechatAction,'confirm-revoke');await page.addWechat();await page.revokeWechat();await flush();
    assert.ok(held);assert.equal((held as Options|undefined)?.method,'DELETE');assert.equal(h.subscribe,1);assert.equal(page.data.wechat.remainingCount,2);
    request(held!);held=undefined;await closing;assert.equal(page.data.wechatAction,'');assert.equal(page.data.wechat.safe.state,'revoked');assert.equal(page.data.wechat.remainingCount,0);
  }finally{if(held)request(held);await flush();page.onUnload();}
});

test('类型开关在保存期间保留点击选择，响应不确定后恢复确认值，重读再核对',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000,failPreferencesAfterSave:true}),page=pageHarness(h.reader).page('settings');
  const request=h.wx.request;let held:Options|undefined;
  try{
    await flush();h.wx.request=(options:Options)=>{if(options.url.endsWith('/preferences')){held=options;return{abort(){}};}return request(options);};
    const saving=page.changeWechatPreference({currentTarget:{dataset:{kind:'result'}},detail:{value:false}});
    assert.equal(page.data.wechatAction,'preferences');assert.equal(page.data.wechat.reminderPreferences.result,false);
    assert.equal(h.reader.getState().reminderPreferences.result,true,'读取器仍保留服务端确认值');
    await page.addWechat();await page.revokeWechat();await flush();assert.ok(held);assert.equal(h.subscribe,0);
    request(held!);held=undefined;await saving;
    assert.equal(page.data.wechatAction,'');assert.equal(page.data.wechat.reminderPreferences.result,true);
    assert.match(page.data.wechat.error,/尚未确认/);assert.equal(page.data.wechat.canChooseTypes,false);
    await page.addWechat();assert.equal(page.data.wechat.reminderPreferences.result,false);assert.equal(page.data.wechatAction,'');assert.equal(h.subscribe,0);
  }finally{if(held)request(held);await flush();page.onUnload();}
});

test('准备到期前续期，状态同步复用仍有效nonce，不把预备算作提醒次数',async()=>{
  const h=mock({sessionMs:900000,challengeMs:300000});await h.reader.loadForPage();
  assert.equal(h.reader.nextRefreshDelay(),270000);const before=h.requests.length;
  await h.reader.loadForPage();assert.equal(h.requests.length,before);
  h.advance(270000);await h.reader.loadForPage();assert.equal(h.requests.filter(r=>r.url.endsWith('/challenge')).length,2);
  assert.equal(h.reader.nextRefreshDelay(),30000);h.advance(30000);await h.reader.loadForPage();
  assert.equal(h.requests.filter(r=>r.url.endsWith('/challenge')).length,2,'状态检查不重复创建有效nonce');
  assert.equal(h.reader.getState().remainingCount,0);assert.equal(h.subscribe,0);
  const work=h.reader.authorize({userInitiated:true});assert.equal(h.subscribe,1);await work;
  assert.equal(h.reader.getState().remainingCount,1);
});

test('未同意隐私不连接；同意后仅加载提醒，开启按钮仍需主动点击',async()=>{
  const options={privacy:true,sessionMs:600000,challengeMs:300000},h=mock(options),page=pageHarness(h.reader).page('settings');
  try {
    await flush();assert.equal(h.login,0);assert.equal(page.data.wechat.privacyNeeded,true);assert.equal(h.subscribe,0);
    options.privacy=false;await page.agreeWechatPrivacy();assert.equal(page.data.wechat.ready,true);assert.equal(h.login,1);assert.equal(h.subscribe,0);
    const work=page.addWechat();assert.equal(h.subscribe,1);await work;assert.equal(page.data.wechat.remainingCount,1);
  } finally {page.onUnload();}
});

test('同步发现其他设备关闭提醒时作废本机旧准备，重新点击使用新nonce',async()=>{
  const h=mock({state:'available',sessionMs:900000,challengeMs:300000});await h.reader.loadForPage();
  h.advance(270000);await h.reader.loadForPage();h.changeState('revoked');h.advance(30000);await h.reader.loadForPage();
  assert.equal(h.requests.filter(r=>r.url.endsWith('/challenge')).length,3);assert.equal(h.reader.getState().remainingCount,0);assert.equal(h.subscribe,0);
  await h.reader.authorize({userInitiated:true});assert.equal(h.requests.find(r=>r.url.endsWith('/confirm'))!.data.nonce,'fixture-nonce-3');assert.equal(h.reader.getState().remainingCount,1);
});

test('确认失败后重进提醒页不自动重试，点击重试同一nonce不再弹授权',async()=>{
  const options={failConfirm:true,sessionMs:600000,challengeMs:300000},h=mock(options),page=pageHarness(h.reader).page('settings');
  try {
    await flush();await page.addWechat();assert.equal(page.data.wechat.confirmNeeded,true);assert.match(page.data.wechat.error,/尚未确认/);
    const before=h.requests.length;page.onHide();page.onShow();await flush();assert.equal(h.requests.length,before);assert.equal(h.subscribe,1);
    options.failConfirm=false;await page.addWechat();assert.equal(h.subscribe,1);assert.equal(page.data.wechat.remainingCount,1);
    const confirms=h.requests.filter(r=>r.url.endsWith('/confirm'));assert.equal(confirms.length,2);assert.deepEqual(confirms[0].data,confirms[1].data);
  } finally {page.onUnload();}
});

test('连接失败明确重试，重试只读取状态，不意外授权；后台不再调度准备',async()=>{
  const options={failState:true,sessionMs:600000,challengeMs:300000},h=mock(options),page=pageHarness(h.reader).page('settings');
  try {
    await flush();assert.ok(page.data.wechat.error);assert.equal(page.data.wechat.safe,null);assert.equal(h.subscribe,0);
    options.failState=false;await page.addWechat();assert.equal(page.data.wechat.ready,true);assert.equal(h.subscribe,0);
    page.onHide();assert.equal(page._wechatRefreshTimer,null);await page.loadWechat();assert.equal(page._wechatRefreshTimer,null);
  } finally {page.onUnload();}
});

test('关闭后预备不会恢复提醒，下一次明确点击才重新授权',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000,challengeState:'challenged'}),page=pageHarness(h.reader).page('settings');
  try {
    await flush();await page.revokeWechat();assert.equal(page.data.wechat.safe.state,'revoked');assert.equal(page.data.wechat.remainingCount,0);assert.equal(page.data.wechat.ready,true);assert.equal(h.subscribe,0);
    const work=page.addWechat();assert.equal(h.subscribe,1);await work;assert.equal(page.data.wechat.remainingCount,1);
  } finally {page.onUnload();}
});

test('冷启动读取服务端已关闭状态仍可提前准备，点击前零授权且剩余次数不恢复',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000});await h.reader.loadForPage();
  await h.reader.revoke({userInitiated:true});await h.reader.loadForPage();
  const cold=h.freshReader();await cold.loadForPage();
  assert.equal(cold.getState().safe.state,'revoked');assert.equal(cold.getState().remainingCount,0);assert.equal(cold.getState().ready,true);
  assert.equal(h.login,2);assert.equal(h.subscribe,0);
  const work=cold.authorize({userInitiated:true});assert.equal(h.subscribe,1);await work;
  assert.equal(cold.getState().safe.state,'available');assert.equal(cold.getState().remainingCount,1);
});

test('开启失败提示不会被自动预备清除，也不会显示新增次数',async()=>{
  const h=mock({sessionMs:600000,challengeMs:300000}),page=pageHarness(h.reader).page('settings');
  try {
    await flush();const before=h.requests.length;h.wx.requestSubscribeMessage=(options:Options)=>options.fail({});
    await page.addWechat();assert.match(page.data.wechat.error,/订阅未完成/);assert.equal(page.data.wechat.remainingCount,0);assert.equal(h.requests.length,before);
  } finally {page.onUnload();}
});

test('关闭失败保留错误和已有次数，不被紧接的自动刷新伪装为成功',async()=>{
  const h=mock({state:'available',failRevoke:true,sessionMs:600000,challengeMs:300000}),page=pageHarness(h.reader).page('settings');
  try {
    await flush();const before=h.requests.length;await page.revokeWechat();assert.ok(page.data.wechat.error);assert.equal(page.data.wechat.remainingCount,1);
    assert.equal(h.requests.length,before+1);assert.notEqual(page.data.wechat.safe.state,'revoked');
  } finally {page.onUnload();}
});

test('提醒页结果未知时可准备新授权，过期会话重入恢复但不自动授权',async()=>{
  const blocked=mock({state:'unknown'});await blocked.reader.loadForPage();assert.equal(blocked.reader.getState().ready,true);assert.equal(blocked.requests.some(r=>r.url.endsWith('/challenge')),true);assert.equal(blocked.subscribe,0);await blocked.reader.authorize({userInitiated:true});assert.equal(blocked.subscribe,1);assert.equal(blocked.reader.getState().remainingCount,1);
  const h=mock({sessionMs:60000,challengeMs:300000});await h.reader.loadForPage();h.advance(60001);assert.equal(h.reader.getState().ready,false);
  await h.reader.loadForPage();assert.equal(h.login,2);assert.equal(h.reader.getState().ready,true);assert.equal(h.subscribe,0);
});

test('首页没有重置安排时，海报携带当前空状态版本，不借用产品动态圆码或调用微信',()=>{
  const h=pageHarness(),page=h.page('home');
  assert.equal(page.data.latest,null);
  assert.equal(page.data.posterPath,'/pages/detail/index?publicationId=fixture-new');
  assert.match(page.data.posterDescription,/黑金或水墨/);
  assert.equal(h.requests.length,0);assert.deepEqual(h.calls,[]);
  page.openPoster();
  assert.equal(h.navigation.length,1);assert.equal(h.navigation[0].method,'navigateTo');
  const entry=new URL(h.navigation[0].url,'https://isolated.test');assert.equal(entry.pathname,'/packages/poster/index');assert.equal(entry.searchParams.get('kind'),'automatic_reset');assert.equal(entry.searchParams.get('revision'),page.data.resetCards[0].revision);
  assert.match(page.onShareAppMessage().path,/^\/pages\/home\/index\?kind=automatic_reset&revision=home-[a-f0-9]{16}$/);
  assert.equal(h.data.publications[1].mode,'news_only');assert.equal(h.data.events[0].actions.length,0);
  page.onUnload();
});

test('首页海报保留完成记录优先，不被发布时间更晚的新闻替换',()=>{
  const h=pageHarness(),completed=structuredClone(h.data.publications[1]);
  completed.id='fixture-completed';completed.articleId='completed-article';completed.eventId='completed-event';completed.mode='state_change';
  Object.assign(completed.article,{id:completed.articleId,eventId:completed.eventId,publicationId:completed.id,category:'reset',publishedAt:'2026-10-09T01:00:00Z'});
  Object.assign(completed.event,{id:completed.eventId,publicationId:completed.id,actions:[{id:'completed-action',kind:'automatic_reset',stage:'claimed_complete',scope:'public',eligibility:'公开账户',statementAt:'2026-10-09T01:00:00Z',evidenceIds:[]}]});
  completed.publishedAt='2026-10-09T01:00:00Z';
  h.data.publications.push(completed);h.data.articles.push(completed.article);h.data.events.push(completed.event);
  const page=h.page('home');
  assert.equal(page.data.posterPath,'/pages/detail/index?publicationId=fixture-completed');
  assert.match(page.data.posterDescription,/黑金或水墨/);
  page.onUnload();
});

test('首页海报跳过撤回、合并和关联缺失的动态；无有效记录时明确说明',()=>{
  for(const kind of ['withdrawn','merged','missing']){
    const h=pageHarness(),invalid=structuredClone(h.data.publications[1]);
    invalid.id='fixture-invalid';invalid.articleId='invalid-article';invalid.eventId='invalid-event';invalid.article.id=invalid.articleId;invalid.article.eventId=invalid.eventId;invalid.article.publicationId=invalid.id;invalid.article.publishedAt='2026-10-10T03:00:00Z';invalid.event.id=invalid.eventId;invalid.event.publicationId=invalid.id;
    if(kind==='withdrawn')invalid.article.status='withdrawn';
    if(kind==='merged')invalid.event.status='merged';
    h.data.publications.push(invalid);h.data.articles.push(invalid.article);if(kind!=='missing')h.data.events.push(invalid.event);
    const page=h.page('home');assert.equal(page.data.posterPath,'/pages/detail/index?publicationId=fixture-new');page.onUnload();
  }
  const empty=pageHarness();empty.data.publications=[];empty.data.events=[];empty.data.articles=[];
  const page=empty.page('home');assert.equal(page.data.posterPath,'');assert.match(page.data.posterDescription,/分享当前公开状态/);
  page.openPoster();assert.equal(empty.navigation.length,1);assert.equal(empty.navigation[0].method,'navigateTo');assert.match(empty.navigation[0].url,/^\/packages\/poster\/index\?kind=automatic_reset&revision=/);assert.equal(empty.requests.length,0);page.onUnload();
});

test('首页微信提醒切换到设置标签页，不打开动态记录或自动发起微信登录授权',()=>{
  const h=pageHarness(),page=h.page('home');
  page.openWechatSettings();
  assert.deepEqual(h.navigation,[{method:'switchTab',url:'/pages/settings/index'}]);
  assert.equal(h.requests.length,0);assert.deepEqual(h.calls,[]);
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const app=JSON.parse(readFileSync(resolve(root,'miniprogram/app.json'),'utf8'));
  assert.ok(app.tabBar.list.some((tab:{pagePath:string})=>tab.pagePath==='pages/settings/index'));
  page.onUnload();
});

test('实际扫码详情落在固定旧版本；隐藏时取消，迟到scene响应不能覆盖重入后的选择',async()=>{
  const h=pageHarness(),page=h.page('detail',{scene});assert.equal(page.data.detail,null);assert.equal(h.requests.length,1);
  page.onHide();assert.equal(h.requests[0].abortCount,1);assert.equal(h.subscriptions,0);page.onShow();assert.equal(h.requests.length,2);
  h.requests[1].resolve({data:{publicationId:'fixture-old'}});await flush();assert.equal(page.data.detail.title,'测试旧版本标题');assert.equal(page.onShareAppMessage().path,'/pages/detail/index?publicationId=fixture-old');
  h.requests[0].resolve({data:{publicationId:'fixture-new'}});await flush();assert.equal(page.data.detail.title,'测试旧版本标题');assert.equal(h.calls.filter(item=>item==='refresh').length,1);page.onUnload();assert.equal(h.subscriptions,0);
});

test('实际详情无效scene不发请求、不回退最新；公告长图不请求圆码且画布不可用时可重试',async()=>{
  const invalid=pageHarness(),bad=invalid.page('detail',{scene:'../latest',publicationId:'fixture-new'});assert.equal(invalid.requests.length,0);assert.equal(bad.data.detail,null);assert.match(bad.data.sceneError,/无效/);bad.onUnload();
  const h=pageHarness(),page=h.page('detail',{publicationId:'fixture-old'});await page.generatePoster();assert.equal(h.requests.length,0);
  assert.equal(page.data.posterBusy,false);assert.equal(page.data.posterPreview,'');assert.equal(page._posterArtifact,null);assert.match(page.data.posterError,/不支持生成海报/);
  await page.savePoster();assert.match(page.data.posterError,/先生成/);page.onUnload();
});

test('公告样式选择在首次生成前只改变选择，生成后切换复用缓存且不触发额外请求',()=>{
  const h=pageHarness(),page=h.page('detail',{publicationId:'fixture-old'});
  page.selectPosterTheme({currentTarget:{dataset:{theme:'editorial'}}});
  assert.equal(page.data.posterTheme,'editorial');assert.equal(h.requests.length,0);assert.equal(page.data.posterBusy,false);
  page._posterAt=Date.now();
  page._posterCache={precision:{tempFilePath:'wxfile://cached-dark.png'},editorial:{tempFilePath:'wxfile://cached-light.png'}};
  page.setData({posterPreview:'wxfile://cached-light.png',posterReady:true});
  page.selectPosterTheme({currentTarget:{dataset:{theme:'precision'}}});
  assert.equal(page.data.posterPreview,'wxfile://cached-dark.png');assert.equal(page.data.posterReady,true);assert.equal(h.requests.length,0);
  page.setData({posterSaving:true});
  page.selectPosterTheme({currentTarget:{dataset:{theme:'editorial'}}});
  assert.equal(page.data.posterTheme,'precision');assert.equal(page.data.posterPreview,'wxfile://cached-dark.png');
  page.onUnload();
});

test('公告更换样式生成失败时保留预览但禁用保存，不把旧图当成新样式',async()=>{
  const h=pageHarness(),page=h.page('detail',{publicationId:'fixture-old'});
  page.setData({posterPreview:'wxfile://previous-dark.png',posterReady:true,posterTheme:'editorial'});
  const pending=page.generatePoster();
  assert.equal(page.data.posterReady,false);assert.equal(page.data.posterBusy,true);
  assert.equal(h.requests.length,0);await pending;
  assert.equal(page.data.posterPreview,'wxfile://previous-dark.png');assert.equal(page.data.posterReady,false);assert.equal(page._posterArtifact,null);
  assert.equal(page.data.posterBusy,false);assert.match(page.data.posterError,/不支持生成海报/);
  page.onUnload();
});

test('隐藏提醒页解除状态监听，后台完成不更新隐藏页面，重入后读取最新次数',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000}),ui=pageHarness(h.reader),page=ui.page('settings');
  try {
    await flush();assert.equal(page.data.wechat.remainingCount,1);page.onHide();assert.equal(ui.subscriptions,0);
    await h.reader.revoke({userInitiated:true});assert.equal(page.data.wechat.remainingCount,1);
    page.onShow();await flush();assert.equal(page.data.wechat.remainingCount,0);assert.equal(h.subscribe,0);
  } finally {page.onUnload();}
});

test('次数后台刷新保留次数、主按钮状态和关闭入口，不产生全卡忙碌切换',async()=>{
 const h=mock({state:'available',sessionMs:600000,challengeMs:600000});await h.reader.loadForPage();
 const values:Options[]=[];const off=h.reader.subscribe((state:Options)=>values.push(state));
 h.advance(300000);await h.reader.loadForPage();off();
 assert.ok(values.some(v=>v.refreshing));assert.ok(values.every(v=>v.remainingCount===1&&v.canRevoke===true&&v.canChooseTypes===true&&v.busy===false));
});
test('用户同步授权优先于旧后台读取，迟到响应不能覆盖新增次数或新nonce',async()=>{
 const h=mock({state:'available',sessionMs:900000,challengeMs:900000});await h.reader.loadForPage();
 const request=h.wx.request;let delayed:Options|undefined;
 h.wx.request=(options:Options)=>{if(options.url.endsWith('/subscription')&&options.method!=='DELETE'){delayed=options;return {abort(){}};}return request(options);};
 h.advance(300000);const refresh=h.reader.loadForPage();await new Promise(resolve=>setImmediate(resolve));assert.ok(delayed);
 const work=h.reader.authorize({userInitiated:true});assert.equal(h.subscribe,1,'仍须同步弹出微信原生授权');await work;
 assert.equal(h.reader.getState().remainingCount,2);
 delayed!.success({statusCode:200,data:{data:{...safe('available'),remainingCount:1,pendingCount:0,preferencesSupported:true,reminderPreferences:{announcement:true,result:true,correction:true}}}});await refresh;
 assert.equal(h.reader.getState().remainingCount,2);assert.equal(h.reader.getState().ready,true);assert.equal(h.reader.getState().busy,false);assert.equal(h.reader.getState().error,'');
});

test('旧后台隐私读取晚于新授权返回时，不重新读取次数或覆盖准备状态',async()=>{
 const h=mock({state:'available',sessionMs:900000,challengeMs:900000});await h.reader.loadForPage();
 let privacy:Options|undefined;h.wx.getPrivacySetting=(options:Options)=>{privacy=options;};
 h.advance(300000);const background=h.reader.loadForPage();assert.ok(privacy);
 await h.reader.authorize({userInitiated:true});const requests=h.requests.length;
 privacy!.success({needAuthorization:false});await background;
 assert.equal(h.requests.length,requests);assert.equal(h.reader.getState().remainingCount,2);assert.equal(h.reader.getState().ready,true);
});


test('取消关闭确认不撤销次数；确认文案写明作废次数和保留次数的暂停路径',async()=>{
 const h=mock({state:'available',sessionMs:600000,challengeMs:300000});let content='';
 const page=pageHarness(h.reader,{}, {showModal(options:Options){content=options.content;options.success({confirm:false,cancel:true});}}).page('settings');
 try{await flush();const before=h.requests.length;await page.revokeWechat();assert.equal(h.requests.length,before);assert.equal(page.data.wechat.remainingCount,1);assert.match(content,/剩余 1 次提醒授权将作废/);assert.match(content,/次数会保留/);assert.equal(page.data.wechatAction,'');}finally{page.onUnload();}
});


test('授权准备失败仍保留整卡与真实次数，可重试且不擅自授权',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000}),request=h.wx.request;
  let held:Options|undefined;
  h.wx.request=(options:Options)=>{if(options.url.endsWith('/challenge')){held=options;return{abort(){}};}return request(options);};
  const ui=pageHarness(h.reader),page=ui.page('settings');
  try{
    await flush();assert.ok(held);assert.equal(page.data.wechat.remainingCount,1);
    held!.success({statusCode:503,data:{error:'暂时无法准备提醒，请重试。'}});await flush();
    assert.equal(page.data.wechat.remainingCount,1);assert.equal(page.data.wechat.busy,false);
    assert.match(page.data.wechat.error,/重试/);assert.equal(h.subscribe,0);
    page.onHide();assert.equal(page._wechatRefreshTimer,null);
  }finally{page.onUnload();}
});

test('提醒页公告预览最多三条，先置顶再日期倒序，未读统计仍覆盖全部',async()=>{
  const h=mock({state:'available',sessionMs:600000,challengeMs:300000}),ui=pageHarness(h.reader),page=ui.page('settings');
  try{
    await flush();
    const notices=Array.from({length:5},(_,i)=>({id:'notice-'+i,title:'公告'+i,body:'公开公告正文',summary:'公开公告摘要',origin:'admin',status:'active',pinned:i===0,createdAt:new Date(Date.parse('2026-10-20T00:00:00Z')+i*86400000).toISOString(),categories:['system'],eventId:'',publicationId:''}));
    ui.feed({data:{...ui.data,notices}});
    assert.deepEqual(Array.from(page.data.notices,(n:Options)=>n.id),['notice-0','notice-4','notice-3']);
    assert.equal(page.data.unread,5);
    notices[0].pinned=false;ui.feed({data:{...ui.data,notices:[...notices]}});
    assert.deepEqual(Array.from(page.data.notices,(n:Options)=>n.id),['notice-4','notice-3','notice-2']);
  }finally{page.onUnload();}
});


test('登录摘要在首个后台返回时显示真实次数，慢预备不阻止整卡且总计只需两次请求',async()=>{
 const h=mock({state:'available',sessionMs:600000,challengeMs:300000,loginSnapshot:true}),request=h.wx.request;
 let held:Options|undefined;
 h.wx.request=(o:Options)=>{if(o.url.endsWith('/challenge')){held=o;return{abort(){}};}return request(o);};
 const page=pageHarness(h.reader).page('settings');
 try{
  await flush();assert.equal(h.requests.length,1);assert.ok(held);assert.equal(page.data.wechat.remainingCount,1);assert.equal(page.data.wechat.ready,false);
  assert.doesNotMatch(JSON.stringify(page.data.wechat),/sessionToken|fixture-reader-session|extraPrivateField|openid/);
  assert.equal(h.requests[0].header['X-Radar-Subscription-View'],'summary');assert.equal(h.requests[0].header.Authorization,undefined);
  page.onHide();page.onShow();await flush();assert.equal(h.requests.length,1);assert.equal(page.data.wechat.remainingCount,1);
  request(held!);held=undefined;await flush();assert.equal(h.requests.length,2);assert.equal(page.data.wechat.ready,true);assert.equal(h.subscribe,0);
  assert.equal(h.requests.some(r=>r.url.endsWith('/subscription')),false);
 }finally{if(held)request(held);await flush();page.onUnload();}
});
test('登录摘要兼容旧服务器；新服务器少一次次数往返，重入复用与过期重连仍准确',async()=>{
 for(const loginSnapshot of [false,true]){
  const h=mock({state:'available',loginSnapshot,sessionMs:600000,challengeMs:300000});await h.reader.loadForPage();
  assert.equal(h.requests.length,loginSnapshot?2:3);assert.equal(h.reader.getState().remainingCount,1);
  const before=h.requests.length;await h.reader.loadForPage();assert.equal(h.requests.length,before);
  h.advance(600001);h.changeState('consumed');await h.reader.loadForPage();
  assert.equal(h.requests.length-before,loginSnapshot?2:3);assert.equal(h.reader.getState().remainingCount,0);assert.equal(h.login,2);assert.equal(h.subscribe,0);
 }
});
test('登录摘要预备失败保留真实次数并允许重新准备，不重复登录或自动授权',async()=>{
 const h=mock({state:'available',loginSnapshot:true,sessionMs:600000,challengeMs:300000}),request=h.wx.request;
 let fail=true;h.wx.request=(o:Options)=>{if(fail&&o.url.endsWith('/challenge')){queueMicrotask(()=>o.success({statusCode:503,data:{error:'微信服务暂不可用，请稍后重试。'}}));return{abort(){}};}return request(o);};
 await h.reader.loadForPage();assert.equal(h.reader.getState().remainingCount,1);assert.equal(h.reader.getState().ready,false);assert.ok(h.reader.getState().error);assert.equal(h.login,1);
 fail=false;await h.reader.loadForPage();assert.equal(h.reader.getState().ready,true);assert.equal(h.reader.getState().remainingCount,1);assert.equal(h.login,1);assert.equal(h.subscribe,0);
});
test('登录摘要非法次数不进入界面，也不继续预备或弹出授权',async()=>{
 const h=mock({loginSnapshot:true,invalidLoginSnapshot:true});await h.reader.loadForPage();assert.equal(h.reader.getState().safe,null);assert.equal(h.reader.getState().remainingCount,null);assert.ok(h.reader.getState().error);assert.equal(h.requests.length,1);assert.equal(h.subscribe,0);
});
test('清除会话后迟到的登录摘要不能恢复身份、次数或授权预备',async()=>{
 for(const phase of ['native-login','server-login']){
  const h=mock({state:'available',loginSnapshot:true}),request=h.wx.request,login=h.wx.login;let held:Options|undefined;
  if(phase==='native-login')h.wx.login=(o:Options)=>{held=o;};else h.wx.request=(o:Options)=>{if(o.url.endsWith('/login')){held=o;return{abort(){}};}return request(o);};
  const pending=h.reader.loadForPage();await flush();assert.ok(held);h.reader.clearSession();
  if(phase==='native-login')login(held!);else request(held!);await pending;
  assert.equal(h.reader.getState().safe,null);assert.equal(h.reader.getState().ready,false);assert.equal(h.requests.some(r=>r.url.endsWith('/challenge')),false);
  assert.equal(h.requests.length,phase==='native-login'?0:1);assert.equal(h.subscribe,0);
 }
});
test('登录摘要保留关闭、已用完及未知结果，不把准备或进入页面当作增加次数',async()=>{
 for(const state of ['revoked','consumed','unknown','reserved']){
  const h=mock({state,loginSnapshot:true});await h.reader.loadForPage();assert.equal(h.reader.getState().safe.state,state);assert.equal(h.reader.getState().remainingCount,state==='reserved'?1:0);assert.equal(h.subscribe,0);assert.equal(h.requests.some(r=>r.url.endsWith('/confirm')),false);
 }
});
test('登录摘要仍先检查隐私；未同意前不请求身份或私人次数',async()=>{
 const h=mock({privacy:true,loginSnapshot:true});await h.reader.loadForPage();assert.equal(h.login,0);assert.equal(h.requests.length,0);assert.equal(h.reader.getState().remainingCount,null);assert.equal(h.reader.getState().privacyNeeded,true);
});


test('全局入场后会话清理只清除私人次数，不重播页面入场',async()=>{
  const h=mock({state:'available',loginSnapshot:true,sessionMs:600000,challengeMs:300000}),harness=pageHarness(h.reader),page=harness.page('settings');
  try{
    await flush();page.onHide();page.onShow();
    h.reader.clearSession();harness.feed({loading:true});
    assert.equal(page.data.wechat.remainingCount,null);assert.equal(page.data.contentMotion,'');assert.equal(h.subscribe,0);
  }finally{page.onUnload();}
});


test('首次私人状态尚未返回不展示占位次数，真实次数随原有全局入场一次出现',async()=>{
  const h=mock({state:'available',loginSnapshot:true,sessionMs:600000,challengeMs:300000});const request=h.wx.request;let held:Options|undefined;
  h.wx.request=(o:Options)=>{if(o.url.endsWith('/login')){held=o;return{abort(){}};}return request(o);};
  const ui=pageHarness(h.reader),page=ui.page('settings');
  try{
    await flush();assert.ok(held);assert.equal(page.data.connected,true);assert.equal(page.data.awaitingWechat,true);assert.equal(page.data.contentMotion,'');assert.equal(page.data.wechat.safe,null);assert.equal(page.data.wechat.remainingCount,null);
    assert.equal(page._entranceTimer,null);request(held!);held=undefined;await flush();
    assert.equal(page.data.awaitingWechat,false);assert.equal(page.data.wechat.remainingCount,1);assert.equal(page.data.contentMotion,'content-enter');
    const firstVisible=ui.frames.find(frame=>!frame.awaitingWechat);assert.ok(firstVisible);assert.equal(firstVisible.wechat.remainingCount,1);assert.equal(firstVisible.contentMotion,'content-enter');
    const entrance=page._entranceTimer;assert.ok(entrance);assert.equal(h.subscribe,0);
    page.redraw();assert.equal(page._entranceTimer,entrance,'后续公开刷新不重播入场');
    page.onHide();page.onShow();assert.equal(page.data.contentMotion,'');assert.equal(page._entranceTimer,null);assert.equal(page.data.wechat.remainingCount,1);
  }finally{if(held)request(held);await flush();page.onUnload();}
});


test('已同意隐私后应用预读仅登录并查询次数，不预备nonce或发起授权，短时回前台复用',async()=>{
  for(const loginSnapshot of [true,false]){
    const h=mock({state:'available',loginSnapshot,sessionMs:900000});
    const first=h.reader.warmup();assert.equal(h.reader.warmup(),first);await first;
    assert.equal(h.reader.getState().remainingCount,1);assert.equal(h.subscribe,0);
    assert.equal(h.requests.length,loginSnapshot?1:2);
    assert.equal(h.requests.some(r=>/challenge|confirm|preferences/.test(r.url)||r.method==='DELETE'),false);
    await h.reader.warmup();assert.equal(h.login,1);assert.equal(h.requests.length,loginSnapshot?1:2);
    assert.doesNotMatch(JSON.stringify(h.reader.getState()),/sessionToken|nonce|fixture-reader-session|extraPrivateField/);
  }
});

test('未同意隐私或无法核实隐私时启动预读不登录、不查询、不弹授权',async()=>{
  const denied=mock({privacy:true,loginSnapshot:true});await denied.reader.warmup();
  assert.equal(denied.login,0);assert.equal(denied.requests.length,0);assert.equal(denied.subscribe,0);
  const missing=mock();delete (missing.wx as Options).getPrivacySetting;await missing.reader.warmup();assert.equal(missing.login,0);
  const failed=mock();failed.wx.getPrivacySetting=(o:Options)=>o.fail({});await failed.reader.warmup();assert.equal(failed.login,0);assert.equal(failed.requests.length,0);
  const malformed=mock();malformed.wx.getPrivacySetting=(o:Options)=>o.success({});await malformed.reader.warmup();assert.equal(malformed.login,0);assert.equal(malformed.requests.length,0);
});

test('预读在提醒页之前完成，第一帧就是实际次数；返回不重读、不重复入场',async()=>{
  const h=mock({state:'available',loginSnapshot:true,sessionMs:900000,challengeMs:300000});await h.reader.warmup();
  const page=pageHarness(h.reader).page('settings');
  try{
    assert.equal(page.data.wechat.remainingCount,1);assert.equal(page.data.awaitingWechat,false);assert.equal(page.data.contentMotion,'content-enter');
    await flush();const count=h.requests.length;page.onHide();page.onShow();await flush();
    assert.equal(page.data.contentMotion,'');assert.equal(page.data.awaitingWechat,false);assert.equal(h.requests.length,count);assert.equal(h.subscribe,0);
  }finally{page.onUnload();}
});

test('刚启动立即进提醒与进行中的预读共用一次登录，进入后才准备授权',async()=>{
  const h=mock({state:'available',loginSnapshot:true,sessionMs:900000,challengeMs:300000});let held:Options|undefined;const request=h.wx.request;
  h.wx.request=(o:Options)=>{if(o.url.endsWith('/login')){held=o;return{abort(){}};}return request(o);};
  const warming=h.reader.warmup();await flush();assert.ok(held);
  const page=pageHarness(h.reader).page('settings');
  try{
    assert.equal(page.data.awaitingWechat,true);assert.equal(page.data.contentMotion,'');assert.equal(h.requests.length,0);
    request(held!);held=undefined;await warming;await flush();
    assert.equal(h.login,1);assert.equal(h.requests.filter(r=>r.url.endsWith('/login')).length,1);
    assert.equal(h.requests.filter(r=>r.url.endsWith('/subscription')).length,0);
    assert.equal(h.requests.filter(r=>r.url.endsWith('/challenge')).length,1);assert.equal(page.data.wechat.ready,true);
    assert.equal(page.data.wechat.remainingCount,1);assert.equal(page.data.awaitingWechat,false);assert.equal(page.data.contentMotion,'content-enter');assert.equal(h.subscribe,0);
  }finally{if(held)request(held);await flush();page.onUnload();}
});

test('预读中清理会话，迟到响应不能恢复私人次数或发起授权准备',async()=>{
  const h=mock({state:'available',loginSnapshot:true});let held:Options|undefined;const request=h.wx.request;
  h.wx.request=(o:Options)=>{held=o;return{abort(){}};};
  const warming=h.reader.warmup();await flush();const pageRead=h.reader.loadForPage();h.reader.clearSession();
  assert.ok(held);request(held!);await warming;await pageRead;
  assert.equal(h.reader.getState().safe,null);assert.equal(h.reader.getState().remainingCount,null);assert.equal(h.requests.length,1);assert.equal(h.subscribe,0);
});

test('预读失败不自动重试风暴，实际进入提醒仍可重试并展示结果',async()=>{
  const options={failState:true,loginSnapshot:false,sessionMs:900000},h=mock(options);await h.reader.warmup();
  const count=h.requests.length;await h.reader.warmup();assert.equal(h.requests.length,count);
  options.failState=false;await h.reader.loadForPage();assert.equal(h.reader.getState().remainingCount,0);assert.equal(h.reader.getState().ready,true);assert.equal(h.subscribe,0);
});

test('直接进入后快速离开，迟到预读不会恢复隐藏页面动画或订阅监听',async()=>{
  const h=mock({state:'available',loginSnapshot:true,sessionMs:900000});let held:Options|undefined;const request=h.wx.request;
  h.wx.request=(o:Options)=>{if(o.url.endsWith('/login')){held=o;return{abort(){}};}return request(o);};
  const warming=h.reader.warmup();await flush();const ui=pageHarness(h.reader),page=ui.page('settings');
  page.onHide();request(held!);await warming;await flush();assert.equal(page.data.contentMotion,'');assert.equal(ui.subscriptions,0);
  page.onShow();await flush();assert.equal(page.data.wechat.remainingCount,1);assert.equal(page.data.awaitingWechat,false);assert.equal(page.data.contentMotion,'content-enter');page.onUnload();
});


test('应用前台生命周期启动公共读取后并行预读，后退后台不触发订阅或本地写入',()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const calls:string[]=[],app:Options={};
  const creates:Record<string,Options>={
    './utils/client':{createClient:()=>({start(){calls.push('public');},stop(){calls.push('stop');}})},
    './utils/preferences':{createPreferences:()=>({})},'./utils/transport':{createTransport:()=>({})},
    './utils/wechat':{createWechatReader:()=>({warmup(){calls.push('private');return Promise.resolve();}})},
    './utils/entry-navigation':{createEntryNavigation:()=>({show(){},hide(){}})},
    './utils/app-update':{createAppUpdate:()=>({show(){},hide(){}})}
  };
  new Script(readFileSync(resolve(root,'miniprogram/app.js'),'utf8')).runInNewContext({wx:{},App(value:Options){Object.assign(app,value);},require(path:string){return path==='./config'?config:creates[path];}});
  app.onLaunch();assert.deepEqual(calls,[]);app.onShow({});assert.deepEqual(calls,['public','private']);app.onHide();assert.deepEqual(calls,['public','private','stop']);
});
