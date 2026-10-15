import {config} from 'dotenv';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {CloudbaseRpc,CloudbaseRpcError} from '../src/server/cloudbase/rpc';
import {cloudbaseStore} from '../src/server/cloudbase/store';
import type {Table} from '../src/db';
import type {Evidence} from '../src/lib/types';

const output=fileURLToPath(new URL('../outputs/month-replay-20261016/',import.meta.url));
const credentialPath=fileURLToPath(new URL('../../public-read-optimization-20261013/.env.cloudbase-validation.local',import.meta.url));
config({path:credentialPath,quiet:true});
const rpc=new CloudbaseRpc(process.env.CLOUDBASE_TEST_ENV_ID??'',process.env.CLOUDBASE_TEST_API_KEY??'');
const store=cloudbaseStore(rpc);
const report:Record<string,unknown>={checkedAt:new Date().toISOString(),readOnly:true};
await mkdir(output,{recursive:true});
const business:Table[]=['evidence','candidates','events','articles','publications','notices','activities','forecast_cases','forecast_snapshots','forecast_outcomes'];
const records:Record<string,unknown[]>={};
if(process.argv.includes('--health')){
  const worker=await store.one<Record<string,unknown>>('settings','worker_runtime');
  const response=await fetch('https://express-l98p-326351-12-1503749333.sh.run.tcloudbase.com/api/v1/health',{redirect:'error',signal:AbortSignal.timeout(15000)});
  const body=await response.json();
  const health={checkedAt:new Date().toISOString(),readOnly:true,httpStatus:response.status,database:body.data?.database,serverTime:body.data?.serverTime,sources:body.data?.sources,worker:worker?{heartbeatAt:worker.heartbeatAt,lastJobAt:worker.lastJobAt,hasError:!!worker.error}:null,productionMutations:false};
  await writeFile(output+'live-health-final.json',JSON.stringify(health,null,2)+'\n');console.log(JSON.stringify(health));process.exit(response.ok?0:1);
}
try{
  for(const table of [...business,'sources','settings','jobs','audits','wechat_readers','wechat_grants','wechat_deliveries'] as Table[]){
    let rows:Record<string,unknown>[];
    try{rows=await store.list<Record<string,unknown>>(table);}catch(error){
      if(business.includes(table))throw error;
      report[table]={status:'not_measured',reason:error instanceof CloudbaseRpcError?error.diagnosticCode:'READ_FAILED'};continue;
    }
    report[table]={count:rows.length};
    if(business.includes(table))records[table]=rows;
    if(table==='sources')report.sources=rows.map(row=>({id:row.id,enabled:row.enabled,validated:row.validated,status:row.status,lastSuccessAt:row.lastSuccessAt,nextRunAt:row.nextRunAt}));
    if(table==='settings'){
      report.settingIds=rows.map(row=>row.id).filter(id=>['site','ai','wechat','forecast_runtime','worker_runtime'].includes(String(id)));
      const worker=rows.find(row=>row.id==='worker_runtime');
      report.worker=worker?{heartbeatAt:worker.heartbeatAt,lastJobAt:worker.lastJobAt,error:!!worker.error}:null;
      const ai=rows.find(row=>row.id==='ai');report.ai={enabled:!!ai?.enabled};
      const wx=rows.find(row=>row.id==='wechat');report.wechat=wx?{enabled:wx.enabled,hasSecret:wx.hasSecret,hasTemplate:!!wx.templateId}:null;
    }
  }
  const evidence=records.evidence as Evidence[];
  report.evidenceRange={first:evidence.map(e=>e.publishedAt).sort()[0],last:evidence.map(e=>e.publishedAt).sort().at(-1)};
  // Only existing public business material; no settings, credentials, readers,
  // sessions, grants, deliveries, or arbitrary audit payloads are exported.
  await writeFile(output+'existing-business-snapshot.json',JSON.stringify({capturedAt:report.checkedAt,consistentWholeDatabaseSnapshot:false,records},null,2)+'\n',{mode:0o600});
  report.snapshot='existing-business-snapshot.json';
  report.status='passed';
}catch(error){report.status='failed';report.reason=error instanceof CloudbaseRpcError?error.diagnosticCode:'READ_FAILED';process.exitCode=1;}
await writeFile(output+'preflight.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
