/** @typedef {{mode:string,baseUrl:string,cloudEnv:string,serviceName:string,timeoutMs?:number,pollMs?:number}} Config */
const { validateForecastPublicData, validateForecastSnapshot } = require('./model');
/** @param {Config} config */
function configurationError(config) {
  if (!config || !['https', 'cloud'].includes(config.mode)) return '尚未连接，请先配置公开接口或微信云托管。';
  if (config.mode === 'https') {
    const match = typeof config.baseUrl === 'string' && config.baseUrl.match(/^https:\/\/([a-z0-9.-]+)(?::\d{1,5})?\/?$/i);
    if (!match || !match[1].includes('.') || /^(?:\d+\.){3}\d+$/.test(match[1]) || /(?:^|\.)localhost$/i.test(match[1])) return '请配置真实 HTTPS 接口域名，不使用本机地址。';
  }
  if (config.mode === 'cloud' && (typeof config.cloudEnv !== 'string' || !config.cloudEnv.trim() || typeof config.serviceName !== 'string' || !config.serviceName.trim())) return '尚未连接，请填写实际云托管环境和服务名。';
  return '';
}
function validateBootstrap(value) {
  if (!value || typeof value !== 'object' || !value.site || typeof value.site.name !== 'string' || !Number.isFinite(Date.parse(value.serverTime))) return false;
  if (!['events','articles','publications','evidence','notices','activities','sources'].every(key => Array.isArray(value[key]))) return false;
  if (!['events','articles','publications','evidence','notices','activities','sources'].every(key => new Set(value[key].map(item => item && item.id)).size === value[key].length)) return false;
  const text = x => typeof x === 'string';
  const validArticle = x => x && text(x.id) && text(x.eventId) && text(x.publicationId) && text(x.title) && text(x.summary) && text(x.translation) && ['published','withdrawn'].includes(x.status) && Array.isArray(x.evidenceIds) && x.evidenceIds.every(text) && Number.isFinite(Date.parse(x.publishedAt));
  const validAction = x => x && text(x.id) && ['automatic_reset','banked_reset'].includes(x.kind) && ['promised','in_progress','claimed_complete','cancelled'].includes(x.stage) && ['public','targeted','private'].includes(x.scope) && text(x.eligibility) && Array.isArray(x.evidenceIds) && Number.isFinite(Date.parse(x.statementAt));
  const validEvent = x => x && text(x.id) && text(x.publicationId) && ['published','withdrawn','merged'].includes(x.status) && Array.isArray(x.actions) && x.actions.every(validAction) && Array.isArray(x.evidenceIds);
  if (!value.articles.every(validArticle) || !value.events.every(validEvent)) return false;
  if (!value.publications.every(x => x && text(x.id) && text(x.eventId) && text(x.articleId) && validArticle(x.article) && validEvent(x.event) && x.event.id === x.eventId && x.article.id === x.articleId && x.article.eventId === x.eventId && Number.isFinite(Date.parse(x.publishedAt)) && Number.isFinite(Date.parse(x.cutoffAt)))) return false;
  if (!value.evidence.every(x => x && text(x.id) && text(x.text) && text(x.url) && ['official','archive','manual'].includes(x.provenance))) return false;
  if (!value.notices.every(x => x && text(x.id) && text(x.publicationId) && text(x.title) && text(x.summary) && ['active','withdrawn'].includes(x.status) && Array.isArray(x.categories) && (x.origin === undefined || x.origin === 'admin' && text(x.body)))) return false;
  if (!value.activities.every(x => x && text(x.id) && text(x.title) && text(x.rules) && text(x.timezone) && /^\d{4}-\d{2}-\d{2}$/.test(x.startsOn) && Number.isInteger(x.days) && x.days > 0 && x.days <= 366 && Array.isArray(x.items) && x.items.every(item => item && Number.isInteger(item.day) && item.day >= 1 && item.day <= x.days && text(item.articleId)))) return false;
  return value.sources.every(x => x && text(x.id) && text(x.name) && ['unconnected','healthy','delayed','failed','paused'].includes(x.status)) && (value.forecasts === undefined || validateForecastPublicData(value.forecasts));
}
const forecastSnapshotPath = /^\/api\/v1\/forecasts\/[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;
function validForecastBody(path, value) {
  return path === '/api/v1/forecasts' ? validateForecastPublicData(value) : forecastSnapshotPath.test(path) && validateForecastSnapshot(value) && value.id === path.slice(path.lastIndexOf('/') + 1);
}
const subscriptionStates = ['unavailable','none','challenged','available','reserved','consumed','rejected','revoked','unknown'];
function validateSubscription(value) {
  return !!value && typeof value.configured==='boolean' && typeof value.enabled==='boolean' && subscriptionStates.includes(value.state)
    && (value.remainingCount===undefined || Number.isSafeInteger(value.remainingCount) && value.remainingCount>=0)
    && (value.pendingCount===undefined || Number.isSafeInteger(value.pendingCount) && value.pendingCount>=0 && value.pendingCount<=value.remainingCount)
    && (value.templateId===undefined || typeof value.templateId==='string') && (value.lastResult===undefined || ['sent','rejected','unknown','cancelled'].includes(value.lastResult));
}
function validWechatBody(path,value) {
  if(!value || typeof value!=='object') return false;
  if(path.startsWith('/api/v1/wechat/code/')) {let id;try{id=decodeURIComponent(path.slice(path.lastIndexOf('/')+1));}catch(_){return false;}return value.publicationId===id && ['image/png','image/jpeg'].includes(value.contentType) && typeof value.imageBase64==='string' && value.imageBase64.length<=3000000 && /^[a-f0-9]{32}$/.test(value.scene);}
  if(path.startsWith('/api/v1/wechat/scene/')) return typeof value.publicationId==='string' && !!value.publicationId;
  if(path==='/api/wechat/login') return typeof value.sessionToken==='string' && !!value.sessionToken && Number.isFinite(Date.parse(value.expiresAt));
  if(path.endsWith('/challenge')) return typeof value.templateId==='string' && (subscriptionStates.includes(value.state) || validateSubscription(value.state)) && (value.nonce===undefined || (typeof value.nonce==='string' && Number.isFinite(Date.parse(value.expiresAt))));
  return validateSubscription(value);
}
function requestError(status,body) {
  const safe=body && typeof body.error==='string' && body.error.length<=250 && /[\u4e00-\u9fff]/.test(body.error) ? body.error.replace(/[\u0000-\u001f]/g,'') : `资料暂时无法读取（${Number(status) || '请求异常'}）`;
  const error=new Error(safe);error.status=status;return error;
}
function createTransport(wxApi, config, {privateRequests=false}={}) {
  let cloudInit;
  return function request(path, etagOrOptions) {
    const options=privateRequests ? (etagOrOptions || {}) : {}, etag=privateRequests ? undefined : etagOrOptions;
    const method=privateRequests ? options.method || 'GET' : 'GET';
    const basePath=path.split('?')[0];
    const readPath=/^\/api\/v1\/bootstrap\?(?:[A-Za-z]+=[A-Za-z0-9%._~-]*)(?:&[A-Za-z]+=[A-Za-z0-9%._~-]*)*$/.test(path);
    const versionPath=basePath==='/api/v1/version' && (path===basePath || path==='/api/v1/version?light=1');
    let task, cancelled = false, rejectPending;
    const error = configurationError(config);
    const promise = new Promise((resolve, reject) => {
      rejectPending = reject;
      if (error) { reject(new Error(error)); return; }
      const allowed=privateRequests ? ((path==='/api/wechat/login' && method==='POST') || (path==='/api/wechat/subscription' && ['GET','DELETE'].includes(method)) || (['/api/wechat/subscription/challenge','/api/wechat/subscription/confirm'].includes(path) && method==='POST'))
        : (readPath || versionPath || ['/api/v1/bootstrap','/api/v1/forecasts'].includes(path) || forecastSnapshotPath.test(path) || /^\/api\/v1\/wechat\/code\/[^/?#]+$/.test(path) || /^\/api\/v1\/wechat\/scene\/[a-f0-9]{32}$/.test(path));
      if (!allowed) { reject(new Error('请求路径不受支持')); return; }
      if(privateRequests && path!=='/api/wechat/login' && !options.sessionToken){reject(requestError(401,{error:'请先点击微信提醒，重新建立当前会话。'}));return;}
      const header = typeof etag==='string' && etag ? { 'If-None-Match': `"${etag}"` } : {};
      if(privateRequests){header['content-type']='application/json';if(options.sessionToken)header.Authorization=`Bearer ${options.sessionToken}`;}
      const receive = response => {
        if (cancelled) return;
        if (response.statusCode === 304) { if (versionPath && etag) resolve({ unchanged: true }); else reject(new Error('接口未返回公开资料，请重新加载。')); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) { reject(requestError(response.statusCode,response.data)); return; }
        const body = response.data;
        if(body?.page && (!Array.isArray(body.page.ids)||!body.page.ids.every(id=>typeof id==='string')||!(body.page.nextCursor===null||typeof body.page.nextCursor==='string')||!Number.isSafeInteger(body.page.total)||body.page.total<0)){reject(new Error('分页资料格式不完整，请重试。'));return;}
        if (!body || typeof body !== 'object' || (basePath==='/api/v1/bootstrap' ? !validateBootstrap(body.data) || typeof body.version !== 'string' : versionPath ? !body.data || typeof body.data.version !== 'string' : path==='/api/v1/forecasts'||forecastSnapshotPath.test(path) ? !validForecastBody(path,body.data) : !validWechatBody(path,body.data))) { reject(new Error('接口返回的公开资料格式不完整，请稍后重试。')); return; }
        resolve(basePath==='/api/v1/bootstrap' ? { data: body.data, version: body.version, ...(body.contentVersion?{contentVersion:body.contentVersion}:{}), ...(body.page?{page:body.page}:{}) } : versionPath ? { version: body.data.version, ...(body.data.contentVersion?{contentVersion:body.data.contentVersion}:{}) } : {data:body.data});
      };
      const fail = () => { if (!cancelled) reject(new Error('连接失败，请检查网络或接口设置后重试。')); };
      const timeout = Math.max(1000, Math.min(60000, Number(config.timeoutMs) || 10000));
      if (config.mode === 'https') { try { task = wxApi.request({ url: config.baseUrl.replace(/\/$/, '') + path, method, data:options.data, header, timeout, success: receive, fail }); } catch (_) { fail(); } }
      else {
        if (!wxApi.cloud || typeof wxApi.cloud.callContainer !== 'function') { reject(new Error('当前微信版本不支持云服务，请更新微信。')); return; }
        try {
          if (!cloudInit) cloudInit = Promise.resolve(typeof wxApi.cloud.init === 'function' ? wxApi.cloud.init({ traceUser: false }) : undefined);
          cloudInit.then(() => { if (!cancelled) return wxApi.cloud.callContainer({ config: { env: config.cloudEnv }, path, method, data:options.data, header: { ...header, 'X-WX-SERVICE': config.serviceName }, timeout }); }).then(response => { if (!cancelled) receive(response); }).catch(() => { cloudInit = undefined; fail(); });
        } catch (_) { cloudInit = undefined; fail(); }
      }
    });
    return { promise, abort() { cancelled = true; rejectPending(new Error('请求已取消')); if (task && typeof task.abort === 'function') task.abort(); } };
  };
}
const createWechatTransport=(wxApi,config)=>createTransport(wxApi,config,{privateRequests:true});
module.exports = { configurationError, validateBootstrap, validateSubscription, createTransport, createWechatTransport };
