import { z } from 'zod';
import { pool } from '@/db';
import { createAuth,hasOwner,requireSameOrigin } from '@/server/auth';
import {apiError,body} from '@/server/http';
export const dynamic='force-dynamic';
export async function GET(){try{return Response.json({initialized:await hasOwner()},{headers:{'Cache-Control':'no-store'}})}catch(e){return apiError(e)}}
export async function POST(request:Request){let client;try{requireSameOrigin(request);if(!['127.0.0.1','localhost','[::1]'].includes(new URL(process.env.BETTER_AUTH_URL||request.url).hostname))throw Object.assign(new Error('首次初始化仅允许在本机完成'),{status:403});const input=z.object({email:z.email(),name:z.string().trim().min(1).max(60),password:z.string().min(12).max(128)}).safeParse(await body(request));if(!input.success)throw Object.assign(new Error('请填写有效邮箱、姓名及至少12位密码'),{status:400});client=await pool.connect();await client.query('SELECT pg_advisory_lock(83951001)');if(await hasOwner())throw Object.assign(new Error('站长账号已建立，请登录'),{status:409});await createAuth(true).api.signUpEmail({body:input.data});return Response.json({initialized:true});}catch(e){return apiError(e)}finally{if(client){await client.query('SELECT pg_advisory_unlock(83951001)');client.release()}}}
