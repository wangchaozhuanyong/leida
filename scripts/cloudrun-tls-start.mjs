import {readFileSync} from 'node:fs';
import {createSignedGateway} from './signed-tls-proxy.mjs';

const port=Number(process.env.PORT||8080);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid gateway port');
const server=createSignedGateway('https://43.142.149.178:80',{
  ca:readFileSync(new URL('./gateway-server-public.pem',import.meta.url)),
});
server.listen(port,'0.0.0.0',()=>console.log('Gateway ready'));
const stop=()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
