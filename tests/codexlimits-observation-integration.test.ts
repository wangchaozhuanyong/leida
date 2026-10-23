import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {load} from 'cheerio';
import {pool,one,put,list} from '../src/db';
import type {Evidence,Source,Publication,Job,Notice} from '../src/lib/types';
import {CODEX_LIMITS_OBSERVATION_SOURCE as source} from '../src/server/codexlimits-observation-source';
import {REFERENCE_SOURCES} from '../src/server/reference-reset-source';
import {TIBO_PUBLIC_SOURCE} from '../src/server/tibo-public';
import {collectSource} from '../src/server/ingestion';
import {runOne,scheduleDue,sourceCollectionDue} from '../src/server/worker';
import {defaultSite,getPublicData} from '../src/server/service';
import {publicResetOutlook} from '../src/lib/reset-outlook';
import {publicActions} from '../src/lib/public-facts';
import {extractCadenceObservations} from '../src/server/reset-cadence-evidence';
const captured=readFileSync(new URL('./fixtures/codexlimits-reset-observations.html',import.meta.url),'utf8');
function page(times:number[]){
 const $=load(captured),template=$('article').first();
 const rows=times.map(time=>{const date=new Date(time),row=template.clone(),month=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getUTCMonth()],day=date.getUTCDate();
  row.find('.archive-date > span').eq(0).text(`${month} ${day}`);row.find('.archive-date > span').eq(1).text(String(date.getUTCFullYear()));
  row.find('.archive-event-body > p').text(`Third-party observation on ${month} ${day}, ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')} UTC.`);return $.html(row);
 });
 return '<!doctype html><html><body>'+rows.join('\n')+'</body></html>';
}

test('隔离库：受控来源注册、首次静默、重复去重、后续新观测自动news-only发布且不污染完成训练',{skip:process.env.RADAR_OBSERVATION_INTEGRATION!=='1'},async()=>{
 assert.match(new URL(process.env.DATABASE_URL!).pathname,/^\/radar_qa_limits_[a-z0-9_]+$/,'只允许本次唯一QA库');
 const originalFetch=globalThis.fetch,minute=Math.floor(Date.now()/60000)*60000,first=minute-10*60000,older=minute-60*60000,newer=minute-2*60000;
 let body=page([first,older]);const requests:string[]=[];
 globalThis.fetch=async input=>{requests.push(String(input));assert.equal(String(input),source.url,'只模拟固定观测HTML，禁止任何真实网络');return new Response(body);};
 const worker={schedule:false,enrich:async()=>{throw new Error('不应请求原帖');},enrichQuoted:async()=>[],wechat:async()=>{throw new Error('禁止真实微信提醒');}};
 const publishQueued=async(expected:number)=>{
  // The local PostgreSQL container's clock can trail Node by a few milliseconds.
  // Honor availableAt rather than rewriting the persisted scheduling contract.
  for(let attempt=0;attempt<40;attempt++){
   await runOne(worker);
   if((await list<Publication>('publications')).length===expected)return;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal((await list<Publication>('publications')).length,expected,'已排队的观测必须完成发布');
 };
 try{
  await put('settings',{id:'site',...defaultSite,autoPublish:true});await put('settings',{id:'ai',enabled:false,version:1});
  await put('sources',{...TIBO_PUBLIC_SOURCE,enabled:true,validated:true,nextRunAt:new Date(Date.now()+86400000).toISOString()});
  for(const other of REFERENCE_SOURCES.filter(item=>item.id!==source.id))await put('sources',other);
  await scheduleDue({skipGeneration:true});
  let saved=(await one<Source>('sources',source.id))!;
  assert.equal(saved.enabled,true);assert.equal(saved.validated,false);assert.equal(saved.publicationPaused,true);assert.equal(saved.pauseReason,'structure');
  assert.equal((await list<Job>('jobs')).filter(job=>job.kind==='collect'&&job.sourceId===source.id).length,1);
  assert.ok((await list<Source>('sources')).filter(item=>REFERENCE_SOURCES.some(ref=>ref.id===item.id)&&item.id!==source.id).every(item=>!item.enabled),'不重开已有人工暂停来源');
  await runOne(worker);
  saved=(await one<Source>('sources',source.id))!;
  assert.equal(saved.status,'healthy');assert.equal(saved.validated,true);assert.equal(saved.publicationPaused,false);assert.equal(saved.effectiveIntervalMinutes,5);
  const firstEvidence=(await list<Evidence>('evidence')).filter(e=>e.sourceId===source.id);assert.equal(firstEvidence.length,2);assert.ok(firstEvidence.every(e=>e.historical),'不足24小时的新来源首批也静默');
  await scheduleDue({skipSources:true});
  await publishQueued(2);
  let published=await list<Publication>('publications');assert.equal(published.length,2);assert.ok(published.every(p=>p.mode==='news_only'&&p.event.actions.length===0&&p.article.historical));
  assert.equal((await list<Notice>('notices')).length,0);assert.equal((await list('wechat_deliveries')).length,0);
  assert.equal((await collectSource(source.id)).created,0);
  body=page([newer,first,older]);
  assert.equal((await collectSource(source.id)).created,1,'页面增加一行不能把旧两行的读取快照当新证据');
  let evidence=await list<Evidence>('evidence');assert.equal(evidence.length,3);
  assert.ok(firstEvidence.every(old=>evidence.some(e=>e.id===old.id&&e.collectedAt===old.collectedAt)),'保留旧观测首个采集时间及身份');
  assert.equal(evidence.find(e=>e.publishedAt===new Date(newer).toISOString())!.historical,false,'后续新观测正常处理');
  await scheduleDue({skipSources:true});await publishQueued(3);
  published=await list<Publication>('publications');assert.equal(published.length,3);assert.ok(published.every(p=>p.mode==='news_only'&&p.event.actions.length===0));
  const data=await getPublicData();assert.equal(publicResetOutlook(data).latestObservation?.observedAt,new Date(newer).toISOString());
  assert.equal(publicResetOutlook(data).latestGlobalCompletionAt,undefined);assert.deepEqual(publicActions(data),[]);
  assert.deepEqual(extractCadenceObservations(evidence,await list<Source>('sources'),new Date().toISOString()),[],'不成为正式完成/进度预测训练样本');
  assert.equal((await list<Notice>('notices')).length,0);assert.equal((await list('wechat_deliveries')).length,0);
  saved=(await one<Source>('sources',source.id))!;await put('sources',{...saved,enabled:false,status:'paused'});await scheduleDue({skipGeneration:true});
  assert.equal((await one<Source>('sources',source.id))!.enabled,false);assert.equal(sourceCollectionDue({...saved,enabled:false}),false);
  assert.ok(requests.length>=3);assert.ok(requests.every(url=>url===source.url));
 }finally{globalThis.fetch=originalFetch;await pool.end();}
});
