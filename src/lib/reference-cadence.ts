import type {PublicFactsData} from './public-facts';
import {completedPublicActions,isNewsOnly} from './public-facts';

export const REFERENCE_CADENCE_VERSION='conditional-empirical-global-20261018-1';
const HOUR=3600000,DAY=24*HOUR;
export interface ReferenceResetPoint {id:string;at:string;knownAt:string;}
export interface ReferenceCadenceReview {modelVersion:string;inputFingerprint:string;reviewedAt:string;reviewedBy:string;asOfRevisionsAudited:boolean;continuousCoverageVerified:boolean;}
export interface ReferenceCadencePublic {
 modelVersion:string;status:'ready'|'insufficient_data'|'reset_just_happened'|'pending_review'|'expired'|'error';
 generatedAt:string;validUntil:string;anchorAt:string|null;sampleCount:number;comparableCount:number;
 horizons:{hours:24|48|72;probability:number}[];reason:string;
}
export interface ReferenceCadenceCandidate extends ReferenceCadencePublic {
 inputFingerprint:string;candidateHorizons:ReferenceCadencePublic['horizons'];
 evaluation:{points:number;independentCycles:number;brierScore:number|null;baselineBrierScore:number|null;calibrationError:number|null};
}
const time=(s:string)=>Date.parse(s);

/** Published completions only. A source's future announcement and banked reset
 * cannot enter the global-reset interval series. Deduplicate original post IDs. */
export function referenceResetPoints(facts:PublicFactsData):ReferenceResetPoint[] {
 const seen=new Set<string>();
 return completedPublicActions(facts).filter(({action})=>action.kind==='automatic_reset').flatMap(({action,publication})=>{
  const proof=facts.evidence.filter(e=>action.evidenceIds.includes(e.id)&&publication.article.evidenceIds.includes(e.id)&&e.provenance!=='manual'&&e.textOrigin==='original'&&e.text.includes(action.evidenceQuote??'')&&!!action.evidenceQuote);
  const primary=proof.find(e=>Math.abs(time(e.publishedAt)-time(action.statementAt))<=1000);
  const post=primary?.url.match(/^https:\/\/(?:x|twitter)\.com\/thsottiaux\/status\/(\d{15,20})$/)?.[1];
  if(!primary||!post||!Number.isFinite(time(publication.publishedAt))||proof.some(e=>!Number.isFinite(time(e.collectedAt)))||Math.abs(Number((BigInt(post)>>22n)+1288834974657n)-time(primary.publishedAt))>1000||seen.has(post))return [];
  seen.add(post);
  const equivalent=facts.publications.filter(p=>p.eventId===publication.eventId&&!isNewsOnly(p)&&Number.isFinite(time(p.publishedAt))&&time(p.publishedAt)<=time(facts.serverTime)&&p.event.actions.some(a=>a.id===action.id&&a.kind===action.kind&&a.scope===action.scope&&a.stage==='claimed_complete'&&time(a.statementAt)===time(action.statementAt)&&a.eligibility===action.eligibility));
  const firstKnown=Math.min(time(publication.publishedAt),...equivalent.map(p=>time(p.publishedAt)));
  const knownAt=new Date(Math.max(firstKnown,...proof.map(e=>time(e.collectedAt)))).toISOString();
  return [{id:post,at:action.statementAt,knownAt}];
 }).sort((a,b)=>time(a.at)-time(b.at));
}
/** Reconstruct the immutable publication state known at one historical instant.
 * Current withdrawals/corrections must not rewrite older training snapshots. */
