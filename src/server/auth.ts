import 'dotenv/config';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { pool } from '@/db';
import { configuredStorageRpc } from './cloudbase/storage-config';
import { cloudbaseAuthAdapter } from './cloudbase/auth-adapter';
import { CloudbaseRpcError } from './cloudbase/rpc';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
const baseURL=process.env.BETTER_AUTH_URL||'http://127.0.0.1:5190';
export function createAuth(bootstrap=false,database?:BetterAuthOptions['database']){const rpc=database===undefined?configuredStorageRpc():undefined;database??=rpc?cloudbaseAuthAdapter(rpc,{ownerBootstrap:bootstrap}):pool;return betterAuth({database,baseURL,secret:process.env.BETTER_AUTH_SECRET,trustedOrigins:[baseURL],emailAndPassword:{enabled:true,disableSignUp:!bootstrap,minPasswordLength:12,maxPasswordLength:128,autoSignIn:false},session:{expiresIn:60*60*12,updateAge:60*60},rateLimit:{enabled:true,window:60,max:20},advanced:{useSecureCookies:baseURL.startsWith('https://')}})}
export const auth=createAuth();
export async function hasOwner(){const rpc=configuredStorageRpc();if(rpc){const result=await rpc.call<unknown>('radar_cb_owner_exists');if(typeof result!=='boolean')throw new CloudbaseRpcError('response');return result;}const result=await pool.query('SELECT count(*)::int AS count FROM "user"');return result.rows[0].count>0;}
export async function requireAdminPage(){if(!await hasOwner())redirect('/admin/setup');const session=await auth.api.getSession({headers:await headers()});if(!session)redirect('/admin/login');}
export async function requireAdmin(request:Request){const session=await auth.api.getSession({headers:request.headers});if(!session)throw Object.assign(new Error('请先登录管理后台'),{status:401});return session.user.id;}
export function requireSameOrigin(request:Request){if(request.headers.get('origin')!==new URL(baseURL).origin)throw Object.assign(new Error('请求来源不匹配，请刷新页面重试'),{status:403});}

export async function createOwner(input:{email:string;name:string;password:string}):Promise<void>{
  const rpc=configuredStorageRpc();if(rpc){if(await hasOwner())throw Object.assign(new Error('站长账号已建立，请登录'),{status:409});try{await createAuth(true).api.signUpEmail({body:input});}catch(error){if(await hasOwner())throw Object.assign(new Error('站长账号已建立或开户结果需要核对，请登录'),{status:409});throw error;}return;}
  const client=await pool.connect();try{await client.query('SELECT pg_advisory_lock(83951001)');if(await hasOwner())throw Object.assign(new Error('站长账号已建立，请登录'),{status:409});await createAuth(true).api.signUpEmail({body:input});}finally{try{await client.query('SELECT pg_advisory_unlock(83951001)');}finally{client.release();}}
}
