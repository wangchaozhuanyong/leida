import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {PublicData} from '../src/lib/types';
const require=createRequire(import.meta.url);
const {createClient}=require('../miniprogram/utils/client.js');
const {buildFixture}=require('../scripts/qa-public-navigation-server.mjs');
const base=buildFixture().data as PublicData;delete base.forecasts;
function page(start:number,version:string,offset=0,total=75) {
  const publications=base.publications.slice(start+offset,Math.min(start+offset+20,total+offset));
  const ids=new Set(publications.map(p=>p.id)),articles=new Set(publications.map(p=>p.articleId)),events=new Set(publications.map(p=>p.eventId));
  return {data:{...base,publications,articles:base.articles.filter(a=>articles.has(a.id)),events:base.events.filter(e=>events.has(e.id)),evidence:[]},version,contentVersion:version,page:{ids:[...ids],nextCursor:start+20<total?`page-${start+20}`:null,total}};
}
function harness(responses:unknown[]) {
  const paths:string[]=[], snapshots:any[]=[];
  const client=createClient({wxApi:{request(o:any){paths.push(o.url);const response=responses.shift();queueMicrotask(()=>response?o.success({statusCode:200,data:response}):o.fail());return{abort(){}};}},config:{mode:'https',baseUrl:'https://fixture.example.org',pollMs:300000},now:()=>1000});
  client.subscribe((s:any)=>snapshots.push(s));
  return {client,paths,snapshots};
}
test('翻页遇到更正版本，重新读取完整范围而不拼回旧首屏',async()=>{
  const h=harness([page(0,'v1'),page(20,'v2',1),page(0,'v2',1),page(20,'v2',1)]);
  await h.client.setView({view:'news',filter:'all'});const withdrawn=h.client.getState().data.publications[0].id;
  await h.client.more();const s=h.client.getState();
  assert.equal(s.contentVersion,'v2');assert.equal(s.data.publications.length,40);
  assert.equal(s.data.publications.some((p:any)=>p.id===withdrawn),false);assert.equal(s.pagesLoaded,2);
  assert.equal(h.snapshots.some(s=>s.contentVersion==='v2'&&s.data.publications.some((p:any)=>p.id===withdrawn)),false);
  assert.equal(h.paths.length,4);
});
test('自动更新保留两页范围，只有状态变化不重读正文',async()=>{
  const state={...page(0,'state-v3',1),contentVersion:'v2'};
  const h=harness([page(0,'v1'),page(20,'v1'),{data:{version:'v2',contentVersion:'v2'}},page(0,'v2',1),page(20,'v2',1),{data:{version:'state-v3',contentVersion:'v2'}},state]);
  await h.client.setView({view:'news',filter:'all'});await h.client.more();await h.client.refresh(true);
  assert.equal(h.client.getState().data.publications.length,40);assert.equal(h.client.getState().pagesLoaded,2);
  await h.client.refresh(true);assert.equal(h.client.getState().data.publications.length,40);
  assert.match(h.paths.at(-1)!,/view=state/);assert.equal(h.paths.length,7);
});
test('重读再次变化只重试一次，失败后废弃旧游标，重试可恢复',async()=>{
  const h=harness([page(0,'v1'),page(20,'v2'),page(0,'v2'),page(20,'v3'),page(0,'v3'),page(20,'v4')]);
  await h.client.setView({view:'news',filter:'all'});await h.client.more();
  assert.match(h.client.getState().moreError,/内容正在更新/);assert.equal(h.client.getState().page.nextCursor,null);
  assert.equal(h.paths.length,6);assert.equal(h.client.getState().contentVersion,'v1');
  await h.client.more();assert.equal(h.paths.length,7,'失败重试从第一页开始，不能沿用旧游标');assert.doesNotMatch(h.paths.at(-1)!,/cursor=/);
});
test('刷新后实际结果不足两页，以新结果为准，不保留撤回条目',async()=>{
  const h=harness([page(0,'v1'),page(20,'v1'),page(0,'v2',1,15)]);
  await h.client.setView({view:'news',filter:'all'});await h.client.more();await h.client.refresh(false);
  assert.equal(h.client.getState().data.publications.length,15);assert.equal(h.client.getState().page.nextCursor,null);
  assert.equal(h.client.getState().pagesLoaded,1);
});


test('新增提示保持旧正文和游标同一版本，确认后应用，撤回无需等待确认',async()=>{
  const first=page(0,'v1',1,5),added=page(0,'v2',0,6),withdrawn=page(0,'v3',2,4);
  const h=harness([first,{data:{version:'v2',contentVersion:'v2'}},added,{data:{version:'v2',contentVersion:'v2'}},{data:{version:'v3',contentVersion:'v3'}},withdrawn]);
  await h.client.setView({view:'news',filter:'all'});const ids=h.client.getState().page.ids;
  await h.client.refresh(true);assert.equal(h.client.getState().updateAvailable,true);assert.deepEqual(h.client.getState().page.ids,ids);assert.equal(h.client.getState().contentVersion,'v1');
  await h.client.refresh(true);assert.equal(h.paths.length,4);
  h.client.applyUpdates();assert.equal(h.client.getState().contentVersion,'v2');assert.equal(h.client.getState().updateAvailable,false);
  await h.client.refresh(true);assert.equal(h.client.getState().contentVersion,'v3');assert.equal(h.client.getState().updateAvailable,false);
});

test('二十项缓存上限淘汰旧详情而保留首页',async()=>{
  const h=harness(Array.from({length:30},()=>page(0,'v1')));
  await h.client.setView({view:'home'});
  for(let i=0;i<25;i++)await h.client.setView({view:'detail',entity:'publications',id:`qa-publication-${i}`});
  const count=h.paths.length;await h.client.setView({view:'home'});assert.equal(h.paths.length,count);
  await h.client.setView({view:'detail',entity:'publications',id:'qa-publication-0'});assert.equal(h.paths.length,count+1);
});
