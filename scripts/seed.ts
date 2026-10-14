import { pool, one, insert, transaction } from '../src/db';
if((process.env.RADAR_STORAGE_BACKEND??'native')!=='native'){console.error('此命令仅用于原生数据库；云端请使用 bootstrap，不导入历史。');process.exit(1);}
import { sourceDefinitions } from '../src/server/ingestion';
import { defaultAI } from '../src/server/ai';
import { defaultSite } from '../src/server/service';
import { hash } from '../src/server/domain';
import type { Evidence, RadarEvent, Article, Publication, Activity, BenefitAction, Candidate } from '../src/lib/types';
await transaction(async c=>{
 for(const source of sourceDefinitions)await insert('sources',source,c);
 await insert('settings',{id:'site',...defaultSite},c);await insert('settings',defaultAI,c);
 const activity:Activity={id:'challenge-28',title:'连续28天更新活动',timezone:'America/Los_Angeles',startsOn:'2026-10-05',days:28,rules:'按活动当地日期记录公开更新。产品改进与重置卡分别记录；暂无收录不表示当天没有更新。',version:1,items:[]};await insert('activities',activity,c);
 if(await one('events','historical-20261008',c))return;
 const forecastCutoff='2026-10-08T06:38:00+08:00',latestCutoff='2026-10-08T21:26:51+08:00';
 const texts=[
  {id:'historical-parent-summary',sourceId:'manual',messageId:'2107913674593644711',url:'https://x.com/thsottiaux/status/2107913674593644711',text:'历史人工核对摘要（未保存父帖完整原文）：第3天更新公告承诺将向付费账户发放重置卡（banked reset）。原文资格需结合原帖；本条用于保留既有研究结论。',publishedAt:'2026-10-08T03:19:17.822+08:00',collectedAt:forecastCutoff,contextComplete:false,historical:true,provenance:'manual'},
  {id:'historical-timing',sourceId:'reset-archive',messageId:'2107913738791596286',parentId:'2107913674593644711',url:'https://x.com/thsottiaux/status/2107913738791596286',text:'Will be there by EOD PST.',publishedAt:'2026-10-08T03:19:33.128+08:00',collectedAt:forecastCutoff,contextComplete:false,historical:true,provenance:'archive'},
  {id:'historical-completion',sourceId:'reset-archive',messageId:'2108040921044639779',parentId:'2107913674593644711',url:'https://x.com/thsottiaux/status/2108040921044639779',text:'Confirmed landed across all accounts. How are we doing so far?',publishedAt:'2026-10-08T11:44:00+08:00',collectedAt:latestCutoff,contextComplete:false,historical:true,provenance:'archive'}
 ] as Omit<Evidence,'hash'>[];
 for(const e of texts)await insert('evidence',{...e,hash:hash(e.text)},c);
 const action:BenefitAction={id:'historical-20261008-card',kind:'banked_reset',stage:'promised',eligibility:'历史研究记为付费账户，原帖完整资格待补充',scope:'public',expectedAt:'2026-10-08T15:00:00+08:00',timeNote:'原文PST存在时区歧义，也可能指16:00前；以原帖为准',evidenceIds:['historical-parent-summary','historical-timing'],statementAt:'2026-10-08T03:19:33.128+08:00',evidenceQuote:'Will be there by EOD PST.'};
 const baseEvent:RadarEvent={id:'historical-20261008',title:'重置卡发放预告',version:1,status:'published',actions:[action],evidenceIds:action.evidenceIds,publicationId:'historical-pub-forecast',updatedAt:forecastCutoff};
 const baseArticle:Article={id:'historical-forecast',eventId:baseEvent.id,title:'重置卡发放预告',summary:'历史资料：公告安排发放重置卡，截止时间存在15:00或16:00的时区歧义；截至当时资料仍待完成确认。',translation:'预计在太平洋时间当日结束前发放。',category:'reset',version:1,status:'published',publicationId:baseEvent.publicationId,evidenceIds:baseEvent.evidenceIds,publishedAt:forecastCutoff,updatedAt:forecastCutoff};
 const first:Publication={id:baseEvent.publicationId,eventId:baseEvent.id,articleId:baseArticle.id,event:baseEvent,article:baseArticle,cutoffAt:forecastCutoff,publishedAt:forecastCutoff,reason:'历史研究导入；父帖仅存人工摘要，不代表本次实时核验'};
 const latestEvent:RadarEvent={...baseEvent,title:'公告称重置卡已发放',version:2,actions:[{...action,stage:'claimed_complete',statementAt:'2026-10-08T11:44:00+08:00',evidenceIds:[...action.evidenceIds,'historical-completion'],evidenceQuote:texts[2].text}],evidenceIds:[...baseEvent.evidenceIds,'historical-completion'],publicationId:'historical-pub-complete',updatedAt:latestCutoff};
 const latestArticle:Article={...baseArticle,id:'historical-complete',title:latestEvent.title,summary:'历史公开归档收录了“已在所有账户落地”的完成回复。原父帖完整资格待补充；这不是个人账户到账观测。',translation:'已确认在所有账户落地。到目前为止我们做得怎么样？',publicationId:latestEvent.publicationId,evidenceIds:latestEvent.evidenceIds,publishedAt:'2026-10-08T11:44:00+08:00',updatedAt:latestCutoff};
 const latest:Publication={id:latestEvent.publicationId,eventId:latestEvent.id,articleId:latestArticle.id,event:latestEvent,article:latestArticle,cutoffAt:latestCutoff,publishedAt:latestCutoff,reason:'历史研究导入；辅助归档完成回复，尚未直接核验完整父帖'};
 await insert('publications',first,c);await insert('publications',latest,c);await insert('events',latestEvent,c);await insert('articles',baseArticle,c);await insert('articles',latestArticle,c);
 const candidate:Candidate={id:'historical-context-review',evidenceId:'historical-completion',version:1,status:'pending',reasons:['历史导入父帖只有摘要，请补充完整原文与资格后更正'],content:{title:latestArticle.title,summary:latestArticle.summary,translation:latestArticle.translation,category:'reset',eventId:latestEvent.id,actions:latestEvent.actions,evidenceIds:latestEvent.evidenceIds},createdAt:latestCutoff,updatedAt:latestCutoff,humanEdited:true};await insert('candidates',candidate,c);
 await insert('audits',{id:'historical-import-audit',actor:'historical-import',action:'historical.import',objectId:baseEvent.id,reason:'只导入既有06:38和21:26研究快照，未新采集，父帖摘要和上下文缺口已明确，历史导入不生成实时提醒',createdAt:latestCutoff},c);
});
console.log('历史资料已导入；来源默认关闭，未生成实时提醒');await pool.end();
