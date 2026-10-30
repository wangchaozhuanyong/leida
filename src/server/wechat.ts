import {publicResetOutlook} from '../lib/reset-outlook';
import { lockTransaction } from '../db';
import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {isCloudbaseClient,list,one,put,insert,transaction,type Client,type Table} from '../db';
import type {Article,Evidence,Job,Notice,Publication,RadarEvent} from '../lib/types';
import type {WechatSettings,WechatReader,WechatGrant,WechatCredit,WechatDelivery,WechatSubscriptionState,WechatReminderPreferences} from '../lib/wechat';
import {reminderContentCurrent,reminderStatementAt,reminderObservation} from '../lib/reminder-lifecycle';
import {isHistoricalArticle} from '../lib/history';
import {DomainError,id} from './domain';
import {createWechatProvider,WechatServiceError,WECHAT_CODE_PAGE} from './wechat-provider';
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
interface SubscriptionViewOptions {includeLastResult?:boolean;}
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
const isQuotaPublication=(publication:Publication,evidence:Evidence[]=[],now=publication.publishedAt)=>!!reminderObservation(publication,evidence,now)||publication.mode!=='news_only'&&publication.article.publicationMode!=='news_only'&&(publicQuotaActions(publication).length>0||publication.article.category==='reset'&&publication.event.actions.length===0);
const reminderPreferencesSchema=z.object({announcement:z.boolean(),result:z.boolean(),correction:z.boolean()}).strict();
const reminderTypes=['announcement','result','correction'] as const;
const reminderPreferencesOf=(reader:WechatReader):WechatReminderPreferences=>({announcement:reader.reminderPreferences?.announcement??true,result:reader.reminderPreferences?.result??true,correction:reader.reminderPreferences?.correction??true});
// A correction can also carry the original result/announcement categories. It
// remains a correction so turning that type off cannot be bypassed by overlap.
function reminderType(notice:Notice):keyof WechatReminderPreferences|undefined {
  return notice.categories.includes('correction')?'correction':notice.categories.includes('result')?'result':notice.categories.includes('announcement')?'announcement':undefined;
}
function allowsReminder(reader:WechatReader,notice:Notice,statementAt=notice.createdAt):boolean {
  const type=reminderType(notice);if(!type||notice.origin==='admin')return false;
  const enabledAt=reader.reminderEnabledAt?.[type];
  return reminderPreferencesOf(reader)[type]&&(!enabledAt||Date.parse(statementAt)>Date.parse(enabledAt));
}
export function wechatTemplateData(settings:WechatSettings,notice:Notice,publication?:Publication,evidence:Evidence[]=[]):Record<string,{value:string}> {
  let fields:WechatSettings['templateFields'];try {fields=fieldSchema.parse(settings.templateFields);}catch {throw new WechatServiceError('模板字段未配置或类型不兼容','configuration');}
  let status=notice.categories.includes('correction')?'重要更正':notice.categories.includes('result')?'公告称完成':notice.categories.includes('activity')?'活动更新':'发放预告';
  // Keep the factual qualifier at the beginning even when a long title is truncated.
  let title=notice.categories.includes('result')?`公告称完成：${notice.title.replace(/^公告称(?:已)?(?:完成|发放)[：:]?/,'')}`:notice.title;
  if(publication){
    if(publication.id!==notice.publicationId||!isQuotaPublication(publication,evidence,notice.createdAt))throw new WechatServiceError('此内容不属于额度重置提醒','configuration');
    const observation=reminderObservation(publication,evidence,notice.createdAt);
    const allActions=observation?[]:publicQuotaActions(publication),cited=allActions.filter(action=>action.evidenceIds.some(id=>publication.article.evidenceIds.includes(id)));
    const actions=cited.length?cited:allActions,kinds=new Set(actions.map(action=>action.kind)),stages=new Set(actions.map(action=>action.stage));
    // The actual template labels this field as quota type, not an article title.
    title=kinds.size>1?'Codex额度与重置卡':kinds.has('banked_reset')?'Codex重置卡':'Codex额度';
    const stage=actions[0]?.stage,banked=kinds.has('banked_reset');
    if(notice.categories.includes('correction'))status='重置信息已更正';
    else if(observation)status='已观测到重置（第三方）';
    else if(stages.size>1)status='多项重置进展已更新';
    else if(stage){
      status={promised:banked?'已发布发卡预告，时间待公布':'已发布重置预告，时间待公布',in_progress:'已宣布开始，完成待确认',claimed_complete:banked?'发布者已声明发卡完成':'发布者已声明重置完成',cancelled:'本轮安排已取消'}[stage];
      if(stage==='promised'&&actions.length===1&&Number.isFinite(Date.parse(actions[0].expectedAt??''))){
        const expected=new Date(Date.parse(actions[0].expectedAt!)+8*3600_000),note=actions[0].timeNote??'';
        const qualifier=/最晚|之前|截止|\bby\b|\bwithin\b/i.test(note)?'前':/左右|近似|约|approx/i.test(note)?'左右':'';
        status=`预计${expected.getUTCMonth()+1}月${expected.getUTCDate()}日${expected.toISOString().slice(11,16)}${qualifier}${banked?'发卡':'重置'}`;
      }
    }
    // Keep evidence qualifiers even when the chosen WeChat field only permits five characters.
    if(fields.status.startsWith('phrase'))status=notice.categories.includes('correction')?'信息已更正':observation?'重置观测':stages.size>1?'进展已更新':stage?{promised:'重置预告',in_progress:'正在发放',claimed_complete:'声明已完成',cancelled:'安排已取消'}[stage]:status;
  }
  const at=Date.parse(publication?reminderStatementAt(notice,publication,evidence):notice.createdAt);if(!Number.isFinite(at))throw new WechatServiceError('消息时间无效','configuration');
  const time=new Date(at+8*3600_000).toISOString().slice(0,16).replace('T',' ');
  return {[fields.title]:{value:Array.from(title.replace(/[\r\n\x00-\x1f]/g,' ')).slice(0,20).join('')},[fields.status]:{value:Array.from(status).slice(0,fields.status.startsWith('phrase')?5:20).join('')},[fields.time]:{value:fields.time.startsWith('date')?time.slice(0,10):time}};
}
export function createWechatService(dependencies:WechatDependencies={}) {
  const store=dependencies.store??{list,one,put,insert,transaction};
  const provider=createWechatProvider(dependencies.fetcher);
  const tokenFlights=new Map<string,Promise<string>>();
  const codeFlights=new Map<string,Promise<{image:Buffer;contentType:string;scene:string;publicationId:string}>>();
  const clock=dependencies.clock??Date.now;
  const preparePublicPage=dependencies.preparePublicPage??prepareNotificationPublicPage;
  const timestamp=()=>new Date(clock()).toISOString();
  async function currentResolutions(client?:Client) {
    const [events,publications]=await Promise.all([store.list<RadarEvent>('events',client),store.list<Publication>('publications',client)]);
    return publicResetOutlook({events,publications,articles:[],evidence:[],serverTime:timestamp()}).latestResolutions;
  }
  function creditsOf(grant?:WechatGrant):WechatCredit[] {
    if(grant?.credits)return grant.credits.map(credit=>({...credit}));
    // Existing single-use records represent at most one real accepted choice.
    if(!grant?.acceptedAt||!['available','reserved','consumed','unknown'].includes(grant.status))return [];
    return [{id:grant.confirmedNonceHash??grant.nonceHash,acceptedAt:grant.acceptedAt,status:grant.status as WechatCredit['status'],deliveryId:grant.deliveryId}];
  }
  function withCredits(grant:WechatGrant,credits:WechatCredit[],fallback:WechatGrant['status']):WechatGrant {
    // Keep active opportunities and recent receipts; expired old nonces cannot
    // become the current challenge again, even after their receipt is pruned.
    credits=credits.filter(credit=>['available','reserved','unknown'].includes(credit.status)||Date.parse(credit.acceptedAt)>clock()-15*60_000);
    const reserved=credits.find(credit=>credit.status==='reserved');
    // An uncertain send pauses this grant until a fresh accepted choice. Keep
    // that receipt frozen; it must never be refunded or used to resend it.
    const paused=fallback==='unknown'||grant.status==='unknown'&&fallback!=='revoked';
    const status=paused?'unknown':reserved?'reserved':credits.some(credit=>credit.status==='available')?'available':fallback;
    return {...grant,credits,status,deliveryId:reserved?.deliveryId,updatedAt:timestamp()};
  }
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
    return {available:ready(settings,'subscription'),codeAvailable:ready(settings,'qr')};
  }
  const day=()=>new Date(clock()+8*3600_000).toISOString().slice(0,10);
  const tomorrow=()=>new Date(Date.parse(`${day()}T00:00:00+08:00`)+24*3600_000).toISOString();
  const budgetError=(message:string,at:number|string)=>new WechatServiceError(message,'budget',undefined,new Date(at).toISOString());
  // Admission hints limit a noisy caller, never authenticate it. The global hard budget remains authoritative.
  type LoginAttempt={at:number;count:number;failed:number;minuteAt?:number};
  async function admitLogin(code:string,clientHint:string){
    return store.transaction(async client=>{
      await lock(client,'wechat_login_admission');
      const previous=await store.one<{id:string;clients:Record<string,LoginAttempt>;codes:Record<string,number>}>('settings','wechat_login_admission',client);
      const current=clock(),clientKey=createHmac('sha256',key()).update(clientHint.slice(0,256)).digest('hex'),codeKey=digest(code);
      const clients=Object.fromEntries(Object.entries(previous?.clients??{}).filter(([,v])=>v.at<=current&&current-v.at<15*60_000));
      const codes=Object.fromEntries(Object.entries(previous?.codes??{}).filter(([,at])=>at<=current&&current-at<10*60_000));
      const attempt=clients[clientKey]??{at:current,count:0,failed:0};
      const minuteAt=attempt.minuteAt??attempt.at,minuteFresh=current-minuteAt<60_000;
      if(codes[codeKey]!==undefined)throw budgetError('此微信登录凭证已尝试，请重新打开提醒页面获取新凭证',codes[codeKey]+10*60_000);
      if(attempt.failed>=5)throw budgetError('当前来源连续登录失败，请在15分钟后重试',attempt.at+15*60_000);
      if(attempt.count>=8&&minuteFresh)throw budgetError('当前连接登录过于频繁，请一分钟后重试',minuteAt+60_000);
      if(Object.keys(clients).length>=1024&&!clients[clientKey]||Object.keys(codes).length>=4096)throw budgetError('微信登录请求较多，请一分钟后重试',current+60_000);
      clients[clientKey]={...attempt,count:(minuteFresh?attempt.count:0)+1,minuteAt:minuteFresh?minuteAt:current};codes[codeKey]=current;
      await store.put('settings',{id:'wechat_login_admission',clients,codes},client);return clientKey;
    });
  }
  async function failedLogin(clientKey:string){
    await store.transaction(async client=>{
      await lock(client,'wechat_login_admission');
      const previous=await store.one<{id:string;clients:Record<string,LoginAttempt>;codes:Record<string,number>}>('settings','wechat_login_admission',client);
      const attempt=previous?.clients[clientKey];if(!previous||!attempt)return;
      await store.put('settings',{...previous,clients:{...previous.clients,[clientKey]:{...attempt,failed:attempt.failed+1}}},client);
    });
  }
  async function usage(kind:'login'|'token'|'qr'|'send',existingClient?:Client,expectedVersion?:number) {
    const reserve=async(client:Client)=>{
      await lock(client,'wechat_usage');const settings=await config(client);
      if(expectedVersion!==undefined&&settings.version!==expectedVersion)throw new WechatServiceError('微信配置已变化，请稍后重试','configuration');
      if(kind==='qr'&&!ready(settings,'qr')||(['login','send'].includes(kind))&&!ready(settings,'subscription')||kind==='token'&&!ready(settings,'qr')&&!ready(settings,'subscription'))throw new WechatServiceError('微信功能尚未配置或已关闭','configuration');
      const usageId=`wechat_usage_${day()}`;const previous=await store.one<{id:string;calls:number;codes:number;sends:number;logins?:number;loginWindowAt?:number;loginWindowCount?:number}>('settings',usageId,client)??{id:usageId,calls:0,codes:0,sends:0};
      const windowFresh=Number.isFinite(previous.loginWindowAt)&&clock()-previous.loginWindowAt!<60_000,windowCount=windowFresh?previous.loginWindowCount??0:0;
      if(kind==='login'&&(previous.logins??0)>=Math.max(1,Math.floor(settings.dailyApiLimit/4)))throw budgetError('微信登录调用已达限制，次日零点恢复',tomorrow());
      if(kind==='login'&&windowCount>=10)throw budgetError('微信登录调用已达限制，请一分钟后再试',previous.loginWindowAt!+60_000);
      if(previous.calls>=settings.dailyApiLimit||kind==='qr'&&previous.codes>=settings.dailyQrLimit||kind==='send'&&previous.sends>=settings.dailySendLimit)throw budgetError('今日微信接口调用上限已达，次日恢复',tomorrow());
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
    const cacheId=`wechat_code_${digest(`${settings.appId}:${settings.envVersion}:${WECHAT_CODE_PAGE}:${publicationId}`)}`;
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
  async function lockedReader(sessionToken:string,client:Client):Promise<WechatReader> {
    const value=await reader(sessionToken,client);await lock(client,value.id);
    // Re-read after acquiring the same lock used by login/preferences writes.
    return reader(sessionToken,client);
  }
  async function wechatLogin(code:string,clientHint='anonymous',options:SubscriptionViewOptions={}):Promise<{sessionToken:string;expiresAt:string;subscriptionState?:WechatSubscriptionState}> {
    const input=z.string().min(1).max(512).parse(code);
    if(!ready(await config(),'subscription'))throw new WechatServiceError('微信功能尚未配置或已关闭','configuration');
    const clientKey=await admitLogin(input,clientHint),settings=await usage('login');
    let openid:string;
    try{openid=await provider.login(settings.appId,open(settings.encryptedSecret!),input);}catch(error){if(error instanceof WechatServiceError&&[40029,40163].includes(error.errorCode??0))await failedLogin(clientKey);throw error;}
    const openidHash=digest(`${settings.appId}:${openid}`),readerId=`wxreader_${openidHash}`,sessionToken=randomBytes(32).toString('base64url'),expiresAt=new Date(clock()+7*24*3600_000).toISOString();
    const subscriptionState=await store.transaction(async client=>{
      await lock(client,readerId);const existing=await store.one<WechatReader>('wechat_readers',readerId,client);
      if(existing?.status==='disabled')throw new DomainError('微信提醒身份已停用',403);
      const sessions=[...(existing?.sessions??[]).filter(session=>Date.parse(session.expiresAt)>clock()).slice(-4),{hash:digest(sessionToken),createdAt:timestamp(),expiresAt}];
      const next={...existing,id:readerId,appId:settings.appId,openidHash,encryptedOpenid:existing?.encryptedOpenid??seal(openid),status:'active',createdAt:existing?.createdAt??timestamp(),lastLoginAt:timestamp(),sessions} satisfies WechatReader;
      await store.put('wechat_readers',next,client);
      // Only the native summary caller opts in. Authentication and grant writes
      // stay unchanged; return this reader's live balance without delivery history.
      if(options.includeLastResult===false)return subscriptionView(await reader(sessionToken,client),client,options);
    });return {sessionToken,expiresAt,...(subscriptionState?{subscriptionState}:{})};
  }
  async function subscriptionView(value:WechatReader,client?:Client,options:SubscriptionViewOptions={}):Promise<WechatSubscriptionState> {
    const preferences={reminderPreferences:reminderPreferencesOf(value),preferencesSupported:true};
    const settings=await config(client);if(!ready(settings,'subscription'))return {configured:false,enabled:settings.subscriptionsEnabled,state:'unavailable',...preferences};
    const grant=await store.one<WechatGrant>('wechat_grants',`wxgrant_${digest(`${value.id}:${settings.templateId}`)}`,client);
    // The reminder screen only needs the authoritative grant and preferences.
    // Do not make its balance wait for a paginated scan of everyone's deliveries.
    // Legacy callers retain the optional last-result field and its original semantics.
    let lastResult:WechatSubscriptionState['lastResult'];
    if(options.includeLastResult!==false){
      const deliveries=(await store.list<WechatDelivery>('wechat_deliveries',client)).filter(item=>item.readerId===value.id&&item.templateId===settings.templateId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      lastResult=deliveries.find(item=>['sent','rejected','unknown','cancelled'].includes(item.status))?.status as WechatSubscriptionState['lastResult'];
    }
    const credits=creditsOf(grant);
    return {configured:true,enabled:true,state:grant?.status==='challenged'&&Date.parse(grant.nonceExpiresAt)<clock()?'none':grant?.status??'none',templateId:settings.templateId,acceptedAt:grant?.acceptedAt,remainingCount:credits.filter(credit=>['available','reserved'].includes(credit.status)).length,pendingCount:credits.filter(credit=>credit.status==='reserved').length,...(options.includeLastResult!==false?{lastResult}:{}),...preferences};
  }
  async function wechatSubscriptionState(sessionToken:string,options:SubscriptionViewOptions={}):Promise<WechatSubscriptionState> {return subscriptionView(await reader(sessionToken),undefined,options);}
  async function saveWechatReminderPreferences(sessionToken:string,input:unknown):Promise<WechatSubscriptionState> {
    const preferences=reminderPreferencesSchema.parse(input);
    return store.transaction(async client=>{
      // All scheduling/send claims take config before reader, then grant and
      // delivery. A completed save therefore stops every not-yet-claimed send.
      await lock(client,'wechat_config');const value=await lockedReader(sessionToken,client),previous=reminderPreferencesOf(value);
      const enabledAt={...value.reminderEnabledAt};
      for(const type of reminderTypes)if(!previous[type]&&preferences[type])enabledAt[type]=timestamp();
      const next:WechatReader={...value,reminderPreferences:preferences,reminderEnabledAt:enabledAt};
      await store.put('wechat_readers',next,client);
      const notices=await store.list<Notice>('notices',client);
      for(const delivery of await store.list<WechatDelivery>('wechat_deliveries',client))if(delivery.readerId===value.id&&delivery.status==='queued'){
        const notice=notices.find(item=>item.id===delivery.noticeId);
        if(!notice||!allowsReminder(next,notice))await finish(delivery,'cancelled','读者已关闭此类微信提醒',undefined,client);
      }
      return subscriptionView(next,client);
    });
  }
  async function wechatSubscriptionChallenge(sessionToken:string,options:SubscriptionViewOptions={}) {
    return store.transaction(async client=>{
      const value=await lockedReader(sessionToken,client),settings=await config(client);if(!ready(settings,'subscription'))throw new WechatServiceError('微信提醒尚未配置','configuration');
      const grantId=`wxgrant_${digest(`${value.id}:${settings.templateId}`)}`;await lock(client,grantId);const previous=await store.one<WechatGrant>('wechat_grants',grantId,client);
      const challengeTimes=(previous?.challengeTimes??[]).filter(at=>at>clock()-60_000);
      if(challengeTimes.length>=10)throw new DomainError('操作太快，请稍后再增加提醒次数',429);
      const nonce=randomBytes(32).toString('base64url'),expiresAt=new Date(clock()+5*60_000).toISOString();
      // Preparing a fresh choice must not reopen a reader's closed reminder.
      const status=previous?.status==='revoked'||previous?.status==='unknown'?previous.status:'challenged';
      const next=withCredits({...previous,id:grantId,readerId:value.id,appId:settings.appId,templateId:settings.templateId,status,nonceHash:digest(nonce),nonceExpiresAt:expiresAt,requestedAt:timestamp(),updatedAt:timestamp(),challengeTimes:[...challengeTimes,clock()]},creditsOf(previous),status);
      await store.put('wechat_grants',next,client);
      return {state:await subscriptionView(value,client,options),templateId:settings.templateId,nonce,expiresAt};
    });
  }
  async function confirmWechatSubscription(sessionToken:string,input:unknown):Promise<WechatSubscriptionState> {
    const parsed=z.object({nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),templateId:z.string().min(1).max(128),result:z.enum(['accept','reject','ban','filter'])}).parse(input);
    return store.transaction(async client=>{
      const value=await lockedReader(sessionToken,client),settings=await config(client);if(parsed.templateId!==settings.templateId||!ready(settings,'subscription'))throw new DomainError('订阅模板已变化，请重新操作',409);
      const grantId=`wxgrant_${digest(`${value.id}:${settings.templateId}`)}`;await lock(client,grantId);const grant=await store.one<WechatGrant>('wechat_grants',grantId,client);
      if(!grant)throw new DomainError('订阅请求不存在或已失效',409);
      const receipt=digest(parsed.nonce),credits=creditsOf(grant);
      if(grant.confirmedNonceHash===receipt||credits.some(credit=>credit.id===receipt))return subscriptionView(value,client);
      if(grant.nonceHash!==receipt)throw new DomainError('订阅请求不存在或已失效',409);
      // Revocation expires the old nonce; only a fresh, reader-bound challenge
      // may be accepted to reopen a closed reminder after an explicit choice.
      if(Date.parse(grant.nonceExpiresAt)<=clock())throw new DomainError('订阅请求已失效，请重新操作',409);
      // One fresh accepted callback creates one opportunity, never a requested count.
      let resumedAt=grant.resumedAt;
      if(parsed.result==='accept'){
        const uncertain=credits.some(credit=>credit.status==='unknown');
        if(grant.status==='unknown'||grant.status==='revoked'&&uncertain)resumedAt=timestamp();
        // Freeze the existing conservative boundary for pre-upgrade records
        // before acceptedAt advances with another authorized opportunity.
        else if(!resumedAt&&uncertain)resumedAt=grant.acceptedAt;
        credits.push({id:receipt,acceptedAt:timestamp(),status:'available'});
      }
      await store.put('wechat_grants',withCredits({...grant,resumedAt,status:parsed.result==='accept'?'available':grant.status,confirmedNonceHash:receipt,acceptedAt:parsed.result==='accept'?timestamp():grant.acceptedAt},credits,parsed.result==='accept'?'available':'rejected'),client);return subscriptionView(value,client);
    });
  }
  async function revokeWechatSubscription(sessionToken:string):Promise<WechatSubscriptionState> {
    return store.transaction(async client=>{
      const value=await lockedReader(sessionToken,client),settings=await config(client),grantId=`wxgrant_${digest(`${value.id}:${settings.templateId}`)}`;await lock(client,grantId);
      const grant=await store.one<WechatGrant>('wechat_grants',grantId,client);if(grant)await store.put('wechat_grants',withCredits({...grant,nonceExpiresAt:timestamp()},creditsOf(grant).map(credit=>['available','reserved','unknown'].includes(credit.status)?{...credit,status:'revoked' as const}:credit),'revoked'),client);
      for(const delivery of await store.list<WechatDelivery>('wechat_deliveries',client))if(delivery.readerId===value.id&&delivery.status==='queued')await store.put('wechat_deliveries',{...delivery,status:'cancelled',reason:'读者已取消提醒',finishedAt:timestamp()},client);
      return subscriptionView(value,client);
    });
  }
  async function scheduleWechatDeliveries():Promise<void> {
    const settings=await config();if(!ready(settings,'subscription'))return;
    await store.transaction(async client=>{
      await lock(client,'wechat_config');await lock(client,'wechat_schedule');const active=await config(client);if(!ready(active,'subscription')||active.version!==settings.version)return;
      const [grants,readers,notices,evidence,deliveries]=await Promise.all([store.list<WechatGrant>('wechat_grants',client),store.list<WechatReader>('wechat_readers',client),store.list<Notice>('notices',client),store.list<Evidence>('evidence',client),store.list<WechatDelivery>('wechat_deliveries',client)]);
      const resolutions=await currentResolutions(client);
      let scheduled=0;
      for(const previous of grants.filter(item=>item.appId===settings.appId&&item.templateId===settings.templateId&&item.status==='available'&&item.acceptedAt)) {
        if(scheduled>=WECHAT_DISPATCH_BATCH_SIZE)break;
        await lock(client,previous.readerId);await lock(client,previous.id);const grant=await store.one<WechatGrant>('wechat_grants',previous.id,client);if(!grant||grant.status!=='available'||grant.appId!==active.appId||grant.templateId!==active.templateId||!grant.acceptedAt)continue;
        // Preference writes share the configuration lock, so this batch read
        // stays current without adding one database request per recipient.
        const value=readers.find(item=>item.id===grant.readerId);if(!value||value.status!=='active'||value.appId!==active.appId)continue;
        const credits=creditsOf(grant);
        // Recovery never backfills messages from the pause. Existing uncertain
        // deliveries retain their terminal state and their idempotency keys.
        const resumedAt=deliveries.some(item=>item.readerId===grant.readerId&&item.appId===grant.appId&&item.templateId===grant.templateId&&item.status==='unknown')?Date.parse(grant.resumedAt??grant.acceptedAt):0;
        const eligible=notices.filter(notice=>notice.status==='active'&&allowsReminder(value,notice)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
        for(const notice of eligible) {
          const credit=credits.find(credit=>credit.status==='available'&&Date.parse(notice.createdAt)>Math.max(Date.parse(credit.acceptedAt),resumedAt));if(!credit)continue;
          let pub:Publication;try{pub=await publication(notice.publicationId,client);}catch(error){if(error instanceof DomainError)continue;throw error;}
          const statementAt=reminderStatementAt(notice,pub,evidence),type=reminderType(notice),enabledAt=type?Date.parse(value.reminderEnabledAt?.[type]??''):NaN;if(Date.parse(statementAt)<=Math.max(Date.parse(credit.acceptedAt),resumedAt,Number.isFinite(enabledAt)?enabledAt:0)||Date.parse(statementAt)>clock())continue;
          if(!isQuotaPublication(pub,evidence,timestamp())||!reminderContentCurrent(notice,pub,await store.one<RadarEvent>('events',pub.eventId,client),timestamp(),resolutions,evidence))continue;
          if(!notice.categories.includes('correction')&&isHistoricalArticle(pub.article,evidence))continue;
          const deliveryId=`wxdelivery_${digest(`${notice.id}:${grant.readerId}:${grant.templateId}`)}`;
          const delivery:WechatDelivery={id:deliveryId,readerId:grant.readerId,grantId:grant.id,creditId:credit.id,appId:settings.appId,templateId:settings.templateId,noticeId:notice.id,publicationId:pub.id,semanticKey:notice.semanticKey,status:'queued',createdAt:timestamp(),attempts:0};
          if(!await store.insert('wechat_deliveries',delivery,client))continue;
          deliveries.push(delivery);
          await store.put('wechat_grants',withCredits(grant,credits.map(item=>item.id===credit.id?{...item,status:'reserved',deliveryId}:item),'reserved'),client);
          await store.insert('jobs',{id:`job_${deliveryId}`,kind:'wechat_send',status:'queued',attempts:0,availableAt:timestamp(),createdAt:timestamp(),payload:{deliveryId}} satisfies Job,client);scheduled++;break;
        }
      }
      // Withdrawals cancel queued sends without manufacturing another consent.
      for(const delivery of deliveries)if(delivery.status==='queued') {
        const notice=notices.find(item=>item.id===delivery.noticeId);let safe=notice?.status==='active';
        if(safe)try{const pub=await publication(delivery.publicationId,client);safe=reminderContentCurrent(notice!,pub,await store.one<RadarEvent>('events',pub.eventId,client),timestamp(),resolutions,evidence);}catch(error){if(error instanceof DomainError)safe=false;else throw error;}
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
    if(grant?.deliveryId===delivery.id&&grant.status!=='revoked'){
      const nextStatus:WechatCredit['status']=status==='sent'?'consumed':status==='cancelled'?(current.attempts===0?'available':'unknown'):status;
      const credits=creditsOf(grant).map(credit=>{
        if(status==='rejected'&&['available','reserved'].includes(credit.status))return {...credit,status:'rejected' as const};
        return credit.status==='reserved'&&credit.deliveryId===delivery.id?{...credit,status:nextStatus,deliveryId:nextStatus==='available'?undefined:credit.deliveryId}:credit;
      });
      await store.put('wechat_grants',withCredits(grant,credits,status==='sent'?'consumed':status==='cancelled'?'revoked':status),client);
    }
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
    const [value,grant,notice,evidence]=await Promise.all([store.one<WechatReader>('wechat_readers',delivery.readerId),store.one<WechatGrant>('wechat_grants',delivery.grantId),store.one<Notice>('notices',delivery.noticeId),store.list<Evidence>('evidence')]);
    let safe=value?.status==='active'&&value.appId===settings.appId&&delivery.appId===settings.appId&&delivery.templateId===settings.templateId&&grant?.status==='reserved'&&grant.deliveryId===delivery.id&&notice?.status==='active'&&allowsReminder(value,notice);
    let verifiedPublication:Publication|undefined;
    if(safe)try{verifiedPublication=await publication(delivery.publicationId);if(!isQuotaPublication(verifiedPublication,evidence,timestamp())||!reminderContentCurrent(notice!,verifiedPublication,await store.one<RadarEvent>('events',verifiedPublication.eventId),timestamp(),await currentResolutions(),evidence))safe=false;}catch(error){if(error instanceof DomainError)safe=false;else throw error;}
    if(safe&&verifiedPublication){const credit=creditsOf(grant!).find(item=>item.id===delivery!.creditId),type=reminderType(notice!),enabledAt=type?Date.parse(value!.reminderEnabledAt?.[type]??''):NaN;if(!credit||Date.parse(reminderStatementAt(notice!,verifiedPublication,evidence))<=Math.max(Date.parse(credit.acceptedAt),Number.isFinite(enabledAt)?enabledAt:0))safe=false;}
    if(!safe) {await store.transaction(client=>finish(delivery!,'cancelled','身份、授权、模板或对应内容已失效',undefined,client));return {state:'cancelled'};}
    try {await preparePublicPage(delivery.publicationId);}
    catch {return {state:'deferred',resumeAt:new Date(clock()+5000).toISOString(),reason:'公开页面尚未准备好，稍后再发送'};}
    let token:string,body:Record<string,unknown>;
    try {body={touser:open(value!.encryptedOpenid),template_id:delivery.templateId,page:`pages/detail/index?publicationId=${encodeURIComponent(delivery.publicationId)}`,miniprogram_state:{release:'formal',trial:'trial',develop:'developer'}[settings.envVersion],lang:'zh_CN',data:wechatTemplateData(settings,notice!,verifiedPublication,evidence)};token=await accessToken(settings);}
    catch(error) {const budget=error instanceof WechatServiceError&&error.failureKind==='budget';return {state:'deferred',resumeAt:budget?tomorrow():new Date(clock()+15*60_000).toISOString(),reason:error instanceof WechatServiceError?error.message:'微信发送准备失败'};}
    let claimed=false,rateResumeAt:string|undefined;
    try {claimed=await store.transaction(async client=>{
      await lock(client,'wechat_config');await lock(client,delivery!.readerId);await lock(client,delivery!.grantId);await lock(client,deliveryId);const current=await store.one<WechatDelivery>('wechat_deliveries',deliveryId,client);const currentGrant=await store.one<WechatGrant>('wechat_grants',delivery!.grantId,client);const currentNotice=await store.one<Notice>('notices',delivery!.noticeId,client);const currentReader=await store.one<WechatReader>('wechat_readers',delivery!.readerId,client);
      if(current?.status!=='queued'||currentGrant?.status!=='reserved'||currentGrant.deliveryId!==deliveryId||currentNotice?.status!=='active'||currentReader?.status!=='active')return false;
      if(!reminderContentCurrent(currentNotice,verifiedPublication!,await store.one<RadarEvent>('events',verifiedPublication!.eventId,client),timestamp(),await currentResolutions(client),evidence)){await finish(current,'cancelled','本轮预告或完成内容已失效',undefined,client);return false;}
      if(!allowsReminder(currentReader,currentNotice,reminderStatementAt(currentNotice,verifiedPublication!,evidence))){await finish(current,'cancelled','读者已关闭此类微信提醒',undefined,client);return false;}
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
  return {adminWechat,publicWechatAvailability,saveWechatSettings,generateWechatCode,resolveWechatScene,wechatLogin,wechatSubscriptionState,saveWechatReminderPreferences,wechatSubscriptionChallenge,confirmWechatSubscription,revokeWechatSubscription,scheduleWechatDeliveries,processWechatJob};
}
const service=createWechatService();
export const {adminWechat,publicWechatAvailability,saveWechatSettings,generateWechatCode,resolveWechatScene,wechatLogin,wechatSubscriptionState,saveWechatReminderPreferences,wechatSubscriptionChallenge,confirmWechatSubscription,revokeWechatSubscription,scheduleWechatDeliveries,processWechatJob}=service;

function recentWechatAttempts(deliveries:WechatDelivery[],clock:number){const attempts=deliveries.filter(d=>d.attemptedAt&&Date.parse(d.attemptedAt)>clock-1000);return {attempts:attempts.length,oldest:attempts.map(d=>d.attemptedAt!).sort()[0]};}
