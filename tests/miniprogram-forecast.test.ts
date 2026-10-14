import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';
import {buildForecastSnapshot,forecastWindows,referenceForecast,FORECAST_RULE_VERSION,FORECAST_MODEL_VERSION} from '../src/lib/forecast';
import type {ForecastCase,ForecastPublicData,ForecastSnapshot,ForecastOutcome} from '../src/lib/forecast';
import type {PublicData,Publication,Article,RadarEvent} from '../src/lib/types';

const require=createRequire(import.meta.url);
const mini=require('../miniprogram/utils/model.js');
const {validateBootstrap,createTransport,createWechatTransport}=require('../miniprogram/utils/transport.js');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const signalAt='2026-10-10T00:00:00Z',generatedAt='2026-10-10T02:00:00Z',now='2026-10-10T08:00:00Z';
const config={mode:'https',baseUrl:'https://public.example.org',cloudEnv:'',serviceName:''};

// 全部为隔离合成输入；概率由实际共享纯函数生成，不写库、不调用真实微信或采集接口。
function fixture(target:ForecastCase['target']='automatic_reset'):PublicData {
  const item:ForecastCase={id:'case-test',identity:'openai-status:fixture-test',title:'Codex usage consumed faster than expected',url:'https://status.openai.com/incidents/fixture-test',sourceId:'official-status',signalEvidenceIds:['signal-test'],target,signalAt,collectedAt:'2026-10-10T01:00:00Z',windows:forecastWindows(signalAt),status:'watching',coverage:{status:'unverified',sourceIds:['official-status'],reason:'合成覆盖未核验'},late:false,snapshotId:'snapshot-test',createdAt:generatedAt,updatedAt:generatedAt};
  const snapshot=buildForecastSnapshot({id:item.snapshotId,signature:'fixture-signature',case:item,generatedAt,evidenceCutoffAt:generatedAt,cases:[item],outcomes:[]});
  const forecasts:ForecastPublicData={status:'ready',ruleVersion:FORECAST_RULE_VERSION,modelVersion:FORECAST_MODEL_VERSION,generatedAt,cases:[{...item,snapshot,outcomes:[]}],reference:referenceForecast()};
  return {site:{name:'模钥重置雷达',description:'',autoPublish:true,version:1},serverTime:now,events:[],articles:[],publications:[],evidence:[],notices:[],activities:[],sources:[{id:'official-status',name:'官方状态',status:'healthy',lastSuccessAt:now}],forecasts};
}
function snapshot(data=fixture()):ForecastSnapshot {return data.forecasts!.cases[0].snapshot!;}
function addOutcome(data:PublicData,extra:Partial<ForecastOutcome>={}):ForecastOutcome {
  const c=data.forecasts!.cases[0],outcome:ForecastOutcome={id:'outcome-test',caseId:c.id,target:c.target,stage:'promised',evidenceIds:['outcome-evidence'],observedAt:'2026-10-10T07:00:00Z',announcementAt:'2026-10-10T06:00:00Z',relation:'explicit_source',relationVerified:true,actualDelivery:'unobserved',reason:'隔离合成公开公告，不代表个人到账',signature:'outcome-signature',...extra};
  c.outcomes.push(outcome);return outcome;
}
function addAnnouncement(data:PublicData,stage:'promised'|'in_progress'|'claimed_complete'='promised') {
  const article:Article={id:'article-test',eventId:'event-test',publicationId:'publication-test',title:'合成公开公告',summary:'明确发放声明',translation:'合成中文正文',category:'reset',version:1,status:'published',evidenceIds:['evidence-test'],publishedAt:generatedAt,updatedAt:generatedAt,sourcePublishedAt:generatedAt,historical:false};
  const event:RadarEvent={id:'event-test',title:article.title,version:1,status:'published',publicationId:article.publicationId,evidenceIds:['evidence-test'],updatedAt:generatedAt,actions:[{id:'action-test',kind:'automatic_reset',stage,scope:'public',eligibility:'所有账户',evidenceIds:['evidence-test'],statementAt:generatedAt}]};
  const publication:Publication={id:article.publicationId,eventId:event.id,articleId:article.id,event:structuredClone(event),article:structuredClone(article),publishedAt:generatedAt,cutoffAt:generatedAt,mode:'state_change',reason:'隔离合成公告，仅用于契约验证'};
  data.events.push(event);data.articles.push(article);data.publications.push(publication);
}

test('实际共享预测合同、固定快照和旧客户端数据都可读取',()=>{
  const data=fixture();
  assert.equal(mini.validateForecastSnapshot(snapshot(data)),true);
  assert.equal(mini.validateForecastPublicData(data.forecasts),true);
  assert.equal(validateBootstrap(data),true);
  delete data.forecasts;assert.equal(validateBootstrap(data),true);
});

