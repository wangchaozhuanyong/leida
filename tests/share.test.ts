import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import jsQR from 'jsqr';
import { publicationUrl, isLocalShareUrl, requestShareOrigin } from '../src/lib/share';
import { qrSvg } from '../src/server/share-qr';
import { posterSvg } from '../src/server/poster';
import type { Publication } from '../src/lib/types';

interface RasterResult { data:Buffer; info:{width:number;height:number;channels:number}; }
interface RasterPipeline {
  flatten(options:{background:string}):RasterPipeline;
  png():RasterPipeline;
  ensureAlpha():RasterPipeline;
  raw():RasterPipeline;
  toBuffer():Promise<Buffer>;
  toBuffer(options:{resolveWithObject:true}):Promise<RasterResult>;
}
// QA only: Next already supplies sharp; the production share code does not import it.
const require=createRequire(import.meta.url);
const nextRequire=createRequire(require.resolve('next/package.json'));
const rasterize=nextRequire('sharp') as (input:Buffer)=>RasterPipeline;
const at='2026-10-10T08:00:00Z';
function publication():Publication {
  const eventId='event-1',id='pub-snapshot-1',articleId='article-1';
  return {id,eventId,articleId,publishedAt:at,cutoffAt:at,reason:'明确原文核验',mode:'state_change',
    event:{id:eventId,title:'重置卡已发放',version:2,status:'published',publicationId:id,updatedAt:at,evidenceIds:['e1'],actions:[{id:'card-1',kind:'banked_reset',stage:'claimed_complete',eligibility:'付费用户',scope:'public',evidenceIds:['e1'],statementAt:at}]},
    article:{id:articleId,eventId,title:'公告称重置卡已发放',summary:'原文明确说明重置卡已发放，个人账户是否到账尚未观测。',translation:'',category:'reset',version:3,status:'published',publicationId:id,evidenceIds:['e1'],publishedAt:at,updatedAt:at,publicationMode:'state_change'}};
}

