import type {ActionKind,ActionStage,Evidence,Source} from './types';

export const FORECAST_RULE_VERSION='codex-usage-signal-20261010-1';
export const FORECAST_MODEL_VERSION='dirichlet-reference-20261010-1';
export const FORECAST_PRIOR:[number,number,number]=[0.5,0.5,1];
export interface ForecastCoverage {status:'unverified'|'gap'|'verified';sourceIds:string[];reason:string;}
export interface ForecastCase {
 id:string;identity:string;title:string;url:string;sourceId:string;signalEvidenceIds:string[];target:ActionKind;
 signalAt:string;collectedAt:string;windows:{24:string;48:string};status:'watching'|'elapsed'|'observed'|'paused';
 coverage:ForecastCoverage;late:boolean;snapshotId:string;createdAt:string;updatedAt:string;
}
export interface ForecastEstimate {p24:number|null;p48:number|null;interval24:[number,number]|null;interval48:[number,number]|null;counts:[number,number,number];prior:[number,number,number];sampleCount:number;}
export interface ForecastSnapshot extends ForecastEstimate {
 id:string;caseId:string;title:string;url:string;sourceId:string;target:ActionKind;signature:string;signalAt:string;collectedAt:string;generatedAt:string;evidenceCutoffAt:string;
 windows:{24:string;48:string};ruleVersion:string;modelVersion:string;trainingSampleIds:string[];referenceSampleIds:string[];
 basis:'experimental_seed'|'verified_live'|'insufficient'|'late'|'already_known';coverage:ForecastCoverage;late:boolean;lateWindows:{24:boolean;48:boolean};explanation:string;
 trainingApplied:false;calibrated:false;
}
export interface ForecastOutcome {
 id:string;caseId:string;target:ActionKind;stage:ActionStage|'unknown';evidenceIds:string[];publicationId?:string;eventId?:string;
 observedAt:string;announcementAt?:string;relation:'explicit_source'|'causal_unique'|'unmatched';relationVerified:boolean;
 actualDelivery:'unobserved';reason:string;signature:string;invalidated?:boolean;
}
export interface ForecastCaseView extends ForecastCase {snapshot:ForecastSnapshot|undefined;outcomes:ForecastOutcome[];}
export interface ForecastReference extends ForecastEstimate {sampleIds:string[];coverage:'unverified';method:string;note:string;calibrated:false;}
export interface ForecastCadenceOutcome {id:string;recordType:'reset_cadence_outcome';snapshotId:string;observedAt:string;actualAt:string;evidenceIds:string[];url:string;inWindow:boolean;absoluteErrorHours:number;}
export interface CadenceHorizonOutcome {id:string;recordType:'reset_cadence_horizon_outcome';snapshotId:string;modelVersion:string;target:import('./reset-cadence').CadenceTarget;horizonHours:24|48;windowStart:string;windowEnd:string;observedAt:string;result:'occurred'|'not_occurred'|'unknown';scorable:boolean;actualAt?:string;evidenceIds:string[];reason:string;supersedes?:string;}
export interface CadenceEvaluation {modelVersion:string;maturedSamples:number;positiveSamples:number;unknownSamples:number;brierScore:number|null;baselineBrierScore:number|null;skill:number|null;calibrated:false;externalWeight:0;explanation:string;}
export interface ReferencePublicSignal {id:string;text:string;publishedAt:string;recordedAt:string;sourceUrl:string;sourceName:'AIPlanWatch';}
export interface ForecastPublicData {
 referenceSignal?:ReferencePublicSignal;
 referenceCadence?:import('./reference-cadence').ReferenceCadencePublic;watch?:import('./reset-watch').ResetWatch;status:'ready'|'unavailable';reason?:string;ruleVersion:string;modelVersion:string;generatedAt:string;cases:ForecastCaseView[];reference:ForecastReference;outlook?:import('./reset-outlook').ResetOutlook;cadence?:import('./reset-cadence').ResetCadenceForecast;cadenceByKind?:Partial<Record<import('./reset-cadence').CadenceTarget,import('./reset-cadence').ResetCadenceForecast>>;cadenceEvaluationByKind?:Partial<Record<import('./reset-cadence').CadenceTarget,CadenceEvaluation>>;cadenceHistory?:import('./reset-cadence').ResetCadenceForecast[];cadenceOutcomes?:ForecastCadenceOutcome[];cadenceHorizonOutcomes?:CadenceHorizonOutcome[];}
