import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool,list,one,put,insert} from '../src/db';
import type {Source,Job,Candidate,Evidence,Notice,Publication,RadarEvent,Article} from '../src/lib/types';
import {createEvidence} from '../src/server/service';
import {scheduleDue,runOne} from '../src/server/worker';
import {evidenceFingerprint} from '../src/server/automatic-content';
import {gatherEvidenceContext} from '../src/server/source-context';

test('isolated worker restores old preview, links progress, deduplicates retries and keeps historical recovery silent', {skip:process.env.RADAR_INTEGRATION!=='1'},async()=>{
 const url=new URL(process.env.DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55489');assert.match(url.pathname,/^\/radar_qa_/);
 const tag=randomUUID(),sourceId='banked-qa-'+tag,at=new Date(Date.now()-3*3600_000).toISOString();
 const source:Source={id:sourceId,name:'隔离重置卡测试',kind:'archive',url:'https://example.invalid/qa',enabled:true,validated:true,intervalMinutes:60,version:1,status:'healthy',nextRunAt:'2100-01-01T00:00:00Z'};
 await put('sources',source);await put('settings',{id:'site',name:'隔离测试',description:'本地',autoPublish:true,version:1});
 const fixture=(text:string,id:string,time=at,historical=false)=>createEvidence({sourceId,messageId:id,url:'https://x.com/thsottiaux/status/'+id,text,publishedAt:time,collectedAt:time,contextComplete:true,textOrigin:'original',provenance:'archive',historical});
 const drain=async()=>{await scheduleDue({allowTemplates:true,allowEnrichment:false,skipSources:true});for(let i=0;i<12;i++){const pending=(await list<Job>('jobs')).filter(j=>j.status==='queued'&&j.kind==='generate');if(!pending.length)break;await runOne({schedule:false,allowTemplates:true,generate:async()=>{throw Error('No AI or external calls allowed in this fixture');}});}};
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
  current=await one<RadarEvent>('events',event.id);assert.equal(current?.actions.length,1);assert.equal(current?.actions[0]?.stage,'in_progress');
  assert.match(current!.actions[0].timeNote!,/1\/2/);
  assert.equal((await one<Evidence>('evidence',first.evidence.id))?.parentId,undefined);
  const notices=(await list<Notice>('notices')).filter(n=>n.eventId===event.id);assert.ok(notices.some(n=>n.categories.includes('result')));
  const snapshot=JSON.stringify(await list('publications')),noticeCount=notices.length;
  await fixture('Banked 1/2',tag+'-first',first.evidence.publishedAt);await drain();
  assert.equal(JSON.stringify(await list('publications')),snapshot);assert.equal((await list<Notice>('notices')).filter(n=>n.eventId===event.id).length,noticeCount);
  await fixture('Banked 2/2',tag+'-second',new Date(Date.parse(at)+2*3600_000).toISOString());await drain();
  current=await one<RadarEvent>('events',event.id);assert.equal(current?.actions.length,1);assert.equal(current?.actions[0]?.stage,'claimed_complete');
  const before=(await list<Notice>('notices')).length;
  await fixture('We have granted a banked reset.',tag+'-history','2026-05-01T00:00:00Z',true);await drain();assert.equal((await list<Notice>('notices')).length,before);
  assert.equal((await list<Job>('jobs')).filter(j=>j.status==='failed').length,0);
 }finally{await pool.end();}
});