export function referencePointsAt(facts:PublicFactsData,asOf:string):ReferenceResetPoint[] {
 const cutoff=time(asOf),latest=new Map<string,PublicFactsData['publications'][number]>();
 const publications=facts.publications.filter(p=>Number.isFinite(time(p.publishedAt))&&time(p.publishedAt)<=cutoff).sort((a,b)=>time(a.publishedAt)-time(b.publishedAt)||a.id.localeCompare(b.id));
 for(const p of publications)if(!isNewsOnly(p))latest.set(p.eventId,p);
 const selected=[...latest.values()];
 return referenceResetPoints({events:selected.map(p=>({...p.event,publicationId:p.id})),articles:selected.map(p=>p.article),publications,evidence:facts.evidence.filter(e=>time(e.collectedAt)<=cutoff),serverTime:asOf});
}
export interface ReferenceCadenceReplay {fingerprint:string;pointsAt:(asOf:string)=>ReferenceResetPoint[];}
export function referenceCadenceReplay(facts:PublicFactsData,fingerprint:string):ReferenceCadenceReplay {
 const cached=new Map<string,ReferenceResetPoint[]>();
 return {fingerprint,pointsAt(asOf){if(!cached.has(asOf))cached.set(asOf,referencePointsAt(facts,asOf));return cached.get(asOf)!;}};
}
function series(points:ReferenceResetPoint[],cutoff:number) {
 const seen=new Set<string>();
 return points.filter(p=>!seen.has(p.id)&&Number.isFinite(time(p.at))&&Number.isFinite(time(p.knownAt))&&time(p.at)<=cutoff&&time(p.knownAt)<=cutoff&&(seen.add(p.id),true)).sort((a,b)=>time(a.at)-time(b.at));
}
function distribution(points:ReferenceResetPoint[],cutoff:number) {
 const anchor=points.at(-1),elapsed=anchor?cutoff-time(anchor.at):NaN;
 const intervals=points.slice(1).map((point,index)=>time(point.at)-time(points[index].at)).filter(n=>n>0);
 const comparable=intervals.filter(n=>n>elapsed);
 const horizons=([24,48,72] as const).map(hours=>({hours,probability:comparable.length?comparable.filter(n=>n<=elapsed+hours*HOUR).length/comparable.length:0}));
 return {anchor,elapsed,intervals,comparable,horizons};
}
/** Deterministic source-series identity. Not a credential or approval token. */
function fingerprint(points:ReferenceResetPoint[]) {return JSON.stringify(points.map(p=>[p.id,p.at,p.knownAt]));}

/** Daily chronological replay: final 30% held out, 72h embargo, and every
 * training point must have been published and collected at that replay time. */
function evaluate(points:ReferenceResetPoint[],cutoff:number,replay?:ReferenceCadenceReplay) {
 const empty={points:0,independentCycles:0,brierScore:null as number|null,baselineBrierScore:null as number|null,calibrationError:null as number|null};
 if(points.length<21)return empty;
 const start=time(points[0].at),testStart=start+(cutoff-start)*.7+72*HOUR;
 let count=0,score=0,baseline=0;const cycles=new Set<string>(),bins=Array.from({length:5},()=>({n:0,p:0,y:0}));
 for(let at=Math.ceil(testStart/DAY)*DAY;at+72*HOUR<=cutoff;at+=DAY){
  const training=replay?replay.pointsAt(new Date(at-72*HOUR).toISOString()):series(points,at-72*HOUR),known=replay?replay.pointsAt(new Date(at).toISOString()):series(points,at),anchor=known.at(-1);
  if(!anchor||at-time(anchor.at)<HOUR)continue;
  const historical=distribution(training,at);
  // The waiting origin is the actual latest known event, while the training
  // intervals are embargoed. Never include a future completion in training.
  const elapsed=at-time(anchor.at),support=historical.intervals.filter(n=>n>elapsed);
  if(historical.intervals.length<20||support.length<10)continue;
  cycles.add(anchor.id);count++;
  for(const hours of [24,48,72]){
   const p=support.filter(n=>n<=elapsed+hours*HOUR).length/support.length;
   const y=points.some(point=>time(point.at)>at&&time(point.at)<=at+hours*HOUR)?1:0;
   const b=historical.intervals.filter(n=>n<=hours*HOUR).length/historical.intervals.length;
   score+=(p-y)**2;baseline+=(b-y)**2;
   const bin=bins[Math.min(4,Math.floor(p*5))];bin.n++;bin.p+=p;bin.y+=y;
  }
 }
 return {...empty,points:count,independentCycles:cycles.size,brierScore:count?score/(count*3):null,baselineBrierScore:count?baseline/(count*3):null,calibrationError:count?bins.reduce((sum,b)=>sum+(b.n?Math.abs(b.p-b.y):0),0)/(count*3):null};
}
export function buildReferenceCadence(points:ReferenceResetPoint[],now:string,review?:ReferenceCadenceReview,replay?:ReferenceCadenceReplay):ReferenceCadenceCandidate {
 const cutoff=time(now),known=Number.isFinite(cutoff)?series(points,cutoff):[],d=distribution(known,cutoff),inputFingerprint=fingerprint(known)+(replay?'|revisions:'+replay.fingerprint:'|no-revision-replay');
 const evaluation=evaluate(known,cutoff,replay);
 let status:ReferenceCadencePublic['status']='pending_review',reason='历史修订、连续覆盖和模型审核尚未全部完成，暂不显示概率。';
 if(!Number.isFinite(cutoff)){status='error';reason='预测时间无效。';}
 else if(d.anchor&&d.elapsed<HOUR){status='reset_just_happened';reason='最近额度重置不足一小时，暂不预测下一次。';}
 else if(d.intervals.length<20||d.comparable.length<10){status='insufficient_data';reason='合格历史间隔或可比间隔不足，暂不显示概率。';}
 else if(evaluation.points<30||evaluation.independentCycles<10){reason='时间回测尚未达到30个有效时点和10个独立周期，暂不显示概率。';}
 else if(evaluation.brierScore===null||evaluation.baselineBrierScore===null||evaluation.brierScore>evaluation.baselineBrierScore||evaluation.calibrationError===null||evaluation.calibrationError>.1){reason='校准或基线比较未通过，暂不显示概率。';}
 else if(!replay?.fingerprint){reason='缺少不可变修订的逐日回放，暂不显示概率。';}
 else if(review?.modelVersion===REFERENCE_CADENCE_VERSION&&review.inputFingerprint===inputFingerprint&&review.asOfRevisionsAudited&&review.continuousCoverageVerified&&typeof review.reviewedBy==='string'&&review.reviewedBy.trim()&&Number.isFinite(time(review.reviewedAt))&&time(review.reviewedAt)<=cutoff){status='ready';reason='历史节奏参考，未来24/48/72小时至少一次公共额度重置的累计概率；不是官方安排。';}
 return {modelVersion:REFERENCE_CADENCE_VERSION,status,generatedAt:now,validUntil:Number.isFinite(cutoff)?new Date(cutoff+6*HOUR).toISOString():now,anchorAt:d.anchor?.at??null,sampleCount:d.intervals.length,comparableCount:d.comparable.length,horizons:status==='ready'?d.horizons:[],reason,inputFingerprint,candidateHorizons:d.horizons,evaluation};
}
/** Raw candidate probabilities and approval details never cross the public API. */
export function publicReferenceCadence(candidate:ReferenceCadenceCandidate):ReferenceCadencePublic {
 const {inputFingerprint:_,candidateHorizons:__,evaluation:___,...publicData}=candidate;return publicData;
}

