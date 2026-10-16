import type {ForecastPublicData} from './forecast';
import type {ResetCadenceForecast} from './reset-cadence';
import {RESET_CADENCE_MODEL_VERSION} from './reset-cadence';

export type CadenceTarget='automatic_reset'|'banked_reset';
export const cadenceTargetName=(target:CadenceTarget)=>target==='banked_reset'?'重置卡发放':'用量重置';
const time=(value:unknown)=>typeof value==='string'?Date.parse(value):NaN;
const probability=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;

/** Historical mixed models remain readable, but cannot become a current forecast. */
export function cadenceDisplay(snapshot:ResetCadenceForecast|undefined,now:string,target:CadenceTarget) {
 const legacy=!!snapshot&&(!snapshot.target||snapshot.modelVersion!==RESET_CADENCE_MODEL_VERSION);
 const current=time(now),generated=time(snapshot?.generatedAt),expires=time(snapshot?.validUntil);
 const expired=!!snapshot&&(!Number.isFinite(current)||!Number.isFinite(generated)||!Number.isFinite(expires)||generated>current||expires<=current);
 const valid=!legacy&&snapshot?.target===target&&snapshot.calibrated===false&&Number.isInteger(snapshot.sampleCount)&&snapshot.sampleCount>=8&&Number.isInteger(snapshot.eligibleCount)&&snapshot.eligibleCount>=5&&probability(snapshot.p24)&&probability(snapshot.p48)&&snapshot.p24<=snapshot.p48;
 const ready=snapshot?.status==='ready'&&!expired&&!!valid;
 const state=legacy?'历史模型':expired?'等待更新':snapshot?.status==='paused'?'暂停估算':snapshot?.status==='out_of_range'?'超出样本范围':ready?'历史估算':'积累记录中';
 const message=legacy?'这份旧模型记录仅供历史复盘，不作为当前预测。':expired?'上一次估算已过有效时间，等待后台更新。':snapshot?.status==='paused'?'来源资料暂时不足，恢复后自动更新。':snapshot?.status==='out_of_range'?'本次等待已超出历史可比范围，暂不估算。':ready?'根据同类型历史间隔估算，不是发放承诺。':'可核验的同类型历史记录还不足，暂不估算。';
 return {ready,legacy,state,message,target,label:cadenceTargetName(target),p24:ready?`${Math.round(snapshot!.p24!*100)}%`:'—',p48:ready?`${Math.round(snapshot!.p48!*100)}%`:'—',sampleCount:snapshot?.sampleCount??0,eligibleCount:snapshot?.eligibleCount??0,generatedAt:snapshot?.generatedAt??'',window24:Number.isFinite(generated)?new Date(generated+24*3600_000).toISOString():'',window48:Number.isFinite(generated)?new Date(generated+48*3600_000).toISOString():''};
}

export function cadenceForTarget(data:ForecastPublicData|undefined,target:CadenceTarget) {
 if(data?.status!=='ready')return;
 return data.cadenceByKind?.[target]??(target==='automatic_reset'?data.cadence:undefined);
}
