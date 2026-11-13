'use client';
import {Fragment} from 'react';
import {homeResetStatus} from '../../../miniprogram/utils/home-reset-status';
import Link from 'next/link';
import type {PublicData} from '@/lib/types';
import {resetStateCards,type ResetStateCard} from '@/lib/reset-state-cards';
import {usePublicClock} from './PublicSession';
import {safeUrl} from './model';
import {RadarScope} from './RadarScope';

const symbols:Record<string,string>={radar:'M24 24l11-11M24 9v4M9 24h4M24 35v4M35 24h4',signal:'M9 24h7l4-9 7 18 4-9h8',clock:'M24 14v11l7 4',check:'m16 24 5 5 11-12',progress:'M37 19a14 14 0 0 0-24-4l-4 5m0-8v8h8M11 29a14 14 0 0 0 24 4l4-5m0 8v-8h-8',calendar:'M17 8v8M31 8v8M10 22h28m-20 7h4m5 0h4',cancel:'m18 18 12 12m0-12L18 30'};
export function ResetStateCardView({card}:{card:ResetStateCard}) {
  const href=card.eventId?`/events/${encodeURIComponent(card.eventId)}?version=${encodeURIComponent(card.publicationId)}`:'/news?category=reset';
  return <article className={`pub-reset-state pub-reset-orbit tone-${card.tone}`} data-state={card.state} aria-label={card.title}>
    <div className="pub-reset-orbit-body">
      <RadarScope state={card.state} kind={card.kind}>
        {card.metric?<>
          <h2 className="pub-orbit-label">{card.metricLabel}</h2>
          <div className={`pub-orbit-digits${card.clockParts.length===3?' with-days':''}${card.clockLong?' is-long':''}`} role="img" aria-label={card.metric}>
            {card.clockParts.length?card.clockParts.map((part,index)=><Fragment key={part.unit}>{index>0&&<span className="pub-orbit-colon" aria-hidden="true">:</span>}<span className="pub-orbit-part" aria-hidden="true"><strong>{part.value}</strong><small>{part.unit}</small></span></Fragment>):<strong className="pub-orbit-minute">{card.metric}</strong>}
          </div>
        </>:<>
          {card.window&&<span className="pub-orbit-label">信号发布时预计</span>}
          <h2 className="pub-orbit-title">{card.window||card.dialTitle}</h2>
          <p className="pub-orbit-description">{card.description}</p>
        </>}
        <p className="pub-orbit-status" aria-label={`当前状态：${card.badge}`}>{card.dialStatus}</p>
      </RadarScope>
      {card.observationPublicationId&&<aside className="pub-orbit-observation" aria-label="独立第三方重置观测">
        <div className="pub-orbit-observation-heading"><strong>第三方重置观测</strong><span>独立记录</span></div>
        <p className="pub-orbit-observation-time"><time dateTime={card.observationAt}>{card.observationTime}</time> <small>北京时间</small></p>
        <p className="pub-orbit-observation-source">{card.observationSourceName} · 第三方观测</p>
        <Link scroll={false} href={`/events/${encodeURIComponent(card.observationEventId)}?version=${encodeURIComponent(card.observationPublicationId)}`}>查看观测依据 ↗</Link>
      </aside>}
      {card.expectedElapsed&&<p className="pub-orbit-elapsed">{card.expectedElapsed}</p>}
      {card.timeAt?<div className="pub-orbit-schedule"><div><span>{card.timeLabel}</span><time dateTime={card.timeAt}>{card.dateText||card.time}</time></div>{card.clockText&&<div className="pub-orbit-time"><span>北京时间</span><strong>{card.clockText}<small>{card.timeQualifier}</small></strong></div>}</div>:<p className="pub-orbit-waiting">收到明确预告后，将在这里展示时间。</p>}
      {card.oldTime&&<del className="pub-orbit-old">{card.oldTime} · 北京时间</del>}
    </div>
    <div className="pub-reset-state-footer"><span>{card.state==='estimated'&&card.metric?card.watchNote:card.metric?'预计安排，以实际发放为准':card.window?'不是承诺发放时间 · '+card.footer:card.footer}</span>{card.sourceName?<details className="pub-reset-state-source"><summary>{card.action} →</summary><div><p>来源：{card.sourceName}{card.sourceType==='observed'?' · 观察记录':''}</p>{card.watchNote&&<p>{card.watchNote}</p>}{card.sourceUrl&&safeUrl(card.sourceUrl)?<a href={card.sourceUrl} target="_blank" rel="noopener noreferrer">查看来源原文 ↗</a>:<p>此观察记录没有公开原文链接。</p>}</div></details>:<Link scroll={false} href={href}>{card.action} →</Link>}</div>
  </article>;
}
export function ResetStateCards({data}:{data:PublicData}) {
  const now=usePublicClock(data.serverTime);
  const {primary:card,secondary,untyped}=homeResetStatus(data,now);
  const destination=(item:typeof card)=>{
    if(item.observationSummaryDate)return '/history?date='+encodeURIComponent(item.observationSummaryDate);
    const publicationId=item.timingPublicationId||item.publicationId;
    if(publicationId&&item.eventId)return '/events/'+encodeURIComponent(item.eventId)+'?version='+encodeURIComponent(publicationId);
    return safeUrl(item.sourceUrl)||'/history';
  };
  return <section aria-label="重置动态">
    <article className={`radar-panel is-live kind-${card.kind}`}>
      <header className="radar-mast"><strong className="radar-name"><i aria-hidden="true" className="radar-mark"/>{card.kind==='banked_reset'?'重置卡发放':'额度重置'}</strong>{card.hero.badge&&<span className="radar-basis">{card.hero.badge}</span>}</header>
      {card.roundNotice&&<div className="pub-orbit-round-note"><strong>{card.roundNotice.label}</strong>{card.roundNotice.basis&&<small>{card.roundNotice.basis}</small>}{safeUrl(card.roundNotice.sourceUrl)&&<a href={card.roundNotice.sourceUrl} target="_blank" rel="noopener noreferrer">查看取消原文 ↗</a>}</div>}
      <div className="radar-field">
        <div className="signal-art" aria-hidden="true">
          <div className="signal-wing signal-wing-left"><img className="signal-fold" src="/skin/signal-fold.png" width="615" height="368" alt=""/></div>
          <div className="signal-wing signal-wing-right"><img className="signal-fold" src="/skin/signal-fold.png" width="615" height="368" alt=""/></div>
        </div>
        <div className="radar-readout">
        {(card.hero.metric||card.hero.label)&&<div className="radar-caption"><span className="radar-caption-text">{card.hero.metric&&(card.state!=='estimated'||card.metricLabel==='距推测窗口结束')?(card.hero.captionTitle||card.hero.title||card.hero.label):card.hero.label}</span></div>}
        {card.hero.timeParts.length?<div className="radar-duration" aria-label={card.hero.metric}>
          <div className="radar-calendar" aria-hidden="true">{card.hero.calendarParts.map((part:{unit:string,value:string})=><span className="radar-calendar-part" key={part.unit}><span className="radar-calendar-value">{part.value}</span><span className="radar-calendar-unit">{part.unit}</span></span>)}</div>
          <div className="radar-time" aria-hidden="true">{card.hero.timeParts.map((part:{unit:string,value:string},index:number)=><Fragment key={part.unit}>{index>0&&<span className="radar-colon">:</span>}<span className={`radar-time-part ${part.unit==='秒'?'seconds':''}`}><span className="radar-digits">{part.value.split('').map((digit:string,i:number)=><span key={i} className="radar-digit">{digit}</span>)}</span><small className="radar-unit">{part.unit}</small></span></Fragment>)}</div>
        </div>:<strong className="radar-verdict">{card.hero.metric||card.hero.title}</strong>}
      </div></div>
      {card.timeAt&&<div className="pub-focus-fact"><span>{card.timeLabel} · 北京时间</span><strong>{card.time}</strong></div>}
      {card.oldTime&&<div className="pub-focus-fact">{card.oldTime}</div>}
      {card.observationPublicationId&&<Link className="pub-focus-link" href={'/events/'+encodeURIComponent(card.observationEventId||data.publications.find(p=>p.id===card.observationPublicationId)?.eventId||card.eventId)+'?version='+encodeURIComponent(card.observationPublicationId)}>查看独立观测 · {card.observationTime}</Link>}
      <div className="pub-focus-fact pub-focus-source"><span>消息依据</span><Link className="pub-focus-link" href={destination(card)}>{card.action} →</Link></div>
      {card.parentSourceUrl&&safeUrl(card.parentSourceUrl)&&<Link className="pub-focus-link" href={card.parentSourceUrl}>查看父帖依据 ↗</Link>}
      {secondary&&<Link className="radar-secondary" href={destination(secondary)}><span>{secondary.kind==='banked_reset'?'重置卡发放':'额度重置'} · {secondary.roundNotice?.label||[secondary.hero.badge,secondary.time].filter(Boolean).join(' ')}</span><span>→</span></Link>}
    </article>
    {untyped&&<aside className="pub-reset-untyped"><strong>{untyped.title}</strong><p>{untyped.description}</p>{safeUrl(untyped.sourceUrl)&&<a href={untyped.sourceUrl} target="_blank" rel="noopener noreferrer">{untyped.action} ↗</a>}</aside>}
  </section>;
}

