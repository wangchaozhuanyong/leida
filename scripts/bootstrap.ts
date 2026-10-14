import 'dotenv/config';
import {spawnSync} from 'node:child_process';
const mode=process.env.RADAR_STORAGE_BACKEND??'native';
try{if(mode==='cloudbase'){
  const {configuredStorageRpc}=await import('../src/server/cloudbase/storage-config');const rpc=configuredStorageRpc()!;
  // Presence and contracts are checked before any configuration insert.
  await rpc.call('radar_cb_auth_snapshot');await rpc.call('radar_cb_owner_exists');await rpc.call('radar_cb_ai_summary');
  for(const table of ['evidence','candidates','events','articles','publications','sources','jobs','notices','audits','activities','settings','wechat_readers','wechat_grants','wechat_deliveries','forecast_cases','forecast_snapshots','forecast_outcomes'])await rpc.call('radar_cb_store_read',{p_table:table,p_after:null,p_id:'bootstrap-missing-probe'});
  const {initializeRadarDefaults}=await import('../src/server/initialize');await initializeRadarDefaults();
  console.log('云数据库初始配置已就绪；来源关闭，未导入历史。请在本机首次设置站长账号。');
}else if(mode==='native'){
for(const script of ['scripts/migrate.ts','scripts/auth-migrate.ts','scripts/migrations/forecast.ts','scripts/seed.ts']){const r=spawnSync('pnpm',['exec','tsx',script,...(script.endsWith('/forecast.ts')?['--apply']:[])],{stdio:'inherit',cwd:process.cwd()});if(r.status!==0)process.exit(r.status||1)}
console.log('本地数据库与历史导入已就绪。启动网站后，请在 /admin/setup 自行设置站长账号。');
}else{console.error('数据库模式无效，初始化未执行。');process.exitCode=1;}}catch{console.error('数据库初始化暂不可用；请检查模式及已安装的接口，未输出凭证。');process.exitCode=1;}
