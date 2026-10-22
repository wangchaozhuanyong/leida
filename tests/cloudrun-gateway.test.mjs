import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createGateway} from '../scripts/cloudrun-gateway.mjs';
import {diagnoseGatewayNetwork, networkDiagnosticSummary} from '../scripts/cloudrun-network-diagnostics.mjs';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);});

test('preserves path, query, method, body and application authentication headers', async () => {
  const backend = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('set-cookie', 'qa_session=fixture; HttpOnly; Secure');
    res.writeHead(201, {'content-type':'application/json'});
    res.end(JSON.stringify({method:req.method, path:req.url, body:Buffer.concat(chunks).toString(), auth:req.headers.authorization, proto:req.headers['x-forwarded-proto']}));
  });
  const backendPort = await listen(backend), gateway = createGateway(`http://127.0.0.1:${backendPort}`), port = await listen(gateway);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap?view=home`, {method:'POST', body:'fixture-body', headers:{authorization:'Bearer fixture-not-a-secret'}});
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('x-radar-gateway'), 'native-server-20261022');
    assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure/);
    assert.deepEqual(await response.json(), {method:'POST',path:'/api/v1/bootstrap?view=home',body:'fixture-body',auth:'Bearer fixture-not-a-secret',proto:'https'});
  } finally {await close(gateway); await close(backend);}
});

test('passes application errors without converting them to success', async () => {
  const backend = http.createServer((_req,res) => {res.writeHead(401);res.end('{"error":"fixture"}');});
  const backendPort = await listen(backend), gateway = createGateway(`http://127.0.0.1:${backendPort}`), port = await listen(gateway);
  try {const response = await fetch(`http://127.0.0.1:${port}/api/admin`);assert.equal(response.status,401);assert.equal(await response.text(),'{"error":"fixture"}');}
  finally {await close(gateway);await close(backend);}
});

test('upstream failure returns a bounded generic error without upstream details', async () => {
  const unavailable = http.createServer(); const unusedPort = await listen(unavailable); await close(unavailable);
  const gateway = createGateway(`http://127.0.0.1:${unusedPort}`, {timeoutMs:100}), port = await listen(gateway);
  try {const response=await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`);assert.equal(response.status,503);const body=await response.text();assert.ok(!body.includes('127.0.0.1'));assert.ok(!body.includes(String(unusedPort)));}
  finally {await close(gateway);}
});

test('upstream credentials and non-http targets are rejected', () => {
  for (const target of ['https://127.0.0.1:8080','http://user:pass@127.0.0.1:8080','http://127.0.0.1:8080/path','http://127.0.0.1:8080?url=x']) assert.throws(() => createGateway(target));
});

test('streams static and image bytes unchanged', async () => {
  const bytes = Buffer.from(Array.from({length:65536}, (_,index) => index % 256));
  const backend=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'image/png','cache-control':'public,max-age=300'});res.end(bytes);});
  const backendPort=await listen(backend),gateway=createGateway(`http://127.0.0.1:${backendPort}`),port=await listen(gateway);
  try {const response=await fetch(`http://127.0.0.1:${port}/image.png`);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cache-control'),'public,max-age=300');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);}
  finally {await close(gateway);await close(backend);}
});

test('absolute-form destinations cannot turn the gateway into an open proxy', async () => {
  let upstreamCalls=0;
  const backend=http.createServer((_req,res)=>{upstreamCalls++;res.end();});
  const backendPort=await listen(backend),gateway=createGateway(`http://127.0.0.1:${backendPort}`),port=await listen(gateway);
  try {
    const result=await new Promise((resolve,reject)=>{
      const request=http.request({hostname:'127.0.0.1',port,path:'http://example.invalid/private',method:'GET'},response=>{response.resume();resolve(response.statusCode);});
      request.on('error',reject);request.end();
    });
    assert.equal(result,400);assert.equal(upstreamCalls,0);
  } finally {await close(gateway);await close(backend);}
});


test('background diagnostic completes against the fixed upstream while HTTP forwarding remains available', async () => {
  const logs = [];
  const backend = http.createServer((_req,res) => res.end('fixture-public-response'));
  const backendPort = await listen(backend), target = `http://127.0.0.1:${backendPort}`;
  const gateway = createGateway(target), port = await listen(gateway);
  try {
    const diagnostic = diagnoseGatewayNetwork(target, {idleMs:10, timeoutMs:100, log:line=>logs.push(line)});
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/release`);
    assert.equal(response.status,200); assert.equal(await response.text(),'fixture-public-response');
    assert.equal(response.headers.get('x-radar-gateway-build'),'procfs-readonly-20261022');
    const result = await diagnostic;
    assert.equal(result.state,'tcp-connected');
    assert.match(networkDiagnosticSummary(),/^tcp-connected;idle=(\d+|na);probe=(\d+|na);after=(\d+|na);control=not-run$/);
    assert.equal(logs.length,1); assert.ok(!logs[0].includes('127.0.0.1')); assert.ok(!logs[0].includes('fixture-public-response'));
  } finally {await close(gateway);await close(backend);}
});

test('diagnostic rejects credentialed and non-http upstreams before attempting a connection', async () => {
  for (const target of ['http://user:fixture@127.0.0.1:80','https://127.0.0.1','http://127.0.0.1/path']) {
    await assert.rejects(diagnoseGatewayNetwork(target,{idleMs:0,timeoutMs:1,log:()=>{}}), /Invalid diagnostic upstream/);
  }
});
