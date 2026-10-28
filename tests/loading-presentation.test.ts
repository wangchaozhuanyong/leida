import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {Script} from 'node:vm';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {LoadingContent} from '../src/components/public/LoadingContent';

function harness() {
  const source=new URL('../miniprogram/utils/page.js',import.meta.url);
  const localRequire=createRequire(source),module={exports:{} as any};
  const timers=new Map<number,()=>void>(),writes:any[]=[];let id=0,listener:any;
  let state:any={data:null,loading:true,error:'',unconfigured:false,receivedAt:Date.now()};
  const app={client:{setView:()=>Promise.resolve(),subscribe(fn:any){listener=fn;fn(state);return ()=>{listener=null;};},getState:()=>state}};
  const entry={exports:{}};new Script(readFileSync(new URL('../miniprogram/utils/entry-navigation.js',import.meta.url),'utf8')).runInNewContext({module:entry,getApp:()=>app,wx:{}});
  new Script(readFileSync(source,'utf8')).runInNewContext({module,require:(name:string)=>name==='./entry-navigation'?entry.exports:localRequire(name),getApp:()=>app,wx:{},Date,Set,setTimeout(fn:()=>void,ms:number){assert.equal(ms,560);timers.set(++id,fn);return id;},clearTimeout(key:number){timers.delete(key);}});
  const definition=module.exports.createPage((data:any)=>({title:data?.title||'',items:data?.items||[]}),{view:(p:any)=>({view:'news',filter:p.filter||'all'})});
  const page={...definition,data:{...definition.data},setData(patch:any,done?:()=>void){writes.push(patch);Object.assign(this.data,patch);done?.();}};
  page.onLoad({});page.onShow();
  return {page,timers,writes,send(patch:any){state={...state,...patch};listener?.(state);},ready(){this.send({data:{serverTime:new Date().toISOString(),publications:[],title:'真实消息',items:[{id:'first'}]},loading:false,error:''});}};
}

test('冷启动占位不伪造业务内容；响应当次提交即显示，没有入场等待',()=>{
  const h=harness();assert.equal(h.page.data.loading,true);assert.equal(h.page.data.connected,false);assert.equal(h.page.data.title,'');
  h.ready();assert.equal(h.page.data.connected,true);assert.equal(h.page.data.title,'真实消息');assert.equal(h.page.data.items[0].id,'first');
  assert.equal(h.page.data.contentMotion,'content-enter');assert.equal(h.timers.size,1);
  h.page.onUnload();assert.equal(h.timers.size,0);
});
test('后台刷新、错误和计时重绘保留内容，不重复启动入场',()=>{
  const h=harness();h.ready();const finish=[...h.timers.values()][0];h.timers.clear();finish();
  for(const patch of [{loading:true},{loading:false,error:'连接中断'},{error:''}]){
    h.send(patch);assert.equal(h.page.data.connected,true);assert.equal(h.page.data.title,'真实消息');assert.equal(h.page.data.contentMotion,'');assert.equal(h.timers.size,0);
  }
  h.page.redraw();assert.equal(h.timers.size,0);h.page.onUnload();
});
test('切到后台取消动画定时器；迟到回调不写隐藏页；返回不重播',()=>{
  const h=harness();h.ready();const late=[...h.timers.values()][0];h.page.onHide();assert.equal(h.timers.size,0);
  const count=h.writes.length;late();assert.equal(h.writes.length,count);
  h.page.onShow();assert.equal(h.page.data.contentMotion,'');assert.equal(h.page.data.title,'真实消息');assert.equal(h.timers.size,0);h.page.onUnload();
});
test('新筛选首次进入一次，回到已显示筛选直接恢复且无动画计时泄漏',()=>{
  const h=harness();h.ready();h.page._params={filter:'reset'};h.page.reloadView();h.page.redraw();
  assert.equal(h.page.data.contentMotion,'content-enter');assert.equal(h.timers.size,1);
  const finish=[...h.timers.values()][0];h.timers.clear();finish();
  h.page._params={filter:'all'};h.page.reloadView();h.page.redraw();assert.equal(h.page.data.contentMotion,'');assert.equal(h.timers.size,0);h.page.onUnload();
});
test('首次网络错误可直接重试，第一次成功仍有一次内容入场',()=>{
  const h=harness();h.send({loading:false,error:'无法连接'});assert.equal(h.page.data.contentMotion,'');assert.equal(h.timers.size,0);
  h.ready();assert.equal(h.page.data.contentMotion,'content-enter');assert.equal(h.page.data.error,'');h.page.onUnload();
});
test('过期快照不显示为可信内容，也不触发内容入场',()=>{
  const h=harness();h.send({data:{serverTime:new Date().toISOString(),publications:[],title:'过期记录'},snapshotPending:true,receivedAt:Date.now()-86400001});
  assert.equal(h.page.data.clockUntrusted,true);assert.equal(h.page.data.connected,false);assert.equal(h.page.data.title,'');assert.equal(h.timers.size,0);h.page.onUnload();
});
test('入场期间切换到冷筛选，旧动画被取消，失败页不残留动画标记',()=>{
  const h=harness();h.ready();h.page._params={filter:'product'};h.page.reloadView();h.send({data:null,loading:true});
  assert.equal(h.page.data.contentMotion,'');assert.equal(h.timers.size,0);
  h.send({loading:false,error:'无法连接'});assert.equal(h.page.data.contentMotion,'');h.page.onUnload();
});
test('网页四种占位使用真实结构及状态语义，不显示虚构数字、倒计时或加载进度条',()=>{
  for(const variant of ['home','calendar','detail','list'] as const){
    const html=renderToStaticMarkup(createElement(LoadingContent,{variant}));
    assert.match(html,/role="status"/);assert.match(html,/aria-label="正在加载内容"/);assert.match(html,/aria-hidden="true"/);
    assert.doesNotMatch(html,/pub-loading-bar|已重置|剩余|\d+小时|0次/);
    if(variant==='calendar')assert.equal((html.match(/<span><\/span>/g)||[]).length,35);
  }
});
