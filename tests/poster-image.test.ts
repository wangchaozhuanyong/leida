import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createPosterFromEndpoint} from '../src/components/public/poster-image';

const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><text>固定公告版本</text></svg>';
function browser(t:TestContext, outcome:'fallback'|'failure'|'abort', controller=new AbortController()) {
  const sources:string[]=[],revoked:string[]=[];let requests=0,objects=0;
  class ImageFixture {
    naturalWidth=1080;naturalHeight=1920;
    onload:(()=>void)|null=null;onerror:(()=>void)|null=null;
    set src(value:string) {
      sources.push(value);
      if (!value) return;
      queueMicrotask(()=>{
        if (outcome==='abort') {controller.abort();return;}
        if (outcome==='fallback'&&value.startsWith('data:')) this.onload?.();
        else this.onerror?.();
      });
    }
  }
  t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(svg,{headers:{'Content-Type':'image/svg+xml; charset=utf-8','X-Poster-Code':'omitted'}});});
  t.mock.method(URL,'createObjectURL',()=>`blob:fixture-${++objects}`);
  t.mock.method(URL,'revokeObjectURL',(value:string)=>revoked.push(value));
  const previousImage=globalThis.Image,previousDocument=globalThis.document;
  Object.assign(globalThis,{Image:ImageFixture,document:{createElement:()=>({width:0,height:0,getContext:()=>({drawImage(){}}),toBlob:(done:(blob:Blob)=>void)=>done(new Blob(['png'],{type:'image/png'}))})}});
  t.after(()=>{Object.assign(globalThis,{Image:previousImage,document:previousDocument});});
  return {sources,revoked,controller,requests:()=>requests};
}
test('SVG blob 解码失败后使用同一固定响应生成 PNG，不重取或替换公告',async t=>{
  const f=browser(t,'fallback');
  const image=await createPosterFromEndpoint('/api/v1/posters/fixed?at=frozen','公告.png',f.controller.signal);
  assert.equal(f.requests(),1);assert.equal(image.blob.type,'image/png');assert.equal(image.codeState,'omitted');
  assert.equal(decodeURIComponent(f.sources[1].split(',')[1]),svg);
  assert.deepEqual(f.revoked,['blob:fixture-1']);
});
test('两种浏览器解码都失败时终止，不反复生成或请求',async t=>{
  const f=browser(t,'failure');
  await assert.rejects(createPosterFromEndpoint('/api/v1/posters/fixed','公告.png',f.controller.signal),/浏览器未能/);
  assert.equal(f.sources.length,2);assert.equal(f.requests(),1);assert.deepEqual(f.revoked,['blob:fixture-1']);
});
test('关闭海报时取消解码，不启动备用加载',async t=>{
  const f=browser(t,'abort');
  await assert.rejects(createPosterFromEndpoint('/api/v1/posters/fixed','公告.png',f.controller.signal),{name:'AbortError'});
  assert.equal(f.sources.some(src=>src.startsWith('data:')),false);assert.deepEqual(f.revoked,['blob:fixture-1']);
});
test('状态为200的非图片响应仍拒绝作为海报',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('<html>upstream page</html>',{headers:{'Content-Type':'text/html'}}));
  await assert.rejects(createPosterFromEndpoint('/api/v1/posters/fixed','公告.png',new AbortController().signal),/返回格式异常/);
});
for (const [status,message] of [[409,'公开状态已变化'],[410,'此内容已撤回']] as const) {
  test(`海报接口 ${status} 保留内容状态失效原因`,async t=>{
    t.mock.method(globalThis,'fetch',async()=>new Response('',{status}));
    await assert.rejects(createPosterFromEndpoint('/api/v1/posters/fixed','公告.png',new AbortController().signal),new RegExp(message));
  });
}