test('辅助实验模型只用服务端快照，历史三例不会冒充当前预告，读取不修改输入',()=>{
  const data=fixture(),before=structuredClone(data),view=mini.currentForecast(data);
  assert.equal(view.probability24,'30%');assert.equal(view.probability48,'80%');
  assert.equal(view.sampleCount,3);assert.equal(view.referenceCount,3);assert.equal(view.observedSampleCount,0);
  assert.equal(view.signalTitle,'官方用量异常信号');assert.match(view.coverageText,/实验参考.*未核验/);
  assert.equal(view.window24,'2026-10-11 08:00');assert.equal(view.window48,'2026-10-12 08:00');
  assert.equal(view.path,'/pages/methodology/index?snapshot=snapshot-test');assert.deepEqual(data,before);
  data.forecasts!.cases=[];assert.equal(mini.currentForecast(data),null);
  assert.equal(mini.forecastReferenceModel(data.forecasts).sampleCount,3);
});

test('明确预告及进展优先；完成后的对应观察不再显示提前预测',()=>{
  for(const stage of ['promised','in_progress'] as const){const data=fixture();addAnnouncement(data,stage);assert.equal(mini.currentForecast(data),null,stage);}
  const data=fixture();data.forecasts!.cases[0].status='observed';assert.equal(mini.currentForecast(data),null);
});

test('首24小时后辅助当前观察隐藏双窗口概率，固定快照仍保留原值且刷新不重开窗口',()=>{
  const data=fixture(),fixed=snapshot(data),windows=structuredClone(fixed.windows);
  data.serverTime='2026-10-10T23:59:59.999Z';assert.ok(mini.currentForecast(data));
  data.serverTime=fixed.windows[24];assert.equal(mini.currentForecast(data),null);
  const view=mini.forecastSnapshotModel(fixed,data.serverTime);assert.equal(view.expired24,true);assert.equal(view.expired48,false);assert.equal(view.probability24,'30%');assert.equal(view.probability48,'80%');
  data.serverTime=fixed.windows[48];assert.equal(mini.currentForecast(data),null);assert.equal(mini.forecastSnapshotModel(fixed,data.serverTime).expired48,true);
  assert.deepEqual(fixed.windows,windows);
});

for(const condition of ['gap','snapshot-gap','paused','elapsed','observed','late','snapshot-late','failed-source','paused-source','delayed-source','missing-source','empty-source','unavailable','future-generated'] as const){
  test(`合成不可用条件 ${condition} 不出现在辅助当前观察`,()=>{
    const data=fixture(),c=data.forecasts!.cases[0],s=c.snapshot!;
    switch(condition){
      case 'gap':c.coverage.status='gap';break;case 'snapshot-gap':s.coverage.status='gap';break;
      case 'paused':case 'elapsed':case 'observed':c.status=condition;break;
      case 'late':c.late=true;break;case 'snapshot-late':s.late=true;break;
      case 'failed-source':data.sources[0].status='failed';break;case 'paused-source':data.sources[0].status='paused';break;case 'delayed-source':data.sources[0].status='delayed';break;
      case 'missing-source':data.sources=[];break;case 'empty-source':c.coverage.sourceIds=[];break;
      case 'unavailable':data.forecasts!.status='unavailable';break;case 'future-generated':data.serverTime='2026-10-10T00:30:00Z';break;
    }
    assert.equal(mini.currentForecast(data),null);
  });
}

test('重置卡样本不足保留空值，不显示零概率或套用额度实验',()=>{
  const data=fixture('banked_reset'),s=snapshot(data),view=mini.forecastSnapshotModel(s,now);
  assert.equal(mini.validateForecastSnapshot(s),true);assert.equal(mini.currentForecast(data),null);
  assert.equal(view.probability24,null);assert.equal(view.probability48,null);assert.equal(view.missing,true);assert.equal(view.referenceCount,0);assert.equal(view.interval24,'样本不足');
  assert.match(view.deliveryNote,/个人到账未观测/);
});

test('生成时已有对应公告或取消只作事后观察，已知公告不能伪装提前预测',()=>{
  for(const stage of ['promised','cancelled'] as const){
    const data=fixture(),c=data.forecasts!.cases[0];
    const outcome:ForecastOutcome={id:'known-outcome',caseId:c.id,target:c.target,stage,evidenceIds:['known-evidence'],observedAt:'2026-10-10T01:30:00Z',announcementAt:'2026-10-10T01:00:00Z',relation:'explicit_source',relationVerified:true,actualDelivery:'unobserved',reason:'合成已知公告',signature:'outcome-test'};
    c.snapshot=buildForecastSnapshot({id:c.snapshotId,signature:'known-test',case:c,generatedAt,evidenceCutoffAt:generatedAt,cases:[c],outcomes:[outcome]});
    assert.equal(c.snapshot.basis,'already_known');assert.equal(mini.validateForecastSnapshot(c.snapshot),true);assert.equal(mini.currentForecast(data),null);
    const view=mini.forecastSnapshotModel(c.snapshot,now);assert.equal(view.probability24,null);assert.equal(view.probability48,null);assert.equal(view.basisText,'已知公告，非提前预测');
  }
});

