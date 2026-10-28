import type { Activity, Publication, PublicData } from './types';
import { publicationSourceTime, publicationWithdrawn } from './public-facts';

export const MAX_ACTIVITY_PUBLICATIONS = 8;
export const MAX_ACTIVITY_SHARE_URL = 1800;
export const ACTIVITY_RULES_NOTICE = '活动规则以当前公布内容为准。';
export interface ActivityShareManifest { activityId:string; day:number; publicationIds:string[]; }
export type ActivityDayShare = ActivityShareManifest;
export class ActivityShareError extends Error { constructor(message:string,public status:400|404|409=400){super(message);} }
export interface ActivityShareSource { id:string; name:string; label:string; url:string; publishedAt:string; }
export interface ActivityShareItem { publication:Publication; sourceTime:string; sources:ActivityShareSource[]; }
export interface ActivityShareReady {
  available:true; manifest:ActivityShareManifest; activity:Activity; date:string; timezone:string;
  publications:Publication[]; items:ActivityShareItem[]; cutoffAt:string; rulesNotice:string; excludedCount:number;
}
export interface ActivityShareBlocked { available:false; blockedReason:string; status:400|404|409; }
export type ActivityShareResult = ActivityShareReady|ActivityShareBlocked;
const blocked=(blockedReason:string,status:ActivityShareBlocked['status']=400):ActivityShareBlocked=>({available:false,blockedReason,status});
const validId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=180&&value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);
const validTime=(value:string)=>Number.isFinite(Date.parse(value));

/** Deduplicate only identical snapshot IDs; never substitute another publication. */
export function normalizeActivityShare(manifest:ActivityShareManifest):ActivityShareManifest {
  if(!manifest||!validId(manifest.activityId))throw new ActivityShareError('活动链接无效，请返回选择活动。');
  if(!Number.isInteger(manifest.day)||manifest.day<1||manifest.day>366)throw new ActivityShareError('请选择有效的活动天数。');
  if(!Array.isArray(manifest.publicationIds)||!manifest.publicationIds.length)throw new ActivityShareError('尚未选择活动内容，请返回后重试。');
  if(manifest.publicationIds.some(value=>!validId(value)))throw new ActivityShareError('分享链接无效，请重新分享。');
  const publicationIds=[...new Set(manifest.publicationIds)].sort();
  if(publicationIds.length>MAX_ACTIVITY_PUBLICATIONS)throw new ActivityShareError(`每日整合海报最多包含${MAX_ACTIVITY_PUBLICATIONS}条记录，请分别分享单条公告。`);
  return {activityId:manifest.activityId,day:manifest.day,publicationIds};
}

/** Repeated parameters preserve IDs containing commas, slashes or Chinese characters. */
export function parseActivityShare(activityId:string,params:URLSearchParams):ActivityShareManifest {
  if(params.toString().length>MAX_ACTIVITY_SHARE_URL)throw new ActivityShareError('分享链接过长，请分别分享单条公告。');
  const days=params.getAll('day');
  if(days.length!==1||! /^[1-9]\d{0,2}$/.test(days[0]))throw new ActivityShareError('请选择有效的活动天数。');
  return normalizeActivityShare({activityId,day:Number(days[0]),publicationIds:params.getAll('publication')});
}
export function activityShareQuery(manifest:ActivityShareManifest):URLSearchParams {
  const selected=normalizeActivityShare(manifest),params=new URLSearchParams();
  params.set('day',String(selected.day));selected.publicationIds.forEach(id=>params.append('publication',id));
  if(params.toString().length>MAX_ACTIVITY_SHARE_URL)throw new ActivityShareError('分享链接过长，请分别分享单条公告。');
  return params;
}
export function activityPublicationUrl(origin:string,manifest:ActivityShareManifest):string {
  const selected=normalizeActivityShare(manifest);
  let base:URL;
  try{base=new URL(origin);}catch{throw new ActivityShareError('无效的网站地址。');}
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new ActivityShareError('无效的网站地址。');
  const url=new URL(`/activities/${encodeURIComponent(selected.activityId)}`,base.origin);
  url.search=activityShareQuery(selected).toString();
  if(url.href.length>MAX_ACTIVITY_SHARE_URL)throw new ActivityShareError('分享链接过长，请分别分享单条公告。');
  return url.href;
}

/** Calendar date in the activity's declared timezone, rather than the reader's timezone. */
export function activityDate(activity:Activity,day:number):string {
  if(!Number.isInteger(activity.days)||activity.days<1||activity.days>366||!Number.isInteger(day)||day<1||day>activity.days)throw new ActivityShareError('天数超出这项活动的范围。');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(activity.startsOn))throw new ActivityShareError('活动日期无效，暂不能生成整合海报。');
  const start=Date.parse(`${activity.startsOn}T00:00:00Z`);
  if(!Number.isFinite(start)||new Date(start).toISOString().slice(0,10)!==activity.startsOn)throw new ActivityShareError('活动日期无效，暂不能生成整合海报。');
  try{new Intl.DateTimeFormat('zh-CN',{timeZone:activity.timezone});}catch{throw new ActivityShareError('活动时区无效，暂不能生成整合海报。');}
  return new Date(start+(day-1)*86400000).toISOString().slice(0,10);
}

