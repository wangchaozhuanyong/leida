import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {createClient}=require('../miniprogram/utils/client');
const {createPublicSnapshot}=require('../miniprogram/utils/public-snapshot');
const {homeResetStatus}=require('../miniprogram/utils/home-reset-status');
const config={mode:'https',baseUrl:'https://fixture.example.org',cloudEnv:'',serviceName:'',pollMs:300000};
const baseTime=Date.parse('2026-10-25T00:00:00Z');
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function response(version='v1',at=baseTime){
 const action={id:'a1',kind:'automatic_reset',scope:'public',stage:'promised',eligibility:'公开',statementAt:new Date(baseTime-3600000).toISOString(),expectedAt:new Date(baseTime+3600000).toISOString(),evidenceIds:['e1']};
 const event={id:'ev1',publicationId:'p1',title:'公开预告',version:1,status:'published',evidenceIds:['e1'],updatedAt:new Date(at).toISOString(),actions:[action]};
 const article={id:'ar1',eventId:'ev1',publicationId:'p1',title:'公开预告',summary:'公开预计安排',translation:'',category:'reset',version:1,status:'published',evidenceIds:['e1'],publishedAt:new Date(baseTime-3600000).toISOString(),updatedAt:new Date(at).toISOString()};
 const publication={id:'p1',eventId:'ev1',articleId:'ar1',event,article,publishedAt:article.publishedAt,cutoffAt:article.publishedAt,reason:'测试'};
 return {version,contentVersion:version,data:{serverTime:new Date(at).toISOString(),site:{name:'测试雷达',description:'',autoPublish:true,version:1},events:[event],articles:[article],publications:[publication],evidence:[{id:'e1',sourceId:'s1',messageId:'m1',url:'https://example.org/post',text:'公开重置预告',publishedAt:article.publishedAt,collectedAt:article.publishedAt,contextComplete:true,historical:false,provenance:'official',textOrigin:'original'}],sources:[{id:'s1',name:'公开来源',status:'healthy',lastSuccessAt:new Date(at).toISOString()}],notices:[],activities:[]}};
}
function storage(){let saved:any;const writes:any[]=[];return {get value(){return saved;},set value(value){saved=value;},writes,api:{getStorage(o:any){queueMicrotask(()=>saved?o.success({data:structuredClone(saved)}):o.fail());},setStorage(o:any){saved=structuredClone(o.data);writes.push(saved);queueMicrotask(()=>o.success?.());}}};}
function multiStorage(){
 const values=new Map<string,any>(),writes:string[]=[];
 return {values,writes,api:{getStorage(o:any){queueMicrotask(()=>values.has(o.key)?o.success({data:structuredClone(values.get(o.key))}):o.fail());},setStorage(o:any){values.set(o.key,structuredClone(o.data));writes.push(o.key);queueMicrotask(()=>o.success?.());}}};
}
function network(store=storage(),clock=baseTime){const calls:any[]=[];let now=clock;const api={...store.api,request(o:any){calls.push(o);return{abort(){}};}};return {calls,store,api,now:()=>now,advance:(ms:number)=>now+=ms,reply(i:number,body=response(),status=200){calls[i].success({statusCode:status,data:body});},client(){return createClient({wxApi:api,config,now:()=>now});}};}
async function seed(store:ReturnType<typeof storage>,value=response(),time=baseTime){createPublicSnapshot(store.api,config,{now:()=>time}).save({...value,receivedAt:time});await flush();assert(store.value);}