test('快照概率、区间、窗口与冻结标识错误时阻止渲染',()=>{
  const invalid:((s:any)=>void)[]=[s=>s.p24='30%',s=>s.p24=NaN,s=>s.p48=1.1,s=>s.p24=.9,s=>s.interval24=[.8,.2],s=>s.windows[24]='2026-10-11T01:00:00Z',s=>delete s.title,s=>delete s.url,s=>delete s.sourceId,s=>s.sampleCount=4,s=>s.trainingApplied=true,s=>s.calibrated=true,s=>s.basis='already_known'];
  for(const mutate of invalid){const s=structuredClone(snapshot());mutate(s);assert.equal(mini.validateForecastSnapshot(s),false);assert.equal(mini.forecastSnapshotModel(s,now),null);}
  for(const mutate of [(d:ForecastPublicData)=>d.cases[0].snapshot!.caseId='wrong',(d:ForecastPublicData)=>d.cases[0].snapshot!.id='wrong',(d:ForecastPublicData)=>d.cases.push(structuredClone(d.cases[0]))]){const f=fixture().forecasts!;mutate(f);assert.equal(mini.validateForecastPublicData(f),false);}
});

test('实时结局仅作为观察展示，不被计入已采用样本或宣称准确率',()=>{
  const s=snapshot();s.trainingSampleIds=['observation-a','observation-b'];
  const view=mini.forecastSnapshotModel(s,now);assert.equal(view.observedSampleCount,2);assert.equal(view.sampleCount,3);assert.equal(view.probability24,'30%');
  const template=readFileSync(resolve(root,'miniprogram/pages/methodology/index.wxml'),'utf8');
  assert.match(template,/尚未用于概率训练/);assert.match(template,/不是准确率/);assert.match(template,/个人到账|deliveryNote/);
});

function mockTransport(body:unknown,statusCode=200){
  const calls:any[]=[];
  const wxApi={request(options:any){calls.push(options);queueMicrotask(()=>options.success({statusCode,data:body}));return {abort(){}};}};
  return {request:createTransport(wxApi,config),privateRequest:createWechatTransport(wxApi,config),calls};
}
test('公共预测接口使用匿名GET，列表与固定记录读取正确合同',async()=>{
  const data=fixture(),s=snapshot(data),list=mockTransport({data:data.forecasts});
  assert.deepEqual((await list.request('/api/v1/forecasts').promise).data,data.forecasts);
  const fixed=mockTransport({data:s});assert.deepEqual((await fixed.request('/api/v1/forecasts/snapshot-test').promise).data,s);
  for(const call of [...list.calls,...fixed.calls]){assert.equal(call.method,'GET');assert.equal(call.header.Authorization,undefined);assert.equal(call.data,undefined);}
});

test('固定记录不接受旧包装、其他记录或异常概率；管理路径与越界路径不发送',async()=>{
  for(const body of [{data:{case:fixture().forecasts!.cases[0],snapshot:snapshot(),outcomes:[]}},{data:{...snapshot(),id:'wrong'}},{data:{...snapshot(),p24:2}}]){const mock=mockTransport(body);await assert.rejects(mock.request('/api/v1/forecasts/snapshot-test').promise,/格式不完整/);}
  for(const path of ['/api/admin/forecasts','/api/v1/forecasts/../admin','/api/v1/forecasts/snapshot-test?current=1','/api/v1/forecasts/.hidden']){const mock=mockTransport({data:snapshot()});await assert.rejects(mock.request(path).promise,/不受支持/);assert.equal(mock.calls.length,0);}
  const mock=mockTransport({data:snapshot()});await assert.rejects(mock.privateRequest('/api/v1/forecasts/snapshot-test',{sessionToken:'fixture-not-real'}).promise,/不受支持/);assert.equal(mock.calls.length,0);
});

