import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool,list,one,put} from '../src/db';
import {createEvidence,defaultSite,publishCandidate} from '../src/server/service';
import {runOne,scheduleDue} from '../src/server/worker';
import type {Evidence,Candidate,Source,Publication,Article,Job,Notice} from '../src/lib/types';

test('隔离库：漏报补录保留旧快照、完整闭环、幂等且不发历史通知',{skip:process.env.RADAR_OMISSION_INTEGRATION!=='1'},async()=>{
 assert.match(new URL(process.env.DATABASE_URL!).pathname,/^\/radar_qa_/);
 const sourceId='omission-fixture',calendarSource='omission-calendar';
 const source:Source={id:sourceId,name:'漏报隔离来源',kind:'archive',url:'https://example.invalid',enabled:true,validated:true,intervalMinutes:2,version:1,status:'healthy',nextRunAt:'2100-01-01T00:00:00Z'};
 const records=JSON.parse(readFileSync(new URL('./fixtures/reset-omission-month.json',import.meta.url),'utf8')) as Evidence[];
 const before=new Map((await list<Publication>('publications')).map(p=>[p.id,JSON.stringify(p)]));
 const inputs=records.filter(r=>r.sourceId==='tibo-public'||r.sourceId==='activity-archive'&&r.messageId==='2107158998495748264');
 const liveFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('隔离验收禁止网络、AI和微信调用');};
 try {
  for(const s of await list<Source>('sources'))await put('sources',{...s,enabled:false});
  await put('sources',source);await put('settings',{id:'site',...defaultSite,autoPublish:true});await put('settings',{id:'ai',enabled:false,version:1});
  const byMessage=new Map<string,string>();
  const add=async(r:Evidence)=>{
   const {id:_id,hash:_hash,...input}=r;
   const saved=await createEvidence({...input,sourceId:r.sourceId==='activity-archive'?calendarSource:sourceId,historical:true,collectedAt:new Date().toISOString()});
   if(r.sourceId==='tibo-public')byMessage.set(r.messageId,saved.candidate!.id);
  };
  const drain=async()=>{for(let i=0;i<50;i++){await scheduleDue({allowEnrichment:false});let n=0;for(;n<20;n++)if(!await runOne({schedule:false,enrich:async()=>undefined,enrichQuoted:async()=>[],wechat:async()=>{throw new Error('不得发送历史通知');}}))break;if(!n){if(!(await list<Job>('jobs')).some(j=>j.status==='queued'||j.status==='running'))return;await new Promise(resolve=>setTimeout(resolve,100));}}throw new Error('队列未收敛');};
  for(const r of inputs.filter(r=>!['2110595554036400151','2110618732666257557'].includes(r.messageId)))await add(r);
  // Two independent product articles may both cite campaign rules as background.
  const ruleCandidate=(await one<Candidate>('candidates',byMessage.get('2106845241357824205')!))!;
  for(const [i,id] of ['2107158998495748264','2107575657014468879'].entries()){
   const c=(await one<Candidate>('candidates',byMessage.get(id)!))!;
   await put('candidates',{...c,content:{title:'活动产品动态'+(i+1),summary:'依据活动背景记录独立产品改进。',translation:'',category:'product',publicationMode:'news_only',contentOrigin:'generated',actions:[],evidenceIds:[c.evidenceId,ruleCandidate.evidenceId]},reasons:[]});
   await publishCandidate(c.id,c.version,'qa','隔离产品消息，背景引用不作为同一事件');
  }
  await drain();
  assert.equal((await one<Candidate>('candidates',ruleCandidate.id))?.status,'published','活动规则不能因多条背景引用卡在事件关联不明');
  const root=(await one<Candidate>('candidates',byMessage.get('2110595484180214059')!))!;
  assert.equal(root.status,'published');assert.equal(root.content.reviewStatus,'pending');
  for(const id of ['2110618732666257557','2110595554036400151'])await add(inputs.find(r=>r.messageId===id)!);
  await drain();
  for(const id of ['2102463847714247142','2103637477760311522']){const c=(await one<Candidate>('candidates',byMessage.get(id)!))!;assert.equal(c.status,'published',JSON.stringify(c.reasons));assert.equal(c.content.actions.length,1);}
  const deadline=(await one<Candidate>('candidates',byMessage.get('2110595554036400151')!))!,done=(await one<Candidate>('candidates',byMessage.get('2110618732666257557')!))!;
  assert.equal(deadline.status,'published',JSON.stringify(deadline.reasons));assert.equal(done.status,'published',JSON.stringify(done.reasons));
  assert.equal(deadline.content.actions[0].expectedAt,'2026-10-15T06:56:07.000Z');assert.equal(done.content.actions[0].stage,'claimed_complete');
  assert.equal(deadline.content.eventId,done.content.eventId);assert.equal(deadline.content.actions[0].id,done.content.actions[0].id);
  for(const id of ['2103911959544610829','2106233145163141249','2106239435461579088']){
   const c=(await one<Candidate>('candidates',byMessage.get(id)!))!;assert.equal(c.status,'published',JSON.stringify(c.reasons));assert.equal(c.content.actions.length,0);assert.ok(c.content.reviewStatus);
  }
  const canonical=(await list<Article>('articles')).find(a=>a.id===done.automation?.articleId)!;assert.equal(canonical.publicationMode,'state_change');
  const copySource=sourceId+'-copy';await put('sources',{...source,id:copySource});
  const copied=await createEvidence({...inputs.find(r=>r.messageId==='2110618732666257557')!,sourceId:copySource,text:'用量重置均已传播。',textOrigin:'archive_excerpt',contextComplete:false,historical:true,collectedAt:new Date().toISOString()});
  await drain();assert.equal((await one<Candidate>('candidates',copied.candidate!.id))?.status,'published');
  const retained=(await one<Article>('articles',canonical.id))!;assert.equal(retained.publicationId,canonical.publicationId,'辅助摘要不能覆盖完整原文的发布版本');assert.equal(retained.publicationMode,'state_change');assert.equal(retained.reviewStatus,undefined);
  const pubs=await list<Publication>('publications'),count=pubs.length;
  for(const [id,text] of before)assert.equal(JSON.stringify(pubs.find(p=>p.id===id)),text,'旧快照被改写');
  for(const p of pubs.filter(p=>!before.has(p.id)))assert.equal(p.article.historical,true);
  const ownEventIds=new Set(pubs.filter(p=>!before.has(p.id)).map(p=>p.eventId));
  assert.equal((await list<Notice>('notices')).filter(n=>ownEventIds.has(n.eventId)).length,0);
  await drain();assert.equal((await list<Publication>('publications')).length,count,'重复执行不能创建重复快照');
  assert.ok(!(await list<Job>('jobs')).some(j=>j.status==='failed'&&[...byMessage.values()].includes(j.candidateId??'')));
  assert.ok((await list<Article>('articles')).some(a=>a.reviewStatus==='pending'));
 } finally {globalThis.fetch=liveFetch;await pool.end();}
});
