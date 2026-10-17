import test from 'node:test';
import assert from 'node:assert/strict';
import type {Article,Candidate,Evidence,Job,Notice,Publication,RadarEvent,Source} from '../src/lib/types';
import {gatherEvidenceContext,evidenceBenefitClaims} from '../src/server/source-context';
import {buildAutomaticTemplate,evidenceFingerprint} from '../src/server/automatic-content';
import {contextFor,isResolvedNewsContextConflict,resolveLinkedEvents,runOne,scheduleDue} from '../src/server/worker';
const known='2026-10-18T02:00:00.000Z';
const timeline:Source={id:'tibo-public',name:'Saved public originals',kind:'timeline',url:'https://api.fxtwitter.com/2/profile/thsottiaux/statuses',enabled:true,validated:true,status:'healthy',intervalMinutes:10,version:1};
const calendar:Source={...timeline,id:'activity-archive',kind:'activity',url:'https://codex-resets.com/tibo-28'};
function fixture():Evidence[]{
 const original=(id:string,messageId:string,text:string,publishedAt:string,parentId?:string):Evidence=>({id,sourceId:timeline.id,messageId,url:`https://x.com/thsottiaux/status/${messageId}`,text,publishedAt,collectedAt:known,hash:id,historical:true,contextComplete:false,provenance:'archive',textOrigin:'original',metadata:{sourceGroup:'fxembed:thsottiaux'},...(parentId?{parentId}:{})});
 return [
  original('done','2110618732666257557','Done and dusted','2026-10-15T06:28:13.000Z','2110595554036400151'),
  original('landing','2110595554036400151','Landing within the next 2 hours','2026-10-15T04:56:07.000Z','2110595484180214059'),
  original('day10','2110595484180214059','The reports of my reset button being lost are greatly exaggerated\n\nDay 10/ Reset','2026-10-15T04:55:51.000Z'),
  original('product-root','2106610099720720811','All right, we’re locking in. Only things being worked on are simplifications, more efficiency for more usage, groundbreaking features or new models.\n\nSometimes you have to invest ahead of the curve, but feedback is clear that you all want things to get simpler. On it.','2026-10-04T04:59:21.000Z'),
  original('rule','2106845241357824205','Over the next 28 days, each day we’ll either ship one thing that is a clear improvement and relevant for most codex/work users or ship a full reset. Let the improvements begin.','2026-10-04T20:33:43.000Z','2106610099720720811'),
  {...original('day1','2107158998495748264','Day 1/\n\nWe have optimized the default speed to be ~50% faster across GPT-6 Astra and GPT-6.1 Sol through the subscription across all our products and partners using Sign in With ChatGPT (including OpenCode, Pi, Amp, Devin, ...).\n\nNo changes needed on your end and this should be felt within the next two hours.','2026-10-05T17:20:29.000Z','2106845241357824205'),contextComplete:true},
  {...original('calendar','2107548725359104441','OpenAI API 的付费使用层级从五档减为三档：Build、Launch 和 Grow。新的最高档 Grow 现在累计 API 付费满 $500 即可达到，此前最高档需要 $1,000。','2026-10-06T19:09:07.144Z'),sourceId:calendar.id,textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'product',activityDay:2,activity:{id:'challenge-28',title:'Tibo 的 28 天挑战',startsOn:'2026-10-05',days:28,timezone:'America/Los_Angeles',rules:'每天改进或完整重置'}}},
 ];
}
function announcement(){
 const rows=fixture().filter(e=>!['done','landing','day10'].includes(e.id));
 const day:Evidence={...rows[0],id:'day13',messageId:'2111492673890824348',url:'https://x.com/thsottiaux/status/2111492673890824348',text:'Day 13/ Le limit reset https://t.co/zXd2DIH5xf',parentId:undefined,publishedAt:'2026-10-17T16:20:57.000Z',historical:false,contextComplete:false};
 const reply:Evidence={...day,id:'landing13',messageId:'2111492738025959922',url:'https://x.com/thsottiaux/status/2111492738025959922',text:'Landing sometime today by EOD PST',parentId:day.messageId,publishedAt:'2026-10-17T16:21:13.000Z'};
 return {rows:[reply,day,...rows],reply,day};
}
test('已验证活动的 Le limit reset 父帖与明确时间回复进入正常预告发布通道',()=>{
 const {rows,reply,day}=announcement(),before=structuredClone(rows);
 const context=gatherEvidenceContext(reply,rows),draft=buildAutomaticTemplate(context)!;
 assert.equal(draft.publicationMode,'state_change');assert.equal(draft.actions.length,1);
 assert.equal(draft.actions[0].stage,'promised');assert.equal(draft.actions[0].kind,'automatic_reset');
 assert.equal(draft.actions[0].expectedAt,'2026-10-18T08:00:00.000Z'); // PST is UTC-8, not PDT.
 assert.match(draft.actions[0].timeNote!,/PST/);assert.match(draft.actions[0].eligibility,/原帖未列明/);
 assert.equal(buildAutomaticTemplate(gatherEvidenceContext(day,rows))?.publicationMode,'news_only','活动简写本身不作为完成或推送承诺');
 assert.deepEqual(rows,before);
});
test('缺父帖、活动证据不足、日期不匹配或消息被否定时不会制造预告',()=>{
 const {rows,reply,day}=announcement();
 for(const input of [rows.filter(e=>e.id!==day.id),rows.filter(e=>e.id!=='rule'),rows.filter(e=>e.id!=='calendar'),rows.map(e=>e.id===day.id?{...e,text:'Day 13/ Maybe Le limit reset'}:e),rows.map(e=>e.id===day.id?{...e,publishedAt:'2026-10-16T16:20:57Z'}:e)]){
  assert.equal(evidenceBenefitClaims(reply,gatherEvidenceContext(reply,input)).length,0);
 }
});