type NativePage=Record<string,any> & {data:Record<string,any>;setData:(patch:Record<string,unknown>)=>void};
function nativeHarness(data=fixture(),publicApi:(path:string)=>{promise:Promise<unknown>;abort:()=>void}=()=>({promise:Promise.reject(new Error('合成接口失败')),abort(){}})){
  const listeners=new Set<(state:any)=>void>(),calls:string[]=[],ui:{navigations:string[];copies:string[]}={navigations:[],copies:[]};
  const app={publicApi(path:string){calls.push(path);return publicApi(path);},preferences:{snapshot(){return {preferences:mini.preferenceDefaults,read:[]};}},client:{subscribe(fn:(state:any)=>void){listeners.add(fn);fn({data,receivedAt:Date.now(),error:''});return()=>listeners.delete(fn);},getState(){return {data,receivedAt:Date.now(),error:''};}}};
  function page(name:string,query:Record<string,string>={},autoShow=true){
    let definition:any;const cache=new Map<string,{exports:any}>();
    function load(filename:string):any {if(cache.has(filename))return cache.get(filename)!.exports;const module={exports:{}};cache.set(filename,module);const sandbox={module,exports:module.exports,Page(value:any){definition=value;},getApp(){return app;},wx:{navigateTo({url}:{url:string}){ui.navigations.push(url);},setClipboardData({data}:{data:string}){ui.copies.push(data);},showShareMenu(){},hideShareMenu(){},showToast(){},stopPullDownRefresh(){}},setInterval,clearInterval,Date,require(path:string){const file=resolve(dirname(filename),path.endsWith('.js')?path:`${path}.js`);assert.ok(file.startsWith(resolve(root,'miniprogram')+'/'));return load(file);}};new Script(readFileSync(filename,'utf8'),{filename}).runInNewContext(sandbox);return module.exports;}
    load(resolve(root,`miniprogram/pages/${name}/index.js`));assert.ok(definition);
    const instance={...definition,data:structuredClone(definition.data||{}),setData(patch:Record<string,unknown>){Object.assign(this.data,patch);}} as NativePage;
    instance.onLoad?.(query);if(autoShow)instance.onShow?.();return instance;
  }
  return {page,calls,ui,get subscriptions(){return listeners.size;},replace(next:PublicData,error=''){data=next;listeners.forEach(fn=>fn({data,receivedAt:Date.now(),error}));}};
}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('实际首页只显示当前公开预告，历史实验不变成下次倒计时或分享目标',()=>{
  const h=nativeHarness(),page=h.page('home');assert.equal(page.data.forecast,null);assert.equal(page.data.sharePath,'');assert.match(page.data.waitingText,/等待下一次预告.*暂无新的时间依据/);
  const next=fixture();addAnnouncement(next);h.replace(next);assert.equal(page.data.forecast,null);assert.ok(page.data.pending);assert.equal(page.data.pending.countdown,'时间待明确');assert.equal(page.data.sharePath,'/pages/detail/index?publicationId=publication-test');assert.match(page.data.shareLabel,/公告/);page.onUnload();assert.equal(h.subscriptions,0);
  const template=readFileSync(resolve(root,'miniprogram/pages/home/index.wxml'),'utf8');assert.doesNotMatch(template,/forecast\.probability|forecast &&|实验预测/);assert.match(template,/timeline\.title/);assert.match(template,/北京时间/);
});

const outlookDeadline='2026-10-10T13:00:00Z';
const outlookAction=(extra:Record<string,unknown>={})=>({actionId:'live-reset',eventId:'live-event',publicationId:'live-publication',kind:'automatic_reset',stage:'promised',statementAt:'2026-10-10T06:00:00Z',expectedAt:outlookDeadline,timeNote:'公开归档换算时间，实际发放待确认。',...extra});
function withOutlook(data:PublicData,value:unknown){(data.forecasts as unknown as {outlook:unknown}).outlook=value;return data;}

test('原生首页优先服务端outlook：公开预告倒计时由服务器时间计算，历史概率不参与',()=>{
  const data=withOutlook(fixture(),{status:'scheduled',active:outlookAction(),evidenceCutoffAt:now}),before=structuredClone(data),view=mini.resetOutlookModel(data);
  assert.equal(view.status,'scheduled');assert.equal(view.active.actionId,'live-reset');assert.equal(mini.announcementCountdown(view.active,data.serverTime).label,'预计5小时内');
  const h=nativeHarness(data),page=h.page('home');assert.equal(page.data.pending.countdown,'预计5小时内');assert.equal(page.data.pending.time,'2026-10-10 21:00');assert.equal(page.data.pending.counting,true);assert.equal(page.data.forecast,null);assert.equal(page.data.sharePath,'/pages/detail/index?publicationId=live-publication');assert.ok(page._countdownTimer);assert.deepEqual(data,before);
  page.onHide();assert.equal(page._countdownTimer,null);assert.equal(h.subscriptions,0);page.onShow();assert.ok(page._countdownTimer);page.onUnload();assert.equal(page._countdownTimer,null);assert.equal(h.subscriptions,0);
});

