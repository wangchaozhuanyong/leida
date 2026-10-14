// Disposable local QA only. The production entrypoint never imports this file.
const gateway=new URL(process.env.RADAR_QA_GATEWAY||'');
if(gateway.protocol!=='http:'||gateway.hostname!=='127.0.0.1')throw new Error('QA gateway must be loopback');
const original=globalThis.fetch;
globalThis.fetch=(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(url.hostname==='leida-test-qa.api.tcloudbasegateway.com'){
    const headers=new Headers(init?.headers);headers.set('x-qa-database','complete-probe');
    return original(new URL(url.pathname,gateway),{...init,headers});
  }
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('QA external request denied');
  return original(input,init);
};
