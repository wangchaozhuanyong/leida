import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool,list,one,put,insert,transaction,lockTransaction} from '../src/db';
import type {Source,Job,Candidate,Evidence,Notice,Publication,RadarEvent,Article} from '../src/lib/types';
import {createEvidence,publishHistoricalDraft,providerIdentity} from '../src/server/service';
import {scheduleDue,runOne} from '../src/server/worker';
import {buildAutomaticTemplate,evidenceFingerprint} from '../src/server/automatic-content';
import {gatherEvidenceContext} from '../src/server/source-context';
import {hash} from '../src/server/domain';
import {defaultAI} from '../src/server/ai';
import {completedPublicActions} from '../src/lib/public-facts';

test('isolated worker restores old preview, links progress, deduplicates retries and keeps historical recovery silent', {skip:process.env.RADAR_INTEGRATION!=='1'},async()=>{
 const url=new URL(process.env.DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55489');assert.match(url.pathname,/^\/radar_qa_/);
 const tag=randomUUID(),sourceId='banked-qa-'+tag,at=new Date(Date.now()-3*3600_000).toISOString();
 const source:Source={id:sourceId,name:'隔离重置卡测试',kind:'archive',url:'https://example.invalid/qa',enabled:true,validated:true,intervalMinutes:60,version:1,status:'healthy',nextRunAt:'2100-01-01T00:00:00Z'};
 await put('sources',source);await put('settings',{id:'site',name:'隔离测试',description:'本地',autoPublish:true,version:1});
 const fixture=(text:string,id:string,time=at,historical=false)=>createEvidence({sourceId,messageId:id,url:'https://x.com/thsottiaux/status/'+id,text,publishedAt:time,collectedAt:time,contextComplete:true,textOrigin:'original',provenance:'archive',historical});
 const drain=async()=>{await scheduleDue({allowTemplates:true,allowEnrichment:false,skipSources:true});for(let i=0;i<12;i++){const pending=(await list<Job>('jobs')).filter(j=>j.status==='queued'&&j.kind==='generate');if(!pending.length)break;if(!await runOne({schedule:false,allowTemplates:true,generate:async()=>{throw Error('No AI or external calls allowed in this fixture');}}))await new Promise(resolve=>setTimeout(resolve,25));}};
 try{
  const p=await fixture('Next two days will be resets… banked… do with this what you may 👀.',tag+'-preview');
  // Reproduce the already-published old machine news shell without rewriting
  // any immutable record. Only synthetic records in this test database are inserted.
  const event:RadarEvent={id:tag+'-event',title:'重置相关消息待确认',version:1,status:'published',actions:[],evidenceIds:[p.evidence.id],publicationId:tag+'-old',updatedAt:at};
  const article:Article={id:tag+'-article',eventId:event.id,title:event.title,summary:'旧规则暂未识别',translation:'',category:'reset',version:1,status:'published',publicationId:event.publicationId,evidenceIds:event.evidenceIds,publishedAt:at,updatedAt:at,publicationMode:'news_only',contentOrigin:'template',reviewStatus:'pending',reviewReasons:['旧规则待核对']};
  const old:Publication={id:event.publicationId,eventId:event.id,articleId:article.id,event,article,cutoffAt:at,publishedAt:at,reason:'synthetic old machine shell',mode:'news_only',contentOrigin:'template'};
  await insert('publications',old);await put('events',event);await put('articles',article);
  const fingerprint=evidenceFingerprint(gatherEvidenceContext(p.evidence,[p.evidence])).split(':').at(-1);
  await put('candidates',{...p.candidate!,status:'published',content:{...p.candidate!.content,eventId:event.id},automation:{state:'deferred',reasonCodes:['ambiguous_kind_or_audience'],dependencyIds:[],inputFingerprint:'benefit-rules-20261023-1:'+fingerprint,articleId:article.id,templatePublished:true}});
  await drain();
  let current=await one<RadarEvent>('events',event.id);assert.equal(current?.actions[0]?.stage,'promised');
  assert.deepEqual(await one('publications',old.id),old,'old snapshot remains unchanged');
  const first=await fixture('Banked 1/2',tag+'-first',new Date(Date.parse(at)+3600_000).toISOString());await drain();
  current=await one<RadarEvent>('events',event.id);assert.equal(current?.actions.length,1);assert.equal(current?.actions[0]?.stage,'claimed_complete');
  assert.match(current!.actions[0].timeNote!,/1\/2/);
  assert.equal((await one<Evidence>('evidence',first.evidence.id))?.parentId,undefined);
  const notices=(await list<Notice>('notices')).filter(n=>n.eventId===event.id);assert.ok(notices.some(n=>n.categories.includes('result')));
  const snapshot=JSON.stringify(await list('publications')),noticeCount=notices.length;
  await fixture('Banked 1/2',tag+'-first',first.evidence.publishedAt);await drain();
  assert.equal(JSON.stringify(await list('publications')),snapshot);assert.equal((await list<Notice>('notices')).filter(n=>n.eventId===event.id).length,noticeCount);
  const second=await fixture('Day 28/ Banked 2/2',tag+'-second',new Date(Date.parse(at)+2*3600_000).toISOString());
  // Reproduce an unchanged raw post already deferred under the 1.0.83 grammar.
  const latest=await one<Candidate>('candidates',second.candidate!.id);
  const context=gatherEvidenceContext(second.evidence,await list<Evidence>('evidence'));
  await put('candidates',{...latest!,automation:{state:'deferred',reasonCodes:['ambiguous_kind_or_audience'],dependencyIds:[],inputFingerprint:evidenceFingerprint(context).replace(/^[^:]+:/,'benefit-rules-20261101-3:')}});
  await drain();
  current=await one<RadarEvent>('events',event.id);assert.equal(current?.actions.length,2);assert.ok(current?.actions.every(a=>a.stage==='claimed_complete'));
  assert.deepEqual(current?.actions.map(a=>a.statementAt).sort(),[first.evidence.publishedAt,second.evidence.publishedAt].sort());
  assert.equal((await one<Evidence>('evidence',second.evidence.id))?.text,'Day 28/ Banked 2/2');
  const before=(await list<Notice>('notices')).length;
  await fixture('We have granted a banked reset.',tag+'-history','2026-05-01T00:00:00Z',true);await drain();assert.equal((await list<Notice>('notices')).length,before);
  // A recent captured original must remain recent: no forged historical flag
  // or shifted timestamp is needed to recover it without sending an old alert.
  const recent=await fixture('We have granted a banked reset.',tag+'-recent-recovery',at),draft=buildAutomaticTemplate([recent.evidence])!;
  const cutoff=new Date().toISOString(),proof={evidenceId:recent.evidence.id,evidenceHash:recent.evidence.hash,capturedBefore:cutoff};
  const publicationsBefore=JSON.stringify(await list('publications'));
  await assert.rejects(transaction(c=>publishHistoricalDraft(draft,c,'QA recent without capture pin')),/历史补录证据范围不符/);
  for(const invalid of [{...proof,evidenceHash:'wrong'},{...proof,capturedBefore:'bad'},{...proof,capturedBefore:new Date(Date.now()+60_000).toISOString()},{...proof,capturedBefore:new Date(Date.parse(at)-1).toISOString()}])await assert.rejects(transaction(c=>publishHistoricalDraft(draft,c,'QA rejected pin',undefined,invalid)),/静默补录范围不符/);
  assert.equal(JSON.stringify(await list('publications')),publicationsBefore);
  const recovered=await transaction(async c=>{await lockTransaction(c,'radar_publication');return publishHistoricalDraft(draft,c,'QA captured original recovery',undefined,proof);});
  assert.equal(recovered.article.historical,false);assert.equal(recovered.event.actions[0].statementAt,at);
  assert.deepEqual(await one('evidence',recent.evidence.id),recent.evidence);
  assert.equal((await list<Notice>('notices')).length,before);
  assert.equal((await list('wechat_deliveries')).length,0);
  assert.equal((await list<Job>('jobs')).filter(j=>j.status==='failed').length,0);
  // Reproduce the deployed legacy shape: both articles already exist, but their
  // snapshots used one shared action. Restore only the missing first occurrence.
  const base=Date.now()-8*86400_000;
  const lp=await fixture('Next two days will be banked resets.',tag+'-legacy-preview',new Date(base).toISOString());
  const lf=await fixture('Banked 1/2',tag+'-legacy-first',new Date(base+3600_000).toISOString());
  const ls=await fixture('Day 28/ Banked 2/2',tag+'-legacy-second',new Date(base+2*3600_000).toISOString());
  const all=[lp.evidence,lf.evidence,ls.evidence],sharedId='legacy-action-'+tag;
  const finalDraft=buildAutomaticTemplate(gatherEvidenceContext(ls.evidence,all))!;
  const finalAction={...finalDraft.actions[0],id:sharedId};
  const finalEvent:RadarEvent={id:tag+'-legacy-event',title:finalDraft.title,status:'published',version:2,publicationId:tag+'-legacy-final-pub',actions:[finalAction],evidenceIds:all.map(e=>e.id),updatedAt:ls.evidence.collectedAt};
  const firstDraft=buildAutomaticTemplate(gatherEvidenceContext(lf.evidence,all))!;
  const oldFirst:Article={...firstDraft,id:tag+'-legacy-first-article',eventId:finalEvent.id,status:'published',version:1,publicationId:tag+'-legacy-first-pub',publishedAt:lf.evidence.collectedAt,updatedAt:lf.evidence.collectedAt,sourcePublishedAt:lf.evidence.publishedAt};
  const finalArticle:Article={...finalDraft,id:tag+'-legacy-final-article',eventId:finalEvent.id,status:'published',version:1,publicationId:finalEvent.publicationId,publishedAt:ls.evidence.collectedAt,updatedAt:ls.evidence.collectedAt,sourcePublishedAt:ls.evidence.publishedAt};
  const firstEvent={...finalEvent,publicationId:oldFirst.publicationId,version:1,actions:[{...firstDraft.actions[0],id:sharedId,stage:'in_progress' as const}]};
  const oldFirstPub:Publication={id:oldFirst.publicationId,articleId:oldFirst.id,eventId:finalEvent.id,article:oldFirst,event:firstEvent,cutoffAt:lf.evidence.collectedAt,publishedAt:lf.evidence.collectedAt,reason:'synthetic deployed legacy shape',mode:'state_change'};
  const oldFinalPub:Publication={id:finalArticle.publicationId,articleId:finalArticle.id,eventId:finalEvent.id,article:finalArticle,event:finalEvent,cutoffAt:ls.evidence.collectedAt,publishedAt:ls.evidence.collectedAt,reason:'synthetic deployed legacy shape',mode:'state_change'};
  await insert('publications',oldFirstPub);await insert('publications',oldFinalPub);await put('events',finalEvent);await put('articles',oldFirst);await put('articles',finalArticle);
  const recoveredDraft={...firstDraft,eventId:finalEvent.id,actions:[{...firstDraft.actions[0],id:'action_'+hash(providerIdentity(lf.evidence)+':banked_reset:public:0')}]};
  const captured={evidenceId:lf.evidence.id,evidenceHash:lf.evidence.hash,capturedBefore:new Date().toISOString()};
  const recover=(article=oldFirst)=>transaction(async c=>{await lockTransaction(c,'radar_publication');return publishHistoricalDraft(recoveredDraft,c,'QA restore first batch',article,captured);});
  const noticesBeforeRecovery=JSON.stringify(await list('notices'));
  for(const protectedArticle of [{...oldFirst,manualFields:['title'] as Article['manualFields']},{...oldFirst,status:'withdrawn' as const}])await assert.rejects(recover(protectedArticle),/不符合/);
  const restored=await recover();
  assert.equal(restored.event.actions.length,2);assert.deepEqual(restored.event.actions.map(a=>a.statementAt).sort(),[lf.evidence.publishedAt,ls.evidence.publishedAt].sort());
  assert.equal(restored.cutoffAt,ls.evidence.collectedAt,'retained later facts cannot appear under an earlier knowledge cutoff');
  assert.equal(restored.article.sourcePublishedAt,lf.evidence.publishedAt,'source time remains the earlier original, not recovery time');
  assert.deepEqual(await one('publications',oldFirstPub.id),JSON.parse(JSON.stringify(oldFirstPub)));assert.deepEqual(await one('publications',oldFinalPub.id),JSON.parse(JSON.stringify(oldFinalPub)));
  assert.deepEqual(await one('evidence',lf.evidence.id),lf.evidence);assert.deepEqual(await one('evidence',ls.evidence.id),ls.evidence);
  const count=(await list('publications')).length;
  assert.equal((await recover(restored.article)).id,restored.id);assert.equal((await list('publications')).length,count);
  assert.equal(JSON.stringify(await list('notices')),noticesBeforeRecovery);assert.equal((await list('wechat_deliveries')).length,0);
  const facts={events:[restored.event],articles:[restored.article,finalArticle],publications:[restored,oldFirstPub,oldFinalPub],evidence:all,serverTime:new Date().toISOString()};
  assert.deepEqual(completedPublicActions(facts).map(f=>[f.action.statementAt,f.publication.id]),[[ls.evidence.publishedAt,oldFinalPub.id],[lf.evidence.publishedAt,restored.id]]);
  // New evidence can arrive in reverse order. It still creates exactly the two
  // observed occurrences, without deriving a missing time from the counter.
  const rb=Date.now()-16*86400_000;
  await fixture('Next two days will be banked resets.',tag+'-reverse-preview',new Date(rb).toISOString());await drain();
  const r2=await fixture('Banked 2/2',tag+'-reverse-second',new Date(rb+2*3600_000).toISOString());await drain();
  let re=(await list<RadarEvent>('events')).find(e=>e.actions.some(a=>a.evidenceIds.includes(r2.evidence.id)))!;
  assert.equal(re.actions.length,1,'a final counter alone never invents an unobserved first time');
  const r1=await fixture('Banked 1/2',tag+'-reverse-first',new Date(rb+3600_000).toISOString());await drain();
  re=(await one<RadarEvent>('events',re.id))!;assert.equal(re.actions.length,2);assert.deepEqual(re.actions.map(a=>a.statementAt).sort(),[r1.evidence.publishedAt,r2.evidence.publishedAt].sort());
  // A published state-changing template (not only a news shell) must recover
  // its missing deadline once the parser version changes, without a new alert.
  const timed=await fixture('We will reset usage limits for all paid users within 6 hours, and this promotion is valid for 7 days.',tag+'-mixed-time',at);
  const correct=buildAutomaticTemplate([timed.evidence])!,legacyAction={...correct.actions[0],expectedAt:undefined,timeNote:'旧规则丢失发放期限'};
  const timedEvent:RadarEvent={id:tag+'-timed-event',title:correct.title,version:1,status:'published',actions:[legacyAction],evidenceIds:[timed.evidence.id],publicationId:tag+'-timed-old',updatedAt:at};
  const timedArticle:Article={...correct,id:tag+'-timed-article',eventId:timedEvent.id,status:'published',version:1,publicationId:timedEvent.publicationId,publishedAt:at,updatedAt:at};
  const timedOld:Publication={id:timedEvent.publicationId,eventId:timedEvent.id,articleId:timedArticle.id,event:timedEvent,article:timedArticle,cutoffAt:at,publishedAt:at,reason:'synthetic missing deadline',mode:'state_change',contentOrigin:'template'};
  await insert('publications',timedOld);await put('events',timedEvent);await put('articles',timedArticle);
  const timedHash=evidenceFingerprint([timed.evidence]).split(':').at(-1);
  await put('candidates',{...timed.candidate!,status:'published',reasons:['同一动作在相同声明时间出现不同事实，存在事实冲突'],content:{...correct,actions:[legacyAction],eventId:timedEvent.id},automation:{state:'conflict',reasonCodes:['ambiguous_time'],dependencyIds:[],inputFingerprint:'benefit-rules-20261101-3:'+timedHash,articleId:timedArticle.id,templatePublished:true}});
  const noticesBeforeTimed=JSON.stringify(await list('notices'));
  await drain();
  const fixed=await one<RadarEvent>('events',timedEvent.id);
  assert.equal(fixed?.actions[0].expectedAt,new Date(Date.parse(at)+6*3600_000).toISOString(),JSON.stringify({candidate:await one<Candidate>('candidates',timed.candidate!.id),jobs:(await list<Job>('jobs')).filter(j=>j.candidateId===timed.candidate!.id)}));
  assert.deepEqual(await one('publications',timedOld.id),JSON.parse(JSON.stringify(timedOld)));
  assert.equal(JSON.stringify(await list('notices')),noticesBeforeTimed,'rule-only deadline recovery is silent');
  // Unknown source wording must expose its missing interpreter, not become a
  // success/ignored completion. This fixture has no AI configuration or calls.
  await put('sources',{...source,id:'tibo-public'});
  const unknown=await createEvidence({sourceId:'tibo-public',messageId:'2117999999999999999',url:'https://x.com/thsottiaux/status/2117999999999999999',text:'A surprise is on its way for our subscribers.',publishedAt:at,collectedAt:at,contextComplete:true,textOrigin:'original',provenance:'archive',historical:false,metadata:{sourceGroup:'fxembed:thsottiaux'}});
  await drain();const pending=await one<Candidate>('candidates',unknown.candidate!.id);
  assert.equal(pending?.automation?.state,'configuration');assert.ok(pending?.automation?.reasonCodes.includes('semantic_pending'));
  const pendingBefore=JSON.stringify(pending);await drain();assert.equal(JSON.stringify(await one('candidates',pending!.id)),pendingBefore,'unchanged unconfigured input does not busy-loop');
  const repeat=JSON.stringify(await list('publications'));await drain();assert.equal(JSON.stringify(await list('publications')),repeat);
  // Queue-only readiness simulation. Never execute the fake endpoint/key.
  await put('settings',{...defaultAI,version:defaultAI.version+1,enabled:true,testedAt:at,encryptedKey:'TEST_ONLY_NOT_A_KEY',baseUrl:'https://example.invalid/v1',model:'queue-only-fixture',dailyCallLimit:2,dailyBudget:1,inputPrice:1,outputPrice:1});
  const schedule=()=>scheduleDue({allowTemplates:true,allowEnrichment:false,skipSources:true});
  await schedule();await schedule();
  const resumed=(await list<Job>('jobs')).filter(j=>j.candidateId===unknown.candidate!.id&&j.status==='queued');
  assert.equal(resumed.length,1,'ready interpreter requeues unchanged pending input exactly once');
  assert.equal((await one<Candidate>('candidates',unknown.candidate!.id))?.status,'pending','queued is not interpreted or published');
  for(let i=0;i<20;i++){
   const queued=(await list<Job>('jobs')).some(j=>j.candidateId===unknown.candidate!.id&&j.status==='queued');if(!queued)break;
   await runOne({schedule:false,allowTemplates:true,generate:async context=>({title:'普通摘要',summary:'待进一步解释',translation:'',category:'product',publicationMode:'news_only',contentOrigin:'generated',evidenceIds:context.map(e=>e.id),actions:[]}),review:async()=>{throw Error('An empty-action summary must be held before semantic proof or external calls');}});
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  const notInterpreted=await one<Candidate>('candidates',unknown.candidate!.id);
  assert.equal(notInterpreted?.status,'pending');assert.ok(notInterpreted?.reasons.some(reason=>reason.includes('不能用普通摘要')));
  assert.equal((await list<Publication>('publications')).some(p=>p.article.evidenceIds.includes(unknown.evidence.id)),false,'generic model prose cannot silently finish an unknown benefit input');


 }finally{await pool.end();}
});
