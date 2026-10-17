'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import type { PublicData } from '@/lib/types';
import { recordCalendar } from '../../../miniprogram/utils/record-calendar';
import type { HistoryFilter } from './public-navigation';

export const recordKinds: [HistoryFilter, string][] = [['all', '全部'], ['automatic_reset', '额度重置'], ['banked_reset', '重置卡']];
export function RecordKindFilter({ value, onChange, counts }: { value: HistoryFilter; onChange: (value: HistoryFilter) => void; counts?: Record<HistoryFilter, number> }) {
  return <div className="pub-record-kinds" role="group" aria-label="重置类型">{recordKinds.map(([key, label]) => <button key={key} aria-pressed={value === key} className={value === key ? 'active' : ''} onClick={() => onChange(key)}>{key !== 'all' && <i className={`pub-record-dot ${key}`} aria-hidden="true" />}{label}{counts && <span className="pub-kind-count">{counts[key]}</span>}</button>)}</div>;
}
export function RecordCalendar({ data, date, kind, onDate, onKind }: { data: PublicData; date: string; kind: HistoryFilter; onDate: (date: string) => void; onKind: (kind: HistoryFilter) => void }) {
  const model = recordCalendar(data, { date, kind });
  useEffect(() => { if (!date) onDate(model.selected); }, [date, model.selected, onDate]);
  const selectMonth = (month: string) => onDate(recordCalendar(data, { kind, month }).selected);
  return <section className="pub-records" aria-label="近半年重置记录">
    <section className="pub-record-sheet" aria-label="重置月历">
      <div className="pub-month-calendar">
        <div className="pub-month-heading">
          <div><select aria-label="选择月份" value={model.month} onChange={event => selectMonth(event.target.value)}>{model.months.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><p>本月已收录的完成记录</p></div>
          <div className="pub-month-controls"><button aria-label="上个月" disabled={model.monthIndex === model.months.length - 1} onClick={() => selectMonth(model.months[model.monthIndex + 1].value)}>‹</button><button aria-label="下个月" disabled={model.monthIndex === 0} onClick={() => selectMonth(model.months[model.monthIndex - 1].value)}>›</button></div>
        </div>
        <RecordKindFilter value={kind} onChange={onKind} counts={{ all: model.automaticCount + model.bankedCount, automatic_reset: model.automaticCount, banked_reset: model.bankedCount }} />
        <div className="pub-month-week" aria-hidden="true">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
        <div className="pub-month-days">{model.days.map(day => day.blank ? <span key={day.date} aria-hidden="true" /> : <button key={day.date} disabled={day.disabled} aria-pressed={day.selected} aria-label={`${day.date}，${day.count}条已收录完成记录`} className={`${day.selected ? 'selected' : ''} ${day.today ? 'today' : ''}`} onClick={() => onDate(day.date)}><span>{day.day}</span><span className="pub-day-markers">{day.automatic && <i className="pub-record-dot automatic_reset" />}{day.banked && <i className="pub-record-dot banked_reset" />}</span></button>)}</div>
      </div>
      <section className="pub-record-detail" aria-label="所选日期记录" aria-live="polite">
        <div className="pub-record-heading"><h2>{model.selectedLabel}</h2><span>{model.selectedItems.length} 条记录 · 北京时间</span></div>
        {model.selectedItems.length ? model.selectedItems.map(item => <article key={item.id} data-reading-id={item.id}><Link scroll={false} className="pub-date-record" href={item.href} aria-label={`${item.title}，${item.time}，查看公告`}><span className={`pub-record-seal ${item.kind}`} aria-hidden="true">✓</span><span className="pub-record-copy"><span className="pub-record-meta"><span className={`pub-record-label ${item.kind}`}>{item.label}</span><time dateTime={item.at}>{item.time}</time></span><h3>{item.title}</h3></span><span className="pub-record-chevron" aria-hidden="true">›</span></Link></article>) : <div className="pub-date-empty"><strong>这一天暂无已收录记录</strong><p>选择有标记的日期，查看完成公告。</p>{model.recentDate && model.recentDate !== model.selected && <button onClick={() => onDate(model.recentDate)}>查看最近一次记录 →</button>}</div>}
      </section>
    </section>
    <details className="pub-record-notes"><summary><span>近半年记录</span><span>收录说明 <i aria-hidden="true">⌄</i></span></summary><p>{model.periodLabel}<br />按公开完成声明的北京时间归档。未收录记录不代表当日没有发生重置。</p></details>
  </section>;
}
