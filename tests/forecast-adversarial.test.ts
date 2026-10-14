import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {Evidence, Source} from '../src/lib/types';
import {
  FORECAST_REFERENCE_SAMPLES, betaQuantile, forecastEstimate, forecastWindows, forecastSourceAvailable,
  qualifyForecastSignal, matchForecastCase, referenceForecast, selectTrainingSamples,
  buildForecastSnapshot, publicForecastCaseProjection, effectiveForecastOutcome,
  type ForecastCase, type ForecastOutcome, type ForecastSnapshot, type ForecastPublicData,
} from '../src/lib/forecast';
import {currentForecast, forecastRevision, intervalText, probabilityText} from '../src/lib/forecast-display';

// Independent synthetic boundary fixtures. Historical reference expectations are
// frozen source-time research, never claimed to be prior live forecasts.
const at='2026-10-10T04:00:00.000Z';
const atMs=Date.parse(at);
const hour=(n:number)=>new Date(atMs+n*3_600_000).toISOString();
const source=(extra:Partial<Source>={}):Source=>({id:'official-status',name:'合成状态来源',kind:'status',url:'https://status.openai.com/api/v2/incidents.json',enabled:true,validated:true,intervalMinutes:5,version:1,status:'healthy',lastSuccessAt:hour(1),...extra});
const evidence=(text:string,extra:Partial<Evidence>={}):Evidence=>({id:'signal',sourceId:'official-status',messageId:'incident:update',url:'https://status.openai.com/incidents/QAIncident',text,publishedAt:at,collectedAt:hour(1),hash:text,contextComplete:true,historical:false,provenance:'official',textOrigin:'structured',metadata:{title:'Codex usage issue',status:'investigating'},...extra});
const forecastCase=(extra:Partial<ForecastCase>={}):ForecastCase=>({id:'case',identity:'openai-status:QAIncident',title:'合成额度异常',url:'https://status.openai.com/incidents/QAIncident',sourceId:'official-status',signalEvidenceIds:['signal'],target:'automatic_reset',signalAt:at,collectedAt:hour(1),windows:forecastWindows(at),status:'watching',coverage:{status:'verified',sourceIds:['official-status','reset-archive'],reason:'合成已确认完整覆盖，不代表真实来源'},late:false,snapshotId:'snapshot',createdAt:hour(1),updatedAt:hour(1),...extra});
const outcome=(extra:Partial<ForecastOutcome>={}):ForecastOutcome=>({id:'outcome',caseId:'case',target:'automatic_reset',stage:'claimed_complete',evidenceIds:['announcement'],publicationId:'synthetic-publication',eventId:'synthetic-event',observedAt:hour(7),announcementAt:hour(6),relation:'causal_unique',relationVerified:true,actualDelivery:'unobserved',reason:'合成公开公告，不代表个人到账',signature:'synthetic',...extra});
const announcement=(text:string,extra:Partial<Evidence>={})=>evidence(text,{id:'announcement',sourceId:'reset-archive',messageId:'announcement',url:'https://x.com/forecast_fixture/status/announcement',provenance:'archive',textOrigin:'original',metadata:undefined,publishedAt:hour(6),collectedAt:hour(7),...extra});
const approx=(actual:number,expected:number,tolerance=1e-7)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
const snapshot=(c=forecastCase(),generatedAt=hour(1),cutoff=generatedAt):ForecastSnapshot=>buildForecastSnapshot({id:'snapshot',signature:'synthetic-only',case:c,generatedAt,evidenceCutoffAt:cutoff,cases:[c],outcomes:[]});
const publicData=(c=forecastCase(),s:ForecastSnapshot|undefined=snapshot(c)):ForecastPublicData=>({status:'ready',ruleVersion:'synthetic-rule',modelVersion:'synthetic-model',generatedAt:hour(1),cases:[{...c,snapshot:s,outcomes:[]}],reference:referenceForecast()});

