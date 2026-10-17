import { z } from 'zod';
import type { Notice } from './types';

const inputSchema = z.object({
  title: z.string().trim().min(2).max(80),
  body: z.string().trim().min(2).max(5000),
  createdAt: z.string().datetime({offset:true}).optional(),
});
/** Standalone public inbox messages never manufacture an event or a WeChat grant. */
export function createAdminNotice(input: unknown, id: string, createdAt: string): Notice {
  const parsed = inputSchema.refine(value=>!value.createdAt||Date.parse(value.createdAt)<=Date.parse(createdAt),'显示日期不能晚于当前时间').parse(input);
  return { id, eventId:'', publicationId:'', semanticKey:id, origin:'admin', title:parsed.title,
    body:parsed.body, summary:Array.from(parsed.body.replace(/\s+/g,' ')).slice(0,100).join(''),
    categories:['system'], status:'active', createdAt:parsed.createdAt?new Date(parsed.createdAt).toISOString():createdAt };
}
