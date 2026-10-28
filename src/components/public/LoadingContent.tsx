import {RadarScope} from './RadarScope';

/** Placeholders contain no facts, zero counts, or fabricated countdowns. */
export function LoadingContent({variant='list'}:{variant?:'home'|'calendar'|'detail'|'list'}) {
  const line=(name='')=><span className={`pub-skeleton-line ${name}`}/>;
  return <section className={`pub-loading-skeleton skeleton-${variant}`} role="status" aria-label="正在加载内容">
    <div aria-hidden="true">
      {variant==='home'?<>
        <div className="pub-skeleton-tabs"><span/><span/></div>
        <RadarScope state="observed">{line('short')}{line('metric')}{line('short')}</RadarScope>
        <div className="pub-skeleton-copy">{line()}{line('short')}</div>
        <div className="pub-skeleton-card compact">{line('short')}{line()}</div>
        <div className="pub-skeleton-tabs actions"><span/><span/></div>
      </>:variant==='calendar'?<div className="pub-skeleton-card">{line('short')}<div className="pub-skeleton-calendar">{Array.from({length:35},(_,i)=><span key={i}/>)}</div>{line()}{line('short')}</div>
      :Array.from({length:variant==='detail'?1:3},(_,i)=><div className="pub-skeleton-card" key={i}>{line('short')}{line('heading')}{line()}{variant==='detail'&&<div className="pub-skeleton-paragraph">{line()}{line()}{line()}</div>}{line('tail')}</div>)}
    </div>
    <span className="pub-skeleton-hint">正在获取内容…</span>
  </section>;
}
