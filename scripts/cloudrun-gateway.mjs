import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {initializeGatewayNetwork} from './cloudrun-network-init.mjs';

function cleanHeaders(headers) {
  const blocked = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
  for (const token of String(headers.connection ?? '').split(',')) blocked.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

/** Fixed upstream only. Request headers and paths cannot choose another server. */
export function createGateway(upstreamUrl, {timeoutMs = 15000} = {}) {
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol !== 'http:' || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('Invalid gateway upstream');
  const agent = new http.Agent({keepAlive:true, maxSockets:100, maxFreeSockets:10});
  const server = http.createServer({maxHeaderSize:16384}, (request, response) => {
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(400); response.end(); return;
    }
    const headers = cleanHeaders(request.headers);
    headers.host = request.headers.host ?? upstream.host;
    headers['x-forwarded-host'] = headers.host;
    headers['x-forwarded-proto'] = 'https';
    const proxy = http.request({hostname:upstream.hostname, port:upstream.port || 80, method:request.method, path:request.url, headers, agent}, incoming => {
      response.writeHead(incoming.statusCode ?? 502, {...cleanHeaders(incoming.headers), 'x-radar-gateway':'native-server-20261022'});
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    });
    const timeout = setTimeout(() => proxy.destroy(new Error('UPSTREAM_TIMEOUT')), timeoutMs);
    timeout.unref();
    const clear = () => clearTimeout(timeout);
    response.once('finish', clear);
    response.once('close', () => {clear(); if (!response.writableFinished) proxy.destroy();});
    request.once('aborted', () => proxy.destroy());
    request.once('error', () => proxy.destroy());
    proxy.on('error', () => {
      clear();
      if (response.headersSent) {response.destroy(); return;}
      response.writeHead(503, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'});
      response.end(JSON.stringify({error:'服务暂时不可用，请稍后重试'}));
    });
    request.pipe(proxy);
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  server.on('connect', (_request, socket) => {socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');});
  server.on('upgrade', (_request, socket) => {socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');});
  server.once('close', () => agent.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port');
  initializeGatewayNetwork();
  const server = createGateway(process.argv[2]);
  server.listen(port, '0.0.0.0', () => console.log('Gateway ready'));
  const stop = () => {server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref();};
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
