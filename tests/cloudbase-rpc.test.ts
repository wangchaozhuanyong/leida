import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { CloudbaseRpc, CloudbaseRpcError, type CloudbaseOperation } from '../src/server/cloudbase/rpc';

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
