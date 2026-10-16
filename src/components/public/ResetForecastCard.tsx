'use client';
import Link from 'next/link';
import {useState} from 'react';
import type {ForecastPublicData} from '@/lib/forecast';
import {cadenceDisplay,cadenceForTarget,type CadenceTarget} from '@/lib/cadence-display';
import {displayTime} from './model';

export function ResetForecastCard({data,now}:{data?:ForecastPublicData;now:string}) {
 const [target,setTarget]=useState<CadenceTarget>('automatic_reset');
 const snapshot=cadenceForTarget(data,target),view=cadenceDisplay(snapshot,now,target);
 const active=data?.outlook?.active;
 const announced=active?.kind===target;
 return <section className="pub-card pub-forecast-reference" aria-label="下一次重置参考">
  <div className="pub-card-top"><h2>下一次重置参考</h2><span className="pub-badge">{announced?'已有公开安排':view.state}</span></div>
  <div className="pub-forecast-types" role="group" aria-label="预测类型">
   <button aria-pressed={target==='automatic_reset'} onClick={()=>setTarget('automatic_reset')}>用量重置</button>
   <button aria-pressed={target==='banked_reset'} onClick={()=>setTarget('banked_reset')}>重置卡</button>
  </div>
  {announced?<p className="pub-forecast-message">已有明确公开安排，请以上方公告进展和原文为准。</p>:<>
   {view.ready&&<div className="pub-forecast-metrics"><div><span>24小时内</span><strong>{view.p24}</strong></div><div><span>48小时内</span><strong>{view.p48}</strong></div></div>}
   <p className="pub-forecast-message" role="status">{view.message}</p>
   {snapshot&&<p className="pub-forecast-meta">{view.sampleCount}个历史间隔 · {view.eligibleCount}个当前可比间隔<br/>估算于 {displayTime(snapshot.generatedAt)} · 北京时间</p>}
   {view.ready&&<p className="pub-forecast-meta">窗口从本次估算时间起算；24小时截至 {displayTime(view.window24)}。个人账户到账需自行确认。</p>}
  </>}
  <Link scroll={false} className="pub-text-link" href={`/methodology?target=${target}#cadence-prediction`}>查看预测依据 <span aria-hidden="true">→</span></Link>
 </section>;
}
