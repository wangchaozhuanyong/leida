'use client';
import {Fragment,useState} from 'react';
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
      {card.timeAt?<div className="pub-orbit-schedule"><div><span>{card.timeLabel}</span><time dateTime={card.timeAt}>{card.dateText||card.time}</time></div>{card.clockText&&<div className="pub-orbit-time"><span>北京时间</span><strong>{card.clockText}<small>{card.timeQualifier}</small></strong></div>}</div>:<p className="pub-orbit-waiting">收到明确预告后，将在这里展示时间。</p>}
      {card.oldTime&&<del className="pub-orbit-old">{card.oldTime} · 北京时间</del>}
    </div>
    <div className="pub-reset-state-footer"><span>{card.metric?'预计安排，以实际发放为准':card.window?'不是承诺发放时间 · '+card.footer:card.footer}</span>{card.sourceName?<details className="pub-reset-state-source"><summary>{card.action} →</summary><div><p>来源：{card.sourceName}{card.sourceType==='observed'?' · 观察记录':''}</p>{card.watchNote&&<p>{card.watchNote}</p>}{card.sourceUrl&&safeUrl(card.sourceUrl)?<a href={card.sourceUrl} target="_blank" rel="noopener noreferrer">查看来源原文 ↗</a>:<p>此观察记录没有公开原文链接。</p>}</div></details>:<Link scroll={false} href={href}>{card.action} →</Link>}</div>
  </article>;
}
export function ResetStateCards({data,selectedKind,onKindChange}:{data:PublicData;selectedKind?:'automatic_reset'|'banked_reset';onKindChange?:(kind:'automatic_reset'|'banked_reset')=>void}) {
  const now=usePublicClock(data.serverTime),model=resetStateCards(data,now);
  const [localKind,setLocalKind]=useState('automatic_reset');
  const selected=selectedKind??localKind;
  const setSelected=(kind:'automatic_reset'|'banked_reset')=>{setLocalKind(kind);onKindChange?.(kind);};
  const card=model.cards.find(item=>item.kind===selected)!;
  return <section className="pub-reset-states" aria-label="额度重置和重置卡进展">
    <div className="pub-reset-tabs" role="tablist" aria-label="重置类型">{model.cards.map(item=><button type="button" key={item.kind} id={`reset-tab-${item.kind}`} role="tab" aria-selected={item.kind===selected} tabIndex={item.kind===selected?0:-1} aria-controls="reset-state-panel" onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const kind=event.key==='Home'?'automatic_reset':event.key==='End'?'banked_reset':selected==='automatic_reset'?'banked_reset':'automatic_reset';setSelected(kind);document.getElementById(`reset-tab-${kind}`)?.focus();}}} onClick={()=>setSelected(item.kind as 'automatic_reset'|'banked_reset')}><img src={`/icons/${item.kind==='banked_reset'?'card':'reset'}.svg`} width="24" height="24" alt=""/><span className="pub-reset-tab-copy"><strong>{item.kind==='banked_reset'?'重置卡发放':item.name}</strong></span></button>)}</div>
    {model.sourceWarning&&<p className="pub-reset-source-warning" role="status">{model.sourceWarning}</p>}
    <div id="reset-state-panel" role="tabpanel" aria-labelledby={`reset-tab-${selected}`}><ResetStateCardView card={card}/></div>
    {model.untyped&&<div className="pub-reset-untyped"><p>类型暂未明确的公开线索</p><ResetStateCardView card={model.untyped}/></div>}
    {model.expiredNote&&<p className="pub-reset-expired">{model.expiredNote}</p>}
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
          <p className="pub-last-reset-basis">{record.sourceType==='observed'?`${record.sourceName} 观测 · 个人到账未核验`:banked?'依据公开发放完成消息记录':'依据公开完成消息记录'}</p>
          <Link scroll={false} href={`/events/${encodeURIComponent(record.eventId)}?version=${encodeURIComponent(record.publicationId)}`} className="pub-last-reset-link" aria-label={banked?'查看这次发卡记录':'查看这次重置记录'}>查看记录 <span aria-hidden="true">↗</span></Link>
        </div>
      </div>
    </> : <><p className="pub-last-reset-empty">暂无已确认记录</p><p className="pub-last-reset-basis">收到公开完成记录后开始计时</p></>}
  </section>;
}

export function ResetStatePending({failed=false,busy=false,onRetry}:{failed?:boolean;busy?:boolean;onRetry:()=>void}) {
  return <section className="pub-reset-state tone-slate" role={failed?'alert':'status'} aria-label="公开动态读取状态"><div className="pub-reset-state-body"><div className="pub-reset-state-meta"><span>公开动态追踪</span><span className="pub-reset-state-badge">{failed?'连接异常':'读取中'}</span></div><div className="pub-reset-state-heading"><h2>{failed?'暂时无法获取动态':'正在获取公开动态'}</h2></div><p className="pub-reset-state-description">{failed?'当前没有可展示的缓存，连接恢复后更新。':'正在读取公开消息和已确认记录。'}</p>{!failed&&<div className="pub-page-loading"><span className="pub-loading-bar" aria-hidden="true"/></div>}</div><div className="pub-reset-state-footer"><span>{failed?'暂不能判断是否出现新消息':'读取完成后显示来源'}</span>{failed&&<button className="pub-text-button" onClick={onRetry} disabled={busy}>{busy?'正在重试…':'重新获取 →'}</button>}</div></section>;
}
