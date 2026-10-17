import type {ForecastPublicData} from './forecast';
import type {ResetCadenceForecast} from './reset-cadence';
import {RESET_CADENCE_MODEL_VERSION} from './reset-cadence';

export type CadenceTarget='automatic_reset'|'banked_reset';
export const cadenceTargetName=(target:CadenceTarget)=>target==='banked_reset'?'重置卡发放':'用量重置';
const time=(value:unknown)=>typeof value==='string'?Date.parse(value):NaN;
const probability=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
const windowTime=(value:string)=>{const s=new Date(Date.parse(value)+8*3600_000).toISOString();return `${s.slice(5,7)}月${s.slice(8,10)}日 ${s.slice(11,16)}`;};

/** Historical mixed models remain readable, but cannot become a current forecast. */
export function cadenceDisplay(snapshot:ResetCadenceForecast|undefined,now:string,target:CadenceTarget) {
 const legacy=!!snapshot&&(!snapshot.target||snapshot.modelVersion!==RESET_CADENCE_MODEL_VERSION);
 const current=time(now),generated=time(snapshot?.generatedAt),expires=time(snapshot?.validUntil);
 const expired=!!snapshot&&(!Number.isFinite(current)||!Number.isFinite(generated)||!Number.isFinite(expires)||generated>current||expires<=current);
 const valid=!legacy&&snapshot?.target===target&&snapshot.calibrated===false&&Number.isInteger(snapshot.sampleCount)&&snapshot.sampleCount>=8&&Number.isInteger(snapshot.eligibleCount)&&snapshot.eligibleCount>=5&&probability(snapshot.p24)&&probability(snapshot.p48)&&snapshot.p24<=snapshot.p48;
 const start=time(snapshot?.windowStart),end=time(snapshot?.windowEnd),point=time(snapshot?.predictedAt);
 const validWindow=Number.isFinite(start)&&Number.isFinite(end)&&Number.isFinite(point)&&start>generated&&start<=point&&point<=end&&end>current;
 const ready=snapshot?.status==='ready'&&!expired&&!!valid&&validWindow;
 const missingAnchor=snapshot?.status==='insufficient'&&snapshot.sampleCount>=8&&!Number.isFinite(time(snapshot.anchorAt));
 const comparableMissing=snapshot?.status==='insufficient'&&snapshot.sampleCount>=8&&!missingAnchor;
 const state=legacy?'历史模型':expired?'等待更新':snapshot?.status==='paused'?'暂停估算':snapshot?.status==='out_of_range'?'超出样本范围':ready?'历史估算':missingAnchor?'时间待核对':snapshot?.status==='ready'?'等待更新':'积累记录中';
 const message=legacy?'这份旧模型记录仅供历史复盘，不作为当前预测。':expired?'上一次估算已过有效时间，等待后台更新。':snapshot?.status==='paused'?'来源资料暂时不足，恢复后自动更新。':snapshot?.status==='out_of_range'?'本次等待已超出历史可比范围，暂不估算。':ready?'根据同类型历史间隔估算，不是发放承诺。':missingAnchor?'最近一次重置的时间依据待核对，暂不估算。':comparableMissing?'当前等待时长下的可比记录不足，暂不估算。':snapshot?.status==='ready'?'当前估计区间已失效或资料不完整，等待后台更新。':'可核验的同类型历史记录还不足，暂不估算。';
 const rangeLabel=ready?start===end?`${windowTime(snapshot!.windowStart!)}附近`:`${windowTime(snapshot!.windowStart!)} — ${windowTime(snapshot!.windowEnd!)}`:'';
 return {ready,legacy,state,message,target,label:cadenceTargetName(target),rangeLabel,predictedLabel:ready?windowTime(snapshot!.predictedAt!):'',p24:ready?`${Math.round(snapshot!.p24!*100)}%`:'—',p48:ready?`${Math.round(snapshot!.p48!*100)}%`:'—',sampleCount:snapshot?.sampleCount??0,eligibleCount:snapshot?.eligibleCount??0,generatedAt:snapshot?.generatedAt??'',window24:Number.isFinite(generated)?new Date(generated+24*3600_000).toISOString():'',window48:Number.isFinite(generated)?new Date(generated+48*3600_000).toISOString():''};
}

export function cadenceForTarget(data:ForecastPublicData|undefined,target:CadenceTarget) {
 if(data?.status!=='ready')return;
 return data.cadenceByKind?.[target]??(target==='automatic_reset'?data.cadence:undefined);
}
