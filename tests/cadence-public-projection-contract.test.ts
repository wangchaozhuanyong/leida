import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../scripts/migrations/cloudbase-public-read.sql',import.meta.url),'utf8');
const upgrade=readFileSync(new URL('../scripts/migrations/cloudbase-cadence-public-projection-upgrade.sql',import.meta.url),'utf8');
const uncomment=(sql:string)=>sql.replace(/--[^\n]*/g,'');
const body=(sql:string,name:string)=>sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\$fn\\$;`))?.[0].replace('CREATE OR REPLACE FUNCTION','CREATE FUNCTION');

test('CloudBase升级候选仅替换两项已有只读投影，不更改表、数据、权限或其他函数',()=>{
 const sql=uncomment(upgrade);
 assert.deepEqual([...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)/g)].map(m=>m[1]),['radar_cb_public_version','radar_cb_public_bundle']);
 assert.equal(/\b(?:ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/i.test(sql),false);
 assert.equal(/CREATE\s+(?:TABLE|INDEX|POLICY|ROLE|SCHEMA)/i.test(sql),false);
 assert.match(sql,/to_regprocedure\('public\.radar_cb_public_version\(\)'\)/);
 assert.match(sql,/to_regprocedure\('public\.radar_cb_public_bundle\(jsonb,text\)'\)/);
 assert.match(sql,/^\s*BEGIN;/);assert.match(sql,/COMMIT;\s*$/);
 for(const name of ['radar_cb_public_version','radar_cb_public_bundle']){
  const value=body(upgrade,name);assert.ok(value);assert.equal(value,body(source,name),'升级与新安装的函数体必须一致');
  assert.match(value,/LANGUAGE plpgsql STABLE SECURITY INVOKER/);
  assert.match(value,/SET search_path=pg_catalog SET timezone='UTC'/);
  assert.match(value,/request\.jwt\.claims/);assert.match(value,/'service_role'/);
 }
 assert.equal(body(upgrade,'radar_cb_forecast_snapshot'),undefined,'固定历史记录读取函数不需要升级');
});

test('CloudBase home与版本投影保留双目标及评估，精简快照不裁掉概率时间和类型',()=>{
 const version=body(upgrade,'radar_cb_public_version')!,bundle=body(upgrade,'radar_cb_public_bundle')!;
 for(const value of [version,bundle]){
  assert.match(value,/'cadenceSnapshotIds'/);assert.match(value,/'cadenceEvaluationByKind'/);
  assert.match(value,/jsonb_each_text\(coalesce\(payload->'cadenceSnapshotIds'/);
 }
 const projection=bundle.match(/snapshots:=\([\s\S]*?FROM public\.radar_forecast_snapshots/)?.[0];assert.ok(projection);
 for(const field of ['target','modelVersion','generatedAt','validUntil','p24','p48','rawP24','rawP48','sampleCount','eligibleCount'])assert.equal(new RegExp(`-'${field}'`).test(projection),false,`${field}必须保留在home精简快照`);
 assert.match(projection,/'summaryOnly',true/);assert.match(projection,/'observations','\[\]'::jsonb/);
});
