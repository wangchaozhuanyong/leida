import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticNewsContextUpgrade} from '../src/server/service';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import {gatherEvidenceContext} from '../src/server/source-context';
import type {Evidence,RadarEvent,Article} from '../src/lib/types';
const at='2026-10-02T00:00:00Z';
const post=(id:string,text:string,patch:Partial<Evidence>={}):Evidence=>({id,sourceId:'tibo-public',messageId:id,url:'https://x.com/thsottiaux/status/'+id,text,hash:id,publishedAt:at,collectedAt:at,contextComplete:true,textOrigin:'original',provenance:'archive',historical:false,...patch});
function fixture(qualified=false){
 const product=post('200000000000000001','We shipped a new Codex feature.');
 const parent=post('200000000000000002','We will reset usage limits for all paid Codex users in 2 hours.',{parentId:product.messageId,publishedAt:'2026-10-02T01:00:00Z'});
 const child=post('200000000000000003','Done and dusted',{parentId:parent.messageId,publishedAt:'2026-10-02T02:00:00Z'});
 const copy={...child,id:'copy',sourceId:'aiplanwatch-history',parentId:undefined};const all=[product,parent,child,copy];
 const draft=buildAutomaticTemplate(gatherEvidenceContext(child,all))!,p=buildAutomaticTemplate(gatherEvidenceContext(parent,all))!;
 assert.equal(draft.actions[0].stage,'claimed_complete');
 const target:RadarEvent={id:'target',title:p.title,status:'published',version:1,publicationId:'parent-pub',actions:p.actions,evidenceIds:[parent.id],updatedAt:at};
 const duplicate:RadarEvent={...target,id:'duplicate',actions:qualified?[{...draft.actions[0],evidenceIds:[copy.id]}]:[],evidenceIds:[copy.id]};
 const article:Article={id:'child-article',eventId:duplicate.id,title:'Child',summary:'Child',translation:'',category:'reset',version:1,status:'published',publicationId:'child-pub',evidenceIds:[copy.id],publishedAt:at,updatedAt:at,publicationMode:qualified?'state_change':'news_only',contentOrigin:'template'};
 const parentArticle:Article={...article,id:'parent-article',eventId:target.id,evidenceIds:[parent.id],publicationMode:'state_change'};
 return {product,parent,child,copy,all,draft,target,duplicate,article,parentArticle};
}
test('equivalent versions do not become the last ancestor and block a typed completion upgrade',()=>{
 const f=fixture();assert.equal(automaticNewsContextUpgrade(f.child,f.draft,f.duplicate,f.target,f.all,[f.article,f.parentArticle])?.id,f.article.id);
 assert.deepEqual(f.duplicate.actions,[],'read-only preflight');
});
test('same source identity and exact qualified copy can attach to its explicit promise without losing snapshots',()=>{
 const f=fixture(true);assert.equal(automaticNewsContextUpgrade(f.child,f.draft,f.duplicate,f.target,f.all,[f.article,f.parentArticle])?.id,f.article.id);
 for(const patch of [{stage:'promised' as const},{eligibility:'不同资格'},{statementAt:'2026-10-03T00:00:00Z'}])assert.equal(automaticNewsContextUpgrade(f.child,f.draft,{...f.duplicate,actions:[{...f.duplicate.actions[0],...patch}]},f.target,f.all,[f.article,f.parentArticle]),undefined);
});
test('manual, withdrawn, different-identity and untyped parent records stay protected',()=>{
 const f=fixture();
 assert.equal(automaticNewsContextUpgrade(f.child,f.draft,f.duplicate,f.target,f.all,[f.article]),undefined,'a target needs its actual published state article');
 for(const patch of [{manualFields:['title']},{status:'withdrawn' as const}])assert.equal(automaticNewsContextUpgrade(f.child,f.draft,{...f.duplicate,...patch},f.target,f.all,[f.article,f.parentArticle]),undefined);
 assert.equal(automaticNewsContextUpgrade({...f.child,parentId:'another'},f.draft,f.duplicate,f.target,f.all,[f.article,f.parentArticle]),undefined);
 const foreign={...f.copy,url:f.copy.url.replace('thsottiaux','another')};assert.equal(automaticNewsContextUpgrade(f.child,f.draft,f.duplicate,f.target,[f.product,f.parent,f.child,foreign],[f.article,f.parentArticle]),undefined);
});

