import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool,put,insert,list,one,transaction} from '../src/db';
import {applyForecastMigration} from '../scripts/migrations/forecast';
import {runForecastCycle,getPublicForecast,getForecastSnapshot,forecastTablesAvailable} from '../src/server/forecast';
import {createEvidence,executeCommand,getPublicData} from '../src/server/service';
import type {Source,Evidence,Publication,RadarEvent,Article,Notice} from '../src/lib/types';
import {effectiveForecastOutcome,selectTrainingSamples,type ForecastCase,type ForecastSnapshot,type ForecastOutcome} from '../src/lib/forecast';

test('真实隔离库：预测独立闭环、固定快照、公告关联和未知守卫',{skip:process.env.RADAR_INTEGRATION!=='1'},async t=>{
 assert.match(new URL(process.env.DATABASE_URL!).pathname,/^\/radar_qa_/);
 const tag=randomUUID(),sourceId=`forecast-status-${tag}`,announcementSource=`forecast-archive-${tag}`,signalAt='2026-10-10T00:00:00.000Z',collectedAt='2026-10-10T00:01:00.000Z',at='2026-10-10T00:02:00.000Z';
 const source:Source={id:sourceId,name:'隔离官方来源',kind:'status',url:'https://status.openai.com/api/v2/incidents.json',enabled:true,validated:true,status:'healthy',intervalMinutes:10_080,version:1,lastSuccessAt:collectedAt};
 const signal:Evidence={id:`signal-${tag}`,sourceId,messageId:`update-${tag}`,parentId:tag.replaceAll('-',''),url:`https://status.openai.com/incidents/${tag.replaceAll('-','')}`,text:'We have identified an issue causing Codex usage to be consumed faster than expected, which may cause some users to hit rate limits sooner than intended.',metadata:{title:'Issues with Increased Codex Usage Rate',status:'identified',sourceGroup:'openai-status'},textOrigin:'structured',publishedAt:signalAt,collectedAt,contextComplete:true,historical:false,provenance:'official',hash:tag};
 try{
  await t.test('未迁移公共事务正常返回unavailable；显式隔离迁移可重复',async()=>{
   assert.equal(await forecastTablesAvailable(),false);assert.equal((await getPublicData()).forecasts?.status,'unavailable');
   await transaction(applyForecastMigration);await transaction(applyForecastMigration);assert.equal(await forecastTablesAvailable(),true);
  });
  await put('sources',source);await put('sources',{...source,id:announcementSource,name:'隔离公告来源',kind:'archive'});await insert('evidence',signal);
  const before=[(await list('events')).length,(await list('articles')).length,(await list<Notice>('notices')).length];
  let caseId='',firstSnapshot:ForecastSnapshot|undefined;
  await t.test('自动发现分开两个目标；无福利写入；refresh及并发不重复',async()=>{
   const result=await runForecastCycle(at);assert.equal(result.discovered,2);assert.equal(result.snapshots,2);
   const cases=(await list<ForecastCase>('forecast_cases')).filter(c=>c.sourceId===sourceId);assert.equal(cases.length,2);
   const usage=cases.find(c=>c.target==='automatic_reset')!,card=cases.find(c=>c.target==='banked_reset')!;caseId=usage.id;
   firstSnapshot=await getForecastSnapshot(usage.snapshotId);assert.equal(firstSnapshot?.p24,.3);assert.equal(firstSnapshot?.p48,.8);assert.equal((await getForecastSnapshot(card.snapshotId))?.p48,null);
   const concurrent=await Promise.all([runForecastCycle('2026-10-10T00:04:00Z'),runForecastCycle('2026-10-10T00:04:00Z')]);assert.equal(concurrent.reduce((n,r)=>n+r.discovered+r.snapshots,0),0);
   assert.deepEqual(await getForecastSnapshot(usage.snapshotId),firstSnapshot);assert.deepEqual([(await list('events')).length,(await list('articles')).length,(await list<Notice>('notices')).length],before);
  });
  const publishFixture=async(stage:'promised'|'in_progress'|'claimed_complete'|'cancelled',time:string,text:string,proofSourceId=announcementSource)=>{
   const id=randomUUID(),eid=`announcement-${id}`,pid=`pub-${id}`,eventId=`event-${id}`,articleId=`article-${id}`;
   const e:Evidence={...signal,id:eid,sourceId:proofSourceId,messageId:id,parentId:undefined,url:`https://x.com/forecast_fixture/status/${BigInt('0x'+id.replaceAll('-','').slice(0,14))}`,text,textOrigin:'original',provenance:'archive',metadata:undefined,publishedAt:time,collectedAt:time,hash:id};
   const event:RadarEvent={id:eventId,title:'隔离公告',version:1,status:'published',publicationId:pid,updatedAt:time,evidenceIds:[eid],actions:[{id:`action-${id}`,kind:'automatic_reset',stage,scope:'public',eligibility:'所有账户',statementAt:time,evidenceIds:[eid],evidenceQuote:text}]};
   const article:Article={id:articleId,eventId,title:'隔离公告',summary:'明确关联的公开公告。',translation:'',category:'reset',version:1,status:'published',publicationId:pid,evidenceIds:[eid],publishedAt:time,updatedAt:time,publicationMode:'state_change'};
   const publication:Publication={id:pid,eventId,articleId,event,article,publishedAt:time,cutoffAt:time,reason:'synthetic QA publication fixture'};
   await insert('evidence',e);await put('events',event);await put('articles',article);await insert('publications',publication);return {publication,event,article};
  };
  await t.test('时间近邻不关联；明确来源关联记录预告/進展/完成，不当个人到账',async()=>{
   await publishFixture('promised','2026-10-10T00:30:00Z','We will reset Codex usage for all accounts.');await runForecastCycle('2026-10-10T01:00:00Z',{inputsChanged:true});
   assert.equal((await list<ForecastOutcome>('forecast_outcomes')).filter(o=>o.caseId===caseId).length,0);
   for(const [stage,time] of [['promised','2026-10-10T02:00:00Z'],['in_progress','2026-10-10T03:00:00Z'],['claimed_complete','2026-10-10T04:00:00Z']] as const){await publishFixture(stage,time,`Codex usage reset statement (${stage}) for all accounts, in response to the usage issue: ${signal.url}`);await runForecastCycle(time,{inputsChanged:true});}
   const outcomes=(await list<ForecastOutcome>('forecast_outcomes')).filter(o=>o.caseId===caseId);assert.deepEqual(outcomes.map(o=>o.stage).sort(),['claimed_complete','in_progress','promised']);assert.ok(outcomes.every(o=>o.actualDelivery==='unobserved'));
   const c=(await one<ForecastCase>('forecast_cases',caseId))!;assert.equal(c.status,'observed');assert.deepEqual(await getForecastSnapshot(c.snapshotId),firstSnapshot);
   await runForecastCycle('2026-10-10T04:02:00Z');assert.equal((await list<ForecastOutcome>('forecast_outcomes')).filter(o=>o.caseId===caseId).length,3);
  });
  await t.test('首采前已有公告只作事后观察；取消保留结局但旧正例失效',async()=>{
   const known={...signal,id:`known-${tag}`,messageId:`known-update-${tag}`,url:`https://status.openai.com/incidents/known${tag.replaceAll('-','')}`,collectedAt:'2026-10-10T07:00:00Z',hash:`known-${tag}`};await insert('evidence',known);
   await publishFixture('promised','2026-10-10T06:00:00Z',`Codex usage will be reset for all accounts in response to the usage issue ${known.url}`);
   await runForecastCycle('2026-10-10T08:00:00Z',{inputsChanged:true});
   const c=(await list<ForecastCase>('forecast_cases')).find(c=>c.url===known.url&&c.target==='automatic_reset')!,snapshot=(await getForecastSnapshot(c.snapshotId))!;
   assert.equal(snapshot.basis,'already_known');assert.equal(snapshot.p24,null);assert.equal(snapshot.p48,null);assert.match(snapshot.explanation,/生成时已存在/);
   await publishFixture('cancelled','2026-10-10T09:00:00Z',`Correction: Codex usage reset for all accounts is cancelled in response to the usage issue ${known.url}`);await runForecastCycle('2026-10-10T09:00:00Z',{inputsChanged:true});
   const related=(await list<ForecastOutcome>('forecast_outcomes')).filter(outcome=>outcome.caseId===c.id);
   const effective=effectiveForecastOutcome(related,c.id,'automatic_reset','2026-10-10T09:00:00Z');
   assert.equal(effective.positive,undefined,'明确取消使先前预告不再有效');assert.equal(effective.invalidated,true);
   assert.equal(effective.latest?.stage,'cancelled');assert.equal((await one<ForecastCase>('forecast_cases',c.id))?.status,'observed');assert.deepEqual(await getForecastSnapshot(c.snapshotId),snapshot);
   const cancelled=related.find(outcome=>outcome.stage==='cancelled')!;
   assert.ok(cancelled.relationVerified);assert.ok(related.some(outcome=>outcome.stage==='promised'),'原预告记录继续保留');
   assert.equal(related.some(outcome=>outcome.invalidated&&outcome.publicationId===cancelled.publicationId),false,'稳定取消公告不能标记自身失效');
   const replay=await runForecastCycle('2026-10-10T09:02:00Z');assert.equal(replay.status,'ready');assert.equal(replay.outcomes,0);
   const replayed=(await list<ForecastOutcome>('forecast_outcomes')).filter(outcome=>outcome.caseId===c.id);
   assert.deepEqual(replayed.map(outcome=>outcome.id).sort(),related.map(outcome=>outcome.id).sort(),'重跑不追加取消自身的失效结局');
   assert.equal(effectiveForecastOutcome(replayed,c.id,'automatic_reset','2026-10-10T09:02:00Z').positive,undefined);
  });
  await t.test('到期未找到保持unknown；来源暂停不复活；原始快照数据库也不可覆盖',async()=>{
   await runForecastCycle('2026-10-12T01:00:00Z');const data=await getPublicForecast(undefined,'2026-10-12T01:00:00Z');
   const card=data.cases.find(c=>c.sourceId===sourceId&&c.target==='banked_reset')!;assert.equal(card.status,'elapsed');assert.equal(card.outcomes[0].stage,'unknown');assert.equal(card.snapshot?.p48,null);
   await put('sources',{...source,enabled:false,status:'paused'});await runForecastCycle('2026-10-12T01:02:00Z',{inputsChanged:true});assert.equal((await getPublicForecast(undefined,'2026-10-12T01:02:00Z')).cases.find(c=>c.id===caseId)?.status,'paused');assert.equal((await one<Source>('sources',sourceId))?.enabled,false);
   await assert.rejects(put('forecast_snapshots',{...firstSnapshot!,p48:1}),/不可变/);
   await assert.rejects(pool.query('UPDATE radar_forecast_snapshots SET payload=payload WHERE id=$1',[firstSnapshot!.id]),/immutable forecast/);
   assert.deepEqual(await getForecastSnapshot(firstSnapshot!.id),firstSnapshot);
  });
  await t.test('原动作合并后继续有效，人工更正移除后追加一次失效且训练排除',async()=>{
   const start=Date.now()-60*3600_000;
   const startAt=new Date(start).toISOString(),completionAt=new Date(start+2*3600_000).toISOString();
   const statusId=`corrected-status-${tag}`,proofId=`corrected-proof-${tag}`;
   const correctedSignal={...signal,id:`corrected-signal-${tag}`,sourceId:statusId,messageId:`corrected-update-${tag}`,url:`https://status.openai.com/incidents/corrected${tag.replaceAll('-','')}`,publishedAt:startAt,collectedAt:startAt,hash:`corrected-${tag}`};
   await put('sources',{...source,id:statusId,lastSuccessAt:startAt});
   await put('sources',{...source,id:proofId,kind:'archive',lastSuccessAt:startAt});
   await insert('evidence',correctedSignal);
   await runForecastCycle(new Date(start+60_000).toISOString(),{force:true});
   const observation=(await list<ForecastCase>('forecast_cases')).find(c=>c.sourceId===statusId&&c.target==='automatic_reset')!;
   assert.ok(observation);
   const sample={...observation,coverage:{...observation.coverage,status:'verified' as const}};
   const frozen=await getForecastSnapshot(sample.snapshotId);
   const completed=await publishFixture('claimed_complete',completionAt,`We have reset all usage limits for all accounts.\n${correctedSignal.url}`,proofId);
   const target=await publishFixture('promised',completionAt,'We will reset usage for all accounts.',proofId);
   await runForecastCycle(completionAt,{force:true});
   const related=async()=>(await list<ForecastOutcome>('forecast_outcomes')).filter(o=>o.caseId===sample.id);
   const initial=await related();
   assert.equal(initial.length,1);
   assert.equal(initial[0].stage,'claimed_complete');
   const merged=await executeCommand('event.merge',{id:completed.event.id,version:completed.event.version,targetId:target.event.id,targetVersion:target.event.version,reason:'合并相同活动的公开动作'},'qa') as Publication;
   const afterMove=new Date().toISOString();
   await runForecastCycle(afterMove,{force:true});
   assert.deepEqual(await related(),initial,'同一动作移动到仍公开的事件不使结果失效');
   assert.deepEqual(selectTrainingSamples([sample],await related(),afterMove),initial);

   const correction=await createEvidence({sourceId:'manual',messageId:`correction-${tag}`,url:'https://example.invalid/correction',text:'Correction: this update concerns an editor layout improvement only.',publishedAt:afterMove,collectedAt:afterMove,contextComplete:true,historical:false,provenance:'manual'});
   await executeCommand('event.correct',{id:merged.event.id,version:merged.event.version,reason:'核实这条公告仅涉及产品改进',content:{title:'产品消息更正',summary:'此公告仅涉及编辑器的布局调整。',translation:'',category:'product',actions:[],evidenceIds:[correction.evidence.id]}},'qa');
   await runForecastCycle(afterMove,{force:true});
   assert.deepEqual(await related(),initial,'更正尚不可知的回放时间不能提前使旧结局失效');
   const afterCorrection=new Date().toISOString();
   await runForecastCycle(afterCorrection,{force:true});
   const invalidated=await related();
   assert.deepEqual(invalidated.filter(o=>!o.invalidated),initial,'旧结果快照保持原样');
   assert.equal(invalidated.filter(o=>o.invalidated).length,1);
   assert.equal(effectiveForecastOutcome(invalidated,sample.id,sample.target,afterCorrection).positive,undefined);
   assert.deepEqual(selectTrainingSamples([sample],invalidated,afterCorrection),[]);
   await runForecastCycle(new Date().toISOString(),{force:true});
   assert.deepEqual(await related(),invalidated,'重新运行不会重复写入失效结局');
   assert.deepEqual(await getForecastSnapshot(sample.snapshotId),frozen);
  });
 }finally{await pool.end();}
});