function newsShells(){
 const {rows,reply,day}=announcement();
 const excerpt:Evidence={...reply,id:'archive-reply',sourceId:'reset-archive',parentId:undefined,textOrigin:'archive_excerpt',text:'公开归档已安排用量重置，原帖内容待核对。'};
 const all=[...rows,excerpt],context=gatherEvidenceContext(reply,all);
 const pending=buildAutomaticTemplate(gatherEvidenceContext(day,all))!,oldReply=buildAutomaticTemplate([excerpt,reply])!;
 const event=(id:string,content:typeof pending):RadarEvent=>({id,title:content.title,status:'published',version:1,actions:[],evidenceIds:content.evidenceIds,publicationId:`pub-${id}`,updatedAt:known});
 const article=(id:string,content:typeof pending):Article=>({...content,id:`article-${id}`,eventId:id,status:'published',version:1,publicationId:`pub-${id}`,publishedAt:known,updatedAt:known});
 const events=[event('parent-news',pending),event('reply-news',oldReply)],articles=[article('parent-news',pending),article('reply-news',oldReply)];
 const content=buildAutomaticTemplate(context)!;
 const candidate:Candidate={id:'reply-candidate',evidenceId:reply.id,status:'pending',humanEdited:false,version:2,createdAt:known,updatedAt:known,content,reasons:['事件关联不明'],automation:{state:'conflict',reasonCodes:['fact_conflict'],dependencyIds:[]}};
 return {all,reply,day,context,events,articles,candidate};
}
test('父帖与时间回复先各自发布待确认动态后，只升级回复自身记录，保留父帖历史',()=>{
 const f=newsShells(),before=structuredClone(f);
 assert.equal(resolveLinkedEvents(f.reply,f.context,f.events,f.all).length,2,'重现旧关联冲突');
 assert.deepEqual(resolveLinkedEvents(f.reply,f.context,f.events,f.all,f.articles).map(e=>e.id),['reply-news']);
 assert.deepEqual(resolveLinkedEvents(f.reply,f.context,[f.events[0]],f.all,[f.articles[0]]),[],'没有自己的记录时新建预告，不改变父帖新闻');
 assert.equal(isResolvedNewsContextConflict(f.candidate,f.reply,f.context,f.events,f.all,f.articles),true);
 assert.deepEqual(f,before,'关联筛选不合并、删除或改写历史记录');
});
test('真实福利事件、人工内容、撤回记录和不明确父链仍保留冲突保护',()=>{
 const f=newsShells();
 for(const altered of [
  {...f,events:f.events.map((e,i)=>i===0?{...e,actions:f.candidate.content.actions}:e)},
  {...f,events:f.events.map((e,i)=>i===0?{...e,manualFields:['title']}:e)},
  {...f,events:f.events.map((e,i)=>i===0?{...e,status:'withdrawn' as const}:e)},
  {...f,articles:f.articles.map((a,i)=>i===0?{...a,manualFields:['summary' as const]}:a)},
  {...f,articles:f.articles.map((a,i)=>i===0?{...a,contentOrigin:'generated' as const}:a)},
  {...f,articles:f.articles.map((a,i)=>i===0?{...a,reviewStatus:undefined}:a)},
  {...f,articles:[...f.articles,{...f.articles[0],id:'other-parent-article'}]},
  {...f,context:f.context.filter(e=>e.id!=='rule')},
 ]){
  assert.equal(resolveLinkedEvents(altered.reply,altered.context,altered.events,altered.all,altered.articles).length,2);
  assert.equal(isResolvedNewsContextConflict(altered.candidate,altered.reply,altered.context,altered.events,altered.all,altered.articles),false);
 }
 for(const candidate of [{...f.candidate,humanEdited:true},{...f.candidate,reasons:['事件关联不明','来源已暂停']},{...f.candidate,reasons:['原帖已有事件，关联冲突']},{...f.candidate,reasons:[]}])
  assert.equal(isResolvedNewsContextConflict(candidate,f.reply,f.context,f.events,f.all,f.articles),false);
});

