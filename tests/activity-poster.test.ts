import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import jsQR from 'jsqr';
import type { Activity, PublicData, Publication } from '../src/lib/types';
import { ACTIVITY_RULES_NOTICE, ActivityShareError, MAX_ACTIVITY_PUBLICATIONS, MAX_ACTIVITY_SHARE_URL, activityDate, activityPublicationUrl, activityShareQuery, buildActivityShare, normalizeActivityShare, parseActivityShare, resolveActivityShare, type ActivityDayShare } from '../src/lib/activity-share';
import { activityPosterSvg, resolveActivityPoster } from '../src/server/activity-poster';

const at='2026-10-10T08:00:00Z';
function fixture():PublicData{return {events:[],articles:[],publications:[],evidence:[],sources:[{id:'official',name:'官方公开资料',status:'healthy'}],notices:[],activities:[{id:'activity',title:'每日活动公开进展',version:2,timezone:'America/Los_Angeles',startsOn:'2026-03-07',days:3,rules:'以公开声明和明确资格为准。',items:[]}],site:{name:'模钥重置雷达',description:'',autoPublish:true,version:1},serverTime:at};}
function add(data:PublicData, id:string, sourceTime='2026-03-08T10:00:00Z', day=2, mode:'state_change'|'news_only'='state_change'):Publication {
  const articleId=`article-${data.publications.length}`,eventId=`event-${data.publications.length}`,evidenceId=`evidence-${data.publications.length}`;
  const publication:Publication={id,eventId,articleId,publishedAt:at,cutoffAt:at,reason:'公开来源核验',mode,
    event:{id:eventId,title:'活动公开进展',status:'published',version:2,publicationId:id,evidenceIds:[evidenceId],updatedAt:at,actions:[{id:`action-${id}`,kind:'banked_reset',stage:'claimed_complete',eligibility:'付费用户',scope:'public',evidenceIds:[evidenceId],statementAt:sourceTime}]},
    article:{id:articleId,eventId,publicationId:id,status:'published',version:3,title:`中文公告 ${id}`,summary:'根据来源声明整理，个人账户是否到账尚未观测。',translation:'',category:'activity',evidenceIds:[evidenceId],publishedAt:at,updatedAt:at,sourcePublishedAt:sourceTime,publicationMode:mode,historical:true}};
  data.publications.push(publication);data.events.push(structuredClone(publication.event));data.articles.push(structuredClone(publication.article));
  data.evidence.push({id:evidenceId,sourceId:'official',messageId:id,url:`https://example.invalid/source/${encodeURIComponent(id)}`,text:'Exact original public evidence.',publishedAt:sourceTime,collectedAt:at,hash:'fixture',contextComplete:true,historical:true,provenance:'official',textOrigin:'original'});
  data.activities[0].items.push({day,articleId,eventId});return publication;
}
const manifest=(publicationIds:string[]):ActivityDayShare=>({activityId:'activity',day:2,publicationIds});
function blocked(data:PublicData,selected:ActivityDayShare){const result=resolveActivityShare(data,selected);assert.equal(result.available,false);if(result.available)assert.fail('应拒绝生成');return result;}