test('服务端完成转为24小时结果计时，取消结束计时，不回退旧预告、cases或cadence',()=>{
  for(const status of ['completed','cancelled'] as const){
    const data=fixture();addAnnouncement(data);const active=outlookAction(),h=nativeHarness(withOutlook(data,{status:'scheduled',active})),page=h.page('home');assert.ok(page._countdownTimer);
    const next=fixture();addAnnouncement(next);
    const resolved=outlookAction({stage:status==='completed'?'claimed_complete':'cancelled',statementAt:'2026-10-10T09:00:00Z',resolvedAt:'2026-10-10T09:00:00Z',announcedAt:active.statementAt,announcedDeadline:active.expectedAt});
    next.serverTime='2026-10-10T09:00:00Z';withOutlook(next,{status,latestCompletion:status==='completed'?resolved:undefined,lastResolved:resolved});
    if(status==='completed'){
      const p=next.publications[0];p.id='live-publication';p.eventId=p.event.id='live-event';p.event.publicationId=p.id;p.publishedAt=next.serverTime;
      p.event.actions[0]={...p.event.actions[0],id:'live-reset',stage:'claimed_complete',statementAt:next.serverTime};
      p.article.eventId=p.eventId;p.article.publicationId=p.id;p.article.publishedAt=next.serverTime;
      next.events=[structuredClone(p.event)];next.articles=[structuredClone(p.article)];
    }
    h.replace(next);assert.equal(page.data.pending,null);assert.equal(page.data.forecast,null);assert.equal(page.data.outlookStatus,status);assert.match(page.data.waitingText,/等待下一次预告/);
    if(status==='completed'){assert.ok(page._countdownTimer);assert.equal(page.data.timeline.completed,true);assert.equal(page.data.latest.elapsed,'刚刚');assert.equal(page.data.latest.title,'公告称已重置用量');assert.equal(page.data.sharePath,'/pages/detail/index?publicationId=live-publication');}
    else assert.equal(page._countdownTimer,null);
    page.onUnload();
  }
});

test('预告截止边界转等待确认，进行中也不凭时间自动完成或重新开窗口',()=>{
  for(const stage of ['promised','in_progress']){
    const data=withOutlook(fixture(),{status:stage==='promised'?'scheduled':'in_progress',active:outlookAction({stage})}),before=structuredClone(data);
    assert.equal(mini.announcementCountdown(outlookAction({stage}),outlookDeadline).status,'expired');
    data.serverTime=outlookDeadline;assert.equal(mini.resetOutlookModel(data).status,'overdue');
    const h=nativeHarness(data),page=h.page('home');assert.equal(page.data.pending.countdown,'已过预计时间 · 等待确认');assert.equal(page.data.pending.counting,false);assert.equal(page._countdownTimer,null);assert.equal(page.data.latest,null);assert.equal(page.data.forecast,null);
    h.replace(data);assert.equal(page.data.pending.countdown,'已过预计时间 · 等待确认');assert.equal((data.forecasts as unknown as {outlook:{active:{stage:string}}}).outlook.active.stage,stage);assert.equal(data.forecasts!.cases[0].snapshot!.p24,before.forecasts!.cases[0].snapshot!.p24);page.onUnload();
  }
});

test('无明确时间的服务端预告只显示时间待明确，不猜时区或伪造倒计时',()=>{
  const data=withOutlook(fixture(),{status:'announced',active:outlookAction({expectedAt:undefined,timeNote:'原帖时区尚未明确'})}),h=nativeHarness(data),page=h.page('home');
  assert.equal(page.data.outlookStatus,'announced');assert.equal(page.data.pending.countdown,'时间待明确');assert.equal(page.data.pending.timed,false);assert.equal(page.data.pending.time,'');assert.equal(page.data.pending.timeNote,'原帖时区尚未明确');assert.equal(page._countdownTimer,null);page.onUnload();
});

test('outlook监测中、错误或不完整时不复活客户端旧预告，缺字段才采用公开动作降级',()=>{
  for(const outlook of [{status:'monitoring'},{status:'invalid',active:outlookAction()},{status:'scheduled',active:outlookAction({expectedAt:'unknown'})},{status:'scheduled',active:outlookAction({stage:'claimed_complete'})},null]){
    const data=fixture();addAnnouncement(data);withOutlook(data,outlook);assert.equal(mini.resetOutlookModel(data).active,null);
    const h=nativeHarness(data),page=h.page('home');assert.equal(page.data.pending,null);assert.equal(page.data.forecast,null);assert.match(page.data.waitingText,/等待下一次预告/);page.onUnload();
  }
  const old=fixture();addAnnouncement(old);assert.equal(mini.resetOutlookModel(old).status,'announced');assert.equal(mini.resetOutlookModel(old).active.actionId,'action-test');
  delete old.forecasts;assert.equal(mini.resetOutlookModel(old).active.actionId,'action-test');
});

