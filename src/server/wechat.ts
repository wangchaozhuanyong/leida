import { lockTransaction } from '../db';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {isCloudbaseClient,list,one,put,insert,transaction,type Client,type Table} from '../db';
import type {Article,Evidence,Job,Notice,Publication,RadarEvent} from '../lib/types';
import type {WechatSettings,WechatReader,WechatGrant,WechatDelivery,WechatSubscriptionState} from '../lib/wechat';
import {isHistoricalArticle} from '../lib/history';
import {DomainError,id} from './domain';
import {createWechatProvider,WechatServiceError} from './wechat-provider';
import {validateWechatImage} from './wechat-image';
import {prepareNotificationPublicPage} from './notification-public-page';

// Application ceilings, independent of the provider's quota and existing daily budget.
export const WECHAT_DISPATCH_BATCH_SIZE=50;
export const WECHAT_SEND_MAX_PER_SECOND=10;

export type WechatRecord=WechatSettings&{id:'wechat';encryptedSecret?:string};
export const defaultWechat:WechatRecord={id:'wechat',appId:'',qrEnabled:false,subscriptionsEnabled:false,envVersion:'release',templateId:'',templateFields:{title:'',status:'',time:''},dailyApiLimit:0,dailyQrLimit:0,dailySendLimit:0,version:1,hasSecret:false};
export interface WechatStore {
  list<T>(table:Table,client?:Client):Promise<T[]>;
  one<T>(table:Table,id:string,client?:Client,lock?:boolean):Promise<T|undefined>;
  put<T extends {id:string}>(table:Table,value:T,client?:Client):Promise<void>;
  insert<T extends {id:string}>(table:Table,value:T,client?:Client):Promise<boolean>;
  transaction<T>(fn:(client:Client)=>Promise<T>):Promise<T>;
}
export interface WechatDependencies {store?:WechatStore;fetcher?:typeof fetch;clock?:()=>number;encryptionKey?:()=>Buffer;preparePublicPage?:(publicationId:string)=>Promise<void>;}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const publicationScene=(publicationId:string)=>digest(publicationId).slice(0,32);
export function publicationForScene(scene:string,publications:Publication[]):Publication {
  if(!/^[a-f0-9]{32}$/.test(scene))throw new DomainError('小程序码参数无效');
  const matches=publications.filter(publication=>publicationScene(publication.id)===scene);
  if(matches.length!==1)throw new DomainError(matches.length?'小程序码标识冲突':'未找到对应发布版本',matches.length?409:404);
  return matches[0];
}
export function assertWechatPublication(publication:Publication,event?:RadarEvent,article?:Article):void {
  if(!event||!article||publication.event.status!=='published'||publication.article.status!=='published'||event.status!=='published'||article.status!=='published')throw new DomainError('该内容已撤回、合并或不可分享',410);
}
const fieldSchema=z.object({title:z.string().regex(/^thing\d{1,3}$/),status:z.string().regex(/^(?:thing|phrase)\d{1,3}$/),time:z.string().regex(/^(?:time|date)\d{1,3}$/)}).refine(fields=>new Set(Object.values(fields)).size===3,'模板字段不能重复');
const publicQuotaActions=(publication:Publication)=>publication.event.actions.filter(action=>action.scope==='public'&&['automatic_reset','banked_reset'].includes(action.kind));
const isQuotaPublication=(publication:Publication)=>publicQuotaActions(publication).length>0||publication.article.category==='reset'&&publication.event.actions.length===0;
export function wechatTemplateData(settings:WechatSettings,notice:Notice,publication?:Publication):Record<string,{value:string}> {
  let fields:WechatSettings['templateFields'];try {fields=fieldSchema.parse(settings.templateFields);}catch {throw new WechatServiceError('模板字段未配置或类型不兼容','configuration');}
  let status=notice.categories.includes('correction')?'重要更正':notice.categories.includes('result')?'公告称完成':notice.categories.includes('activity')?'活动更新':'发放预告';
  // Keep the factual qualifier at the beginning even when a long title is truncated.
  let title=notice.categories.includes('result')?`公告称完成：${notice.title.replace(/^公告称(?:已)?(?:完成|发放)[：:]?/,'')}`:notice.title;
  if(publication){
    if(publication.id!==notice.publicationId||!isQuotaPublication(publication))throw new WechatServiceError('此内容不属于额度重置提醒','configuration');
    const actions=publicQuotaActions(publication),kinds=new Set(actions.map(action=>action.kind)),stages=new Set(actions.map(action=>action.stage));
    // The actual template labels this field as quota type, not an article title.
    title=kinds.size>1?'用量重置与重置卡':kinds.has('banked_reset')?'重置卡':'编程套餐额度';
    if(notice.categories.includes('correction'))status='公告更正';
    else if(stages.size>1)status='公开进展更新';
    else if(stages.size===1)status={promised:'已公布计划',in_progress:'公告称进行中',claimed_complete:'公告称完成',cancelled:'公告已取消'}[actions[0].stage];
    // Mixed stages must never imply every benefit is complete; phrase fields allow five characters.
    if(fields.status.startsWith('phrase')&&Array.from(status).length>5)status='进展已更新';
  }
  const at=Date.parse(notice.createdAt);if(!Number.isFinite(at))throw new WechatServiceError('消息时间无效','configuration');
  const time=new Date(at+8*3600_000).toISOString().slice(0,16).replace('T',' ');
  return {[fields.title]:{value:Array.from(title.replace(/[\r\n\x00-\x1f]/g,' ')).slice(0,20).join('')},[fields.status]:{value:status},[fields.time]:{value:fields.time.startsWith('date')?time.slice(0,10):time}};
}
export function createWechatService(dependencies:WechatDependencies={}) {
  const store=dependencies.store??{list,one,put,insert,transaction};
  const provider=createWechatProvider(dependencies.fetcher);
  const tokenFlights=new Map<string,Promise<string>>();
  const codeFlights=new Map<string,Promise<{image:Buffer;contentType:string;scene:string;publicationId:string}>>();
  const clock=dependencies.clock??Date.now;
  const preparePublicPage=dependencies.preparePublicPage??prepareNotificationPublicPage;
  const timestamp=()=>new Date(clock()).toISOString();
  const key=()=>{const value=dependencies.encryptionKey?.()??Buffer.from(process.env.ENCRYPTION_KEY??'','base64');if(value.length!==32)throw new WechatServiceError('服务端加密密钥不可用','configuration');return value;};
  // Same AES-256-GCM storage format as the existing smart-service credential.
  function seal(value:string):string {const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv),body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');}
  function open(value:string):string {try{const raw=Buffer.from(value,'base64');if(raw.length<29)throw new Error();const cipher=createDecipheriv('aes-256-gcm',key(),raw.subarray(0,12));cipher.setAuthTag(raw.subarray(12,28));return Buffer.concat([cipher.update(raw.subarray(28)),cipher.final()]).toString('utf8');}catch{throw new WechatServiceError('微信加密凭据无法读取，请检查服务端恢复配置','configuration');}}
  const lock=(client:Client,name:string)=>lockTransaction(client,name);
  const config=(client?:Client)=>store.one<WechatRecord>('settings','wechat',client).then(value=>value??defaultWechat);
  const ready=(settings:WechatRecord,kind:'qr'|'subscription')=>Boolean(settings.appId&&settings.encryptedSecret&&settings.dailyApiLimit>0&&(kind==='qr'?settings.qrEnabled&&settings.dailyQrLimit>0:settings.subscriptionsEnabled&&settings.dailySendLimit>0&&settings.templateId&&fieldSchema.safeParse(settings.templateFields).success));
  // Public UI readiness only: no credentials, quota reservations or provider requests.
  async function publicWechatAvailability():Promise<{available:boolean;codeAvailable:boolean}> {
    const settings=await config();
    return {available:ready(settings,'qr')&&ready(settings,'subscription'),codeAvailable:ready(settings,'qr')};
  }
  const day=()=>new Date(clock()+8*3600_000).toISOString().slice(0,10);
  const tomorrow=()=>new Date(Date.parse(`${day()}T00:00:00+08:00`)+24*3600_000).toISOString();
  async function usage(kind:'login'|'token'|'qr'|'send',existingClient?:Client,expectedVersion?:number) {
    const reserve=async(client:Client)=>{
      await lock(client,'wechat_usage');const settings=await config(client);
      if(expectedVersion!==undefined&&settings.version!==expectedVersion)throw new WechatServiceError('微信配置已变化，请稍后重试','configuration');
      if(kind==='qr'&&!ready(settings,'qr')||(['login','send'].includes(kind))&&!ready(settings,'subscription')||kind==='token'&&!ready(settings,'qr')&&!ready(settings,'subscription'))throw new WechatServiceError('微信功能尚未配置或已关闭','configuration');
      const usageId=`wechat_usage_${day()}`;const previous=await store.one<{id:string;calls:number;codes:number;sends:number;logins?:number;loginWindowAt?:number;loginWindowCount?:number}>('settings',usageId,client)??{id:usageId,calls:0,codes:0,sends:0};
      const windowFresh=Number.isFinite(previous.loginWindowAt)&&clock()-previous.loginWindowAt!<60_000,windowCount=windowFresh?previous.loginWindowCount??0:0;
      if(kind==='login'&&((previous.logins??0)>=Math.max(1,Math.floor(settings.dailyApiLimit/4))||windowCount>=10))throw new WechatServiceError('微信登录调用已达限制，请稍后再试','budget');
      if(previous.calls>=settings.dailyApiLimit||kind==='qr'&&previous.codes>=settings.dailyQrLimit||kind==='send'&&previous.sends>=settings.dailySendLimit)throw new WechatServiceError('今日微信接口调用上限已达，次日恢复','budget');
      const updated={...previous,calls:previous.calls+1,codes:previous.codes+(kind==='qr'?1:0),sends:previous.sends+(kind==='send'?1:0),logins:(previous.logins??0)+(kind==='login'?1:0),loginWindowAt:kind==='login'?(windowFresh?previous.loginWindowAt:clock()):previous.loginWindowAt,loginWindowCount:kind==='login'?windowCount+1:previous.loginWindowCount};await store.put('settings',updated,client);return settings;
    };return existingClient?reserve(existingClient):store.transaction(reserve);
  }
  async function adminWechat():Promise<WechatSettings> {
    const value=await config(),counts=await store.one<{calls:number;codes:number;sends:number}>('settings',`wechat_usage_${day()}`);
    const safe:WechatSettings={appId:value.appId,qrEnabled:value.qrEnabled,subscriptionsEnabled:value.subscriptionsEnabled,envVersion:value.envVersion,templateId:value.templateId,templateFields:value.templateFields,dailyApiLimit:value.dailyApiLimit,dailyQrLimit:value.dailyQrLimit,dailySendLimit:value.dailySendLimit,version:value.version,updatedAt:value.updatedAt,hasSecret:!!value.encryptedSecret};
    let deliveries:WechatSettings['deliveries'];
    try {const rows=await store.list<WechatDelivery>('wechat_deliveries');deliveries={queued:rows.filter(row=>row.status==='queued'||row.status==='sending').length,sent:rows.filter(row=>row.status==='sent').length,rejected:rows.filter(row=>row.status==='rejected').length,unknown:rows.filter(row=>row.status==='unknown').length,cancelled:rows.filter(row=>row.status==='cancelled').length};}
    catch(error) {if((error as {code?:string}).code!=='42P01')throw error;}
    return {...safe,hasSecret:!!value.encryptedSecret,callsToday:counts?.calls??0,codesToday:counts?.codes??0,sendsToday:counts?.sends??0,deliveries};
  }
  async function saveWechatSettings(input:unknown,actor:string):Promise<WechatSettings> {
    const parsed=z.object({version:z.number().int().positive(),appId:z.string().regex(/^wx[a-fA-F0-9]{16}$/).or(z.literal('')),qrEnabled:z.boolean(),subscriptionsEnabled:z.boolean(),envVersion:z.enum(['release','trial','develop']),templateId:z.string().max(128),templateFields:z.object({title:z.string().max(30),status:z.string().max(30),time:z.string().max(30)}),dailyApiLimit:z.number().int().min(0).max(100000),dailyQrLimit:z.number().int().min(0).max(10000),dailySendLimit:z.number().int().min(0).max(10000),secret:z.string().max(512).optional()}).parse(input);
    if(parsed.subscriptionsEnabled&&!fieldSchema.safeParse(parsed.templateFields).success)throw new DomainError('请填写与微信实际模板一致的标题、状态和时间字段');
    await store.transaction(async client=>{
      await lock(client,'wechat_config');const previous=await config(client);if(previous.version!==parsed.version)throw new DomainError('微信配置已变化，请刷新后重试',409);
      const secret=parsed.secret?.trim();const changedApp=previous.appId!==parsed.appId;
      const encryptedSecret=secret?seal(secret):changedApp?undefined:previous.encryptedSecret;
      const {secret:_inputSecret,...safe}=parsed;
      const next:WechatRecord={...safe,id:'wechat',encryptedSecret,hasSecret:!!encryptedSecret,version:previous.version+1,updatedAt:timestamp()};
      if(next.qrEnabled&&!ready(next,'qr')||next.subscriptionsEnabled&&!ready(next,'subscription'))throw new DomainError('启用微信功能前请配置账号、密钥、模板与调用上限');
      await store.put('settings',next,client);
      await store.insert('audits',{id:id('audit'),actor,action:'wechat.save',objectId:'wechat',reason:'更新微信小程序配置',createdAt:timestamp(),after:{...safe,hasSecret:!!encryptedSecret,version:next.version}},client);
    });return adminWechat();
  }
  async function accessToken(settings:WechatRecord):Promise<string> {
    const tokenId=`wechat_token_${digest(settings.appId).slice(0,24)}`;
    const flightKey=`${tokenId}:${settings.version}`;const pending=tokenFlights.get(flightKey);if(pending)return pending;
    const refreshing=(async()=>{
      const cached=await store.one<{id:string;encryptedToken:string;expiresAt:string;version:number}>('settings',tokenId);
      if(cached?.version===settings.version&&Date.parse(cached.expiresAt)>clock()+30_000)return open(cached.encryptedToken);
      // Commit quota before I/O: a failed provider call still consumed an attempt.
      await usage('token',undefined,settings.version);const token=await provider.accessToken(settings.appId,open(settings.encryptedSecret!));
      await store.put('settings',{id:tokenId,encryptedToken:seal(token.token),expiresAt:new Date(clock()+(token.expiresIn-5)*1000).toISOString(),version:settings.version});return token.token;
    })();tokenFlights.set(flightKey,refreshing);try{return await refreshing;}finally{tokenFlights.delete(flightKey);}
  }
  async function publication(publicationId:string,client?:Client) {
    const value=await store.one<Publication>('publications',publicationId,client);if(!value)throw new DomainError('未找到已发布版本',404);
    const [event,article]=await Promise.all([store.one<RadarEvent>('events',value.eventId,client),store.one<Article>('articles',value.articleId,client)]);assertWechatPublication(value,event,article);return value;
  }
  async function resolveWechatScene(scene:string):Promise<{publicationId:string}> {const value=publicationForScene(scene,await store.list<Publication>('publications'));await publication(value.id);return {publicationId:value.id};}
  async function generateWechatCode(publicationId:string):Promise<{image:Buffer;contentType:string;scene:string;publicationId:string}> {
    await publication(publicationId);const settings=await config();if(!ready(settings,'qr'))throw new WechatServiceError('微信小程序码尚未配置','configuration');
    const scene=publicationScene(publicationId);if(publicationForScene(scene,await store.list<Publication>('publications')).id!==publicationId)throw new DomainError('小程序码标识冲突',409);
    const cacheId=`wechat_code_${digest(`${settings.appId}:${settings.envVersion}:pages/detail/index:${publicationId}`)}`;
    const pending=codeFlights.get(cacheId);if(pending)return pending;
    const generating=(async()=>{
      const claimId=randomBytes(16).toString('hex');
      const cached=await store.transaction(async client=>{
        await lock(client,'wechat_config');await lock(client,cacheId);const currentSettings=await config(client);
        if(currentSettings.version!==settings.version||!ready(currentSettings,'qr'))throw new WechatServiceError('微信配置已变化，请稍后重试','configuration');
        const cache=await store.one<{base64?:string;contentType?:string;status?:string;leaseUntil?:string}>('settings',cacheId,client);
        if(cache?.base64&&['image/png','image/jpeg'].includes(cache.contentType??'')){const image=Buffer.from(cache.base64,'base64');try{const contentType=validateWechatImage(image);return {image,contentType,scene,publicationId};}catch{/* An invalid old cache is regenerated under this same lease. */}}
        if(cache?.status==='generating'&&Date.parse(cache.leaseUntil??'')>clock())throw new WechatServiceError('小程序码正在生成，请稍后重试','transient');
        await store.put('settings',{id:cacheId,status:'generating',claimId,leaseUntil:new Date(clock()+60_000).toISOString(),publicationId},client);return undefined;
      });if(cached)return cached;
      try {
        const token=await accessToken(settings);await usage('qr',undefined,settings.version);const result=await provider.code(token,scene,settings.envVersion);
        // Recheck withdrawal and active account after the external request.
        await store.transaction(async client=>{await lock(client,'wechat_config');await lock(client,cacheId);await publication(publicationId,client);const active=await config(client),cache=await store.one<{claimId:string}>('settings',cacheId,client);if(active.version!==settings.version||!ready(active,'qr')||cache?.claimId!==claimId)throw new WechatServiceError('微信配置或生成请求已变化，请稍后重试','configuration');await store.put('settings',{id:cacheId,status:'ready',base64:result.image.toString('base64'),contentType:result.contentType,scene,publicationId},client);});return {...result,scene,publicationId};
      } catch(error) {await store.transaction(async client=>{await lock(client,cacheId);const cache=await store.one<{claimId?:string}>('settings',cacheId,client);if(cache?.claimId===claimId)await store.put('settings',{id:cacheId,status:'failed',publicationId},client);});throw error;}
    })();codeFlights.set(cacheId,generating);try{return await generating;}finally{codeFlights.delete(cacheId);}
  }
  async function reader(sessionToken:string,client?:Client):Promise<WechatReader> {
    if(!/^[A-Za-z0-9_-]{43}$/.test(sessionToken))throw new DomainError('请重新打开微信提醒管理',401);
    const sessionHash=digest(sessionToken),settings=await config(client);
    const value=(await store.list<WechatReader>('wechat_readers',client)).find(item=>item.status==='active'&&item.appId===settings.appId&&item.sessions.some(session=>session.hash===sessionHash&&Date.parse(session.expiresAt)>clock()));
    if(!value)throw new DomainError('微信读者会话已过期，请重新授权',401);return value;
  }
  async function wechatLogin(code:string):Promise<{sessionToken:string;expiresAt:string}> {
    const input=z.string().min(1).max(512).parse(code),settings=await usage('login');
    const openid=await provider.login(settings.appId,open(settings.encryptedSecret!),input);
    const openidHash=digest(`${settings.appId}:${openid}`),readerId=`wxreader_${openidHash}`,sessionToken=randomBytes(32).toString('base64url'),expiresAt=new Date(clock()+7*24*3600_000).toISOString();
    await store.transaction(async client=>{
      await lock(client,readerId);const existing=await store.one<WechatReader>('wechat_readers',readerId,client);
      if(existing?.status==='disabled')throw new DomainError('微信提醒身份已停用',403);
      const sessions=[...(existing?.sessions??[]).filter(session=>Date.parse(session.expiresAt)>clock()).slice(-4),{hash:digest(sessionToken),createdAt:timestamp(),expiresAt}];
      await store.put('wechat_readers',{id:readerId,appId:settings.appId,openidHash,encryptedOpenid:existing?.encryptedOpenid??seal(openid),status:'active',createdAt:existing?.createdAt??timestamp(),lastLoginAt:timestamp(),sessions} satisfies WechatReader,client);
    });return {sessionToken,expiresAt};
  }
  async function subscriptionView(value:WechatReader,client?:Client):Promise<WechatSubscriptionState> {
    const settings=await config(client);if(!ready(settings,'subscription'))return {configured:false,enabled:settings.subscriptionsEnabled,state:'unavailable'};
    const grant=await store.one<WechatGrant>('wechat_grants',`wxgrant_${digest(`${value.id}:${settings.templateId}`)}`,client);
    const deliveries=(await store.list<WechatDelivery>('wechat_deliveries',client)).filter(item=>item.readerId===value.id&&item.templateId===settings.templateId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    const last=deliveries.find(item=>['sent','rejected','unknown','cancelled'].includes(item.status));
    return {configured:true,enabled:true,state:grant?.status==='challenged'&&Date.parse(grant.nonceExpiresAt)<clock()?'none':grant?.status??'none',templateId:settings.templateId,acceptedAt:grant?.acceptedAt,lastResult:last?.status as WechatSubscriptionState['lastResult']};
  }
  async function wechatSubscriptionState(sessionToken:string):Promise<WechatSubscriptionState> {return subscriptionView(await reader(sessionToken));}
  async function wechatSubscriptionChallenge(sessionToken:string) {
    return store.transaction(async client=>{
      const value=await reader(sessionToken,client),settings=await config(client);if(!ready(settings,'subscription'))throw new WechatServiceError('微信提醒尚未配置','configuration');
      const grantId=`wxgrant_${digest(`${value.id}:${settings.templateId}`)}`;await lock(client,grantId);const previous=await store.one<WechatGrant>('wechat_grants',grantId,client);
      const unresolved=(await store.list<WechatDelivery>('wechat_deliveries',client)).some(delivery=>delivery.readerId===value.id&&delivery.appId===settings.appId&&delivery.templateId===settings.templateId&&delivery.status==='unknown');
      if(unresolved)return {state:'unknown' as const,templateId:settings.templateId};
      if(previous&&['available','reserved','unknown'].includes(previous.status))return {state:previous.status,templateId:settings.templateId};
      if(previous&&clock()-Date.parse(previous.requestedAt)<30_000)throw new DomainError('订阅操作过于频繁，请稍后重试',429);
      const nonce=randomBytes(32).toString('base64url'),expiresAt=new Date(clock()+5*60_000).toISOString();
      await store.put('wechat_grants',{id:grantId,readerId:value.id,appId:settings.appId,templateId:settings.templateId,status:'challenged',nonceHash:digest(nonce),nonceExpiresAt:expiresAt,requestedAt:timestamp(),updatedAt:timestamp()} satisfies WechatGrant,client);
      return {state:'challenged' as const,templateId:settings.templateId,nonce,expiresAt};
    });
  }
  async function confirmWechatSubscription(sessionToken:string,input:unknown):Promise<WechatSubscriptionState> {
    const parsed=z.object({nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),templateId:z.string().min(1).max(128),result:z.enum(['accept','reject','ban','filter'])}).parse(input);
    return store.transaction(async client=>{
      const value=await reader(sessionToken,client),settings=await config(client);if(parsed.templateId!==settings.templateId||!ready(settings,'subscription'))throw new DomainError('订阅模板已变化，请重新操作',409);
      const grantId=`wxgrant_${digest(`${value.id}:${settings.templateId}`)}`;await lock(client,grantId);const grant=await store.one<WechatGrant>('wechat_grants',grantId,client);
      if(!grant||grant.nonceHash!==digest(parsed.nonce))throw new DomainError('订阅请求不存在或已失效',409);
      if(grant.confirmedNonceHash===digest(parsed.nonce))return subscriptionView(value,client);
      if(grant.status!=='challenged'||Date.parse(grant.nonceExpiresAt)<=clock())throw new DomainError('订阅请求已失效，请重新操作',409);
      // A client report is not proof of provider quota. It only creates one pending opportunity.
      await store.put('wechat_grants',{...grant,status:parsed.result==='accept'?'available':'rejected',confirmedNonceHash:digest(parsed.nonce),acceptedAt:parsed.result==='accept'?timestamp():undefined,updatedAt:timestamp()} satisfies WechatGrant,client);return subscriptionView(value,client);
    });
  }
  async function revokeWechatSubscription(sessionToken:string):Promise<WechatSubscriptionState> {
    return store.transaction(async client=>{
      const value=await reader(sessionToken,client),settings=await config(client),grantId=`wxgrant_${digest(`${value.id}:${settings.templateId}`)}`;await lock(client,grantId);
      const grant=await store.one<WechatGrant>('wechat_grants',grantId,client);if(grant)await store.put('wechat_grants',{...grant,status:'revoked',updatedAt:timestamp()},client);
      for(const delivery of await store.list<WechatDelivery>('wechat_deliveries',client))if(delivery.readerId===value.id&&delivery.status==='queued')await store.put('wechat_deliveries',{...delivery,status:'cancelled',reason:'读者已取消提醒',finishedAt:timestamp()},client);
      return subscriptionView(value,client);
    });
  }
  async function scheduleWechatDeliveries():Promise<void> {
    const settings=await config();if(!ready(settings,'subscription'))return;
    await store.transaction(async client=>{
      await lock(client,'wechat_config');await lock(client,'wechat_schedule');const active=await config(client);if(!ready(active,'subscription')||active.version!==settings.version)return;
      const [grants,readers,notices,evidence]=await Promise.all([store.list<WechatGrant>('wechat_grants',client),store.list<WechatReader>('wechat_readers',client),store.list<Notice>('notices',client),store.list<Evidence>('evidence',client)]);
      let scheduled=0;
      for(const previous of grants.filter(item=>item.appId===settings.appId&&item.templateId===settings.templateId&&item.status==='available'&&item.acceptedAt)) {
        if(scheduled>=WECHAT_DISPATCH_BATCH_SIZE)break;
        await lock(client,previous.id);const grant=await store.one<WechatGrant>('wechat_grants',previous.id,client);if(!grant||grant.status!=='available'||grant.appId!==active.appId||grant.templateId!==active.templateId||!grant.acceptedAt)continue;
        if(!readers.some(value=>value.id===grant.readerId&&value.status==='active'))continue;
        const eligible=notices.filter(notice=>notice.origin!=='admin'&&notice.status==='active'&&notice.categories.length>0&&Date.parse(notice.createdAt)>Date.parse(grant.acceptedAt!)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
        for(const notice of eligible) {
          let pub:Publication;try{pub=await publication(notice.publicationId,client);}catch(error){if(error instanceof DomainError)continue;throw error;}
          if(!isQuotaPublication(pub))continue;
          if(!notice.categories.includes('correction')&&isHistoricalArticle(pub.article,evidence))continue;
          const deliveryId=`wxdelivery_${digest(`${notice.id}:${grant.readerId}:${grant.templateId}`)}`;
          const delivery:WechatDelivery={id:deliveryId,readerId:grant.readerId,grantId:grant.id,appId:settings.appId,templateId:settings.templateId,noticeId:notice.id,publicationId:pub.id,semanticKey:notice.semanticKey,status:'queued',createdAt:timestamp(),attempts:0};
          if(!await store.insert('wechat_deliveries',delivery,client))continue;
          await store.put('wechat_grants',{...grant,status:'reserved',deliveryId,updatedAt:timestamp()},client);
          await store.insert('jobs',{id:`job_${deliveryId}`,kind:'wechat_send',status:'queued',attempts:0,availableAt:timestamp(),createdAt:timestamp(),payload:{deliveryId}} satisfies Job,client);scheduled++;break;
        }
      }
      // Withdrawals cancel queued sends without manufacturing another consent.
      for(const delivery of await store.list<WechatDelivery>('wechat_deliveries',client))if(delivery.status==='queued') {
        const notice=notices.find(item=>item.id===delivery.noticeId);let safe=notice?.status==='active';
        if(safe)try{await publication(delivery.publicationId,client);}catch(error){if(error instanceof DomainError)safe=false;else throw error;}
        if(!safe)await finish(delivery,'cancelled','对应内容已撤回或不可分享',undefined,client);
      }
    });
  }
  async function finish(delivery:WechatDelivery,status:'sent'|'rejected'|'unknown'|'cancelled',reason?:string,errorCode?:number,client?:Client) {
    if(!client)throw new DomainError('微信发送结果必须在事务内保存');
    await lock(client,delivery.grantId);await lock(client,delivery.id);
    const current=await store.one<WechatDelivery>('wechat_deliveries',delivery.id,client);
    if(!current||!['queued','sending'].includes(current.status))return;
    await store.put('wechat_deliveries',{...current,status,reason,errorCode,finishedAt:timestamp()},client);
    const grant=await store.one<WechatGrant>('wechat_grants',delivery.grantId,client);
    if(grant?.deliveryId===delivery.id&&grant.status!=='revoked')await store.put('wechat_grants',{...grant,status:status==='sent'?'consumed':status==='unknown'?'unknown':status==='rejected'?'rejected':'revoked',updatedAt:timestamp()},client);
  }
  async function processWechatJob(job:Job):Promise<{state:WechatDelivery['status']|'deferred';resumeAt?:string;reason?:string}> {
    if(job.kind!=='wechat_send'||typeof job.payload.deliveryId!=='string')throw new DomainError('微信发送任务无效');
    const deliveryId=job.payload.deliveryId;
    let delivery=await store.one<WechatDelivery>('wechat_deliveries',deliveryId);if(!delivery)throw new DomainError('微信发送记录不存在',404);
    if(!['queued','sending'].includes(delivery.status))return {state:delivery.status};
    if(delivery.status==='sending') {
      if(delivery.jobAttempt===job.attempts&&Date.parse(delivery.attemptedAt??'')+120_000>clock())return {state:'deferred',resumeAt:new Date(Date.parse(delivery.attemptedAt!)+120_000).toISOString(),reason:'微信发送正在进行，等待当前执行结果'};
      await store.transaction(client=>finish(delivery!,'unknown','服务重启后无法确认此前发送结果，停止重发',undefined,client));return {state:'unknown'};
    }
    const settings=await config();
    if(!ready(settings,'subscription'))return {state:'deferred',resumeAt:new Date(clock()+15*60_000).toISOString(),reason:'微信提醒未配置或已关闭'};
    const [value,grant,notice]=await Promise.all([store.one<WechatReader>('wechat_readers',delivery.readerId),store.one<WechatGrant>('wechat_grants',delivery.grantId),store.one<Notice>('notices',delivery.noticeId)]);
    let safe=value?.status==='active'&&value.appId===settings.appId&&delivery.appId===settings.appId&&delivery.templateId===settings.templateId&&grant?.status==='reserved'&&grant.deliveryId===delivery.id&&notice?.status==='active';
    let verifiedPublication:Publication|undefined;
    if(safe)try{verifiedPublication=await publication(delivery.publicationId);if(!isQuotaPublication(verifiedPublication))safe=false;}catch(error){if(error instanceof DomainError)safe=false;else throw error;}
    if(!safe) {await store.transaction(client=>finish(delivery!,'cancelled','身份、授权、模板或对应内容已失效',undefined,client));return {state:'cancelled'};}
    try {await preparePublicPage(delivery.publicationId);}
    catch {return {state:'deferred',resumeAt:new Date(clock()+5000).toISOString(),reason:'公开页面尚未准备好，稍后再发送'};}
    let token:string,body:Record<string,unknown>;
    try {body={touser:open(value!.encryptedOpenid),template_id:delivery.templateId,page:`pages/detail/index?publicationId=${encodeURIComponent(delivery.publicationId)}`,miniprogram_state:{release:'formal',trial:'trial',develop:'developer'}[settings.envVersion],lang:'zh_CN',data:wechatTemplateData(settings,notice!,verifiedPublication)};token=await accessToken(settings);}
    catch(error) {const budget=error instanceof WechatServiceError&&error.failureKind==='budget';return {state:'deferred',resumeAt:budget?tomorrow():new Date(clock()+15*60_000).toISOString(),reason:error instanceof WechatServiceError?error.message:'微信发送准备失败'};}
    let claimed=false,rateResumeAt:string|undefined;
    try {claimed=await store.transaction(async client=>{
      await lock(client,'wechat_config');await lock(client,delivery!.grantId);await lock(client,deliveryId);const current=await store.one<WechatDelivery>('wechat_deliveries',deliveryId,client);const currentGrant=await store.one<WechatGrant>('wechat_grants',delivery!.grantId,client);const currentNotice=await store.one<Notice>('notices',delivery!.noticeId,client);const currentReader=await store.one<WechatReader>('wechat_readers',delivery!.readerId,client);
      if(current?.status!=='queued'||currentGrant?.status!=='reserved'||currentGrant.deliveryId!==deliveryId||currentNotice?.status!=='active'||currentReader?.status!=='active')return false;
      await publication(current.publicationId,client);
      const currentSettings=await config(client);if(currentSettings.version!==settings.version)throw new WechatServiceError('微信配置已变化，暂缓发送','configuration');
      // The existing configuration lock serializes this check across workers/restarts.
      // Count actual attempts, including unknown/rejected results; no new consent is made.
      const recent=isCloudbaseClient(client)?{rows:[recentWechatAttempts(await store.list<WechatDelivery>('wechat_deliveries',client),clock())]}:await client.query("SELECT count(*)::int AS attempts, min(payload->>'attemptedAt') AS oldest FROM radar_wechat_deliveries WHERE payload->>'attemptedAt' > $1",[new Date(clock()-1000).toISOString()]);
      if(recent.rows[0]?.attempts>=WECHAT_SEND_MAX_PER_SECOND){rateResumeAt=new Date(Math.max(clock()+100,Date.parse(recent.rows[0].oldest)+1000)).toISOString();return false;}
      await usage('send',client);
      delivery={...current,status:'sending',attempts:current.attempts+1,jobAttempt:job.attempts,attemptedAt:timestamp()};await store.put('wechat_deliveries',delivery,client);return true;
    });}catch(error){if(error instanceof WechatServiceError)return {state:'deferred',resumeAt:error.failureKind==='budget'?tomorrow():new Date(clock()+15*60_000).toISOString(),reason:error.message};if(error instanceof DomainError){await store.transaction(client=>finish(delivery!,'cancelled','对应内容已撤回或不可分享',undefined,client));return {state:'cancelled'};}throw error;}if(!claimed)return rateResumeAt?{state:'deferred',resumeAt:rateResumeAt,reason:'通知发送达到每秒上限，继续排队'}:{state:'cancelled'};
    try {await provider.send(token!,body!);await store.transaction(client=>finish(delivery!,'sent',undefined,0,client));return {state:'sent'};}
    catch(error) {const rejected=error instanceof WechatServiceError&&error.failureKind==='rejected',state=rejected?'rejected':'unknown';await store.transaction(client=>finish(delivery!,state,rejected?'微信未接受此次发送':'发送结果未知，停止自动重发',error instanceof WechatServiceError?error.errorCode:undefined,client));return {state};}
  }
  return {adminWechat,publicWechatAvailability,saveWechatSettings,generateWechatCode,resolveWechatScene,wechatLogin,wechatSubscriptionState,wechatSubscriptionChallenge,confirmWechatSubscription,revokeWechatSubscription,scheduleWechatDeliveries,processWechatJob};
}
const service=createWechatService();
export const {adminWechat,publicWechatAvailability,saveWechatSettings,generateWechatCode,resolveWechatScene,wechatLogin,wechatSubscriptionState,wechatSubscriptionChallenge,confirmWechatSubscription,revokeWechatSubscription,scheduleWechatDeliveries,processWechatJob}=service;

function recentWechatAttempts(deliveries:WechatDelivery[],clock:number){const attempts=deliveries.filter(d=>d.attemptedAt&&Date.parse(d.attemptedAt)>clock-1000);return {attempts:attempts.length,oldest:attempts.map(d=>d.attemptedAt!).sort()[0]};}
