const m=require('./model');
const {selectedHomeStatus,homeResetStatus}=require('./home-reset-status');
function dateTime(value){
  if(!Number.isFinite(Date.parse(value)))return{date:'暂无公开公告',time:''};
  const d=new Date(Date.parse(value)+8*3600000),pad=n=>String(n).padStart(2,'0');
  return{date:`${d.getUTCFullYear()}.${pad(d.getUTCMonth()+1)}.${pad(d.getUTCDate())}`,time:`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`};
}
/** Freeze the same current status used by the homepage, never a different old completion. */
function statusPosterInput(data,kind){
  if(!data||!Number.isFinite(Date.parse(data.serverTime)))throw new Error('请先加载公开状态。');
  const card=kind?selectedHomeStatus(data,kind):homeResetStatus(data).primary,hero=card.hero;
  const date=dateTime(card.timeAt),generated=dateTime(data.serverTime);
  // A date summary has several source records; a code for one article cannot
  // represent the whole summary. Native forwarding opens the selected date.
  const publicationId=card.observationSummaryDate||card.roundNotice?.basis?'':card.timingPublicationId||card.publicationId||'';
  const shareable=publicationId&&m.resolveDetail(data,{publicationId}).canShare;
  const sourceLabel=card.evidenceType==='observation'?'来源：'+card.sourceName+' · 第三方观测':card.declarationAt?'依据：发布者公开完成声明':card.sourceName?'来源：'+card.sourceName:'依据：当前公开状态';
  const scheduleNote=['scheduled','revised','estimated','overdue'].includes(card.state)&&card.expectedAt
    ? card.metricLabel+' · '+date.date+' · 北京时间\n'+date.time+(card.timeQualifier?' '+card.timeQualifier:'') : '';
  const closure=card.roundNotice?[card.roundNotice.label,card.roundNotice.basis].filter(Boolean).join(' · '):'';
  const nextNote=[closure,card.oldTime&&card.oldTime+' · 北京时间',scheduleNote||hero.description,
    card.declarationTime&&'完成声明：'+card.declarationTime+' · 北京时间'].filter(Boolean).join('\n');
  return {name:data.site.name||'模钥重置雷达',kind:card.kind,round:card.revision,followingFocus:!kind,publicationId,codePublicationId:shareable?publicationId:'',sharePath:card.sharePath,shareTitle:card.shareTitle,generatedAt:data.serverTime,
    title:hero.title||card.title,label:hero.label,value:hero.metric||hero.title,unit:'',date:date.date,time:date.time+(card.timeQualifier?' '+card.timeQualifier:''),generated:generated.date+' '+generated.time,
    statementAt:card.timeAt,statementLabel:hero.timeLabel||'公开状态',nextNote,
    sourceLabel,validUntil:card.validUntil||''};
}
module.exports={statusPosterInput};
