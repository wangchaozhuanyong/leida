import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {Article,Candidate,Evidence,Job,Publication,Source} from '../src/lib/types';

test('隔离库：原始产品消息无需AI发布，中文先后到达不退级、不制造重置或通知', {skip:process.env.RADAR_INTEGRATION!=='1'},async t=>{
  const target=new URL(process.env.DATABASE_URL!);
  assert.equal(target.hostname,'127.0.0.1');assert.match(target.pathname,/^\/radar_qa_product_[a-z0-9_]+$/);
  const {pool,list,one,put,transaction}=await import('../src/db');
  const {createEvidence,defaultSite,queueJob}=await import('../src/server/service');
  const {runOne,scheduleDue}=await import('../src/server/worker');
  const {evidenceFingerprint}=await import('../src/server/automatic-content');
  const original:Evidence=JSON.parse(readFileSync(new URL('./fixtures/original-usage-limits-product.json',import.meta.url),'utf8'));
  const savedFetch=globalThis.fetch;let external=0;
  globalThis.fetch=async()=>{external++;throw new Error('隔离产品发布测试禁止外部请求');};
  const noExternal=async()=>{throw new Error('不得调用外部AI、采集或微信');};
  const worker={schedule:false,allowTemplates:true,generate:noExternal,collect:noExternal,enrich:async()=>undefined,enrichQuoted:async()=>[],wechat:noExternal};
  const source:Source={id:'tibo-public',name:'隔离原文',url:'https://example.invalid/source',kind:'archive',enabled:true,validated:true,publicationPaused:false,status:'healthy',intervalMinutes:10,version:1,nextRunAt:'2100-01-01T00:00:00Z'};
  const input=(offset:number):Omit<Evidence,'id'|'hash'>=>{
    const {id:_,hash:__,...raw}=original;const messageId=String(BigInt(raw.messageId)+BigInt(offset));
    return {...raw,messageId,url:'https://x.com/thsottiaux/status/'+messageId};
  };
  const archive=(raw:Omit<Evidence,'id'|'hash'>):Omit<Evidence,'id'|'hash'>=>({...raw,sourceId:'activity-archive',text:'即日起，Pro 100/200/500 各档套餐及 Business Premium 的所有使用限额翻倍。',textOrigin:'archive_excerpt',contextComplete:false,metadata:{title:'Pro 各档套餐及 Business Premium 使用限额翻倍',summary:'即日起，Pro 100/200/500 各档套餐及 Business Premium 的所有使用限额翻倍。',category:'product',sourceGroup:'codex-resets',activityDay:25,activity:{id:'challenge-28',title:'隔离活动',startsOn:'2026-10-05',days:28,timezone:'America/Los_Angeles',rules:'隔离活动规则'}}});
  const drain=async()=>{
    for(let turn=0;turn<20;turn++){
      await scheduleDue({skipSources:true,allowEnrichment:false});let processed=false;
      for(let i=0;i<20;i++){if(!await runOne(worker))break;processed=true;}
      if(!processed&&!(await list<Job>('jobs')).some(job=>job.status==='queued'||job.status==='running'))return;
      await new Promise<void>(resolve=>setTimeout(resolve,25));
    }
    assert.fail('隔离发布队列未收敛');
  };
  try{
    assert.equal((await list('evidence')).length,0,'必须使用全新QA库');
    await put('settings',{id:'site',...defaultSite});await put('sources',source);
    await put('sources',{...source,id:'activity-archive',kind:'activity'});
    await put('activities',{...archive(input(0)).metadata!.activity!,version:1,showOnHome:true,items:[]});
    await t.test('原文先到：旧规则等待项能自动发布，重复调度不新增快照',async()=>{
      const result=await createEvidence(input(0));assert.ok(result.candidate);
      const fingerprint=evidenceFingerprint([result.evidence]);
      await put('candidates',{...result.candidate,automation:{state:'waiting_evidence',reasonCodes:[],dependencyIds:[],inputFingerprint:fingerprint.replace('-original-product-1','')}});
      await drain();const current=(await one<Candidate>('candidates',result.candidate.id))!;
      assert.equal(current.status,'published');const publications=await list<Publication>('publications');assert.equal(publications.length,1);
      assert.equal(publications[0].article.translation,original.text);assert.equal(publications[0].mode,'news_only');assert.deepEqual(publications[0].event.actions,[]);
      assert.equal((await list('notices')).length,0,'限额调整不是重置提醒');
      await drain();assert.equal((await list('publications')).length,1);
      const archived=await createEvidence(archive(input(0)));assert.ok(archived.candidate);await drain();
      const archivedResult=(await one<Candidate>('candidates',archived.candidate.id))!;
      assert.equal(archivedResult.status,'published',JSON.stringify({candidate:archivedResult,jobs:(await list<Job>('jobs')).filter(job=>job.candidateId===archivedResult.id)}));
      const article=(await list<Article>('articles'))[0],frozen=await list<Publication>('publications');
      assert.match(article.title,/活动归档/);
      const originalCandidate=(await one<Candidate>('candidates',current.id))!;
      await transaction(c=>queueJob('generate',{candidateId:current.id,automatic:true,enrichArticle:true,expectedVersion:originalCandidate.version},c));
      await drain();assert.deepEqual(await list('publications'),frozen,'英文兜底不得覆盖现有中文文章或重发');
      assert.equal((await one<Article>('articles',article.id))!.publicationId,article.publicationId);
    });
    await t.test('中文先到：后到原文复用同一发布，保留现有中文及人工保护',async()=>{
      const raw=input(1000);const before=(await list('publications')).length;
      const archived=await createEvidence(archive(raw));assert.ok(archived.candidate);await drain();
      const archivedResult=(await one<Candidate>('candidates',archived.candidate.id))!;
      assert.equal(archivedResult.status,'published',JSON.stringify({candidate:archivedResult,jobs:(await list<Job>('jobs')).filter(job=>job.candidateId===archivedResult.id)}));
      const known=await list<Publication>('publications');assert.equal(known.length,before+1);
      const archivedCandidate=(await one<Candidate>('candidates',archived.candidate.id))!;
      const targetArticle=(await one<Article>('articles',archivedCandidate.automation!.articleId!))!;
      await put('articles',{...targetArticle,manualFields:['summary']});
      const added=await createEvidence(raw);assert.ok(added.candidate);
      const job=await transaction(c=>queueJob('generate',{candidateId:added.candidate!.id,automatic:true,expectedVersion:added.candidate!.version},c));
      for(let i=0;i<20;i++){await runOne(worker);if((await one<Job>('jobs',job.id))!.status==='succeeded')break;}
      assert.equal((await list('publications')).length,known.length);
      assert.equal((await one<Candidate>('candidates',added.candidate.id))!.status,'published');
      assert.equal((await one<Article>('articles',targetArticle.id))!.summary,targetArticle.summary);
      assert.deepEqual((await one<Article>('articles',targetArticle.id))!.manualFields,['summary']);
      await drain();assert.equal((await one<Article>('articles',targetArticle.id))!.summary,targetArticle.summary);
      assert.equal((await list('articles')).length,2,'补充出处可以新增版本，不能新建重复文章');
    });
    await t.test('人工候选和暂停来源继续保留，不被新兜底规则自动公开',async()=>{
      const human=await createEvidence(input(2000));assert.ok(human.candidate);await put('candidates',{...human.candidate,humanEdited:true});
      await put('sources',{...source,publicationPaused:true});const paused=await createEvidence(input(3000));assert.ok(paused.candidate);
      const before=(await list('publications')).length;await drain();assert.equal((await list('publications')).length,before);
      assert.equal((await one<Candidate>('candidates',human.candidate.id))!.status,'pending');assert.equal((await one<Candidate>('candidates',paused.candidate.id))!.status,'pending');
    });
    for(const notice of await list<any>('notices'))assert.ok(notice.categories.every((category:string)=>!['announcement','result'].includes(category)));
    assert.equal((await list('wechat_deliveries')).length,0);assert.equal(external,0);
    for(const event of await list<any>('events'))assert.deepEqual(event.actions,[],'产品消息不产生重置动作');
  }finally{globalThis.fetch=savedFetch;await pool.end();}
});
