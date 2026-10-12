import 'dotenv/config';
import { betterAuth } from 'better-auth';
import { pool } from '@/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
const baseURL=process.env.BETTER_AUTH_URL||'http://127.0.0.1:5190';
export function createAuth(bootstrap=false){return betterAuth({database:pool,baseURL,secret:process.env.BETTER_AUTH_SECRET,trustedOrigins:[baseURL],emailAndPassword:{enabled:true,disableSignUp:!bootstrap,minPasswordLength:12,maxPasswordLength:128,autoSignIn:false},session:{expiresIn:60*60*12,updateAge:60*60},rateLimit:{enabled:true,window:60,max:20},advanced:{useSecureCookies:baseURL.startsWith('https://')}})}
export const auth=createAuth();
export async function hasOwner(){const result=await pool.query('SELECT count(*)::int AS count FROM "user"');return result.rows[0].count>0;}
export async function requireAdminPage(){if(!await hasOwner())redirect('/admin/setup');const session=await auth.api.getSession({headers:await headers()});if(!session)redirect('/admin/login');}
export async function requireAdmin(request:Request){const session=await auth.api.getSession({headers:request.headers});if(!session)throw Object.assign(new Error('请先登录管理后台'),{status:401});return session.user.id;}
export function requireSameOrigin(request:Request){if(request.headers.get('origin')!==new URL(baseURL).origin)throw Object.assign(new Error('请求来源不匹配，请刷新页面重试'),{status:403});}
