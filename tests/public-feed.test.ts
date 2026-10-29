import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {publicNewsGroups, homeNewsGroups} from '../src/lib/public-feed';
import {paginatePublicNews} from '../src/server/public-read';
import {publicArticleSummary, publicReviewMessage, publicSourceNotes} from '../src/lib/public-content';
import {createCloudbasePublicReader} from '../src/server/cloudbase/public-read';
import {CloudbaseRpc} from '../src/server/cloudbase/rpc';
import type {PublicData, Publication, ActionStage, ActionKind} from '../src/lib/types';

const now='2026-10-18T12:00:00Z';
const native=createRequire(import.meta.url)('../miniprogram/utils/model.js');
function fixture():PublicData {return {events:[],articles:[],publications:[],evidence:[],activities:[],notices:[],sources:[],serverTime:now,site:{name:'测试',description:'',autoPublish:false,version:1}};}
function add(data:PublicData,id:string,eventId=id,stage:ActionStage='promised',kind:ActionKind='automatic_reset',hour=1) {
  const at=`2026-10-18T${String(hour).padStart(2,'0')}:00:00Z`;
  const article={id:'a-'+id,eventId,title:`公告 ${id}`,summary:`公开消息 ${id}`,translation:'',category:'reset' as const,version:1,status:'published' as const,publicationId:'p-'+id,evidenceIds:['proof-'+id],publishedAt:at,sourcePublishedAt:at,updatedAt:at};
  const event={id:eventId,title:article.title,version:1,status:'published' as const,publicationId:article.publicationId,evidenceIds:article.evidenceIds,updatedAt:at,actions:[{id:'action-'+eventId,kind,stage,eligibility:'具体套餐暂未明确',scope:'public' as const,statementAt:at,evidenceIds:article.evidenceIds}]};
  const p:Publication={id:article.publicationId,eventId,articleId:article.id,article,event,cutoffAt:at,publishedAt:at,reason:'内部处理说明'};
  data.events=data.events.filter(e=>e.id!==eventId).concat(event);data.articles.push(article);data.publications.push(p);
  data.evidence.push({id:article.evidenceIds[0],sourceId:'official',messageId:id,url:'https://x.com/thsottiaux/status/'+id,text:'Original '+id,publishedAt:at,collectedAt:at,hash:id,contextComplete:true,historical:false,provenance:'official'});
  return p;
}

test('同轮预告、完成只占一项，过程和撤回更正保留；两类、不同轮次不按时间合并',()=>{
  const data=fixture();add(data,'promise','round');const completed=add(data,'complete','round','claimed_complete','automatic_reset',3);
  add(data,'card','card-round','claimed_complete','banked_reset',3);add(data,'next','next-round','promised','automatic_reset',3);
  const before=JSON.stringify(data),groups=publicNewsGroups(data);
  assert.equal(groups.length,3);const round=groups.find(g=>g.id==='event:round')!;
  assert.equal(round.latest.id,completed.id);assert.equal(round.updates.length,2);
  assert.deepEqual(native.publicNewsGroups(data),groups);assert.equal(JSON.stringify(data),before);
  completed.article.status='withdrawn';data.events.find(e=>e.id==='round')!.status='withdrawn';
  assert.equal(publicNewsGroups(data).find(g=>g.id==='event:round')!.withdrawn,true);
  completed.article.status='published';assert.equal(publicNewsGroups(data).find(g=>g.id==='event:round')!.withdrawn,true,'当前撤回状态优先于冻结发布快照');
});

test('显式合并事件可收拢，未关联待确认和循环关联不合并',()=>{
  const data=fixture();add(data,'uncertain');add(data,'early');add(data,'latest');
  const early=data.events.find(e=>e.id==='early')!;early.status='merged';early.mergedInto='latest';
  assert.equal(publicNewsGroups(data).length,2);
  data.events.find(e=>e.id==='latest')!.status='merged';data.events.find(e=>e.id==='latest')!.mergedInto='early';
  assert.equal(publicNewsGroups(data).length,3);
});