test('旧接口更早无时刻预告保留历史但不遮较新完成，延伸到完成后安排继续显示',()=>{
  const old=fixture();addAnnouncement(old);const later=structuredClone(old.publications[0]);later.id='later-publication';later.eventId='later-event';later.articleId='later-article';later.event.id=later.eventId;later.event.publicationId=later.id;later.event.actions[0]={...later.event.actions[0],id:'later-action',stage:'claimed_complete',statementAt:'2026-10-10T06:00:00Z'};later.article.id=later.articleId;later.article.eventId=later.eventId;later.article.publicationId=later.id;
  old.publications.push(later);old.events.push(later.event);old.articles.push(later.article);const before=structuredClone(old),view=mini.resetOutlookModel(old);assert.equal(view.active,null);assert.equal(view.status,'completed');assert.equal(view.latestCompletion.actionId,'later-action');assert.deepEqual(old,before);assert.equal(old.publications[0].event.actions[0].stage,'promised');
  const h=nativeHarness(old),page=h.page('home');assert.equal(page.data.pending,null);assert.equal(page.data.latest.path,'/pages/detail/index?publicationId=later-publication');assert.equal(page.data.forecast,null);page.onUnload();
  old.publications[0].event.actions[0].expectedAt='2026-10-10T07:00:00Z';const extended=mini.resetOutlookModel(old);assert.equal(extended.active.actionId,'action-test');assert.equal(extended.status,'overdue');assert.equal(old.publications[0].event.actions[0].stage,'promised');
  assert.equal(mini.announcementCountdown({...outlookAction(),stage:'claimed_complete'},now).status,'inactive');assert.equal(mini.announcementCountdown({...outlookAction(),stage:'cancelled'},now).status,'inactive');
});

test('旧接口只有当前同action发布版本的完成或取消才能关闭自己的预告',()=>{
  for(const stage of ['claimed_complete','cancelled'] as const){
    const data=fixture();addAnnouncement(data);const previous=structuredClone(data.publications[0]);
    const latest=structuredClone(previous);latest.id='updated-publication';latest.event.publicationId=latest.id;latest.event.actions[0].stage=stage;latest.event.actions[0].statementAt='2026-10-10T06:00:00Z';latest.article.publicationId=latest.id;latest.publishedAt='2026-10-10T06:01:00Z';
    data.publications.push(latest);data.events[0].publicationId=latest.id;data.articles[0].publicationId=latest.id;
    const view=mini.resetOutlookModel(data);assert.equal(view.active,null);assert.equal(view.latestCompletion?.actionId??null,stage==='claimed_complete'?'action-test':null);assert.deepEqual(data.publications[0],previous);
    const h=nativeHarness(data),page=h.page('home');assert.equal(page.data.pending,null);assert.equal(page.data.forecast,null);page.onUnload();
  }
});

test('旧接口待执行及完成记录都排除未来或无效声明、未来或无效发布时间',()=>{
  for(const stage of ['promised','in_progress','claimed_complete'] as const){
    for(const invalid of ['future-statement','invalid-statement','future-publication','invalid-publication'] as const){
      const data=fixture();addAnnouncement(data,stage);const publication=data.publications[0];
      if(invalid==='future-statement')publication.event.actions[0].statementAt='2026-10-10T09:00:00Z';
      if(invalid==='invalid-statement')publication.event.actions[0].statementAt='invalid';
      if(invalid==='future-publication')publication.publishedAt='2026-10-10T09:00:00Z';
      if(invalid==='invalid-publication')publication.publishedAt='invalid';
      assert.equal(mini.upcomingActions(data).length,0,`${stage}/${invalid}`);const view=mini.resetOutlookModel(data);assert.equal(view.active,null,`${stage}/${invalid}`);assert.equal(view.latestCompletion,null,`${stage}/${invalid}`);
    }
  }
  const data=fixture();addAnnouncement(data);for(const current of ['invalid','','2026-10-10T01:00:00Z'])assert.equal(mini.upcomingActions(data,current).length,0,current);
  data.serverTime='invalid';assert.equal(mini.upcomingActions(data).length,0);assert.equal(mini.resetOutlookModel(data).active,null);assert.equal(mini.resetOutlookModel(data).latestCompletion,null);
});

test('实际方法页将历史参考放在方法说明，固定查询失败不会回退当前预测',async()=>{
  const h=nativeHarness(),page=h.page('methodology',{snapshot:'snapshot-old'});await flush();
  assert.deepEqual(h.calls,['/api/v1/forecasts/snapshot-old']);assert.equal(page.data.forecast,null);assert.equal(page.data.reference,null);assert.match(page.data.fixedError,/合成接口失败/);
  h.replace(fixture());assert.equal(page.data.forecast,null);assert.equal(page.data.reference,null);assert.equal(page.onShareAppMessage().path,'/pages/methodology/index?snapshot=snapshot-old');page.onUnload();assert.equal(h.subscriptions,0);
  const regular=h.page('methodology');assert.equal(regular.data.reference.sampleCount,3);assert.match(regular.data.reference.note,/不是当前发放预告/);regular.onUnload();
});

