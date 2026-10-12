import { requireAdmin } from '@/server/auth';
import { getAdminData } from '@/server/service';
import {json,apiError} from '@/server/http';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{await requireAdmin(request);return json(await getAdminData())}catch(e){return apiError(e)}}