test('故障仅按同一官方事件链接合并，产品资讯不进入首页重置动态',()=>{
  const data=fixture();add(data,'reset');
  for(const [id,incident,hour] of [['investigating','one',2],['resolved','one',3],['different','two',3]] as const){
    const p=add(data,id,id,'promised','automatic_reset',hour);p.mode='news_only';p.article.category='product';p.event.actions=[];
    data.evidence.find(e=>e.id===p.article.evidenceIds[0])!.url='https://status.openai.com/incidents/'+incident;
  }
  const release=add(data,'release');release.article.category='product';release.mode='news_only';release.event.actions=[];
  const groups=publicNewsGroups(data);assert.equal(groups.length,4);
  const one=groups.find(g=>g.id==='incident:one')!;assert.equal(one.latest.articleId,'a-resolved');assert.equal(one.updates.length,2);
  assert.deepEqual(homeNewsGroups(data).map(g=>g.latest.articleId),['a-reset']);
  assert.equal(paginatePublicNews(data,{view:'news',filter:'product'}).page.total,3);
  assert.equal(paginatePublicNews(data,{view:'news',filter:'reset'}).page.total,1);
});

test('先合并再分页，跨页不重复且总数按事件计，当前页仍有此前进展',()=>{
  const data=fixture();for(let i=0;i<25;i++){add(data,`${i}-start`,'round-'+i);add(data,`${i}-done`,'round-'+i,'claimed_complete','automatic_reset',2);}
  const options={view:'news' as const,filter:'all'},first=paginatePublicNews(data,options);
  assert.equal(first.page.total,25);assert.equal(first.page.ids.length,20);assert.equal(first.selected.size,40);
  const second=paginatePublicNews(data,{...options,cursor:first.page.nextCursor!});
  assert.equal(second.page.ids.length,5);assert.equal(second.page.nextCursor,null);assert.equal(new Set([...first.page.ids,...second.page.ids]).size,25);
  assert.throws(()=>paginatePublicNews(data,{...options,filter:'product',cursor:first.page.nextCursor!}));
});

test('正文隐藏内部分类与时间换算说明，保留来源限定、日期、适用范围及原始说明',()=>{
  const data=fixture(),p=add(data,'content');p.article.contentOrigin='template';
  const note='原文承诺日终前完成，预计最晚时间已换算为北京时间（UTC+8）；按原文PST字面UTC-8换算，未自行改用当地夏令时；这是公告预计时间，仍待实际确认。';
  p.article.summary='AIPlanWatch 将对应原帖记录为公共额度重置；原帖仅为简短完成表达，福利类型采用参考项目分类，未虚构回复关系。根据公开原文，用量重置公告称已完成，适用对象：Pro。预计时间：2026/10/18 16:00（北京时间）。'+note;
  p.event.actions[0].timeNote=note;p.article.reviewStatus='pending';p.article.reviewReasons=['规则核验需要补抓父消息'];
  const before=JSON.stringify(p),summary=publicArticleSummary(p.article);
  assert.match(summary,/AIPlanWatch|Pro|2026\/10\/18 16:00/);assert.doesNotMatch(summary,/未虚构|字面|夏令时/);
  assert.match(publicReviewMessage(p.article),/尚不能确认/);assert.doesNotMatch(publicReviewMessage(p.article),/补抓/);
  const notes=publicSourceNotes(p.article,p.event.actions);assert.ok(notes.includes('预计为最晚时间，以实际发放为准。'));assert.doesNotMatch(notes.join(' '),/字面|夏令时|补抓|未虚构/);assert.ok(notes.includes(publicReviewMessage(p.article)));assert.equal(native.publicArticleSummary(p.article),summary);assert.equal(JSON.stringify(p),before);
  p.article.manualFields=['summary'];assert.equal(publicArticleSummary(p.article),p.article.summary);
});

test('CloudBase复用既有只读轻量接口，分组分页结果与本地读取一致，保留原文入口',async()=>{
  const data=fixture();add(data,'promise','one');add(data,'done','one','claimed_complete','automatic_reset',3);
  const calls:string[]=[];
  const bundle={...data,page:null,versionData:{digests:Array(5).fill('0'.repeat(32)),sources:[],settings:[],deadlines:[],cases:[],snapshots:[],outcomeDigest:'0'.repeat(32)},forecastRecords:{cases:[],snapshots:[],outcomes:[]}};
  const rpc=new CloudbaseRpc('local-feed-qa','synthetic-only',async(input,init)=>{
    calls.push(String(input).split('/').at(-1)!);assert.deepEqual(JSON.parse(String(init?.body)).p_options,{view:'calendar'});return Response.json(bundle);
  });
  const result=await createCloudbasePublicReader(rpc,()=>now).read({view:'news',filter:'all'});
  assert.deepEqual(calls,['radar_cb_public_bundle']);assert.equal(result.page?.total,1);assert.equal(result.data.publications.length,2);
  assert.equal(publicNewsGroups(result.data)[0].latest.id,'p-done');assert.equal(result.data.evidence.length,2);
});

