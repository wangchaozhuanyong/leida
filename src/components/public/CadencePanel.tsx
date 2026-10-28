'use client';
import Link from 'next/link';
import {useState} from 'react';
import {useFixedSnapshot} from './useFixedSnapshot';
import type {ForecastPublicData} from '@/lib/forecast';
import type {ResetCadenceForecast} from '@/lib/reset-cadence';
import {ResetPrediction} from './ResetPrediction';
import {displayTime,safeUrl} from './model';
import {cadenceForTarget,type CadenceTarget} from '@/lib/cadence-display';

export function CadencePanel({data,selectedId,initialTarget='automatic_reset'}:{data?:ForecastPublicData;selectedId?:string|null;initialTarget?:CadenceTarget}) {
 const [target,setTarget]=useState<CadenceTarget>(initialTarget);
 const fixed = useFixedSnapshot<ResetCadenceForecast>(selectedId ? `/api/v1/forecasts/cadence/${encodeURIComponent(selectedId)}` : null, selectedId ?? null);
 const snapshot = selectedId ? fixed.value : cadenceForTarget(data,target);
 const evaluation=data?.cadenceEvaluationByKind?.[target];
 const outcomes=data?.cadenceOutcomes?.filter(o=>o.snapshotId===snapshot?.id)??[];
 const horizons=data?.cadenceHorizonOutcomes?.filter(o=>o.snapshotId===snapshot?.id)??[];
 if(selectedId&&!snapshot)return <section className="pub-card" role={fixed?.error?'alert':'status'}><h2>{fixed?.error?'这条预测暂时无法加载':'正在加载预测记录'}</h2>{fixed.error&&<><p>{fixed.error}</p><button className="pub-button" onClick={fixed.retry}>重新检查</button></>}<Link scroll={false} className="pub-text-link" href="/methodology#reset-prediction">返回当前预测</Link></section>;
 return <div>
  {!selectedId&&<div className="pub-forecast-types" role="group" aria-label="预测依据类型"><button aria-pressed={target==='automatic_reset'} onClick={()=>setTarget('automatic_reset')}>用量重置</button><button aria-pressed={target==='banked_reset'} onClick={()=>setTarget('banked_reset')}>重置卡发放</button></div>}
  {fixed.error && <p className="pub-warning" role="alert">{fixed.error}<button onClick={fixed.retry}>重新检查</button></p>}
  {selectedId&&<p className="pub-muted">这是当时的预测记录，请结合后续进展查看。</p>}
  <ResetPrediction forecast={snapshot} now={selectedId&&snapshot?snapshot.generatedAt:data?.generatedAt??''} details frozen={!!selectedId}/>
  {!!snapshot?.target&&<section className="pub-card"><h2>固定窗口后续结果</h2>{horizons.length?horizons.map(outcome=><div className="pub-source-row" key={outcome.id}><div><strong>{outcome.horizonHours}小时窗口 · {outcome.result==='occurred'?'已找到对应公开动态':outcome.result==='not_occurred'?'覆盖已核验，未发现对应动态':'暂不能判断'}</strong><span>窗口截至 {displayTime(outcome.windowEnd)} · 北京时间</span>{outcome.actualAt&&<span>公开动态时间 {displayTime(outcome.actualAt)}</span>}<span>{outcome.scorable?'已加入可评分记录':'资料不完整或消息晚采，未计入预测成绩'}</span></div></div>):<p className="pub-muted">窗口尚未结束，或当前摘要未包含这条记录的后续结果；不能据此判断没有发生。</p>}</section>}
  {!selectedId&&evaluation&&<div className="pub-card pub-forecast-evaluation"><h2>上线后的预测验证</h2><p>可评分样本 {evaluation.maturedSamples} 次，其中发生 {evaluation.positiveSamples} 次；未知或晚采 {evaluation.unknownSamples} 次。</p><p>{evaluation.brierScore===null?'暂未积累足够的可评分结果。':`概率误差评分 ${evaluation.brierScore.toFixed(3)}；未平滑历史比例基线 ${evaluation.baselineBrierScore?.toFixed(3)??'暂无'}。分数越低，概率误差越小。`}</p><p>仅使用固定且互不重叠的48小时窗口；未知不当作未发生。尚未完成准确率验证。</p></div>}
  {outcomes.length>0&&<section className="pub-card"><h2>后续观测结果</h2>{outcomes.map(o=><div className="pub-source-row" key={o.id}><div><strong>{o.inWindow?'落在原估计区间内':'未落在原估计区间内'}</strong><span>后续公开动态：{displayTime(o.actualAt)}（北京时间）</span><span>与中位估计相差 {o.absoluteErrorHours.toFixed(1)} 小时</span>{safeUrl(o.url)&&<a className="pub-text-link" href={safeUrl(o.url)} target="_blank" rel="noopener noreferrer">查看后续原帖</a>}</div></div>)}<p className="pub-muted">结果依据公开动态，实际到账以账户显示为准。</p></section>}
  {!selectedId&&!!data?.cadenceHistory?.length&&<details className="pub-card"><summary>查看已执行的历史实验记录</summary><p className="pub-muted">初始窗口固定保留，后续结果另行记录；这些实验不作为当前重置时间。</p>{data.cadenceHistory.slice(0,8).map(s=><div className="pub-source-row" key={s.id}><div><strong>{displayTime(s.generatedAt)}（北京时间）</strong><span>{s.status==='ready'?`${s.sampleCount} 个历史间隔 · 已生成时间窗口`:s.status==='paused'?'来源暂停':s.status==='out_of_range'?'超出历史范围':'样本不足'}</span></div><Link scroll={false} className="pub-text-link" href={`/methodology?cadence=${encodeURIComponent(s.id)}`}>查看记录</Link></div>)}</details>}
  {selectedId&&<Link scroll={false} className="pub-text-link" href="/methodology#reset-prediction">查看当前预测</Link>}
 </div>;
}
