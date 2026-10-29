import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {createRequire} from 'node:module';

const base=new URL('../miniprogram/',import.meta.url);
const localRequire=createRequire(new URL('utils/transport.js',base));
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function clock(){
 let time=0,id=0;const jobs=new Map<number,{at:number;fn:()=>void}>();
 return {jobs,setTimeout(fn:()=>void,ms:number){jobs.set(++id,{at:time+ms,fn});return id;},clearTimeout(key:number){jobs.delete(key);},tick(ms:number){time+=ms;for(const [key,job] of [...jobs])if(job.at<=time){jobs.delete(key);job.fn();}}};
}
function harness(){
 const timers=clock(),stops:string[]=[],requests:{resolve:()=>void;reject:(e:Error)=>void}[]=[];
 let current='',deferCommit=false;const commits:(()=>void)[]=[];
 const state={data:{serverTime:new Date().toISOString(),publications:[],title:'已加载正文'},receivedAt:Date.now(),loading:false,error:''};
 const app={client:{getState:()=>state,setView(){},subscribe(fn:any){fn(state);return ()=>{};},refresh(){return new Promise<void>((resolve,reject)=>requests.push({resolve,reject}));}}};
 const api={stopPullDownRefresh(){stops.push(current);}};
 const module={exports:{} as any};
 new Script(readFileSync(new URL('utils/page.js',base),'utf8')).runInNewContext({module,require:(name:string)=>name==='./model'?{displayTime:(s:string)=>s}:{enterPage:()=>false,suspendEntry(){},preserveNativeReturn(){}},getApp:()=>app,wx:api,...timers,Date,Set,Promise});
 function page(name:string){
  current=name;const def=module.exports.createPage((data:any)=>({title:data?.title}));
  const p={...def,data:{...def.data},setData(patch:any,done?:()=>void){Object.assign(this.data,patch);if(done){if(deferCommit)commits.push(done);else done();}}};
  p.onLoad({});p.onShow();timers.tick(560);return p;
 }
 return {timers,stops,requests,app,api,page,state,commits,defer(value:boolean){deferCommit=value;},select(name:string){current=name;}};
}

test('十次慢请求下拉在反馈提交后立即收起，持续旋转直至响应，正文保留',async()=>{
 const h=harness(),p=h.page('home');
 for(let i=0;i<10;i++){
  const work=p.onPullDownRefresh();assert.equal(h.requests.length,i+1);
  assert.equal(h.stops.length,i+1,'不人为等待300ms');assert.equal(p.data.pullRefreshState,'loading');
  h.timers.tick(5000);assert.equal(p.data.title,'已加载正文');assert.equal(p.data.pullRefreshState,'loading');
  assert.equal(h.timers.jobs.size,0,'请求悬挂不反复创建提示计时器');
  h.requests[i].resolve();await work;assert.equal(h.stops.length,i+1);
  assert.equal(p.data.pullRefreshState,'success');h.timers.tick(1400);assert.equal(p.data.pullRefreshState,'');
 }
 p.onUnload();assert.equal(h.timers.jobs.size,0);
});

test('快响应和失败均有准确结果反馈，失败保留正文，结束后移除反馈',async()=>{
 const h=harness(),p=h.page('news');const a=p.onPullDownRefresh();h.requests[0].resolve();await a;
 assert.equal(h.stops.length,1);assert.equal(p.data.pullRefreshState,'success');
 const b=p.onPullDownRefresh();h.requests[1].reject(new Error('离线'));await b;
 assert.equal(h.stops.length,2);assert.equal(p.data.pullRefreshState,'error');
 assert.equal(p.data.title,'已加载正文');assert.equal(p.data.connected,true);
 h.timers.tick(3499);assert.equal(p.data.pullRefreshState,'error');h.timers.tick(1);assert.equal(p.data.pullRefreshState,'');
 p.onUnload();assert.equal(h.timers.jobs.size,0);
});

test('渲染回调延迟时300ms兜底，隐藏后旧回调不能收起新页手势',async()=>{
 const h=harness(),a=h.page('home');h.defer(true);
 const old=a.onPullDownRefresh(),late=h.commits.shift()!;
 h.timers.tick(299);assert.equal(h.stops.length,0);h.timers.tick(1);assert.equal(h.stops.length,1);
 a.onHide();assert.equal(a.data.pullRefreshState,'');assert.equal(h.timers.jobs.size,0);
 h.defer(false);const b=h.page('records');h.defer(true);const fresh=b.onPullDownRefresh();
 h.requests[0].resolve();await old;late();a.onUnload();assert.equal(h.stops.length,1);
 b.onUnload();assert.deepEqual(h.stops,['home','records']);h.requests[1].resolve();await fresh;
 assert.equal(h.stops.length,2);assert.equal(b.data.pullRefreshState,'');assert.equal(h.timers.jobs.size,0);
});

