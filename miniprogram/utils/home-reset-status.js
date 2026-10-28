const m = require('./model');
const { resetStateCards } = require('./reset-state-cards');
const { observationDayGroups, observationSources } = require('./reset-records');
const { homeOrbitPresentation } = require('./home-orbit');
const { countdownParts } = require('./status-timeline');
const DAY = 86400000;
const valid = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const millis = value => valid(value) ? Date.parse(value) : -Infinity;
const kinds = ['automatic_reset', 'banked_reset'];
const validKind = kind => kinds.includes(kind) ? kind : 'automatic_reset';
const keyOf = item => item.eventId + ':' + item.actionId;
const detailPath = id => '/pages/detail/index?publicationId=' + encodeURIComponent(id);
// Compact UI revision only; not a credential or a security signature.
function stateRevision(value) {
  let first=2166136261,second=5381;
  for(let i=0;i<value.length;i++){first=Math.imul(first^value.charCodeAt(i),16777619);second=Math.imul(second,33)^value.charCodeAt(i);}
  return 'home-'+(first>>>0).toString(16).padStart(8,'0')+(second>>>0).toString(16).padStart(8,'0');
}
function clock(at, now) {
  const parts = countdownParts(now, at);
  const units = parts.some(p => p.unit === '天') ? ['天','小时','分钟'] : ['小时','分钟'];
  return {metric:parts.length ? parts.map(p=>p.value+p.unit).join('') : '刚刚',clockParts:parts.length ? units.map(unit=>({unit,value:String(parts.find(p=>p.unit===unit)?.value||0).padStart(2,'0')})) : []};
}
function dateFields(at, qualifier='') {
  const time = valid(at) ? m.displayTime(at) : '', [date='',clockText=''] = time.split(' ');
  return {timeAt:at||'',time:time+(qualifier?' '+qualifier:''),dateText:date.replace(/^(\d{4})-(\d{2})-(\d{2})$/,(_,y,mo,d)=>`${y}年${Number(mo)}月${Number(d)}日`),clockText,timeQualifier:qualifier};
}
function roundsFor(data, kind, now) {
  const current = millis(now), facts = m.publicActions(data).filter(({action,publication})=>action.kind===kind && millis(action.statementAt)<=current && valid(action.statementAt) && valid(publication.publishedAt) && millis(publication.publishedAt)<=current);
  const rounds = facts.map(({action,event,publication})=>{
    const versions = data.publications.filter(p=>p.eventId===event.id && !m.isNewsOnly(p) && !m.publicationWithdrawn(data,p) && millis(p.publishedAt)<=millis(publication.publishedAt))
      .flatMap(p=>p.event.actions.filter(a=>a.id===action.id && a.kind===kind && a.scope==='public' && valid(a.statementAt) && millis(a.statementAt)<=current).map(a=>({...a,publicationId:p.id})))
      .sort((a,b)=>millis(a.statementAt)-millis(b.statementAt));
    const promises = versions.filter(a=>['promised','in_progress'].includes(a.stage));
    const first = promises[0], prior = promises.filter(a=>valid(a.expectedAt)&&a.publicationId!==publication.id).pop();
    const deadline = valid(action.expectedAt) ? action.expectedAt : promises.filter(a=>valid(a.expectedAt)).pop()?.expectedAt || '';
    const ids = new Set(versions.flatMap(a=>a.evidenceIds||[]).concat(action.evidenceIds||[]));
    const urls = data.evidence.filter(e=>ids.has(e.id)).map(e=>e.url);
    return {...action,timeNote:action.timeNote||promises.filter(a=>a.expectedAt===deadline).pop()?.timeNote||'',actionId:action.id,eventId:event.id,publicationId:publication.id,startAt:first?.statementAt||action.statementAt,expectedAt:deadline,
      previousExpectedAt:prior?.expectedAt && prior.expectedAt!==deadline ? prior.expectedAt : '',urls,remote:false,hasPromise:!!first};
  });
  // The home payload can omit an older publication while retaining its existing
  // server outlook. Apply the same deadline rules to that validated projection.
  if(data.forecasts?.outlook){
    const outlook=m.resetOutlookModel(data,data.forecasts.outlook.byKind?kind:undefined);
    for(const item of [outlook.lastResolved,outlook.latestResolutions?.[kind],outlook.latestCompletion,outlook.active,...(outlook.pendingReview||[])]){
      if(!item||item.kind!==kind||millis(item.statementAt)>current||rounds.some(r=>keyOf(r)===keyOf(item)))continue;
      const expectedAt=item.expectedAt||item.announcedDeadline||'';
      rounds.push({...item,timeNote:item.timeNote||item.announcedDeadlineNote||'',startAt:item.announcedAt||item.statementAt,expectedAt,urls:[],remote:false,hasPromise:['promised','in_progress'].includes(item.stage)||valid(item.announcedAt)});
    }
  }
  // Use the existing remote contract only when its original post is not already represented.
  const remote = m.activeResetSchedule(data.forecasts?.watch, now);
  if(remote?.kind===kind && !rounds.some(r=>r.urls.includes(remote.sourceUrl)))rounds.push({actionId:remote.id,eventId:'remote',publicationId:'',kind,stage:'promised',statementAt:remote.announcedAt,startAt:remote.announcedAt,expectedAt:remote.scheduledFor||'',timeNote:/最晚|之前|\bby\b/i.test(remote.text)?'最晚之前':'',urls:remote.sourceUrl?[remote.sourceUrl]:[],remote:true,sourceName:'Codex Resets',sourceType:remote.sourceType||'x_post',sourceUrl:remote.sourceUrl||'',hasPromise:true});
  return rounds.sort((a,b)=>millis(b.startAt)-millis(a.startAt)||millis(b.statementAt)-millis(a.statementAt)||keyOf(a).localeCompare(keyOf(b)));
}
function assignObservations(rounds, observations) {
  const assignments = new Map(), independent = [], unassigned = [];
  for(const observation of observations){
    // A shared source/index URL is provenance, not an occurrence identity.
    // Only a distinct referenced post can explicitly bind different records.
    const postReference=observation.referenceUrl&&observation.referenceUrl!==observation.sourceUrl;
    const explicit = rounds.filter(r=>r.stage!=='cancelled' && (!r.hasPromise||millis(observation.observedAt)>=millis(r.startAt)) && (r.eventId===observation.eventId || postReference&&r.urls.includes(observation.referenceUrl)));
    const candidates = explicit.length ? explicit : rounds.filter(r=>r.stage!=='cancelled' && r.hasPromise && millis(observation.observedAt)>=millis(r.startAt) &&
      (valid(r.expectedAt) ? millis(observation.observedAt)<=millis(r.expectedAt)+DAY : ['promised','in_progress'].includes(r.stage)));
    if(candidates.length===1){const key=keyOf(candidates[0]);assignments.set(key,[...(assignments.get(key)||[]),observation]);}
    else {
      independent.push(observation);
      // Ambiguous evidence can be shown alongside an arrangement, but must not
      // be promoted into a separate later round while it still matches one.
      if(!candidates.length)unassigned.push(observation);
    }
  }
  return {assignments,independent,unassigned};
}
function completedCard(base, kind, round, observations, now) {
  // Source-observation time stays the clock anchor when a later declaration upgrades evidence.
  const observation = observations.slice().sort((a,b)=>millis(a.observedAt)-millis(b.observedAt))[0];
  const declared = round?.stage==='claimed_complete';
  const at = observation?.observedAt || round.statementAt;
  const publicationId = declared ? round.publicationId : observation.publicationId;
  const banked=kind==='banked_reset',early=!!round?.expectedAt && millis(at)<millis(round.expectedAt) && millis(at)>=millis(round.startAt);
  const title=banked?'重置卡已发放':'额度已重置';
  const card={...base,kind,state:declared?'completed':'observed',tone:declared?'green':'teal',title,badge:declared?'发布者已确认':'第三方报告',completedDisplay:true,expiredRound:false,
    ...clock(at,now),...dateFields(at),timeLabel:observation?'来源观测时间':'完成消息时间',metricLabel:observation?round?'距本轮最早观测':'距来源观测':banked?'距上次发放':'距上次重置',
    clockAt:at,expectedAt:round?.expectedAt||'',roundKey:round?keyOf(round):'observation:'+observation.eventId,publicationId,eventId:declared?round.eventId:observation.eventId,
    declarationAt:declared?round.statementAt:'',declarationTime:declared&&observation?m.displayTime(round.statementAt):'',evidenceType:declared?'declaration':'observation',
    sourceName:declared?'':observation.sourceName,sourceType:declared?'announcement':'observed',sourceUrl:'',
    dialStatus:declared?'依据公开完成声明':'依据第三方观测',description:'持续关注下一次安排。',footer:declared?'公开完成消息，个人账户以实际显示为准':observation.sourceName+' · 第三方观测',
    action:'查看记录',oldTime:'',expectedElapsed:'',observationPublicationId:'',observationSourceName:'',observationTime:'',observationAt:'',watchNote:'',validUntil:'',early};
  card.hero=homeOrbitPresentation(card,now);
  card.hero.badge=declared?'发布者已确认':'第三方报告';
  card.hero.timeLabel=card.timeLabel;
  card.hero.description=early ? '预计时间前已有'+(declared?'完成声明。':'重置观测。') : declared?(banked?'发布者已声明发卡完成。':'发布者已声明重置完成。'):'来源：'+observation.sourceName+'。';
  card.hero.footnote=declared?'实际到账以账户显示为准。':early?'来源：'+observation.sourceName+' · 实际额度以账户为准。':'实际额度以账户显示为准。';
  const summary=!round&&observation?.displaySummary;
  if(summary){
    card.observationSummaryDate=summary.date;card.roundKey=summary.id;card.sourceName=summary.sourceName;
    card.timeLabel=summary.summaryScope==='date'?'最早观测时间':'观测时间';card.hero.timeLabel=card.timeLabel;
    card.hero.description='来源：'+summary.sourceName+'。';
    card.hero.footnote='实际额度以账户显示为准。';
    card.action='查看来源';
  }
  return card;
}
function pendingCard(base, round, now) {
  const time=millis(now),deadline=millis(round.expectedAt),timed=valid(round.expectedAt),overdue=timed&&time>=deadline;
  const expired=overdue&&time>=deadline+DAY;
  const card={...base,completedDisplay:false,expiredRound:expired,roundKey:keyOf(round),expectedAt:round.expectedAt||'',clockAt:'',declarationAt:'',declarationTime:'',evidenceType:'announcement',
    publicationId:round.publicationId,eventId:round.eventId,sourceName:round.sourceName||'',sourceUrl:round.sourceUrl||'',sourceType:round.sourceType||'',
    observationPublicationId:'',observationSourceName:'',observationTime:'',observationAt:'',oldTime:'',expectedElapsed:'',metric:'',clockParts:[],window:'',watchNote:'',validUntil:timed?new Date(overdue?deadline+DAY:deadline).toISOString():''};
  if(expired){
    Object.assign(card,{state:'waiting',tone:'slate',title:'暂无新消息',badge:'持续关注',publicationId:'',eventId:'',sourceName:'',sourceUrl:'',sourceType:'',...dateFields(''),timeLabel:'',action:'查看历史记录',validUntil:'',previousRoundPublicationId:round.publicationId});
    card.hero=homeOrbitPresentation(card,now);Object.assign(card.hero,{title:'暂无新消息',label:'公开消息追踪',badge:'持续关注',description:'暂未收到新的重置消息。',footnote:'有新进展会及时更新。'});
    return card;
  }
  const adjusted=valid(round.previousExpectedAt),timing=/(?:日终|最晚|之前|以内|截止|\bby\b|\bwithin\b)/i.test(round.timeNote||'')?'deadline':/^原文近似时间/.test(round.timeNote||'')?'approximate':'point';
  const qualifier=timing==='deadline'?'前':timing==='approximate'?'左右':'';
  const progress=round.stage==='in_progress';
  card.state=overdue?'overdue':progress?'progress':timed?adjusted?'revised':'scheduled':'announced';
  card.title=overdue?'预计时间已过，暂未观测到完成':base.title;
  card.timeLabel=timed?overdue?'原预计安排':adjusted?'最新安排':'预计安排':progress?'进展消息':'预告发布';
  Object.assign(card,dateFields(timed?round.expectedAt:round.statementAt,timed?qualifier:''));
  if(adjusted)card.oldTime='原预计 '+m.displayTime(round.previousExpectedAt);
  if(timed&&!overdue&&!progress){
    const parts=countdownParts(round.expectedAt,now),units=parts.some(p=>p.unit==='天')?['天','小时','分钟']:['小时','分钟'];
    card.metric=parts.length?parts.map(p=>p.value+p.unit).join(''):'不足1分钟';
    card.clockParts=parts.length?units.map(unit=>({unit,value:String(parts.find(p=>p.unit===unit)?.value||0).padStart(2,'0')})):[];
    card.metricLabel=adjusted?'距离最新预计安排':timing==='deadline'?'距离预计最晚时间':timing==='approximate'?'距离预计时间（约）':'距离预计安排';
  }
  card.action=overdue?'查看原预告':adjusted?'查看调整说明':progress?'查看最新进展':'查看安排依据';
  card.hero=homeOrbitPresentation(card,now);
  if(overdue){card.hero.description=progress?'已宣布开始，原预计时间已过，完成情况待核对。':'原预计时间已过，暂未观测到完成，正在持续核对。';card.hero.badge='暂未观测到完成';card.hero.footnote='实际到账以账户显示为准。';}
  return card;
}
function finalize(card, data) {
  if(!card.hero)card.hero=homeOrbitPresentation(card,data.serverTime);
  card.roundKey=card.roundKey||card.kind+':'+(card.publicationId||card.timeAt||'waiting');
  card.clockAt=card.clockAt||(['completed','observed'].includes(card.state)?card.timeAt:'');
  card.evidenceType=card.evidenceType||(['signal','estimated'].includes(card.state)?'signal':'announcement');
  card.validUntil=card.validUntil||(['signal','estimated'].includes(card.state)?card.expiresAt||'':'');
  card.shareTitle=(card.kind==='banked_reset'?'重置卡发放':'额度重置')+' · '+(card.hero.title||card.hero.label)+' · '+card.hero.badge;
  // Clock digits and collection time are intentionally excluded: a minute tick is not a new fact.
  card.revision=stateRevision(JSON.stringify([card.kind,card.roundKey,card.state,card.publicationId||'',card.timeAt||'',card.expectedAt||'',card.clockAt||'',card.declarationAt||'',card.hero.title,card.hero.badge,card.hero.description,card.hero.footnote,card.sourceName||'',card.sourceUrl||'',card.observationPublicationId||'',card.timeQualifier||'',card.oldTime||'']));
  card.sharePath=(card.observationSummaryDate?'/pages/schedule/index?date='+card.observationSummaryDate+'&':card.publicationId?detailPath(card.publicationId)+'&':'/pages/home/index?')+'kind='+card.kind+'&revision='+card.revision;
  return card;
}
function historyMessage(record) {
  if(!record)return null;
  const days=Number(record.days),hours=Number(record.hours),minutes=Number(record.minutes);
  const duration=days?days+'天'+(hours?hours+'小时':''):hours?hours+'小时'+(minutes?minutes+'分钟':''):minutes?minutes+'分钟':'';
  const [dateText,clockText]=record.displayTime.split(' ');
  return {publicationId:record.publicationId,sourceType:record.sourceType,sourceName:record.sourceName,dateText,clockText,relativeTime:duration?'距今 '+duration:'刚刚',badge:record.sourceType==='observed'?'第三方报告':'公开完成声明'};
}
function homeResetStatus(data, now=data.serverTime) {
  const input={...data,serverTime:now},states=resetStateCards(input,now),observations=observationSources(input);
  states.cards=states.cards.map(base=>{
    const kind=base.kind,rounds=roundsFor(input,kind,now),assigned=assignObservations(rounds,observations.filter(o=>o.kind===kind));
    // A late report from another source must not create a second occurrence or
    // restart the clock. Unlinked evidence stays a clearly labelled date summary.
    const summarize=rows=>observationDayGroups(input,rows).map(g=>({...g.observations[0],...(g.isObservationSummary?{displaySummary:g}:{})}));
    const {assignments}=assigned,independent=summarize(assigned.independent),unassigned=summarize(assigned.unassigned);
    const latest=rounds[0],record=kind==='banked_reset'?states.lastCard:states.lastReset;
    let card;
    const bound=latest?assignments.get(keyOf(latest))||[]:[];
    if(latest?.stage==='claimed_complete'||bound.length){
      // Select the current occurrence before choosing its clock anchor. Keeping
      // the earliest proof inside one round must not pin every future reset to it.
      const resolvedAt=Math.max(millis(latest.statementAt),...bound.map(o=>millis(o.observedAt)));
      const newer=unassigned.find(o=>millis(o.observedAt)>resolvedAt);
      card=newer?completedCard(base,kind,null,[newer],now):completedCard(base,kind,latest,bound,now);
    }
    else if(latest&&['promised','in_progress'].includes(latest.stage)){
      card=pendingCard(base,latest,now);
      const newer=independent.find(o=>millis(o.observedAt)>millis(latest.expectedAt)+DAY);
      if(card.expiredRound&&newer)card=completedCard(base,kind,null,[newer],now);
      else if(!card.expiredRound){const other=independent.find(o=>millis(o.observedAt)>=millis(latest.startAt));if(other)Object.assign(card,{observationPublicationId:other.publicationId,observationSourceName:other.sourceName,observationTime:m.displayTime(other.observedAt),observationAt:other.observedAt});}
    }else if(latest?.stage==='cancelled'){
      const newer=independent.find(o=>millis(o.observedAt)>millis(latest.statementAt));
      card=newer?completedCard(base,kind,null,[newer],now):{...base,state:'cancelled',title:'本轮安排已取消',...dateFields(latest.statementAt),publicationId:latest.publicationId,eventId:latest.eventId,roundKey:keyOf(latest),completedDisplay:false,metric:'',clockParts:[],sourceName:'',sourceUrl:'',observationPublicationId:'',validUntil:'',action:'查看取消依据'};
      card.hero=homeOrbitPresentation(card,now);
    }else if(independent.length)card=completedCard(base,kind,null,[independent[0]],now);
    else card={...base,completedDisplay:false,expiredRound:false};
    // A genuinely newer classified signal replaces history, never a still-active arrangement.
    if(['signal','estimated'].includes(base.state) && (!latest || millis(base.timeAt)>Math.max(millis(latest.statementAt),millis(card.clockAt))) && !['scheduled','revised','announced','progress','overdue'].includes(card.state))card={...base,completedDisplay:false,expiredRound:false};
    card.lastMessage=historyMessage(record);
    return finalize(card,input);
  });
  states.sourceWarning=[states.sourceWarning,m.sourceStatus(input.sources).warning?'部分来源更新延迟，新消息可能稍晚显示。':''].filter(Boolean).join(' ');
  return states;
}
function selectedHomeStatus(data, kind, now=data.serverTime) {return homeResetStatus(data,now).cards.find(c=>c.kind===validKind(kind));}
module.exports={homeResetStatus,selectedHomeStatus,validKind};
