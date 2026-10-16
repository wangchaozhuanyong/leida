import Link from 'next/link';
import type {ResetCadenceForecast} from '@/lib/reset-cadence';
import {displayTime,safeUrl} from './model';
import {RESET_CADENCE_MODEL_VERSION} from '@/lib/reset-cadence';

const probability=(value:number|null)=>value!==null&&Number.isFinite(value)?`${Math.round(value*100)}%`:'暂无估计';
const validProbability=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
const validTime=(value:string|null|undefined)=>value?Date.parse(value):Number.NaN;
const windowTime=(value:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));

/** Display only a current model window; announcements and personal delivery are separate facts. */
export function ResetPrediction({forecast,now,details=false,frozen=false}:{forecast?:ResetCadenceForecast;now:string;details?:boolean;frozen?:boolean}) {
 const current=validTime(now),start=validTime(forecast?.windowStart),end=validTime(forecast?.windowEnd),expires=validTime(forecast?.validUntil);
 const expired=!!forecast&&(!Number.isFinite(current)||!Number.isFinite(expires)||expires<=current||validTime(forecast.generatedAt)>current);
 const legacy=!!forecast&&(!forecast.target||forecast.modelVersion!==RESET_CADENCE_MODEL_VERSION);
 const ended=forecast?.status==='ready'&&Number.isFinite(end)&&end<=current;
 const ready=forecast?.status==='ready'&&(!legacy||frozen)&&!expired&&!ended&&Number.isFinite(start)&&Number.isFinite(end)&&end>=start&&validProbability(forecast.p24)&&validProbability(forecast.p48)&&forecast.p24!<=forecast.p48!;
 const remaining=ready&&start<current;
 const futureStart=remaining?now:forecast?.windowStart;
 const recentError=forecast?.backtest.recent.medianAbsoluteErrorHours;
 const coarse=typeof recentError==='number'&&recentError>24;
 const state=legacy?'冻结历史模型':!forecast?'尚无记录':expired||ended?'待重新计算':forecast.status==='ready'?(ready?(coarse?'粗略估计':'历史估算'):'资料待核验'):forecast.status==='paused'?'暂停估计':forecast.status==='out_of_range'?'超出样本范围':'样本不足';
 const unavailable=!forecast?'正在读取最新预测。':expired||ended?'上一次估计已过有效时间，等待重新计算。':forecast.status==='paused'?'采集资料暂时不足以支持当前估计，预测已暂停。':forecast.status==='out_of_range'?'当前等待时间已超过历史样本支持范围，暂不提供下一次时间估计。':forecast.status==='insufficient'?'可比较的历史间隔还不足，暂不提供下一次时间估计。':'预测资料尚未完整核验，暂不提供时间估计。';
 const observations=forecast?.observations.filter(item=>forecast.trainingObservationIds.includes(item.id)).slice().sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,6)??[];
 return <section className={`pub-card pub-reset-prediction${ready?' is-ready':''}`} aria-label="历史间隔实验">
  <div className="pub-card-top"><h2>{!legacy&&forecast?.target?(forecast.target==='banked_reset'?'重置卡发放参考':'用量重置参考'):'历史间隔实验'}</h2><span className={`pub-badge${ready?' purple':''}`}>{state}</span></div>
  <p className="pub-muted">{!legacy&&forecast?.target?'按同类型、时间可核验的历史间隔估算，样本较少时作平滑处理。明确公告优先，估算不是发放承诺。':'此旧实验混合了不同公开动态，不作为当前下次重置时间；原始计算和失准记录保留供复盘。'}</p>
  {ready&&forecast&&futureStart&&forecast.windowEnd?<>
   <p className="pub-prediction-label">{remaining?'剩余估计区间':'估计时间区间'} · 北京时间</p>
   <div className="pub-prediction-window"><time dateTime={futureStart}>{windowTime(futureStart)}</time>{start===end?<span>附近</span>:<><span aria-hidden="true">—</span><time dateTime={forecast.windowEnd}>{windowTime(forecast.windowEnd)}</time></>}</div>
   <div className="pub-prediction-probabilities"><div><span>24小时内</span><strong>{probability(forecast.p24)}</strong></div><div><span>48小时内</span><strong>{probability(forecast.p48)}</strong></div></div>
   <p className="pub-muted">从本次计算时间起算。{!legacy?'概率为（窗口内次数＋2）÷（可比间隔＋4），不是已验证准确率。':'旧模型采用历史经验比例，0%不代表重置不会发生。'}</p>
   {coarse&&<p className="pub-muted">历史起点回测的近期中位误差约 {recentError.toFixed(0)} 小时，只能参考天级范围。</p>}
  </>:<p className="pub-prediction-unavailable" role="status">{unavailable}</p>}
  <p className="pub-prediction-target">估计{forecast?.target==='banked_reset'?'公开重置卡发放动态':forecast?.target==='automatic_reset'?'公开用量重置动态':'公开重置动态（旧混合模型）'}，个人额度是否到账仍需自行确认。</p>
  {forecast&&<div className="pub-prediction-meta"><span>采用 {forecast.sampleCount} 个历史间隔</span><span>更新于 <time dateTime={forecast.generatedAt}>{displayTime(forecast.generatedAt)}</time>（北京时间）</span></div>}
  {details&&forecast&&<details className="pub-prediction-details"><summary>查看计算与回测依据</summary>
   <p className="pub-muted">{forecast.explanation}</p>
   <dl className="pub-prediction-facts"><div><dt>资料截止</dt><dd><time dateTime={forecast.cutoffAt}>{displayTime(forecast.cutoffAt)}</time>（北京时间）</dd></div><div><dt>可比样本</dt><dd>{forecast.eligibleCount} 个间隔长于当前等待时间</dd></div><div><dt>历史回测</dt><dd>{forecast.backtest.tests>0?`${forecast.backtest.tests} 次，区间命中 ${forecast.backtest.hits}／${forecast.backtest.tests}`:'暂无可回放结果'}</dd></div><div><dt>中位时间误差</dt><dd>{forecast.backtest.medianAbsoluteErrorHours!==null&&Number.isFinite(forecast.backtest.medianAbsoluteErrorHours)?`${forecast.backtest.medianAbsoluteErrorHours.toFixed(1)} 小时`:'暂无可计算结果'}</dd></div>{forecast.windowStart&&forecast.windowEnd&&<div><dt>生成时区间</dt><dd>{displayTime(forecast.windowStart)} 至 {displayTime(forecast.windowEnd)}（北京时间）</dd></div>}</dl>
   <p className="pub-muted">回测从上一次动态刚发生时开始，按时间顺序只使用此前样本，再与下一条公开动态比较。这是事后资料重放，不代表当前已等待时长下的预测成绩；实际提前预测成绩仍待后续观测。</p>
   <p className="pub-muted">最近 {forecast.backtest.recent.tests} 次回测，区间命中 {forecast.backtest.recent.hits} 次；中位误差 {forecast.backtest.recent.medianAbsoluteErrorHours?.toFixed(1)??'暂无'} 小时。完整历史成绩保留在上方。</p>
   {forecast.summaryOnly&&<Link className="pub-text-link" href={`/methodology?cadence=${encodeURIComponent(forecast.id)}`}>读取完整计算与原帖依据</Link>}
   {observations.length>0&&<><h3>近期样本原帖</h3><p className="pub-muted">时间为原帖发布时间，展示最近 {observations.length} 条采用的动态。</p><ul className="pub-prediction-sources">{observations.map(item=>{const href=typeof item.url==='string'?safeUrl(item.url):undefined;return <li key={item.id}>{href?<a href={href} target="_blank" rel="noopener noreferrer"><time dateTime={item.at}>{displayTime(item.at)}</time><span>查看原帖 ↗</span></a>:<span><time dateTime={item.at}>{displayTime(item.at)}</time> · 原帖链接待补充</span>}</li>;})}</ul></>}
  </details>}
  {!details&&<Link className="pub-text-link pub-prediction-method" href="/methodology#reset-prediction">查看预测依据 <span aria-hidden="true">→</span></Link>}
 </section>;
}
