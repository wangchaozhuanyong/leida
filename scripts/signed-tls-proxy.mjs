import http from 'node:http';
import https from 'node:https';
import {createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify} from 'node:crypto';

export const keyPath = '/.well-known/radar-gateway-key';
const prefix = 'x-radar-edge-';
const hops = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const build = 'signed-tls-upstream-20261022';

function clean(headers) {
  const blocked = new Set(hops);
  for (const name of String(headers.connection ?? '').split(',')) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase()) && !name.toLowerCase().startsWith(prefix)));
}
function frame(method,path,headers,time,nonce) {
  // TLS protects streamed bodies. This one-use grant binds the method, path and application identity headers.
  const entries = Object.entries(clean(headers)).filter(([name]) => name !== 'content-length').sort(([a],[b]) => a.localeCompare(b));
  return Buffer.from(JSON.stringify([method,path,entries,time,nonce]));
}
const identify = der => createHash('sha256').update(der).digest('hex');
function reply(res,status=503,auth=false) {
  if (res.headersSent) {res.destroy();return;}
  res.writeHead(status, {...(auth?{'connection':'close'}:{}),'content-type':'application/json; charset=utf-8','cache-control':'no-store',...(auth?{[prefix+'auth']:'rejected'}:{})});
  res.end(JSON.stringify({error:status===401?'Unauthorized':'服务暂时不可用，请稍后重试'}));
}
function pipeUpstream(req,res,options,{tls=false,timeoutMs=15000,mark=false}={}) {
  const outbound=(tls?https:http).request(options,incoming=>{
    if(mark && incoming.headers[prefix+'auth']==='rejected'){incoming.resume();reply(res);return;}
    res.writeHead(incoming.statusCode??502,{...clean(incoming.headers),...(mark?{'x-radar-gateway':'native-server-20261022','x-radar-gateway-build':build}:{})});
    incoming.on('error',()=>res.destroy());incoming.pipe(res);
  });
  const timer=setTimeout(()=>outbound.destroy(),timeoutMs);timer.unref();
  const stop=()=>clearTimeout(timer);
  res.once('finish',stop);res.once('close',()=>{stop();if(!res.writableFinished)outbound.destroy();});
  req.once('aborted',()=>outbound.destroy());req.once('error',()=>outbound.destroy());
  outbound.once('error',()=>{stop();reply(res);});req.pipe(outbound);
}
function configure(server,onClose) {
  server.headersTimeout=10000;server.requestTimeout=20000;
  server.on('connect',(_req,socket)=>socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'));
  server.on('upgrade',(_req,socket)=>socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n'));
  if(onClose)server.once('close',onClose);return server;
}

/** CloudRun. Private signing key exists only in this process's memory. */
export function createSignedGateway(upstreamUrl,{ca,timeoutMs=15000}={}) {
  const target=new URL(upstreamUrl);
  if(target.protocol!=='https:' || !ca || target.username || target.password || target.pathname!=='/' || target.search || target.hash)throw new Error('Invalid pinned upstream');
  const identity=generateKeyPairSync('ed25519');
  const der=identity.publicKey.export({format:'der',type:'spki'});
  const publicIdentity={keyId:identify(der),publicKey:der.toString('base64')};
  const agent=new https.Agent({ca,rejectUnauthorized:true,minVersion:'TLSv1.2',keepAlive:true,maxSockets:100,maxFreeSockets:10});
  const server=http.createServer({maxHeaderSize:16384},(req,res)=>{
    res.setHeader('x-radar-gateway','native-server-20261022');res.setHeader('x-radar-gateway-build',build);
    if(req.method==='GET' && req.url===keyPath){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(publicIdentity));return;}
    if(!req.url?.startsWith('/') || req.url.startsWith('//')){res.writeHead(400);res.end();return;}
    const headers=clean(req.headers);headers.host=req.headers.host??target.host;
    headers['x-forwarded-host']=headers.host;headers['x-forwarded-proto']='https';
    const time=String(Date.now()),nonce=randomBytes(18).toString('base64url');
    const signature=sign(null,frame(req.method,req.url,headers,time,nonce),identity.privateKey).toString('base64');
    Object.assign(headers,{[prefix+'key-id']:publicIdentity.keyId,[prefix+'time']:time,[prefix+'nonce']:nonce,[prefix+'signature']:signature});
    pipeUpstream(req,res,{hostname:target.hostname,port:Number(target.port||443),path:req.url,method:req.method,headers,agent},{tls:true,timeoutMs,mark:true});
  });
  return configure(server,()=>agent.destroy());
}

/** Trust keys only from a fixed HTTPS CloudRun endpoint, never from request-supplied URLs or keys. */
export function createGatewayKeyResolver(endpoint,{ca,timeoutMs=3000}={}) {
  const url=new URL(endpoint);
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!==keyPath || url.search || url.hash)throw new Error('Invalid key authority');
  const keys=new Map();let loading=null,lastLoad=0;
  const load=()=>new Promise((resolve,reject)=>{
    const request=https.get(url,{ca,rejectUnauthorized:true,headers:{'cache-control':'no-cache'}},response=>{
      if(response.statusCode!==200){response.resume();reject(new Error('Key authority unavailable'));return;}
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>4096){response.destroy();reject(new Error('Invalid key authority response'));}else chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>{try{
        const body=JSON.parse(Buffer.concat(chunks));const der=Buffer.from(body.publicKey,'base64');
        if(der.length>256 || identify(der)!==body.keyId)throw new Error('Invalid authority key');
        const key=createPublicKey({key:der,format:'der',type:'spki'});
        if(key.asymmetricKeyType!=='ed25519')throw new Error('Invalid authority key');
        if(keys.size>=16)keys.delete(keys.keys().next().value);
        keys.set(body.keyId,{key,expires:Date.now()+120000});resolve();
      }catch(error){reject(error);}});
    });
    const deadline=setTimeout(()=>request.destroy(new Error('Key authority timeout')),timeoutMs);deadline.unref();
    request.once('close',()=>clearTimeout(deadline));request.on('error',reject);
  });
  return async keyId=>{
    let cached=keys.get(keyId);if(cached?.expires>Date.now())return cached.key;
    if(!loading && Date.now()-lastLoad>=1000){lastLoad=Date.now();loading=load().catch(()=>{}).finally(()=>loading=null);}
    if(loading)await loading;
    cached=keys.get(keyId);return cached?.expires>Date.now()?cached.key:null;
  };
}

