'use client';
import Link from 'next/link';
import {useFixedSnapshot} from './useFixedSnapshot';
import type {ForecastPublicData,ForecastSnapshot,ForecastCaseView} from '@/lib/forecast';
import {forecastBasisText,forecastStatusText,forecastValueText,intervalText,probabilityText} from '@/lib/forecast-display';
import {displayTime,safeUrl} from './model';
import {CadencePanel} from './CadencePanel';
import {ResetOutlookPanel} from './ResetOutlookPanel';

function Snapshot({snapshot,onPoster,onShare,disabled=false}:{snapshot:ForecastSnapshot;disabled?:boolean;onPoster:(s:ForecastSnapshot)=>void;onShare:(s:ForecastSnapshot)=>Promise<void>}) {
 return <section className="pub-card"><div className="pub-card-top"><h2>{snapshot.target==='banked_reset'?'重置卡':'用量重置'}实验快照</h2><span className="pub-badge purple">{forecastBasisText(snapshot.basis)}</span></div>
  <p>{snapshot.title}</p><p className="pub-muted">这是生成时的固定预测，后续公告不会重写这组概率。</p>
  <div className="pub-source-row"><div><strong>24小时内出现对应公开公告</strong><span>窗口截至：{displayTime(snapshot.windows[24])}</span></div><strong>{forecastValueText(snapshot,24)}</strong></div>
  <div className="pub-source-row"><div><strong>48小时内出现对应公开公告</strong><span>窗口截至：{displayTime(snapshot.windows[48])}</span></div><strong>{forecastValueText(snapshot,48)}</strong></div>
  <p>首次信号：{displayTime(snapshot.signalAt)}<br/>生成时间：{displayTime(snapshot.generatedAt)}<br/>证据截至：{displayTime(snapshot.evidenceCutoffAt)}</p>
  <p className="pub-muted">样本{snapshot.sampleCount}例 · 24小时区间{intervalText(snapshot.interval24)} · 48小时区间{intervalText(snapshot.interval48)}</p>
  <p>{snapshot.explanation}</p><p className="pub-muted">预测目标是公开公告，分别记录预告、进行中和完成；个人到账未观测。来源连续覆盖{snapshot.coverage.status==='verified'?'已核验':'未核验'}，概率和区间均不代表准确率。</p>
  {safeUrl(snapshot.url)&&<a className="pub-text-link" href={safeUrl(snapshot.url)!} target="_blank" rel="noopener noreferrer">查看首次信号来源</a>}
  <details><summary>查看实验计算依据</summary><p className="pub-prose">规则批次：{snapshot.ruleVersion.match(/\d{8}-\d+$/)?.[0]||'固定版本'}<br/>模型：历史样本实验<br/>已采用的历史参考：{snapshot.referenceSampleIds.length}例<br/>实时结局观察：{snapshot.trainingSampleIds.length}条，尚未用于概率训练</p></details>
  <div className="pub-share-row"><button className="pub-button" disabled={disabled} onClick={()=>void onShare(snapshot)}>转发此快照</button><button className="pub-button" disabled={disabled} onClick={()=>onPoster(snapshot)}>生成实验海报</button></div>
 </section>;
}

function OutcomeRecords({item,available}:{item:ForecastCaseView|undefined;available:boolean}) {
 const labels={promised:'公开预告',in_progress:'公开进行中声明',claimed_complete:'公开完成声明',cancelled:'取消或更正',unknown:'结局未知'};
 return <section className="pub-card"><h2>后续结局</h2><p className="pub-muted">独立记录后续公告，保留原预测。个人到账未观测。</p>{!available?<p>后续记录暂时不可用，不能据此判断没有公告。</p>:!item?.outcomes.length?<p>尚无可明确对应的公告，不代表没有发放。</p>:item.outcomes.map(o=>{
  const hours=o.announcementAt?(Date.parse(o.announcementAt)-Date.parse(item.signalAt))/3600000:undefined;
  const window=o.invalidated?'关联内容已撤回':hours===undefined?'缺少可核验结局':hours<=24?'首次信号24小时内':hours<=48?'首次信号24至48小时':'48小时窗口外公告';
  return <div className="pub-source-row" key={o.id}><div><strong>{labels[o.stage]} · {window}</strong>{o.announcementAt&&<span>公告时间：{displayTime(o.announcementAt)}</span>}<span>观测时间：{displayTime(o.observedAt)}</span><span>{o.reason}</span></div></div>;
 })}</section>;
}

