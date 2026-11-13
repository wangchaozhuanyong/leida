const {assignObservations,latestResolution,openRounds,orderRounds,pending,publishedRounds,roundExpiry,
  roundKey:keyOf,signalRounds,withSignal}=require('./round-evidence');
const m = require('./model');
const { resetStateCards } = require('./reset-state-cards');
const { observationDayGroups, observationSources } = require('./reset-records');
const { homeClock, homeOrbitPresentation } = require('./home-orbit');
/** @typedef {{label:string,basis:string,at:string,publicationId?:string,sourceUrl?:string,sourceName?:string}} RoundNotice */
const DAY = 86400000;
const valid = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const millis = value => valid(value) ? Date.parse(value) : -Infinity;
const kinds = ['automatic_reset', 'banked_reset'];
const validKind = kind => kinds.includes(kind) ? kind : 'automatic_reset';
const detailPath = id => '/pages/detail/index?publicationId=' + encodeURIComponent(id);
// Compact UI revision only; not a credential or a security signature.
function stateRevision(value) {
  let first=2166136261,second=5381;
  for(let i=0;i<value.length;i++){first=Math.imul(first^value.charCodeAt(i),16777619);second=Math.imul(second,33)^value.charCodeAt(i);}
  return 'home-'+(first>>>0).toString(16).padStart(8,'0')+(second>>>0).toString(16).padStart(8,'0');
}
function overlappingClock(rounds, active) {
  const prior=rounds.find(round=>round!==active&&pending(round)&&!round.remote&&valid(round.expectedAt)&&
    millis(round.startAt)<=millis(active.statementAt)&&millis(active.statementAt)<=millis(round.expectedAt)+DAY);
  if(!prior)return active;
  const competing=rounds.some(round=>round!==active&&round!==prior&&pending(round)&&!round.remote&&
    millis(round.startAt)<=millis(active.statementAt)&&(!valid(round.expectedAt)||millis(round.expectedAt)+DAY>=millis(active.statementAt)));
  if(competing)return active;
  return prior;
}
function dateFields(at, qualifier='') {
  const time = valid(at) ? m.displayTime(at) : '', [date='',clockText=''] = time.split(' ');
  return {timeAt:at||'',time:time+(qualifier?' '+qualifier:''),dateText:date.replace(/^(\d{4})-(\d{2})-(\d{2})$/,(_,y,mo,d)=>`${y}年${Number(mo)}月${Number(d)}日`),clockText,timeQualifier:qualifier};
}
function roundsFor(data, kind, now) {
  const current=millis(now), facts=m.publicActions(data).filter(({action})=>action.kind===kind);
  const outlook=data.forecasts?.outlook&&m.resetOutlookModel(data,data.forecasts.outlook.byKind?kind:undefined);
  const snapshots=data.publications.filter(p=>!m.isNewsOnly(p)&&!m.publicationWithdrawn(data,p));
  const rounds=publishedRounds(facts,snapshots,data.evidence,now,outlook?.latestResolutions);
  // The home payload can omit an older publication while retaining its existing
  // server outlook. Apply the same deadline rules to that validated projection.
  if(outlook){
    for(const item of [outlook.lastResolved,outlook.latestResolutions?.[kind],outlook.latestCompletion,outlook.active,...(outlook.pendingReview||[])]){
      if(!item||item.kind!==kind||millis(item.statementAt)>current||rounds.some(r=>keyOf(r)===keyOf(item)))continue;
      const expectedAt=item.expectedAt||item.announcedDeadline||'';
      rounds.push({...item,timeNote:item.timeNote||item.announcedDeadlineNote||'',startAt:item.announcedAt||item.statementAt,expectedAt,urls:[],remote:false,hasPromise:['promised','in_progress'].includes(item.stage)||valid(item.announcedAt)});
    }
  }
  // Use the existing remote contract only when its original post is not already represented.
  const remote = m.activeResetSchedule(data.forecasts?.watch, now);
  if(remote?.kind===kind && !rounds.some(r=>r.urls.includes(remote.sourceUrl)))rounds.push({actionId:remote.id,eventId:'remote',publicationId:'',kind,stage:'promised',statementAt:remote.announcedAt,startAt:remote.announcedAt,expectedAt:remote.scheduledFor||'',timeNote:/最晚|之前|\bby\b/i.test(remote.text)?'最晚之前':'',urls:remote.sourceUrl?[remote.sourceUrl]:[],remote:true,sourceName:'Codex Resets',sourceType:remote.sourceType||'x_post',sourceUrl:remote.sourceUrl||'',hasPromise:true});
  return rounds.sort(orderRounds);
}