test('isolated worker: a completed first reset plus another promise keep separate identities through repeat and later completion',{skip:process.env.RADAR_INTEGRATION!=='1'},async()=>{
 const {pool,list,one,put,insert,transaction,lockTransaction}=await import('../src/db');
 const {createEvidence,publishHistoricalDraft,samePublishedContent}=await import('../src/server/service');
 const {runOne,scheduleDue}=await import('../src/server/worker');
 const url=new URL(process.env.DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55489');assert.match(url.pathname,/^\/radar_qa_/);
 const sourceId='half-year-wording-qa',start=new Date(Date.now()-2*3600_000).toISOString();
 await put('sources',{id:sourceId,name:'隔离回放回归',kind:'archive',url:'https://example.invalid',enabled:true,validated:true,intervalMinutes:60,version:1,status:'healthy',nextRunAt:'2100-01-01T00:00:00Z'});
 await put('settings',{id:'site',name:'本地测试',description:'本地',autoPublish:true,version:1});await put('settings',{id:'ai',enabled:false,version:1});
 const add=(id:string,text:string,time=start,parentId?:string)=>createEvidence({sourceId,messageId:id,url:'https://x.com/thsottiaux/status/'+id,text,publishedAt:time,collectedAt:time,contextComplete:true,textOrigin:'original',provenance:'archive',historical:false,parentId});
 const drain=async()=>{for(let i=0;i<30;i++){await scheduleDue({skipSources:true,allowTemplates:true,allowEnrichment:false});if(!await runOne({schedule:false,allowTemplates:true,generate:async()=>{throw Error('no AI')},enrich:async()=>undefined,enrichQuoted:async()=>[],wechat:async()=>{throw Error('no WeChat sends')}})){const due=(await list<any>('jobs')).some(j=>j.status==='queued'&&Date.parse(j.availableAt)<=Date.now()+100);if(!due)return;await new Promise(resolve=>setTimeout(resolve,25));}}throw Error('queue did not converge');};
 try{
  const text='We have reset usage limits across Codex and ChatGPT Work. And another one will come later in the day.';
  await add('200000000000000101',text);await drain();
  const event=(await list<RadarEvent>('events')).find(e=>e.actions.length===2)!;assert.ok(event);assert.equal(new Set(event.actions.map(a=>a.id)).size,2);assert.deepEqual(new Set(event.actions.map(a=>a.stage)),new Set(['claimed_complete','promised']));
  const frozen=JSON.stringify(await list('publications'));
  await add('200000000000000101',text);await drain();assert.equal(JSON.stringify(await list('publications')),frozen);
  const rollout='Introducing... another usage limit reset for all our ChatGPT Work and Codex users. Should land over next 30 minutes.',rolloutAt=new Date(Date.parse(start)+30*60_000).toISOString();
  await add('200000000000000103',rollout,rolloutAt);await drain();
  await add('200000000000000103',rollout,rolloutAt,'200000000000000101');await drain();
  const rolling=await one<RadarEvent>('events',event.id);assert.equal(rolling?.actions.length,2);assert.equal(rolling?.actions[0].stage,'claimed_complete');assert.equal(rolling?.actions[1].stage,'in_progress');
  assert.equal(rolling?.actions[1].expectedAt,new Date(Date.parse(start)+3600_000).toISOString());
  assert.equal((await list<RadarEvent>('events')).filter(e=>e.status==='published'&&e.actions.length).length,1,'a copy arriving before its explicit parent does not create a duplicate round');
  // Unambiguous same-kind second occurrence, with the explicit earlier original.
  await add('200000000000000102','Another usage reset has landed across Codex and ChatGPT Work.',new Date(Date.parse(start)+3600_000).toISOString(),'200000000000000101');await drain();
  const final=await one<RadarEvent>('events',event.id);assert.equal(final?.actions.length,2);assert.ok(final?.actions.every(a=>a.stage==='claimed_complete'));
  const {getPublicRead}=await import('../src/server/public-read');
  const {publicActions}=await import('../src/lib/public-facts');
  for(const view of ['calendar','history'] as const){
   const envelope=await getPublicRead({view});
   const facts=publicActions(envelope.data).filter(item=>item.event.id===event.id);
   assert.equal(facts.length,2,view+' retains both rounds');
   assert.deepEqual(facts.map(item=>item.publication.article.sourcePublishedAt).sort(),[start,new Date(Date.parse(start)+3600_000).toISOString()].sort(),view+' retains each source article');
  }
  const completion='We have reset usage limits for all paid Codex users.';
  const first=await add('200000000000000201',completion+' See you see.',start,'200000000000000190');await drain();
  const firstEvent=(await list<RadarEvent>('events')).find(e=>e.actions.some(a=>a.evidenceIds.includes(first.evidence.id)))!;assert.ok(firstEvent);
  const notices=(await list('notices')).length;
  await add('200000000000000202',completion+' See you soon.',new Date(Date.parse(start)+5*60_000).toISOString(),'200000000000000190');await drain();
  const repostEvent=await one<RadarEvent>('events',firstEvent.id);assert.equal(repostEvent?.actions.length,1);assert.equal(repostEvent?.actions[0].statementAt,start);assert.equal((await list('notices')).length,notices,'wording-only repost does not create another reminder');
  assert.equal((await list('wechat_deliveries')).length,0);
  assert.equal((await list<any>('jobs')).filter(j=>j.status==='failed').length,0);
  // A real old state article may already contain the first completion only.
  // Recover the omitted explicit promise through the controlled history path,
  // rather than disguising the article as news or changing its old snapshot.
  const legacy=await add('200000000000000301',text);
  const recovery=buildAutomaticTemplate([legacy.evidence])!;
  recovery.eventId='legacy-first-only';recovery.actions[0].id='legacy-first';recovery.actions[1].id='legacy-second';
  const legacyEvent:RadarEvent={id:recovery.eventId,title:'Legacy first completion',status:'published',version:1,publicationId:'legacy-pub',actions:[recovery.actions[0]],evidenceIds:[legacy.evidence.id],updatedAt:start};
  const legacyArticle:Article={id:'legacy-article',eventId:legacyEvent.id,title:legacyEvent.title,summary:'Legacy first completion',translation:'',category:'reset',status:'published',version:1,publicationId:'legacy-pub',evidenceIds:[legacy.evidence.id],publishedAt:start,updatedAt:start,sourcePublishedAt:start,publicationMode:'state_change',contentOrigin:'template'};
  const legacyPub={id:'legacy-pub',eventId:legacyEvent.id,articleId:legacyArticle.id,event:legacyEvent,article:legacyArticle,publishedAt:start,cutoffAt:start,mode:'state_change',reason:'synthetic old first-only state'};
  await put('events',legacyEvent);await put('articles',legacyArticle);await insert('publications',legacyPub);const legacyFrozen=await one('publications',legacyPub.id);
  const capture={evidenceId:legacy.evidence.id,evidenceHash:legacy.evidence.hash,capturedBefore:new Date().toISOString()};
  const recover=(article=legacyArticle,draft=recovery,proof=capture)=>transaction(async c=>{await lockTransaction(c,'radar_publication');return publishHistoricalDraft(draft,c,'QA omitted second promise',article,proof);});
  await assert.rejects(recover({...legacyArticle,manualFields:['title']}),/历史文章/);
  const foreign=await add('200000000000000302',text);
  await assert.rejects(recover(legacyArticle,{...recovery,evidenceIds:[foreign.evidence.id],actions:recovery.actions.map(a=>({...a,evidenceIds:[foreign.evidence.id]}))},{evidenceId:foreign.evidence.id,evidenceHash:foreign.evidence.hash,capturedBefore:new Date().toISOString()}),/历史文章/);
  const notificationCount=(await list('notices')).length;
  const restored=await recover();assert.equal(restored.event.actions.length,2);assert.equal(restored.event.actions[0].id,'legacy-first');assert.equal(restored.event.actions[1].id,'legacy-second');assert.equal(restored.event.actions[1].stage,'promised');
  assert.deepEqual(await one('publications',legacyPub.id),legacyFrozen,'the old state snapshot stays immutable');
  assert.equal((await list('notices')).length,notificationCount,'controlled recovery is silent');
  assert.equal((await list('wechat_deliveries')).length,0);
  assert.equal(samePublishedContent(recovery,restored.article,restored.event),true,'a repeated maintenance scan reuses the restored state');
 }finally{await pool.end();}
});