export function LastResetElapsed({data,selectedKind='automatic_reset'}:{data:PublicData;selectedKind?:'automatic_reset'|'banked_reset'}) {
  const now=usePublicClock(data.serverTime),model=resetStateCards(data,now),banked=selectedKind==='banked_reset';
  const record=banked?model.lastCard:model.lastReset;
  return <section className="pub-last-reset" aria-labelledby="last-reset-heading">
    <div className="pub-last-reset-heading">
      <span className="pub-last-reset-icon" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="24" cy="24" r="16"/><path d={symbols.clock}/></svg></span>
      <h2 id="last-reset-heading" aria-label={record?.sourceType==='observed'?'距最近重置观测已经过去':banked?'上次重置卡发放已经过去':'上次额度重置已经过去'}>{record?.sourceType==='observed'?'最近重置观测':banked?'上次重置卡发放':'上次额度重置'}</h2><span className="pub-last-reset-caption">已经过去</span>
    </div>
    {record ? <>
      <div className="pub-last-reset-value" aria-label={record.elapsed}>
        {[{value:record.days,unit:'天',days:true},{value:record.hours,unit:'小时'},{value:record.minutes,unit:'分钟'},{value:record.seconds,unit:'秒'}].map(part=><span key={part.unit} className={`pub-last-reset-part${part.days?' pub-last-reset-days':''}${part.days&&record.days>=1000?' is-long':part.days&&record.days>=100?' is-medium':''}`} aria-hidden="true"><strong>{part.value}</strong><span>{part.unit}</span></span>)}
      </div>
      <div className="pub-last-reset-record">
        <p className="pub-last-reset-time"><span>{record.sourceType==='observed'?'来源观测时间':banked?'上次发放时间':'上次重置时间'}</span><span className="pub-last-reset-date"><time dateTime={record.statementAt}>{record.displayTime}</time><small>北京时间</small></span></p>
        <div className="pub-last-reset-footer">
          <p className="pub-last-reset-basis">{record.sourceType==='observed'?`${record.sourceName} · 第三方观测`:banked?'依据公开发放完成消息记录':'依据公开完成消息记录'}</p>
          <Link scroll={false} href={`/events/${encodeURIComponent(record.eventId)}?version=${encodeURIComponent(record.publicationId)}`} className="pub-last-reset-link" aria-label={banked?'查看这次发卡记录':'查看这次重置记录'}>查看记录 <span aria-hidden="true">↗</span></Link>
        </div>
      </div>
    </> : <><p className="pub-last-reset-empty">暂无已确认记录</p><p className="pub-last-reset-basis">收到公开完成记录后开始计时</p></>}
  </section>;
}

export function ResetStatePending({failed=false,busy=false,onRetry}:{failed?:boolean;busy?:boolean;onRetry:()=>void}) {
  return <section className="pub-reset-state tone-slate" role={failed?'alert':'status'} aria-label="公开动态读取状态"><div className="pub-reset-state-body"><div className="pub-reset-state-meta"><span>公开动态追踪</span><span className="pub-reset-state-badge">{failed?'连接异常':'读取中'}</span></div><div className="pub-reset-state-heading"><h2>{failed?'暂时无法获取动态':'正在获取公开动态'}</h2></div><p className="pub-reset-state-description">{failed?'暂时无法加载消息，请检查网络后重试。':'正在读取公开消息和已确认记录。'}</p>{!failed&&<div className="pub-page-loading"><span className="pub-loading-bar" aria-hidden="true"/></div>}</div><div className="pub-reset-state-footer"><span>{failed?'暂不能判断是否出现新消息':'读取完成后显示来源'}</span>{failed&&<button className="pub-text-button" onClick={onRetry} disabled={busy}>{busy?'正在重试…':'重新获取 →'}</button>}</div></section>;
}
