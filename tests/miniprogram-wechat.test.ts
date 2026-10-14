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
function mock(options:{state?:string;challengeState?:string;result?:string;privacy?:boolean;failConfirm?:boolean;failState?:boolean;codeStatus?:number}={}){
  let state=options.state||'none',login=0,subscribe=0,clock=now;
  const requests:Options[]=[];
  const wx={
    login(option:Options){login++;queueMicrotask(()=>option.success({code:'fixture-login-code'}));},
    getPrivacySetting(option:Options){queueMicrotask(()=>option.success({needAuthorization:!!options.privacy}));},
    requestSubscribeMessage(option:Options){subscribe++;queueMicrotask(()=>option.success({[option.tmplIds[0]]:options.result||'accept'}));},
    request(option:Options){requests.push(option);queueMicrotask(()=>{
      const path=option.url.replace(config.baseUrl,'');let response:unknown;
      if(path==='/api/wechat/login')response={sessionToken:'fixture-reader-session',expiresAt:new Date(clock+60000).toISOString()};
      else if(path==='/api/wechat/subscription'){
        if(options.failState){option.success({statusCode:401,data:{error:'当前读者会话已失效，请重新连接。'}});return;}
        if(option.method==='DELETE')state='revoked';response=safe(state);
      }else if(path.endsWith('/challenge')){const s=options.challengeState||'challenged';response={state:s,templateId:'fixture-template',...(['available','reserved','unknown'].includes(s)?{}:{nonce:'fixture-single-nonce',expiresAt:new Date(clock+30000).toISOString()})};}
      else if(path.endsWith('/confirm')){if(options.failConfirm){option.fail({errMsg:'internal-detail'});return;}state=option.data.result==='accept'?'available':'rejected';response={...safe(state),acceptedAt:option.data.result==='accept'?new Date(clock).toISOString():undefined,extraPrivateField:'must-not-reach-ui'};}
      else if(path.startsWith('/api/v1/wechat/scene/'))response={publicationId:'fixture-publication'};
      else if(path.startsWith('/api/v1/wechat/code/')){if(options.codeStatus){option.success({statusCode:options.codeStatus,data:{error:options.codeStatus===503?'后台尚未配置微信小程序码。':'该版本已撤回。'}});return;}response={publicationId:'fixture-publication',scene,imageBase64:'iVBORw0KGgo=',contentType:'image/png'};}
      else {option.success({statusCode:404,data:{error:'未找到接口'}});return;}
      option.success({statusCode:200,data:{data:response}});
    });return{abort(){}};}
  };
  const reader=createWechatReader({wxApi:wx,config,now:()=>clock});
  return{wx,reader,requests,get login(){return login;},get subscribe(){return subscribe;},advance(ms:number){clock+=ms;},changeState(value:string){state=value;}};
}

test('创建应用、读取本地状态和无点击调用均不登录，不保存读者会话',async()=>{
  const h=mock();let snapshot:unknown;const off=h.reader.subscribe((value:unknown)=>{snapshot=value;});
  assert.ok(snapshot);assert.equal(h.login,0);assert.equal(h.requests.length,0);
  await h.reader.prepare();assert.equal(h.login,0);assert.equal(h.requests.length,0);assert.match(h.reader.getState().error,/点击/);
  assert.doesNotMatch(JSON.stringify(h.reader.getState()),/sessionToken|nonce|fixture-reader-session|openid/);off();
});

test('主动准备只获取登录/状态/nonce，不弹订阅；第二次点击同步调用微信，再按真实服务返回显示',async()=>{
  const h=mock();await h.reader.prepare({userInitiated:true});
  assert.equal(h.login,1);assert.equal(h.subscribe,0);assert.equal(h.reader.getState().ready,true);
  const promise=h.reader.authorize({userInitiated:true});assert.equal(h.subscribe,1,'授权在点击函数返回前同步发起');await promise;
  assert.equal(h.reader.getState().safe.state,'available');assert.equal(h.reader.getState().ready,false);
  assert.equal(h.reader.getState().label,'已记录本次订阅选择，实际发送以微信结果为准');
  assert.doesNotMatch(JSON.stringify(h.reader.getState()),/永久|已送达|sessionToken|nonce|extraPrivateField/);
  const confirm=h.requests.find(item=>item.url.endsWith('/confirm'))!;assert.deepEqual(confirm.data,{nonce:'fixture-single-nonce',templateId:'fixture-template',result:'accept'});
  assert.equal(confirm.header.Authorization,'Bearer fixture-reader-session');
});

