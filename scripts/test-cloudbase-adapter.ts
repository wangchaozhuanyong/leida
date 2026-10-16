import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {resolve} from 'node:path';
import pg from 'pg';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { cloudbaseAuthAdapter } from '../src/server/cloudbase/auth-adapter';
import { cloudbaseTasks } from '../src/server/cloudbase/tasks';
import { CloudbaseRpc, CloudbaseRpcError } from '../src/server/cloudbase/rpc';
import type { Job } from '../src/lib/types';

const exec=promisify(execFile);
const outputArgument=process.argv.find(arg=>arg.startsWith('--output='))?.slice(9);
const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const qa=outputArgument?resolve(projectRoot,outputArgument)+'/':fileURLToPath(new URL('../../../outputs/implementation-qa/cloud-continuation-20261013/',import.meta.url));
if(outputArgument&&!qa.startsWith(projectRoot+'outputs/'))throw new Error('测试输出必须位于本项目 outputs 内');
await access(qa);
const runId=new Date().toISOString().replace(/[:.]/g,'-');
const name=`leida-cloudbase-adapter-${process.pid}`,label='cloudbase-adapter-20261014';
const token=randomBytes(32).toString('hex'),secret=randomBytes(40).toString('hex');
const password=randomBytes(24).toString('base64url');
const checks:{name:string;status:'passed';detail:string}[]=[];
const pass=(name:string,detail:string)=>{checks.push({name,status:'passed',detail});console.log(`PASS ${name}`);};
const command=(...args:string[])=>exec('docker',args,{timeout:30000,maxBuffer:256*1024});
const sqlSource=await readFile(new URL('./migrations/cloudbase-rpc.sql',import.meta.url),'utf8');
const inputs=['src/server/cloudbase/rpc.ts','src/server/cloudbase/auth-adapter.ts','src/server/cloudbase/tasks.ts','src/server/cloudbase/public-read.ts','src/server/cloudbase/public-config.ts','src/server/public-read.ts','src/server/public-version.ts','src/server/service.ts','src/server/forecast.ts','src/server/reset-cadence-runtime.ts','src/server/auth.ts','src/db/index.ts','scripts/migrations/cloudbase-rpc.sql','scripts/migrations/cloudbase-permissions.sql','scripts/migrations/cloudbase-public-schema.sql','scripts/migrations/cloudbase-public-read.sql','scripts/test-cloudbase-public-checks.ts','scripts/test-cloudbase-adapter.ts','scripts/test-cloudbase-live.ts','.env.example','pnpm-lock.yaml','src/server/cloudbase/store.ts','src/server/cloudbase/storage-config.ts','scripts/migrations/cloudbase-write-schema.sql','scripts/migrations/cloudbase-write-rpc.sql','scripts/test-cloudbase-write-checks.ts','src/server/worker.ts','src/server/wechat.ts','src/server/tibo-timeline.ts','src/server/ai.ts','README.md','scripts/cloudbase-write-rollback-probe.sql','scripts/migrations/cloudbase-accounting.sql','src/server/cloudbase/ai-usage.ts','src/server/initialize.ts','src/app/api/setup/route.ts','scripts/bootstrap.ts','scripts/runtime-health.ts','scripts/runtime-entrypoint.mjs','scripts/test-cloudbase-complete-checks.ts','scripts/test-cloudbase-startup-checks.ts','scripts/cloudbase-qa-preload.mjs','scripts/migrate.ts','scripts/auth-migrate.ts','scripts/seed.ts','scripts/migrations/forecast.ts','scripts/migrations/wechat.ts','scripts/cloudbase-accounting-rollback-probe.sql'];
async function fingerprints(){return Object.fromEntries(await Promise.all(inputs.map(async path=>[path,createHash('sha256').update(await readFile(new URL('../'+path,import.meta.url))).digest('hex')])));}
const sourceFingerprints=await fingerprints();
let networkCreated=false,containerCreated=false,pool:pg.Pool|undefined,appPool:pg.Pool|undefined,appProbePool:pg.Pool|undefined;
let phase='initialization',failure:unknown,outcome='failed',imageId='',version='';
let auth:ReturnType<typeof import('../src/server/auth').createAuth>|undefined;
let publicCalls=0;
const server=createServer(async(request,response)=>{
  try{
    let text='';for await(const chunk of request){text+=chunk;if(Buffer.byteLength(text)>2*1024*1024)throw new Error('request limit');}
    const path=new URL(request.url??'/', 'http://127.0.0.1').pathname;
    if(path.startsWith('/api/auth/')&&auth){
      const headers=new Headers();for(const [key,value] of Object.entries(request.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
      const input=new Request(`http://${request.headers.host}${request.url}`,{method:request.method,headers,...(request.method!=='GET'&&request.method!=='HEAD'?{body:text}:{})});
      const result=await auth.handler(input);response.statusCode=result.status;
      result.headers.forEach((value,key)=>{if(key!=='set-cookie')response.setHeader(key,value);});
      const cookies=result.headers.getSetCookie();if(cookies.length)response.setHeader('set-cookie',cookies);
      response.end(await result.text());return;
    }
    if(request.headers.authorization!==`Bearer ${token}`){response.writeHead(401,{'Content-Type':'application/json'});response.end('{}');return;}
    const params:Record<string,unknown>=JSON.parse(text||'{}');
    const operation=path.split('/').at(-1);
    const calls:Record<string,{sql:string;values:unknown[]}>= {
      radar_cb_auth_snapshot:{sql:'SELECT public.radar_cb_auth_snapshot() AS result',values:[]},
      radar_cb_auth_commit:{sql:'SELECT public.radar_cb_auth_commit($1,$2::jsonb) AS result',values:[params.p_expected_fingerprint,JSON.stringify(params.p_changes)]},
      radar_cb_claim_job:{sql:'SELECT public.radar_cb_claim_job() AS result',values:[]},
      radar_cb_finish_job:{sql:'SELECT public.radar_cb_finish_job($1,$2,$3,$4::jsonb) AS result',values:[params.p_id,params.p_lease_until,params.p_attempts,JSON.stringify(params.p_result)]},
      radar_cb_public_version:{sql:'SELECT public.radar_cb_public_version() AS result',values:[]},
      radar_cb_public_bundle:{sql:'SELECT public.radar_cb_public_bundle($1::jsonb,$2) AS result',values:[JSON.stringify(params.p_options),params.p_now]},
      radar_cb_forecast_snapshot:{sql:'SELECT public.radar_cb_forecast_snapshot($1) AS result',values:[params.p_id]},
      radar_cb_store_read:{sql:'SELECT public.radar_cb_store_read($1,$2,$3) AS result',values:[params.p_table,params.p_after,params.p_id]},
      radar_cb_store_commit:{sql:'SELECT public.radar_cb_store_commit($1::jsonb,$2::jsonb,$3::jsonb) AS result',values:[JSON.stringify(params.p_expected),JSON.stringify(params.p_changes),params.p_lease?JSON.stringify(params.p_lease):null]},
      radar_cb_store_lease:{sql:'SELECT public.radar_cb_store_lease($1,$2,$3) AS result',values:[params.p_name,params.p_owner,params.p_release]},
      radar_cb_owner_exists:{sql:'SELECT public.radar_cb_owner_exists() AS result',values:[]},
      radar_cb_ai_summary:{sql:'SELECT public.radar_cb_ai_summary() AS result',values:[]},
      radar_cb_ai_reserve:{sql:'SELECT public.radar_cb_ai_reserve($1,$2,$3) AS result',values:[params.p_id,params.p_version,params.p_input_bound]},
      radar_cb_ai_finish:{sql:'SELECT public.radar_cb_ai_finish($1,$2,$3,$4) AS result',values:[params.p_id,params.p_status,params.p_input_tokens,params.p_output_tokens]}
    };
    if(!operation||!calls[operation])throw new Error('unsupported operation');
    if(operation.startsWith('radar_cb_public_')||operation==='radar_cb_forecast_snapshot')publicCalls++;
    const role=request.headers['x-qa-role']==='anon'?'anon':'service_role';
    const client=await (request.headers['x-qa-database']==='complete-probe'?appProbePool!:pool!).connect();
    try{
      await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${role}`);
      await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({role})]);
      const result=await client.query(calls[operation].sql,calls[operation].values);
      await client.query('COMMIT');response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(result.rows[0].result));
    }catch(error){await client.query('ROLLBACK');const code=(error as {code?:string}).code;
      if(operation.startsWith('radar_cb_public_')||operation==='radar_cb_forecast_snapshot'||operation.startsWith('radar_cb_store_')){const message=error instanceof Error?error.message:'';console.error('PUBLIC_SQL_FAILURE',code??'unknown',/^(column reference "[A-Za-z_]+" is ambiguous|column "[A-Za-z_]+" does not exist|relation "[A-Za-z_]+" does not exist)$/.test(message)?message:'details suppressed');}
      response.writeHead(code==='42501'?403:code==='40001'||code==='23505'?409:500,{'Content-Type':'application/json'});
      response.end(JSON.stringify({code:/^[A-Z0-9]{5}$/.test(code??'')?code:'P0001'}));
    }finally{client.release();}
  }catch{response.writeHead(500,{'Content-Type':'application/json'});response.end('{}');}
});
try{
  phase='image-inspect';imageId=(await command('image','inspect','postgres:17-alpine','--format','{{.Id}}')).stdout.trim();
  // Default pools are exhausted on this host. This unused QA-only subnet was
  // checked against existing networks; Docker rejects collisions without edits.
  phase='network-create';await command('network','create','--subnet','10.252.94.0/28','--label',`leida-qa=${label}`,name);networkCreated=true;
  phase='container-run';await command('run','--detach','--name',name,'--label',`leida-qa=${label}`,'--network',name,'--publish','127.0.0.1::5432','--pull','never','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-alpine');containerCreated=true;
  phase='published-port';
  const port=(await command('port',name,'5432/tcp')).stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1];assert.ok(port,'QA database must be loopback-only');
  phase='database-ready';pool=new pg.Pool({host:'127.0.0.1',port:Number(port),user:'postgres',database:'postgres',max:20,connectionTimeoutMillis:1500});
  let ready=false;for(let i=0;i<20;i++){try{await pool.query('SELECT 1');ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,300));}}assert.ok(ready);
  version=(await pool.query("SELECT current_setting('server_version') AS version")).rows[0].version;
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  const baseURL=`http://127.0.0.1:${address.port}`;
  Object.assign(process.env,{DATABASE_URL:`postgresql://postgres@127.0.0.1:${port}/postgres`,BETTER_AUTH_URL:baseURL,BETTER_AUTH_SECRET:secret,NODE_ENV:'test'});
  phase='native-schema';
  const migrationAuth=betterAuth({database:pool,baseURL,secret,emailAndPassword:{enabled:true},logger:{disabled:true}});
  const {runMigrations}=await getMigrations(migrationAuth.options);await runMigrations();
  await pool.query('CREATE TABLE public.radar_jobs(id text PRIMARY KEY,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())');
  const dumped=(await command('exec',name,'pg_dump','-U','postgres','-d','postgres','--schema-only','--no-owner','--no-privileges','--no-comments','--no-security-labels','--no-tablespaces',...['user','account','session','verification','radar_jobs'].map(table=>`--table=public.${table}`))).stdout;
  const statements=dumped.split('\n').filter(line=>!line.startsWith('--')&&!line.startsWith('\\')&&!/^(?:SET |SELECT pg_catalog.set_config)/.test(line)).join('\n').split(';').map(value=>value.trim()).filter(Boolean);
  assert.ok(statements.length>5&&statements.every(value=>/^(?:CREATE TABLE public\.|ALTER TABLE (?:ONLY )?public\.|CREATE (?:UNIQUE )?INDEX )/.test(value)),'schema dump must contain only the five requested empty table definitions');
  const emptySchema='-- Generated from the current BetterAuth 1.7.7 native migration; no rows, secrets or ownership changes.\nDO LANGUAGE plpgsql $cb_empty$\nBEGIN\n'+statements.map((statement,index)=>`  EXECUTE $cb_ddl_${index}$${statement}$cb_ddl_${index}$;`).join('\n')+'\nEND;\n$cb_empty$;\n';
  await writeFile(qa+'cloudbase-empty-test-schema-20261014.sql',emptySchema);
  const permissions=await readFile(new URL('./migrations/cloudbase-permissions.sql',import.meta.url),'utf8');
  await pool.query(sqlSource);
  await pool.query("CREATE ROLE service_role NOLOGIN NOBYPASSRLS; CREATE ROLE anon NOLOGIN NOBYPASSRLS; CREATE ROLE authenticated NOLOGIN NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;");
  phase='empty-cloud-installation-candidate';
  await pool.query('CREATE DATABASE radar_cloudbase_schema_probe');
  const installPool=new pg.Pool({host:'127.0.0.1',port:Number(port),user:'postgres',database:'radar_cloudbase_schema_probe',max:2});
  try{
    await installPool.query(emptySchema);await installPool.query(sqlSource);await installPool.query(permissions);
    const installClient=await installPool.connect();try{await installClient.query('BEGIN');await installClient.query('SET LOCAL ROLE service_role');await installClient.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);const empty=(await installClient.query('SELECT public.radar_cb_auth_snapshot() AS result')).rows[0].result;assert.ok(Object.values(empty.records).every(rows=>Array.isArray(rows)&&rows.length===0));await installClient.query('COMMIT');}finally{installClient.release();}
    for(const source of ['cloudbase-public-schema.sql','cloudbase-public-read.sql','cloudbase-write-schema.sql','cloudbase-write-rpc.sql'])await installPool.query(await readFile(new URL('./migrations/'+source,import.meta.url),'utf8'));
    await installPool.query(await readFile(new URL('./cloudbase-write-rollback-probe.sql',import.meta.url),'utf8'));
    await installPool.query(await readFile(new URL('./migrations/cloudbase-accounting.sql',import.meta.url),'utf8'));await installPool.query(await readFile(new URL('./cloudbase-accounting-rollback-probe.sql',import.meta.url),'utf8'));
    pass('empty_accounting_rollback_probe','seven accounting SQL assertions passed and synthetic configuration/reservations left no rows');
    pass('empty_business_write_rollback_probe','six synthetic SQL probes passed and all settings/audit/job/lease rows rolled back in the empty disposable database');
    pass('empty_installation_and_minimum_permissions','generated empty schema, four functions and backend-only privileges applied successfully in a second disposable database');
  }finally{await installPool.end();}
  for(const table of ['user','account','session','verification','radar_jobs']){
    await pool.query(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`);
    await pool.query(`CREATE POLICY backend_probe ON public."${table}" TO service_role USING(true) WITH CHECK(true)`);
    await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON public."${table}" TO service_role`);
    // Anonymous SELECT deliberately has no matching policy: rows remain hidden.
    await pool.query(`GRANT SELECT ON public."${table}" TO anon`);
  }
  const transport:typeof fetch=(input,init)=>{const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);return fetch(baseURL+target.pathname,init);};
  const rpc=new CloudbaseRpc('leida-test-qa',token,transport);
  const {createAuth}=await import('../src/server/auth');appPool=(await import('../src/db')).pool;
  const factory=cloudbaseAuthAdapter(rpc);
  const bootstrap=createAuth(true,factory);const publicAuth=createAuth(false,factory);auth=publicAuth;
  const adapter=factory(publicAuth.options);
  phase='actual-betterauth-login';
  await bootstrap.api.signUpEmail({body:{email:'owner@radar.invalid',name:'QA owner',password}});
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM public."user"')).rows[0].count,1);
  const logged=await fetch(baseURL+'/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json',Origin:baseURL},body:JSON.stringify({email:'owner@radar.invalid',password})});
  assert.equal(logged.status,200);const cookie=logged.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');assert.ok(cookie);
  const session=await fetch(baseURL+'/api/auth/get-session',{headers:{Cookie:cookie}});
  assert.equal(session.status,200);assert.ok((await session.json()).user?.email==='owner@radar.invalid');
  const badPassword=await fetch(baseURL+'/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json',Origin:baseURL},body:JSON.stringify({email:'owner@radar.invalid',password:randomBytes(24).toString('hex')})});assert.equal(badPassword.status,401);
  const crossOrigin=await fetch(baseURL+'/api/auth/sign-out',{method:'POST',headers:{Cookie:cookie,Origin:'https://blocked.invalid','Content-Type':'application/json'},body:'{}'});assert.equal(crossOrigin.status,403);
  const signUp=await fetch(baseURL+'/api/auth/sign-up/email',{method:'POST',headers:{Origin:baseURL,'Content-Type':'application/json'},body:JSON.stringify({email:'other@radar.invalid',name:'blocked',password})});assert.equal(signUp.status,400);assert.equal((await signUp.json()).code,'EMAIL_PASSWORD_SIGN_UP_DISABLED');
  await fetch(baseURL+'/api/auth/sign-out',{method:'POST',headers:{Cookie:cookie,Origin:baseURL,'Content-Type':'application/json'},body:'{}'});
  const revoked=await fetch(baseURL+'/api/auth/get-session',{headers:{Cookie:cookie}});assert.ok(!await revoked.json());
  pass('actual_betterauth_login','existing hashing, password rejection, session read/revocation, same-origin checks and disabled public signup passed through actual HTTP handler');

  phase='expired-session';
  const renewed=await fetch(baseURL+'/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json',Origin:baseURL},body:JSON.stringify({email:'owner@radar.invalid',password})});assert.equal(renewed.status,200);
  const expiredCookie=renewed.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  await pool.query('UPDATE public.session SET "expiresAt"=now()-interval \'1 minute\'');
  const expired=await fetch(baseURL+'/api/auth/get-session',{headers:{Cookie:expiredCookie}});assert.ok(!await expired.json());
  pass('session_date_and_expiry','database timestamp conversion preserved expiry; an expired session did not authenticate');

  phase='auth-transaction-rollback';
  const countBefore=(await pool.query('SELECT count(*)::int AS count FROM public."user"')).rows[0].count;
  await assert.rejects(adapter.transaction(async trx=>{
    await trx.create({model:'user',data:{name:'rollback-one',email:'rollback@radar.invalid',emailVerified:false,createdAt:new Date(),updatedAt:new Date()}});
    await trx.create({model:'user',data:{name:'rollback-two',email:'rollback@radar.invalid',emailVerified:false,createdAt:new Date(),updatedAt:new Date()}});
  }));
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM public."user"')).rows[0].count,countBefore);
  pass('auth_atomic_rollback','native unique constraint failure after writes rolled back the whole RPC transaction');

  phase='auth-snapshot-conflict';
  await assert.rejects(adapter.transaction(async trx=>{
    await trx.create({model:'verification',data:{identifier:'rollback-probe',value:'non-secret-probe',expiresAt:new Date(Date.now()+60000),createdAt:new Date(),updatedAt:new Date()}});
    await pool!.query('UPDATE public."user" SET name=$1 WHERE email=$2',['concurrent native edit','owner@radar.invalid']);
  }),error=>error instanceof CloudbaseRpcError&&error.kind==='conflict');
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.verification WHERE identifier='rollback-probe'")).rows[0].count,0);
  assert.ok((await pool.query('SELECT name FROM public."user"')).rows[0].name==='concurrent native edit');
  pass('auth_snapshot_conflict','concurrent native edit preserved and all stale callback changes rejected');

  phase='single-use-auth-consumption';
  const expiry=new Date(Date.now()+60000);
  await adapter.create({model:'verification',data:{identifier:'consume-probe',value:'non-secret-probe',expiresAt:expiry,createdAt:new Date(),updatedAt:new Date()}});
  assert.equal(await adapter.count({model:'verification',where:[{field:'expiresAt',value:new Date(expiry.getTime())}]}),1);
  const consumed=await Promise.all(Array.from({length:20},()=>adapter.consumeOne({model:'verification',where:[{field:'identifier',value:'consume-probe'}]})));
  assert.equal(consumed.filter(Boolean).length,1);
  pass('single_use_credential','20 consumption attempts yielded exactly one committed winner');

  phase='nested-callback-savepoint';
  await adapter.transaction(async trx=>{
    await trx.create({model:'verification',data:{identifier:'outer-kept',value:'non-secret-probe',expiresAt:new Date(Date.now()+60000),createdAt:new Date(),updatedAt:new Date()}});
    const nested=trx as typeof adapter;
    await assert.rejects(nested.transaction(async inner=>{await inner.create({model:'verification',data:{identifier:'inner-rejected',value:'non-secret-probe',expiresAt:new Date(Date.now()+60000),createdAt:new Date(),updatedAt:new Date()}});throw new Error('intentional local savepoint rollback');}));
  });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.verification WHERE identifier='outer-kept'")).rows[0].count,1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.verification WHERE identifier='inner-rejected'")).rows[0].count,0);
  pass('nested_callback_rollback','caught nested callback failure rolled back its writes while retaining the outer transaction');

  phase='actual-task-rpc';
  const now=new Date().toISOString();
  for(let i=0;i<20;i++){const job:Job={id:`qa-job-${i}`,kind:i%2?'generate':'collect',status:'queued',attempts:0,availableAt:now,createdAt:now,payload:{}};await pool.query('INSERT INTO public.radar_jobs(id,payload) VALUES($1,$2)',[job.id,JSON.stringify(job)]);}
  const tasks=cloudbaseTasks(rpc);const claimed=(await Promise.all(Array.from({length:50},()=>tasks.claim()))).filter((job):job is Job=>!!job);
  assert.equal(claimed.length,20);assert.equal(new Set(claimed.map(job=>job.id)).size,20);assert.equal(claimed[0].kind,'collect');
  const old=claimed[0];
  await pool.query("UPDATE public.radar_jobs SET payload=jsonb_set(payload,'{leaseUntil}',to_jsonb($2::text)) WHERE id=$1",[old.id,new Date(Date.now()-1000).toISOString()]);
  assert.equal(await tasks.finish(old,{status:'succeeded',payload:{},availableAt:now,finishedAt:now}),false);
  const taken=await tasks.claim();assert.ok(taken&&taken.id===old.id&&taken.attempts===old.attempts+1);
  assert.equal(await tasks.finish(old,{status:'succeeded',payload:{},availableAt:now}),false);
  const finished=await Promise.all(Array.from({length:30},()=>tasks.finish(taken,{status:'succeeded',payload:{},availableAt:now,finishedAt:now})));
  assert.equal(finished.filter(Boolean).length,1);
  const orderFixtures=[['history-new',true,'2026-10-15T06:28:13.000Z'],['history-old',true,'2026-10-15T04:56:07.000Z'],['fresh-old',false,'2026-10-16T04:56:07.000Z'],['fresh-new',false,'2026-10-16T06:28:13.000Z']] as const;
  for(const [suffix,historical,evidencePublishedAt] of orderFixtures){const job:Job={id:'qa-order-'+suffix,kind:'generate',status:'queued',attempts:0,availableAt:now,createdAt:now,payload:{historical,evidencePublishedAt}};await pool.query('INSERT INTO public.radar_jobs(id,payload) VALUES($1,$2)',[job.id,JSON.stringify(job)]);}
  for(const suffix of ['fresh-new','fresh-old','history-old','history-new']){const job=await tasks.claim();assert.equal(job?.id,'qa-order-'+suffix,'live messages first, historical promises before completions');assert.equal(await tasks.finish(job!,{status:'succeeded',payload:job!.payload,availableAt:now,finishedAt:now}),true);}
  pass('actual_job_payload_and_fence','concurrent claims and lease fencing passed; live jobs newest first, historical jobs source order');

  phase='anonymous-permission-gate';
  const anonymous:typeof fetch=(input,init)=>transport(input,{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),'x-qa-role':'anon'}});
  const anonRpc=new CloudbaseRpc('leida-test-qa',token,anonymous);
  for(const operation of ['radar_cb_auth_snapshot','radar_cb_auth_commit','radar_cb_claim_job','radar_cb_finish_job'] as const){await assert.rejects(anonRpc.call(operation),error=>error instanceof CloudbaseRpcError&&error.status===403);}
  const c=await pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE anon');assert.equal((await c.query('SELECT count(*)::int AS count FROM public."user"')).rows[0].count,0);await c.query('ROLLBACK');}finally{c.release();}
  pass('anonymous_and_rls_gate','all four functions denied anonymous role, and direct anonymous table query saw no authentication rows');
  phase='public-read-adapter';const {testCloudbasePublic}=await import('./test-cloudbase-public-checks');await testCloudbasePublic(pool,rpc,pass,()=>publicCalls,{baseURL,token});
  for(const operation of ['radar_cb_public_version','radar_cb_public_bundle','radar_cb_forecast_snapshot'] as const)await assert.rejects(anonRpc.call(operation),error=>error instanceof CloudbaseRpcError&&error.status===403);
  pass('public_anonymous_gate','all three public adapter RPCs reject anonymous backend impersonation');
  phase='business-write-adapter';const {testCloudbaseWrite}=await import('./test-cloudbase-write-checks');await testCloudbaseWrite(pool,rpc,anonRpc,pass,transport,token);
  phase='complete-cloudbase-accounting';const {testCloudbaseComplete}=await import('./test-cloudbase-complete-checks');await testCloudbaseComplete(pool,rpc,anonRpc,pass,transport,token);
  if(process.argv.includes('--full-app')){
    phase='full-cloudbase-startup';await pool.query('CREATE DATABASE radar_cloudbase_full_probe');appProbePool=new pg.Pool({host:'127.0.0.1',port:Number(port),user:'postgres',database:'radar_cloudbase_full_probe',max:20});
    await appProbePool.query(emptySchema);await appProbePool.query(sqlSource);await appProbePool.query(permissions);for(const file of ['cloudbase-public-schema.sql','cloudbase-public-read.sql','cloudbase-write-schema.sql','cloudbase-write-rpc.sql','cloudbase-accounting.sql'])await appProbePool.query(await readFile(new URL('./migrations/'+file,import.meta.url),'utf8'));
    const {testCloudbaseStartup}=await import('./test-cloudbase-startup-checks');await testCloudbaseStartup(appProbePool,baseURL,token,pass);
  }
  assert.deepEqual(await fingerprints(),sourceFingerprints,'source changed during validation');
  outcome='passed';
}catch(error){const setupOnly=['image-inspect','network-create','container-run','published-port'].includes(phase);failure={phase,kind:error instanceof CloudbaseRpcError?error.kind:undefined,status:error instanceof CloudbaseRpcError?error.status:undefined,locations:error instanceof Error?error.stack?.split('\n').slice(1,5).map(line=>line.replace(/\?.*/,'')):undefined,name:error instanceof Error?error.name:'unknown',probeDiagnostic:error instanceof Error&&/^(requires empty accounting probe|empty accounting summary failed|reservation failed|reservation summary failed|budget limit failed|captured price accounting failed|once-only accounting failed|version gate failed|disabled budget gate failed|accounting rollback failed)$/.test(error.message)?error.message:undefined,code:typeof error==='object'&&error!==null&&'code'in error&&/^[A-Z0-9]{5}$/.test(String(error.code))?error.code:undefined,setupDiagnostic:setupOnly&&typeof error==='object'&&error!==null&&'stderr'in error?String(error.stderr).slice(0,600):undefined};console.error(`FAIL ${phase}; details sanitized`);process.exitCode=1;
}finally{
  await new Promise<void>(resolve=>server.close(()=>resolve()));await appPool?.end();await appProbePool?.end();await pool?.end();
  if(containerCreated){assert.equal((await command('inspect','--format','{{index .Config.Labels "leida-qa"}}',name)).stdout.trim(),label);await command('rm','--force',name);}
  if(networkCreated){assert.equal((await command('network','inspect','--format','{{index .Labels "leida-qa"}}',name)).stdout.trim(),label);await command('network','rm',name);}
  const result={runId,finishedAt:new Date().toISOString(),outcome,failure,checks,sourceFingerprints,postgresVersion:version,imageId,sqlSha256:createHash('sha256').update(sqlSource).digest('hex'),transport:'local-HTTP-gateway-with-one-native-database-transaction-per-RPC',cleanup:containerCreated?'owned-local-container-and-network-removed':networkCreated?'owned-local-network-removed':'no-test-resource-created',actualCloudHttpTested:false,actualCloudLoginTested:false,productionActivated:false,gitPushed:false,remoteDeployed:false};
  await writeFile(qa+`cloudbase-adapter-result-${runId}.json`,JSON.stringify(result,null,2)+'\n');
  await writeFile(qa+'cloudbase-adapter-latest.json',JSON.stringify(result,null,2)+'\n');
}
