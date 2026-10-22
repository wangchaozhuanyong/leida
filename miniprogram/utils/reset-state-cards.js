/** @typedef {import('../../src/lib/types').PublicData} PublicData */
/** @typedef {import('../../src/lib/types').ActionKind} ActionKind */
/** @typedef {import('../../src/lib/reset-outlook').ResetOutlook} ResetOutlook */
const m = require('./model');
const {countdownParts} = require('./status-timeline');
const kinds = ['automatic_reset', 'banked_reset'];
const valid = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const at = value => valid(value) ? m.displayTime(value) : '';
const names = {automatic_reset:'额度重置',banked_reset:'重置卡'};
const waitingTitle = kind => kind === 'banked_reset' ? '等待下一次重置卡发放' : '等待下一次 Reset';
function base(kind) {
  return {kind, name:names[kind] || '公开线索', state:'waiting', tone:'slate', badge:'等待新消息', evidence:'公开动态追踪', title:waitingTitle(kind), description:`暂无新的${kind==='banked_reset'?'重置卡发放':'额度重置'}预告，有可靠消息后更新。`, icon:'radar', metric:'', metricLabel:'', window:'', timeLabel:'当前状态', time:'没有有效的新信号或安排', timeAt:'', oldTime:'', footer:'依据公开信息更新', action:'查看最近公告', publicationId:'', eventId:'', sourceUrl:'', sourceName:'', expiresAt:'', sourceType:'', watchNote:'',progress:/** @type {{label:string,current:boolean}[]} */([])};
}
function sourceTarget(card, round) {
  if (!round) return;
  card.publicationId=round.publicationId || ''; card.eventId=round.eventId || '';
}
/** A source URL linked to a classified public action or existing forecast case is required. */
function signalKind(data, url) {
  if(!url)return null;
  const evidenceIds=new Set(data.evidence.filter(e=>e.url===url).map(e=>e.id));
  const targets=new Set(m.publicActions(data).filter(({action})=>action.evidenceIds.some(id=>evidenceIds.has(id))).map(({action})=>action.kind));
  for(const c of data.forecasts?.cases || []) if(c.status==='watching' && c.coverage?.status==='verified' && kinds.includes(c.target) && (c.url===url || c.signalEvidenceIds.some(id=>evidenceIds.has(id))))targets.add(c.target);
  return targets.size===1 ? [...targets][0] : null;
}
/** @param {PublicData} data @param {string} now */
function resetStateCards(data, now=data.serverTime) {
  const current=Date.parse(now), forecasts=data.forecasts, outlooks=Object.fromEntries(kinds.map(kind=>[kind,m.resetOutlookModel({...data,serverTime:now},kind)]));
  // Older servers expose only one authoritative round. Preserve it while deriving the other category from public facts.
  if(forecasts?.outlook && !forecasts.outlook.byKind){
    const legacy=m.resetOutlookModel({...data,serverTime:now});
    for(const kind of kinds){
      for(const key of ['active','latestCompletion','lastResolved'])if(legacy[key]?.kind===kind)outlooks[kind][key]=legacy[key];
      if(legacy.latestResolutions?.[kind])outlooks[kind].latestResolutions={...outlooks[kind].latestResolutions,[kind]:legacy.latestResolutions[kind]};
    }
  }
  const remote=m.activeResetSchedule(forecasts?.watch,now);
  const cards=kinds.map(kind=>{
    const outlook=outlooks[kind], card=base(kind);
    let active=outlook.active;
    if(active && (!valid(active.statementAt)||Date.parse(active.statementAt)>current))active=null;
    const resolution=outlook.latestResolutions?.[kind] || outlook.lastResolved;
    // An older unmatched promise is not proof of a new round; keep it in history.
    const useRemote=remote?.kind===kind && (!resolution || Date.parse(remote.announcedAt)>Date.parse(resolution.statementAt)) && (!active || Date.parse(remote.announcedAt)>Date.parse(active.statementAt));
    if(useRemote) {active={kind,stage:'promised',statementAt:remote.announcedAt,expectedAt:remote.scheduledFor||undefined,publicationId:'',eventId:''};card.sourceUrl=remote.sourceUrl||'';card.sourceName='Codex Resets';card.sourceType=remote.sourceType||'x_post';}
    const completion=outlook.latestCompletion;
    sourceTarget(card, completion);
    if(active){
      sourceTarget(card,active);
      const timed=valid(active.expectedAt),overdue=timed&&Date.parse(active.expectedAt)<=current;
      const adjusted=valid(active.previousExpectedAt)&&Date.parse(active.previousExpectedAt)!==Date.parse(active.expectedAt);
      const timing=/(?:日终|最晚|之前|以内|截止|\bby\b|\bwithin\b)/i.test(active.timeNote||'')?'deadline':/^原文近似时间/.test(active.timeNote||'')?'approximate':'point';
      Object.assign(card,{tone:'blue',badge:'已预告',state:'announced',evidence:'公开预告',title:kind==='banked_reset'?'已预告发放重置卡':'已预告额度重置',description:'已公布相关安排，具体时间仍待说明。',icon:'calendar',timeLabel:'预告发布',time:at(active.statementAt),timeAt:active.statementAt,action:'查看预告原文'});
      if(active.stage==='in_progress')Object.assign(card,{state:'progress',tone:'teal',badge:'进行中',evidence:'公开进展消息',title:kind==='banked_reset'?'重置卡正在发放':'额度重置进行中',description:'公开消息称已开始，完成情况等待后续声明。',icon:'progress',timeLabel:'进展消息',action:'查看最新进展'});
      else if(timed){
        const metric=countdownParts(active.expectedAt,now).map(p=>p.value+p.unit).join('') || '不足1分钟';
        Object.assign(card,{state:overdue?'overdue':adjusted?'revised':'scheduled',tone:overdue?'amber':'blue',badge:overdue?'等待确认':adjusted?'安排已调整':'时间已公布',evidence:overdue?'原预告已到预计时间':'公开预告 · 有明确时间',title:overdue?'预计时间已到，待确认':adjusted?`${kind==='banked_reset'?'重置卡发放':'额度重置'}时间已更新`:kind==='banked_reset'?'预计发放重置卡':'预计额度重置',description:overdue?`尚未看到${kind==='banked_reset'?'重置卡发放':'额度重置'}完成声明，正在持续关注。`:'预计时间仅供参考，以实际发放为主。',icon:'clock',metric:overdue?'':metric,metricLabel:adjusted?'距离最新预计安排':timing==='deadline'?'距离预计最晚时间':timing==='approximate'?'距离预计时间（约）':'距离预计安排',timeLabel:overdue?'原预计安排':adjusted?'最新安排':'预计安排',time:at(active.expectedAt)+(timing==='deadline'?' 前':timing==='approximate'?' 左右':''),timeAt:active.expectedAt,oldTime:adjusted?'原预计 '+at(active.previousExpectedAt):'',footer:overdue?'停止倒计时，保留原安排':'依据公开信息更新',action:adjusted?'查看调整说明':overdue?'查看最新消息':'查看安排依据'});
      }
    }else if(resolution?.stage==='cancelled'){
      sourceTarget(card,resolution);
      Object.assign(card,{state:'cancelled',badge:'已取消',evidence:'公开取消声明',title:kind==='banked_reset'?'本轮发卡安排已取消':'本轮重置安排已取消',description:'原安排已取消；如有新安排，将另行更新。',icon:'cancel',timeLabel:'取消消息',time:at(resolution.statementAt),timeAt:resolution.statementAt,action:'查看取消依据'});
    }else if(completion && valid(completion.statementAt) && current>=Date.parse(completion.statementAt) && current-Date.parse(completion.statementAt)<86400000){
      Object.assign(card,{state:'completed',tone:'green',badge:'公开完成',evidence:'公开完成声明',title:kind==='banked_reset'?'重置卡发放已确认':'额度重置已确认',description:'本轮已有公开完成声明，等待下一次预告。',icon:'check',timeLabel:'完成消息',time:at(completion.statementAt),timeAt:completion.statementAt,footer:'个人账户以实际显示为准',action:'查看完成公告'});
    }
    return card;
  });
  const activeSignal=m.activeResetWatch(forecasts?.watch,now);
  const reference=forecasts?.referenceSignal;
  const refValid=reference && valid(reference.publishedAt) && valid(reference.recordedAt) && Date.parse(reference.publishedAt)<=current && Date.parse(reference.recordedAt)<=current;
  const signals=[];
  if(refValid)signals.push({url:reference.sourceUrl,at:reference.publishedAt,window:'',expiresAt:'',sourceName:reference.sourceName,type:'x_post'});
  if(activeSignal)signals.push({url:activeSignal.sourceUrl||'',at:activeSignal.observedAt,window:m.resetWatchWindow(activeSignal.forecastWindow),expiresAt:activeSignal.expiresAt,sourceName:'Codex Resets',type:activeSignal.sourceType||'x_post'});
  const signal=signals.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
  let untyped=null;
  if(signal){
    const kind=signalKind(data,signal.url), target=cards.find(c=>c.kind===kind);
    const resolution=kind ? outlooks[kind].latestResolutions?.[kind] || outlooks[kind].lastResolved : kinds.map(k=>outlooks[k].latestResolutions?.[k]||outlooks[k].lastResolved).filter(Boolean).sort((a,b)=>Date.parse(b.statementAt)-Date.parse(a.statementAt))[0];
    const consumed=m.publicActions(data).some(({action})=>['claimed_complete','cancelled'].includes(action.stage) && Date.parse(action.statementAt)>=Date.parse(signal.at) && data.evidence.some(e=>e.url===signal.url && action.evidenceIds.includes(e.id)));
    if(!consumed && (!resolution || Date.parse(resolution.statementAt)<Date.parse(signal.at)) && (!target || ['waiting','completed','cancelled'].includes(target.state) && (!target.timeAt || Date.parse(signal.at)>Date.parse(target.timeAt)))){
      const card=base(kind);
      Object.assign(card,{state:signal.window?'estimated':'signal',tone:'violet',badge:signal.window?'信号推测':'信号观察',evidence:'依据公开线索'+(signal.window?'推测':'观察'),title:!kind?'发现重置相关信号':signal.window?kind==='banked_reset'?'预计近期发放重置卡':'预计近期额度重置':kind==='banked_reset'?'发现重置卡发放线索':'发现额度重置信号',description:!kind?'发现公开线索，具体类型及发放安排尚未明确。':'这是信号推测，尚未形成明确安排。',icon:'signal',window:signal.window,timeLabel:'信号发布',time:at(signal.at),timeAt:signal.at,footer:'尚未形成明确预告',action:signal.window?'查看预测依据':'查看信号依据',sourceUrl:signal.url,sourceName:signal.sourceName,sourceType:signal.type,expiresAt:signal.expiresAt,watchNote:signal.expiresAt?'观察有效至 '+at(signal.expiresAt)+' · 北京时间；不是发放截止时间。':'公开线索尚无明确发放时间。'});
      if(target)Object.assign(target,card);else untyped=card;
    }
  }
  const expired=forecasts?.watch?.status==='active' && !activeSignal && valid(forecasts.watch.signal?.expiresAt) && Date.parse(forecasts.watch.signal.expiresAt)<=current;
  const sourceWarning=forecasts?.status==='unavailable'?'趋势分析暂未更新，公开公告与历史记录仍可查看。':forecasts?.watch?.status==='unavailable'?'辅助信号等待更新：第三方辅助信号暂未更新，仅影响信号观察；公开公告与历史记录仍可查看。':'';
  const completed=m.latestCompletedBenefits({...data,serverTime:now});
  for(const card of cards){
    const current=['announced','scheduled','revised','overdue'].includes(card.state)?0:card.state==='progress'?1:card.state==='completed'?2:-1;
    // A later declaration does not prove that earlier stages were publicly recorded.
    card.progress=['公开预告',card.kind==='banked_reset'?'发放进行':'重置进行','完成确认'].map((label,index)=>({label,current:index===current}));
  }
  const history=kind=>{
    const item=completed.find(item=>item.action.kind===kind);
    if(!item)return null;
    const elapsed=m.completionElapsed(item.action,now);
    if(!elapsed)return null;
    const parts=elapsed.parts,clock=unit=>String(parts.find(part=>part.unit===unit)?.value||0).padStart(2,'0');
    const date=at(item.action.statementAt);
    return {time:date,displayTime:`${date.slice(0,4)===m.dateKey(now).slice(0,4)?'':date.slice(0,4)+'年'}${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日 ${date.slice(11,16)}`,elapsed:elapsed.label,days:parts.find(part=>part.unit==='天')?.value||0,hours:clock('小时'),minutes:clock('分钟'),hoursMinutes:clock('小时')+':'+clock('分钟'),seconds:clock('秒'),statementAt:item.action.statementAt,publicationId:item.publication.id,eventId:item.event.id};
  };
  return {cards,untyped,sourceWarning,expiredNote:expired&&!signal?'先前信号已过观察期，等待新的公开消息。':'',lastReset:history('automatic_reset'),lastCard:history('banked_reset')};
}
module.exports={resetStateCards};