export const FORECAST_REFERENCE_SAMPLES=[
 {id:'01KK26XE1W536H7DQV2EXM3GHE',signalAt:'2026-03-06T18:35:00Z',announcementAt:'2026-03-08T02:42:13Z',delayHours:32.12027777777778,incidentUrl:'https://status.openai.com/incidents/01KK26XE1W536H7DQV2EXM3GHE',announcementUrl:'https://x.com/thsottiaux/status/2030474136024400173'},
 {id:'01KS88SRADTWQW27NYRAXMBAQN',signalAt:'2026-05-22T16:37:00Z',announcementAt:'2026-05-23T20:14:35Z',delayHours:27.62638888888889,incidentUrl:'https://status.openai.com/incidents/01KS88SRADTWQW27NYRAXMBAQN',announcementUrl:'https://x.com/thsottiaux/status/2058280452851638313'},
 {id:'01KW2E6W0503W4NXJNCVAG8V6T',signalAt:'2026-06-26T17:04:00Z',announcementAt:'2026-06-26T23:39:48Z',delayHours:6.596666666666667,incidentUrl:'https://status.openai.com/incidents/01KW2E6W0503W4NXJNCVAG8V6T',announcementUrl:'https://x.com/thsottiaux/status/2070653282440405046'},
] as const;