test('冷启动并行读取快照和一个首页请求；快照先显示但不能视为已联网验证',async()=>{
 const store=storage();await seed(store);const n=network(store),client=n.client();
 const work=client.start();assert.equal(n.calls.length,1);assert.match(n.calls[0].url,/bootstrap\?view=home$/);
 await flush();assert.equal(client.getState().data.site.name,'测试雷达');assert.equal(client.getState().snapshotPending,true);assert.equal(client.getState().loading,true);assert.equal(n.calls.length,1);
 n.reply(0,response('v2'));await work;assert.equal(client.getState().snapshotPending,false);assert.equal(client.getState().version,'v2');client.stop();
});
test('网络先返回时，迟到的本地资料不能覆盖新结果；缓存读取失败不增加请求',async()=>{
 const store=storage();await seed(store);let held:any;const n=network(store);n.api.getStorage=o=>{held=o;};const client=n.client(),work=client.start();n.reply(0,response('network-new'));await work;held.success({data:store.value});await flush();assert.equal(client.getState().version,'network-new');assert.equal(client.getState().snapshotPending,false);assert.equal(n.calls.length,1);client.stop();
});
test('缓存恢复后请求失败保留公开资料并明确未核对，重试直接拉首页而不多查一次版本',async()=>{
 const store=storage();await seed(store);const n=network(store),client=n.client(),first=client.start();await flush();n.calls[0].fail();await first;assert(client.getState().data);assert.equal(client.getState().snapshotPending,true);assert(client.getState().error);
 const retry=client.refresh(true);assert.match(n.calls[1].url,/bootstrap\?view=home$/);n.reply(1,response('fresh'));await retry;assert.equal(client.getState().snapshotPending,false);client.stop();
});
test('401、429和500都保留待核对快照；恢复后撤回信息完整替换旧记录',async()=>{
 for(const status of [401,429,500]){
  const store=storage();await seed(store);const n=network(store),client=n.client(),first=client.start();await flush();n.reply(0,{error:'暂时无法读取'} as any,status);await first;
  assert.equal(client.getState().snapshotPending,true);assert.equal(client.getState().data.articles[0].status,'published');
  const fresh=response('withdrawn');fresh.data.articles[0].status='withdrawn';fresh.data.publications[0].article.status='withdrawn';fresh.data.events[0].status='withdrawn';fresh.data.publications[0].event.status='withdrawn';
  const retry=client.refresh(false);n.reply(1,fresh);await retry;assert.equal(client.getState().snapshotPending,false);assert.equal(client.getState().data.articles[0].status,'withdrawn');assert.equal(store.value.data.articles[0].status,'withdrawn');client.stop();
 }
});
test('损坏、不兼容、跨环境、24小时到期、时钟回拨和过大快照均不进入首页',async()=>{
 const store=storage();await seed(store);const good=structuredClone(store.value);
 const mutations=[(v:any)=>v.schema='old-model',(v:any)=>v.connection='other-env',(v:any)=>v.savedAt=baseTime-86400000,(v:any)=>v.savedAt=baseTime+1,(v:any)=>v.data.events=[],(v:any)=>v.data.site.name='x'.repeat(300000),(v:any)=>v.data.serverTime='2099-01-01T00:00:00Z'];
 for(const change of mutations){store.value=structuredClone(good);change(store.value);const n=network(store),client=n.client(),work=client.start();await flush();assert.equal(client.getState().data,null);n.reply(0);await work;client.stop();}
 store.value='{bad json';assert.equal(await createPublicSnapshot(store.api,config,{now:()=>baseTime}).load(),null);
});
test('无存储和读写失败均不影响网络成功；只保存明确公共投影',async()=>{
 const store=storage(),value:any=response();value.data.sessionToken='PRIVATE_TEST';value.data.sources[0].cookie='PRIVATE_TEST';value.data.evidence[0].metadata={title:'公共标题',nonce:'PRIVATE_TEST'};
 await seed(store,value);assert.doesNotMatch(JSON.stringify(store.value),/PRIVATE_TEST|sessionToken|cookie|nonce/);assert.equal(store.value.data.evidence[0].metadata.title,'公共标题');
 const n=network(store);n.api.getStorage=()=>{throw Error('read failure');};n.api.setStorage=()=>{throw Error('quota');};const client=n.client(),work=client.start();n.reply(0);await work;assert(client.getState().data);assert.equal(client.getState().snapshotPending,false);client.stop();
});
test('存储写入串行且合并为最新版本，不允许慢旧写覆盖较新快照',async()=>{
 const held:any[]=[];const store=createPublicSnapshot({setStorage(o:any){held.push(o);}},config,{now:()=>baseTime});
 for(const v of ['v1','v2','v3'])store.save({...response(v),receivedAt:baseTime});
 assert.equal(held.length,1);held[0].success();assert.equal(held.length,2);assert.equal(held[1].data.version,'v3');held[1].success();
});
test('缓存数据先按实际经过时间重算到点及24小时失效，不复活旧预告',async()=>{
 const store=storage();await seed(store);const n=network(store),client=n.client(),work=client.start();await flush();const saved=client.getState();
 assert.equal(homeResetStatus(saved.data,new Date(baseTime).toISOString()).cards[0].state,'scheduled');
 assert.equal(homeResetStatus(saved.data,new Date(baseTime+3600000).toISOString()).cards[0].state,'overdue');
 const expired=homeResetStatus(saved.data,new Date(baseTime+25*3600000).toISOString()).cards[0];assert.equal(expired.state,'waiting');assert(expired.expiredRound);
 n.reply(0);await work;client.stop();
});
test('切页和后台丢弃迟到缓存；十次快速切页后旧请求不能覆盖当前页',async()=>{
 const n=network();let held:any;n.api.getStorage=o=>{held=o;};const client=n.client(),first=client.start();
 const jobs=[first];for(let i=0;i<10;i++)jobs.push(client.setView({view:'detail',entity:'publications',id:'p'+i}));
 const store=storage();await seed(store);held.success({data:store.value});await flush();assert.equal(client.getState().data,null);
 n.reply(n.calls.length-1,response('last'));await flush();for(let i=0;i<n.calls.length-1;i++)n.reply(i,response('old'));await Promise.all(jobs);assert.equal(client.getState().version,'last');client.stop();
});
test('前台刷新取消后台预取；进入后台后不继续预取；预取无权覆盖首页',async()=>{
 const n=network(),client=n.client(),first=client.start();n.reply(0);await first;
 const prefetch=client.prefetchCalendar();assert.equal(n.calls.length,2);const refresh=client.refresh(false);assert.equal(n.calls.length,3);n.reply(1,response('prefetch-old'));n.reply(2,response('foreground'));await Promise.all([prefetch,refresh]);assert.equal(client.getState().version,'foreground');client.stop();await client.prefetchCalendar();assert.equal(n.calls.length,3);
});
test('缓存读取悬挂200毫秒后退出，迟到回调无效，网络不用等待缓存',async()=>{
 let callback:any,timeout:any;const store=storage();await seed(store);const loader=createPublicSnapshot({getStorage(o:any){callback=o;}},config,{now:()=>baseTime,timers:{setTimeout(fn:any,ms:number){assert.equal(ms,200);timeout=fn;return 1;},clearTimeout(){}}});
 const work=loader.load();timeout();assert.equal(await work,null);callback.success({data:store.value});assert.equal(await work,null);
});
test('海报背景仅放在已有分包，内容原字节保留；提醒页复用整页加载与入场，不再有独立提醒骨架',()=>{
 for(const name of ['precision','editorial']){assert(existsSync(new URL('../miniprogram/packages/poster/'+name+'.jpg',import.meta.url)));assert(!existsSync(new URL('../miniprogram/assets/posters/'+name+'.jpg',import.meta.url)));}
 const view=readFileSync(new URL('../miniprogram/pages/settings/index.wxml',import.meta.url),'utf8');assert.match(view,/<page-loader wx:if="\{\{!contentReady\}\}"/);assert.doesNotMatch(view,/reminder-skeleton|settled-reveal/);assert.match(view,/inbox-card/);
});

