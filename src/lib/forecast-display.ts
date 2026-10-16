import type {ForecastCaseView, ForecastPublicData, ForecastSnapshot} from './forecast';

export const probabilityText=(value:number|null)=>value===null?'样本不足':`${Math.round(value*100)}%`;
export const forecastValueText=(snapshot:ForecastSnapshot,window:24|48)=>{
 const value=window===24?snapshot.p24:snapshot.p48;
 return value===null&&['late','already_known'].includes(snapshot.basis)?'不作提前预测':probabilityText(value);
};
export const intervalText=(value:[number,number]|null)=>value?`${(value[0]*100).toFixed(1)}%～${(value[1]*100).toFixed(1)}%`:'暂无可用区间';
export const forecastBasisText=(basis:ForecastSnapshot['basis'])=>({experimental_seed:'历史样本实验',verified_live:'观察样本实验',insufficient:'样本不足',late:'迟到观察',already_known:'已知公告，非提前预测'}[basis]);
export const forecastStatusText=(status:ForecastCaseView['status'])=>({watching:'观察中',elapsed:'窗口已结束',observed:'已找到对应公告',paused:'来源暂停或有缺口'}[status]);

/** The hero compares both original windows only before the first one expires. */
export function currentForecast(data:ForecastPublicData|undefined,now:string):ForecastCaseView|undefined {
 if(data?.status!=='ready'||!Number.isFinite(Date.parse(now)))return;
 return data.cases.filter(c=>c.target==='automatic_reset'&&c.status==='watching'&&!c.late&&c.coverage.status!=='gap'&&c.snapshot&&!c.snapshot.late&&c.snapshot.p24!==null&&c.snapshot.p48!==null&&Date.parse(c.signalAt)<=Date.parse(now)&&Date.parse(now)<Date.parse(c.windows[24]))
  .sort((a,b)=>Date.parse(b.signalAt)-Date.parse(a.signalAt))[0];
}

/** Polling revisions reflect stored facts, not the time this projection was fetched. */
export function forecastRevision(data:ForecastPublicData|undefined):unknown {
 if(!data)return {status:'unavailable'};
 return {status:data.status,ruleVersion:data.ruleVersion,modelVersion:data.modelVersion,...(data.outlook?{outlook:data.outlook}:{}),...(data.cadence?{cadence:{id:data.cadence.id,status:data.cadence.status}}:{}),...(data.cadenceByKind?{cadenceByKind:Object.fromEntries(Object.entries(data.cadenceByKind).map(([kind,snapshot])=>[kind,{id:snapshot?.id,status:snapshot?.status}]))}:{}),...(data.cadenceEvaluationByKind?{cadenceEvaluationByKind:data.cadenceEvaluationByKind}:{}),...(data.cadenceOutcomes?.length?{cadenceOutcomes:data.cadenceOutcomes.map(o=>o.id).sort()}:{}),...(data.cadenceHorizonOutcomes?.length?{cadenceHorizonOutcomes:data.cadenceHorizonOutcomes.map(o=>({id:o.id,snapshotId:o.snapshotId,horizonHours:o.horizonHours,result:o.result,scorable:o.scorable})).sort((a,b)=>a.id.localeCompare(b.id))}:{}),cases:data.cases.map(c=>({id:c.id,status:c.status,coverage:c.coverage,snapshotId:c.snapshotId,outcomes:c.outcomes.map(o=>o.id).sort()})).sort((a,b)=>a.id.localeCompare(b.id))};
}
