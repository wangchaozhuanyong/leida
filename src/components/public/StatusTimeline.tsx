'use client';
import type {ResetOutlook} from '@/lib/reset-outlook';
import type {BenefitAction} from '@/lib/types';
import type {ForecastPublicData} from '@/lib/forecast';
import {statusTimelineModel,type Completion} from '@/lib/status-timeline';
export {statusTimelineModel} from '@/lib/status-timeline';
import {usePublicClock} from './PublicSession';
import {NeuralNetworkArt} from './NeuralNetworkArt';

export function StatusTimeline({outlook, serverTime, completion = outlook.latestCompletion, forecasts}: {outlook: ResetOutlook; serverTime: string; completion?: Completion; forecasts?: ForecastPublicData}) {
  const now = usePublicClock(serverTime);
  const model = statusTimelineModel(outlook, now, completion, forecasts);
  return <section className={`pub-status-timeline${model.completed ? ' is-completed' : ''}${model.scheduled ? ' is-scheduled' : ''}${model.watching?' is-watching':''}${model.estimating?' is-estimating':''}`} aria-label="公开重置进展">
    <div className="pub-timeline-overview">
      <div className="pub-timeline-copy">
        <div className="pub-timeline-head">{model.lead}</div>
        <div className="pub-timeline-row"><h1 className={model.title==='等待下一次 Reset'?'pub-timeline-waiting':undefined}>{model.title}{model.scheduled && <small>小时 : 分钟</small>}</h1></div>
        <p className="pub-timeline-note">{model.note}</p>
        {model.forecastWindow&&<p className="pub-timeline-detail">信号发布时预计：{model.forecastWindow}</p>}
        {model.observedLabel&&<p className="pub-timeline-detail">{model.observedLabel}</p>}
        {model.chanceLabel&&<p className="pub-timeline-detail">{model.chanceLabel}</p>}
        {(model.scheduled||model.watching)&&<p className="pub-timeline-timezone">北京时间</p>}
        {model.detail&&<p className="pub-timeline-detail">{model.detail}</p>}
      </div>
      <NeuralNetworkArt/>
    </div>
    {model.sourceCredit&&<div className="pub-watch-source">{model.sourceUrl&&<a href={model.sourceUrl} target="_blank" rel="noopener noreferrer">{model.sourceType==='observed'?'查看观察来源 ↗':'查看来源原帖 ↗'}</a>}<a href="https://codex-resets.com/" target="_blank" rel="noopener noreferrer">数据来自 Codex Resets ↗</a></div>}
    <ol className="pub-timeline-stages" aria-label="公开进展阶段">{model.stages.map((stage, i) => <li key={stage} className={model.currentStage === i ? 'current' : undefined} aria-current={model.currentStage === i ? 'step' : undefined}>{stage}</li>)}</ol>
  </section>;
}
