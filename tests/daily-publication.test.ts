import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool,list,one,put,insert} from '../src/db';
import {createEvidence,publishCandidate,executeCommand,previewCandidate,getPublicData} from '../src/server/service';
import {getPublicVersion,publicRevision} from '../src/server/public-version';
import {posterSvg} from '../src/server/poster';
import type {Evidence,Source,Candidate,DraftContent,Notice,RadarEvent,Article,Publication} from '../src/lib/types';

test('隔离库：自动更正、新闻隔离、人工字段与原帖质量', {skip:process.env.RADAR_INTEGRATION!=='1'},async t=>{
 assert.match(new URL(process.env.DATABASE_URL!).pathname,/^\/radar_qa_/);
 const tag=randomUUID(),sourceId=`daily-publication-${tag}`;
 const source:Source={id:sourceId,name:'隔离回放来源',kind:'archive',url:'https://example.invalid/fixture',enabled:true,validated:true,intervalMinutes:5,version:1,status:'healthy',nextRunAt:'2100-01-01T00:00:00Z'};
 await put('sources',source);let count=0;
 const fixture=async(text:string,extra:Partial<Evidence>={})=>{const messageId=String(2108040921044639779n+BigInt(++count));const time=new Date(Date.now()+count*1000).toISOString();return createEvidence({sourceId,messageId,url:`https://x.com/daily_fixture/status/${messageId}`,text,publishedAt:time,collectedAt:time,contextComplete:true,historical:false,provenance:'archive',...extra});};
 const prepare=async(text:string,options:{stage?:'claimed_complete'|'cancelled';scope?:'public'|'targeted';eligibility?:string;eventId?:string;actionId?:string}={})=>{const item=await fixture(text);const content:DraftContent={title:'公开重置卡进展',summary:'依据准确原文记录对应的重置卡进展。',translation:'',category:'reset',publicationMode:'state_change',contentOrigin:'generated',eventId:options.eventId,evidenceIds:[item.evidence.id],actions:[{id:options.actionId??`action-${tag}-${count}`,kind:'banked_reset',stage:options.stage??'claimed_complete',scope:options.scope??'public',eligibility:options.eligibility??'付费账户',statementAt:item.evidence.publishedAt,evidenceQuote:text,evidenceIds:[item.evidence.id]}]};const candidate={...item.candidate!,content,reasons:[]};await put('candidates',candidate);return {item,candidate,publication:await publishCandidate(candidate.id,candidate.version,'worker','隔离库自动回放',true)};};
 try {
  await t.test('明确取消自动发布并撤回旧错误提醒，其他动作仍保留',async()=>{
   const first=await prepare('We have loaded banked resets for all paid accounts.');
   const next=await prepare('We have cancelled banked resets for all paid accounts.',{stage:'cancelled',eventId:first.publication.eventId,actionId:first.publication.event.actions[0].id});
   assert.equal(next.publication.event.actions[0].stage,'cancelled');
   const notices=(await list<Notice>('notices')).filter(item=>item.eventId===first.publication.eventId);
   assert.equal(notices.filter(item=>item.status==='active').length,1);assert.deepEqual(notices.find(item=>item.status==='active')?.categories,['correction']);assert.ok(notices.some(item=>item.status==='withdrawn'));
  });
  await t.test('普发更正为定向范围不残留错误公开动作或提醒',async()=>{
   const first=await prepare('We have loaded banked resets for all paid accounts.');
   const next=await prepare('Correction: we have loaded banked resets for selected Pro accounts affected by the outage only.',{scope:'targeted',eligibility:'Pro套餐账户（限定范围：selected Pro accounts affected by the outage only.）',eventId:first.publication.eventId,actionId:first.publication.event.actions[0].id});
   assert.equal(next.publication.event.actions.length,1);assert.equal(next.publication.event.actions[0].scope,'targeted');
   const notices=(await list<Notice>('notices')).filter(item=>item.eventId===first.publication.eventId&&item.status==='active');assert.equal(notices.length,1);assert.deepEqual(notices[0].categories,['correction']);
  });
  await t.test('仅新闻及人工编辑不覆盖事实，自动补充保留人工标题',async()=>{
   const first=await prepare('We have loaded banked resets for all paid accounts.');
   const item=await fixture('Codex 新增了清晰的用量提示。');
   const content:DraftContent={title:'Codex 用量提示更新',summary:'公开产品来源记录新增用量提示。',translation:'',category:'product',actions:[],evidenceIds:[item.evidence.id],eventId:first.publication.eventId,publicationMode:'news_only',contentOrigin:'template'};
   await put('candidates',{...item.candidate!,content,reasons:[]});const news=await publishCandidate(item.candidate!.id,1,'worker','新闻独立发布',true);
   assert.equal((await one<RadarEvent>('events',first.publication.eventId))?.publicationId,first.publication.id);assert.equal(news.mode,'news_only');
   const edited=await executeCommand('article.save',{id:news.articleId,version:news.article.version,title:'站长保留的新闻标题',reason:'校对标题'},'qa') as {article:Article};assert.ok(edited.article.manualFields?.includes('title'));
   const saved=(await one<Candidate>('candidates',item.candidate!.id))!;
   await put('candidates',{...saved,version:saved.version+1,content:{...saved.content,title:'模型新的新闻标题',summary:'公开产品来源记录了更清楚的用量提示。',contentOrigin:'generated'}});
   const enriched=await publishCandidate(saved.id,saved.version+1,'worker','自动补充中文',true);
   assert.equal(enriched.articleId,news.articleId);assert.equal(enriched.article.title,'站长保留的新闻标题');assert.equal((await one<RadarEvent>('events',first.publication.eventId))?.publicationId,first.publication.id);
   assert.equal((await list<Notice>('notices')).filter(n=>n.eventId===first.publication.eventId&&n.status==='active').length,1);
  });
  await t.test('已补全原帖不会被后续归档摘要降级',async()=>{
   const original=await fixture('We have loaded a banked reset for all paid accounts.',{textOrigin:'original'});
   const archive=await createEvidence({...original.evidence,text:'付费账户重置卡已加载。',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets'},collectedAt:new Date(Date.now()+60000).toISOString()});
   assert.equal(archive.evidence.text,original.evidence.text);assert.equal(archive.evidence.textOrigin,'original');assert.equal(archive.evidence.metadata?.summary,'付费账户重置卡已加载。');
   const repeat=await createEvidence({...archive.evidence,text:'付费账户重置卡已加载。',textOrigin:'archive_excerpt',collectedAt:new Date(Date.now()+120000).toISOString()});assert.equal(repeat.created,false);
  });
  await t.test('旧false历史标识不生成实时提醒，遗留v1读取与海报修正但原库不变',async()=>{
   const oldTime=new Date(Date.now()-90*86400_000).toISOString(),time=new Date().toISOString();
   const item=await fixture('We have loaded banked resets for all paid accounts.',{publishedAt:oldTime,collectedAt:time});
   const content:DraftContent={title:'历史重置卡记录',summary:'依据保存的旧原文记录重置卡声明。',translation:'',category:'reset',publicationMode:'state_change',contentOrigin:'template',evidenceIds:[item.evidence.id],actions:[{id:`history-action-${tag}`,kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'付费账户',statementAt:oldTime,evidenceQuote:item.evidence.text,evidenceIds:[item.evidence.id]}]};
   await put('candidates',{...item.candidate!,content,reasons:[]});
   const preview=await previewCandidate(item.candidate!.id,1);assert.equal(preview.canPublish,true);assert.equal(preview.willNotify,false);assert.match(preview.noticeReason,/历史资料/);
   const publication=await publishCandidate(item.candidate!.id,1,'worker','历史回放',true);
   assert.equal(publication.article.historical,true);assert.equal((await list<Notice>('notices')).filter(n=>n.eventId===publication.eventId).length,0);
   assert.equal((await one<Evidence>('evidence',item.evidence.id))?.historical,false,'兼容判断不覆盖原证据');
   // A separate immutable legacy fixture reproduces the original v1 bug without modifying any snapshot.
   const legacyId=`pub-legacy-${tag}`,legacyArticle={...publication.article,historical:false,sourcePublishedAt:undefined,publicationId:legacyId};
   const legacy:Publication={...publication,id:legacyId,article:legacyArticle,event:{...publication.event,publicationId:legacyId}};
   assert.equal(await insert('publications',legacy),true);await put('events',legacy.event);await put('articles',legacy.article);
   const before=await one<Publication>('publications',legacyId),publicData=await getPublicData();
   const projected=publicData.publications.find(p=>p.id===legacyId)!;
   assert.equal(projected.article.historical,true);assert.equal(projected.article.sourcePublishedAt,oldTime);
   assert.equal(publicData.articles.find(a=>a.id===legacy.articleId)?.historical,true);
   assert.match(posterSvg(projected,'模钥重置雷达'),/历史收录/);
   assert.deepEqual(await one<Publication>('publications',legacyId),before,'读取不会改写不可变v1');
   assert.equal(await getPublicVersion(),publicRevision(publicData),'轻量版本和完整响应使用同一投影版本');
  });
  await t.test('真实新主帖引用旧父帖会新建文章，不覆盖旧文章或沿用历史标识',async()=>{
   const oldTime=new Date(Date.now()-90*86400_000).toISOString();
   const parent=await fixture('公开来源记录了 Codex 旧产品更新。',{publishedAt:oldTime});
   const oldContent:DraftContent={title:'旧产品更新',summary:'公开来源记录了旧产品更新。',translation:'',category:'product',publicationMode:'news_only',contentOrigin:'template',actions:[],evidenceIds:[parent.evidence.id]};
   await put('candidates',{...parent.candidate!,content:oldContent,reasons:[]});const first=await publishCandidate(parent.candidate!.id,1,'worker','历史产品记录',true),storedFirst=await one<Article>('articles',first.articleId);
   const current=await fixture('公开来源记录了 Codex 新的产品更新。',{parentId:parent.evidence.messageId});
   const content:DraftContent={...oldContent,eventId:first.eventId,title:'新的产品更新',summary:'公开来源记录了新的产品更新。',evidenceIds:[parent.evidence.id,current.evidence.id]};
   await put('candidates',{...current.candidate!,content,reasons:[]});const next=await publishCandidate(current.candidate!.id,1,'worker','最新产品记录',true);
   assert.notEqual(next.articleId,first.articleId);assert.equal(next.article.historical,false);assert.equal(next.article.evidenceIds[0],current.evidence.id,'主原帖在首位，上下文不能主导文章身份');
   assert.deepEqual(await one<Article>('articles',first.articleId),storedFirst,'旧文章不被新主帖覆盖');
   assert.equal((await getPublicData()).publications.find(p=>p.id===next.id)?.article.historical,false);
  });
  await t.test('首次实时发表文章晚重译时预览与实际沿用首次时间，不粘住错误历史标识',async()=>{
   const oldTime=new Date(Date.now()-90*86400_000).toISOString();
   const item=await fixture('公开来源记录了一次 Codex 产品更新。',{publishedAt:oldTime,collectedAt:oldTime});
   const eventId=`first-event-${tag}`,articleId=`first-article-${tag}`,publicationId=`first-pub-${tag}`;
   const content:DraftContent={title:'产品更新',summary:'公开来源记录了一次产品更新。',translation:'',category:'product',publicationMode:'news_only',contentOrigin:'template',eventId,actions:[],evidenceIds:[item.evidence.id]};
   const event:RadarEvent={id:eventId,title:content.title,version:1,status:'published',publicationId,updatedAt:oldTime,evidenceIds:[item.evidence.id],actions:[]};
   const article:Article={id:articleId,eventId,title:content.title,summary:content.summary,translation:'',category:'product',version:1,status:'published',publicationId,evidenceIds:[item.evidence.id],publishedAt:oldTime,updatedAt:oldTime,historical:true,sourcePublishedAt:oldTime,contentOrigin:'template',publicationMode:'news_only'};
   await insert('publications',{id:publicationId,eventId,articleId,event,article,cutoffAt:oldTime,publishedAt:oldTime,reason:'隔离库旧快照'} satisfies Publication);await put('events',event);await put('articles',article);
   const candidate={...item.candidate!,content:{...content,eventId:undefined,summary:'公开来源记录了更清楚的产品更新说明。',contentOrigin:'generated' as const},reasons:[],automation:{...item.candidate!.automation!,articleId,templatePublished:true}};
   await put('candidates',candidate);const preview=await previewCandidate(candidate.id,candidate.version);
   assert.equal(preview.canPublish,true);assert.doesNotMatch(preview.noticeReason,/历史资料/,'预览应按首次发表时间判断');
   const enriched=await publishCandidate(candidate.id,candidate.version,'worker','晚重译',true);
   assert.equal(enriched.articleId,articleId);assert.equal(enriched.article.publishedAt,oldTime);assert.equal(enriched.article.historical,false,'重新依据文章证据判断，不沿用旧错误true标识');
   assert.equal((await one<Publication>('publications',publicationId))?.article.historical,true,'原始旧快照仍保持原样');
  });
 } finally {
  await put('sources',{...source,enabled:false});await pool.end();
 }
});