/** Display a frozen public result only during its original validity window. */
export function referenceCadenceVisible(value:ReferenceCadencePublic|undefined,now:string):boolean {
 return !!value&&value.modelVersion===REFERENCE_CADENCE_VERSION&&value.status==='ready'&&time(value.generatedAt)<=time(now)&&time(value.validUntil)>time(now)&&value.sampleCount>=20&&value.comparableCount>=10&&value.horizons.length===3&&value.horizons.every((p,i)=>p.hours===[24,48,72][i]&&Number.isFinite(p.probability)&&p.probability>=0&&p.probability<=1&&(i===0||p.probability>=value.horizons[i-1].probability));
}

/** Reuse the worker's immutable cutoff. Reads never slide a published horizon. */
export function projectReferenceCadence(value:ReferenceCadencePublic|undefined,anchorAt:string|null,now:string):ReferenceCadencePublic {
 const empty:ReferenceCadencePublic={modelVersion:REFERENCE_CADENCE_VERSION,status:'pending_review',generatedAt:now,validUntil:now,anchorAt,sampleCount:0,comparableCount:0,horizons:[],reason:'历史概率尚未完成数据核验和审核，暂不显示数字。'};
 if(!value||value.modelVersion!==REFERENCE_CADENCE_VERSION||!Number.isFinite(time(value.generatedAt))||!Number.isFinite(time(value.validUntil))||time(value.generatedAt)>time(now)||value.anchorAt!==anchorAt||!Array.isArray(value.horizons))return empty;
 if(time(value.validUntil)<=time(now))return {...value,status:'expired',horizons:[],reason:'历史概率已过期，等待后台更新。'};
 if(value.status==='ready'&&!referenceCadenceVisible(value,now))return empty;
 return {...value,horizons:value.status==='ready'?value.horizons:[]};
}
export function validatedReferenceReview(value:unknown):ReferenceCadenceReview|undefined {
 if(!value||typeof value!=='object')return;
 const row=value as ReferenceCadenceReview;
 if(row.modelVersion!==REFERENCE_CADENCE_VERSION||typeof row.inputFingerprint!=='string'||row.inputFingerprint.length>100000||typeof row.reviewedBy!=='string'||!row.reviewedBy.trim()||row.reviewedBy.length>200||!Number.isFinite(time(row.reviewedAt))||row.asOfRevisionsAudited!==true||row.continuousCoverageVerified!==true)return;
 return {modelVersion:row.modelVersion,inputFingerprint:row.inputFingerprint,reviewedAt:row.reviewedAt,reviewedBy:row.reviewedBy,asOfRevisionsAudited:true,continuousCoverageVerified:true};
}
