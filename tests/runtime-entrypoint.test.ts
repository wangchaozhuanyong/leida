import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';

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

async function supervisedFixture(failing?:'app'|'worker',failureCode=17){
  const qa=resolve(dirname(entry),'../outputs/implementation-qa');
  await mkdir(qa,{recursive:true});
  const root=await mkdtemp(join(qa,'runtime-supervision-'));
  await mkdir(join(root,'.next/standalone'),{recursive:true});
  await mkdir(join(root,'scripts'),{recursive:true});
  await writeFile(join(root,'package.json'),'{"type":"module"}');
  const source=(kind:'app'|'worker')=>`import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(root,kind+'.started'))},String(process.pid));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{writeFileSync(${JSON.stringify(join(root,kind+'.stopped'))},signal);process.exit(0);});
setInterval(()=>{},1000);
${failing===kind?`setTimeout(()=>process.exit(${failureCode}),1500);`:''}`;
  await writeFile(join(root,'.next/standalone/server.js'),source('app'));
  await writeFile(join(root,'scripts/worker.ts'),source('worker'));
  const child=spawn(process.execPath,[entry,'app-worker'],{cwd:root,env:{PATH:process.env.PATH,NODE_ENV:'test',RADAR_STORAGE_BACKEND:'cloudbase'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const closed=new Promise<number|null>(resolve=>child.once('close',resolve));
  const waitStarted=async()=>{
    for(let attempt=0;attempt<100;attempt++){
      try{await Promise.all(['app','worker'].map(kind=>readFile(join(root,kind+'.started'))));return;}catch{}
      if(child.exitCode!==null)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error('fixture processes did not both start');
  };
  return {child,closed,waitStarted,stopped:async(kind:'app'|'worker')=>readFile(join(root,kind+'.stopped'),'utf8'),output:()=>output,cleanup:async()=>{
    if(child.exitCode===null){child.kill('SIGTERM');await closed;}
    await rm(root,{recursive:true,force:true});
  }};
}
for(const kind of ['app','worker'] as const)test(`${kind}意外退出会终止另一个进程并让容器失败`,{timeout:15000},async()=>{
  const fixture=await supervisedFixture(kind);
  try{
    await fixture.waitStarted();assert.equal(await fixture.closed,17);
    assert.equal(await fixture.stopped(kind==='app'?'worker':'app'),'SIGTERM');
    assert.match(fixture.output(),/网站或后台任务已停止/);
  }finally{await fixture.cleanup();}
});
test('单容器收到停止信号时网站和任务均能退出，不留下后台进程',{timeout:15000},async()=>{
  const fixture=await supervisedFixture();
  try{
    await fixture.waitStarted();fixture.child.kill('SIGTERM');assert.equal(await fixture.closed,0);
    assert.deepEqual(await Promise.all(['app','worker'].map(kind=>fixture.stopped(kind as 'app'|'worker'))),['SIGTERM','SIGTERM']);
  }finally{await fixture.cleanup();}
});
test('任务提前正常退出也不能留下只有网站的健康假象',{timeout:15000},async()=>{
  const fixture=await supervisedFixture('worker',0);
  try{await fixture.waitStarted();assert.equal(await fixture.closed,1);assert.equal(await fixture.stopped('app'),'SIGTERM');}
  finally{await fixture.cleanup();}
});
