import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, list, one, put, transaction } from '../src/db';
import type { AIRecord } from '../src/server/ai';
import { AIServiceError, completionFailure } from '../src/server/ai';
import { nextBudgetDay, runOne, scheduleDue, type WorkerDependencies } from '../src/server/worker';
import { SourceStructureError } from '../src/server/ingestion';
import { createEvidence, executeCommand, queueJob } from '../src/server/service';
import type { Candidate, DraftContent, Evidence, Job, Notice, RadarEvent, Source } from '../src/lib/types';

test('智能接口错误按可恢复原因分类，限流退避有上限',()=>{
  assert.equal(completionFailure(429,'90').failureKind,'transient');
  assert.equal(completionFailure(429,'99999').retryAfterMs,300_000);
  assert.equal(completionFailure(503).failureKind,'transient');
  assert.equal(completionFailure(401).failureKind,'configuration');
  assert.equal(completionFailure(400).failureKind,'configuration');
  assert.equal(nextBudgetDay(Date.parse('2026-10-09T15:59:59Z')),'2026-10-09T16:00:00.000Z');
});

test('真实隔离库：自动积压接续、证据关联、有限恢复与人工保护', {skip:process.env.RADAR_INTEGRATION!=='1'}, async t=>{
  const dbName=new URL(process.env.DATABASE_URL!).pathname.slice(1);
  assert.match(dbName,/^radar_qa_/,'自动化测试必须使用独立 QA 数据库');
  const schedule=()=>scheduleDue({allowTemplates:false,allowEnrichment:false});
  const tag=randomUUID(),sourceId=`automation-${tag}`;
  const source:Source={id:sourceId,name:'自动化隔离样例来源',kind:'archive',url:'https://example.invalid/fixture',enabled:true,validated:true,intervalMinutes:5,version:1,status:'healthy',nextRunAt:'2100-01-01T00:00:00.000Z'};
  const priorAI=await one<AIRecord>('settings','ai');
  const ai:AIRecord={id:'ai',enabled:true,baseUrl:'https://example.invalid/v1',model:'injected-fixture-only',encryptedKey:'fixture-never-sent',hasKey:true,dailyCallLimit:100,dailyBudget:100,inputPrice:1,outputPrice:1,currency:'元',testedAt:new Date().toISOString(),version:501};
  let serial=0;
  const ownedCandidates=new Set<string>();
  const fixture=async(options:Partial<Parameters<typeof createEvidence>[0]>={})=>{
    const sequence=(1900000000000000000n+BigInt(++serial)).toString();
    const time=new Date(Date.now()+serial*1000).toISOString();
    const record=await createEvidence({sourceId,messageId:sequence,url:`https://x.com/automation_fixture/status/${sequence}`,text:'We have reset all usage limits for all accounts.',publishedAt:time,collectedAt:time,contextComplete:true,historical:false,provenance:'archive',...options});
    if(record.candidate)ownedCandidates.add(record.candidate.id);
    return record;
  };
  const generated:Evidence[][]=[];
  const generate=async(evidence:Evidence[]):Promise<DraftContent>=>{
    generated.push(evidence);
    const primary=evidence[0];
    const banked=evidence.some(item=>/banked/i.test(item.text));
    const promise=/will/i.test(primary.text);
    return {title:promise?'公开预告重置安排':'公告称重置已完成',summary:promise?'公开来源已预告重置安排。':'公开来源确认了对应重置动作。',translation:'依据已保存原文生成中文内容。',category:'reset',evidenceIds:evidence.map(item=>item.id),actions:[{id:'model-action',kind:banked?'banked_reset':'automatic_reset',stage:promise?'promised':'claimed_complete',eligibility:'所有账户',scope:'public',statementAt:primary.publishedAt,evidenceIds:evidence.map(item=>item.id),evidenceQuote:primary.text}]};
  };
  const enqueue=async(candidate:Candidate)=>transaction(c=>queueJob('generate',{candidateId:candidate.id,automatic:true,expectedVersion:candidate.version,aiVersion:ai.version},c));
  const step=async(generator:typeof generate=generate)=>{
    for(let attempt=0;attempt<20;attempt++){if(await runOne({schedule:false,generate:generator}))return true;await new Promise(resolve=>setTimeout(resolve,25));}
    return false;
  };
  const processJob=async(jobId:string,generator:typeof generate=generate,options:Partial<WorkerDependencies>={})=>{
    const before=(await one<Job>('jobs',jobId))!;
    for(let attempt=0;attempt<100;attempt++){
      await runOne({schedule:false,generate:generator,...options});
      const current=(await one<Job>('jobs',jobId))!;
      if(current.attempts>before.attempts&&current.status!=='running')return current;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.fail(`目标任务未被处理：${jobId}`);
  };
  const generateCandidate=async(candidate:Candidate)=>processJob((await enqueue(candidate)).id);
  const run=()=>step();
  const completeQueued=async()=>{for(let count=0;count<30;count++){if(!await run())break;}};
  const stopUnused=async()=>{
    for(const candidate of await list<Candidate>('candidates'))if(ownedCandidates.has(candidate.id)&&candidate.status==='pending')await put('candidates',{...candidate,status:'ignored'});
  };
  t.afterEach(async()=>{
    await stopUnused();
    for(const job of await list<Job>('jobs'))if(ownedCandidates.has(job.candidateId??'')&&['queued','running'].includes(job.status)){
      await put('jobs',{...job,status:'failed',leaseUntil:undefined,error:'隔离测试案例结束，取消遗留样例任务',finishedAt:new Date().toISOString()});
    }
  });
  try {
    await put('sources',source);
    await put('settings',{...ai,enabled:false});
    await t.test('关闭接口不调用；启用后自动补排，最新优先且历史分批',async()=>{
      const older=await fixture({publishedAt:new Date(Date.now()-2*3600_000).toISOString()});
      const newest=await fixture({publishedAt:new Date(Date.now()-3600_000).toISOString()});
      for(let index=0;index<4;index++)await fixture({historical:true,publishedAt:`2026-09-0${index+1}T01:00:00Z`});
      await schedule();
      assert.equal((await list<Job>('jobs')).filter(job=>ownedCandidates.has(job.candidateId??'')).length,0);
      await put('settings',ai);
      await Promise.all([schedule(),schedule(),schedule()]);
      const jobs=(await list<Job>('jobs')).filter(job=>ownedCandidates.has(job.candidateId??''));
      assert.equal(jobs.length,4);
      assert.equal(jobs.filter(job=>job.payload.historical===true).length,2);
      await processJob(jobs.find(job=>job.candidateId===newest.candidate!.id)!.id);
      assert.equal(generated.at(-1)?.[0].id,newest.evidence.id,'最新公告先处理');
      assert.equal((await one<Candidate>('candidates',newest.candidate!.id))?.status,'published');
      await completeQueued();
      assert.equal((await one<Candidate>('candidates',older.candidate!.id))?.status,'published');
      const publicationsBefore=(await list('publications')).length;
      await schedule();await completeQueued();
      assert.equal((await list('publications')).length,publicationsBefore+2,'只继续剩余历史积压');
      await schedule();
      assert.equal((await list<Job>('jobs')).filter(job=>ownedCandidates.has(job.candidateId??'')).length,6,'重跑不会再次生成');
    });
    await t.test('原文上下文补全复用未生成候选并保留历史证据',async()=>{
      const raw=await fixture({contextComplete:false});
      const upgraded=await createEvidence({...raw.evidence,contextComplete:true,collectedAt:new Date(Date.now()+60_000).toISOString()});
      assert.equal(upgraded.candidate?.id,raw.candidate!.id);
      assert.equal(upgraded.candidate?.version,raw.candidate!.version+1);
      assert.ok(!upgraded.candidate?.reasons.some(reason=>reason.includes('原帖出现新版本')));
      assert.ok(await one<Evidence>('evidence',raw.evidence.id),'原证据保持不可变且可追溯');
      await schedule();await processJob((await list<Job>('jobs')).find(job=>job.candidateId===raw.candidate!.id)!.id);
      assert.equal((await one<Candidate>('candidates',raw.candidate!.id))?.status,'published');
    });
    await t.test('并发排队只创建一个任务；人工编辑和暂停来源不进入自动积压',async()=>{
      const created=await fixture();
      const results=await Promise.all(Array.from({length:8},()=>enqueue(created.candidate!)));
      assert.equal(new Set(results.map(job=>job.id)).size,1);
      await processJob(results[0].id);
      const edited=await fixture();await put('candidates',{...edited.candidate!,humanEdited:true,status:'draft'});
      const manual=await fixture({provenance:'manual'});
      const pausedId=`paused-${tag}`;await put('sources',{...source,id:pausedId,enabled:false});
      const paused=await fixture({sourceId:pausedId});
      await schedule();
      assert.ok(!(await list<Job>('jobs')).some(job=>[edited.candidate!.id,manual.candidate!.id,paused.candidate!.id].includes(job.candidateId??'')));
      await stopUnused();
    });
    await t.test('同原帖跨来源复用事件、动作和提醒',async()=>{
      const first=await fixture();await generateCandidate(first.candidate!);
      const firstCandidate=(await one<Candidate>('candidates',first.candidate!.id))!;
      const noticeCount=(await list<Notice>('notices')).filter(notice=>notice.eventId===firstCandidate.content.eventId).length;
      const crossId=`cross-${tag}`;await put('sources',{...source,id:crossId});
      const repeated=await fixture({sourceId:crossId,messageId:first.evidence.messageId,url:first.evidence.url,text:first.evidence.text,publishedAt:first.evidence.publishedAt});
      await generateCandidate(repeated.candidate!);
      assert.equal((await one<Candidate>('candidates',repeated.candidate!.id))?.content.eventId,firstCandidate.content.eventId);
      assert.equal((await one<RadarEvent>('events',firstCandidate.content.eventId!))?.actions.length,1);
      assert.equal((await list<Notice>('notices')).filter(notice=>notice.eventId===firstCandidate.content.eventId).length,noticeCount);
    });
    await t.test('明确资格范围更正复用原动作编号，不保留错误的普发状态',async()=>{
      const initial=await fixture();await generateCandidate(initial.candidate!);
      const original=(await one<Candidate>('candidates',initial.candidate!.id))!;
      const eventBefore=(await one<RadarEvent>('events',original.content.eventId!))!;
      const corrected=await fixture({parentId:initial.evidence.messageId,text:'Correction: we have reset usage limits only for the affected accounts.'});
      const generator=async(evidence:Evidence[]):Promise<DraftContent>=>({title:'用量重置资格范围更正',summary:'来源更正说明本次用量重置仅适用于受影响账户。',translation:'更正：本次仅重置受影响账户的使用限额。',category:'reset',evidenceIds:evidence.map(item=>item.id),actions:[{id:'corrected-model-action',kind:'automatic_reset',stage:'claimed_complete',eligibility:'受影响账户',scope:'targeted',statementAt:evidence[0].publishedAt,evidenceIds:evidence.map(item=>item.id),evidenceQuote:evidence[0].text}]});
      await processJob((await enqueue(corrected.candidate!)).id,generator);
      const after=(await one<Candidate>('candidates',corrected.candidate!.id))!;
      assert.equal(after.status,'published');assert.equal(after.content.eventId,eventBefore.id);
      const eventAfter=(await one<RadarEvent>('events',eventBefore.id))!;
      assert.equal(eventAfter.actions.length,1);assert.equal(eventAfter.actions[0].id,eventBefore.actions[0].id);
      assert.equal(eventAfter.actions[0].scope,'targeted');
      assert.equal(eventAfter.actions.filter(action=>action.scope==='public').length,0);
    });
    await t.test('完成回复先到时按真实父链关联；晚处理预告不回退或重复提醒',async()=>{
      const parent=await fixture({text:'We will load a banked reset for all accounts.'});
      const child=await fixture({parentId:parent.evidence.messageId,text:'Confirmed landed across all accounts.',contextComplete:false});
      await generateCandidate(child.candidate!);
      const publishedChild=(await one<Candidate>('candidates',child.candidate!.id))!;
      assert.equal(publishedChild.status,'published');
      const noticesBefore=(await list<Notice>('notices')).filter(notice=>notice.eventId===publishedChild.content.eventId).length;
      await generateCandidate(parent.candidate!);
      const publishedParent=(await one<Candidate>('candidates',parent.candidate!.id))!;
      assert.equal(publishedParent.content.eventId,publishedChild.content.eventId);
      const event=(await one<RadarEvent>('events',publishedParent.content.eventId!))!;
      assert.equal(event.actions.length,1);assert.equal(event.actions[0].stage,'claimed_complete');
      assert.equal((await list<Notice>('notices')).filter(notice=>notice.eventId===event.id).length,noticesBefore);
      const missing=await fixture({parentId:'unknown-parent',contextComplete:false});await generateCandidate(missing.candidate!);
      assert.equal((await one<Candidate>('candidates',missing.candidate!.id))?.status,'pending');
      assert.ok((await list<Job>('jobs')).find(job=>job.candidateId===missing.candidate!.id)?.payload.generated);
      await schedule();assert.equal((await list<Job>('jobs')).filter(job=>job.candidateId===missing.candidate!.id).length,1);
      await stopUnused();
    });
    await t.test('网络与限流三次后冷却恢复；配置错误等待变更',async()=>{
      const created=await fixture();const task=await enqueue(created.candidate!);
      for(let attempt=1;attempt<=3;attempt++) {
        await processJob(task.id,async()=>{throw new AIServiceError('临时限流','transient',60_000);});
        const state=(await one<Job>('jobs',task.id))!;
        assert.equal(state.attempts,attempt);assert.equal(state.status,attempt<3?'queued':'failed');
        if(attempt<3){assert.ok(Date.parse(state.availableAt)>Date.now());await put('jobs',{...state,availableAt:new Date(Date.now()-1000).toISOString()});}
      }
      await schedule();assert.equal((await one<Job>('jobs',task.id))?.status,'failed');
      const cooled=(await one<Job>('jobs',task.id))!;
      assert.equal(cooled.payload.blockedReason,'cooldown');
      assert.equal(cooled.payload.cooldownCycle,1);
      assert.ok(Date.parse(String(cooled.payload.resumeAfter))>Date.now());
      await put('jobs',{...cooled,payload:{...cooled.payload,resumeAfter:new Date(Date.now()-1000).toISOString()}});
      await schedule();assert.equal((await one<Job>('jobs',task.id))?.status,'queued');
      await processJob(task.id);assert.equal((await one<Candidate>('candidates',created.candidate!.id))?.status,'published','服务恢复无需人工点重试');
      const bad=await fixture();const badTask=await enqueue(bad.candidate!);
      await processJob(badTask.id,async()=>{throw new AIServiceError('接口未通过认证','configuration');});
      await schedule();assert.equal((await one<Job>('jobs',badTask.id))?.status,'failed');
      await put('settings',{...ai,version:ai.version+1});await schedule();
      assert.equal((await one<Job>('jobs',badTask.id))?.status,'queued','配置变化后恢复一次');
      await processJob(badTask.id);assert.equal((await one<Candidate>('candidates',bad.candidate!.id))?.status,'published');
      await put('settings',ai);await stopUnused();
    });
    await t.test('预算耗尽不会循环调用，到次日后同一任务恢复',async()=>{
      const created=await fixture();const task=await enqueue(created.candidate!);
      await processJob(task.id,async()=>{throw new AIServiceError('今日额度已耗尽','budget');});
      const blocked=(await one<Job>('jobs',task.id))!;
      assert.equal(blocked.status,'failed');assert.equal(blocked.payload.blockedReason,'budget');
      await schedule();assert.equal((await one<Job>('jobs',task.id))?.status,'failed');
      await put('jobs',{...blocked,payload:{...blocked.payload,resumeAfter:new Date(Date.now()-1000).toISOString()}});
      await schedule();assert.equal((await one<Job>('jobs',task.id))?.status,'queued');
      await processJob(task.id);assert.equal((await one<Candidate>('candidates',created.candidate!.id))?.status,'published');
      assert.equal((await list<Job>('jobs')).filter(job=>job.candidateId===created.candidate!.id).length,1);
    });
    await t.test('容量暂缓不算人工冲突，证据变化后失败也不会在同输入循环调用',async()=>{
      const parentKey=`190000000000009${serial+1}`;
      const child=await fixture({parentId:parentKey,contextComplete:false});
      await generateCandidate(child.candidate!);
      const waiting=(await one<Candidate>('candidates',child.candidate!.id))!;
      assert.equal(waiting.status,'pending');assert.ok(waiting.automation?.inputFingerprint);
      const parent=await fixture({messageId:parentKey,url:`https://x.com/automation_fixture/status/${parentKey}`});
      await put('candidates',{...parent.candidate!,status:'ignored'});
      await schedule();const task=(await list<Job>('jobs')).find(job=>job.candidateId===child.candidate!.id&&job.status==='queued')!;
      assert.ok(task);assert.notEqual(task.payload.inputFingerprint,waiting.automation!.inputFingerprint);
      await processJob(task.id,async()=>{throw new AIServiceError('完整证据超过接口容量，暂缓等待输入或配置变化','capacity');});
      const blocked=(await one<Job>('jobs',task.id))!,candidate=(await one<Candidate>('candidates',child.candidate!.id))!;
      assert.equal(blocked.status,'failed');assert.equal(blocked.attempts,1);assert.equal(blocked.payload.blockedReason,'capacity');assert.equal(blocked.payload.cooldownCycle,undefined);
      assert.equal(candidate.automation?.state,'deferred');assert.deepEqual(candidate.automation?.reasonCodes,['input_capacity']);assert.equal(candidate.automation?.inputFingerprint,task.payload.inputFingerprint);
      const jobCount=(await list<Job>('jobs')).filter(job=>job.candidateId===child.candidate!.id).length;
      await schedule();await schedule();
      assert.equal((await one<Job>('jobs',task.id))?.status,'failed');assert.equal((await list<Job>('jobs')).filter(job=>job.candidateId===child.candidate!.id).length,jobCount);
      await put('settings',{...ai,version:ai.version+1});await schedule();
      assert.equal((await one<Job>('jobs',task.id))?.status,'queued','配置变化后才恢复');
      await processJob(task.id);assert.equal((await one<Candidate>('candidates',child.candidate!.id))?.status,'published');
      await put('settings',ai);
    });
    await t.test('模型返回结构错误有限重试并冷却恢复，业务缺证不会重复收费',async()=>{
      const created=await fixture();const task=await enqueue(created.candidate!);
      for(let attempt=1;attempt<=3;attempt++) {
        await processJob(task.id,async()=>{throw new AIServiceError('生成内容未通过结构校验','validation');});
        const current=(await one<Job>('jobs',task.id))!;
        assert.equal(current.status,attempt<3?'queued':'failed');
        if(attempt<3)await put('jobs',{...current,availableAt:new Date(Date.now()-1000).toISOString()});
      }
      const cooled=(await one<Job>('jobs',task.id))!;
      assert.equal(cooled.payload.blockedReason,'cooldown');
      await schedule();assert.equal((await one<Job>('jobs',task.id))?.status,'failed');
      await put('jobs',{...cooled,payload:{...cooled.payload,resumeAfter:new Date(Date.now()-1000).toISOString()}});
      await schedule();await processJob(task.id);
      assert.equal((await one<Candidate>('candidates',created.candidate!.id))?.status,'published');
    });
    await t.test('无事实回复自动排除，完成短句仍等待对应证据',async()=>{
      const noise=await fixture({text:'Thank you!',contextComplete:false});
      const completion=await fixture({text:'Done.',contextComplete:false});
      await schedule();
      assert.equal((await one<Candidate>('candidates',noise.candidate!.id))?.status,'ignored');
      assert.ok(await one<Evidence>('evidence',noise.evidence.id),'自动排除不删除原文');
      assert.ok(!(await list<Job>('jobs')).some(job=>job.candidateId===noise.candidate!.id),'不为无事实回复付费调用模型');
      assert.notEqual((await one<Candidate>('candidates',completion.candidate!.id))?.status,'ignored','done可能是完成回复，不能直接过滤');
    });
    await t.test('生成期间人工编辑不被覆盖；人工标题保留且新进展自动接续',async()=>{
      const edited=await fixture();const task=await enqueue(edited.candidate!);
      await processJob(task.id,async evidence=>{
        await put('candidates',{...edited.candidate!,version:2,humanEdited:true,status:'draft',content:{...edited.candidate!.content,title:'站长保留的标题'}});
        return generate(evidence);
      });
      assert.equal((await one<Job>('jobs',task.id))?.status,'failed');
      assert.equal((await one<Candidate>('candidates',edited.candidate!.id))?.content.title,'站长保留的标题');
      const parent=await fixture();await generateCandidate(parent.candidate!);
      const candidate=(await one<Candidate>('candidates',parent.candidate!.id))!;
      const event=(await one<RadarEvent>('events',candidate.content.eventId!))!;
      await executeCommand('event.correct',{id:event.id,version:event.version,reason:'人工确认资格后保留说明',content:{...candidate.content,title:'人工更正后的事件'}},'qa');
      const update=await fixture({parentId:parent.evidence.messageId});await generateCandidate(update.candidate!);
      assert.equal((await one<RadarEvent>('events',event.id))?.title,'人工更正后的事件');
      assert.equal((await one<Candidate>('candidates',update.candidate!.id))?.status,'published','人工保护只限修改字段，不永久阻断整个事件');
      await stopUnused();
    });
    await t.test('生成已保存后的租约恢复复用检查点，不重复调用模型',async()=>{
      const oldSite=await one<{id:string;name:string;description:string;autoPublish:boolean;version:number}>('settings','site');
      await put('settings',{id:'site',name:'模钥重置雷达',description:'隔离测试',autoPublish:false,version:60});
      const created=await fixture();const initialJob=await enqueue(created.candidate!);await processJob(initialJob.id);
      const savedJob=(await one<Job>('jobs',initialJob.id))!;
      assert.equal(savedJob.payload.generatedCandidateVersion,(await one<Candidate>('candidates',created.candidate!.id))!.version);
      await put('jobs',{...savedJob,status:'running',finishedAt:undefined,leaseUntil:new Date(Date.now()-1000).toISOString()});
      await put('settings',{id:'site',name:'模钥重置雷达',description:'隔离测试',autoPublish:true,version:61});
      await processJob(savedJob.id,async()=>{throw new Error('租约恢复不应重复调用模型');});
      assert.equal((await one<Candidate>('candidates',created.candidate!.id))?.status,'published');
      if(oldSite)await put('settings',oldSite);
    });
    await t.test('迟到父帖自动唤醒缺证候选，同一输入不会反复调用模型',async()=>{
      const parentMessage=(1900000000000000000n+BigInt(serial+2)).toString();
      const child=await fixture({parentId:parentMessage,text:'Confirmed landed across all accounts.',contextComplete:false});
      await generateCandidate(child.candidate!);
      const waiting=(await one<Candidate>('candidates',child.candidate!.id))!;
      assert.equal(waiting.status,'pending');assert.equal(waiting.automation?.state,'waiting_evidence');
      const callsBefore=generated.length;
      const jobsBefore=(await list<Job>('jobs')).filter(job=>job.candidateId===child.candidate!.id).length;
      await schedule();
      assert.equal((await list<Job>('jobs')).filter(job=>job.candidateId===child.candidate!.id).length,jobsBefore,'未补齐前不重复收费');
      const parent=await fixture({text:'We will load a banked reset for all accounts.'});
      assert.equal(parent.evidence.messageId,parentMessage);
      await schedule();
      const resumed=(await list<Job>('jobs')).find(job=>job.candidateId===child.candidate!.id&&job.status==='queued');
      assert.ok(resumed,'父帖入库后自动排入处理');
      await processJob(resumed.id);
      const completed=(await one<Candidate>('candidates',child.candidate!.id))!;
      assert.equal(completed.status,'published');
      assert.ok(generated.length>callsBefore);
      assert.ok(completed.content.evidenceIds.includes(parent.evidence.id));
      const count=generated.length;await schedule();await completeQueued();await schedule();
      assert.equal(generated.length,count,'补齐后的同一输入只生成一次');
    });
    await t.test('无智能接口先发布结构化中文模板，恢复后补充同一文章',async()=>{
      const previous=await one<Source>('sources','official-status');
      await put('sources',{...source,id:'official-status'});
      await put('settings',{...ai,enabled:false});
      try {
        const created=await fixture({sourceId:'official-status',text:'Codex service incident resolved.',provenance:'official',textOrigin:'structured',metadata:{status:'resolved'}});
        const task=await enqueue(created.candidate!);const callsBefore=generated.length;
        await processJob(task.id,generate,{allowTemplates:true});
        const template=(await one<Candidate>('candidates',created.candidate!.id))!;
        assert.equal(template.status,'published');assert.equal(template.content.contentOrigin,'template');
        assert.equal(template.automation?.templatePublished,true);assert.ok(template.automation.articleId);
        assert.equal(generated.length,callsBefore,'模板发布不调用模型');
        const articleId=template.automation.articleId;
        const articlesBefore=(await list('articles')).length,noticesBefore=(await list('notices')).length;
        await put('settings',ai);await schedule();
        const augment=(await list<Job>('jobs')).find(job=>job.candidateId===template.id&&job.status==='queued'&&job.payload.enrichArticle===true);
        assert.ok(augment);
        const detail=async(evidence:Evidence[]):Promise<DraftContent>=>({title:'官方服务恢复进展',summary:'官方状态记录确认服务故障已解决，原文没有福利发放承诺。',translation:'服务事件已经解决。',category:'product',actions:[],evidenceIds:evidence.map(item=>item.id),publicationMode:'news_only',contentOrigin:'generated'});
        await processJob(augment.id,detail,{allowTemplates:true});
        const enriched=(await one<Candidate>('candidates',template.id))!;
        assert.equal(enriched.status,'published');assert.equal(enriched.automation?.articleId,articleId);
        assert.equal(enriched.automation?.templatePublished,false);
        assert.equal((await list('articles')).length,articlesBefore,'补充中文不新建新闻');
        assert.equal((await list('notices')).length,noticesBefore,'中文补充不产生新提醒');
      } finally {await put('settings',ai);if(previous)await put('sources',previous);else await put('sources',{...source,id:'official-status',enabled:false});}
    });
    await t.test('来源结构异常暂停发布，成功探测后自动恢复，人工暂停保持关闭',async()=>{
      const sourceId=`structure-${tag}`;await put('sources',{...source,id:sourceId});
      const first=await transaction(c=>queueJob('collect',{sourceId},c));
      await processJob(first.id,generate,{collect:async()=>{throw new SourceStructureError('来源页面结构变化');}});
      const blocked=(await one<Source>('sources',sourceId))!;
      assert.equal(blocked.enabled,true);assert.equal(blocked.validated,false);assert.equal(blocked.publicationPaused,true);
      await put('sources',{...blocked,nextRunAt:new Date(Date.now()-1000).toISOString()});
      await schedule();const probe=(await list<Job>('jobs')).find(job=>job.sourceId===sourceId&&job.status==='queued');assert.ok(probe);
      await processJob(probe.id,generate,{collect:async()=>({seen:0,created:0})});
      const recovered=(await one<Source>('sources',sourceId))!;
      assert.equal(recovered.validated,true);assert.equal(recovered.publicationPaused,false);assert.equal(recovered.consecutiveFailures,0);
      await put('sources',{...blocked,enabled:false,nextRunAt:new Date(Date.now()-1000).toISOString()});await schedule();
      assert.ok(!(await list<Job>('jobs')).some(job=>job.sourceId===sourceId&&['queued','running'].includes(job.status)));
    });
    await t.test('仅新闻模板的补充仍缺证时，不循环生成或改变福利状态',async()=>{
      const created=await fixture({text:'重置卡已经加载。',parentId:'missing-template-parent',contextComplete:false,textOrigin:'archive_excerpt',metadata:{category:'reset'}});
      const task=await enqueue(created.candidate!);
      await processJob(task.id,generate,{allowTemplates:true});
      const template=(await one<Candidate>('candidates',created.candidate!.id))!;
      assert.equal(template.status,'published');assert.equal(template.content.publicationMode,'news_only');
      assert.equal((await one<RadarEvent>('events',template.content.eventId!))?.actions.length,0);
      await schedule();
      const augment=(await list<Job>('jobs')).find(job=>job.candidateId===template.id&&job.status==='queued'&&job.payload.enrichArticle===true);assert.ok(augment);
      let attempts=0;
      const incomplete=async(evidence:Evidence[]):Promise<DraftContent>=>{
        attempts++;
        return {title:'重置卡进展记录',summary:'来源记录了重置卡加载消息。',translation:'',category:'reset',actions:[{id:'incomplete-action',kind:'banked_reset',stage:'claimed_complete',eligibility:'所有账户',scope:'public',statementAt:evidence[0].publishedAt,evidenceIds:evidence.map(item=>item.id),evidenceQuote:evidence[0].text}],evidenceIds:evidence.map(item=>item.id),publicationMode:'state_change'};
      };
      await processJob(augment.id,incomplete,{allowTemplates:true});
      const count=(await list<Job>('jobs')).filter(job=>job.candidateId===template.id).length;
      await schedule();await schedule();
      assert.equal((await list<Job>('jobs')).filter(job=>job.candidateId===template.id).length,count,'输入相同且缺证时不重复付费生成');
      assert.equal(attempts,1);
      assert.equal((await one<RadarEvent>('events',template.content.eventId!))?.actions.length,0,'待补证候选不改变公开状态');
    });
    await t.test('自动发布重新开启只续发，不再调用模型',async()=>{
      const oldSite=await one<{id:string;name:string;description:string;autoPublish:boolean;version:number}>('settings','site');
      await put('settings',{id:'site',name:'模钥重置雷达',description:'隔离测试',autoPublish:false,version:70});
      const created=await fixture();await generateCandidate(created.candidate!);
      assert.equal((await one<Candidate>('candidates',created.candidate!.id))?.status,'pending');
      await put('settings',{id:'site',name:'模钥重置雷达',description:'隔离测试',autoPublish:true,version:71});
      await schedule();
      assert.ok((await list<Job>('jobs')).some(job=>job.candidateId===created.candidate!.id&&job.payload.publishOnly===true));
      const pendingJob=(await list<Job>('jobs')).find(job=>job.candidateId===created.candidate!.id&&job.payload.publishOnly===true)!;
      await processJob(pendingJob.id,async()=>{throw new Error('已生成的内容不应再次调用模型');});
      assert.equal((await one<Candidate>('candidates',created.candidate!.id))?.status,'published');
      if(oldSite)await put('settings',oldSite);
    });
  } finally {
    await put('settings',priorAI??{...ai,enabled:false,encryptedKey:undefined,hasKey:false});
    for(const item of await list<Source>('sources'))if(item.id.includes(tag))await put('sources',{...item,enabled:false});
    await pool.end();
  }
});
