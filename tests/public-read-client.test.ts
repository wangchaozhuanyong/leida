import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createClient}=require('../miniprogram/utils/client.js');
const config={mode:'https',baseUrl:'https://fixture.example.org',pollMs:5000,timeoutMs:10000};
const data=()=>({events:[],articles:[],publications:[],evidence:[],notices:[],activities:[],sources:[{id:'fixture-source',name:'隔离测试',status:'healthy',lastSuccessAt:'2026-10-13T00:00:00Z'}],site:{name:'测试'},serverTime:'2026-10-13T01:00:00Z'});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function clock(){let time=0,id=0;const jobs=new Map<number,{fn:()=>void;delay:number}>();return {jobs,now:()=>time,timers:{setTimeout(fn:()=>void,delay:number){jobs.set(++id,{fn,delay});return id;},clearTimeout(key:number){jobs.delete(key);}},tick(){const first=jobs.entries().next().value;assert.ok(first);jobs.delete(first[0]);time+=first[1].delay;first[1].fn();}};}

test('采集时间变化只取状态信息；断网有限退避，回到前台立即检查',async()=>{
 const timing=clock(),calls:string[]=[];let version='v1',content='c1',failed=false;
 const wxApi={request(options:any){calls.push(options.url);queueMicrotask(()=>{
  if(failed){options.fail();return;}
  const body=options.url.includes('/version?')?{data:{version,contentVersion:content}}:{data:data(),version,contentVersion:content};
  options.success({statusCode:200,data:body});
 });return {abort(){}};}};
 const client=createClient({wxApi,config,timers:timing.timers,now:timing.now,random:()=>0.5});await client.start();
 assert.equal(timing.jobs.size,1);const original=client.getState().data;
 version='v2';timing.tick();await settle();assert.equal(calls.at(-1),'https://fixture.example.org/api/v1/bootstrap?view=state');assert.equal(client.getState().contentVersion,'c1');assert.equal(client.getState().data.publications,original.publications);
 failed=true;timing.tick();await settle();assert.match(client.getState().error,/连接失败/);assert.equal([...timing.jobs.values()][0].delay,10500);
 timing.tick();await settle();assert.equal([...timing.jobs.values()][0].delay,20500);
 client.stop();assert.equal(timing.jobs.size,0);failed=false;const count=calls.length;await client.start();assert.equal(calls.length,count+1);assert.match(calls.at(-1)!,/version\?light=1/);client.stop();
});

test('切换页面取消旧响应；分页位置与当前页面独立',async()=>{
 const timing=clock(),requests:any[]=[];
 const wxApi={request(options:any){requests.push(options);return {abort(){}};}};
 const client=createClient({wxApi,config,timers:timing.timers,random:()=>0});const home=client.start();
 const history=client.setView({view:'history',filter:'banked_reset'});
 requests[1].success({statusCode:200,data:{data:data(),version:'history',contentVersion:'changed',page:{ids:[],nextCursor:'next_page',total:40}}});await history;
 requests[0].success({statusCode:200,data:{data:data(),version:'old',contentVersion:'old'}});await home;
 assert.equal(client.getState().version,'history');assert.equal(client.getState().page.nextCursor,'next_page');
 const more=client.more();assert.match(requests[2].url,/view=history&filter=banked_reset&cursor=next_page/);
 requests[2].success({statusCode:200,data:{data:data(),version:'history',contentVersion:'changed',page:{ids:[],nextCursor:null,total:40}}});await more;assert.equal(client.getState().page.nextCursor,null);
 const news=client.setView({view:'news',filter:'product'});assert.equal(client.getState().data,null);assert.equal(client.getState().page,null);
 requests[3].success({statusCode:200,data:{data:data(),version:'news',contentVersion:'news',page:{ids:[],nextCursor:null,total:0}}});await news;assert.equal(client.getState().version,'news');client.stop();
});