test('活动整合只读指定快照、按来源时间先后排序，不拼接当前文章',()=>{
  const data=fixture(),late=add(data,'late','2026-03-08T13:00:00Z'),early=add(data,'early','2026-03-08T11:00:00Z');
  late.publishedAt='2026-10-09T00:00:00Z';early.publishedAt='2026-10-10T00:00:00Z';
  const updated=structuredClone(early);updated.id='new-early';updated.article.publicationId=updated.id;updated.article.title='最新措辞不能覆盖选定旧版本';updated.article.version++;
  data.publications.push(updated);data.articles[1]=updated.article;data.events[1].publicationId=updated.id;
  const before=structuredClone(data),selected=manifest(['late','early','early']);
  const result=resolveActivityPoster(data,selected);
  assert.deepEqual(result.publications.map(item=>item.id),['early','late']);assert.equal(result.items[0].publication.article.title,'中文公告 early');assert.equal(result.date,'2026-03-08');assert.equal(result.timezone,'America/Los_Angeles');assert.equal(result.rulesNotice,ACTIVITY_RULES_NOTICE);assert.equal(result.cutoffAt,at);
  assert.deepEqual(data,before);assert.deepEqual(selected.publicationIds,['late','early','early']);
});
test('分享manifest去重、规范排序并完整往返中文和保留字符，只用来源origin',()=>{
  const selected={activityId:'活动/1',day:2,publicationIds:['版本,二/ &?','a','a']};
  const url=activityPublicationUrl('https://radar.example.org:8443/admin?wrong=1#preview',selected),parsed=new URL(url);
  assert.equal(parsed.origin,'https://radar.example.org:8443');assert.equal(decodeURIComponent(parsed.pathname.slice('/activities/'.length)),selected.activityId);assert.equal(parsed.hash,'');
  assert.deepEqual(parsed.searchParams.getAll('publication'),['a','版本,二/ &?']);assert.deepEqual(parseActivityShare(selected.activityId,parsed.searchParams),normalizeActivityShare(selected));
  assert.equal(activityPublicationUrl('https://radar.example.org:8443',{...selected,publicationIds:selected.publicationIds.slice().reverse()}),url);
  assert.equal(parsed.searchParams.toString(),activityShareQuery(selected).toString());
  for(const origin of ['file:///preview','javascript:alert(1)','https://username@radar.example.org'])assert.throws(()=>activityPublicationUrl(origin,selected),/网站地址/);
});
test('活动日期按日历天推算，跨夏令时和闰日正确，非法日期和实际天数拒绝',()=>{
  const activity=fixture().activities[0];assert.equal(activityDate(activity,3),'2026-03-09');
  assert.equal(activityDate({...activity,timezone:'Asia/Shanghai',startsOn:'2024-02-28'},2),'2024-02-29');
  for(const day of [0,-1,1.5,4,NaN])assert.throws(()=>activityDate(activity,day),/范围/);
  assert.throws(()=>activityDate({...activity,startsOn:'2026-02-30'},1),/日期无效/);assert.throws(()=>activityDate({...activity,timezone:'No/Such_Zone'},1),/时区无效/);
  const data=fixture();add(data,'p');assert.match(blocked(data,{...manifest(['p']),day:4}).blockedReason,/范围/);
});
test('URL必须指定唯一整数天数和完整版本集合，不接受模糊输入',()=>{
  for(const day of ['', '0','-1','1.5','1e0','+1',' 1','01','367'])assert.throws(()=>parseActivityShare('activity',new URLSearchParams({day,publication:'p'})),ActivityShareError);
  assert.throws(()=>parseActivityShare('activity',new URLSearchParams('day=1&day=2&publication=p')),/天数/);
  assert.throws(()=>parseActivityShare('activity',new URLSearchParams('day=1')),/尚未选择活动内容/);
  assert.throws(()=>parseActivityShare('activity',new URLSearchParams('day=1&publication=')),/分享链接无效/);
  assert.throws(()=>normalizeActivityShare(manifest(['x'.repeat(181)])),/分享链接无效/);
});
test('缺失、部分缺失、错误日期与错误活动关联都拒绝，不静默使用其他版本',()=>{
  const data=fixture();add(data,'p');
  assert.match(blocked(data,manifest(['p','missing'])).blockedReason,/部分分享内容已不可用/);
  assert.match(blocked(data,{...manifest(['p']),day:1}).blockedReason,/所选活动日期不一致/);
  const other:Activity={...data.activities[0],id:'other',items:[]};data.activities.push(other);
  assert.match(blocked(data,{...manifest(['p']),activityId:'other'}).blockedReason,/所选活动日期不一致/);
  const bad=structuredClone(data);bad.publications[0].article.publicationId='not-this-snapshot';assert.match(blocked(bad,manifest(['p'])).blockedReason,/分享内容暂不可用/);
  const absent=structuredClone(data);absent.articles=[];assert.match(blocked(absent,manifest(['p'])).blockedReason,/分享内容暂不可用/);
  assert.equal(blocked(data,{...manifest(['p']),activityId:'missing'}).status,404);
});
test('当前及历史快照撤回或合并时全部拒绝，不生成部分海报',()=>{
  const original=fixture();add(original,'p');add(original,'valid');
  const changes=[(data:PublicData)=>data.articles[0].status='withdrawn',(data:PublicData)=>data.events[0].status='withdrawn',(data:PublicData)=>data.publications[0].article.status='withdrawn',(data:PublicData)=>data.publications[0].event.status='withdrawn',(data:PublicData)=>data.events[0].status='merged',(data:PublicData)=>data.publications[0].event.status='merged'];
  for(const change of changes){const data=structuredClone(original);change(data);assert.equal(blocked(data,manifest(['p','valid'])).status,409);assert.throws(()=>resolveActivityPoster(data,manifest(['p','valid'])),ActivityShareError);}
});
test('同一文章多个版本、重复活动跨日期与来源缺口不能合并',()=>{
  const data=fixture(),p=add(data,'p'),newer=structuredClone(p);newer.id='p-new';newer.article.publicationId=newer.id;data.publications.push(newer);
  assert.match(blocked(data,manifest(['p','p-new'])).blockedReason,/同一条消息请勿重复选择/);
  const ambiguous=structuredClone(data);ambiguous.activities[0].items.push({...ambiguous.activities[0].items[0],day:1});assert.match(blocked(ambiguous,manifest(['p'])).blockedReason,/所选活动日期不一致/);
  const absent=structuredClone(data);absent.evidence=[];assert.match(blocked(absent,manifest(['p'])).blockedReason,/部分来源暂不可用/);
});
test('自动选当日已发布文章形成显式集合，空日及超过8条不静默截断',()=>{
  const data=fixture();assert.throws(()=>buildActivityShare(data,'activity',2),/暂无可整合/);
  add(data,'first');add(data,'other-day',undefined,1);const removed=add(data,'removed');data.articles.find(item=>item.id===removed.articleId)!.status='withdrawn';
  assert.deepEqual(buildActivityShare(data,'activity',2),manifest(['first']));
  const many=fixture();for(let i=0;i<MAX_ACTIVITY_PUBLICATIONS+1;i++)add(many,`p-${i}`);
  assert.throws(()=>buildActivityShare(many,'activity',2),/最多包含8条/);assert.match(blocked(many,manifest(many.publications.map(item=>item.id))).blockedReason,/单条公告/);
  assert.deepEqual(normalizeActivityShare(manifest(Array(12).fill('same'))).publicationIds,['same']);
});
test('URL有明确长度上限，超长版本集合在二维码生成前拒绝',()=>{
  const selected=manifest(['汉'.repeat(180),'字'.repeat(180)]);
  assert.throws(()=>activityShareQuery(selected),/链接过长/);assert.throws(()=>activityPublicationUrl('https://radar.example.org',selected),/链接过长/);
  assert.throws(()=>parseActivityShare('activity',new URLSearchParams(`day=1&publication=${'x'.repeat(MAX_ACTIVITY_SHARE_URL)}`)),/链接过长/);
});