test('重复点击合并准备；重复授权不重弹、不重复确认，同一available不再生成nonce',async()=>{
  const h=mock();await Promise.all([h.reader.prepare({userInitiated:true}),h.reader.prepare({userInitiated:true})]);assert.equal(h.login,1);
  await Promise.all([h.reader.authorize({userInitiated:true}),h.reader.authorize({userInitiated:true})]);assert.equal(h.subscribe,1);
  await h.reader.prepare({userInitiated:true});assert.equal(h.subscribe,1);assert.equal(h.requests.filter(item=>item.url.endsWith('/challenge')).length,1);
  assert.equal(h.requests.filter(item=>item.url.endsWith('/confirm')).length,1);
});

test('拒绝、封禁、过滤按微信返回原样报告，不能伪造accept或仍显示授权可用',async()=>{
  for(const result of ['reject','ban','filter']){const h=mock({result});await h.reader.prepare({userInitiated:true});await h.reader.authorize({userInitiated:true});assert.equal(h.requests.find(item=>item.url.endsWith('/confirm'))!.data.result,result);assert.equal(h.reader.getState().safe.state,'rejected');assert.equal(h.reader.getState().ready,false);}
});

test('已有额度、处理中、未知结果均不再次申请；挑战无nonce时绝不弹窗',async()=>{
  for(const state of ['available','reserved','unknown']){
    const h=mock({state});await h.reader.prepare({userInitiated:true});await h.reader.authorize({userInitiated:true});assert.equal(h.subscribe,0);assert.equal(h.requests.some(item=>item.url.endsWith('/challenge')),false);
    const race=mock({challengeState:state});await race.reader.prepare({userInitiated:true});await race.reader.authorize({userInitiated:true});assert.equal(race.subscribe,0);assert.equal(race.reader.getState().safe.state,state);
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
  await assert.rejects(publicRequest('/api/wechat/subscription').promise,/路径/);
  await assert.rejects(privateRequest(`/api/v1/wechat/scene/${scene}`,{sessionToken:'fixture-reader-session'}).promise,/路径/);
  await assert.rejects(privateRequest('/api/wechat/subscription').promise,/重新建立/);
  await assert.rejects(publicRequest('/api/v1/wechat/scene/../latest').promise,/路径/);
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
});

test('页面声明真实canvas、主动授权和隐私入口，场景解析不按事件猜最新',()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const detail=readFileSync(resolve(root,'miniprogram/pages/detail/index.wxml'),'utf8');
  assert.match(detail,/<canvas type="2d"/);assert.match(detail,/保存海报到相册/);assert.match(detail,/agreePrivacyAuthorization/);
  const settings=readFileSync(resolve(root,'miniprogram/pages/settings/index.wxml'),'utf8');assert.match(settings,/bindtap="authorizeWechat"/);assert.match(settings,/关闭本站微信提醒/);
  const code=readFileSync(resolve(root,'miniprogram/pages/detail/index.js'),'utf8');assert.match(code,/publicationId:result.data.publicationId/);assert.doesNotMatch(code,/wx\.login/);
  const app=readFileSync(resolve(root,'miniprogram/app.js'),'utf8');assert.doesNotMatch(app,/wx\.login|setStorageSync\([^)]*session/);
  assert.doesNotThrow(()=>new Script(code));
});