/** Native server. TLS plus one-use CloudRun grants protect the fixed local application. */
export function createTlsFront({key,cert,resolveKey,upstream='http://app:8080',timeoutMs=15000,clock=Date.now}) {
  const target=new URL(upstream);
  if(target.protocol!=='http:' || !['app','127.0.0.1'].includes(target.hostname) || target.username || target.password || target.pathname!=='/' || target.search || target.hash)throw new Error('Invalid local upstream');
  const agent=new http.Agent({keepAlive:true,maxSockets:100,maxFreeSockets:10});const seen=new Map();
  const server=https.createServer({key,cert,minVersion:'TLSv1.2',maxHeaderSize:16384},async(req,res)=>{
    try{
      if(!req.url?.startsWith('/') || req.url.startsWith('//')){res.writeHead(400);res.end();return;}
      const id=req.headers[prefix+'key-id'],time=req.headers[prefix+'time'],nonce=req.headers[prefix+'nonce'],signature=req.headers[prefix+'signature'];
      if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)||typeof time!=='string'||!/^\d{13}$/.test(time)||Math.abs(clock()-Number(time))>30000||typeof nonce!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(nonce)||typeof signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(signature)){reply(res,401,true);return;}
      const headers=clean(req.headers),publicKey=await resolveKey(id);
      if(!publicKey || !verify(null,frame(req.method,req.url,headers,time,nonce),publicKey,Buffer.from(signature,'base64'))){reply(res,401,true);return;}
      const now=clock();for(const [name,expires]of seen){if(expires>now)break;seen.delete(name);}
      const token=id+':'+nonce;if(seen.has(token)){reply(res,401,true);return;}
      if(seen.size>=4096){reply(res);return;}seen.set(token,now+60000);
      if(req.destroyed||res.destroyed)return;
      pipeUpstream(req,res,{hostname:target.hostname,port:Number(target.port||80),path:req.url,method:req.method,headers,agent},{timeoutMs});
    }catch{reply(res,401,true);}
  });
  return configure(server,()=>agent.destroy());
}
