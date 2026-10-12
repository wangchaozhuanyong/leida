'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import type {ForecastPublicData} from '@/lib/forecast';
import type {ResetCadenceForecast} from '@/lib/reset-cadence';
import {ResetPrediction} from './ResetPrediction';
import {displayTime,safeUrl} from './model';

export function CadencePanel({data,selectedId}:{data?:ForecastPublicData;selectedId?:string|null}) {
 const [fixed,setFixed]=useState<{id:string;value?:ResetCadenceForecast;error?:string}|null>(null);
 useEffect(()=>{
  if(!selectedId)return;
  const controller=new AbortController();
  void fetch(`/api/v1/forecasts/cadence/${encodeURIComponent(selectedId)}`,{cache:'no-store',signal:controller.signal}).then(async r=>{
   const body=await r.json();if(!r.ok||body.data?.id!==selectedId)throw new Error(body.error||'固定预测记录暂不可用');return body.data as ResetCadenceForecast;
  }).then(value=>{if(!controller.signal.aborted)setFixed({id:selectedId,value});}).catch(error=>{if(!controller.signal.aborted)setFixed({id:selectedId,error:error instanceof Error?error.message:'固定预测记录暂不可用'});});
  return()=>controller.abort();
 },[selectedId]);
 const snapshot=selectedId?(fixed?.id===selectedId?fixed.value:undefined):data?.cadence;
 const outcomes=data?.cadenceOutcomes?.filter(o=>o.snapshotId===snapshot?.id)??[];
 if(selectedId&&!snapshot)return <section className="pub-card" role={fixed?.error?'alert':'status'}><h2>{fixed?.error?'固定预测读取失败':'正在读取固定预测记录'}</h2>{fixed?.error&&<p>{fixed.error}</p>}<Link className="pub-text-link" href="/methodology#reset-prediction">返回当前预测</Link></section>;
 return <div>
  {selectedId&&<p className="pub-muted">固定预测记录：以下保留生成时的估计，后续资料不会重写这些数值。</p>}
  <ResetPrediction forecast={snapshot} now={selectedId&&snapshot?snapshot.generatedAt:data?.generatedAt??''} details/>
  {outcomes.length>0&&<section className="pub-card"><h2>后续观测结果</h2>{outcomes.map(o=><div className="pub-source-row" key={o.id}><div><strong>{o.inWindow?'落在原估计区间内':'未落在原估计区间内'}</strong><span>后续公开动态：{displayTime(o.actualAt)}（北京时间）</span><span>与中位估计相差 {o.absoluteErrorHours.toFixed(1)} 小时</span>{safeUrl(o.url)&&<a className="pub-text-link" href={safeUrl(o.url)} target="_blank" rel="noopener noreferrer">查看后续原帖</a>}</div></div>)}<p className="pub-muted">这里只核对公开动态时间，个人实际到账尚未观测。</p></section>}
  {!selectedId&&!!data?.cadenceHistory?.length&&<details className="pub-card"><summary>查看已执行的历史实验记录</summary><p className="pub-muted">初始窗口固定保留，后续结果另行记录；这些实验不作为当前重置时间。</p>{data.cadenceHistory.slice(0,8).map(s=><div className="pub-source-row" key={s.id}><div><strong>{displayTime(s.generatedAt)}（北京时间）</strong><span>{s.status==='ready'?`${s.sampleCount} 个历史间隔 · 已生成时间窗口`:s.status==='paused'?'来源暂停':s.status==='out_of_range'?'超出历史范围':'样本不足'}</span></div><Link className="pub-text-link" href={`/methodology?cadence=${encodeURIComponent(s.id)}`}>查看记录</Link></div>)}</details>}
  {selectedId&&<Link className="pub-text-link" href="/methodology#reset-prediction">查看当前预测</Link>}
 </div>;
}
