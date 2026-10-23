import { CloudbaseRpcError } from './cloudbase/rpc';
import {WechatServiceError} from './wechat-errors';

export function json(data:unknown,status=200){return Response.json({data},{status,headers:{'Cache-Control':'no-store'}})}
export function apiError(error:unknown){const e=error as {status?:number;message?:string;name?:string};const status=e.name==='ZodError'?400:e.status&&e.status>=400&&e.status<600?e.status:500;const retryAt=error instanceof WechatServiceError&&error.retryAt&&Number.isFinite(Date.parse(error.retryAt))?error.retryAt:undefined;return Response.json({error:status===500?'服务暂不可用，请稍后重试':e.name==='ZodError'?'提交内容不完整或格式有误，请检查必填项':e.message||'请求未完成',...(error instanceof CloudbaseRpcError?{diagnosticCode:error.diagnosticCode}:{}),...(retryAt?{retryAt}:{})},{status,headers:{'Cache-Control':'no-store',...(retryAt?{'Retry-After':String(Math.max(1,Math.ceil((Date.parse(retryAt)-Date.now())/1000)))}:{})}})}
export async function body(request:Request){const text=await request.text();if(text.length>1_000_000)throw Object.assign(new Error('提交内容过大'),{status:413});try{return JSON.parse(text)}catch{throw Object.assign(new Error('提交格式不正确'),{status:400})}}
