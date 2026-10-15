import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { CloudbaseRpc, CloudbaseRpcError, type CloudbaseOperation } from '../src/server/cloudbase/rpc';
import { apiError } from '../src/server/http';

test('CloudBase后端调用限定环境与函数，不允许任意SQL或转发秘密', async () => {
  const token=randomBytes(24).toString('hex'); let count=0;
  const transport:typeof fetch=async (url,options)=>{
    count++;assert.equal(String(url),'https://leida-test-qa.api.tcloudbasegateway.com/v1/rdb/rest/rpc/radar_cb_auth_snapshot');
    assert.equal(new Headers(options?.headers).get('authorization'),`Bearer ${token}`);
    assert.equal(options?.redirect,'error');assert.equal(options?.cache,'no-store');assert.equal(options?.body,'{}');
    return Response.json({fingerprint:'a'.repeat(32)});
  };
  assert.throws(()=>new CloudbaseRpc('https://untrusted.invalid',token),CloudbaseRpcError);
  assert.throws(()=>new CloudbaseRpc('leida-test-qa','x\r\ny'),CloudbaseRpcError);
  const rpc=new CloudbaseRpc('leida-test-qa',token,transport);
  assert.equal((await rpc.call<{fingerprint:string}>('radar_cb_auth_snapshot')).fingerprint,'a'.repeat(32));
  assert.ok(!JSON.stringify(rpc).includes(token));
  await assert.rejects(rpc.call('execute_sql' as CloudbaseOperation,{Sql:'SELECT 1'}),CloudbaseRpcError);
  assert.equal(count,1);
});
test('CloudBase错误正文及网络异常不泄漏凭证，请求结果未知时不自动重发',async()=>{
  const canary=randomBytes(24).toString('hex');let attempts=0;
  const rpc=new CloudbaseRpc('leida-test-qa',canary,async()=>{attempts++;throw new Error(canary);});
  await assert.rejects(rpc.call('radar_cb_auth_commit'),error=>error instanceof CloudbaseRpcError&&error.kind==='unknown'&&!String(error).includes(canary));
  assert.equal(attempts,1);
  const rejected=new CloudbaseRpc('leida-test-qa',canary,async()=>Response.json({code:'42501',message:canary,details:canary},{status:403}));
  await assert.rejects(rejected.call('radar_cb_auth_snapshot'),error=>error instanceof CloudbaseRpcError&&error.kind==='rejected'&&!JSON.stringify(error).includes(canary));
});
test('CloudBase拒绝损坏与超限响应，冲突保留为明确失败',async()=>{
  for(const response of [new Response('not-json'),new Response('x'.repeat(2*1024*1024+1))]){
    const rpc=new CloudbaseRpc('leida-test-qa','qa-only',async()=>response);
    await assert.rejects(rpc.call('radar_cb_auth_snapshot'),error=>error instanceof CloudbaseRpcError&&error.kind==='response');
  }
  for(const [code,status] of [['40001',409],['DATABASE_40001',500],['DATABASE_42501',500],['NOT_DATABASE_40001',500]] as const){
    let calls=0;
    const conflict=new CloudbaseRpc('leida-test-qa','qa-only',async()=>{calls++;return Response.json({code,message:'private-detail'},{status});});
    const kind=code==='40001'||code==='DATABASE_40001'?'conflict':'rejected';
    await assert.rejects(conflict.call('radar_cb_auth_commit'),error=>error instanceof CloudbaseRpcError&&error.kind===kind&&!String(error).includes('private-detail'));
    assert.equal(calls,1);
  }
});

test('CloudBase公开错误可区分数据库连接、环境、权限和函数缺失，且不改变原状态',async()=>{
  for (const [code,status] of [['PGRST002',503],['DATABASE_PGRST000',503],['PGRST003',504],['INVALID_ENV',404],['DATABASE_42501',403],['PGRST202',404],['DATABASE_53300',503]] as const) {
    const canary=randomBytes(24).toString('hex');let attempts=0;
    const rpc=new CloudbaseRpc('leida-test-qa',canary,async()=>{attempts++;return Response.json({code,message:canary,details:canary,hint:canary,requestId:canary},{status});});
    const error:unknown=await rpc.call('radar_cb_public_version',{private:canary}).catch((error:unknown)=>error);
    assert.ok(error instanceof CloudbaseRpcError);
    const response=apiError(error),body=await response.json();
    assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(body,{error:'数据库接口暂不可用',diagnosticCode:`CB_REJECTED_${status}_${code.replace(/^DATABASE_/,'')}`});
    assert.ok(!JSON.stringify(error).includes(canary));assert.ok(!JSON.stringify(body).includes(canary));assert.equal(attempts,1);
  }
});

