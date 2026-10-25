const {validateBootstrap}=require('./transport');
const {currentModel}=require('./cadence');
const KEY='radar:public-home:v1', MAX_AGE=86400000, MAX_BYTES=262144;
const pick=(value,keys)=>Object.fromEntries(keys.split(' ').filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
const action=value=>pick(value,'id kind stage eligibility scope expectedAt timeNote evidenceIds statementAt evidenceQuote');
const article=value=>pick(value,'id eventId title summary translation category version status publicationId evidenceIds contextEvidenceIds publishedAt updatedAt publicationMode contentOrigin reviewStatus reviewReasons sourcePublishedAt historical');
const event=value=>({...pick(value,'id title version status mergedInto evidenceIds publicationId updatedAt'),actions:value.actions.map(action)});
// Only public read projections enter storage; private reader/session state never does.
function projection(data){
 const result={site:pick(data.site,'name description autoPublish version'),serverTime:data.serverTime,
  sources:data.sources.map(s=>pick(s,'id name status lastSuccessAt')),events:data.events.map(event),articles:data.articles.map(article),
  publications:data.publications.map(p=>({...pick(p,'id eventId articleId cutoffAt publishedAt reason mode contentOrigin'),article:article(p.article),event:event(p.event)})),
  evidence:data.evidence.map(e=>pick(e,'id sourceId messageId url text parentId publishedAt collectedAt hash contextComplete historical provenance textOrigin metadata')),
  notices:data.notices.map(n=>pick(n,'id eventId publicationId semanticKey title summary categories status createdAt origin body')),
  activities:data.activities.map(a=>({...pick(a,'id title timezone startsOn days rules version showOnHome'),items:a.items.map(i=>pick(i,'day articleId eventId'))}))};
 if(data.forecasts)result.forecasts=pick(data.forecasts,'ruleVersion modelVersion generatedAt reference outlook watch referenceCadence status cases cadence cadenceByKind cadenceEvaluationByKind cadenceHistory cadenceOutcomes cadenceHorizonOutcomes');
 // Public metadata is nested. Remove unexpected credential fields even in a malformed response.
 return JSON.parse(JSON.stringify(result,(key,value)=>/^(?:authorization|cookie|password|secret|appsecret|token|sessiontoken|apikey|privatekey|nonce|openid|unionid|code)$/i.test(key)?undefined:value));
}
const connection=config=>JSON.stringify([config.mode,config.baseUrl||'',config.cloudEnv||'',config.serviceName||'']);
const compatible='home-v1:'+currentModel;
function validEnvelope(value,config,now){
 try{
  if(!value||value.schema!==compatible||value.connection!==connection(config)||typeof value.version!=='string'||!value.version||typeof value.contentVersion!=='string'
   ||!Number.isFinite(value.savedAt)||now<value.savedAt||now-value.savedAt>=MAX_AGE||JSON.stringify(value).length*3>MAX_BYTES||!validateBootstrap(value.data))return false;
  const data=value.data,events=new Set(data.events.map(e=>e.id)),articles=new Set(data.articles.map(a=>a.id));
  return data.publications.every(p=>events.has(p.eventId)&&articles.has(p.articleId))&&Number.isFinite(Date.parse(data.serverTime))&&Date.parse(data.serverTime)<=value.savedAt+300000;
 }catch(_){return false;}
}
function createPublicSnapshot(wxApi,config,{now=Date.now,timers={setTimeout,clearTimeout}}={}){
 let queued,writing=false;
 function flush(){
  if(writing||!queued||typeof wxApi.setStorage!=='function')return;
  const value=queued;queued=undefined;writing=true;
  const finish=()=>{writing=false;flush();};
  try{wxApi.setStorage({key:KEY,data:value,success:finish,fail:finish});}catch(_){finish();}
 }
 return{
  load(){
   if(typeof wxApi.getStorage!=='function')return Promise.resolve(null);
   return new Promise(resolve=>{
    let settled=false;const finish=value=>{if(settled)return;settled=true;timers.clearTimeout(timeout);resolve(value);};
    const timeout=timers.setTimeout(()=>finish(null),200);
    try{wxApi.getStorage({key:KEY,success:({data})=>{try{finish(validEnvelope(data,config,now())?{...data,data:projection(data.data)}:null);}catch(_){finish(null);}},fail:()=>finish(null)});}catch(_){finish(null);}
   });
  },
  save(state){
   try{
    const value={schema:compatible,connection:connection(config),version:state.version,contentVersion:state.contentVersion||'',savedAt:state.receivedAt,data:projection(state.data)};
    if(!validEnvelope(value,config,now()))return;
    queued=value;flush();
   }catch(_){/* Storage is optional; network and navigation remain available. */}
  }
 };
}
module.exports={createPublicSnapshot};
