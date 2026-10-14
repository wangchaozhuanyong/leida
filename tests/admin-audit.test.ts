import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Audit, Candidate, Job, Source } from '../src/lib/types';

// The normal suite uses controlled SQL and HTTP IO only, without loading local secrets.
process.env.DOTENV_CONFIG_PATH=fileURLToPath(new URL('./.admin-audit-no-env',import.meta.url));
process.env.ENCRYPTION_KEY=randomBytes(32).toString('base64');
const { pool, list, one, put }=await import('../src/db');
const { executeCommand }=await import('../src/server/service');
const { DomainError }=await import('../src/server/domain');
const { defaultAI, encryptKey, AIServiceError }=await import('../src/server/ai');
const originalQuery=pool.query,originalConnect=pool.connect;
type RecordValue={id:string;[key:string]:unknown};
type State={tables:Record<string,RecordValue[]>;usage:RecordValue[]};
let state:State={tables:{},usage:[]},auditFailures=0;
const clone=<T>(value:T):T=>structuredClone(value);
const table=(name:string)=>state.tables[name]??(state.tables[name]=[]);
const rows=(values:unknown[],rowCount=values.length)=>({rows:values,rowCount});
async function query(sql:string,values:unknown[]=[]):Promise<ReturnType<typeof rows>> {
  if(sql.startsWith('SELECT pg_advisory')||sql.startsWith('SET TRANSACTION'))return rows([]);
  if(sql.includes('SELECT count(*)::int AS calls'))return rows([{calls:state.usage.length,cost:state.usage.reduce((total,item)=>total+Number(item.cost),0)}]);
  if(sql.startsWith('INSERT INTO radar_ai_usage')){state.usage.push({id:String(values[0]),model:values[1],cost:values[2]});return rows([],1);}
  if(sql.startsWith('UPDATE radar_ai_usage')){const item=state.usage.find(item=>item.id===values[0]);assert.ok(item);if(sql.includes("status='failed'"))item.status='failed';else Object.assign(item,{input_tokens:values[1],output_tokens:values[2],cost:values[3],status:values[4]});return rows([],1);}
  const select=sql.match(/^SELECT payload FROM radar_(\w+)(?: WHERE id = \$1)?/);
  if(select){const records=table(select[1]);return rows((sql.includes('WHERE id =')?records.filter(item=>item.id===values[0]):records).map(payload=>({payload:clone(payload)})));}
  const insert=sql.match(/^INSERT INTO radar_(\w+)\(id,payload\)/);
  if(insert){if(insert[1]==='audits'&&auditFailures>0){auditFailures--;throw new Error('fixture storage failure contains no source or credential');}const records=table(insert[1]),index=records.findIndex(item=>item.id===values[0]),record=JSON.parse(String(values[1]));if(index<0){records.push(record);return rows([],1);}if(sql.includes('DO UPDATE')){records[index]=record;return rows([],1);}return rows([],0);}
  throw new Error('Unexpected controlled SQL operation');
}
function installMemoryIO() {
  pool.query=query as typeof pool.query;
  pool.connect=(async()=>{
    let snapshot:State|undefined;
    return {release(){},async query(sql:string,values?:unknown[]){
      if(sql==='BEGIN'){snapshot=clone(state);return rows([]);}
      if(sql==='COMMIT'){snapshot=undefined;return rows([]);}
      if(sql==='ROLLBACK'){if(snapshot)state=snapshot;snapshot=undefined;return rows([]);}
      return query(sql,values);
    }};
  }) as typeof pool.connect;
}
function reset(){state={tables:{},usage:[]};auditFailures=0;installMemoryIO();}
const actor='audit-test-owner';
test('活动管理拒绝不存在的日历日期，不保存不可展示的活动',async()=>{
  reset();
  for(const startsOn of ['2026-02-31','2026-04-31','2026-13-01']){
    await assert.rejects(executeCommand('activity.save',{title:'日期校验活动',timezone:'Asia/Shanghai',startsOn,days:28,rules:'按当地日期记录活动'},actor));
  }
  assert.equal(table('activities').length,0);
  const saved=await executeCommand('activity.save',{title:'日期校验活动',timezone:'Asia/Shanghai',startsOn:'2024-02-29',days:28,rules:'按当地日期记录活动'},actor) as {startsOn:string};
  assert.equal(saved.startsOn,'2024-02-29');
});
const rawText='Exact private fixture body must never enter the audit log.';
const input=()=>({url:'https://example.invalid/audit-original',text:rawText,publishedAt:'2026-10-10T00:00:00Z',contextComplete:true});
const audits=()=>list<Audit>('audits');
function source(id='audit-source',validated=true):Source{return {id,name:'审计测试来源',kind:'archive',url:'https://example.invalid/archive',enabled:true,validated,intervalMinutes:5,version:1,status:'unconnected'};}
async function makeCandidate():Promise<Candidate>{const result=await executeCommand('candidate.create',input(),actor) as {candidate:Candidate};return result.candidate;}
function assertSafe(value:unknown,...forbidden:string[]){const serialized=JSON.stringify(value);for(const secret of [rawText,...forbidden])assert.ok(!serialized.includes(secret),'审计不应保留原文、密钥或原始异常内容');}
async function fakeAI<T>(callback:()=>Promise<T>):Promise<{value:T;requests:number}> {
  const originalRequest=https.request,originalLookup=dns.lookup;let requests=0;
  dns.lookup=(async()=>[{address:'203.0.113.20',family:4}]) as unknown as typeof dns.lookup;
  https.request=((_url:unknown,_options:unknown,onResponse:(response:unknown)=>void)=>{
    const req=new EventEmitter() as EventEmitter&{end:(body:string)=>void;destroy:()=>void};
    req.destroy=()=>req.emit('close');req.end=()=>queueMicrotask(()=>{requests++;const response=Object.assign(new EventEmitter(),{statusCode:200,headers:{},resume(){}});onResponse(response);response.emit('data',Buffer.from(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}],usage:{prompt_tokens:20,completion_tokens:10}})));response.emit('end');req.emit('close');});return req;
  }) as typeof https.request;
  syncBuiltinESMExports();
  try{return {value:await callback(),requests};}finally{https.request=originalRequest;dns.lookup=originalLookup;syncBuiltinESMExports();}
}
async function configureFakeAI(){await put('settings',{...defaultAI,encryptedKey:encryptKey('fixture-only-api-key'),hasKey:true,baseUrl:'https://ai-fixture.example.invalid/v1',model:'fixture-model',dailyCallLimit:10,dailyBudget:1,inputPrice:0.2,outputPrice:0.8});}