test('CloudBase未列入白名单的错误码和正文不能进入公开诊断',async()=>{
  const canary=randomBytes(24).toString('hex');
  for (const code of [canary,`DATABASE_${canary}`,{code:canary},null]) {
    const rpc=new CloudbaseRpc('leida-test-qa',canary,async()=>Response.json({code,message:canary,details:canary},{status:503}));
    const error:unknown=await rpc.call('radar_cb_store_read',{private:canary}).catch((error:unknown)=>error);
    assert.ok(error instanceof CloudbaseRpcError);
    assert.deepEqual(await apiError(error).json(),{error:'数据库接口暂不可用',diagnosticCode:'CB_REJECTED_503_UNCLASSIFIED'});
    assert.ok(!JSON.stringify(error).includes(canary));
  }
});

test('CloudBase损坏和超限响应保留安全诊断，原始内容不可见',async()=>{
  const canary=randomBytes(24).toString('hex');
  for (const [response,diagnostic] of [[new Response(canary,{status:503}),'CB_RESPONSE_503_INVALID_JSON'],[new Response('x'.repeat(2*1024*1024+1)),'CB_RESPONSE_200_RESPONSE_TOO_LARGE']] as const) {
    const rpc=new CloudbaseRpc('leida-test-qa',canary,async()=>response);
    const error:unknown=await rpc.call('radar_cb_public_bundle').catch((error:unknown)=>error);
    assert.ok(error instanceof CloudbaseRpcError);assert.equal(error.diagnosticCode,diagnostic);
    const body=await apiError(error).text();assert.ok(!body.includes(canary));
  }
});

test('CloudBase网络诊断只读取有限原因链中的已知码，不重发请求',async()=>{
  const canary=randomBytes(24).toString('hex');
  const certificate=Object.assign(new Error(canary),{code:'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'});
  const cyclic:Record<string,unknown>={code:canary};cyclic.cause=cyclic;
  for (const [failure,code] of [[new Error(canary,{cause:new AggregateError([cyclic,certificate])}),'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'],[Object.assign(new Error(canary),{name:'TimeoutError'}),'REQUEST_TIMEOUT'],[cyclic,'UNCLASSIFIED']] as const) {
    let attempts=0;
    const rpc=new CloudbaseRpc('leida-test-qa',canary,async()=>{attempts++;throw failure;});
    const error:unknown=await rpc.call('radar_cb_store_commit',{private:canary}).catch((error:unknown)=>error);
    assert.ok(error instanceof CloudbaseRpcError);assert.equal(error.kind,'unknown');
    assert.equal(error.diagnosticCode,`CB_UNKNOWN_0_${code}`);assert.equal(attempts,1);
    const response=apiError(error);assert.equal(response.status,500);
    assert.deepEqual(await response.json(),{error:'服务暂不可用，请稍后重试',diagnosticCode:`CB_UNKNOWN_0_${code}`});
    assert.ok(!JSON.stringify(error).includes(canary));
  }
});

test('CloudBase配置失败及普通接口错误不暴露调用参数或伪造诊断',async()=>{
  const canary=randomBytes(24).toString('hex');
  assert.deepEqual(await apiError(new CloudbaseRpcError('configuration')).json(),{error:'服务暂不可用，请稍后重试',diagnosticCode:'CB_CONFIGURATION_0_UNCLASSIFIED'});
  assert.deepEqual(await apiError({name:'CloudbaseRpcError',message:canary,diagnosticCode:canary}).json(),{error:'服务暂不可用，请稍后重试'});
  assert.deepEqual(await apiError({status:401,message:'请先登录'}).json(),{error:'请先登录'});
  const validation=apiError({name:'ZodError',message:canary});assert.equal(validation.status,400);
  assert.deepEqual(await validation.json(),{error:'提交内容不完整或格式有误，请检查必填项'});
});
