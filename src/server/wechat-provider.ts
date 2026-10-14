import { WechatServiceError } from './wechat-errors';
export { WechatServiceError } from './wechat-errors';
export type { WechatFailure } from './wechat-errors';
import { validateWechatImage } from './wechat-image';

const origin='https://api.weixin.qq.com';
function connectionFailure(error:unknown):WechatServiceError {
  const pending:unknown[]=[error],seen=new Set<unknown>(),codes=new Set<string>();let timedOut=false;
  // Native fetch nests failures in cause/AggregateError. Read only their codes,
  // never provider URLs, messages, stacks or request options containing secrets.
  for(let i=0;i<pending.length&&i<16;i++) {
    const item=pending[i];if(!item||typeof item!=='object'||seen.has(item))continue;seen.add(item);
    const value=item as {code?:unknown;name?:unknown;cause?:unknown;errors?:unknown};
    if(typeof value.code==='string')codes.add(value.code);
    if(value.name==='TimeoutError'||value.name==='AbortError')timedOut=true;
    if(value.cause)pending.push(value.cause);
    if(Array.isArray(value.errors))pending.push(...value.errors.slice(0,8));
  }
  const message=['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID'].some(code=>codes.has(code))
    ?'微信接口证书校验失败，请联系站长检查云端证书配置'
    :['ENOTFOUND','EAI_AGAIN'].some(code=>codes.has(code))?'微信接口域名解析失败，请稍后重试'
    :timedOut||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT'].some(code=>codes.has(code))?'微信接口连接超时，请稍后重试'
    :['ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','UND_ERR_SOCKET'].some(code=>codes.has(code))?'微信接口网络连接失败，请稍后重试'
    :'微信接口暂时无法连接';
  return new WechatServiceError(message,'transient');
}
/** No provider URL, body or error message is copied into application logs. */
export function createWechatProvider(fetcher:typeof fetch=fetch) {
  async function bytes(response:Response,limit:number):Promise<Buffer> {
    if(Number(response.headers.get('content-length'))>limit)throw new WechatServiceError('微信接口返回内容过大','configuration');
    if(!response.body)throw new WechatServiceError('微信接口未返回内容','configuration');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
    try {while(true){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.byteLength;if(length>limit){await reader.cancel();throw new WechatServiceError('微信接口返回内容过大','configuration');}chunks.push(chunk.value);}}
    catch(error){if(error instanceof WechatServiceError)throw error;throw new WechatServiceError('微信接口响应中断','transient');}
    finally {reader.releaseLock();}return Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)),length);
  }
  async function request(path:string,body?:Record<string,unknown>):Promise<Response> {
    try {
      const response=await fetcher(`${origin}${path}`,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15_000)});
      if(!response.ok)throw new WechatServiceError('微信接口响应异常','transient');
      return response;
    } catch(error) {if(error instanceof WechatServiceError)throw error;throw connectionFailure(error);}
  }
  async function json(path:string,body?:Record<string,unknown>):Promise<Record<string,unknown>> {
    const response=await request(path,body);
    const text=(await bytes(response,100_000)).toString('utf8');
    let data:Record<string,unknown>;
    try {data=JSON.parse(text);}catch {throw new WechatServiceError('微信接口返回结构异常','configuration');}
    if(!data||typeof data!=='object'||Array.isArray(data))throw new WechatServiceError('微信接口返回结构异常','configuration');
    if(typeof data.errcode==='number'&&data.errcode!==0)throw new WechatServiceError(`微信接口拒绝请求（错误码 ${data.errcode}）`,[-1,45009,45011].includes(data.errcode)?'transient':'rejected',data.errcode);
    return data;
  }
  return {
    async login(appId:string,secret:string,code:string) {
      const query=new URLSearchParams({appid:appId,secret,js_code:code,grant_type:'authorization_code'});
      const data=await json(`/sns/jscode2session?${query}`);
      if(typeof data.openid!=='string'||!/^[A-Za-z0-9_-]{10,128}$/.test(data.openid))throw new WechatServiceError('微信登录未返回有效身份','rejected');
      // session_key/unionid are intentionally neither returned nor persisted.
      return data.openid;
    },
    async accessToken(appId:string,secret:string) {
      const data=await json('/cgi-bin/stable_token',{appid:appId,secret,grant_type:'client_credential',force_refresh:false});
      if(typeof data.access_token!=='string'||data.access_token.length<10||data.access_token.length>4096||typeof data.expires_in!=='number'||data.expires_in<10||data.expires_in>7200)throw new WechatServiceError('微信凭据返回结构异常','configuration');
      return {token:data.access_token,expiresIn:data.expires_in};
    },
    async code(token:string,scene:string,envVersion:string) {
      const response=await request(`/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`,{scene,page:'pages/detail/index',check_path:true,env_version:envVersion,width:430});
      const image=await bytes(response,2_000_000);
      if(image[0]===123||image[0]===91) {
        let errcode:number|undefined;try {const data=JSON.parse(image.toString('utf8'));if(typeof data.errcode==='number')errcode=data.errcode;}catch{}
        throw new WechatServiceError(errcode===undefined?'微信未返回真实小程序码':`微信小程序码未生成（错误码 ${errcode}）`,'rejected',errcode);
      }
      return {image,contentType:validateWechatImage(image)};
    },
    async send(token:string,body:Record<string,unknown>) {
      try {
        const data=await json(`/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`,body);
        // This is acceptance by WeChat, not an observation that a reader saw it.
        if(data.errcode!==0)throw new WechatServiceError('微信发送结果无法确认','unknown');
        return {errorCode:0};
      } catch(error) {
        if(error instanceof WechatServiceError&&error.errorCode!==undefined)throw new WechatServiceError(error.message,'rejected',error.errorCode);
        // No provider idempotency key: retrying an ambiguous send may consume another grant.
        throw new WechatServiceError('微信发送结果未知，已停止自动重发','unknown');
      }
    }
  };
}