test('系统站内信使用对应历史公告的客户摘要，人工站内信及缺失关联保持原文',async()=>{
  const {publicNoticeSummary}=await import('../src/lib/public-content');
  const data=fixture(),p=add(data,'notice');p.article.contentOrigin='template';
  const notice={id:'n',eventId:p.eventId,publicationId:p.id,semanticKey:'n',title:'预告',summary:'根据公开原文，额度将重置。',categories:['announcement' as const],status:'active' as const,createdAt:now};
  assert.equal(publicNoticeSummary(notice,data.publications),'额度将重置。');
  assert.equal(native.publicNoticeSummary(notice,data.publications),'额度将重置。');
  assert.equal(publicNoticeSummary({...notice,origin:'admin'},data.publications),notice.summary);
  assert.equal(publicNoticeSummary(notice,[]),notice.summary);
  data.notices=[notice];assert.deepEqual(native.noticeModel(data,{},[]),[]);
  data.notices=[{...notice,origin:'admin'}];assert.equal(native.noticeModel(data,{},[])[0].summary,notice.summary);
});

test('活动摘要去掉归档处理说明，保留时间限定、适用范围和不确定性，两端一致且原文不变',()=>{
  const d=fixture(),p=add(d,'copy-only');p.article.contentOrigin='template';
  const cases=[
    {text:'辅助归档将此条列为第 20 天重置相关消息。归档摘录：“在午夜 PST 之前”。仅记录消息，不据此认定已完成；具体福利、时间和完成情况仍需核对。',expected:'在午夜 PST 之前 具体发放安排待确认。'},
    {text:'辅助归档将此条列为第 1 天产品动态。归档摘录：“Pro 用户速度提升约50%，两小时内逐步生效”。这是来源消息，完整细节以原帖为准。',expected:'Pro 用户速度提升约50%，两小时内逐步生效'},
    {text:'Codex Limits 记录用量重置观测，观测时间：2026/10/26 14:08（北京时间）。这不是原作者的新完成公告，个人账户是否到账请查看实际额度。',expected:'Codex Limits 已观测到额度重置，时间：2026/10/26 14:08（北京时间）。实际额度以账户显示为准。'}
  ];
  for(const row of cases){
    p.article.summary=row.text;const before=JSON.stringify(p);
    assert.equal(publicArticleSummary(p.article),row.expected);assert.equal(native.publicArticleSummary(p.article),row.expected);assert.equal(JSON.stringify(p),before);
    p.article.manualFields=['summary'];assert.equal(publicArticleSummary(p.article),row.text);assert.equal(native.publicArticleSummary(p.article),row.text);p.article.manualFields=[];
  }
});

test('精简时间备注仍区分最晚与近似时间，原始时间说明不被改写',()=>{
 const d=fixture(),p=add(d,'time-note-copy');p.article.contentOrigin='template';
 const rows=[
  {note:'原文承诺日终前完成，预计最晚时间已换算为北京时间（UTC+8）；按原文PST字面UTC-8换算，未自行改用当地夏令时；这是公告预计时间，仍待实际确认。',match:/最晚时间/},
  {note:'原文近似时间：约略预计时刻，并非最晚截止，未给出误差范围；按原文PDT字面UTC-7换算，未自行改用当地夏令时；这是公告预计时间，仍待实际确认。',match:/大致时间/}
 ];
 for(const row of rows){
  p.event.actions[0].timeNote=row.note;p.article.summary='保留的公告内容';
  const before=JSON.stringify(p),notes=publicSourceNotes(p.article,p.event.actions);
  assert.match(notes.join(' '),row.match);assert.doesNotMatch(notes.join(' '),/字面|误差范围|夏令时/);
  const data={...d,publications:[p]};const view=native.resolveDetail(data,{publicationId:p.id});
  assert.deepEqual(view.sourceNotes,notes);assert.equal(JSON.stringify(p),before);
 }
});