test('固定方法页保留冻结标题、窗口和概率，新客户端输入不能覆盖旧记录',async()=>{
  const frozen=snapshot();frozen.title='冻结用量异常信号';frozen.id='snapshot-old';
  const h=nativeHarness(fixture(),()=>({promise:Promise.resolve({data:frozen}),abort(){}})),page=h.page('methodology',{snapshot:frozen.id});await flush();
  assert.equal(page.data.forecast.signalTitle,'冻结用量异常信号');assert.equal(page.data.forecast.probability24,'30%');assert.equal(page.data.forecast.path,'/pages/methodology/index?snapshot=snapshot-old');
  const fresh=fixture();snapshot(fresh).title='新的信号';snapshot(fresh).p24=.4;h.replace(fresh);assert.equal(page.data.forecast.signalTitle,'冻结用量异常信号');assert.equal(page.data.forecast.probability24,'30%');assert.equal(page.data.reference,null);
  assert.equal(h.ui.copies.length,0);page.copySignal();assert.deepEqual(h.ui.copies,[frozen.url]);assert.equal(page.onShareAppMessage().path,'/pages/methodology/index?snapshot=snapshot-old');page.onUnload();
});

test('页面隐藏会取消固定读取且忽略迟到响应，无效编号不请求',async()=>{
  let complete!:(result:unknown)=>void,aborts=0;const promise=new Promise(resolve=>complete=resolve);
  const h=nativeHarness(fixture(),()=>({promise,abort(){aborts++;}})),page=h.page('methodology',{snapshot:'snapshot-test'});assert.equal(page.data.fixedLoading,true);
  page.onHide();assert.equal(aborts,1);assert.equal(h.subscriptions,0);complete({data:snapshot()});await flush();assert.equal(page.data.forecast,null);assert.equal(page.data.fixedLoading,false);
  const bad=h.page('methodology',{snapshot:'../admin'});await flush();assert.equal(h.calls.length,1);assert.match(bad.data.fixedError,/链接无效/);bad.onUnload();
});

test('空概率区分资料晚采、已知公告与真正样本不足',()=>{
  const data=fixture(),c=data.forecasts!.cases[0];
  const late=buildForecastSnapshot({id:'snapshot-late',signature:'late',case:c,generatedAt:'2026-10-11T01:00:00Z',evidenceCutoffAt:'2026-10-11T01:00:00Z',cases:[c],outcomes:[]});
  const known=buildForecastSnapshot({id:'snapshot-known',signature:'known',case:c,generatedAt:'2026-10-10T07:00:00Z',evidenceCutoffAt:'2026-10-10T07:00:00Z',cases:[c],outcomes:[addOutcome(data)]});
  for(const s of [late,known]){const view=mini.forecastSnapshotModel(s,now);assert.equal(view.emptyProbabilityText,'不作提前预测');assert.equal(view.interval24,'不适用');assert.equal(view.interval48,'不适用');assert.equal(view.sampleCount,3);}
  assert.equal(mini.forecastSnapshotModel(snapshot(fixture('banked_reset')),now).emptyProbabilityText,'样本不足');
});

test('后续结局独立显示阶段、双时间与原信号窗口，不修改冻结概率',()=>{
  const data=fixture(),fixed=structuredClone(snapshot(data)),before=structuredClone(fixed);
  addOutcome(data,{id:'promise',stage:'promised',announcementAt:'2026-10-10T06:00:00Z',observedAt:'2026-10-10T07:00:00Z'});
  addOutcome(data,{id:'progress',stage:'in_progress',announcementAt:'2026-10-11T06:00:00Z',observedAt:'2026-10-11T07:00:00Z'});
  addOutcome(data,{id:'done',stage:'claimed_complete',announcementAt:'2026-10-12T06:00:00Z',observedAt:'2026-10-12T07:00:00Z'});
  addOutcome(data,{id:'cancel',stage:'cancelled',announcementAt:'2026-10-12T08:00:00Z',observedAt:'2026-10-12T09:00:00Z'});
  addOutcome(data,{id:'unknown',stage:'unknown',announcementAt:undefined,observedAt:'2026-10-12T10:00:00Z',relation:'unmatched',relationVerified:false,reason:'缺少可核对公告，结局未知'});
  const model=mini.forecastOutcomeModel(fixed,data.forecasts),byId=new Map(model.entries.map((entry:any)=>[entry.id,entry]));
  assert.equal(model.available,true);assert.equal(model.entries[0].id,'unknown');
  assert.equal((byId.get('promise') as any).stage,'发放预告');assert.equal((byId.get('promise') as any).windowText,'24小时内');
  assert.equal((byId.get('progress') as any).stage,'进行中');assert.equal((byId.get('progress') as any).windowText,'24—48小时内');
  assert.equal((byId.get('done') as any).stage,'公告称已完成');assert.equal((byId.get('done') as any).windowText,'窗口外');
  assert.equal((byId.get('cancel') as any).stage,'已取消');assert.equal((byId.get('unknown') as any).stage,'结局未知');assert.equal((byId.get('unknown') as any).windowText,'窗口位置未知');
  assert.equal((byId.get('promise') as any).announcementAt,'2026-10-10 14:00');assert.equal((byId.get('promise') as any).observedAt,'2026-10-10 15:00');
  assert.match(model.note,/后续记录，不改原快照；个人到账未观测/);assert.deepEqual(fixed,before);
});

