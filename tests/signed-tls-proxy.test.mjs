import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {spawnSync} from 'node:child_process';
import {createSignedGateway,createGatewayKeyResolver,createTlsFront,keyPath} from '../scripts/signed-tls-proxy.mjs';

// Fixture private keys remain in memory and are never serialized to disk or output.
const config='[req]\ndistinguished_name=dn\nx509_extensions=server\nprompt=no\n[dn]\nCN=127.0.0.1\n[server]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n';
function certificate(){const result=spawnSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config','/dev/fd/0','-keyout','/dev/fd/3','-out','/dev/fd/4'],{input:config,stdio:['pipe','ignore','pipe','pipe','pipe']});assert.equal(result.status,0,'fixture generation failed');return {key:result.output[3],cert:result.output[4]};}
const fixture=certificate(),other=certificate();
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server)));
const url=(server,tls=false)=>`${tls?'https':'http'}://127.0.0.1:${server.address().port}`;
const close=async servers=>{for(const server of [...servers].reverse()){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
function request(address,{method='GET',headers={},body='',ca=fixture.cert}={}){return new Promise((resolve,reject)=>{const target=new URL(address);const req=(target.protocol==='https:'?https:http).request(target,{method,headers,ca,rejectUnauthorized:true,agent:false},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.setTimeout(3000,()=>req.destroy(new Error('fixture timeout')));req.once('error',reject);req.end(body);});}
async function setup(t,{authorityBody}={}){
  const servers=[];t.after(()=>close(servers));const seen=[];let gateway;
  const backend=await listen(http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);seen.push({method:req.method,path:req.url,headers:req.headers,body:Buffer.concat(chunks)});if(req.url==='/business-401'){res.writeHead(401,{'content-type':'application/json'});res.end('{"loginRequired":true}');return;}res.writeHead(200,{'content-type':'application/octet-stream','set-cookie':['a=1; HttpOnly','b=2; Secure'],'cache-control':'max-age=17'});res.end(Buffer.concat(chunks));}));servers.push(backend);
  const authority=await listen(https.createServer(fixture,async(_req,res)=>{try{const data=authorityBody??JSON.parse((await request(url(gateway)+keyPath)).body);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));}catch{res.writeHead(503);res.end();}}));servers.push(authority);
  const resolver=createGatewayKeyResolver(url(authority,true)+keyPath,{ca:fixture.cert});
  const front=await listen(createTlsFront({...fixture,resolveKey:resolver,upstream:url(backend)}));servers.push(front);
  gateway=await listen(createSignedGateway(url(front,true),{ca:fixture.cert}));servers.push(gateway);
  return {backend,front,gateway,authority,servers,seen};
}

