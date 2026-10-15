import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {parseTiboPublicPage} from '../src/server/tibo-public';
import {enrichKnownEvidence} from '../src/server/source-enrichment';
import {REPLAY_VERSION,replayTimeline,type ReplayInput,type ReplayRecord} from '../src/lib/historical-replay';
import type {Evidence} from '../src/lib/types';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=resolve(process.env.REPLAY_OUTPUT??root+'outputs/month-replay-20261016')+'/';
if(!output.startsWith(root+'outputs/'))throw new Error('输出必须位于本项目 outputs 内');
await mkdir(output,{recursive:true});
const old=fileURLToPath(new URL('../../../outputs/implementation-qa/replay-2months-20261012/replay-input.json',import.meta.url));
const saved=JSON.parse(await readFile(old,'utf8')) as {records:ReplayRecord[]};
const prior=await readFile(output+'input.json','utf8').then(text=>JSON.parse(text) as ReplayInput).catch(()=>undefined);
const end=prior?new Date(prior.window.end):new Date(),start=new Date(end);start.setUTCMonth(start.getUTCMonth()-1);
const notes=['使用目前可取得的公开原文版本，无法证明历史编辑或删除前的全文。','模拟两分钟发现，不代表历史实际采集延迟。','来源未提供可证明完整性的消息清单，覆盖保持未核验。'];
const rows:ReplayRecord[]=[...saved.records];
const existing=JSON.parse(await readFile(output+'existing-business-snapshot.json','utf8')) as {records:{evidence:Evidence[]}};
rows.push(...existing.records.evidence.filter(e=>e.provenance!=='manual'));
const captures:unknown[]=[];
const warmup=existing.records.evidence.filter(e=>e.sourceId==='reset-archive'&&Date.parse(e.publishedAt)<Date.parse('2026-08-11T16:00:00Z')).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)).slice(0,24);
for(let index=0;index<warmup.length;index+=3){
 const batch=await Promise.all(warmup.slice(index,index+3).map(async evidence=>{
  const original=await enrichKnownEvidence(evidence,async(url,init)=>{
   const response=await fetch(url,init);
   if(response.ok)await writeFile(output+`warmup-oembed-${evidence.messageId}.json`,await response.clone().text());
   return response;
  });
  captures.push({role:'warmup-original',messageId:evidence.messageId,originalVerified:!!original});
  return original?{...original,captureProvenance:'official-oembed-current-original'}:undefined;
 }));
 rows.push(...batch.filter((row):row is NonNullable<typeof row>=>!!row));
}
for(const replies of [false,true]){
  let cursor:string|undefined;const seen=new Set<string>();
  for(let page=0;page<(replies?48:12);page++){
    const url=new URL('https://api.fxtwitter.com/2/profile/thsottiaux/statuses');
    url.searchParams.set('count','100');if(replies)url.searchParams.set('with_replies','true');if(cursor)url.searchParams.set('cursor',cursor);
    try{
      const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!response.ok){await response.body?.cancel();captures.push({replies,page,status:response.status});break;}
      const raw=await response.json();const at=new Date().toISOString();
      const parsed=parseTiboPublicPage(raw,at);
      await writeFile(output+`capture-${at.replace(/[:.]/g,'-')}-${replies?'replies':'posts'}-${page}.json`,JSON.stringify(raw)+'\n');
      rows.push(...parsed.records.map(row=>({...row,captureProvenance:`fxembed-${replies?'replies':'posts'}-captured-${at}`})));
      captures.push({replies,page,count:parsed.records.length,oldest:parsed.records[0]?.publishedAt});
      const newest=parsed.newestId?Number((BigInt(parsed.newestId)>>22n)+1288834974657n):undefined;
      // Pinned posts and quoted context can be much older than the page itself.
      if(!parsed.nextToken||newest!==undefined&&newest<=start.getTime())break;
      if(seen.has(parsed.nextToken))throw new Error('分页重复');seen.add(parsed.nextToken);cursor=parsed.nextToken;
    }catch{captures.push({replies,page,status:'unavailable'});break;}
  }
}
const byId=new Map<string,ReplayRecord>();
for(const row of rows){
  if(Date.parse(row.publishedAt)>end.getTime())continue;
  const key=row.sourceId+':'+row.messageId,previous=byId.get(key);
  // Prefer original text; preserve capture files rather than inventing an edit time.
  if(previous?.textOrigin==='original'&&row.textOrigin!=='original')continue;
  if(previous&&previous.textOrigin===row.textOrigin&&Date.parse(previous.collectedAt)>Date.parse(row.collectedAt))continue;
  const {sourceId,messageId,url,text,parentId,publishedAt,collectedAt,contextComplete,provenance,textOrigin,metadata,captureProvenance}=row;
  byId.set(key,{sourceId,messageId,url,text,parentId,publishedAt,collectedAt,contextComplete,provenance,textOrigin,metadata,captureProvenance:captureProvenance??'previously-saved-public-evidence'});
}
const input:ReplayInput={version:REPLAY_VERSION,window:{start:start.toISOString(),end:end.toISOString()},capturedAt:new Date().toISOString(),coverage:{complete:false,notes},records:[...byId.values()].sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt)||a.messageId.localeCompare(b.messageId))};
const timeline=replayTimeline(input),serialized=JSON.stringify(input,null,2)+'\n';
await writeFile(output+'input.json',serialized);
await writeFile(output+'capture-report.json',JSON.stringify({window:input.window,capturedAt:input.capturedAt,captures,records:input.records.length,messagesInWindow:timeline.filter(t=>t.record&&t.phase==='evaluation').length,warmup:timeline.filter(t=>t.phase==='warmup').length,steps:timeline.length,inputSha256:createHash('sha256').update(serialized).digest('hex'),coverage:input.coverage},null,2)+'\n');
console.log(JSON.stringify({records:input.records.length,window:input.window,captures,steps:timeline.length}));