test('结局缺失、当前接口不可用与真实未知分开，错误记录不能冒充无公告',()=>{
  const data=fixture(),fixed=snapshot(data);
  const empty=mini.forecastOutcomeModel(fixed,data.forecasts);assert.equal(empty.available,true);assert.equal(empty.entries.length,0);assert.match(empty.message,/不代表没有公告/);
  for(const f of [undefined,{...data.forecasts,status:'unavailable'},{...data.forecasts,cases:[]}]){const view=mini.forecastOutcomeModel(fixed,f);assert.equal(view.available,false);assert.match(view.message,/暂不可用.*不能据此判断没有公告/);}
  const invalid=fixture();addOutcome(invalid,{target:'banked_reset'});assert.equal(mini.validateForecastPublicData(invalid.forecasts),false);assert.equal(mini.forecastOutcomeModel(fixed,invalid.forecasts).available,false);
  const unknown=fixture();addOutcome(unknown,{stage:'unknown',announcementAt:undefined,relation:'unmatched',relationVerified:false,invalidated:true});
  const row=mini.forecastOutcomeModel(fixed,unknown.forecasts).entries[0];assert.equal(row.stage,'结局已失效，保持未知');assert.equal(row.windowText,'窗口位置未知');
});

for(const order of ['订阅先到','固定记录先到'])test(`实际方法页 ${order} 都能显示新结局，快照保持原值`,async()=>{
  const data=fixture();addOutcome(data);let complete!:(value:unknown)=>void;const promise=new Promise(resolve=>complete=resolve);
  const fixed=structuredClone(snapshot(data));fixed.id='snapshot-old';fixed.title='冻结中文信号';
  const h=nativeHarness(data,()=>({promise,abort(){}})),page=h.page('methodology',{snapshot:fixed.id},order==='订阅先到');
  complete({data:fixed});await flush();
  if(order==='固定记录先到'){assert.equal(page.data.outcomes.available,false);page.onShow();}
  assert.equal(page.data.outcomes.available,true);assert.equal(page.data.outcomes.entries[0].stage,'发放预告');
  const frozenView=structuredClone(page.data.forecast),updated=fixture();snapshot(updated).title='新中文标题';snapshot(updated).p24=.4;updated.forecasts!.cases[0].status='observed';addOutcome(updated,{stage:'claimed_complete'});h.replace(updated);
  assert.equal(page.data.outcomes.entries[0].stage,'公告称已完成');assert.deepEqual(structuredClone(page.data.forecast),frozenView);assert.equal(page.data.forecast.probability24,'30%');assert.equal(page.onShareAppMessage().path,'/pages/methodology/index?snapshot=snapshot-old');
  h.replace(updated,'合成网络中断');assert.equal(page.data.outcomes.available,false);assert.match(page.data.outcomes.message,/暂不可用/);assert.deepEqual(structuredClone(page.data.forecast),frozenView);
  page.onUnload();assert.equal(h.subscriptions,0);
});

test('预测用户文字为中文，历史参考与卡样本不足有明确说明，未新增概率微信推送',()=>{
  const home=readFileSync(resolve(root,'miniprogram/pages/home/index.wxml'),'utf8'),rules=readFileSync(resolve(root,'miniprogram/pages/methodology/index.wxml'),'utf8');
  assert.doesNotMatch(home+rules,/experimental_seed|verified_live|automatic_reset|banked_reset|already_known/);assert.match(rules,/样本不足/);assert.match(rules,/固定预测记录/);assert.match(rules,/首次合格信号|windowNote/);
  const code=readFileSync(resolve(root,'miniprogram/pages/methodology/index.js'),'utf8');assert.doesNotMatch(code,/requestSubscribeMessage|\/api\/wechat\//);
});
