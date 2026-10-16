/** Loopback-only visual fixture. No database, worker, credentials or remote API. */
import http from 'node:http';
import {createHash} from 'node:crypto';
import {readFixture} from './qa-public-navigation-server.mjs';
import {buildResetCadenceForecast,type CadenceTarget} from '../src/lib/reset-cadence';
import {publicResetOutlook} from '../src/lib/reset-outlook';
import type {PublicData} from '../src/lib/types';
const now='2026-10-16T06:00:00.000Z';
function fixture(target:CadenceTarget){
 const observations=Array.from({length:12},(_,i)=>{const at=new Date(Date.parse(now)-(11-i)*(target==='banked_reset'?72:48)*3600000).toISOString();return {id:`qa-${target}-${i}`,evidenceIds:[`qa-evidence-${i}`],url:`https://example.invalid/qa/${target}/${i}`,kind:target,at,firstKnownAt:at,timePrecision:'exact' as const};});
 return buildResetCadenceForecast({observations,target,generatedAt:now,inputFingerprint:createHash('sha256').update(`simulation-${target}`).digest('hex')});
}
const byKind={automatic_reset:fixture('automatic_reset'),banked_reset:fixture('banked_reset')};
const server=http.createServer((request,response)=>{
 const url=new URL(request.url??'/','http://127.0.0.1:5337');
 const json=(value:unknown,status=200)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-QA-Simulation':'true'});response.end(JSON.stringify(value));};
 if(!['GET','HEAD'].includes(request.method??''))return json({error:'Read-only local visual fixture'},405);
 if(url.pathname==='/api/v1/bootstrap'||url.pathname==='/api/v1/status'){
  // The existing JS-only fixture widens tuple/literal types; it has its own contract tests.
  const result=readFixture(url.searchParams,undefined,now) as unknown as {data:PublicData};
  for(const event of [...result.data.events,...result.data.publications.map(p=>p.event)])for(const action of event.actions)if(action.stage==='promised'){action.stage='claimed_complete';delete action.expectedAt;}
  if(result.data.forecasts){result.data.forecasts={...result.data.forecasts,cadence:byKind.automatic_reset,cadenceByKind:byKind,cadenceHistory:Object.values(byKind),outlook:publicResetOutlook(result.data),cadenceEvaluationByKind:{automatic_reset:{modelVersion:byKind.automatic_reset.modelVersion,maturedSamples:0,positiveSamples:0,unknownSamples:0,brierScore:null,baselineBrierScore:null,skill:null,calibrated:false,externalWeight:0,explanation:'SIMULATION ONLY'}}};}
  return json(result);
 }
 if(url.pathname==='/api/v1/version')return json({data:{version:'qa-forecast-upgrade',contentVersion:'qa-forecast-upgrade'}});
 if(url.pathname==='/api/v1/wechat/availability')return json({data:{available:false,codeAvailable:false}});
 if(url.pathname.startsWith('/api/v1/forecasts/cadence/')){
  const snapshot=Object.values(byKind).find(row=>row.id===url.pathname.split('/').at(-1));return json(snapshot?{data:snapshot}:{error:'Missing simulation snapshot'},snapshot?200:404);
 }
 if(url.pathname.startsWith('/api/'))return json({error:'Real APIs are disabled in this fixture'},503);
 const upstream=http.request({hostname:'127.0.0.1',port:5336,path:request.url,method:request.method,headers:{...request.headers,host:'127.0.0.1:5336'}},next=>{response.writeHead(next.statusCode??502,next.headers);next.pipe(response);});
 upstream.on('error',()=>{if(!response.headersSent)json({error:'Start the isolated production frontend on 5336'},502);});
 response.on('close',()=>upstream.destroy());request.pipe(upstream);
});
server.listen(5337,'127.0.0.1',()=>console.log('SIMULATION ONLY: http://127.0.0.1:5337 (no real collection or prediction data)'));
