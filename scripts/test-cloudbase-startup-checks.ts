import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { access, cp, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type pg from 'pg';

const exec=promisify(execFile);
type Pass=(name:string,detail:string)=>void;
export async function testCloudbaseStartup(database:pg.Pool,gateway:string,token:string,pass:Pass){
  const candidate=fileURLToPath(new URL('../',import.meta.url));
  const build=fileURLToPath(new URL('../../../outputs/implementation-qa/cloud-continuation-20261013/cloudbase-complete-build-20261014/',import.meta.url));
  await access(build+'.next/standalone/server.js');
  await cp(build+'public',build+'.next/standalone/public',{recursive:true,errorOnExist:false});
  await cp(build+'.next/static',build+'.next/standalone/.next/static',{recursive:true,errorOnExist:false});
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const address=probe.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const base=`http://127.0.0.1:${address.port}`;
  const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'production',PORT:String(address.port),HOSTNAME:'127.0.0.1',RADAR_STORAGE_BACKEND:'cloudbase',RADAR_PUBLIC_READ_BACKEND:'cloudbase',CLOUDBASE_ENV_ID:'leida-test-qa',CLOUDBASE_API_KEY:token,BETTER_AUTH_URL:base,BETTER_AUTH_SECRET:randomBytes(40).toString('base64url'),ENCRYPTION_KEY:randomBytes(32).toString('base64'),PGHOST:'127.0.0.1',PGPORT:'1',NEXT_TELEMETRY_DISABLED:'1',RADAR_QA_GATEWAY:gateway,NODE_OPTIONS:'--import='+pathToFileURL(candidate+'scripts/cloudbase-qa-preload.mjs').href};
  delete env.DATABASE_URL;
  const script=(path:string,args:string[]=[])=>exec(process.execPath,['--import','tsx',path,...args],{cwd:build,env,timeout:60000,maxBuffer:256*1024});
  await script('scripts/bootstrap.ts');
  const initial=(await database.query("SELECT (SELECT count(*)::int FROM radar_evidence) AS evidence,(SELECT count(*)::int FROM radar_publications) AS publications,(SELECT count(*)::int FROM radar_sources WHERE payload->>'enabled'='true') AS enabled,(SELECT count(*)::int FROM radar_sources) AS sources,(SELECT count(*)::int FROM radar_settings) AS settings")).rows[0];
  assert.equal(initial.evidence,0);assert.equal(initial.publications,0);assert.equal(initial.enabled,0);assert.equal(initial.sources,6);
  await database.query("UPDATE radar_settings SET payload=jsonb_set(payload,'{name}','\"Retained QA site\"') WHERE id='site'");await script('scripts/bootstrap.ts');assert.equal((await database.query("SELECT payload->>'name' AS name FROM radar_settings WHERE id='site'")).rows[0].name,'Retained QA site');
  pass('full_cloud_bootstrap_without_native_db','actual bootstrap command with no DATABASE_URL inserted only disabled defaults, no history, and preserved existing settings on repeat');
  const app=spawn(process.execPath,['scripts/runtime-entrypoint.mjs','--container','app'],{cwd:build,env,stdio:['ignore','pipe','pipe']});
  let exited=false;app.on('exit',()=>{exited=true;});app.stdout.resume();app.stderr.resume();
  let phase='startup';
  try{
    let ready=false;for(let attempt=0;attempt<100;attempt++){if(exited)break;try{const result=await fetch(base+'/api/setup',{signal:AbortSignal.timeout(1000)});if(result.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,200));}assert.ok(ready,'standalone server must become ready');
    assert.deepEqual(await (await fetch(base+'/api/setup')).json(),{initialized:false});assert.equal((await fetch(base+'/api/admin/data')).status,401);
    assert.equal((await fetch(base+'/api/v1/version?light=1')).status,200);assert.equal((await fetch(base+'/')).status,200);
    pass('full_standalone_cloud_startup','actual compiled Next standalone starts through container entrypoint; public/initialization APIs work while native PostgreSQL is unreachable');
    phase='local-only-setup';
    const password=randomBytes(24).toString('base64url');
    const input=(index:number)=>({email:`qa-owner-${index}@radar.invalid`,name:'QA Owner',password});
    const post=(data:unknown,origin=base)=>fetch(base+'/api/setup',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
    assert.equal((await post(input(0),'https://untrusted.invalid')).status,403);assert.equal((await post({email:'invalid',password:'short'})).status,400);
    assert.equal((await database.query('SELECT count(*)::int AS count FROM public."user"')).rows[0].count,0);
    const attempts=await Promise.all([post(input(1)),post(input(2))]);const winner=attempts.findIndex(response=>response.status===200);assert.ok(winner>=0);assert.equal(attempts.filter(response=>response.status===200).length,1);assert.equal(attempts[1-winner].status,409);
    const counts=(await database.query('SELECT (SELECT count(*)::int FROM public."user") AS users,(SELECT count(*)::int FROM public.account) AS accounts')).rows[0];assert.deepEqual(counts,{users:1,accounts:1});
    assert.deepEqual(await (await fetch(base+'/api/setup')).json(),{initialized:true});assert.equal((await post(input(3))).status,409);
    pass('full_first_owner_atomic_and_origin_gate','actual setup endpoint rejected wrong origin/invalid form; simultaneous first-owner attempts created exactly one user/account and blocked further setup');
    phase='login-and-admin';
    const request=(path:string,data:unknown,headers:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
    assert.equal((await request('/api/auth/sign-in/email',{email:input(winner+1).email,password:randomBytes(24).toString('base64url')})).status,401);
    const signin=await request('/api/auth/sign-in/email',input(winner+1));assert.equal(signin.status,200);const cookie=signin.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');assert.ok(cookie);
    const data=await fetch(base+'/api/admin/data',{headers:{Cookie:cookie}});assert.equal(data.status,200);const admin=await data.json();assert.equal(admin.data.ai.callsToday,0);assert.equal(admin.data.ai.estimatedCostToday,0);assert.equal(admin.data.site.name,'Retained QA site');
    assert.equal((await fetch(base+'/admin',{headers:{Cookie:cookie}})).status,200);
    assert.equal((await request('/api/auth/sign-up/email',input(4))).status,400);assert.equal((await request('/api/auth/sign-out',{}, {Cookie:cookie,Origin:'https://untrusted.invalid'})).status,403);
    await request('/api/auth/sign-out',{}, {Cookie:cookie});assert.equal((await fetch(base+'/api/admin/data',{headers:{Cookie:cookie}})).status,401);
    pass('full_cloud_login_admin_and_revocation','actual compiled auth handlers verify password/session, render authenticated admin with cloud AI totals, deny public signup/foreign origin and revoke session on logout');
    phase='worker-and-health';await script('scripts/worker.ts',['--once']);await script('scripts/runtime-health.ts',['--worker','--quiet']);
    assert.equal((await database.query("SELECT count(*)::int AS count FROM radar_settings WHERE id='worker_runtime'")).rows[0].count,1);
    const evidence=(await database.query('SELECT count(*)::int AS count FROM radar_evidence')).rows[0].count;assert.equal(evidence,0);
    pass('full_cloud_worker_and_health_without_native_db','actual worker once and worker health commands passed with no native connection and no evidence/provider calls');
    phase='native-command-safety';
    for(const native of ['scripts/migrate.ts','scripts/auth-migrate.ts','scripts/seed.ts'])await assert.rejects(script(native));
    assert.equal((await database.query('SELECT count(*)::int AS count FROM radar_evidence')).rows[0].count,0);
    pass('cloud_native_migration_and_history_guard','native migrations/history-import commands refuse cloud mode; no silent connection to another database');
  }catch{throw new Error('full-cloud-startup-check-failed-'+phase);}
  finally{if(!exited){app.kill('SIGTERM');await new Promise<void>(resolve=>{app.once('exit',()=>resolve());setTimeout(()=>{if(!exited)app.kill('SIGKILL');resolve();},5000).unref();});}}
}