async function decodedSvg(svg:string):Promise<{url:string;width:number;height:number}> {
  // Decode actual SVG rendering after a PNG round-trip, rather than rebuilding its matrix.
  const png=await rasterize(Buffer.from(svg)).flatten({background:'#112b40'}).png().toBuffer();
  assert.deepEqual(png.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  const {data,info}=await rasterize(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(info.channels,4);
  const code=jsQR(new Uint8ClampedArray(data),info.width,info.height,{inversionAttempts:'dontInvert'});
  assert.ok(code,'真实SVG光栅化后的二维码必须可以解码');
  return {url:code.data,width:info.width,height:info.height};
}

test('分享地址编码事件和固定发布版本，只使用来源origin',()=>{
  const selected={eventId:'事件/1',id:'发布/2 &?'};
  const result=publicationUrl('https://radar.example.org:8443/admin/preview?version=wrong#tab',selected);
  assert.equal(result,'https://radar.example.org:8443/events/%E4%BA%8B%E4%BB%B6%2F1?version=%E5%8F%91%E5%B8%83%2F2+%26%3F');
  const parsed=new URL(result);
  assert.equal(parsed.origin,'https://radar.example.org:8443');
  assert.equal(decodeURIComponent(parsed.pathname.slice('/events/'.length)),selected.eventId);
  assert.equal(parsed.searchParams.get('version'),selected.id); assert.equal(parsed.searchParams.size,1); assert.equal(parsed.hash,'');
  const old=publication(); old.event.publicationId='pub-new-current'; old.article.publicationId='pub-new-current';
  assert.equal(new URL(publicationUrl('https://radar.example.org',old)).searchParams.get('version'),'pub-snapshot-1');
});

test('本机地址明确识别，公开域名和仿冒localhost后缀不误标',()=>{
  for(const origin of ['http://127.0.0.1:5190','http://127.2.3.4:5190','http://0.0.0.0:5190','http://localhost:5190','http://preview.localhost:5190','http://[::1]:5190']) {
    assert.equal(isLocalShareUrl(publicationUrl(origin,publication())),true,origin);
  }
  for(const origin of ['https://radar.example.org','https://localhost.example.org','https://preview.localhost.example.org','https://127.0.0.1.example.org','https://0.0.0.0.example.org']) {
    assert.equal(isLocalShareUrl(publicationUrl(origin,publication())),false,origin);
  }
});

test('非网页协议和含认证信息的地址不能进入分享二维码',()=>{
  for(const value of ['javascript:alert(1)','file:///tmp/preview.html','data:text/plain,preview','https://username@radar.example.org']) {
    assert.throws(()=>publicationUrl(value,publication())); assert.throws(()=>qrSvg(value));
  }
});

test('Next内部localhost不覆盖浏览器127地址，完整海报解码仍指向浏览器origin',async()=>{
  const selected=publication();
  const request=new Request('http://localhost:5190/api/v1/posters/pub-snapshot-1',{headers:{host:'127.0.0.1:5190'}});
  const origin=requestShareOrigin(request);
  assert.equal(origin,'http://127.0.0.1:5190');
  const url=publicationUrl(origin,selected);
  assert.equal(url,'http://127.0.0.1:5190/events/event-1?version=pub-snapshot-1');
  assert.equal((await decodedSvg(posterSvg(selected,'模钥重置雷达',url))).url,url);
});

test('反向代理HTTPS与公开Host生成同一固定版本的完整海报',async()=>{
  const selected=publication(); selected.event.publicationId='pub-later-current';
  const request=new Request('http://localhost:5190/api/v1/posters/pub-snapshot-1',{headers:{host:'radar.example.org','x-forwarded-proto':'https'}});
  const origin=requestShareOrigin(request);
  assert.equal(origin,'https://radar.example.org');
  const url=publicationUrl(origin,selected);
  assert.equal(url,'https://radar.example.org/events/event-1?version=pub-snapshot-1');
  const svg=posterSvg(selected,'模钥重置雷达',url);
  assert.equal((await decodedSvg(svg)).url,url); assert.match(svg,/扫码查看此版本/); assert.ok(!svg.includes('本机预览码'));
});

test('Host中的路径、参数、认证信息和异常端口不能进入分享来源',()=>{
  for(const host of ['radar.example.org/path','radar.example.org?query=1','radar.example.org#fragment','username@radar.example.org','radar.example.org\\path','radar example.org','radar.example.org:invalid','radar.example.org,other.example.org']) {
    const request=new Request('http://localhost:5190/api/v1/posters/pub-snapshot-1',{headers:{host}});
    assert.throws(()=>requestShareOrigin(request),host);
  }
});

test('缺少Host时回退请求origin，非规范转发协议不会改变原请求协议',()=>{
  const request=new Request('https://radar.example.org:8443/api/v1/posters/pub-snapshot-1?wrong=1');
  assert.equal(requestShareOrigin(request),'https://radar.example.org:8443');
  assert.equal(publicationUrl(requestShareOrigin(request),publication()),'https://radar.example.org:8443/events/event-1?version=pub-snapshot-1');
  for(const protocol of ['https, http','ftp','HTTPS']) {
    const forwarded=new Request('http://localhost:5190/api/v1/posters/pub-snapshot-1',{headers:{host:'radar.example.org','x-forwarded-proto':protocol}});
    assert.equal(requestShareOrigin(forwarded),'http://radar.example.org');
  }
});

test('圆形网站二维码实际渲染为PNG后可解码固定版本链接',async()=>{
  const url=publicationUrl('https://radar.example.org',publication());
  const result=await decodedSvg(qrSvg(url));
  assert.equal(result.url,url); assert.equal(result.width,320); assert.equal(result.height,320);
});

test('密集长链接的圆形二维码保留完整点阵和静区',async()=>{
  const url=publicationUrl('https://radar.example.org',{eventId:'round-'+('x'.repeat(240)),id:'publication-'+('y'.repeat(220))});
  assert.ok(url.length>500);
  assert.equal((await decodedSvg(qrSvg(url))).url,url);
});

test('长中文标题及摘要的完整海报仍可解码，来源版本保持固定',async()=>{
  const selected=publication();
  selected.article.title='重置卡公开进展与适用范围已确认'.repeat(12);
  selected.article.summary='根据原始声明整理中文消息，资格与预计时间以来源为准。'.repeat(12);
  const url=publicationUrl('https://radar.example.org',selected);
  const svg=posterSvg(selected,'模钥重置雷达',url);
  const result=await decodedSvg(svg);
  assert.equal(result.url,url); assert.equal(result.width,900); assert.ok(result.height>1200);
  assert.match(svg,/资料截至/); assert.match(svg,/适用范围：付费用户/);
});

test('仅新闻海报实际嵌入二维码可解码，不携带已有事件福利动作',async()=>{
  const selected=publication(); selected.mode='news_only'; selected.article.publicationMode='news_only';
  selected.article.category='product'; selected.article.title='产品更新 <与> 中文消息 & 来源记录'; selected.article.version=7;
  const url=publicationUrl('https://radar.example.org',selected);
  const svg=posterSvg(selected,'模钥重置雷达',url);
  assert.equal((await decodedSvg(svg)).url,url);
  assert.ok(!svg.includes('适用范围：')); assert.match(svg,/仅新闻更新/); assert.match(svg,/第7版/); assert.match(svg,/&lt;与&gt;/);
});

test('本机预览海报保留提示，二维码与分享链接同为所选发布版本',async()=>{
  const selected=publication(),url=publicationUrl('http://127.0.0.1:5190',selected);
  const svg=posterSvg(selected,'模钥重置雷达',url);
  assert.match(svg,/本机预览码/); assert.match(svg,/手机访问需使用正式网站地址/);
  assert.equal((await decodedSvg(svg)).url,url);
});
