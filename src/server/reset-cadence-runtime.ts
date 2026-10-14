import {createHash} from 'node:crypto';
import {insert,list,one,type Client} from '../db';
import type {Evidence,Source} from '../lib/types';
import {forecastSourceAvailable,type ForecastCadenceOutcome} from '../lib/forecast';
import {buildResetCadenceForecast,RESET_CADENCE_MODEL_VERSION,type ResetCadenceForecast} from '../lib/reset-cadence';
import {extractCadenceObservations} from './reset-cadence-evidence';

export interface StoredCadenceForecast extends ResetCadenceForecast {recordType:'reset_cadence';sourceIds:string[];inputFingerprint:string;}
export type CadenceOutcome=ForecastCadenceOutcome;
export interface CadenceRuntime {id:string;checkedAt:string;cadenceSnapshotId?:string;}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const isCadence=(value:unknown):value is StoredCadenceForecast=>!!value&&typeof value==='object'&&'recordType' in value&&value.recordType==='reset_cadence';
const isOutcome=(value:unknown):value is CadenceOutcome=>!!value&&typeof value==='object'&&'recordType' in value&&value.recordType==='reset_cadence_outcome';

/** Training can come from either verified public feed. An unused failed
 * archive does not disable a healthy direct Tibo series. */
export function cadenceSourcesAvailable(sources:Source[],sourceIds:string[],timestamp:string):boolean {
 const feeds=sources.filter(source=>
  source.id==='reset-archive'&&source.kind==='archive'&&source.url==='https://codex-resets.com/zh-CN'||
  source.id==='tibo-public'&&source.kind==='timeline'&&source.url==='https://api.fxtwitter.com/2/profile/thsottiaux/statuses');
 if(!sourceIds.length)return feeds.some(source=>forecastSourceAvailable(source,timestamp));
 return sourceIds.every(id=>forecastSourceAvailable(feeds.find(source=>source.id===id),timestamp));
}

/** This is a forecast of public messages. It never publishes a reset or sends reader notifications. */
export async function executeResetCadence(client:Client,evidence:Evidence[],sources:Source[],timestamp:string):Promise<{snapshotId:string;snapshots:number;outcomes:number}> {
 const observations=extractCadenceObservations(evidence,sources,timestamp);
 const sourceIds=[...new Set(evidence.filter(e=>observations.some(o=>o.evidenceIds.includes(e.id))).map(e=>e.sourceId))].sort();
 // An empty/new installation still records an honest insufficient result. A failed feed pauses the model.
 const paused=!cadenceSourcesAvailable(sources,sourceIds,timestamp);
 const inputFingerprint=digest([RESET_CADENCE_MODEL_VERSION,observations,sourceIds,paused]);
 const bucket=Math.floor(Date.parse(timestamp)/3600_000);
 const snapshotId=`forecast_cadence_${digest([inputFingerprint,bucket])}`;
 const previous=await one<StoredCadenceForecast>('forecast_snapshots',snapshotId,client);
 const model=buildResetCadenceForecast({observations,generatedAt:timestamp,inputFingerprint,paused,pauseReason:'历史重置来源暂停、采集延迟或结构异常，恢复后重新计算。'});
 let snapshots=0;
 if(!previous){
  const snapshot:StoredCadenceForecast={...model,id:snapshotId,recordType:'reset_cadence',sourceIds,inputFingerprint};
  if(await insert('forecast_snapshots',snapshot,client))snapshots=1;
 }
 // Resolve stored forecasts only with a later observed public statement, never with a countdown expiry.
 const stored=(await list<unknown>('forecast_snapshots',client)).filter(isCadence);
 let outcomes=0;
 for(const forecast of stored){
  if(forecast.status!=='ready'||!forecast.predictedAt||!forecast.windowStart||!forecast.windowEnd)continue;
  const next=model.observations.find(o=>Date.parse(o.at)>Date.parse(forecast.generatedAt));
  if(!next)continue;
  const actual=Date.parse(next.at),signature=digest([forecast.id]);
  const outcome:CadenceOutcome={id:`forecast_cadence_outcome_${signature}`,recordType:'reset_cadence_outcome',snapshotId:forecast.id,observedAt:timestamp,actualAt:next.at,evidenceIds:next.evidenceIds,url:next.url,inWindow:actual>=Date.parse(forecast.windowStart)&&actual<=Date.parse(forecast.windowEnd),absoluteErrorHours:Math.abs(actual-Date.parse(forecast.predictedAt))/3600_000};
  if(await insert('forecast_outcomes',outcome,client))outcomes++;
 }
 return {snapshotId,snapshots,outcomes};
}

export async function getCadenceSnapshot(id:string,client:Client):Promise<StoredCadenceForecast|undefined> {
 if(!/^forecast_cadence_[a-f0-9]{64}$/.test(id))return;
 const row=await one<unknown>('forecast_snapshots',id,client);
 return isCadence(row)?row:undefined;
}

export function projectCadenceForecast(snapshot:StoredCadenceForecast|undefined,sources:Source[],timestamp:string):ResetCadenceForecast|undefined {
 if(!snapshot)return;
 if(!snapshot.sourceIds.length?!(snapshot.status==='insufficient'&&cadenceSourcesAvailable(sources,[],timestamp)):snapshot.sourceIds.some(id=>!forecastSourceAvailable(sources.find(s=>s.id===id),timestamp)))return {...snapshot,status:'paused',p24:null,p48:null,predictedAt:null,windowStart:null,windowEnd:null,explanation:'历史重置来源暂停、失效或采集延迟，暂不提供当前估计；固定预测记录继续保留。'};
 if(Date.parse(snapshot.generatedAt)>Date.parse(timestamp)||Date.parse(snapshot.validUntil)<=Date.parse(timestamp))return {...snapshot,status:'paused',p24:null,p48:null,predictedAt:null,windowStart:null,windowEnd:null,explanation:'预测更新已超时，等待后台重新计算；旧记录不会冒充当前预测。'};
 return snapshot;
}

export function cadenceOutcomes(rows:unknown[]):CadenceOutcome[]{return rows.filter(isOutcome).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));}
