'use client';
import React, {useEffect, useState} from 'react';
import type {ResetOutlook} from '@/lib/reset-outlook';
import {announcementClock, announcementCountdown} from './model';

const point = (angle: number, radius: number) => ({x: 300 + Math.sin(angle * Math.PI / 180) * radius, y: 300 - Math.cos(angle * Math.PI / 180) * radius});
const timeLabel = (at: string) => new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(at));

/** A 24-hour Beijing clock face; the centre is remaining time, never a fabricated forecast. */
export function InstrumentDial({outlook, serverTime}: {outlook: ResetOutlook; serverTime: string}) {
  const [clock, setClock] = useState({serverTime, elapsed: 0});
  useEffect(() => {
    const start = performance.now(), tick = () => setClock({serverTime, elapsed: performance.now() - start});
    tick(); const timer = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {clearInterval(timer); document.removeEventListener('visibilitychange', tick);};
  }, [serverTime]);
  const now = announcementClock(serverTime, clock.serverTime === serverTime ? clock.elapsed : 0);
  const active = outlook.active, countdown = active ? announcementCountdown(active, now) : undefined;
  const scheduled = countdown?.status === 'upcoming';
  const remaining = scheduled ? Math.ceil((Date.parse(active!.expectedAt!) - Date.parse(now)) / 60000) : 0;
  const digits = scheduled ? `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}` : undefined;
  const angle = (at: string) => {const [h,m] = timeLabel(at).split(':').map(Number); return (h + m / 60) * 15;};
  const currentAngle = angle(now), endAngle = scheduled ? angle(active!.expectedAt!) : currentAngle;
  const marker = point(endAngle, 255), start = point(currentAngle, 255);
  const sweep = Math.min(359.9, remaining / 4), arcEnd = point(currentAngle + sweep, 255);
  const state = countdown?.status === 'expired' ? '等待确认' : active ? active.stage === 'in_progress' ? '重置进行中' : '时间待明确' : '等待预告';
  const lead = scheduled ? /^原文近似时间/.test(active?.timeNote ?? '') ? '预计约' : /^原文预计时刻/.test(active?.timeNote ?? '') ? '预计剩余' : '距离预计最晚时间' : outlook.status === 'cancelled' ? '上轮安排已取消' : '公开动态追踪';
  return <section className={`pub-instrument-dial ${scheduled ? 'is-scheduled' : 'is-waiting'}`} aria-label={scheduled ? `公开预告：${countdown.label}，北京时间${timeLabel(active!.expectedAt!)}` : `重置雷达：${state}`}>
    <h1 className="pub-visually-hidden">重置雷达</h1>
    <svg className="pub-dial-face" viewBox="0 0 600 600" aria-hidden="true">
      <defs><radialGradient id="dial-light"><stop stopColor="#242820"/><stop offset="1" stopColor="#0c1214"/></radialGradient><linearGradient id="dial-gold"><stop stopColor="#ffe197"/><stop offset="1" stopColor="#e6ac3c"/></linearGradient></defs>
      <circle cx="300" cy="300" r="283" className="pub-dial-orbit"/><circle cx="300" cy="300" r="271" className="pub-dial-orbit"/>
      <circle cx="300" cy="300" r="255" fill="url(#dial-light)" className="pub-dial-rim"/>
      {scheduled && <path d={`M${start.x} ${start.y} A255 255 0 ${sweep>180?1:0} 1 ${arcEnd.x} ${arcEnd.y}`} className="pub-dial-arc"/>}
      {Array.from({length: 240}, (_, i) => {const a=point(i*1.5,254),b=point(i*1.5,i%20===0?231:i%5===0?242:248);return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={i%20===0?'pub-dial-tick major':'pub-dial-tick'}/>;})}
      <circle cx="300" cy="300" r="204" className="pub-dial-inner"/>
      {[['00',0],['06',90],['12',180],['18',270]].map(([label,a])=>{const p=point(Number(a),219);return <text key={label} x={p.x} y={p.y+6} textAnchor="middle" className="pub-dial-hour">{label}</text>;})}
      {[0,90,180,270].map(a=>{const p=point(a,266),q=point(a,290);return <line key={a} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="pub-dial-axis"/>;})}
      {scheduled && <><circle cx={marker.x} cy={marker.y} r="16" fill="#f4bf5522"/><circle cx={marker.x} cy={marker.y} r="6" fill="#ffc85a"/><g transform={`translate(${Math.max(8,Math.min(486,marker.x-52))},${Math.max(6,marker.y-37)})`}><rect width="106" height="27" rx="13.5" fill="#f4c15c"/><text x="53" y="19" fill="#111719" fontSize="14" textAnchor="middle">预计 {timeLabel(active!.expectedAt!)}</text></g></>}
    </svg>
    <div className="pub-dial-readout"><p>{lead}</p>{digits ? <strong className={digits.length>5?'long':''}>{digits}</strong> : <strong className="pub-dial-state">{state}</strong>}<span>{scheduled ? '小时 : 分钟' : countdown?.status==='expired'?'已过预计时间，待公开确认':active?'有明确安排后，自动更新':'暂无下一次明确时间'}</span></div>
    <div className="pub-dial-caption"><small>24 小时表盘 · 北京时间</small></div>
  </section>;
}