test('authenticated TLS streaming preserves application identity, bytes, paths and cookies',async t=>{
 const f=await setup(t);const body=Buffer.alloc(65537,0x9c);
 const r=await request(url(f.gateway)+'/api/v1/fixture?q=a%2Fb',{method:'POST',body,headers:{authorization:'Bearer fixture-not-secret',cookie:'session=fixture','x-wx-openid':'fixture-openid','content-type':'application/octet-stream'}});
 assert.equal(r.status,200);assert.deepEqual(r.body,body);assert.deepEqual(r.headers['set-cookie'],['a=1; HttpOnly','b=2; Secure']);assert.equal(r.headers['cache-control'],'max-age=17');assert.equal(r.headers['x-radar-gateway-build'],'signed-tls-upstream-20261022');
 assert.equal(f.seen.length,1);assert.equal(f.seen[0].path,'/api/v1/fixture?q=a%2Fb');assert.equal(f.seen[0].headers['x-wx-openid'],'fixture-openid');assert.equal(f.seen[0].headers.authorization,'Bearer fixture-not-secret');assert.equal(f.seen[0].headers.cookie,'session=fixture');assert.deepEqual(f.seen[0].body,body);assert.equal(Object.keys(f.seen[0].headers).some(k=>k.startsWith('x-radar-edge-')),false);
});
test('direct unsigned requests and spoofed WeChat identity cannot reach application',async t=>{const f=await setup(t);const r=await request(url(f.front,true)+'/api/v1/me',{headers:{'x-wx-openid':'forged'}});assert.equal(r.status,401);assert.equal(f.seen.length,0);});
test('application authentication errors remain 401',async t=>{const f=await setup(t);const r=await request(url(f.gateway)+'/business-401');assert.equal(r.status,401);assert.deepEqual(JSON.parse(r.body),{loginRequired:true});});
test('TLS certificate pin and hostname checks remain enforced',async t=>{const f=await setup(t);const bad=await listen(createSignedGateway(url(f.front,true),{ca:other.cert}));f.servers.push(bad);const r=await request(url(bad)+'/');assert.equal(r.status,503);assert.equal(f.seen.length,0);await assert.rejects(request(url(f.front,true),{ca:other.cert}));});
test('transport authorization failure is 503, not user logout',async t=>{const f=await setup(t,{authorityBody:{keyId:'0'.repeat(64),publicKey:'invalid'}});const r=await request(url(f.gateway)+'/');assert.equal(r.status,503);assert.equal(r.headers['x-radar-edge-auth'],undefined);assert.equal(f.seen.length,0);});
test('key endpoint publishes only an Ed25519 public key',async t=>{const f=await setup(t);const r=await request(url(f.gateway)+keyPath);assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');const key=JSON.parse(r.body);assert.deepEqual(Object.keys(key).sort(),['keyId','publicKey']);assert.match(key.keyId,/^[a-f0-9]{64}$/);assert.equal(Buffer.from(key.publicKey,'base64').length,44);assert.equal(f.seen.length,0);});
test('configured destinations reject plaintext, credentials and nonlocal application targets',()=>{
 assert.throws(()=>createSignedGateway('http://127.0.0.1',{ca:fixture.cert}));assert.throws(()=>createSignedGateway('https://user:pass@example.test',{ca:fixture.cert}));assert.throws(()=>createGatewayKeyResolver('http://example.test'+keyPath));assert.throws(()=>createGatewayKeyResolver('https://example.test/wrong'));
 assert.throws(()=>createTlsFront({...fixture,resolveKey:async()=>null,upstream:'http://169.254.169.254'}));
});
test('identity/path mutation, expired grants and replay fail before application',async t=>{
 const servers=[];t.after(()=>close(servers));let captured;let gateway;let calls=0;
 const backend=await listen(http.createServer((_req,res)=>{calls++;res.end('ok');}));servers.push(backend);
 const capture=await listen(https.createServer(fixture,(req,res)=>{captured={method:req.method,path:req.url,headers:req.headers};req.resume();res.end('captured');}));servers.push(capture);
 gateway=await listen(createSignedGateway(url(capture,true),{ca:fixture.cert}));servers.push(gateway);
 const authority=await listen(https.createServer(fixture,async(_req,res)=>{res.end((await request(url(gateway)+keyPath)).body);}));servers.push(authority);
 const resolver=createGatewayKeyResolver(url(authority,true)+keyPath,{ca:fixture.cert});
 const front=await listen(createTlsFront({...fixture,resolveKey:resolver,upstream:url(backend)}));servers.push(front);
 await request(url(gateway)+'/intended',{headers:{'x-wx-openid':'real-fixture'}});
 assert.equal((await request(url(front,true)+'/changed',{headers:captured.headers})).status,401);
 assert.equal((await request(url(front,true)+captured.path,{headers:{...captured.headers,'x-wx-openid':'forged'}})).status,401);
 assert.equal((await request(url(front,true)+captured.path,{headers:{...captured.headers,'x-radar-edge-time':String(Date.now()-60000)}})).status,401);
 assert.equal(calls,0);
 assert.equal((await request(url(front,true)+captured.path,{headers:captured.headers})).status,200);assert.equal(calls,1);
 assert.equal((await request(url(front,true)+captured.path,{headers:captured.headers})).status,401);assert.equal(calls,1);
});
