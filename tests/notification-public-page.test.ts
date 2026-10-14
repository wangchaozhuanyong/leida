import test from 'node:test';
import assert from 'node:assert/strict';
import {createNotificationPrewarmer} from '../src/server/notification-public-page';

const detail=()=>({data:{publications:[{id:'notice-version',eventId:'event',articleId:'article',event:{status:'published'},article:{status:'published'}}],events:[{id:'event',status:'published'}],articles:[{id:'article',status:'published'}]}});
test('通知预热请求命中网站进程；百人复用同一份预热，过期再读取',async()=>{
  let clock=0;const paths:string[]=[];
  const prepare=createNotificationPrewarmer({origin:()=> 'http://127.0.0.1:5196',clock:()=>clock,fetcher:async(input,options)=>{
    const url=new URL(String(input));assert.equal(url.origin,'http://127.0.0.1:5196');assert.equal(options?.redirect,'error');assert.equal(options?.cache,'no-store');
    assert.equal(options?.headers,undefined);paths.push(url.pathname+url.search);return Response.json(url.searchParams.get('view')==='home'?{data:{}}:detail());
  }});
  await Promise.all(Array.from({length:100},()=>prepare('notice-version')));assert.equal(paths.length,2);await prepare('notice-version');assert.equal(paths.length,2);
  clock=2000;await prepare('notice-version');assert.equal(paths.length,4);
});
test('预热失败暂缓重试；旧版本撤回不能被成功响应掩盖',async()=>{
  let clock=0,calls=0,healthy=false;
  const prepare=createNotificationPrewarmer({origin:()=> 'https://example.invalid',clock:()=>clock,fetcher:async input=>{
    calls++;const url=new URL(String(input)),body=detail();body.data.events[0].status=healthy?'published':'withdrawn';return Response.json(url.searchParams.get('view')==='home'?{data:{}}:body);
  }});
  await assert.rejects(prepare('notice-version'),/撤回/);await assert.rejects(prepare('notice-version'));assert.equal(calls,2);
  clock=5000;healthy=true;await prepare('notice-version');assert.equal(calls,4);
});
test('预热不接受带凭据或不安全的地址，参数错误时不发请求',async()=>{
  for(const origin of ['http://example.invalid','https://username:password@example.invalid','file:///tmp/example']){
    let calls=0;const prepare=createNotificationPrewarmer({origin:()=>origin,fetcher:async()=>{calls++;return Response.json(detail());}});
    await assert.rejects(prepare('notice-version'));assert.equal(calls,0);
  }
  let calls=0;const prepare=createNotificationPrewarmer({fetcher:async()=>{calls++;return Response.json(detail());}});await assert.rejects(prepare('../secret'));assert.equal(calls,0);
});