interface RasterResult {data:Buffer;info:{width:number;height:number;channels:number};}
interface RasterPipeline {flatten(options:{background:string}):RasterPipeline;png():RasterPipeline;ensureAlpha():RasterPipeline;raw():RasterPipeline;toBuffer():Promise<Buffer>;toBuffer(options:{resolveWithObject:true}):Promise<RasterResult>;}
const require=createRequire(import.meta.url),nextRequire=createRequire(require.resolve('next/package.json'));
const rasterize=nextRequire('sharp') as (input:Buffer)=>RasterPipeline;
async function decoded(svg:string){const png=await rasterize(Buffer.from(svg)).flatten({background:'#112b40'}).png().toBuffer();const {data,info}=await rasterize(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});const code=jsQR(new Uint8ClampedArray(data),info.width,info.height,{inversionAttempts:'dontInvert'});assert.ok(code,'整张SVG转为PNG后二维码应能独立解码');return {url:code.data,height:info.height};}
test('每日SVG保留来源及长文截断提示，实际PNG二维码对应同一明确集合',async()=>{
  const data=fixture(),first=add(data,'early'),news=add(data,'news','2026-03-08T13:00:00Z',2,'news_only');
  first.article.title='长中文标题与活动公开进展'.repeat(20)+' <来源> & 核对';first.article.summary='中文长摘要包含明确资格，不能冒充个人到账。'.repeat(100);
  news.article.title='仅新闻消息';data.activities[0].title='活动 <标题> & 来源';
  const result=resolveActivityPoster(data,manifest(['news','early'])),url=activityPublicationUrl('https://radar.example.org',result.manifest),svg=activityPosterSvg(result,'模钥重置雷达',url);
  assert.match(svg,/官方资料 · 官方公开资料/);assert.match(svg,/内容较长|已截短/);assert.match(svg,/发放状态请查看对应重置消息/);assert.match(svg,/活动规则以当前公布内容为准/);assert.match(svg,/网页二维码，非微信小程序码/);assert.match(svg,/&lt;标题&gt; &amp; 来源/);assert.ok(svg.indexOf('第1条')<svg.indexOf('第2条'));
  assert.equal((await decoded(svg)).url,url);
  assert.throws(()=>activityPosterSvg(result,'模钥重置雷达',activityPublicationUrl('https://radar.example.org',{...result.manifest,publicationIds:['early']})),/不一致/);
});

