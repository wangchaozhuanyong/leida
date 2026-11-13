const { isHistoricalArticle } = require('./model');
const DAY = 86400000;
const stages = { promised:1, in_progress:2, observed:3, claimed_complete:4, cancelled:4 };
const states = ['signal','estimated','announced','scheduled','revised','progress','overdue','observed','completed','cancelled'];

// The identity contains message facts only: a clock tick or layout revision is not news.
function bankedMessage(cards, data) {
  const card=cards?.find(item=>item.kind==='banked_reset');
  if(!data||!card||!states.includes(card.state)||card.expiredRound)return null;
  const cancelled=card.roundNotice?.basis==='发布者取消声明';
  const now=Date.parse(data.serverTime),publication=data.publications?.find(item=>item.id===(cancelled?card.roundNotice.publicationId:card.publicationId));
  if(publication&&isHistoricalArticle(publication.article,data.evidence||[]))return null;
  const action=publication?.event.actions.find(item=>item.kind==='banked_reset'&&item.scope==='public'&&publication.eventId+':'+item.id===card.roundKey)
    ||publication?.event.actions.find(item=>item.kind==='banked_reset'&&item.scope==='public');
  const stage=cancelled?'cancelled':action?.stage||(card.state==='completed'?'claimed_complete':card.state==='observed'?'observed':card.state==='cancelled'?'cancelled':'promised');
  const at=action?.statementAt||publication?.article.sourcePublishedAt||publication?.publishedAt||card.signalAt||card.timeAt;
  if(!card.roundKey||!Number.isFinite(now)||!Number.isFinite(Date.parse(at))||Date.parse(at)>now||!publication&&!card.sourceUrl)return null;
  const round=cancelled&&action?publication.eventId+':'+action.id:card.roundKey;
  const key=JSON.stringify([round,stage,at,action?.expectedAt||card.expectedAt||'',action?.eligibility||'',card.declarationAt||'']);
  return {key,round,at,rank:stages[stage],active:['signal','estimated','announced','scheduled','revised','progress'].includes(card.state)};
}

function createHomeTabNotices(wxApi, config) {
  const scope=JSON.stringify([config.mode,config.baseUrl||'',config.cloudEnv||'',config.serviceName||'']);
  const storageKey='moyao-mini-home-card-read-v1';
  let read=null;
  try {
    const saved=wxApi.getStorageSync(storageKey),item=saved?.read;
    if(saved?.scope===scope&&typeof item?.key==='string'&&item.key.length<=3000&&typeof item.round==='string'&&item.round.length<=500
      &&Number.isFinite(Date.parse(item.at))&&[1,2,3,4].includes(item.rank))read=item;
  } catch (_) { /* A storage failure must not affect the public page. */ }
  return {
    unread(cards,data) {
      const message=bankedMessage(cards,data);
      if(!message||message.key===read?.key)return false;
      // A late cached version cannot resurrect an older message. A same-round
      // publisher confirmation may still upgrade an earlier observation.
      if(read&&Date.parse(message.at)<Date.parse(read.at)&&!(message.round===read.round&&message.rank>read.rank))return false;
      // First use should not label an old completed record as breaking news.
      return !!read||message.active||Date.parse(data.serverTime)-Date.parse(message.at)<DAY;
    },
    markRead(cards,data) {
      const message=bankedMessage(cards,data);
      if(!message||message.key===read?.key||read&&Date.parse(message.at)<Date.parse(read.at)&&!(message.round===read.round&&message.rank>read.rank))return false;
      read={key:message.key,round:message.round,at:message.at,rank:message.rank};
      try { wxApi.setStorageSync(storageKey,{scope,read}); } catch (_) { /* Keep this run's acknowledgement in memory. */ }
      return true;
    }
  };
}
module.exports={createHomeTabNotices,bankedMessage};