test('约100KB真实故障规模的ASCII公开资料可保存与恢复；中英文及emoji仍按实际容量限制',async()=>{
 for(const [text,accepted] of [['a'.repeat(93000),true],['公开'.repeat(23000),true],['🛰'.repeat(50000),true],['x'.repeat(300000),false],['🛰'.repeat(70000),false]] as const){
  const store=storage(),value=response();value.data.evidence[0].text=text;
  const snapshot=createPublicSnapshot(store.api,config,{now:()=>baseTime});snapshot.save({...value,receivedAt:baseTime});await flush();
  assert.equal(!!store.value,accepted);
  const restored=await snapshot.load();assert.equal(!!restored,accepted);
  if(accepted)assert.equal(restored.data.evidence[0].text,text);
 }
});
test('四个公开页各自持久保存，记录的大响应仍有界；未知页面、跨页及损坏分页被拒绝',async()=>{
 const store=multiStorage();
 for(const view of ['home','news','calendar','notices']){
  const value=response(view);value.data.site.name=view;
  if(view==='calendar')value.data.evidence[0].text='calendar'.repeat(42000);
  const snapshot=createPublicSnapshot(store.api,config,{now:()=>baseTime,view});snapshot.save({...value,page:view==='news'?{ids:['p1'],total:21,nextCursor:'next-20'}:null,receivedAt:baseTime});await flush();
  assert.equal((await snapshot.load()).data.site.name,view);
 }
 assert.equal(store.values.size,4);
 const home=store.values.get('radar:public-home:v1');store.values.set('radar:public-home:v1',store.values.get('radar:public-news:v1'));
 assert.equal(await createPublicSnapshot(store.api,config,{now:()=>baseTime}).load(),null);store.values.set('radar:public-home:v1',home);
 const news=store.values.get('radar:public-news:v1');news.page.total=-1;
 assert.equal(await createPublicSnapshot(store.api,config,{now:()=>baseTime,view:'news'}).load(),null);
 const unsupported=createPublicSnapshot(store.api,config,{now:()=>baseTime,view:'private'});unsupported.save({...response(),receivedAt:baseTime});assert.equal(await unsupported.load(),null);assert.equal(store.values.size,4);
 const oversized=response();oversized.data.evidence[0].text='x'.repeat(550000);createPublicSnapshot(store.api,config,{now:()=>baseTime,view:'calendar'}).save({...oversized,receivedAt:baseTime});await flush();
 assert.equal(store.values.get('radar:public-calendar:v1').version,'calendar','过大响应不覆盖既有有效缓存');
});
test('冷进动态、记录及站内信先显示自己的磁盘缓存，同时只发一个实时核对请求',async()=>{
 for(const view of ['news','calendar','notices']){
  const store=multiStorage(),old=response('saved');old.data.site.name='saved-'+view;(old.data as any).wechat={remainingCount:99,sessionToken:'PRIVATE_TEST'};
  createPublicSnapshot(store.api,config,{now:()=>baseTime,view}).save({...old,page:view==='news'?{ids:['p1'],total:21,nextCursor:'next-20'}:null,receivedAt:baseTime});await flush();
  assert.doesNotMatch(JSON.stringify([...store.values]),/PRIVATE_TEST|remainingCount/);
  const calls:any[]=[],client=createClient({wxApi:{...store.api,request(o:any){calls.push(o);return{abort(){}};}},config,now:()=>baseTime});
  try{
   const work=client.setView(view==='news'?{view,filter:'all'}:{view});await flush();
   assert.equal(client.getState().data.site.name,'saved-'+view);assert.equal(client.getState().snapshotPending,true);assert.equal(calls.length,1);assert.match(calls[0].url,/bootstrap/);
   if(view==='news'){assert.equal(client.getState().page.total,21);void client.more();assert.equal(calls.length,1,'待核对游标不另发翻页');}
   const fresh=response('fresh');fresh.data.site.name='fresh-'+view;calls[0].success({statusCode:200,data:fresh});await work;
   assert.equal(client.getState().snapshotPending,false);assert.equal(client.getState().data.site.name,'fresh-'+view);
  }finally{client.stop();}
 }
});
test('动态默认缓存不能进入其他筛选，晚到磁盘及失败恢复不覆盖新分类',async()=>{
 const store=multiStorage();createPublicSnapshot(store.api,config,{now:()=>baseTime,view:'news'}).save({...response('saved-all'),receivedAt:baseTime});await flush();
 const calls:any[]=[],client=createClient({wxApi:{...store.api,request(o:any){calls.push(o);return{abort(){}};}},config,now:()=>baseTime});
 try{
  const work=client.setView({view:'news',filter:'product'});await flush();assert.equal(client.getState().data,null);
  calls[0].success({statusCode:200,data:response('product')});await work;
  const all=client.setView({view:'news',filter:'all'});await flush();assert.equal(client.getState().version,'saved-all');calls[1].fail();await all;assert.equal(client.getState().snapshotPending,true);
  const retry=client.refresh();calls[2].success({statusCode:200,data:response('recovered')});await retry;assert.equal(client.getState().version,'recovered');assert.equal(client.getState().snapshotPending,false);
 }finally{client.stop();}
});
test('常用页逐个预取，重复调度不增请求；点击正在预取的页面复用请求，返回无骨架数据空窗',async()=>{
 const n=network(),client=n.client();
 try{
  const first=client.start();n.reply(0);await first;client.prefetchPrimaryViews();client.prefetchPrimaryViews();assert.equal(n.calls.length,2);assert.match(n.calls[1].url,/view=calendar/);
  const record=client.setView({view:'calendar'});assert.equal(n.calls.length,2,'点击记录不重发同一个请求');n.reply(1);await record;await flush();assert.equal(client.getState().data.site.name,'测试雷达');assert.equal(n.calls.length,3);assert.match(n.calls[2].url,/filter=all&view=news/);
  n.reply(2);await flush();assert.equal(n.calls.length,4);assert.match(n.calls[3].url,/view=notices/);n.reply(3);await flush();
  for(const view of [{view:'news',filter:'all'},{view:'notices'},{view:'home'},{view:'calendar'}]){const work=client.setView(view);assert(client.getState().data);await work;}
  assert.equal(n.calls.length,4);client.prefetchPrimaryViews();await flush();assert.equal(n.calls.length,4);
 }finally{client.stop();}
});
test('预取被其他前台页面抢占后安全恢复；进入后台不再预取，旧结果不能覆盖当前页面',async()=>{
 const n=network(),client=n.client();
 try{
  const first=client.start();n.reply(0);await first;client.prefetchPrimaryViews();const foreground=client.setView({view:'news',filter:'product'});assert.equal(n.calls.length,3);assert.match(n.calls[2].url,/filter=product/);
  n.reply(1,response('late-old'));n.reply(2,response('product'));await foreground;await flush();assert.equal(client.getState().version,'product');assert.equal(n.calls.length,4);
  client.stop();n.reply(3,response('late-warm'));await flush();assert.equal(client.getState().version,'product');assert.equal(n.calls.length,4);
 }finally{client.stop();}
});
test('复用的预取请求失败只显示一次错误，不自动串联第二次等待，仍能切回已有页面',async()=>{
 const n=network(),client=n.client();
 try{
  const first=client.start();n.reply(0);await first;const warm=client.prefetchCalendar(),record=client.setView({view:'calendar'});n.calls[1].fail();await Promise.all([warm,record]);
  assert.equal(n.calls.length,2);assert(client.getState().error);assert.equal(client.getState().loading,false);
  await client.setView({view:'home'});assert(client.getState().data);assert.equal(n.calls.length,2);
 }finally{client.stop();}
});
test('连续点击同一预取页面复用同一个前台等待，预取中的新版本可直接接替而不自等待',async()=>{
 const n=network(),client=n.client();
 try{
  const first=client.start();n.reply(0);await first;client.prefetchCalendar();
  const a=client.setView({view:'calendar'}),b=client.setView({view:'calendar'});assert.equal(a,b);assert.equal(n.calls.length,2);
  n.reply(1,response('v2'));await Promise.all([a,b]);assert.equal(client.getState().version,'v2');assert.equal(client.getState().loading,false);assert.equal(n.calls.length,2);
 }finally{client.stop();}
});
