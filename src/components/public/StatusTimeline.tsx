'use client';
import type {ResetOutlook} from '@/lib/reset-outlook';
import type {BenefitAction} from '@/lib/types';
import type {ForecastPublicData} from '@/lib/forecast';
import {statusTimelineModel,type Completion} from '@/lib/status-timeline';
export {statusTimelineModel} from '@/lib/status-timeline';
import {usePublicClock} from './PublicSession';
import {completionElapsed, completionTime} from './model';
import {referenceCadenceVisible} from '@/lib/reference-cadence';
import {NeuralNetworkArt} from './NeuralNetworkArt';

function LastResetClock({completion,serverTime}:{completion:Completion;serverTime:string}) {
  const now=usePublicClock(serverTime),elapsed=completionElapsed(completion,now);
  return elapsed&&completion?<div className="pub-last-reset-clock"><div><span>上次额度重置</span><time dateTime={completion.statementAt}>{completionTime(completion.statementAt)} · 北京时间</time></div><p aria-label="距上次额度重置已过去">{elapsed.parts.map(part=><span key={part.unit}>{part.value}<small>{part.unit}</small></span>)}</p></div>:null;
}

export function StatusTimeline({outlook, serverTime, completion = outlook.latestCompletion, forecasts, lastReset}: {outlook: ResetOutlook; serverTime: string; completion?: Completion; forecasts?: ForecastPublicData;lastReset?:Completion}) {
  const now = usePublicClock(serverTime);
  const model = statusTimelineModel(outlook, now, completion, forecasts);
  return <section className={`pub-status-timeline${model.completed ? ' is-completed' : ''}${model.scheduled ? ' is-scheduled' : ''}${model.watching?' is-watching':''}${model.estimating?' is-estimating':''}`} aria-label="公开重置进展">
    <div className="pub-timeline-overview">
      <div className="pub-timeline-copy">
        <div className="pub-timeline-head">{model.lead}</div>
        <div className="pub-timeline-row"><h1 className={model.title==='等待下一次 Reset'?'pub-timeline-waiting':undefined}>{model.scheduled && model.countdownParts.length ? model.countdownParts.map(part => <span className="pub-duration-part" key={part.unit}>{part.value}<small>{part.unit}</small></span>) : model.title}</h1></div>
        <div className="pub-timeline-date"><p className="pub-timeline-note">{model.note}</p>{(model.scheduled||model.overdue||model.watching)&&<span className="pub-timeline-timezone">北京时间</span>}</div>
        {model.forecastWindow&&<p className="pub-timeline-detail">信号发布时预计：{model.forecastWindow}</p>}
        {model.observedLabel&&<p className="pub-timeline-detail">{model.observedLabel}</p>}
        {model.chanceLabel&&<p className="pub-timeline-detail">{model.chanceLabel}</p>}
        {model.detail&&<p className="pub-timeline-detail">{model.detail}</p>}
      </div>
      <NeuralNetworkArt/>
    </div>
    {model.sourceCredit&&<div className="pub-watch-source">{model.sourceUrl&&<a href={model.sourceUrl} target="_blank" rel="noopener noreferrer">{model.sourceType==='observed'?'查看观察来源 ↗':'查看来源原帖 ↗'}</a>}<a href={model.sourceName==='AIPlanWatch'?'https://codex-reset.aiplanwatch.com/':'https://codex-resets.com/'} target="_blank" rel="noopener noreferrer">数据来自 {model.sourceName} ↗</a></div>}
    {referenceCadenceVisible(forecasts?.referenceCadence,now)&&<div className="pub-historical-probability"><span>历史节奏参考</span><div>{forecasts!.referenceCadence!.horizons.map(p=><span key={p.hours}><small>{p.hours}小时内</small><strong>{Math.round(p.probability*100)}%</strong></span>)}</div><small>至少一次公共额度重置的累计概率，非官方安排</small></div>}
    <LastResetClock completion={lastReset??(completion?.kind==='automatic_reset'?completion:null)} serverTime={serverTime}/>
    <ol className="pub-timeline-stages" aria-label="公开进展阶段">{model.stages.map((stage, i) => <li key={stage} className={model.currentStage === i ? 'current' : undefined} aria-current={model.currentStage === i ? 'step' : undefined}>{stage}</li>)}</ol>
  </section>;
}
