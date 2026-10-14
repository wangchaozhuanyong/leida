import {getPublicData} from '@/server/service';
import {json,apiError} from '@/server/http';
import {posterSvg} from '@/server/poster';
import {statusPosterSvg,currentStatusPosterSvg,type StatusPosterCode} from '@/server/status-poster';
import {parseStatusPosterOptions,type StatusPosterCodeState} from '@/lib/status-poster-style';
import {WechatServiceError} from '@/server/wechat-errors';
import {activityPosterSvg,resolveActivityPoster} from '@/server/activity-poster';
import {activityPublicationUrl,parseActivityShare} from '@/lib/activity-share';
import {publicationUrl,requestShareOrigin} from '@/lib/share';
import type {PublicData} from '@/lib/types';
import {getPublicVersion,publicRevision} from '@/server/public-version';
import {generateWechatCode,publicWechatAvailability,resolveWechatScene} from '@/server/wechat';
import {publicActions,publicationWithdrawn} from '@/lib/public-facts';
import {publicResetOutlook} from '@/lib/reset-outlook';
import {getForecastSnapshot,getResetCadenceSnapshot} from '@/server/forecast';
import {forecastPosterSvg} from '@/server/forecast-poster';
import {getLightPublicVersion,getPublicRead,parsePublicRead} from '@/server/public-read';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{path:string[]}>}){try{const {path}=await params;const [kind,id]=path;
 if(kind==='version'&&new URL(request.url).searchParams.get('light')==='1'){const state=await getLightPublicVersion(),etag=`"${state.version}"`;if(request.headers.get('if-none-match')===etag)return new Response(null,{status:304,headers:{ETag:etag,'Cache-Control':'no-store'}});return Response.json({data:state},{headers:{ETag:etag,'Cache-Control':'no-store'}});}
 if((kind==='bootstrap'||kind==='status')&&new URL(request.url).searchParams.has('view'))return Response.json(await getPublicRead(parsePublicRead(new URL(request.url).searchParams)),{headers:{'Cache-Control':'no-store'}});
 if(kind==='version'){const version=await getPublicVersion();const etag=`"${version}"`;if(request.headers.get('if-none-match')===etag)return new Response(null,{status:304,headers:{ETag:etag,'Cache-Control':'no-store'}});return Response.json({data:{version}},{headers:{ETag:etag,'Cache-Control':'no-store'}});}
 if(kind==='wechat'&&id==='availability'&&path.length===2)return json(await publicWechatAvailability());
 if(kind==='wechat'&&id==='code'&&path.length===3){const code=await generateWechatCode(path[2]);return json({...code,image:undefined,imageBase64:code.image.toString('base64')});}
 if(kind==='wechat'&&id==='scene'&&path.length===3)return json(await resolveWechatScene(path[2]));
 if(kind==='forecasts'&&id==='cadence'&&path.length===3){const snapshot=await getResetCadenceSnapshot(path[2]);if(!snapshot)throw Object.assign(new Error('未找到固定重置时间预测'),{status:404});return json(snapshot);}
 if(kind==='forecasts'&&path.length<=2){if(!id)return json((await getPublicData()).forecasts);const snapshot=await getForecastSnapshot(id);if(!snapshot)throw Object.assign(new Error('未找到固定预测快照'),{status:404});return json(snapshot);}
 const data=await getPublicData();
 if(kind==='status'||kind==='bootstrap')return Response.json({data,version:publicRevision(data)},{headers:{'Cache-Control':'no-store'}});
 if(kind==='health')return json({database:'ready',serverTime:data.serverTime,sources:data.sources});
 if(kind==='forecast-posters'&&id&&path.length===2){const snapshot=await getForecastSnapshot(id);if(!snapshot)throw Object.assign(new Error('未找到固定预测快照'),{status:404});const shareUrl=`${requestShareOrigin(request)}/methodology?snapshot=${encodeURIComponent(snapshot.id)}`;return new Response(forecastPosterSvg(snapshot,data.site.name,shareUrl),{headers:{'Content-Type':'image/svg+xml; charset=utf-8','Content-Disposition':'attachment; filename="moyao-radar-forecast.svg"','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"}});}
 if(kind==='activity-posters'&&id){const selected=resolveActivityPoster(data,parseActivityShare(id,new URL(request.url).searchParams));const shareUrl=activityPublicationUrl(requestShareOrigin(request),selected.manifest);return new Response(activityPosterSvg(selected,data.site.name,shareUrl),{headers:{'Content-Type':'image/svg+xml; charset=utf-8','Content-Disposition':'attachment; filename="moyao-radar-activity-day.svg"','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"}})}
 if(kind==='posters'&&id==='current'){
  const url=new URL(request.url),options=parseStatusPosterOptions(url.searchParams);
  const at=url.searchParams.get('at')??data.serverTime;
  if(!Number.isFinite(Date.parse(at))||Math.abs(Date.parse(at)-Date.now())>86400000)throw Object.assign(new Error('海报时间已失效，请重新生成'),{status:400});
  const round=url.searchParams.get('round')??'waiting';
  // Validate the round before any provider call. A later state never retargets an open poster.
  currentStatusPosterSvg(data,at,round,options.style);
  let code:StatusPosterCode|undefined;
  if(options.includeCode&&round!=='waiting'){try{code=await generateWechatCode(round);}catch(error){if(!(error instanceof WechatServiceError))throw error;}}
  return new Response(currentStatusPosterSvg(data,at,round,options.style,code),{headers:{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",'X-Poster-Code':code?'included':options.includeCode?'unavailable':'omitted'}});
 }
 if(kind==='posters'&&id){
  const p=data.publications.find(p=>p.id===id);if(!p)throw Object.assign(new Error('未找到已发布版本'),{status:404});
  if(publicationWithdrawn(data,p))throw Object.assign(new Error('该内容已撤回，暂不生成海报'),{status:410});
  const url=new URL(request.url),shareUrl=publicationUrl(requestShareOrigin(request),p);
  let svg:string,posterCodeState:StatusPosterCodeState|undefined;
  if(url.searchParams.get('layout')==='status'){
   const actionId=url.searchParams.get('action');
   if(!actionId||!p.event.actions.some(action=>action.id===actionId&&action.scope==='public'&&action.stage==='claimed_complete'))throw Object.assign(new Error('未找到可分享的公开完成声明'),{status:400});
   let code:StatusPosterCode|undefined;
   let options:ReturnType<typeof parseStatusPosterOptions>;
   try{options=parseStatusPosterOptions(url.searchParams);}catch{throw Object.assign(new Error('海报样式或圆码选项无效'),{status:400});}
   if(options.includeCode){try{code=await generateWechatCode(p.id);}catch(error){if(!(error instanceof WechatServiceError))throw error;}}
   if(options.style)posterCodeState=code?'included':options.includeCode?'unavailable':'omitted';
   const generatedAt=url.searchParams.get('at')??new Date().toISOString();
   if(!Number.isFinite(Date.parse(generatedAt))||Math.abs(Date.parse(generatedAt)-Date.now())>86400000)throw Object.assign(new Error('海报时间已失效，请重新生成'),{status:400});
   const active=publicResetOutlook(data).active;
   const nextAction=active?publicActions(data).find(item=>item.publication.id===active.publicationId&&item.action.id===active.actionId)?.action:undefined;
   svg=statusPosterSvg({publication:p,actionId,name:data.site.name,generatedAt,shareUrl,nextAction,code,style:options.style,evidence:data.evidence});
  }else svg=posterSvg(p,data.site.name,shareUrl);
  return new Response(svg,{headers:{'Content-Type':'image/svg+xml; charset=utf-8','Content-Disposition':'attachment; filename="moyao-radar-poster.svg"','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",...(posterCodeState?{'X-Poster-Code':posterCodeState}:{})}})
 }
 if(kind==='history'){const map=new Map<string,{date:string;announcementCount:number;completedActions:number;actions:unknown[]}>();const seen=new Set<string>();for(const {action} of publicActions(data)){const date=new Date(Date.parse(action.statementAt)+8*3600000).toISOString().slice(0,10);const day=map.get(date)||{date,announcementCount:0,completedActions:0,actions:[]};if(!seen.has(action.id)){day.actions.push(action);if(action.stage==='claimed_complete')day.completedActions++;seen.add(action.id)}map.set(date,day)}for(const a of data.articles.filter(a=>a.status==='published'&&a.publicationMode!=='news_only'&&data.events.some(e=>e.id===a.eventId&&e.actions.length>0))){const date=new Date(Date.parse(a.sourcePublishedAt??a.publishedAt)+8*3600000).toISOString().slice(0,10);const day=map.get(date)||{date,announcementCount:0,completedActions:0,actions:[]};day.announcementCount++;map.set(date,day)}return json([...map.values()].sort((a,b)=>b.date.localeCompare(a.date)))}
 const keys={events:'events',articles:'articles',sources:'evidence',activities:'activities',notices:'notices',publications:'publications'} as const;
 const key=keys[kind as keyof typeof keys];if(!key)throw Object.assign(new Error('未找到页面'),{status:404});
 const list=data[key] as PublicData[typeof key];if(id){const item=list.find(item=>item.id===id);if(!item)throw Object.assign(new Error('未找到公开记录'),{status:404});return json(item)}
 const url=new URL(request.url),limit=Math.max(1,Math.min(100,Number(url.searchParams.get('limit'))||20)),cursor=url.searchParams.get('cursor');const start=cursor?list.findIndex(item=>item.id===cursor)+1:0;if(cursor&&start===0)throw Object.assign(new Error('分页位置已失效，请刷新'),{status:400});const rows=list.slice(start,start+limit);return Response.json({data:rows,nextCursor:start+limit<list.length?rows.at(-1)?.id:null,serverTime:data.serverTime},{headers:{'Cache-Control':'no-store'}});
 }catch(e){return apiError(e)}}
