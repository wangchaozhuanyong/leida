import test from 'node:test';
import assert from 'node:assert/strict';
import {pool,list,one,put,transaction} from '../src/db';
import {sourceDefinitions} from '../src/server/ingestion';
import {queueJob} from '../src/server/service';
import {runOne} from '../src/server/worker';
import type {Audit,Job,Source,Evidence} from '../src/lib/types';

test('隔离库：通用来源重试、持久安全诊断、终端失败与后续恢复',{skip:process.env.RADAR_INTEGRATION!=='1'},async()=>{
 assert.match(new URL(process.env.DATABASE_URL!).pathname,/^\/radar_tibo_public_qa_\d+$/);
 const beforeFetch=globalThis.fetch;const source={...sourceDefinitions.find(s=>s.id==='official-status')!,enabled:true,validated:true,cursor:'2026-10-10T00:00:00Z'};
 let calls=0,phase:'recover'|'failed'|'healthy'='recover';
 globalThis.fetch=async(input,init)=>{
  calls++;assert.equal(String(input),source.url);const headers=new Headers(init?.headers);assert.equal(headers.get('authorization'),null);assert.equal(headers.get('cookie'),null);
  if(phase==='failed'||phase==='recover'&&calls===1)throw new TypeError('private network error',{cause:{code:'ECONNRESET'}});
  if(phase==='recover'&&calls===2)return new Response('private upstream body',{status:503});
  return new Response('{"incidents":[]}');
 };
 try{
  await put('sources',source);const evidenceCount=(await list<Evidence>('evidence')).length;
  const collect=async()=>{const job=await transaction(c=>queueJob('collect',{sourceId:source.id},c));await put('jobs',{...job,availableAt:'2000-01-01T00:00:00Z'});await runOne({schedule:false});return (await one<Job>('jobs',job.id))!;};
  const recovered=await collect();assert.equal(recovered.status,'succeeded');assert.equal(calls,3);
  const diagnostics=(await list<Audit>('audits')).filter(a=>a.objectId===source.id&&a.action.startsWith('source.request.'));
  assert.equal(diagnostics.filter(a=>a.action==='source.request.failed').length,2);assert.equal(diagnostics.filter(a=>a.action==='source.request.recovered').length,1);
  assert.ok(!JSON.stringify(diagnostics).includes('private'));assert.equal((await one<Source>('sources',source.id))?.cursor,source.cursor);
  phase='failed';const failed=await collect();assert.equal(failed.status,'failed');assert.equal(failed.payload.failureKind,'transient');
  assert.equal(calls,6);const audit=(await list<Audit>('audits')).find(a=>a.objectId===failed.id&&a.action==='job.failed');assert.ok(audit);assert.equal((audit.after as {kind:string}).kind,'collect');
  assert.equal((await one<Source>('sources',source.id))?.status,'failed');assert.equal((await one<Source>('sources',source.id))?.validated,true);
  phase='healthy';const healthy=await collect();assert.equal(healthy.status,'succeeded');assert.equal((await one<Source>('sources',source.id))?.consecutiveFailures,0);
  assert.equal((await list<Evidence>('evidence')).length,evidenceCount,'空状态接口不新增或删除业务证据');
 }finally{globalThis.fetch=beforeFetch;await pool.end();}
});
