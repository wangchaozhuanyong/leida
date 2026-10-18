import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchRecords,SourceRateLimitError,SourceStructureError} from '../src/server/ingestion';
import {REFERENCE_RESET_SOURCE,REFERENCE_SIGNAL_SOURCE,REFERENCE_HISTORY_SOURCE,referenceContentsURL} from '../src/server/reference-reset-source';

function snapshot(){
 const occurredAt=new Date(Date.now()-60_000).toISOString(),id=((BigInt(Date.parse(occurredAt))-1288834974657n)<<22n).toString();
 const source={url:`https://x.com/thsottiaux/status/${id}`};
 return {schema_version:1,generated_at:new Date().toISOString(),last_global_reset:{event_id:'fixture-global',reset_type:'global',record_status:'recorded',occurred_at:occurredAt,source},latest_signal:{signal_id:id,recorded_at:occurredAt,summary:'Done',source}};
}
const diagnostics=async()=>{};

test('参考快照只允许同一公开仓库的固定文件，Contents读取保留canonical证据及HTTP缓存',async()=>{
 for(const source of [REFERENCE_RESET_SOURCE,REFERENCE_SIGNAL_SOURCE,REFERENCE_HISTORY_SOURCE])assert.match(referenceContentsURL(source)!,/^https:\/\/api\.github\.com\/repos\/gdutxiaoxu\/codex-reset-radar\/contents\/data\/(latest|signals|resets)\.json\?ref=master$/);
 assert.equal(referenceContentsURL({...REFERENCE_RESET_SOURCE,url:'https://example.invalid/latest.json'}),undefined);
 assert.equal(referenceContentsURL({...REFERENCE_RESET_SOURCE,kind:'timeline'}),undefined);
 const body=snapshot(),requests:string[]=[];
 const source={...REFERENCE_RESET_SOURCE,enabled:true,validated:true,publicationPaused:false};
 const records=await fetchRecords(source,false,{onRequestEvent:diagnostics,fetcher:async(input,init)=>{
  requests.push(String(input));assert.equal(String(input),referenceContentsURL(source));
  const headers=new Headers(init?.headers);assert.equal(headers.get('Accept'),'application/vnd.github.raw+json');assert.equal(headers.has('authorization'),false);assert.equal(headers.has('cookie'),false);assert.equal(init?.redirect,'error');
  return Response.json(body,{headers:{ETag:'"public-reference"'}});
 }});
 assert.equal(requests.length,1);assert.equal(records[0].metadata?.referenceReset?.referenceUrl,REFERENCE_RESET_SOURCE.url);assert.equal(records[0].textOrigin,'archive_excerpt');assert.equal(records[0].contextComplete,false);
 const cached={...source,httpCheckpoints:{[referenceContentsURL(source)!]:{bodyHash:'fixture',etag:'"public-reference"'}}};
 assert.deepEqual(await fetchRecords(cached,false,{onRequestEvent:diagnostics,fetcher:async(input,init)=>{assert.equal(String(input),referenceContentsURL(source));assert.equal(new Headers(init?.headers).get('If-None-Match'),'"public-reference"');return new Response(null,{status:304});}}),[]);
});

test('Contents暂时不可用时有界回退原文件；不新增鉴权或改写来源',async()=>{
 const calls:string[]=[],events:unknown[]=[],body=snapshot();
 const result=await fetchRecords(REFERENCE_RESET_SOURCE,false,{onRequestEvent:async event=>{events.push(event);},sleep:async()=>{},fetcher:async input=>{
  calls.push(String(input));return String(input)===REFERENCE_RESET_SOURCE.url?Response.json(body):new Response('temporary provider body',{status:503});
 }});
 assert.deepEqual(calls,[referenceContentsURL(REFERENCE_RESET_SOURCE),referenceContentsURL(REFERENCE_RESET_SOURCE),referenceContentsURL(REFERENCE_RESET_SOURCE),REFERENCE_RESET_SOURCE.url]);
 assert.equal(result.length,1);assert.equal(events.length,3);assert.doesNotMatch(JSON.stringify(events),/provider body|https:/);
});

test('限流和格式错误不换通路，诊断不包含响应正文',async()=>{
 const originalWarn=console.warn,messages:unknown[][]=[];console.warn=(...args:unknown[])=>{messages.push(args);};
 try{
  for(const status of [429,403]){
   let count=0;
   await assert.rejects(fetchRecords(REFERENCE_RESET_SOURCE,false,{onRequestEvent:diagnostics,fetcher:async()=>{count++;return new Response('private provider failure',{status,headers:{'x-ratelimit-remaining':'0','retry-after':'60'}});}}),SourceRateLimitError);
   assert.equal(count,1);
  }
  let count=0;
  await assert.rejects(fetchRecords(REFERENCE_RESET_SOURCE,false,{onRequestEvent:diagnostics,fetcher:async()=>{count++;return Response.json({secret:'provider response must not leak'});}}),SourceStructureError);
  assert.equal(count,1);assert.deepEqual(messages.map(args=>args[2]),['RATE_LIMIT','RATE_LIMIT','FORMAT']);assert.doesNotMatch(JSON.stringify(messages),/private|secret|provider|https:/);
 }finally{console.warn=originalWarn;}
});