function pageHarness() {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const publication:Publication={id:'fixture-old',articleId:'fixture-article',eventId:'fixture-event',publishedAt:'2026-10-10T01:00:00Z',cutoffAt:'2026-10-10T01:00:00Z',reason:'隔离页面输入',mode:'news_only',article:{id:'fixture-article',eventId:'fixture-event',title:'测试旧版本标题',summary:'测试旧版本正文',translation:'',category:'product',version:1,status:'published',publicationId:'fixture-old',evidenceIds:[],publishedAt:'2026-10-10T01:00:00Z',updatedAt:'2026-10-10T01:00:00Z'},event:{id:'fixture-event',title:'测试事件',version:1,status:'published',publicationId:'fixture-old',actions:[],evidenceIds:[],updatedAt:'2026-10-10T01:00:00Z'}};
  const latest=structuredClone(publication);latest.id='fixture-new';latest.article.publicationId=latest.id;latest.article.title='测试最新版本标题';latest.article.version=2;latest.event.publicationId=latest.id;
  const data:PublicData={publications:[publication,latest],events:[latest.event],articles:[latest.article],activities:[],evidence:[],notices:[],sources:[],site:{name:'模钥重置雷达',description:'',version:1,autoPublish:true},serverTime:'2026-10-10T04:00:00Z'};
  const listeners=new Set<(value:unknown)=>void>(),requests:{path:string;abortCount:number;resolve:(value:unknown)=>void;reject:(error:Error)=>void}[]=[],calls:string[]=[],navigation:{method:string;url:string}[]=[];
  const app={client:{getState(){return{data,receivedAt:Date.now(),loading:false,unconfigured:false,error:''};},subscribe(fn:(value:unknown)=>void){listeners.add(fn);fn(this.getState());return()=>listeners.delete(fn);},async refresh(){calls.push('refresh');}},preferences:{snapshot(){return{preferences:{},error:''};}},publicApi(path:string){let resolve!:(value:unknown)=>void,reject!:(error:Error)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});const item={path,abortCount:0,resolve,reject};requests.push(item);return{promise,abort(){item.abortCount++;}};},wechat:{subscribe(fn:(value:unknown)=>void){calls.push('reader-subscribe');fn({label:'点击后连接',busy:false});return()=>calls.push('reader-unsubscribe');},async prepare(options:Options){assert.equal(options.userInitiated,true);calls.push('reader-prepare');},async authorize(options:Options){assert.equal(options.userInitiated,true);calls.push('reader-authorize');},async refresh(options:Options){assert.equal(options.userInitiated,true);calls.push('reader-refresh');},async revoke(options:Options){assert.equal(options.userInitiated,true);calls.push('reader-revoke');}}};
  function page(name:string,query:Record<string,string>={}){
    let definition:Options|undefined;const cache=new Map<string,{exports:Options}>();
    function load(filename:string):Options{const existing=cache.get(filename);if(existing)return existing.exports;const module={exports:{}};cache.set(filename,module);new Script(readFileSync(filename,'utf8'),{filename}).runInNewContext({module,exports:module.exports,wx:{showShareMenu(){},hideShareMenu(){},showToast(){},switchTab(options:Options){navigation.push({method:'switchTab',url:options.url});},navigateTo(options:Options){navigation.push({method:'navigateTo',url:options.url});}},getApp(){return app;},setTimeout,clearTimeout,Date,Page(value:Options){definition=value;},require(path:string){const target=resolve(dirname(filename),path.endsWith('.js')?path:`${path}.js`);assert.ok(target.startsWith(resolve(root,'miniprogram')+'/'));return load(target);}});return module.exports;}
    load(resolve(root,`miniprogram/pages/${name}/index.js`));assert.ok(definition);const instance:Options={...definition,data:structuredClone(definition.data),setData(patch:Options){Object.assign(this.data,patch);}};instance.onLoad(query);instance.onShow();return instance;
  }
  return{page,requests,calls,navigation,data,get subscriptions(){return listeners.size;}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

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

test('实际详情无效scene不发请求、不回退最新；未配置真实码失败不创建图片或开启保存',async()=>{
  const invalid=pageHarness(),bad=invalid.page('detail',{scene:'../latest',publicationId:'fixture-new'});assert.equal(invalid.requests.length,0);assert.equal(bad.data.detail,null);assert.match(bad.data.sceneError,/无效/);
  const h=pageHarness(),page=h.page('detail',{publicationId:'fixture-old'});const pending=page.generatePoster();assert.equal(h.requests.length,1);assert.equal(h.requests[0].path,'/api/v1/wechat/code/fixture-old');
  h.requests[0].reject(Object.assign(new Error('微信小程序码尚未配置'),{status:503}));await pending;assert.equal(page.data.posterBusy,false);assert.equal(page.data.posterPreview,'');assert.equal(page._posterArtifact,null);assert.match(page.data.posterError,/未配置/);
  await page.savePoster();assert.match(page.data.posterError,/先生成/);page.onUnload();
});

test('实际设置页面只订阅内存状态，读者连接、授权与撤销均由明确按钮触发',async()=>{
  const h=pageHarness(),page=h.page('settings');assert.deepEqual(h.calls,['reader-subscribe']);
  page.prepareWechat();page.authorizeWechat();page.refreshWechat();page.revokeWechat();await flush();
  assert.deepEqual(h.calls,['reader-subscribe','reader-prepare','reader-authorize','reader-refresh','reader-revoke']);page.onHide();assert.equal(h.calls.at(-1),'reader-unsubscribe');assert.equal(h.subscriptions,0);
});
