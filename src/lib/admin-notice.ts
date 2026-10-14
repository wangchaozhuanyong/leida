import { z } from 'zod';
import type { Notice } from './types';

const inputSchema = z.object({
  title: z.string().trim().min(2).max(80),
  body: z.string().trim().min(2).max(5000),
});
/** Standalone public inbox messages never manufacture an event or a WeChat grant. */
export function createAdminNotice(input: unknown, id: string, createdAt: string): Notice {
  const parsed = inputSchema.parse(input);
  return { id, eventId:'', publicationId:'', semanticKey:id, origin:'admin', title:parsed.title,
    body:parsed.body, summary:Array.from(parsed.body.replace(/\s+/g,' ')).slice(0,100).join(''),
    categories:['system'], status:'active', createdAt };
}