test('后台审计：人工原文新增及重复导入有记录，原文不进入日志',async()=>{
  reset();const created=await executeCommand('candidate.create',input(),actor) as {candidate:Candidate;evidence:{id:string};created:boolean};
  const repeated=await executeCommand('candidate.create',input(),actor) as typeof created;
  assert.equal(created.created,true);assert.equal(repeated.created,false);assert.equal(table('evidence').length,1);assert.equal(table('candidates').length,1);
  const records=await audits();assert.deepEqual(records.map(item=>[item.actor,item.action,(item.after as {outcome:string}).outcome]),[[actor,'candidate.create','created'],[actor,'candidate.create','duplicate']]);
  assert.equal(records[0].objectId,created.candidate.id);assert.equal(records[1].objectId,created.evidence.id);assertSafe(records);
});
test('后台审计：重新生成保留任务幂等，已运行任务也被复用',async()=>{
  reset();const candidate=await makeCandidate();
  const job=await executeCommand('candidate.generate',{id:candidate.id,version:1},actor) as Job;
  await put('jobs',{...job,status:'running'});
  const repeated=await executeCommand('candidate.generate',{id:candidate.id,version:1},actor) as Job;
  assert.equal(repeated.id,job.id);assert.equal(table('jobs').length,1);assert.equal(job.payload.force,true);
  const records=(await audits()).filter(item=>item.action==='candidate.generate');assert.deepEqual(records.map(item=>(item.after as {outcome:string}).outcome),['queued','already_pending']);
  assert.ok(records.every(item=>item.actor===actor&&item.objectId===candidate.id));assert.equal((records[1].after as {jobStatus:string}).jobStatus,'running');assertSafe(records);
});
test('后台审计：采集和补采分别入队且重复请求不增加任务',async()=>{
  reset();await put('sources',source());
  for(const action of ['source.collect','source.backfill']){
    const first=await executeCommand(action,{id:'audit-source'},actor) as Job,repeated=await executeCommand(action,{id:'audit-source'},actor) as Job;
    assert.equal(first.id,repeated.id);assert.equal(first.payload.historical,action==='source.backfill');
  }
  assert.equal(table('jobs').length,2);const records=await audits();assert.equal(records.length,4);
  assert.deepEqual(records.map(item=>(item.after as {outcome:string}).outcome),['queued','already_pending','queued','already_pending']);assert.ok(records.every(item=>item.actor===actor&&item.objectId==='audit-source'));assertSafe(records);
});
test('后台审计：版本冲突和未验证来源失败被记录，原异常保留',async()=>{
  reset();const candidate=await makeCandidate();await put('sources',source('unvalidated-source',false));
  await assert.rejects(executeCommand('candidate.generate',{id:candidate.id,version:99},actor),error=>error instanceof DomainError&&error.status===409);
  await assert.rejects(executeCommand('source.collect',{id:'unvalidated-source'},actor),/请先验证来源/);
  const records=(await audits()).filter(item=>(item.after as {outcome:string}).outcome==='failed');assert.deepEqual(records.map(item=>[item.action,(item.after as {status:number;failureKind:string}).status,(item.after as {failureKind:string}).failureKind]),[['candidate.generate',409,'conflict'],['source.collect',400,'validation']]);assert.equal(table('jobs').length,0);assertSafe(records);
});
test('后台审计：创建校验失败与创建后编辑失败分别记为失败和部分完成',async()=>{
  reset();await assert.rejects(executeCommand('candidate.create',{...input(),text:'x',key:'never-log-input-key'},actor));
  await assert.rejects(executeCommand('candidate.create',{...input(),content:{title:'缺少必要内容'}},actor));
  const records=await audits();assert.deepEqual(records.map(item=>(item.after as {outcome:string}).outcome),['failed','created','partial']);assert.equal(table('evidence').length,1);assert.equal(table('candidates').length,1);
  const partial=records[2].after as {evidenceId:string;candidateId:string};assert.equal(partial.evidenceId,table('evidence')[0].id);assert.equal(partial.candidateId,table('candidates')[0].id);assertSafe(records,'never-log-input-key');
});
test('后台审计：入队成功记录写入失败会回滚任务，随后记录安全失败',async()=>{
  reset();await put('sources',source());auditFailures=1;
  await assert.rejects(executeCommand('source.backfill',{id:'audit-source'},actor),/fixture storage failure/);
  assert.equal(table('jobs').length,0);const records=await audits();assert.equal(records.length,1);assert.equal((records[0].after as {outcome:string}).outcome,'failed');assert.equal((records[0].after as {status:number}).status,500);assertSafe(records,'fixture storage failure');
});
test('后台审计：原文成功记录写入失败会回滚原文和候选',async()=>{
  reset();auditFailures=1;await assert.rejects(executeCommand('candidate.create',input(),actor),/fixture storage failure/);
  assert.equal(table('evidence').length,0);assert.equal(table('candidates').length,0);const records=await audits();assert.equal(records.length,1);assert.equal((records[0].after as {outcome:string}).outcome,'failed');assertSafe(records);
});
test('后台审计：未配置智能服务失败不发请求，日志没有输入或密钥',async()=>{
  reset();const result=await fakeAI(async()=>{await assert.rejects(executeCommand('ai.test',{key:'never-log-test-input'},actor),error=>error instanceof AIServiceError&&error.failureKind==='configuration');});
  assert.equal(result.requests,0);assert.equal(state.usage.length,0);const records=await audits();assert.equal(records.length,1);assert.equal(records[0].objectId,'ai');assert.equal((records[0].after as {failureKind:string}).failureKind,'configuration');assertSafe(records,'never-log-test-input');
});
test('后台审计：受控智能连接成功记录结果及调用预算，不保留密钥',async()=>{
  reset();await configureFakeAI();const result=await fakeAI(()=>executeCommand('ai.test',{},actor));
  assert.equal(result.requests,1);assert.equal(state.usage.length,1);assert.equal(state.usage[0].status,'succeeded');const testedAt=(result.value as {testedAt:string}).testedAt;assert.ok(testedAt);assert.equal((await one<{testedAt:string}>('settings','ai'))?.testedAt,testedAt);
  const records=await audits();assert.equal(records.length,1);assert.equal(records[0].actor,actor);assert.deepEqual(records[0].after,{outcome:'succeeded',testedAt});assertSafe(records,'fixture-only-api-key','encryptedKey','ai-fixture.example.invalid');
});
test('后台审计：连接成功但审计不可写时提示已成功，避免重复付费测试',async()=>{
  reset();await configureFakeAI();auditFailures=1;const result=await fakeAI(async()=>{await assert.rejects(executeCommand('ai.test',{},actor),error=>error instanceof DomainError&&error.status===503&&/连接测试已成功/.test(error.message));});
  assert.equal(result.requests,1);assert.ok((await one<{testedAt?:string}>('settings','ai'))?.testedAt);assert.equal(state.usage.length,1);assert.equal(table('audits').length,0);
});

