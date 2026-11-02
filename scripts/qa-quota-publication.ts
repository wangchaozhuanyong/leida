// Existing frozen public corpus, replayed only at its factual collection times.
// This is a local publication/recovery test, not a simulated early-discovery score.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import type {Evidence,Source,Publication,Article,Job,RadarEvent,Activity} from '../src/lib/types';
const root=resolve(import.meta.dirname,'..'),project=resolve(root,'../..'),out=resolve(root,'outputs/quota-closure-20261101');
const frozen=resolve(project,'.codex-worktrees/reset-state-training-fix-20261025/outputs/half-year-replay-20261025');
const url=new URL(process.env.DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55489');assert.match(url.pathname,/^\/radar_qa_quota_/);
const inputText=readFileSync(resolve(frozen,'input.json'),'utf8'),labelsText=readFileSync(resolve(frozen,'independent-classification.json'),'utf8');
const records:Evidence[]=JSON.parse(inputText).records,labels=JSON.parse(labelsText).rows;
const digest=(s:string)=>createHash('sha256').update(s).digest('hex'),identity=(e:Pick<Evidence,'url'|'sourceId'|'messageId'>)=>{const m=e.url.match(/^https:\/\/(?:x|twitter)\.com\/([^/]+)\/status\//i);return m?`x:${m[1].toLowerCase()}:${e.messageId}`:`${e.sourceId}:${e.messageId}`;};
assert.equal(records.length,817);assert.equal(labels.length,373);
const NativeDate=Date,realFetch=globalThis.fetch;
let clock=Math.min(...records.map(e=>Math.max(Date.parse(e.collectedAt),Date.parse(e.publishedAt))));
globalThis.Date=new Proxy(NativeDate,{construct(target,args){return Reflect.construct(target,args.length?args:[clock]);},apply(){return new NativeDate(clock).toString();},get(target,key,receiver){return key==='now'?()=>clock:Reflect.get(target,key,receiver);}});
globalThis.fetch=async()=>{throw Error('Local corpus QA prohibits all external network/model/WeChat calls');};
const {pool,list,one,put}=await import('../src/db');
const {createEvidence}=await import('../src/server/service');
const {scheduleDue,runOne}=await import('../src/server/worker');
const {sourceDefinitions}=await import('../src/server/ingestion');
const {TIBO_PUBLIC_SOURCE}=await import('../src/server/tibo-public');
const {REFERENCE_SOURCES}=await import('../src/server/reference-reset-source');
const sourceTemplates=[...sourceDefinitions,TIBO_PUBLIC_SOURCE,...REFERENCE_SOURCES];
pool.on('connect',client=>{const query=client.query.bind(client);client.query=((sql:unknown,...args:unknown[])=>typeof sql==='string'&&sql.trimStart().startsWith('SELECT id,payload FROM radar_jobs')&&sql.includes('FOR UPDATE SKIP LOCKED LIMIT 1')?query(sql.replace(/\bnow\(\)/g,'$1::timestamptz'),[new NativeDate(clock).toISOString()]):(query as (...args:unknown[])=>unknown)(sql,...args)) as typeof client.query;});
try{
 let groups=0;const steps:unknown[]=[];
 if(!process.argv.includes('--audit-only')){
 for(const table of ['evidence','sources','articles','publications','candidates','settings'] as const)assert.equal((await list(table)).length,0,'QA requires a new empty database');
 await put('settings',{id:'site',name:'冻结公开资料恢复演练',description:'本地',autoPublish:true,version:1});await put('settings',{id:'ai',enabled:false,version:1});
 for(const id of new Set(records.map(e=>e.sourceId))){const known=sourceTemplates.find(s=>s.id===id);await put('sources',{...(known??{kind:'archive',name:id,url:'https://example.invalid/frozen',intervalMinutes:60,version:1}),id,enabled:true,validated:true,status:'healthy',nextRunAt:'2100-01-01T00:00:00Z'} as Source);}
 const timeline=[...records].sort((a,b)=>Math.max(Date.parse(a.collectedAt),Date.parse(a.publishedAt))-Math.max(Date.parse(b.collectedAt),Date.parse(b.publishedAt))||Date.parse(a.publishedAt)-Date.parse(b.publishedAt)||a.sourceId.localeCompare(b.sourceId));
 let completed=0;const snapshots=new Map<string,string>();
 while(completed<timeline.length){
  clock=Math.max(Date.parse(timeline[completed].collectedAt),Date.parse(timeline[completed].publishedAt));
  const group:Evidence[]=[];while(completed<timeline.length&&Math.max(Date.parse(timeline[completed].collectedAt),Date.parse(timeline[completed].publishedAt))===clock)group.push(timeline[completed++]);
  for(const record of group){const {id:_id,hash:_hash,...input}=record;const activity=record.metadata?.activity;if(activity&&!await one<Activity>('activities',activity.id))await put('activities',{...activity,items:[]});await createEvidence({...input,historical:true});}
  for(let round=0;round<100;round++){
   await scheduleDue({allowTemplates:true,allowEnrichment:false,skipSources:true});
   let worked=0;for(;worked<12;worked++)if(!await runOne({schedule:false,allowTemplates:true,enrich:async()=>undefined,enrichQuoted:async()=>[],generate:async()=>{throw Error('No actual model calls');},collect:async()=>{throw Error('No actual collection');},wechat:async()=>{throw Error('No actual delivery');}}))break;
   if(!worked)break;if(round===99)throw Error('Publication queue did not settle');
  }
  const evidence=await list<Evidence>('evidence'),publications=await list<Publication>('publications');
  assert.ok(evidence.every(e=>Date.parse(e.publishedAt)<=clock&&Date.parse(e.collectedAt)<=clock),'future evidence entered QA');
  for(const publication of publications){const value=JSON.stringify(publication),old=snapshots.get(publication.id);if(old)assert.equal(value,old,'immutable publication changed');else snapshots.set(publication.id,value);}
  assert.equal((await list('notices')).length,0,'historical recovery must remain silent');
  steps.push({at:new NativeDate(clock).toISOString(),identities:group.map(identity),evidence:evidence.length,publications:publications.length});groups++;
  if(groups%20===0)console.log(JSON.stringify({groups,records:completed,publications:publications.length}));
 }
 }else{const previous=JSON.parse(readFileSync(resolve(out,'publication-replay.json'),'utf8'));assert.equal(previous.inputSha256,digest(inputText));assert.equal(previous.counts.evidence,records.length);groups=previous.groups;steps.push(...previous.steps);}
 const evidence=await list<Evidence>('evidence'),articles=await list<Article>('articles'),events=await list<RadarEvent>('events'),publications=await list<Publication>('publications');
 const rows=labels.map((label:any)=>{
  const preferred=records.find(e=>identity(e)===label.identity&&digest(e.text)===label.preferredTextSha256);assert.ok(preferred,'frozen label source version missing');
  const matching=articles.filter(a=>a.status==='published'&&evidence.some(e=>e.id===a.evidenceIds[0]&&identity(e)===label.identity));
  const current=matching.map(a=>publications.find(p=>p.id===a.publicationId)!);assert.ok(current.every(Boolean));
  const actions=current.filter(p=>p.mode!=='news_only'&&p.article.publicationMode!=='news_only').flatMap(p=>p.event.actions.filter(action=>action.scope==='public'&&Math.abs(Date.parse(action.statementAt)-Date.parse(preferred.publishedAt))<1000));
  const expected=label.expected,benefit=!['pending','targeted_update','non_benefit','source_news'].includes(expected);
  const okay=benefit?actions.some(a=>a.stage===expected&&a.kind===label.kind&&(!label.expectedAt||a.expectedAt===label.expectedAt))&&actions.every(a=>a.stage===expected&&a.kind===label.kind)&&new Set(actions.map(a=>a.id)).size===1&&new Set(current.map(p=>p.eventId)).size===1:['pending','targeted_update'].includes(expected)?matching.some(a=>a.reviewStatus===expected)&&actions.length===0:actions.length===0;
  return {identity:label.identity,expected,round:label.round,okay,eventIds:[...new Set(current.map(p=>p.eventId))],actions:actions.map(a=>({kind:a.kind,stage:a.stage,at:a.statementAt,expectedAt:a.expectedAt})),reviews:matching.map(a=>a.reviewStatus??null)};
 });
 for(const round of new Set(labels.map((l:any)=>l.round).filter(Boolean))){const related=rows.filter((r:any)=>r.round===round);if(related.length>1&&!related[0].eventIds.some((id:string)=>related.every((r:any)=>r.eventIds.includes(id))))for(const row of related)row.okay=false;}
 const failedJobs=(await list<Job>('jobs')).filter(j=>j.status==='failed').map(j=>({kind:j.kind,error:j.error}));
 const runtimeFiles=['src/server/benefit-language.ts','src/server/benefit-analysis.ts','src/server/semantic-benefit-review.ts','src/server/benefit-rules.ts','src/server/benefit-signal.ts','src/server/source-context.ts','src/server/automatic-content.ts','src/server/domain.ts','src/server/worker.ts','src/server/service.ts','src/server/ai.ts','src/server/reset-cadence-evidence.ts','src/lib/reset-cadence.ts','miniprogram/utils/cadence.js','miniprogram/utils/home-reset-status.js'];
 const candidateFingerprint=digest(runtimeFiles.map(f=>f+'\0'+readFileSync(resolve(root,f),'utf8')).join('\0'));
 const report={baseline:'8f01c9a21bde1e9528bceb011e3ff846c2ed0fd3',candidateFingerprint,inputSha256:digest(inputText),labelsSha256:digest(labelsText),mode:'factual collectedAt order, historical silent recovery; not an advance-prediction benchmark',records:records.length,groups,passed:rows.filter((r:any)=>r.okay).length,failed:rows.filter((r:any)=>!r.okay),rows,steps,counts:{evidence:evidence.length,articles:articles.length,events:events.length,publications:publications.length},failedJobs,noFutureEvidence:true,immutablePublications:true,historicalNotifications:0,externalCalls:0,productionWrites:0};
 mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'publication-replay.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({...report,rows:undefined,steps:undefined},null,2));assert.equal(failedJobs.length,0);assert.equal(report.failed.length,0,'independent labels differ: inspect before claiming acceptance');
}finally{globalThis.Date=NativeDate;globalThis.fetch=realFetch;await pool.end();}
