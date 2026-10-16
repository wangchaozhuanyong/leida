import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CloudbaseRpc,type CloudbaseOperation} from '../src/server/cloudbase/rpc';
import {createEvidence,executeCommand,previewCandidate,publishCandidate} from '../src/server/service';
import {validateSource,sourceDefinitions} from '../src/server/ingestion';
import type {Candidate,DraftContent,Source} from '../src/lib/types';

test('预测输入revision只随成功业务变化同事务提交，重复、只读、失败不触发',async t=>{
 for(const [key,value] of Object.entries({RADAR_STORAGE_BACKEND:'cloudbase',RADAR_PUBLIC_READ_BACKEND:'cloudbase',CLOUDBASE_ENV_ID:'leida-revision-fixture',CLOUDBASE_API_KEY:'fixture-not-a-real-key'})){
  const previous=process.env[key];process.env[key]=value;
  t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
 }
 type Row={id:string;payload:{id:string;[key:string]:any};createdAt:string};
 const tables=new Map<string,Map<string,Row>>();let rejectCommit=false,revisionWrites=0;
 const rows=(table:string)=>[...(tables.get(table)?.values()??[])].sort((a,b)=>a.id.localeCompare(b.id));
 const fingerprint=(table:string)=>createHash('md5').update(JSON.stringify(rows(table))).digest('hex');
 const seed=(table:string,payload:any)=>{if(!tables.has(table))tables.set(table,new Map());tables.get(table)!.set(payload.id,{id:payload.id,payload:structuredClone(payload),createdAt:new Date().toISOString()});};
 const get=(table:string,id:string)=>tables.get(table)?.get(id)?.payload;
 const revision=()=>get('settings','forecast_inputs')?.revision;
 t.mock.method(CloudbaseRpc.prototype,'call',async(operation:CloudbaseOperation,params:Record<string,any>={})=>{
  if(operation==='radar_cb_store_read')return {fingerprint:fingerprint(params.p_table),rows:rows(params.p_table).filter(row=>!params.p_id||row.id===params.p_id),more:false,after:null};
  if(operation==='radar_cb_store_commit'){
   if(rejectCommit)throw new Error('isolated commit rejection');
   for(const [table,expected] of Object.entries(params.p_expected))assert.equal(fingerprint(table),expected);
   for(const change of params.p_changes){
    if(change.kind==='insert'&&get(change.table,change.value.id))continue;
    if(change.table==='settings'&&change.value.id==='forecast_inputs')revisionWrites++;
    seed(change.table,change.value);
   }
   return true;
  }
  assert.fail('unexpected isolated RPC '+operation);
 });
 let invalidValidation=false;
 t.mock.method(globalThis,'fetch',async()=>new Response(invalidValidation?'invalid JSON':'{"incidents":[]}'));
 const source:Source={...sourceDefinitions.find(item=>item.id==='official-status')!,enabled:true,validated:true,status:'healthy',collectionPolicy:'manual',effectiveIntervalMinutes:30};
 seed('sources',source);
 const input={sourceId:source.id,messageId:'revision-message',url:'https://status.openai.com/incidents/revision-message',text:'Codex service update: all systems are operating normally.',publishedAt:'2026-10-16T00:00:00Z',collectedAt:'2026-10-16T00:01:00Z',historical:false,provenance:'official' as const,textOrigin:'structured' as const,contextComplete:true,metadata:{category:'product' as const}};
 const created=await createEvidence(input);
 assert.equal(created.created,true);assert.ok(revision());assert.equal(revisionWrites,1);
 let before=revision();
 const duplicate=await createEvidence({...input,collectedAt:'2026-10-16T00:02:00Z'});
 assert.equal(duplicate.created,false);assert.equal(revision(),before);assert.equal(revisionWrites,1);
 await previewCandidate(created.candidate!.id,created.candidate!.version);
 assert.equal(revision(),before,'read-only preview has no revision write');
 rejectCommit=true;
 await assert.rejects(createEvidence({...input,messageId:'rejected-message',text:'Changed original text.'}),/isolated commit rejection/);
 rejectCommit=false;
 assert.equal(revision(),before);assert.equal(rows('evidence').length,1,'failed transaction preserves both business data and revision');
 await createEvidence({...input,text:'Codex service update: a newer original revision.'});
 assert.notEqual(revision(),before,'a new evidence version wakes prediction');before=revision();

 const configured=await executeCommand('source.save',{id:source.id,version:source.version,name:source.name},'fixture') as Source;
 assert.equal(revision(),before,'name-only save preserves prediction inputs');
 await assert.rejects(executeCommand('source.save',{id:source.id,version:configured.version,url:'https://invalid.example'},'fixture'));
 assert.equal(revision(),before,'rejected configuration does not mark revision');
 await validateSource(source.id,'fixture');assert.equal(revision(),before,'already valid healthy source validation is unchanged');
 const healthy=get('sources',source.id) as Source;seed('sources',{...healthy,validated:false,status:'failed'});
 await validateSource(source.id,'fixture');assert.notEqual(revision(),before,'successful validation restoring availability wakes prediction');before=revision();
 invalidValidation=true;await assert.rejects(validateSource(source.id,'fixture'));invalidValidation=false;
 assert.equal(revision(),before,'failed validation does not commit a success revision');
 await validateSource(source.id,'fixture');assert.notEqual(revision(),before);before=revision();
 let current=get('sources',source.id) as Source;
 const disabled=await executeCommand('source.save',{id:source.id,version:current.version,enabled:false},'fixture') as Source;
 assert.notEqual(revision(),before,'a real source availability change wakes prediction');before=revision();
 await executeCommand('source.save',{id:source.id,version:disabled.version,enabled:false},'fixture');
 assert.equal(revision(),before,'same disabled state does not repeatedly wake prediction');

 current=get('sources',source.id) as Source;seed('sources',{...current,enabled:true,status:'healthy'});
 const content:DraftContent={title:'官方服务动态',summary:'官方来源公开的服务状态记录。',translation:input.text,category:'product',publicationMode:'news_only',contentOrigin:'template',actions:[],evidenceIds:[created.evidence.id]};
 const candidate:Candidate={...created.candidate!,content,status:'pending',version:1,humanEdited:false};seed('candidates',candidate);
 const publication=await publishCandidate(candidate.id,candidate.version,'fixture','核对服务动态');
 assert.notEqual(revision(),before,'successful publication and revision commit together');before=revision();
 const published=get('candidates',candidate.id) as Candidate;
 const retained=await publishCandidate(candidate.id,published.version,'worker','相同内容重新检查',true);
 assert.equal(retained.id,publication.id);assert.equal(revision(),before,'unchanged early-return publication does not add a revision');
 const stored=get('candidates',candidate.id) as Candidate;
 await assert.rejects(publishCandidate(candidate.id,stored.version,'fixture','重复人工发布'));
 assert.equal(revision(),before,'rejected duplicate publication has no revision');
});
