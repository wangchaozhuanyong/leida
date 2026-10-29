/** Owner-requested editorial notices. Preview by default; never called by worker or bootstrap. */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createAdminNotice } from '../src/lib/admin-notice';

const entries=z.array(z.object({requestId:z.string().uuid(),title:z.string(),body:z.string(),createdAt:z.string(),pinned:z.boolean()})).length(3).parse(
  JSON.parse(await readFile(new URL('./inbox-announcements-20261029.json',import.meta.url),'utf8')));
const timestamp=new Date().toISOString();
for(const entry of entries)createAdminNotice(entry,entry.requestId,timestamp);
if(new Set(entries.map(entry=>entry.requestId)).size!==entries.length)throw new Error('站内信请求编号重复');
if(!process.argv.includes('--apply')){
  console.log(JSON.stringify({mode:'preview',writes:0,notices:entries.map(({body,...entry})=>({...entry,body}))},null,2));
}else{
  // Uses the existing audited command and stable request IDs; does not touch facts or reminder credits.
  const {executeCommand}=await import('../src/server/service');
  const {pool,one}=await import('../src/db');
  const {hash}=await import('../src/server/domain');
  const actor='owner-inbox-20261029';
  try{
    // Preflight the complete batch before creating its first record.
    for(const entry of entries){
      const stored=await one<import('../src/lib/types').Notice>('notices',`notice_${hash(`${actor}:${entry.requestId}`).slice(0,32)}`);
      if(stored&&(stored.origin!=='admin'||stored.title!==entry.title||stored.body!==entry.body||stored.createdAt!==new Date(entry.createdAt).toISOString()||!!stored.pinned!==entry.pinned))throw new Error('既有站内信已变化，未覆盖；请先核对内容');
    }
    for(const entry of entries)await executeCommand('notice.publish',entry,actor);
    console.log(JSON.stringify({mode:'applied',count:entries.length,wechatMessages:0}));
  }finally{await pool.end();}
}
