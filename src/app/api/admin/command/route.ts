import {z} from 'zod';
import { requireAdmin,requireSameOrigin } from '@/server/auth';
import { executeCommand } from '@/server/service';
import {json,apiError,body} from '@/server/http';
export async function POST(request:Request){try{const actor=await requireAdmin(request);requireSameOrigin(request);const input=z.object({action:z.string().min(1).max(80),input:z.record(z.string(),z.unknown())}).safeParse(await body(request));if(!input.success)throw Object.assign(new Error('操作参数不完整'),{status:400});return json(await executeCommand(input.data.action,input.data.input,actor))}catch(e){return apiError(e)}}
