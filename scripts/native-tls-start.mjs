import {readFileSync} from 'node:fs';
import {createTlsFront,createGatewayKeyResolver,keyPath} from './signed-tls-proxy.mjs';

const resolveKey=createGatewayKeyResolver('https://express-l98p-326351-12-1503749333.sh.run.tcloudbase.com'+keyPath);
const server=createTlsFront({
  key:readFileSync('/run/secrets/gateway-tls.key'),
  cert:readFileSync('/run/secrets/gateway-tls.pem'),
  resolveKey,
});
server.listen(8443,'0.0.0.0',()=>console.log('Authenticated TLS front ready'));
const stop=()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
