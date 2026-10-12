// Approved additive local migration, with before/after record checks. No forecast samples are inserted.
import {existsSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pool,transaction,type Client} from '../src/db';
import {applyForecastMigration} from './migrations/forecast';
import {getPublicForecast} from '../src/server/forecast';
const root=resolve(import.meta.dirname,'..'),path=resolve(root,'outputs/implementation-qa/forecast-local-migration-20261010.json');
const configured=new URL(process.env.DATABASE_URL!);
if(configured.hostname!=='127.0.0.1'||configured.port!=='55489'||configured.pathname!=='/radar')throw new Error('只允许本项目本机业务库');
if(existsSync(path))throw new Error('已有同名迁移验收，保留后再执行');
async function records(c:Client){const result:Record<string,unknown>={};for(const table of ['evidence','candidates','events','articles','publications','notices','audits'])result[table]=(await c.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(id || payload::text,'|' ORDER BY id),'')) AS hash FROM radar_${table}`)).rows[0];return result;}
try {
 const report=await transaction(async c=>{
  if((await c.query('SELECT current_database() AS name')).rows[0]?.name!=='radar')throw new Error('本机数据库身份不一致');
  const before=await records(c);await applyForecastMigration(c);const after=await records(c);
  if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('原业务记录发生变化，迁移不提交');
  const forecast=await getPublicForecast(c);
  return {status:'passed',localOnly:true,before,after,existingRecordsUnchanged:true,predictionStatus:forecast.status,casesAfterMigration:forecast.cases.length,syntheticFixtureWrites:false,checkedAt:new Date().toISOString()};
 });
 writeFileSync(path,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({status:report.status,existingRecordsUnchanged:report.existingRecordsUnchanged,predictionStatus:report.predictionStatus,cases:report.casesAfterMigration}));
}finally{await pool.end();}