test('历史三例参考严格复算30/80%，可信区间不是准确率',()=>{
  const actual=forecastEstimate([1,2,0],'automatic_reset');
  assert.deepEqual(actual.prior,[.5,.5,1]);assert.deepEqual(actual.counts,[1,2,0]);assert.equal(actual.sampleCount,3);
  approx(actual.p24!,.3);approx(actual.p48!, .8);
  approx(actual.interval24![0],.0284708950871468);approx(actual.interval24![1],.716248320436587);
  // Beta(4,1) has CDF x^4: independent closed-form interval oracle.
  approx(actual.interval48![0],.025**.25);approx(actual.interval48![1],.975**.25);
  const reference=referenceForecast();assert.equal(reference.coverage,'unverified');assert.equal(reference.calibrated,false);
  assert.match(reference.note,/实验|参考/);assert.match(reference.note,/不是.*准确率|非.*准确率/);
  assert.ok(!('accuracy' in reference),'概率参考不能添加虚构准确率字段');
});
test('参考身份与时间保留冻结研究，不能升级为真实预测或已验证覆盖',()=>{
  const saved=JSON.parse(readFileSync(new URL('../outputs/implementation-qa/history-prediction-replay-20261010.json',import.meta.url),'utf8')) as {cases:{incident_id:string;signal_first_public_at:string;first_matched_announcement_public_at:string}[]};
  assert.deepEqual(FORECAST_REFERENCE_SAMPLES.map(s=>({id:s.id,signal:s.signalAt,announcement:s.announcementAt})),saved.cases.map(s=>({id:s.incident_id,signal:s.signal_first_public_at,announcement:s.first_matched_announcement_public_at})));
  assert.deepEqual(referenceForecast().sampleIds,FORECAST_REFERENCE_SAMPLES.map(s=>s.id));
});
test('重置卡不能借额度三例或仅先验显示概率',()=>{
  for(const counts of [[0,0,0],[1,2,0]] as [number,number,number][]){const estimate=forecastEstimate(counts,'banked_reset');assert.equal(estimate.p24,null);assert.equal(estimate.p48,null);assert.equal(estimate.interval24,null);assert.equal(estimate.interval48,null);}
  const empty=forecastEstimate([0,0,0],'automatic_reset');assert.equal(empty.p24,null);assert.equal(empty.p48,null);
});
test('分位数有可复算闭式边界，非法计数不能成为NaN或概率',()=>{
  approx(betaQuantile(.5,1,1),.5);approx(betaQuantile(.025,4,1),.025**.25);assert.equal(betaQuantile(0,4,1),0);assert.equal(betaQuantile(1,4,1),1);
  for(const counts of [[-1,0,0],[.5,0,0],[NaN,0,0],[Infinity,0,0]] as [number,number,number][])assert.throws(()=>forecastEstimate(counts,'automatic_reset'));
});
test('24/48小时固定在首次公开信号，不取采集、刷新或Resolved时刻',()=>{
  assert.deepEqual(forecastWindows(at),{24:hour(24),48:hour(48)});
  assert.deepEqual(forecastCase({collectedAt:hour(30),updatedAt:hour(47)}).windows,{24:hour(24),48:hour(48)});
  assert.throws(()=>forecastWindows('不明时间'));
});
test('停用、结构暂停和失败来源不能自动复活',()=>{
  const variants=[source({enabled:false}),source({validated:false}),source({publicationPaused:true,pauseReason:'structure'}),source({status:'paused'}),source({status:'failed'}),source({kind:'manual'})];
  for(const configured of variants){const before=structuredClone(configured);assert.equal(forecastSourceAvailable(configured,hour(1)),false);assert.equal(qualifyForecastSignal(evidence('Codex usage is being consumed faster than expected.'),configured),undefined);assert.deepEqual(configured,before,'只读判断不能更改来源开关');}
  assert.equal(forecastSourceAvailable(undefined,hour(1)),false);assert.equal(forecastSourceAvailable(source(),hour(1)),true);
});
test('过快消耗才能成为合格信号，普通错误/解决/意外reset不能偷换触发',()=>{
  assert.ok(qualifyForecastSignal(evidence('Codex usage is being consumed faster than expected.'),source()));
  for(const text of ['Codex service errors have been resolved.','Some Codex users may be experiencing unexpected usage limit resets.','Codex login requests are returning errors.','We have reset Codex usage limits for all accounts.'])assert.equal(qualifyForecastSignal(evidence(text),source()),undefined,text);
  assert.equal(qualifyForecastSignal(evidence('Codex usage is being consumed faster than expected.',{metadata:{status:'resolved'}}),source()),undefined);
  assert.equal(qualifyForecastSignal(evidence('Codex usage is being consumed faster than expected.',{provenance:'manual'}),source()),undefined);
  assert.equal(qualifyForecastSignal(evidence('Codex usage is being consumed faster than expected.',{contextComplete:false}),source()),undefined);
});
test('仅时间接近、同分类、祝贺里程碑不能把发卡或额度公告凑成故障补偿',()=>{
  const cases=[forecastCase()];
  for(const text of ['We have reset Codex usage limits for all paid accounts.','We are celebrating 40M Codex users. We have reset usage limits for all accounts.'])assert.equal(matchForecastCase(announcement(text),'automatic_reset',cases,[]),undefined,text);
  assert.equal(matchForecastCase(announcement('Due to the Codex usage bug, we will reset usage limits for all paid accounts.'),'banked_reset',cases,[]),undefined,'不同福利目标不能借同时间关联');
});
test('明确因果且唯一事件可关联，两个合理事件继续等待',()=>{
  const a=announcement('Due to the Codex usage bug, we will reset usage limits for all paid accounts.');
  assert.deepEqual(matchForecastCase(a,'automatic_reset',[forecastCase()],[]),{caseId:'case',relation:'causal_unique'});
  assert.equal(matchForecastCase(a,'automatic_reset',[forecastCase(),forecastCase({id:'other',identity:'openai-status:Other',url:'https://status.openai.com/incidents/Other'})],[]),undefined);
  assert.equal(matchForecastCase(a,'automatic_reset',[forecastCase({signalAt:hour(8),windows:forecastWindows(hour(8))})],[]),undefined,'公告之前未发生的事件不能反向关联');
});
test('正文明确指向事件原链接或已保存父关系才可关联，多个链接仍有歧义',()=>{
  const current=forecastCase(),other=forecastCase({id:'other',identity:'openai-status:Other',url:'https://status.openai.com/incidents/Other'});
  assert.deepEqual(matchForecastCase(announcement(`We will reset Codex usage for all paid accounts. ${current.url}`),'automatic_reset',[current,other],[]),{caseId:'case',relation:'explicit_source'});
  assert.equal(matchForecastCase(announcement(`We will reset Codex usage for all paid accounts. ${current.url} ${other.url}`),'automatic_reset',[current,other],[]),undefined);
  const parent=evidence('Codex usage is being consumed faster than expected.');
  const child=announcement('Confirmed landed across all accounts.',{sourceId:parent.sourceId,parentId:parent.messageId});
  assert.deepEqual(matchForecastCase(child,'automatic_reset',[current],[parent]),{caseId:'case',relation:'explicit_source'});
  assert.equal(matchForecastCase({...child,parentId:'unverified-parent'},'automatic_reset',[current],[parent]),undefined);
});
test('归档描述、人工历史摘要、缺完整证据不建立预测结局关系',()=>{
  const text='Due to the Codex usage bug, we will reset usage limits for all paid accounts.';
  for(const patch of [{textOrigin:'archive_excerpt' as const},{provenance:'manual' as const},{contextComplete:false}])assert.equal(matchForecastCase(announcement(text,patch),'automatic_reset',[forecastCase()],[]),undefined);
});
test('未满48小时、未来和未采到的结局不进入当前训练',()=>{
  const c=forecastCase(),o=outcome();
  assert.deepEqual(selectTrainingSamples([c],[o],hour(24)),[]);assert.deepEqual(selectTrainingSamples([c],[o],hour(48)),[]);
  assert.deepEqual(selectTrainingSamples([c],[{...o,observedAt:hour(60)}],hour(49)),[]);
  assert.deepEqual(selectTrainingSamples([c],[{...o,announcementAt:hour(60)}],hour(49)),[]);
  assert.deepEqual(selectTrainingSamples([c],[o],hour(49)).map(s=>s.id),['outcome']);
});
test('覆盖未核验、覆盖中断、晚采及未知结果不能变成负例',()=>{
  for(const status of ['unverified','gap'] as const)assert.deepEqual(selectTrainingSamples([forecastCase({coverage:{status,sourceIds:[],reason:'合成缺口'}})],[outcome()],hour(60)),[]);
  assert.deepEqual(selectTrainingSamples([forecastCase({late:true})],[outcome()],hour(60)),[]);
  assert.deepEqual(selectTrainingSamples([forecastCase()],[outcome({stage:'unknown',announcementAt:undefined,relationVerified:false})],hour(60)),[]);
  assert.deepEqual(selectTrainingSamples([forecastCase()],[],hour(60)),[],'没有找到公告不自动伪造阴性样本');
});
test('公开承诺、进行中、完成均是公告目标，个人到账始终未观测',()=>{
  for(const stage of ['promised','in_progress','claimed_complete'] as const){const result=selectTrainingSamples([forecastCase()],[outcome({stage})],hour(60));assert.equal(result.length,1,stage);assert.equal(result[0].stage,stage);assert.equal(result[0].actualDelivery,'unobserved');}
});
test('取消、失效或未核实关系不进入训练，重复进展每事件只计一次',()=>{
  assert.deepEqual(selectTrainingSamples([forecastCase()],[outcome({relationVerified:false})],hour(60)),[]);
  assert.deepEqual(selectTrainingSamples([forecastCase()],[outcome({invalidated:true})],hour(60)),[]);
  assert.deepEqual(selectTrainingSamples([forecastCase()],[outcome(),outcome({id:'cancel',stage:'cancelled',observedAt:hour(9)})],hour(60)),[]);
  const result=selectTrainingSamples([forecastCase()],[outcome({id:'later',stage:'claimed_complete',announcementAt:hour(9)}),outcome({id:'first',stage:'promised',announcementAt:hour(6)})],hour(60));
  assert.deepEqual(result.map(s=>s.id),['first']);
});
test('重置卡结果不能被装入同编号的额度训练样本',()=>{
  assert.deepEqual(selectTrainingSamples([forecastCase()],[outcome({target:'banked_reset'})],hour(60)),[]);
});
test('未匹配结局不能因错误关系已核实标记进入观察样本',()=>{
  assert.deepEqual(selectTrainingSamples([forecastCase()],[outcome({relation:'unmatched',relationVerified:true})],hour(60)),[]);
});
test('快照保留真实生成与采集时刻，晚于首24小时保守隐藏两项概率',()=>{
  for(const n of [24,30,48,60]){
    const c=forecastCase({collectedAt:hour(n),createdAt:hour(n),updatedAt:hour(n)});
    const s=snapshot(c,hour(n+1));
    assert.equal(s.signalAt,at);assert.equal(s.collectedAt,hour(n));assert.equal(s.generatedAt,hour(n+1));
    assert.deepEqual(s.windows,{24:hour(24),48:hour(48)});assert.equal(s.late,true);assert.equal(s.basis,'late');
    assert.equal(s.lateWindows[24],true);assert.equal(s.lateWindows[48],n+1>=48);
    assert.equal(s.p24,null);assert.equal(s.p48,null);assert.equal(s.interval24,null);assert.equal(s.interval48,null);
  }
  const delayed=snapshot(forecastCase(),hour(25));
  assert.equal(delayed.generatedAt,hour(25));assert.equal(delayed.collectedAt,hour(1));assert.equal(delayed.p48,null,'生成任务晚跑也不能回填提前预测');
});
test('快照仅使用当时已结束的历史参考，不泄漏本事件和未来结果',()=>{
  const expected=[{counts:[0,0,0],p24:null,p48:null},{counts:[0,1,0],p24:1/6,p48:2/3},{counts:[0,2,0],p24:1/8,p48:3/4}];
  for(let i=0;i<FORECAST_REFERENCE_SAMPLES.length;i++){
    const seed=FORECAST_REFERENCE_SAMPLES[i],known=new Date(Date.parse(seed.signalAt)+3_600_000).toISOString();
    const c=forecastCase({identity:`openai-status:${seed.id}`,signalAt:seed.signalAt,collectedAt:known,createdAt:known,updatedAt:known,windows:forecastWindows(seed.signalAt)}),s=snapshot(c,known);
    assert.deepEqual(s.counts,expected[i].counts);assert.equal(s.p24,expected[i].p24);assert.equal(s.p48,expected[i].p48);
    assert.deepEqual(s.referenceSampleIds,FORECAST_REFERENCE_SAMPLES.slice(0,i).map(x=>x.id));assert.ok(!s.referenceSampleIds.includes(seed.id));
    assert.equal(s.trainingApplied,false);assert.equal(s.calibrated,false);
  }
});
test('只有正例的实时观察不伪装成已校准训练队列，卡也不借实验种子',()=>{
  const c=forecastCase(),old=forecastCase({id:'older',identity:'openai-status:Older',signalAt:hour(-60),collectedAt:hour(-59),createdAt:hour(-59),updatedAt:hour(-59),windows:forecastWindows(hour(-60))});
  const o=outcome({id:'observed-positive',caseId:old.id,announcementAt:hour(-54),observedAt:hour(-53)});
  const s=buildForecastSnapshot({id:'snapshot',signature:'synthetic-only',case:c,generatedAt:hour(1),evidenceCutoffAt:hour(1),cases:[c,old],outcomes:[o]});
  assert.deepEqual(s.trainingSampleIds,[o.id]);assert.deepEqual(s.counts,[1,2,0]);assert.equal(s.trainingApplied,false);assert.equal(s.calibrated,false);assert.equal(s.basis,'experimental_seed');
  assert.match(s.explanation,/尚不用于训练/);
  const card=snapshot(forecastCase({target:'banked_reset'}));
  assert.deepEqual(card.referenceSampleIds,[]);assert.deepEqual(card.counts,[0,0,0]);assert.equal(card.sampleCount,0);assert.equal(card.p24,null);assert.equal(card.p48,null);assert.equal(card.basis,'insufficient');
});
test('前台双窗口概率仅首24小时有效，固定快照在过期后保持原值',()=>{
  const data=publicData(),before=structuredClone(data);
  assert.equal(currentForecast(data,hour(1))?.id,'case');assert.equal(currentForecast(data,hour(23.999))?.id,'case');
  for(const time of [hour(-1),hour(24),hour(30),hour(48),hour(60),'未知时间'])assert.equal(currentForecast(data,time),undefined,time);
  assert.deepEqual(data,before,'显示过期只能影响当前投影，不能修改固定快照');
  assert.equal(data.cases[0].snapshot!.p24,.3);assert.equal(data.cases[0].snapshot!.p48,.8);
  assert.equal(probabilityText(null),'样本不足');assert.equal(probabilityText(.3),'30%');assert.equal(intervalText(null),'暂无可用区间');
});
test('暂停、覆盖缺口、已有公告、迟到和未连接状态不展示当前预测',()=>{
  for(const patch of [{status:'paused' as const},{status:'observed' as const},{late:true},{target:'banked_reset' as const},{coverage:{status:'gap' as const,sourceIds:[],reason:'合成来源中断'}}])assert.equal(currentForecast(publicData(forecastCase(patch)),hour(2)),undefined);
  const late=publicData();late.cases[0].snapshot!.late=true;assert.equal(currentForecast(late,hour(2)),undefined);
  const insufficient=publicData();insufficient.cases[0].snapshot!.p24=null;assert.equal(currentForecast(insufficient,hour(2)),undefined);
  assert.equal(currentForecast({...publicData(),status:'unavailable'},hour(2)),undefined);assert.equal(currentForecast(undefined,hour(2)),undefined);
  const missing=publicData();missing.cases[0].snapshot=undefined;assert.equal(currentForecast(missing,hour(2)),undefined);
});
test('服务端窗口投影明确过期及来源暂停，固定快照不变',()=>{
  const c=forecastCase(),s=snapshot(c),before=structuredClone(s);
  assert.deepEqual(publicForecastCaseProjection(c,s,hour(2)),{status:'watching',current:true,current24:true,current48:true});
  assert.deepEqual(publicForecastCaseProjection(c,s,hour(24)),{status:'watching',current:true,current24:false,current48:true});
  assert.deepEqual(publicForecastCaseProjection(c,s,hour(48)),{status:'elapsed',current:false,current24:false,current48:false});
  for(const patch of [{status:'paused' as const},{status:'observed' as const},{coverage:{status:'gap' as const,sourceIds:[],reason:'合成缺口'}}]){
    const projected=publicForecastCaseProjection(forecastCase(patch),s,hour(2));assert.equal(projected.current,false);assert.equal(projected.current24,false);assert.equal(projected.current48,false);
  }
  assert.deepEqual(s,before);
});
test('轮询版本只跟随事实，不因刷新时间或列表排序制造新更新',()=>{
  const data=publicData(),before=forecastRevision(data);
  assert.deepEqual(forecastRevision({...data,generatedAt:hour(9)}),before);
  const moved=structuredClone(data);moved.cases[0].status='observed';assert.notDeepEqual(forecastRevision(moved),before);
  const added=structuredClone(data);added.cases[0].outcomes.push(outcome());assert.notDeepEqual(forecastRevision(added),before);
  const gap=structuredClone(data);gap.cases[0].coverage={status:'gap',sourceIds:[],reason:'合成缺口'};assert.notDeepEqual(forecastRevision(gap),before);
  const reordered=structuredClone(data);reordered.cases.push({...forecastCase({id:'z'}),snapshot:snapshot(),outcomes:[outcome({id:'b'}),outcome({id:'a'})]});
  const reversed=structuredClone(reordered);reversed.cases.reverse();for(const c of reversed.cases)c.outcomes.reverse();assert.deepEqual(forecastRevision(reordered),forecastRevision(reversed));
});
test('明确否认过快消耗不能触发额度异常预测',()=>{
  for(const text of ['There is no increase in users hitting Codex rate limits.','Codex usage is not being consumed faster than expected.','未发现 Codex 额度消耗过快。'])assert.equal(qualifyForecastSignal(evidence(text),source()),undefined,text);
});
test('事件URL的相似前缀不是明确来源关系',()=>{
  const c=forecastCase();
  assert.equal(matchForecastCase(announcement(`We will reset Codex usage for all paid accounts. ${c.url}Other`),'automatic_reset',[c],[]),undefined);
});
test('当前时间下超过三次轮询间隔的来源不再提供有效预测',()=>{
  const configured=source({lastSuccessAt:at}),before=structuredClone(configured);
  assert.equal(forecastSourceAvailable(configured,hour(.25)),true,'恰好15分钟仍在定义阈值内');
  assert.equal(forecastSourceAvailable(configured,hour(.25+1/3600)),false,'超过15分钟暂停当前预测');
  assert.equal(forecastSourceAvailable(source({lastSuccessAt:hour(-2)}),hour(1)),false);
  assert.equal(forecastSourceAvailable(source({lastSuccessAt:undefined}),hour(1)),false);
  assert.equal(forecastSourceAvailable(source({status:'delayed'}),hour(1)),false);
  assert.equal(qualifyForecastSignal(evidence('Codex usage is being consumed faster than expected.'),configured,hour(2)),undefined);
  assert.deepEqual(configured,before,'健康检查不能自动改变配置或恢复来源');
});
test('明确取消使旧预告失效，撤回追加记录也不会重新激活概率',()=>{
  const promised=outcome({id:'first',stage:'promised'}),cancel=outcome({id:'cancel',stage:'cancelled',announcementAt:hour(9),observedAt:hour(10)});
  const cancelled=effectiveForecastOutcome([promised,cancel],'case','automatic_reset',hour(11));
  assert.equal(cancelled.positive,undefined);assert.equal(cancelled.latest?.id,'cancel');
  const withdrawn=outcome({id:'withdrawn',stage:'unknown',invalidated:true,observedAt:hour(10),announcementAt:undefined,relation:'unmatched',relationVerified:false});
  const invalid=effectiveForecastOutcome([promised,withdrawn],'case','automatic_reset',hour(11));
  assert.equal(invalid.positive,undefined);assert.equal(invalid.invalidated,true);
  assert.equal(effectiveForecastOutcome([promised,cancel],'case','automatic_reset',hour(8)).positive?.id,'first','尚未知的未来取消不能向过去泄漏');
  for(const extra of [{caseId:'different'},{target:'banked_reset' as const}])assert.equal(effectiveForecastOutcome([promised,{...cancel,...extra}],'case','automatic_reset',hour(11)).positive?.id,'first');
});
test('先已知对应公告、后采到信号只能生成观察快照，不冒充提前预测',()=>{
  const c=forecastCase({collectedAt:hour(9),createdAt:hour(9),updatedAt:hour(9)});
  for(const stage of ['promised','in_progress','claimed_complete','cancelled'] as const){
    const known=outcome({stage});
    const s=buildForecastSnapshot({id:'known',signature:'synthetic-known',case:c,generatedAt:hour(9),evidenceCutoffAt:hour(9),cases:[c],outcomes:[known]});
    assert.equal(s.generatedAt,hour(9));assert.equal(s.signalAt,at);assert.equal(s.basis,'already_known',stage);
    assert.equal(s.p24,null);assert.equal(s.p48,null);assert.equal(s.interval24,null);assert.equal(s.interval48,null);
    assert.deepEqual(s.windows,{24:hour(24),48:hour(48)});
    assert.equal(currentForecast(publicData(c,s),hour(10)),undefined);
  }
  const withdrawn=outcome({stage:'unknown',invalidated:true,relation:'unmatched',relationVerified:false,announcementAt:undefined});
  const s=buildForecastSnapshot({id:'withdrawn',signature:'synthetic-withdrawn',case:c,generatedAt:hour(9),evidenceCutoffAt:hour(9),cases:[c],outcomes:[withdrawn]});
  assert.equal(s.basis,'already_known');assert.equal(s.p24,null);assert.equal(s.p48,null);
});
test('未采到、未核实或其他福利结局不能伪装成当前已知公告',()=>{
  const c=forecastCase();
  for(const patch of [{observedAt:hour(10)},{relationVerified:false},{relation:'unmatched' as const},{caseId:'other'},{target:'banked_reset' as const},{stage:'unknown' as const}]){
    const s=buildForecastSnapshot({id:'not-known',signature:'synthetic-not-known',case:c,generatedAt:hour(9),evidenceCutoffAt:hour(9),cases:[c],outcomes:[outcome(patch)]});
    assert.equal(s.basis,'experimental_seed');assert.equal(s.p24,.3);assert.equal(s.p48,.8);
  }
});
test('公告已公开之后才建立的观察case不会混入提前预测观察样本',()=>{
  const c=forecastCase({createdAt:hour(9),collectedAt:hour(9),updatedAt:hour(9)});
  assert.deepEqual(selectTrainingSamples([c],[outcome()],hour(60)),[]);
});