test('活动海报与页面共用摘要清理，保留来源与人工内容，不改写分享集合',()=>{
  const data=fixture(),p=add(data,'p');
  p.article.contentOrigin='template';
  p.article.summary='辅助归档将此条列为第 2 天产品动态。归档摘录：“Pro 用户速度提升约50%”。这是来源消息，完整细节以原帖为准。';
  const before=structuredClone(data),selected=manifest(['p']);
  const result=resolveActivityPoster(data,selected),url=activityPublicationUrl('https://radar.example.org',result.manifest);
  const svg=activityPosterSvg(result,'模钥重置雷达',url);
  assert.match(svg,/Pro 用户速度提升约50%/);assert.doesNotMatch(svg,/辅助归档将|归档摘录|第3版/);
  assert.match(svg,/官方公开资料/);assert.deepEqual(result.manifest,selected);assert.deepEqual(data,before);
  p.article.manualFields=['summary'];
  assert.match(activityPosterSvg(resolveActivityPoster(data,selected),'模钥重置雷达',url),/辅助归档将/,'人工编辑的内容不被自动清理');
});
test('最大8条长版本ID的每日海报仍可实际解码，本机码明确提示',async()=>{
  const data=fixture();for(let i=0;i<MAX_ACTIVITY_PUBLICATIONS;i++)add(data,`p${i}-${'x'.repeat(170)}`,`2026-03-08T${String(10+i).padStart(2,'0')}:00:00Z`);
  const result=resolveActivityPoster(data,buildActivityShare(data,'activity',2)),url=activityPublicationUrl('http://127.0.0.1:5190',result.manifest);
  assert.ok(url.length>1400&&url.length<=MAX_ACTIVITY_SHARE_URL);const svg=activityPosterSvg(result,'模钥重置雷达',url);assert.match(svg,/本机预览/);assert.equal((await decoded(svg)).url,url);
});
test('8条常规版本ID与1800字符边界分享链接的完整海报均可解码',async()=>{
  const normal=fixture();for(let i=0;i<8;i++)add(normal,`pub_${i}0000000-0000-4000-8000-000000000000`);
  const ordinary=resolveActivityPoster(normal,buildActivityShare(normal,'activity',2)),ordinaryUrl=activityPublicationUrl('https://radar.example.org',ordinary.manifest);
  assert.ok(ordinaryUrl.length<700);assert.equal((await decoded(activityPosterSvg(ordinary,'模钥重置雷达',ordinaryUrl))).url,ordinaryUrl);
  const dense=fixture();dense.activities[0].id='a'.repeat(180);for(let i=0;i<8;i++)add(dense,`p${i}-${'x'.repeat(177)}`);
  const selected=resolveActivityPoster(dense,buildActivityShare(dense,dense.activities[0].id,2)),url=activityPublicationUrl(`https://${'r'.repeat(38)}.example.org`,selected.manifest);
  assert.equal(url.length,MAX_ACTIVITY_SHARE_URL);assert.equal((await decoded(activityPosterSvg(selected,'模钥重置雷达',url))).url,url);
});


test('首页手动关闭或活动过期后，历史固定版本仍可读取和生成整日海报',()=>{
  const data=fixture(),publication=add(data,'archived-display');
  data.activities[0].showOnHome=false;
  data.serverTime='2026-11-10T00:00:00Z';
  const selected=manifest([publication.id]),result=resolveActivityShare(data,selected);
  assert.equal(result.available,true);
  if(!result.available)assert.fail('关闭首页入口不能撤回历史分享');
  assert.equal(result.publications[0].id,publication.id);
  const svg=activityPosterSvg(resolveActivityPoster(data,selected),data.site.name,activityPublicationUrl('https://example.invalid',selected));
  assert.match(svg,/<svg/);
  assert.ok(svg.includes(publication.article.title));
});
