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
 let current='';
 const state={data:{serverTime:new Date().toISOString(),publications:[],title:'已加载正文'},receivedAt:Date.now(),loading:false};
 const app={client:{getState:()=>state,setView(){},subscribe(fn:any){fn(state);return ()=>{};},refresh(){return new Promise<void>((resolve,reject)=>requests.push({resolve,reject}));}}};
 const api={stopPullDownRefresh(){stops.push(current);}};
 const module={exports:{} as any};
 new Script(readFileSync(new URL('utils/page.js',base),'utf8')).runInNewContext({module,require:(name:string)=>name==='./model'?{displayTime:(s:string)=>s}:{enterPage:()=>false,suspendEntry(){},preserveNativeReturn(){}},getApp:()=>app,wx:api,...timers,Date,Set,Promise});
 function page(name:string){
  current=name;const def=module.exports.createPage((data:any)=>({title:data?.title}));
  const p={...def,data:{...def.data},setData(patch:any,done?:()=>void){Object.assign(this.data,patch);done?.();}};
  p.onLoad({});p.onShow();timers.tick(560);return p;
 }
 return {timers,stops,requests,app,api,page,select(name:string){current=name;}};
}

test('十次慢请求下拉在300ms收起，正文保留，迟到请求不重复停止手势',async()=>{
 const h=harness(),p=h.page('home');
 for(let i=0;i<10;i++){
  const work=p.onPullDownRefresh();assert.equal(p.onPullDownRefresh(),work,'同一手势合并');assert.equal(h.requests.length,i+1);
  h.timers.tick(299);assert.equal(h.stops.length,i);assert.equal(p.data.title,'已加载正文');
  h.timers.tick(1);assert.equal(h.stops.length,i+1);assert.equal(h.timers.jobs.size,0);
  h.requests[i].resolve();await work;assert.equal(h.stops.length,i+1);
 }
 p.onUnload();assert.equal(h.timers.jobs.size,0);
});

test('快响应和失败都释放手势，失败保留正文且不产生滚动跳转',async()=>{
 const h=harness(),p=h.page('news');const a=p.onPullDownRefresh();h.requests[0].resolve();await a;
 assert.equal(h.stops.length,1);assert.equal(h.timers.jobs.size,0);
 const b=p.onPullDownRefresh();h.requests[1].reject(new Error('离线'));await b;
 assert.equal(h.stops.length,2);assert.equal(p.data.title,'已加载正文');assert.equal(p.data.connected,true);p.onUnload();
});

test('隐藏和卸载立即释放本页手势，旧请求或兜底不能收起新页手势',async()=>{
 const h=harness(),a=h.page('home');const old=a.onPullDownRefresh();const late=[...h.timers.jobs.values()][0].fn;
 a.onHide();assert.equal(h.stops.length,1);assert.equal(h.timers.jobs.size,0);
 const b=h.page('records'),fresh=b.onPullDownRefresh();
 h.requests[0].resolve();await old;late();a.onUnload();assert.equal(h.stops.length,1);
 b.onUnload();assert.deepEqual(h.stops,['home','records']);h.requests[1].resolve();await fresh;assert.equal(h.stops.length,2);assert.equal(h.timers.jobs.size,0);
});

test('相同页面下一次手势不受上一代请求finally影响；原生API不可用不阻断刷新',async()=>{
 const h=harness(),p=h.page('settings');const old=p.onPullDownRefresh();h.timers.tick(300);
 const fresh=p.onPullDownRefresh();h.requests[0].resolve();await old;assert.equal(h.stops.length,1);
 h.api.stopPullDownRefresh=()=>{throw new Error('SDK unavailable');};h.timers.tick(300);
 h.requests[1].resolve();await fresh;p.onUnload();assert.equal(h.timers.jobs.size,0);
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
