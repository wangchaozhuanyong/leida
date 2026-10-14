import { config } from 'dotenv';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CloudbaseRpc, CloudbaseRpcError } from '../src/server/cloudbase/rpc';
import {createCloudbasePublicReader} from '../src/server/cloudbase/public-read';
import type {PublicReadOptions} from '../src/lib/public-read';

const qa=fileURLToPath(new URL('../../../outputs/implementation-qa/cloud-continuation-20261013/',import.meta.url));
const configPath=fileURLToPath(new URL('../.env.cloudbase-validation.local',import.meta.url));
config({path:configPath,quiet:true});
const env=process.env.CLOUDBASE_TEST_ENV_ID??'',key=process.env.CLOUDBASE_TEST_API_KEY??'';
const checks:{name:string;passed:boolean}[]=[];
let status='blocked',reason='missing-human-owned-backend-credential';
try{
  if(env!=='leida-test-d9gm85m7oe7b838d6'||!key||key.startsWith('replace-'))throw new CloudbaseRpcError('configuration');
  const rpc=new CloudbaseRpc(env,key);
  // Read only: never persist or print the private rows returned by the adapter.
  const snapshot=await rpc.call<{fingerprint:string;records:Record<string,unknown[]>}>('radar_cb_auth_snapshot');
  if(!/^[a-f0-9]{32}$/.test(snapshot.fingerprint)||!['user','account','session','verification'].every(model=>Array.isArray(snapshot.records?.[model])))throw new CloudbaseRpcError('response');
  checks.push({name:'actual_backend_snapshot_contract',passed:true});
  // Empty delta only: validate real RPC argument binding and transaction gate.
  if(await rpc.call('radar_cb_auth_commit',{p_expected_fingerprint:snapshot.fingerprint,p_changes:[]})!==true)throw new CloudbaseRpcError('response');
  checks.push({name:'empty_atomic_commit_contract',passed:true});
  try{await rpc.call('radar_cb_auth_commit',{p_expected_fingerprint:'0'.repeat(32),p_changes:[]});throw new CloudbaseRpcError('response');}
  catch(error){if(!(error instanceof CloudbaseRpcError)||error.kind!=='conflict')throw error;}
  checks.push({name:'actual_snapshot_conflict_rejected',passed:true});
  for(const operation of ['radar_cb_auth_snapshot','radar_cb_auth_commit','radar_cb_claim_job','radar_cb_finish_job']){
    const response=await fetch(`https://${env}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/${operation}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(8000)});
    if(response.ok)throw new CloudbaseRpcError('response');
    await response.body?.cancel();checks.push({name:`unauthenticated_${operation}_rejected`,passed:true});
  }
  const publicReader=createCloudbasePublicReader(rpc);
  const version=await publicReader.version();if(!/^[a-f0-9]{24}$/.test(version.version)||!/^[a-f0-9]{24}$/.test(version.contentVersion))throw new CloudbaseRpcError('response');
  checks.push({name:'actual_public_light_version_contract',passed:true});
  const scopes:PublicReadOptions[]=[{view:'home'},{view:'history',filter:'all'},{view:'news',filter:'all'},{view:'detail',entity:'publications',id:'qa-missing-publication'},{view:'activity',id:'qa-missing-activity',day:1},{view:'notices'},{view:'methodology'},{view:'state'},{view:'calendar'}];
  for(const scope of scopes){const result=await publicReader.read(scope);if(!result.version||!Array.isArray(result.data.publications))throw new CloudbaseRpcError('response');checks.push({name:`actual_public_${scope.view}_contract`,passed:true});}
  if(!Array.isArray((await publicReader.legacy()).publications))throw new CloudbaseRpcError('response');checks.push({name:'actual_legacy_public_contract',passed:true});
  if(await publicReader.snapshot('forecast_snapshot_'+'f'.repeat(64))!==undefined)throw new CloudbaseRpcError('response');checks.push({name:'actual_missing_fixed_snapshot_contract',passed:true});
  for(const operation of ['radar_cb_public_version','radar_cb_public_bundle','radar_cb_forecast_snapshot']){
    const response=await fetch(`https://${env}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/${operation}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(8000)});
    if(response.ok)throw new CloudbaseRpcError('response');await response.body?.cancel();checks.push({name:`unauthenticated_${operation}_rejected`,passed:true});
  }
  if(process.argv.includes('--accounting')){
    if(await rpc.call('radar_cb_owner_exists')!==false)throw new CloudbaseRpcError('response');
    checks.push({name:'actual_no_administrator_created',passed:true});
    const usage=await rpc.call<{calls:number;cost:number}>('radar_cb_ai_summary');
    if(usage.calls!==0||usage.cost!==0)throw new CloudbaseRpcError('response');
    checks.push({name:'actual_empty_ai_summary_contract',passed:true});
    if(await rpc.call('radar_cb_ai_reserve',{p_id:'qa-live-disabled-no-provider',p_version:1,p_input_bound:1})!=='configuration')throw new CloudbaseRpcError('response');
    checks.push({name:'actual_unconfigured_ai_reservation_blocked',passed:true});
    if(await rpc.call('radar_cb_ai_finish',{p_id:'qa-live-missing-no-provider',p_status:'failed',p_input_tokens:null,p_output_tokens:null})!=='missing')throw new CloudbaseRpcError('response');
    checks.push({name:'actual_missing_ai_ledger_rejected',passed:true});
    for(const operation of ['radar_cb_owner_exists','radar_cb_ai_summary','radar_cb_ai_reserve','radar_cb_ai_finish']){
      const response=await fetch(`https://${env}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/${operation}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(8000)});
      if(response.ok)throw new CloudbaseRpcError('response');await response.body?.cancel();checks.push({name:`unauthenticated_${operation}_rejected`,passed:true});
    }
  }
  if(process.argv.includes('--initialized')){
    if(process.argv.includes('--business-writes'))throw new CloudbaseRpcError('configuration');
    const read=async(table:string)=>{
      const page=await rpc.call<{fingerprint:string;rows:{id:string;payload:Record<string,unknown>}[];more:boolean}>('radar_cb_store_read',{p_table:table,p_after:null,p_id:null});
      if(!/^[a-f0-9]{32}$/.test(page.fingerprint)||!Array.isArray(page.rows)||page.more!==false)throw new CloudbaseRpcError('response');
      return page.rows;
    };
    const sources=await read('sources');
    if(sources.length!==6||sources.some(row=>row.payload.enabled!==false))throw new CloudbaseRpcError('response');
    checks.push({name:'actual_six_disabled_sources_initialized',passed:true});
    const settings=await read('settings'),ai=settings.find(row=>row.id==='ai')?.payload;
    if(settings.length!==2||!settings.some(row=>row.id==='site')||!ai||ai.enabled!==false||ai.dailyCallLimit!==0||ai.dailyBudget!==0||ai.hasKey!==false||ai.encryptedKey)throw new CloudbaseRpcError('response');
    checks.push({name:'actual_site_and_disabled_zero_budget_ai_initialized',passed:true});
    const activities=await read('activities'),activity=activities[0]?.payload;
    if(activities.length!==1||activities[0]?.id!=='challenge-28'||!Array.isArray(activity?.items)||activity.items.length!==0)throw new CloudbaseRpcError('response');
    checks.push({name:'actual_empty_activity_configuration_initialized',passed:true});
    for(const table of ['evidence','candidates','events','articles','publications','jobs','notices','audits','wechat_readers','wechat_grants','wechat_deliveries','forecast_cases','forecast_snapshots','forecast_outcomes']){
      if((await read(table)).length!==0)throw new CloudbaseRpcError('response');
      checks.push({name:'actual_no_business_import_'+table,passed:true});
    }
    if(Object.values(snapshot.records).some(rows=>rows.length!==0))throw new CloudbaseRpcError('response');
    checks.push({name:'actual_authentication_tables_remain_empty',passed:true});
  }
  if(process.argv.includes('--business-writes')){
    const expected:Record<string,string>={};
    for(const table of ['evidence','candidates','events','articles','publications','sources','jobs','notices','audits','activities','settings','wechat_readers','wechat_grants','wechat_deliveries','forecast_cases','forecast_snapshots','forecast_outcomes']){
      const value=await rpc.call<{fingerprint:string;rows:unknown[];more:boolean}>('radar_cb_store_read',{p_table:table,p_after:null,p_id:null});
      if(!/^[a-f0-9]{32}$/.test(value.fingerprint)||!Array.isArray(value.rows)||value.rows.length!==0||value.more!==false)throw new CloudbaseRpcError('response');
      expected[table]=value.fingerprint;checks.push({name:'actual_empty_business_table_'+table,passed:true});
    }
    if(await rpc.call('radar_cb_store_commit',{p_expected:expected,p_changes:[],p_lease:null})!==true)throw new CloudbaseRpcError('response');
    checks.push({name:'actual_business_empty_atomic_commit',passed:true});
    try{await rpc.call('radar_cb_store_commit',{p_expected:{settings:'f'.repeat(32)},p_changes:[],p_lease:null});throw new CloudbaseRpcError('response');}catch(error){if(!(error instanceof CloudbaseRpcError)||error.kind!=='conflict')throw error;}
    checks.push({name:'actual_business_stale_readset_rejected',passed:true});
    if(await rpc.call('radar_cb_store_lease',{p_name:'radar_auto_publication',p_owner:'00000000-0000-4000-8000-000000000000',p_release:true})!==null)throw new CloudbaseRpcError('response');
    checks.push({name:'actual_business_empty_lease_release_contract',passed:true});
    for(const operation of ['radar_cb_store_read','radar_cb_store_commit','radar_cb_store_lease']){
      const response=await fetch(`https://${env}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/${operation}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(8000)});
      if(response.ok)throw new CloudbaseRpcError('response');await response.body?.cancel();checks.push({name:`unauthenticated_${operation}_rejected`,passed:true});
    }
  }
  status='passed';reason='restricted-live-interface-gates-passed';
}catch(error){if(error instanceof CloudbaseRpcError){reason=error.kind==='configuration'?'missing-human-owned-backend-credential':`live-gate-${error.kind}`;status=error.kind==='configuration'?'blocked':'failed';}else{status='failed';reason='live-gate-unavailable';}process.exitCode=status==='blocked'?2:1;
}finally{
  const at=new Date().toISOString();
  const report={at,status,reason,checks,accountingChecked:process.argv.includes('--accounting'),initializedDefaultsChecked:process.argv.includes('--initialized'),credentialValuesRecorded:false,businessMutations:false,providerCalls:false,actualCloudLoginTested:false,fullCloudApplicationAccepted:false};
  await writeFile(qa+'cloudbase-live-gate-'+at.replace(/[:.]/g,'-')+'.json',JSON.stringify(report,null,2)+'\n');
  console.log(status==='passed'?'真实CloudBase受控接口检查通过；完整业务与云端登录仍需验收':status==='blocked'?'等待用户在本机配置服务端调用凭证；未发出云端请求':'真实CloudBase接口门槛未通过；未输出凭证或响应正文');
}