export function ForecastPanel({data,snapshotId,cadenceId,target='automatic_reset',onPoster,onShare}:{data:ForecastPublicData|undefined;snapshotId:string|null;cadenceId?:string|null;target?:'automatic_reset'|'banked_reset';onPoster:(s:ForecastSnapshot)=>void;onShare:(s:ForecastSnapshot)=>Promise<void>}) {
 const fixed = useFixedSnapshot<ForecastSnapshot>(snapshotId && !cadenceId ? `/api/v1/forecasts/${encodeURIComponent(snapshotId)}` : null, cadenceId ? null : snapshotId);
 if(cadenceId)return <CadencePanel data={data} selectedId={cadenceId}/>;
 if(snapshotId){
  if(!fixed.value && !fixed.error)return <div className="pub-page-loading" role="status"><span className="pub-loading-ring" aria-hidden="true"/><span>加载中</span></div>;
  if(!fixed.value)return <section className="pub-card" role="alert"><h2>预测快照暂时不可用</h2><p>{fixed.error}</p><button className="pub-button" disabled={fixed.loading} onClick={fixed.retry}>重新加载</button><Link scroll={false} className="pub-text-link" href="/methodology">查看其他记录</Link></section>;
  return <><Snapshot snapshot={fixed.value} onPoster={onPoster} onShare={onShare} disabled={!!fixed.error || fixed.loading}/>{fixed.error && <p className="pub-warning" role="alert">{fixed.error}<button onClick={fixed.retry}>重新检查</button></p>}<OutcomeRecords item={data?.cases.find(c=>c.id===fixed.value?.caseId)} available={data?.status==='ready'&&data.cases.some(c=>c.id===fixed.value?.caseId)}/><Link scroll={false} className="pub-text-link" href="/methodology">查看全部实验观察</Link></>;
 }
 const reference=data?.reference;
 return <>
  {data?.outlook&&<div id="reset-prediction"><ResetOutlookPanel outlook={data.outlook} serverTime={data.generatedAt} details/></div>}
  <details className="pub-card" id="cadence-prediction"><summary>历史间隔实验（不用于当前预测）</summary><p className="pub-muted">这里只保留历史统计与回测。没有新的有效信号时，首页保持等待，不用历史间隔推算下一次日期。</p><CadencePanel key={target} data={data} initialTarget={target}/></details>
  <details className="pub-card"><summary>额度异常观察（辅助模型）</summary>
  <section className="pub-card"><h2>实验预测如何计算</h2><p>仅将明确的用量异常信号加入观察，固定首次信号后的24／48小时。明确公告优先；普通故障和故障恢复不会变成发卡预告。</p>
   {reference?<><p>历史参考{reference.sampleCount}例：24小时{probabilityText(reference.p24)}，48小时{probabilityText(reference.p48)}；48小时95%可信区间{intervalText(reference.interval48)}。</p><p className="pub-muted">{reference.note}</p><details><summary>查看实验计算方式</summary><p>三个历史案例中，24小时内出现公告1例、24至48小时出现2例。加入固定先验[0.5，0.5，1]后计算窗口概率和95%可信区间。历史样本未完成连续覆盖核验及前瞻校准。</p></details></>:<p className="pub-muted">实验资料暂时不可用。</p>}
   <p>以上历史参考不会单独作为首页下次发放预测。重置卡没有可比样本时不生成概率；晚采、缺口和无法对应的结局保留为未知。</p>
  </section>
  <section className="pub-card"><h2>自动观察记录</h2>{data?.status!=='ready'?<p className="pub-muted">{data?.reason||'观察服务尚未接入'}</p>:!data.cases.length?<p className="pub-muted">暂无符合规则的异常信号，有新的明确异常后自动建立观察。</p>:data.cases.map(c=><div className="pub-source-row" key={c.id}><div><strong>{c.target==='banked_reset'?'重置卡':'用量重置'} · {forecastStatusText(c.status)}</strong><span>首次信号：{displayTime(c.signalAt)}</span><span>48小时截至：{displayTime(c.windows[48])}</span><span>{c.outcomes.length?`已记录${c.outcomes.length}条结局`:'尚无可对应公告，个人到账未观测'}</span></div>{c.snapshot?<Link scroll={false} className="pub-text-link" href={`/methodology?snapshot=${encodeURIComponent(c.snapshot.id)}`}>查看固定快照</Link>:<span className="pub-muted">待生成</span>}</div>)}</section>
 </details></>;
}