test('隔离库：旧关联冲突经规则更新恢复，产生一次预告且保留父帖及旧快照',{skip:process.env.RADAR_INTEGRATION!=='1'},async()=>{
 assert.match(new URL(process.env.DATABASE_URL!).pathname,/^\/radar_qa_/);
 const {insert,list,one,pool,put}=await import('../src/db');
 const f=newsShells();
 try{
  for(const e of f.all)await insert('evidence',e);
  const activity=f.all.find(e=>e.metadata?.activity)!.metadata!.activity!;
  await put('activities',{...activity,version:1,items:[]});
  for(const id of new Set(f.all.map(e=>e.sourceId)))await put('sources',{...timeline,id,nextRunAt:'2100-01-01T00:00:00Z'});
  await put('settings',{id:'site',name:'隔离提醒回归',description:'测试',autoPublish:true,version:1});
  for(const e of f.events)await put('events',e);
  for(const a of f.articles){
   await put('articles',a);
   await insert('publications',{id:a.publicationId,eventId:a.eventId,articleId:a.id,article:a,event:f.events.find(e=>e.id===a.eventId)!,cutoffAt:known,publishedAt:known,reason:'隔离测试旧动态',mode:'news_only'} satisfies Publication);
  }
  const storedEvidence=await list<Evidence>('evidence');
  const oldFingerprint=evidenceFingerprint(contextFor(f.candidate,storedEvidence.find(e=>e.id===f.reply.id)!,storedEvidence)).replace(/^[^:]+:/,'benefit-rules-20261018-1:');
  await put('candidates',{...f.candidate,automation:{...f.candidate.automation!,inputFingerprint:oldFingerprint}});
  const oldParent=await one<Article>('articles','article-parent-news'),oldSnapshot=await one<Publication>('publications','pub-reply-news');
  await scheduleDue({skipSources:true,allowEnrichment:false});
  const job=(await list<Job>('jobs')).find(j=>j.candidateId===f.candidate.id);
  assert.ok(job,'规则更新应恢复这个可证明的关联冲突');
  for(let attempt=0;attempt<20;attempt++){
   await runOne({schedule:false,enrich:async()=>undefined,enrichQuoted:async()=>[]});
   if((await one<Job>('jobs',job.id))?.status==='succeeded')break;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  const updated=await one<Article>('articles','article-reply-news');
  assert.equal(updated?.publicationMode,'state_change',JSON.stringify({candidate:await one<Candidate>('candidates',f.candidate.id),job:await one<Job>('jobs',job.id)}));
  assert.equal((await one<Candidate>('candidates',f.candidate.id))?.status,'published');
  const notices=(await list<Notice>('notices')).filter(n=>n.eventId==='reply-news');
  assert.equal(notices.length,1);assert.deepEqual(notices[0].categories,['announcement','activity']);
  assert.deepEqual(await one<Article>('articles','article-parent-news'),oldParent);
  assert.deepEqual(await one<Publication>('publications','pub-reply-news'),oldSnapshot);
  const event=await one<RadarEvent>('events','reply-news');
  assert.equal(event?.actions.length,1);assert.equal(event?.actions[0].expectedAt,'2026-10-18T08:00:00.000Z');
  await scheduleDue({skipSources:true,allowEnrichment:false});
  assert.equal((await list<Job>('jobs')).filter(j=>j.candidateId===f.candidate.id).length,1,'重复调度不再生成同一预告');
  assert.equal((await list<Notice>('notices')).filter(n=>n.eventId==='reply-news').length,1);
 }finally{await pool.end();}
});
