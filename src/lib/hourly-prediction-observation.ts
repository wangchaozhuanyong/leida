import type {Evidence,Publication} from './types';
import {isHistoricalArticle} from './history';

export const HOURLY_OBSERVATION_VERSION='public-announcement-hours-v1';
export interface HourlyPredictionCase {
  key:string;eventId:string;actionId:string;kind:string;publicationId:string;evidenceIds:string[];
  statementAt:string;availableAt:string;expectedAt:string;mode:'point'|'deadline';
  completionAt?:string;completionPublicationId?:string;absoluteErrorHours?:number;withinOneHour?:boolean;withinDeadline?:boolean;
  outcome:'unknown'|'public_completion'|'cancelled';
}
export interface HourlyPredictionObservation {
  version:typeof HOURLY_OBSERVATION_VERSION;startedAt:string;lastCheckedAt?:string;cases:HourlyPredictionCase[];
}
const valid=(at:string)=>Number.isFinite(Date.parse(at));

/** Score the first genuinely prospective arrangement, never the latest revision.
 * Availability is the immutable publication/cutoff time, not this polling time.
 * The target is a later public completion statement; account delivery is unknown. */
export function evaluateHourlyPredictions(previous:HourlyPredictionObservation,input:{time:string;publications:Publication[];evidence:Evidence[];automaticPublicationIds:ReadonlySet<string>}) {
  if(previous.version!==HOURLY_OBSERVATION_VERSION||!valid(previous.startedAt)||!valid(input.time)||!valid(previous.lastCheckedAt??previous.startedAt)||Date.parse(previous.lastCheckedAt??previous.startedAt)<Date.parse(previous.startedAt)||Date.parse(input.time)<Date.parse(previous.lastCheckedAt??previous.startedAt)||!Array.isArray(previous.cases))throw new Error('小时预测观察窗口无效');
  const records=structuredClone(previous.cases),known=new Map(records.map(row=>[row.key,row]));
  if(known.size!==records.length||records.some(row=>!row.key||!['point','deadline'].includes(row.mode)||!['unknown','public_completion','cancelled'].includes(row.outcome)||!valid(row.statementAt)||!valid(row.availableAt)||!valid(row.expectedAt)||Date.parse(row.availableAt)<Date.parse(previous.startedAt)||Date.parse(row.statementAt)>Date.parse(row.availableAt)||Date.parse(row.expectedAt)<=Date.parse(row.availableAt)||Date.parse(row.availableAt)>Date.parse(previous.lastCheckedAt??previous.startedAt)||row.outcome==='public_completion'&&(!row.completionAt||!valid(row.completionAt)||Date.parse(row.completionAt)<=Date.parse(row.availableAt)||Date.parse(row.completionAt)>Date.parse(previous.lastCheckedAt??previous.startedAt)||(row.mode==='point'?(row.absoluteErrorHours!==Math.abs(Date.parse(row.completionAt)-Date.parse(row.expectedAt))/3_600_000||row.withinOneHour!==(row.absoluteErrorHours<=1)):row.withinDeadline!==(Date.parse(row.completionAt)<=Date.parse(row.expectedAt))))))throw new Error('已冻结的小时预测记录无效');
  const publications=input.publications.filter(pub=>valid(pub.publishedAt)&&valid(pub.cutoffAt)&&Date.parse(pub.publishedAt)<=Date.parse(input.time)&&Date.parse(pub.cutoffAt)<=Date.parse(input.time)&&input.automaticPublicationIds.has(pub.id)&&pub.mode!=='news_only'&&pub.article.publicationMode!=='news_only'&&pub.article.status==='published'&&pub.event.status==='published'&&!isHistoricalArticle(pub.article,input.evidence))
    .sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt)||a.id.localeCompare(b.id));
  for(const pub of publications)for(const action of pub.event.actions){
    if(action.scope!=='public'||!valid(action.statementAt)||Date.parse(action.statementAt)>Date.parse(input.time))continue;
    const cited=input.evidence.filter(item=>action.evidenceIds.includes(item.id));
    // A carried action in a new product article cannot create an announcement.
    if(!cited.length||cited.length!==new Set(action.evidenceIds).size||cited.some(item=>item.provenance==='manual'||item.historical||!valid(item.collectedAt)||!valid(item.publishedAt)||Date.parse(item.collectedAt)>Date.parse(pub.cutoffAt)||Date.parse(item.publishedAt)>Date.parse(pub.cutoffAt))||!cited.some(item=>Date.parse(item.publishedAt)===Date.parse(action.statementAt)))continue;
    const key=`${pub.eventId}:${action.id}:${action.kind}`,availableAt=new Date(Math.max(Date.parse(pub.publishedAt),Date.parse(pub.cutoffAt))).toISOString();
    if(['promised','in_progress'].includes(action.stage)&&action.expectedAt&&valid(action.expectedAt)&&!known.has(key)&&Date.parse(availableAt)>=Date.parse(previous.startedAt)&&Date.parse(action.statementAt)>=Date.parse(previous.startedAt)&&Date.parse(action.statementAt)<=Date.parse(availableAt)&&Date.parse(action.expectedAt)>Date.parse(availableAt)){
      // The parser labels points explicitly. Older unlabelled times are not
      // reinterpreted as deadlines merely to improve their score.
      const point=/^原文(?:近似时间|预计时刻)/.test(action.timeNote??'');
      const deadline=!point&&(/^原文承诺日终/.test(action.timeNote??'')||/\b(?:by|before|within)\b|最晚|结束前|(?:小时|分钟)内/i.test(action.evidenceQuote??''));
      if(!point&&!deadline)continue;
      const row:HourlyPredictionCase={key,eventId:pub.eventId,actionId:action.id,kind:action.kind,publicationId:pub.id,evidenceIds:[...action.evidenceIds],statementAt:action.statementAt,availableAt,expectedAt:action.expectedAt,mode:deadline?'deadline':'point',outcome:'unknown'};
      records.push(row);known.set(key,row);
    }
    const row=known.get(key);
    if(!row||row.outcome!=='unknown'||Date.parse(action.statementAt)<=Date.parse(row.availableAt)||Date.parse(availableAt)<=Date.parse(row.availableAt))continue;
    if(action.stage==='cancelled'){row.outcome='cancelled';continue;}
    if(action.stage!=='claimed_complete')continue;
    row.outcome='public_completion';row.completionAt=action.statementAt;row.completionPublicationId=pub.id;
    if(row.mode==='deadline')row.withinDeadline=Date.parse(action.statementAt)<=Date.parse(row.expectedAt);
    else{row.absoluteErrorHours=Math.abs(Date.parse(action.statementAt)-Date.parse(row.expectedAt))/3_600_000;row.withinOneHour=row.absoluteErrorHours<=1;}
  }
  const points=records.filter(row=>row.outcome==='public_completion'&&row.mode==='point'),deadlines=records.filter(row=>row.outcome==='public_completion'&&row.mode==='deadline');
  return {state:{...previous,lastCheckedAt:input.time,cases:records},summary:{target:'later_public_completion_statement',firstTimedRounds:records.length,pointCases:points.length,pointWithinOneHour:points.filter(row=>row.withinOneHour).length,deadlineCases:deadlines.length,withinDeadline:deadlines.filter(row=>row.withinDeadline).length,unknownRounds:records.filter(row=>row.outcome==='unknown').length,cancelledRounds:records.filter(row=>row.outcome==='cancelled').length,accountDeliveryMeasured:false}};
}
