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

test('只有下拉期间保留原生三点动画，十次请求均在完成后收起且保留正文',async()=>{
 const h=harness(),p=h.page('home');
 for(let i=0;i<10;i++){
  const work=p.onPullDownRefresh();assert.equal(p.onPullDownRefresh(),work);
  assert.equal(h.requests.length,i+1);assert.equal(h.stops.length,i);assert.equal(p.data.pullRefreshing,true);
  h.timers.tick(2500);assert.equal(h.stops.length,i,'慢请求仍使用原生刷新区域');
  assert.equal(p.data.title,'已加载正文');assert.equal('pullRefreshState' in p.data,false);
  h.requests[i].resolve();await work;assert.equal(h.stops.length,i+1);assert.equal(p.data.pullRefreshing,false);assert.equal(h.timers.jobs.size,0);
 }
 p.onUnload();assert.equal(h.timers.jobs.size,0);
});

test('快响应和失败立即收起原生区域，不加入导航状态文字或滚动跳转',async()=>{
 const h=harness(),p=h.page('news');const a=p.onPullDownRefresh();h.requests[0].resolve();await a;
 assert.equal(h.stops.length,1);assert.equal(h.timers.jobs.size,0);
 const b=p.onPullDownRefresh();h.requests[1].reject(new Error('离线'));await b;
 assert.equal(h.stops.length,2);assert.equal(p.data.title,'已加载正文');assert.equal(p.data.connected,true);
 assert.equal('pullRefreshState' in p.data,false);assert.equal(h.timers.jobs.size,0);p.onUnload();
});

test('原生区域12秒独立兜底，SDK悬挂也不会永远撑开顶部空白',async()=>{
 const h=harness(),p=h.page('home');const work=p.onPullDownRefresh();
 h.timers.tick(11999);assert.equal(h.stops.length,0);h.timers.tick(1);assert.equal(h.stops.length,1);
 assert.equal(h.timers.jobs.size,0);assert.equal(p.data.title,'已加载正文');h.requests[0].resolve();await work;
 assert.equal(h.stops.length,1);p.onUnload();
});

test('隐藏和卸载收起本页手势，旧请求或超时回调不影响新页',async()=>{
 const h=harness(),a=h.page('home');const old=a.onPullDownRefresh(),late=[...h.timers.jobs.values()][0].fn;
 a.onHide();assert.equal(h.stops.length,1);assert.equal(h.timers.jobs.size,0);
 const b=h.page('records'),fresh=b.onPullDownRefresh();h.requests[0].resolve();await old;late();a.onUnload();
 assert.equal(h.stops.length,1);b.onUnload();assert.deepEqual(h.stops,['home','records']);
 h.requests[1].resolve();await fresh;assert.equal(h.stops.length,2);assert.equal(h.timers.jobs.size,0);
});

test('兜底收起后再次下拉复用在途请求，旧回调不能结束新一轮原生手势',async()=>{
 const h=harness(),p=h.page('settings'),old=p.onPullDownRefresh(),late=[...h.timers.jobs.values()][0].fn;
 h.timers.tick(12000);const fresh=p.onPullDownRefresh();assert.equal(h.requests.length,1);
 late();assert.equal(h.stops.length,1);h.requests[0].resolve();await Promise.all([old,fresh]);
 assert.equal(h.stops.length,2);assert.equal(h.timers.jobs.size,0);p.onUnload();
});

test('缓存切页及后台刷新不启动原生下拉，也不显示导航刷新文案',async()=>{
 const h=harness(),a=h.page('home');a.onHide();const b=h.page('news');
 assert.equal(h.stops.length,0);assert.equal(h.requests.length,0);assert.equal('pullRefreshState' in b.data,false);
 assert.equal(b.data.title,'已加载正文');assert.equal(b.data.pullRefreshing,false);b.onUnload();assert.equal(h.timers.jobs.size,0);
});

test('原生停止API不可用或刷新同步异常时仍安全结束，不遗留定时器',async()=>{
 const h=harness(),p=h.page('home');h.api.stopPullDownRefresh=()=>{throw new Error('SDK unavailable');};
 h.app.client.refresh=()=>{throw new Error('SDK unavailable');};await p.onPullDownRefresh();
 assert.equal(h.timers.jobs.size,0);assert.equal(p.data.title,'已加载正文');p.onUnload();
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
