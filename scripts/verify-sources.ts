import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pool, one } from '../src/db';
import { validateSource, collectSource, sourceDefinitions } from '../src/server/ingestion';
import { executeCommand } from '../src/server/service';
import type { Source } from '../src/lib/types';
const results:unknown[]=[];
try {
 // Targeted timeline collection is accepted separately; this batch must not enable it.
 for (const source of sourceDefinitions.filter(s=>s.kind!=='manual'&&s.kind!=='timeline')) {
  try {
   const validation=await validateSource(source.id,'local-acceptance');
   const first=await collectSource(source.id);
   const repeat=await collectSource(source.id);
   const current=await one<Source>('sources',source.id);
   if(!current)throw new Error('来源记录不存在');
   await executeCommand('source.save',{id:source.id,version:current.version,enabled:true},'local-acceptance');
   const result={source:source.id,validation,first,repeat,enabled:true};results.push(result);console.log(JSON.stringify(result));
  } catch(error) {const result={source:source.id,passed:false,error:error instanceof Error?error.message:'来源验证失败'};results.push(result);console.log(JSON.stringify(result));}
 }
 mkdirSync('outputs/implementation-qa',{recursive:true});
 writeFileSync('outputs/implementation-qa/source-verification.json',JSON.stringify({checkedAt:new Date().toISOString(),results,qualityMetrics:{omissionRate:'NOT_MEASURED',factErrorRate:'NOT_MEASURED',endToEndAI:'NOT_CONFIGURED'}},null,2));
} finally {await pool.end();}