/** Read a fully explicit publication set; current articles are used only to detect withdrawal. */
export function resolveActivityShare(data:PublicData,input:ActivityShareManifest):ActivityShareResult {
  let manifest:ActivityShareManifest;
  try{manifest=normalizeActivityShare(input);}catch(error){return blocked(error instanceof Error?error.message:'活动分享链接无效，请返回后重试。');}
  const activity=data.activities.find(item=>item.id===manifest.activityId);
  if(!activity)return blocked('未找到这项已公开的活动。',404);
  let date:string;
  try{date=activityDate(activity,manifest.day);}catch(error){return blocked(error instanceof Error?error.message:'活动日期无效。');}
  const seenArticles=new Set<string>(),items:ActivityShareItem[]=[];
  for(const id of manifest.publicationIds){
    const publication=data.publications.find(item=>item.id===id);
    if(!publication)return blocked('部分分享内容已不可用，请查看活动最新进展。',404);
    if(publication.event.id!==publication.eventId||publication.article.id!==publication.articleId||publication.article.eventId!==publication.eventId||publication.article.publicationId!==publication.id)return blocked('分享内容暂不可用，请返回活动页重新生成。',409);
    const event=data.events.find(item=>item.id===publication.eventId),article=data.articles.find(item=>item.id===publication.articleId);
    if(!event||!article)return blocked('分享内容暂不可用，请返回活动页重新生成。',404);
    if(publicationWithdrawn(data,publication))return blocked('所选记录包含已撤回内容，请分别查看仍有效的公告。',409);
    if(event.status==='merged'||publication.event.status==='merged')return blocked('部分进展已并入其他消息，请返回活动页查看。',409);
    if(event.status!=='published'||article.status!=='published'||publication.event.status!=='published'||publication.article.status!=='published')return blocked('所选记录尚未公开，不能生成海报。',409);
    const links=activity.items.filter(item=>item.articleId===publication.articleId);
    if(!links.length||links.some(item=>item.day!==manifest.day||item.eventId!==publication.eventId)||article.eventId!==publication.eventId)return blocked('分享内容与所选活动日期不一致，请重新选择。',409);
    if(seenArticles.has(publication.articleId))return blocked('同一条消息请勿重复选择。',409);
    seenArticles.add(publication.articleId);
    const sourceTime=publicationSourceTime(publication);
    if(!validTime(sourceTime)||!validTime(publication.cutoffAt)||!validTime(publication.publishedAt))return blocked('消息时间暂不可用，请稍后再生成海报。',409);
    const evidenceIds=[...new Set(publication.article.evidenceIds)],sources:ActivityShareSource[]=[];
    if(!evidenceIds.length)return blocked('消息来源暂不可用，请稍后再生成海报。',409);
    for(const id of evidenceIds){
      const evidence=data.evidence.find(item=>item.id===id);
      if(!evidence||!validTime(evidence.publishedAt))return blocked('部分来源暂不可用，请稍后再生成海报。',409);
      const labels={official:'官方资料',archive:'第三方收录',manual:'补充来源'};
      sources.push({id:evidence.id,name:data.sources.find(item=>item.id===evidence.sourceId)?.name??labels[evidence.provenance],label:labels[evidence.provenance],url:evidence.url,publishedAt:evidence.publishedAt});
    }
    items.push({publication,sourceTime,sources});
  }
  items.sort((a,b)=>Date.parse(a.sourceTime)-Date.parse(b.sourceTime)||a.publication.id.localeCompare(b.publication.id));
  const cutoffAt=items.map(item=>item.publication.cutoffAt).sort((a,b)=>Date.parse(b)-Date.parse(a))[0];
  return {available:true,manifest,activity,date,timezone:activity.timezone,publications:items.map(item=>item.publication),items,cutoffAt,rulesNotice:ACTIVITY_RULES_NOTICE,excludedCount:0};
}

/** Called only when the reader selects a day; freeze its currently published article versions. */
export function buildActivityShare(data:PublicData,activityId:string,day:number):ActivityDayShare {
  if(!validId(activityId)||!Number.isInteger(day))throw new ActivityShareError('活动分享链接无效，请返回后重试。');
  const activity=data.activities.find(item=>item.id===activityId);
  if(!activity)throw new ActivityShareError('未找到这项已公开的活动。',404);
  activityDate(activity,day);
  const ids:string[]=[],seen=new Set<string>();
  for(const item of activity.items.filter(item=>item.day===day)){
    if(seen.has(item.articleId))continue;seen.add(item.articleId);
    const article=data.articles.find(article=>article.id===item.articleId),event=data.events.find(event=>event.id===item.eventId);
    if(!article||!event||article.eventId!==item.eventId)throw new ActivityShareError('这一天的活动内容暂不可用，请稍后再生成海报。',409);
    if(article.status!=='published'||event.status!=='published')continue;
    ids.push(article.publicationId);
  }
  if(!ids.length)throw new ActivityShareError('这一天暂无可整合的已发布内容，可在有公开记录后再试。');
  const result=resolveActivityShare(data,{activityId,day,publicationIds:ids});
  if(!result.available)throw new ActivityShareError(result.blockedReason,result.status);
  return result.manifest;
}