test('隔离数据库后台审计：新增、去重、生成、采集、补采及失败结果', {skip:process.env.RADAR_INTEGRATION!=='1'},async()=>{
  assert.match(new URL(process.env.DATABASE_URL!).pathname,/^\/radar_qa_/,'只允许独立 QA 数据库');
  pool.query=originalQuery;pool.connect=originalConnect;
  const tag=randomBytes(8).toString('hex'),qaActor=`audit-qa-${tag}`,sourceId=`audit-source-${tag}`;
  const fixture={...input(),url:`https://example.invalid/audit-${tag}`,messageId:`audit-${tag}`};
  const originalAI=await one('settings','ai');
  try{
    const created=await executeCommand('candidate.create',fixture,qaActor) as {candidate:Candidate;evidence:{id:string}};
    await executeCommand('candidate.create',fixture,qaActor);
    const generated=await executeCommand('candidate.generate',{id:created.candidate.id,version:1},qaActor) as Job;
    const repeated=await executeCommand('candidate.generate',{id:created.candidate.id,version:1},qaActor) as Job;assert.equal(generated.id,repeated.id);
    await put('sources',source(sourceId));
    for(const action of ['source.collect','source.backfill']){const first=await executeCommand(action,{id:sourceId},qaActor) as Job,again=await executeCommand(action,{id:sourceId},qaActor) as Job;assert.equal(first.id,again.id);}
    await assert.rejects(executeCommand('candidate.generate',{id:created.candidate.id,version:99},qaActor),error=>error instanceof DomainError&&error.status===409);
    await put('settings',defaultAI);await assert.rejects(executeCommand('ai.test',{},qaActor),error=>error instanceof AIServiceError&&error.failureKind==='configuration');
    const records=(await audits()).filter(item=>item.actor===qaActor);assert.equal(records.length,10);assert.deepEqual(new Set(records.map(item=>item.action)),new Set(['candidate.create','candidate.generate','source.collect','source.backfill','ai.test']));
    assert.equal((await list<Job>('jobs')).filter(item=>item.candidateId===created.candidate.id||item.sourceId===sourceId).length,3);assertSafe(records);
  }finally{if(originalAI)await put('settings',originalAI as {id:string});pool.query=originalQuery;pool.connect=originalConnect;}
});
after(async()=>{pool.query=originalQuery;pool.connect=originalConnect;await pool.end();});