function completedCard(base, kind, round, observations) {
  // Source-observation time stays the clock anchor when a later declaration upgrades evidence.
  const observation = observations.slice().sort((a,b)=>millis(a.observedAt)-millis(b.observedAt))[0];
  const declared = round?.stage==='claimed_complete';
  const at = observation?.observedAt || round.statementAt;
  const publicationId = declared ? round.publicationId : observation.publicationId;
  const banked=kind==='banked_reset',early=!!round?.expectedAt && millis(at)<millis(round.expectedAt) && millis(at)>=millis(round.startAt);
  const title=banked?'重置卡已发放':'额度已重置';
  const card={...base,kind,state:declared?'completed':'observed',tone:declared?'green':'teal',title,badge:declared?'发布者已确认':'第三方报告',completedDisplay:true,expiredRound:false,
    ...dateFields(at),timeLabel:observation?'来源观测时间':'完成消息时间',metricLabel:banked?'距离上次发卡':'距离上次重置',
    clockAt:at,expectedAt:round?.expectedAt||'',roundKey:round?keyOf(round):'observation:'+observation.eventId,publicationId,eventId:declared?round.eventId:observation.eventId,
    declarationAt:declared?round.statementAt:'',declarationTime:declared&&observation?m.displayTime(round.statementAt):'',evidenceType:declared?'declaration':'observation',clockEvidenceType:observation?'observation':'declaration',
    sourceName:declared?'':observation.sourceName,sourceType:declared?'announcement':'observed',sourceUrl:'',
    dialStatus:declared?'依据公开完成声明':'依据第三方观测',description:'持续关注下一次安排。',footer:declared?'公开完成消息，个人账户以实际显示为准':observation.sourceName+' · 第三方观测',
    action:'查看记录',oldTime:'',expectedElapsed:'',observationPublicationId:'',observationSourceName:'',observationTime:'',observationAt:'',watchNote:'',validUntil:'',early};
  const summary=!round&&observation?.displaySummary;
  if(summary){
    card.observationSummaryDate=summary.date;card.roundKey=summary.id;card.sourceName=summary.sourceName;
    card.timeLabel=summary.summaryScope==='date'?'最早观测时间':'观测时间';
    card.action='查看来源';
  }
  return card;
}
function pendingCard(base, round, now) {
  const time=millis(now),deadline=millis(round.expectedAt),timed=valid(round.expectedAt),overdue=timed&&time>=deadline;
  const signal=round.signal;
  const fallback=signal?.hint.windowBasis==='fallback_48h', namedDay=!!signal?.hint.dayLabel;
  const card={...base,completedDisplay:false,expiredRound:false,roundKey:keyOf(round),expectedAt:round.expectedAt||'',clockAt:'',declarationAt:'',declarationTime:'',evidenceType:signal?'signal':'announcement',
    publicationId:round.publicationId,eventId:round.eventId,sourceName:round.sourceName||'',sourceUrl:round.sourceUrl||'',sourceType:round.sourceType||'',
    timingPublicationId:!signal&&round.timingPublicationId||'',
    observationPublicationId:'',observationSourceName:'',observationTime:'',observationAt:'',oldTime:'',expectedElapsed:'',metric:'',clockParts:[],window:'',watchNote:'',validUntil:timed?new Date(overdue?roundExpiry(round):deadline).toISOString():''};
  if(signal){
    const banked=round.kind==='banked_reset';
    Object.assign(card,{sourceName:signal.sourceName,sourceUrl:signal.sourceUrl,sourceType:'x_post',
      sourceNames:signal.sourceNames, parentSourceUrl:signal.hint.parentSourceUrl||'',signalAt:signal.publishedAt,
      window:fallback?(banked?'可能发放重置卡':'额度可能重置'):namedDay?signal.hint.dayLabel+(banked?'可能发放':'可能重置'):(banked?'预计发放重置卡':'预计额度重置'),
      watchNote:fallback?'原帖未给发放时间，按 48 小时观察。':namedDay?'按发布者当地日期的结束时间推算。':'时间依据发布者原文，结果以公开声明或观测为准。'});
  }
  const adjusted=valid(round.previousExpectedAt),note=round.timeNote||'',timing=/^原文近似时间/.test(note)?'approximate':/^原文预计时刻/.test(note)?'point':/(?:日终|最晚|之前|以内|截止|\bby\b|\bwithin\b)/i.test(note)?'deadline':'point';
  const qualifier=timing==='deadline'?'前':timing==='approximate'?'左右':'';
  card.state=overdue?'overdue':signal?'estimated':timed?adjusted?'revised':'scheduled':'announced';
  card.title=overdue?(signal?'推测窗口已过':'原预计时间已过'):signal?card.window:round.kind==='banked_reset'?'预计发放重置卡':'预计额度重置';
  card.timeLabel=fallback?'观察窗口结束':namedDay?'推测窗口结束':timed?(overdue?'原预计安排':adjusted?'最新安排':'预计安排'):'消息时间';
  card.metricLabel=fallback?'距离观察窗口结束':namedDay?'距推测窗口结束':overdue?card.title:adjusted?'距离最新预计安排':timing==='deadline'?(round.kind==='banked_reset'?'距离预计最晚发放':'距离预计最晚重置'):timing==='approximate'?'距离预计时间（约）':'距离预计安排';
  Object.assign(card,dateFields(timed?round.expectedAt:round.statementAt,timed?qualifier:''));
  if(adjusted)card.oldTime='原预计 '+m.displayTime(round.previousExpectedAt);
  card.action=signal?'查看预测依据':overdue?'查看原预告':adjusted?'查看调整说明':'查看安排依据';
  return card;
}
function closeRound(base, round, last, now) {
  const explicit=round.stage==='cancelled', fallback=round.signal?.hint.windowBasis==='fallback_48h';
  const at=explicit?round.statementAt:new Date(roundExpiry(round)).toISOString();
  const subject=round.kind==='banked_reset'?'发卡':'重置';
  const label='本轮'+subject+(explicit?'安排已取消':round.signal?'预测已结束':'等待确认已结束');
  const basis=explicit?'发布者取消声明':fallback?'48 小时内暂未确认':round.signal?'推测窗口已过 24 小时':'超时 24 小时，暂未确认';
  const roundNotice={label,basis,at,publicationId:round.publicationId,sourceUrl:explicit?round.sourceUrl:undefined,sourceName:explicit?round.sourceName:undefined};
  if(last)return {...last,roundNotice,expiredRound:!explicit};
  return {...pendingCard(base,round,now),state:'cancelled',title:label,roundNotice,expiredRound:!explicit,
    validUntil:'',metricLabel:'',...dateFields(explicit?round.statementAt:round.expectedAt),
    timeLabel:explicit?'取消消息':'原预计安排',action:explicit?'查看取消依据':round.signal?'查看预测依据':'查看原预告'};
}
/** @param {ReturnType<typeof resetStateCards>['cards'][number] & {roundNotice?:RoundNotice,timingPublicationId?:string} & Record<string,any>} card
 * @param {import('../../src/lib/types').PublicData} data */
