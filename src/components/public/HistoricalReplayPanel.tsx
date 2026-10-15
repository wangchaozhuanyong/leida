'use client';
import {useEffect,useState} from 'react';
import type {ReplayRun,ReplayStep} from '@/lib/historical-replay';
import {displayTime,safeUrl} from './model';

type RunSummary=Pick<ReplayRun,'runId'|'window'|'recordedAt'|'messageCount'|'totalSteps'|'coverage'>;
type Detail={run:RunSummary&Pick<ReplayRun,'scores'|'announcement'|'announcementCases'>;step:ReplayStep};
const benefitName=(kind:string)=>kind==='banked_reset'?'重置卡':'用量重置';
export function HistoricalReplayPanel(){
 const [runs,setRuns]=useState<RunSummary[]>([]),[runId,setRunId]=useState(''),[index,setIndex]=useState<number|null>(null),[detail,setDetail]=useState<Detail|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0);
 useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');
  void fetch('/api/v1/replays',{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error();return response.json();}).then(body=>{setRuns(body.data);setRunId(current=>current||body.data[0]?.runId||'');if(!body.data.length)setLoading(false);}).catch(()=>{if(!controller.signal.aborted){setError('历史回放暂时无法读取，请稍后重试。');setLoading(false);}});
  return()=>controller.abort();
 },[retry]);
 useEffect(()=>{if(!runId)return;const controller=new AbortController();setLoading(true);setError('');setDetail(null);
  void fetch(`/api/v1/replays/${runId}${index===null?'':`?step=${index}`}`,{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error();return response.json();}).then(body=>{if(!controller.signal.aborted){setDetail(body.data);setLoading(false);}}).catch(()=>{if(!controller.signal.aborted){setError('这一步暂时无法读取，请重试。');setLoading(false);}});
  return()=>controller.abort();
 },[runId,index,retry]);
 const step=detail?.step,run=detail?.run,p=step?.prediction,active=step?.outlook.active,resolved=step?.outlook.lastResolved;
 return <section className="pub-card" aria-label="近一个月历史回放">
  <div className="pub-card-top"><h2>近一个月历史回放</h2><span className="pub-badge amber">真实消息 · 历史模拟</span></div>
  <p className="pub-muted">按消息当时的先后顺序重放；预测在每一步固定保存。采集延迟为模拟值，历史回放与实时预测分别统计。</p>
  {error&&<p role="alert">{error} <button className="pub-button" onClick={()=>setRetry(n=>n+1)}>重新加载</button></p>}
  {!loading&&!error&&!runs.length&&<p>尚无已完成的回放批次。</p>}
  {runs.length>1&&<label>回放批次 <select value={runId} onChange={event=>{setRunId(event.target.value);setIndex(null);}}>{runs.map(item=><option key={item.runId} value={item.runId}>{displayTime(item.recordedAt)}</option>)}</select></label>}
  {loading&&<p role="status">正在读取固定回放记录…</p>}
  {step&&run&&<>
   <p>{displayTime(run.window.start)} 至 {displayTime(run.window.end)} · {run.messageCount}条窗口内消息</p>
   <div className="pub-share-row"><button className="pub-button" disabled={step.index===0||loading} onClick={()=>setIndex(0)}>第一步</button><button className="pub-button" disabled={step.index===0||loading} onClick={()=>setIndex(step.index-1)}>上一条</button><button className="pub-button" disabled={step.index>=run.totalSteps-1||loading} onClick={()=>setIndex(step.index+1)}>下一条</button><button className="pub-button" disabled={step.index>=run.totalSteps-1||loading} onClick={()=>setIndex(null)}>最终结果</button></div>
   <p>第{step.index+1} / {run.totalSteps}步 · {step.phase==='warmup'?'起点前历史初始化':step.kind==='message'?'消息到达':'时间推进'} · {displayTime(step.virtualAt)}</p>
   {step.message&&<details open><summary>当时收到的消息</summary><p className="pub-prose">{step.message.text}</p><p className="pub-muted">原文发布：{displayTime(step.message.publishedAt)}<br/>本次资料采集：{displayTime(step.message.collectedAt)}</p>{safeUrl(step.message.url)&&<a className="pub-text-link" href={safeUrl(step.message.url)!} target="_blank" rel="noopener noreferrer">查看原文</a>}</details>}
   <div><h3>按预告跟踪</h3><p>当时状态：{({scheduled:'已有带时间预告',announced:'已有预告，时间未明确',in_progress:'公开声明发放中',overdue:'预计时间已过，等待完成声明',completed:'已有公开完成声明',cancelled:'已公开取消',monitoring:'等待新的明确依据'})[step.outlook.status]}</p>
    {active&&<p>{benefitName(active.kind)} · 预告发布：{displayTime(active.statementAt)}<br/>{active.expectedAt?`公告预计时间：${displayTime(active.expectedAt)}`:'原文未给出可换算的明确时间。'}<br/>{active.timeNote}</p>}
    {resolved&&<p>最近公开{resolved.stage==='cancelled'?'取消':'完成'}声明：{benefitName(resolved.kind)} · {displayTime(resolved.resolvedAt)}</p>}
    <p className="pub-muted">预告时间沿用原文。到时只标记等待确认；必须取得同轮、同类福利的明确后续声明，才记录公开完成。个人账户到账未测。</p>
   </div>
   {run.announcement&&<><h3>预告兑现核对</h3><p>首次带时间预告{run.announcement.firstTimedRounds}轮；截止前完成声明{run.announcement.withinDeadline}/{run.announcement.deadlineCases}轮；预计时刻误差1小时内{run.announcement.pointWithinOneHour}/{run.announcement.pointCases}轮；未知{run.announcement.unknownRounds}轮。</p>{run.announcementCases?.map(row=><div className="pub-source-row" key={row.key}><div><strong>{benefitName(row.kind)} · {displayTime(row.statementAt)}的预告</strong><span>{row.mode==='deadline'?'最晚截止':'预计时刻'}：{displayTime(row.expectedAt)}</span><span>{row.outcome==='public_completion'?`后续公开完成声明：${displayTime(row.completionAt!)}`:row.outcome==='cancelled'?'后续公开取消':'尚无对应完成声明'}</span><span>{row.mode==='point'&&row.absoluteErrorHours!==undefined?`完成声明与预计时刻相差 ${row.absoluteErrorHours.toFixed(2)}小时`:row.withinDeadline!==undefined?row.withinDeadline?'期限前出现完成声明':'期限后出现完成声明':''}</span></div></div>)}</>}
   {(p||run.scores)&&<details><summary>历史间隔实验记录（独立统计）</summary><p className="pub-muted">下列估计只使用以往公开动态的间隔，不采用本轮预告时间，不能作为预告解读或本轮兑现成绩。</p>
    {p&&<div><h3>当时固定的统计估计</h3><p>{p.status==='ready'?`24小时 ${Math.round((p.p24??0)*100)}% · 48小时 ${Math.round((p.p48??0)*100)}%`:'当时未给出可用概率'}</p>{p.predictedAt&&<p>估计时刻：{displayTime(p.predictedAt)}<br/>估计区间：{displayTime(p.windowStart!)} 至 {displayTime(p.windowEnd!)}</p>}<p className="pub-muted">{p.explanation}</p></div>}
    {run.scores&&<><h3>统计估计的最终核对</h3><p>{run.scores.length?`可核对${run.scores.filter(row=>row.outcome==='public_statement').length}轮，未知${run.scores.filter(row=>row.outcome==='unknown').length}轮。每轮固定首次有效估计，后续更新另存。`:'本批未产生可评分的统计估计，样本不足记录全部保留。'}</p>{run.scores.map(row=><div className="pub-source-row" key={row.snapshotId}><div><strong>{displayTime(row.generatedAt)} 的首次估计</strong><span>{row.outcome==='unknown'?'后续结果未知':`时间误差 ${row.absoluteErrorHours!.toFixed(2)}小时 · ${row.inWindow?'区间命中':'区间未命中'}`}</span><span>区间宽度 {row.windowWidthHours.toFixed(2)}小时</span></div></div>)}</>}
   </details>}
   <details><summary>资料边界</summary>{run.coverage.notes.map(note=><p className="pub-muted" key={note}>{note}</p>)}<p className="pub-muted">公开声明时间不代表个人账户实际到账时间。历史模拟不能证明系统过去一个月持续在线。</p></details>
  </>}
 </section>;
}