// Lanczos log-gamma and continued-fraction incomplete beta; no external statistics dependency.
function logGamma(z:number):number {
 const c=[676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
 if(z<0.5)return Math.log(Math.PI)-Math.log(Math.sin(Math.PI*z))-logGamma(1-z);
 z--;let x=0.99999999999980993;for(let i=0;i<c.length;i++)x+=c[i]/(z+i+1);const t=z+c.length-0.5;
 return 0.5*Math.log(2*Math.PI)+(z+0.5)*Math.log(t)-t+Math.log(x);
}
function betaFraction(a:number,b:number,x:number):number {
 const tiny=1e-300;let c=1,d=1-(a+b)*x/(a+1);if(Math.abs(d)<tiny)d=tiny;d=1/d;let h=d;
 for(let m=1;m<=300;m++){
  const m2=2*m;let aa=m*(b-m)*x/((a+m2-1)*(a+m2));d=1+aa*d;if(Math.abs(d)<tiny)d=tiny;c=1+aa/c;if(Math.abs(c)<tiny)c=tiny;d=1/d;h*=d*c;
  aa=-(a+m)*(a+b+m)*x/((a+m2)*(a+m2+1));d=1+aa*d;if(Math.abs(d)<tiny)d=tiny;c=1+aa/c;if(Math.abs(c)<tiny)c=tiny;d=1/d;const delta=d*c;h*=delta;if(Math.abs(delta-1)<3e-14)break;
 }
 return h;
}
export function betaCdf(x:number,a:number,b:number):number {
 if(!(a>0&&b>0)||!Number.isFinite(a+b))throw new Error('Beta参数无效');if(x<=0)return 0;if(x>=1)return 1;
 const factor=Math.exp(logGamma(a+b)-logGamma(a)-logGamma(b)+a*Math.log(x)+b*Math.log1p(-x));
 return x<(a+1)/(a+b+2)?factor*betaFraction(a,b,x)/a:1-factor*betaFraction(b,a,1-x)/b;
}
export function betaQuantile(p:number,a:number,b:number):number {
 if(!(p>=0&&p<=1))throw new Error('分位数无效');if(p===0)return 0;if(p===1)return 1;
 let low=0,high=1;for(let i=0;i<85;i++){const mid=(low+high)/2;if(betaCdf(mid,a,b)<p)low=mid;else high=mid;}return (low+high)/2;
}
export function forecastEstimate(counts:[number,number,number],target:ActionKind):ForecastEstimate {
 if(counts.some(n=>!Number.isSafeInteger(n)||n<0))throw new Error('样本计数无效');
 const sampleCount=counts.reduce((sum,n)=>sum+n,0),base={counts:[...counts] as [number,number,number],prior:[...FORECAST_PRIOR] as [number,number,number],sampleCount};
 if(target==='banked_reset'||!sampleCount)return {...base,p24:null,p48:null,interval24:null,interval48:null};
 const [a,b,c]=counts.map((n,i)=>n+FORECAST_PRIOR[i]),sum=a+b+c;
 return {...base,p24:a/sum,p48:(a+b)/sum,interval24:[betaQuantile(.025,a,b+c),betaQuantile(.975,a,b+c)],interval48:[betaQuantile(.025,a+b,c),betaQuantile(.975,a+b,c)]};
}
export function referenceForecast():ForecastReference {
 return {...forecastEstimate([1,2,0],'automatic_reset'),sampleIds:FORECAST_REFERENCE_SAMPLES.map(s=>s.id),coverage:'unverified',calibrated:false,method:'三例额度异常历史实验；Dirichlet先验[0.5,0.5,1]；95%等尾贝叶斯可信区间',note:'选中的三例历史仅作实验参考种子，连续来源覆盖未核验，不是实时训练队列或准确率；个人到账未观测。'};
}
export function forecastWindows(signalAt:string):{24:string;48:string} {
 const time=Date.parse(signalAt);if(!Number.isFinite(time))throw new Error('信号时间无效');return {24:new Date(time+24*3600_000).toISOString(),48:new Date(time+48*3600_000).toISOString()};
}
/** A successful HTTP check does not refresh a public snapshot's contents. */
export function referenceSnapshotFresh(snapshotAt:string|undefined,timestamp:string):boolean {
 const age=Date.parse(timestamp)-Date.parse(snapshotAt??'');
 return Number.isFinite(age)&&age>=-60_000&&age<=48*3600_000;
}
export function forecastSourceAvailable(source:Source|undefined,timestamp=new Date().toISOString()):boolean {
 const last=Date.parse(source?.lastSuccessAt??''),time=Date.parse(timestamp);
 if(source?.id==='aiplanwatch-signals'&&!referenceSnapshotFresh(source.referenceSnapshotAt,timestamp))return false;
 return !!source?.enabled&&source.validated&&!source.publicationPaused&&!['failed','paused','delayed','unconnected'].includes(source.status)&&source.kind!=='manual'&&Number.isFinite(last)&&Number.isFinite(time)&&time-last>=0&&time-last<=(source.effectiveIntervalMinutes??source.intervalMinutes)*3*60_000;
}
export function qualifyForecastSignal(evidence:Evidence,source:Source|undefined,timestamp=evidence.collectedAt):{identity:string;title:string;url:string;signalAt:string}|undefined {
 if(!forecastSourceAvailable(source,timestamp)||source?.kind!=='status'||evidence.provenance!=='official'||!evidence.contextComplete)return;
 const incident=evidence.url.match(/^https:\/\/status\.openai\.com\/incidents\/([A-Za-z0-9]+)\/?$/)?.[1];if(!incident||!Number.isFinite(Date.parse(evidence.publishedAt)))return;
 if(/resolved|已解决|已恢复/i.test(evidence.metadata?.status??''))return;
 const text=`${evidence.metadata?.title??''}\n${evidence.text}`;
 if(!/codex/i.test(text))return;
 const drain=/(?:usage|quota|limits?)\s+(?:are\s+|is\s+|being\s+|to\s+be\s+|be\s+)*(?:being\s+)?(?:consumed|deplet(?:ed|ing))\s+faster\s+than\s+expected|increased\s+codex\s+usage\s+rate|increase\s+in\s+users\s+hitting\s+codex\s+rate\s+limits|(?:hit|hitting|reach(?:ing)?)\s+(?:rate\s+|usage\s+)?limits?\s+(?:sooner|earlier)\s+than\s+(?:intended|expected)|(?:额度|用量).{0,16}(?:消耗过快|异常消耗|提前耗尽)|提前.{0,8}(?:触及|达到|撞上).{0,5}限额/i.test(text);
 if(!drain||/(?:not|no)\s+(?:an?\s+)?(?:issue\s+(?:with|of)\s+)?(?:increased|abnormal|unexpected)\s+(?:codex\s+)?usage|(?:not|no)\s+(?:an?\s+)?increase\s+in\s+(?:users\s+)?hitting\s+codex\s+rate\s+limits|未发现[^。！？\n]{0,40}(?:异常消耗|消耗过快)|并非[^。！？\n]{0,40}额度异常/i.test(evidence.text))return;
 return {identity:`openai-status:${incident}`,title:evidence.metadata?.title??'Codex 用量异常信号',url:evidence.url,signalAt:new Date(evidence.publishedAt).toISOString()};
}
/** Only explicitly linked evidence or supported causal text with a unique candidate may associate an announcement. */
export function matchForecastCase(evidence:Evidence,target:ActionKind,cases:ForecastCase[],all:Evidence[]):{caseId:string;relation:'explicit_source'|'causal_unique'}|undefined {
 if(evidence.provenance==='manual'||evidence.textOrigin==='archive_excerpt'||!evidence.contextComplete)return;
 if(/not\s+(?:related\s+to|due\s+to|because\s+of|compensation\s+for)|unrelated\s+to|与.{0,80}(?:无关|没有关系)|并非.{0,12}(?:补偿|针对)/i.test(evidence.text))return;
 const eligible=cases.filter(c=>c.target===target&&c.status!=='paused'&&Date.parse(c.signalAt)<=Date.parse(evidence.publishedAt));
 const incidentIds=[...evidence.text.matchAll(/https:\/\/status\.openai\.com\/incidents\/([A-Za-z0-9]+)/gi)].map(match=>match[1]);
 const linked=(c:ForecastCase)=>incidentIds.includes(c.url.match(/\/incidents\/([A-Za-z0-9]+)/)?.[1]??'')||c.signalEvidenceIds.some(id=>{const signal=all.find(e=>e.id===id);return !!signal&&(signal.id===evidence.id||signal.sourceId===evidence.sourceId&&signal.messageId===evidence.parentId);});
 const explicit=eligible.filter(linked);if(explicit.length===1)return {caseId:explicit[0].id,relation:'explicit_source'};if(explicit.length)return;
 if(!/codex/i.test(evidence.text)||!/(?:due\s+to|because\s+of|in\s+response\s+to|to\s+compensate\s+for|as\s+compensation\s+for|由于|针对|为补偿|因.{0,8}导致)/i.test(evidence.text)||!/(?:usage|quota|rate\s+limits?|额度|用量).{0,70}(?:bug|issue|consum|deplet|early|sooner|异常|消耗|提前)|(?:bug|issue|异常).{0,70}(?:usage|quota|rate\s+limits?|额度|用量)/i.test(evidence.text))return;
 const unique=eligible.filter(c=>Date.parse(evidence.publishedAt)<=Date.parse(c.windows[48]));
 return unique.length===1?{caseId:unique[0].id,relation:'causal_unique'}:undefined;
}
/** Positive means first public announcement, independently recording promised/progress/completion. No auto-negative label. */
export function selectTrainingSamples(cases:ForecastCase[],outcomes:ForecastOutcome[],asOf:string):ForecastOutcome[] {
 const cutoff=Date.parse(asOf),samples:ForecastOutcome[]=[];
 for(const c of cases){
  if(c.target!=='automatic_reset'||c.late||c.coverage.status!=='verified'||!(Date.parse(c.windows[48])<cutoff))continue;
  const related=outcomes.filter(o=>o.caseId===c.id&&o.target===c.target&&Date.parse(o.observedAt)<=cutoff);
  if(effectiveForecastOutcome(related,c.id,c.target,asOf).invalidated)continue;
  const first=related.filter(o=>['promised','in_progress','claimed_complete'].includes(o.stage)&&o.relationVerified&&o.relation!=='unmatched'&&o.announcementAt&&Date.parse(o.announcementAt)>=Date.parse(c.signalAt)&&Date.parse(o.announcementAt)<=Date.parse(c.windows[48])).sort((a,b)=>Date.parse(a.announcementAt!)-Date.parse(b.announcementAt!))[0];
  if(first&&Date.parse(c.createdAt)<=Date.parse(first.announcementAt!))samples.push(first);
 }
 return samples;
}
export function effectiveForecastOutcome(outcomes:ForecastOutcome[],caseId:string,target:ActionKind,asOf:string):{positive?:ForecastOutcome;latest?:ForecastOutcome;invalidated:boolean} {
 const related=outcomes.filter(o=>o.caseId===caseId&&o.target===target&&Date.parse(o.observedAt)<=Date.parse(asOf)&&(!o.announcementAt||Date.parse(o.announcementAt)<=Date.parse(asOf))).sort((a,b)=>Date.parse(a.announcementAt??a.observedAt)-Date.parse(b.announcementAt??b.observedAt)||Date.parse(a.observedAt)-Date.parse(b.observedAt)||a.id.localeCompare(b.id));
 const invalidated=related.some(o=>o.invalidated||o.stage==='cancelled'&&o.relationVerified&&o.relation!=='unmatched');
 const positive=invalidated?undefined:related.find(o=>['promised','in_progress','claimed_complete'].includes(o.stage)&&o.relationVerified&&o.relation!=='unmatched');
 return {positive,latest:related.at(-1),invalidated};
}
export function buildForecastSnapshot(input:{id:string;signature:string;case:ForecastCase;generatedAt:string;evidenceCutoffAt:string;cases:ForecastCase[];outcomes:ForecastOutcome[]}):ForecastSnapshot {
 const c=input.case,generated=Date.parse(input.generatedAt),knownAt=Math.max(generated,Date.parse(c.collectedAt));
 const lateWindows={24:knownAt>=Date.parse(c.windows[24]),48:knownAt>=Date.parse(c.windows[48])},late=lateWindows[24];
 const currentOutcome=effectiveForecastOutcome(input.outcomes,c.id,c.target,input.generatedAt),alreadyKnown=!!currentOutcome.positive||currentOutcome.invalidated;
 const samples=c.target==='automatic_reset'?selectTrainingSamples(input.cases,input.outcomes,input.evidenceCutoffAt).filter(o=>o.caseId!==c.id):[];
 const seeds=FORECAST_REFERENCE_SAMPLES.filter(s=>Date.parse(forecastWindows(s.signalAt)[48])<Date.parse(input.evidenceCutoffAt)&&`openai-status:${s.id}`!==c.identity);
 const counts:[number,number,number]=[0,0,0];
 if(c.target==='automatic_reset')for(const s of seeds)counts[s.delayHours<=24?0:1]++;
 const estimate=forecastEstimate(counts,c.target),basis:ForecastSnapshot['basis']=alreadyKnown?'already_known':late?'late':c.target==='banked_reset'||!estimate.sampleCount?'insufficient':'experimental_seed';
 return {...estimate,...(late||alreadyKnown?{p24:null,p48:null,interval24:null,interval48:null}:{}),id:input.id,caseId:c.id,title:c.title,url:c.url,sourceId:c.sourceId,target:c.target,signature:input.signature,signalAt:c.signalAt,collectedAt:c.collectedAt,generatedAt:input.generatedAt,evidenceCutoffAt:input.evidenceCutoffAt,windows:{...c.windows},ruleVersion:FORECAST_RULE_VERSION,modelVersion:FORECAST_MODEL_VERSION,trainingSampleIds:samples.map(s=>s.id),referenceSampleIds:c.target==='banked_reset'?[]:seeds.map(s=>s.id),trainingApplied:false,calibrated:false,basis,coverage:{...c.coverage,sourceIds:[...c.coverage.sourceIds]},late,lateWindows,
  explanation:alreadyKnown?'生成时已存在可知的对应公开公告或更正结局，记录事后观察，不输出提前预测概率；个人到账未观测。':late?'生成或采集已过首次信号24小时窗口，保守不输出提前预测概率；窗口起点不会刷新。':c.target==='banked_reset'?'没有可比的重置卡样本分母，不能套用额度重置实验概率。':estimate.sampleCount?'使用明确标注的选中历史实验种子，来源连续覆盖未核验；实时结局仅作观察，缺少可核验负例，尚不用于训练。可信区间不是准确率，个人到账未观测。':'没有已可用的可比样本，不把纯先验当作预测。'};
}
export function publicForecastCaseProjection(c:ForecastCase,snapshot:ForecastSnapshot|undefined,timestamp:string):{status:ForecastCase['status'];current:boolean;current24:boolean;current48:boolean} {
 const time=Date.parse(timestamp),status:ForecastCase['status']=c.status==='paused'||c.coverage.status==='gap'?'paused':c.status==='observed'?'observed':time>=Date.parse(c.windows[48])?'elapsed':'watching';
 const active=status==='watching'&&!!snapshot&&!snapshot.late&&snapshot.basis!=='already_known'&&snapshot.coverage.status!=='gap';
 const current24=active&&time<Date.parse(c.windows[24]),current48=active&&time<Date.parse(c.windows[48]);
 return {status,current:current48,current24,current48};
}