function finalize(card, data) {
  const hero=homeOrbitPresentation(card,data.serverTime);
  card.roundKey=card.roundKey||card.kind+':'+(card.publicationId||card.timeAt||'waiting');
  card.clockAt=card.clockAt||(['completed','observed'].includes(card.state)?card.timeAt:'');
  card.evidenceType=card.evidenceType||(['signal','estimated'].includes(card.state)?'signal':'announcement');
  card.validUntil=card.validUntil||(['signal','estimated'].includes(card.state)?card.expiresAt||'':'');
  card.shareTitle=[card.kind==='banked_reset'?'重置卡发放':'额度重置',hero.title||hero.label,card.roundNotice?.label].filter(Boolean).join(' · ');
  // Clock digits and collection time do not change the source revision.
  const evidencePublicationId=card.timingPublicationId||card.publicationId;
  card.revision=stateRevision(JSON.stringify([card.kind,card.roundKey,card.state,card.publicationId||'',evidencePublicationId||'',card.timeAt||'',card.expectedAt||'',card.clockAt||'',card.declarationAt||'',hero.title,hero.badge,card.roundNotice,card.sourceName||'',card.sourceUrl||'',card.parentSourceUrl||'',card.observationPublicationId||'',card.timeQualifier||'',card.oldTime||'']));
  card.sharePath=(card.roundNotice?.basis?'/pages/home/index?':card.observationSummaryDate?'/pages/schedule/index?date='+card.observationSummaryDate+'&':evidencePublicationId?detailPath(evidencePublicationId)+'&':'/pages/home/index?')+'kind='+card.kind+'&revision='+card.revision;
  return {...card,hero,metric:hero.metric,clockParts:hero.parts,clockLong:hero.long};
}
function historyMessage(record, now) {
  if(!record)return null;
  const [dateText,clockText]=record.displayTime.split(' ');
  const elapsed=homeClock(record.statementAt,now).metric;
  return {publicationId:record.publicationId,sourceType:record.sourceType,sourceName:record.sourceName,dateText,clockText,relativeTime:'距今 '+elapsed,badge:record.sourceType==='observed'?'第三方报告':'公开完成声明'};
}
function homeResetStatus(data, now=data.serverTime) {
  const input={...data,serverTime:now},states=resetStateCards(input,now),observations=observationSources(input);
  const cards=states.cards.map(base=>{
    const kind=base.kind, signals=signalRounds(input.forecasts?.referenceSignals??[input.forecasts?.referenceSignal],kind,now);
    const rounds=signals.reduce(withSignal,roundsFor(input,kind,now)),assigned=assignObservations(rounds,observations.filter(o=>o.kind===kind));
    // A late report from another source must not create a second occurrence or
    // restart the clock. Unlinked evidence stays a clearly labelled date summary.
    const summarize=rows=>observationDayGroups(input,rows,{separateSourceTimes:true}).map(g=>({...g.observations[0],...(g.isObservationSummary?{displaySummary:g}:{})}));
    const {assignments}=assigned,independent=summarize(assigned.independent),unassigned=summarize(assigned.unassigned);
    const record=kind==='banked_reset'?states.lastCard:states.lastReset;
    const resolution=latestResolution(rounds);
    // Start time orders open arrangements. Once resolved, use the resolution time:
    // an earlier announcement for batch two must not make batch one appear newer.
    const open=openRounds(rounds,resolution);
    const current=open[0];
    const latest=current?.stage==='in_progress'&&!valid(current.expectedAt)&&!assignments.get(keyOf(current))?.length
      ?overlappingClock(open,current):current||resolution;
    const lastCompletion=()=>{
      const completions=rounds.filter(r=>r.stage==='claimed_complete'||assignments.get(keyOf(r))?.length)
        .map(r=>completedCard(base,kind,r,assignments.get(keyOf(r))||[]));
      for(const observation of unassigned)completions.push(completedCard(base,kind,null,[observation]));
      return completions.sort((a,b)=>millis(b.clockAt)-millis(a.clockAt))[0];
    };
    let card;
    const bound=latest?assignments.get(keyOf(latest))||[]:[];
    if(latest?.stage==='claimed_complete'||bound.length){
      // Select the current occurrence before choosing its clock anchor. Keeping
      // the earliest proof inside one round must not pin every future reset to it.
      const resolvedAt=Math.max(millis(latest.statementAt),...bound.map(o=>millis(o.observedAt)));
      const actual=completedCard(base,kind,latest,bound),other=lastCompletion();
      card=other&&millis(other.clockAt)>resolvedAt?other:actual;
    }
    else if(latest&&pending(latest)){
      const timed=valid(latest.expectedAt), expires=roundExpiry(latest);
      const last=(!timed||millis(now)>=expires)?lastCompletion():null;
      if(timed&&millis(now)>=expires){
        card=last&&millis(last.clockAt)>expires?last:closeRound(base,latest,last,now);
      }else{
        card=last||pendingCard(base,latest,now);
        if(last)card={...card,roundNotice:{label:(kind==='banked_reset'?'发卡':'重置')+'时间待公布',basis:'',at:latest.statementAt}};
        const other=independent.find(o=>millis(o.observedAt)>=millis(latest.startAt)&&o.publicationId!==last?.publicationId);
        if(other)Object.assign(card,{observationPublicationId:other.publicationId,observationEventId:other.eventId,observationSourceName:other.sourceName,observationTime:m.displayTime(other.observedAt),observationAt:other.observedAt});
      }
    }else if(latest?.stage==='cancelled'){
      const last=lastCompletion();
      card=last&&millis(last.clockAt)>millis(latest.statementAt)?last:closeRound(base,latest,last,now);
    }else if(independent.length)card=completedCard(base,kind,null,[independent[0]]);
    else card={...base,state:'waiting',publicationId:'',eventId:'',sourceUrl:'',sourceName:'',timeLabel:'',...dateFields(''),completedDisplay:false,expiredRound:false};
    // A genuinely newer classified signal replaces history, never a still-active arrangement.
    if(['signal','estimated'].includes(base.state) && !signals.some(signal=>base.sourceUrl===signal.sourceUrl) &&
      millis(base.signalAt)>Math.max(millis(latest?.statementAt),millis(card.clockAt)) &&
      (!['scheduled','revised','announced','progress','overdue'].includes(card.state)||
       card.state==='announced'&&!!base.hintForPublicationId&&base.hintForPublicationId===latest?.publicationId)){
      card={...base,completedDisplay:false,expiredRound:false,roundKey:kind+':signal:'+base.signalAt};
    }
    card.lastMessage=historyMessage(record,now);
    return finalize(card,input);
  });
  states.sourceWarning=[states.sourceWarning,m.sourceStatus(input.sources).warning?'部分来源更新延迟，新消息可能稍晚显示。':''].filter(Boolean).join(' ');
  return {...states,cards,...chooseFocus(cards)};
}
// Choose a presentation only. Comparing cards must never change either occurrence.
function chooseFocus(cards) {
  function rank(card) {
    if (['scheduled','revised','progress','announced'].includes(card.state)) return 0;
    if (card.state==='overdue') return 1;
    if (['signal','estimated'].includes(card.state)) return 2;
    if (card.completedDisplay || card.state==='cancelled') return 3;
    return 4;
  }
  const sorted=cards.slice().sort((a,b)=>{
    const order=rank(a)-rank(b);
    if(order) return order;
    if(rank(a)===0){
      const at=valid(a.expectedAt)?millis(a.expectedAt):Infinity;
      const bt=valid(b.expectedAt)?millis(b.expectedAt):Infinity;
      if(at!==bt)return at-bt;
    }
    return (millis(b.roundNotice?.at||b.clockAt||b.timeAt)-millis(a.roundNotice?.at||a.clockAt||a.timeAt)) || a.kind.localeCompare(b.kind);
  });
  const [primary, other]=sorted;
  const secondary=other && rank(other)<4 && (rank(primary)<3 || rank(other)<3 || other.roundNotice?.basis) ? other : null;
  return {primary, secondary};
}
function selectedHomeStatus(data, kind, now=data.serverTime) {return homeResetStatus(data,now).cards.find(c=>c.kind===validKind(kind));}
module.exports={homeResetStatus,selectedHomeStatus,validKind};