test('站内信独立发布、校验和撤回均有审计，不制造公告、事件或微信任务',async()=>{
  reset();
  for(const input of [{title:'',body:'测试正文'},{title:'标题',body:''},{title:'长'.repeat(81),body:'测试正文'}])await assert.rejects(executeCommand('notice.publish',input,actor));
  assert.equal(table('notices').length,0);
  const input={title:' 测试站内信 ',body:'第一行正文\n第二行正文',requestId:'00000000-0000-4000-8000-000000000001'};
  const notice=await executeCommand('notice.publish',input,actor) as {id:string;origin:string;publicationId:string;body:string;status:string};
  assert.equal((await executeCommand('notice.publish',input,actor) as {id:string}).id,notice.id);
  await assert.rejects(executeCommand('notice.publish',{...input,body:'另一个正文'},actor),/已变化/);
  assert.equal(table('notices').length,1);
  assert.equal(notice.origin,'admin');assert.equal(notice.publicationId,'');assert.equal(notice.body,'第一行正文\n第二行正文');
  for(const tableName of ['events','articles','publications','jobs','wechat_deliveries'])assert.equal(table(tableName).length,0);
  assert.equal((await audits()).filter(a=>a.action==='notice.publish').length,1);
  await executeCommand('notice.withdraw',{id:notice.id},actor);await executeCommand('notice.withdraw',{id:notice.id},actor);
  assert.equal(table('notices')[0].status,'withdrawn');assert.equal((await audits()).filter(a=>a.action==='notice.withdraw').length,1);
  await assert.rejects(executeCommand('notice.withdraw',{id:'missing'},actor),/未找到/);
});