test('同页等待期间重复下拉不重复请求，原生API不可用不阻断刷新',async()=>{
 const h=harness(),p=h.page('settings'),old=p.onPullDownRefresh();
 const fresh=p.onPullDownRefresh();assert.equal(fresh,old);assert.equal(h.requests.length,1);
 assert.equal(h.stops.length,2);assert.equal(p.data.pullRefreshState,'loading');
 h.requests[0].resolve();await old;
 h.api.stopPullDownRefresh=()=>{throw new Error('SDK unavailable');};
 const next=p.onPullDownRefresh();assert.equal(h.requests.length,2);h.requests[1].resolve();await next;
 assert.equal(p.data.pullRefreshState,'success');p.onUnload();assert.equal(h.timers.jobs.size,0);
});

test('旧结果的迟到清除和隐藏前的请求均不能覆盖新一轮反馈',async()=>{
 const h=harness(),p=h.page('home');const first=p.onPullDownRefresh();h.requests[0].resolve();await first;
 const clearOld=[...h.timers.jobs.values()][0].fn;
 const next=p.onPullDownRefresh();clearOld();assert.equal(p.data.pullRefreshState,'loading');
 p.onHide();p.onShow();h.timers.tick(560);assert.equal(p.data.pullRefreshState,'');
 const current=p.onPullDownRefresh();h.requests[1].resolve();await next;
 assert.equal(p.data.pullRefreshState,'loading');h.requests[2].resolve();await current;
 assert.equal(p.data.pullRefreshState,'success');p.onUnload();assert.equal(h.timers.jobs.size,0);
});

test('客户端捕获的错误和同步失败均显示失败，不误报已更新',async()=>{
 const h=harness(),p=h.page('home');const work=p.onPullDownRefresh();h.state.error='连接超时';h.requests[0].resolve();await work;
 assert.equal(p.data.pullRefreshState,'error');
 h.state.error='';h.app.client.refresh=()=>{throw new Error('SDK unavailable');};await p.onPullDownRefresh();
 assert.equal(p.data.pullRefreshState,'error');p.onUnload();assert.equal(h.timers.jobs.size,0);
});

function transport(api:any){
 const timers=clock(),module={exports:{} as any};
 new Script(readFileSync(new URL('utils/transport.js',base),'utf8')).runInNewContext({module,require:localRequire,...timers,Promise,Date,Set});
 return {timers,request:module.exports.createTransport(api,{mode:'cloud',cloudEnv:'fixture',serviceName:'fixture',timeoutMs:1000})};
}
test('云初始化悬挂有全链路期限，晚到初始化不发请求，下次可重新初始化',async()=>{
 let finish:any,initializations=0,calls=0;
 const h=transport({cloud:{init(){initializations++;return new Promise(resolve=>{finish=resolve;});},callContainer(){calls++;}}});
 const first=h.request('/api/v1/version'),rejected=assert.rejects(first.promise,/连接超时/);
 h.timers.tick(1000);await rejected;finish();await flush();assert.equal(calls,0);assert.equal(h.timers.jobs.size,0);
 const next=h.request('/api/v1/version');assert.equal(initializations,2);const cancelled=assert.rejects(next.promise,/取消/);next.abort();await cancelled;assert.equal(h.timers.jobs.size,0);
});
test('云请求悬挂超时后迟到结果无效，正常返回清除期限且复用初始化',async()=>{
 let complete:any,initializations=0;
 const h=transport({cloud:{init(){initializations++;},callContainer(){return new Promise(resolve=>{complete=resolve;});}}});
 const first=h.request('/api/v1/version'),expired=assert.rejects(first.promise,/连接超时/);await flush();h.timers.tick(1000);await expired;
 complete({statusCode:200,data:{data:{version:'old'}}});await flush();
 const next=h.request('/api/v1/version');await flush();complete({statusCode:200,data:{data:{version:'fresh'}}});assert.equal((await next.promise).version,'fresh');
 assert.equal(initializations,1);assert.equal(h.timers.jobs.size,0);
});

test('HTTPS回调永不返回时也受统一期限保护，并中止底层请求、忽略迟到结果',async()=>{
 const timers=clock(),module={exports:{} as any};let callback:any,aborted=0;
 new Script(readFileSync(new URL('utils/transport.js',base),'utf8')).runInNewContext({module,require:localRequire,...timers,Promise,Date,Set});
 const request=module.exports.createTransport({request(options:any){callback=options;return {abort(){aborted++;}};}},{mode:'https',baseUrl:'https://isolated.example.org',timeoutMs:1000});
 const work=request('/api/v1/version'),expired=assert.rejects(work.promise,/连接超时/);
 timers.tick(1000);await expired;assert.equal(aborted,1);assert.equal(timers.jobs.size,0);
 callback.success({statusCode:200,data:{data:{version:'late'}}});await flush();assert.equal(timers.jobs.size,0);
});
