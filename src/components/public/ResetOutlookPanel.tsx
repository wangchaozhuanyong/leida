'use client';
import Link from 'next/link';
import type {ResetOutlook} from '@/lib/reset-outlook';
import {announcementCountdown,displayTime} from './model';
import {usePublicClock} from './PublicSession';

export function ResetOutlookPanel({outlook,serverTime,details=false,instrument=false}:{outlook:ResetOutlook;serverTime:string;details?:boolean;instrument?:boolean}) {
 const now=usePublicClock(serverTime),active=outlook.active;
 const countdown=active?announcementCountdown(active,now):undefined;
 const kind=active?.kind==='banked_reset'?'重置卡发放':'用量重置';
 const resolved=outlook.lastResolved;
 const badge=active?countdown?.status==='expired'?'等待确认':active.stage==='in_progress'?'进行中':'公开预告':outlook.status==='completed'?'本轮已完成':outlook.status==='cancelled'?'本轮已取消':'监测中';
 return <section className={`pub-card pub-reset-outlook${active?' is-active':''}`} aria-label="公开重置预测">
  <div className="pub-card-top"><h2>{active?`${kind} · 公开预告`:'下次重置'}</h2><span className="pub-badge cyan">{badge}</span></div>
  {active?<>
   {!instrument && <p className="pub-outlook-countdown" role="status">{countdown?.status==='unknown'?active.stage==='in_progress'?'正在重置 · 等待完成声明':'已有预告 · 时间待明确':countdown?.label}</p>}
   {countdown?.status!=='unknown'&&active.expectedAt&&<p>{/^原文近似时间/.test(active.timeNote??'')?'预计约':'预计'} <time dateTime={active.expectedAt}>{displayTime(active.expectedAt)}</time>（北京时间）</p>}
   {active.timeNote&&<p className="pub-muted">{active.timeNote}</p>}
   {!instrument && <Link scroll={false} className="pub-text-link" href={`/events/${encodeURIComponent(active.eventId)}`}>查看预告依据 →</Link>}
  </>:<>
   <p className="pub-outlook-countdown">等待下一次预告</p>
   <p className="pub-muted">{outlook.status==='completed'?'本轮重置已收到完成声明，目前没有新的重置时间依据。':outlook.status==='cancelled'?'本轮安排已取消，目前没有新的重置时间依据。':'目前没有明确的重置时间依据，有新预告后更新。'}</p>
  </>}
  {!instrument&&resolved?.announcedAt&&<details className="pub-outlook-recap" open={details||undefined}><summary>本轮预告与结果</summary>
   <dl className="pub-prediction-facts"><div><dt>预告原帖</dt><dd>{displayTime(resolved.announcedAt)}（北京时间）</dd></div>{resolved.announcedDeadline&&<div><dt>原文预计时间</dt><dd>{displayTime(resolved.announcedDeadline)}（北京时间）</dd></div>}<div><dt>{resolved.stage==='cancelled'?'取消声明':'完成声明'}</dt><dd>{displayTime(resolved.resolvedAt)}（北京时间）</dd></div></dl>
   {resolved.announcedDeadlineNote&&<p className="pub-muted">当时的预告说明（本轮现已结束）：{resolved.announcedDeadlineNote}</p>}
   <Link scroll={false} className="pub-text-link" href={`/events/${encodeURIComponent(resolved.eventId)}`}>查看同一轮的原文证据 →</Link>
  </details>}
  {!details&&!instrument&&<Link scroll={false} className="pub-text-link" href="/methodology#reset-prediction">查看判断规则 →</Link>}
 </section>;
}
