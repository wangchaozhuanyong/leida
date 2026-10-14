import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const entry=fileURLToPath(new URL('../scripts/runtime-entrypoint.mjs',import.meta.url));
async function health(port:string){
  return new Promise<{code:number|null;output:string}>(resolve=>{
    const child=spawn(process.execPath,[entry,'health-app'],{env:{PATH:process.env.PATH,PORT:port,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.on('close',code=>resolve({code,output}));
  });
}
test('网站健康检查使用实际端口和轻量版本；HTTP成功但无公开数据仍判失败',async()=>{
  let body:unknown={data:{version:'fixture-public-version',contentVersion:'fixture-content-version'}},status=200,requests:string[]=[];
  const server=createServer((request,response)=>{requests.push(request.url!);response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(body));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  try{
    assert.equal((await health(String(address.port))).code,0);assert.equal(requests[0],'/api/v1/version?light=1');
    for(const value of [{data:{}},{data:{version:''}},{data:{version:42}},{error:'database unavailable'}]){body=value;assert.equal((await health(String(address.port))).code,1);}
    body={data:{version:'valid'}};status=503;assert.equal((await health(String(address.port))).code,1);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
test('健康检查拒绝重定向及非法端口，失败不输出配置或响应正文',async()=>{
  const server=createServer((_request,response)=>{response.writeHead(302,{Location:'/login'});response.end('sensitive-fixture-error-body');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  try{
    const redirect=await health(String(address.port));assert.equal(redirect.code,1);assert.equal(redirect.output,'');
    for(const port of ['0','65536','8080/path','invalid']){const result=await health(port);assert.equal(result.code,1);assert.equal(result.output,'');}
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
