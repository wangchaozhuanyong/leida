'use client';
import {useState} from 'react';
import Link from 'next/link';
import type {PublicData} from '@/lib/types';
import {resetStateCards,type ResetStateCard} from '@/lib/reset-state-cards';
import {usePublicClock} from './PublicSession';
import {safeUrl} from './model';

const symbols:Record<string,string>={radar:'M24 24l11-11M24 9v4M9 24h4M24 35v4M35 24h4',signal:'M9 24h7l4-9 7 18 4-9h8',clock:'M24 14v11l7 4',check:'m16 24 5 5 11-12',progress:'M37 19a14 14 0 0 0-24-4l-4 5m0-8v8h8M11 29a14 14 0 0 0 24 4l4-5m0 8v-8h-8',calendar:'M17 8v8M31 8v8M10 22h28m-20 7h4m5 0h4',cancel:'m18 18 12 12m0-12L18 30'};
export function ResetStateCardView({card}:{card:ResetStateCard}) {
  const href=card.eventId?`/events/${encodeURIComponent(card.eventId)}?version=${encodeURIComponent(card.publicationId)}`:'/news?category=reset';
  return <article className={`pub-reset-state tone-${card.tone}`} data-state={card.state} aria-label={card.title}>
    <div className="pub-reset-state-body">
      <div className="pub-reset-state-meta"><span>{card.evidence}</span><span className="pub-reset-state-badge">{card.badge}</span></div>
      <div className="pub-reset-state-heading"><h2>{card.title}</h2><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{!['signal','progress','calendar'].includes(card.icon)&&<circle cx="24" cy="24" r="15"/>}{card.icon==='radar'&&<circle cx="24" cy="24" r="8"/>}{card.icon==='calendar'&&<rect x="10" y="12" width="28" height="28" rx="5"/>}<path d={symbols[card.icon]}/></svg></div>
      <p className="pub-reset-state-description">{card.description}</p>
      {card.window&&<div className="pub-reset-state-window"><span>信号发布时预计</span><strong>{card.window}</strong><small>不是承诺发放时间</small></div>}
      {card.metric&&<div className="pub-reset-state-metric"><span>{card.metricLabel}</span><strong>{card.metric}</strong></div>}
      <div className="pub-reset-state-fact"><div><span>{card.timeLabel}</span><time dateTime={card.timeAt||undefined}>{card.time}</time>{card.oldTime&&<del>{card.oldTime}</del>}</div>{card.timeAt&&<small>北京时间</small>}</div>
    </div>
    <div className="pub-reset-state-footer"><span>{card.footer}</span>{card.sourceName?<details className="pub-reset-state-source"><summary>{card.action} →</summary><div><p>来源：{card.sourceName}{card.sourceType==='observed'?' · 观察记录':''}</p>{card.watchNote&&<p>{card.watchNote}</p>}{card.sourceUrl&&safeUrl(card.sourceUrl)?<a href={card.sourceUrl} target="_blank" rel="noopener noreferrer">查看来源原文 ↗</a>:<p>此观察记录没有公开原文链接。</p>}</div></details>:<Link scroll={false} href={href}>{card.action} →</Link>}</div>
  </article>;
}
export function ResetStateCards({data,selectedKind,onKindChange}:{data:PublicData;selectedKind?:'automatic_reset'|'banked_reset';onKindChange?:(kind:'automatic_reset'|'banked_reset')=>void}) {
  const now=usePublicClock(data.serverTime),model=resetStateCards(data,now);
  const [localKind,setLocalKind]=useState('automatic_reset');
  const selected=selectedKind??localKind;
  const setSelected=(kind:'automatic_reset'|'banked_reset')=>{setLocalKind(kind);onKindChange?.(kind);};
  const card=model.cards.find(item=>item.kind===selected)!;
  return <section className="pub-reset-states" aria-label="额度重置和重置卡进展">
    <div className="pub-reset-tabs" role="tablist" aria-label="重置类型">{model.cards.map(item=><button type="button" key={item.kind} id={`reset-tab-${item.kind}`} role="tab" aria-selected={item.kind===selected} tabIndex={item.kind===selected?0:-1} aria-controls="reset-state-panel" onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const kind=event.key==='Home'?'automatic_reset':event.key==='End'?'banked_reset':selected==='automatic_reset'?'banked_reset':'automatic_reset';setSelected(kind);document.getElementById(`reset-tab-${kind}`)?.focus();}}} onClick={()=>setSelected(item.kind as 'automatic_reset'|'banked_reset')}><span>{item.name}</span><small>{item.badge}</small></button>)}</div>
    {model.sourceWarning&&<p className="pub-reset-source-warning" role="status">{model.sourceWarning}</p>}
    <div id="reset-state-panel" role="tabpanel" aria-labelledby={`reset-tab-${selected}`}><ResetStateCardView card={card}/></div>
    {model.untyped&&<div className="pub-reset-untyped"><p>类型暂未明确的公开线索</p><ResetStateCardView card={model.untyped}/></div>}
    {model.expiredNote&&<p className="pub-reset-expired">{model.expiredNote}</p>}
    {(model.lastReset||model.lastCard)&&<aside className="pub-reset-last-facts">{model.lastReset&&<><div><span>上次额度重置</span><time dateTime={model.lastReset.statementAt}>{model.lastReset.time} · 北京时间</time></div><p aria-label="距上次额度重置已过去">{model.lastReset.elapsed}<small>已过去</small></p></>}{model.lastCard&&<div className="pub-reset-last-card"><span>上次发放重置卡</span><time dateTime={model.lastCard.statementAt}>{model.lastCard.time} · 北京时间</time></div>}</aside>}
  </section>;
}

export function ResetStatePending({failed=false,busy=false,onRetry}:{failed?:boolean;busy?:boolean;onRetry:()=>void}) {
  return <section className="pub-reset-state tone-slate" role={failed?'alert':'status'} aria-label="公开动态读取状态"><div className="pub-reset-state-body"><div className="pub-reset-state-meta"><span>公开动态追踪</span><span className="pub-reset-state-badge">{failed?'连接异常':'读取中'}</span></div><div className="pub-reset-state-heading"><h2>{failed?'暂时无法获取动态':'正在获取公开动态'}</h2></div><p className="pub-reset-state-description">{failed?'当前没有可展示的缓存，连接恢复后更新。':'正在读取公开消息和已确认记录。'}</p>{!failed&&<div className="pub-page-loading"><span className="pub-loading-bar" aria-hidden="true"/></div>}</div><div className="pub-reset-state-footer"><span>{failed?'暂不能判断是否出现新消息':'读取完成后显示来源'}</span>{failed&&<button className="pub-text-button" onClick={onRetry} disabled={busy}>{busy?'正在重试…':'重新获取 →'}</button>}</div></section>;
}
