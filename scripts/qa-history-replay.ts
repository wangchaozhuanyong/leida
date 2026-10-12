/** Read-only history diagnostics. Writes QA artifacts; never publishes or mutates the database. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {buildAutomaticTemplate,isClearlyUnrelated} from '../src/server/automatic-content';
import {validateDraft,hash} from '../src/server/domain';
import {gatherEvidenceContext,hasStandaloneContext,isTruncatedText} from '../src/server/source-context';
import {publicActions} from '../src/lib/public-facts';
import type {Evidence,BenefitAction,DraftContent,PublicData} from '../src/lib/types';

const root=fileURLToPath(new URL('../',import.meta.url));
const qa=path.join(root,'outputs/implementation-qa');
const samplePath=path.join(qa,'history-evidence-samples-20261010.json');
interface ExpectedAction {kind:BenefitAction['kind'];stage:BenefitAction['stage'];scope:BenefitAction['scope'];eligibility:string;quote:string;}
interface HistoricalSample {
 key:string;label:string;evidence:Evidence;origin:string;verifiedAt?:string;observedProductRecord?:unknown;
 expected:ExpectedAction[];limitations?:string[];links?:string[];
}
const parsed:unknown=JSON.parse(await readFile(samplePath,'utf8'));
const samples:HistoricalSample[]=Array.isArray(parsed)?parsed:(parsed as {samples:HistoricalSample[]}).samples;
if(!Array.isArray(samples)||!samples.length)throw new Error('历史证据样本格式不正确或为空');

function inspectTemplate(evidence:Evidence[]) {
 const primary=evidence[0];
 if(isClearlyUnrelated(primary))return {route:'excluded_unrelated',validationReasons:[],actions:[]};
 const draft=buildAutomaticTemplate(evidence);
 if(!draft)return {route:'no_template',validationReasons:[],actions:[]};
 const validationReasons=validateDraft(draft,evidence,true);
 return {route:validationReasons.length?'template_blocked':draft.publicationMode??'state_change',title:draft.title,summary:draft.summary,validationReasons,actions:draft.actions.map(a=>({kind:a.kind,stage:a.stage,scope:a.scope,eligibility:a.eligibility}))};
}
function candidate(e:Evidence,expected:ExpectedAction[],citeFullOriginal=false):DraftContent {
 return {title:'历史事实校验候选',summary:'只读回放候选，检查现有业务规则，不代表智能服务的真实提取结果。',translation:'',category:'reset',publicationMode:'state_change',contentOrigin:'generated',evidenceIds:[e.id],actions:expected.map((a,i)=>({id:`qa:${e.messageId}:${i}`,kind:a.kind,stage:a.stage,scope:a.scope,eligibility:a.eligibility,evidenceQuote:citeFullOriginal?e.text:a.quote,statementAt:e.publishedAt,evidenceIds:[e.id]}))};
}
const historyResults=samples.map(sample=>{
 const e=sample.evidence;
 // No parent relationship is inferred from time proximity or from another sample's text.
 const actual=inspectTemplate([e]);
 // Human fact labels remain independent; quote the complete saved original so
 // omitted qualifying words in the short research annotation cannot be lost.
 const semanticCandidate=sample.expected.length?candidate(e,sample.expected,true):undefined;
 const candidateValidation=semanticCandidate?validateDraft(semanticCandidate,[e],true):undefined;
 return {key:sample.key,label:sample.label,origin:sample.origin,verifiedAt:sample.verifiedAt,url:e.url,messageId:e.messageId,publishedAt:e.publishedAt,text:e.text,contextComplete:e.contextComplete,parserStandalone:hasStandaloneContext(e.text,'reset'),truncatedByParser:isTruncatedText(e.text),expected:sample.expected,actualTemplate:actual,candidateValidation,observedProductRecord:sample.observedProductRecord,limitations:sample.limitations??[],links:sample.links??[]};
});

// Deliberately incorrect candidate facts, built from explicit QA fixtures. They are not historical posts.
const fixtureAt='2026-10-09T12:00:00Z';
const fixtures:{key:string;text:string;action:ExpectedAction;extra?:Partial<Evidence>;reasonIncludes?:string}[]=[
 {key:'promise_cannot_be_complete',text:'We will load banked resets for all paid accounts.',action:{kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'付费账户',quote:'We will load banked resets for all paid accounts.'},reasonIncludes:'完成声明'},
 {key:'banked_cannot_be_usage',text:'We have loaded banked resets for all paid accounts.',action:{kind:'automatic_reset',stage:'claimed_complete',scope:'public',eligibility:'付费账户',quote:'We have loaded banked resets for all paid accounts.'},reasonIncludes:'不能证明用量'},
 {key:'usage_cannot_be_banked',text:'We have reset usage limits for all accounts.',action:{kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'所有账户',quote:'We have reset usage limits for all accounts.'},reasonIncludes:'重置卡'},
 {key:'paid_cannot_be_all',text:'We have loaded banked resets for all paid accounts.',action:{kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'所有账户',quote:'We have loaded banked resets for all paid accounts.'},reasonIncludes:'资格'},
 {key:'plus_cannot_be_pro',text:'We have loaded banked resets for Plus accounts only.',action:{kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'Pro套餐账户',quote:'We have loaded banked resets for Plus accounts only.'},reasonIncludes:'资格'},
 {key:'targeted_cannot_be_public',text:'We have loaded banked resets for selected Pro accounts affected by the outage.',action:{kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'Pro套餐账户',quote:'We have loaded banked resets for selected Pro accounts affected by the outage.'},reasonIncludes:'定向补偿'},
 {key:'private_cannot_be_public',text:'We have loaded a banked reset for your account only.',action:{kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'所有账户',quote:'We have loaded a banked reset for your account only.'},reasonIncludes:'个人或定向'},
 {key:'status_cannot_be_benefit',text:'We have completed mitigation of the Codex outage.',action:{kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'所有账户',quote:'We have completed mitigation of the Codex outage.'},extra:{sourceId:'official-status',provenance:'official'},reasonIncludes:'故障状态'},
 {key:'missing_parent_cannot_be_complete',text:'Confirmed landed across all accounts.',action:{kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'所有账户',quote:'Confirmed landed across all accounts.'},extra:{contextComplete:false,parentId:'missing-parent'},reasonIncludes:'上下文'},
 {key:'negated_cancellation_cannot_cancel',text:'We will not cancel banked resets for all paid accounts.',action:{kind:'banked_reset',stage:'cancelled',scope:'public',eligibility:'付费账户',quote:'We will not cancel banked resets for all paid accounts.'},reasonIncludes:'肯定的取消'},
 {key:'quote_must_be_literal',text:'We will load banked resets for all paid accounts.',action:{kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'付费账户',quote:'We have loaded banked resets for all paid accounts.'},reasonIncludes:'准确证据'},
 {key:'mixed_actions_need_separate_completion',text:'We have reset usage limits for all accounts. Banked resets will be loaded tomorrow.',action:{kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'所有账户',quote:'Banked resets will be loaded tomorrow.'},reasonIncludes:'完成声明'},
];
const guardResults=fixtures.map(f=>{
 const e:Evidence={id:`fixture:${f.key}`,sourceId:'qa-archive',messageId:f.key,url:`https://example.org/qa/${f.key}`,text:f.text,hash:hash(f.text),publishedAt:fixtureAt,collectedAt:fixtureAt,contextComplete:true,historical:true,provenance:'archive',textOrigin:'original',...f.extra};
 const reasons=validateDraft(candidate(e,[f.action]),[e],true);
 return {key:f.key,origin:'synthetic_adversarial_fixture',rejected:reasons.length>0,expectedReasonFound:!!f.reasonIncludes&&reasons.some(r=>r.includes(f.reasonIncludes!)),reasons};
});

// This GET only reads the existing public API; it does not enqueue collection or publish anything.
const response=await fetch('http://127.0.0.1:5190/api/v1/bootstrap',{signal:AbortSignal.timeout(10000)});
if(!response.ok)throw new Error(`公开资料读取失败：${response.status}`);
const publicResponse=await response.json() as {data:PublicData;version:string};
const data=publicResponse.data;
if(!Array.isArray(data.evidence))throw new Error('公开资料格式不正确');
const historicalEvidence=data.evidence.filter(e=>e.historical&&e.provenance!=='manual');
const installedHistoryResults=historicalEvidence.map(e=>({id:e.id,messageId:e.messageId,sourceId:e.sourceId,url:e.url,publishedAt:e.publishedAt,textOrigin:e.textOrigin,contextComplete:e.contextComplete,...inspectTemplate(gatherEvidenceContext(e,data.evidence))}));
const clearHistory=historyResults.filter(row=>row.expected.length>0);
const evidenceCompletenessDifferences=historyResults.flatMap(row=>installedHistoryResults.filter(current=>current.messageId===row.messageId&&current.contextComplete!==row.contextComplete).map(current=>({key:row.key,messageId:row.messageId,replayContextComplete:row.contextComplete,installedContextComplete:current.contextComplete,installedRoute:current.route,installedActions:current.actions,note:'独立样本与现有入库标记的差异；缺全文的不能由原标记反证完整，完整新正文也未写回真实库。'})));
const counts=(rows:{route:string}[])=>rows.reduce<Record<string,number>>((out,row)=>(out[row.route]=(out[row.route]??0)+1,out),{});
const report={
 generatedAt:new Date().toISOString(),purpose:'只读历史回放：真实模板路径、候选业务校验、独立合成错误防线',
 boundaries:{databaseWrites:0,aiCalls:0,wechatCalls:0,productCodeChanges:0,modelExtractionQuality:'未测',forecastRuntime:'另见离线概率复算；当前网站没有概率引擎'},
 sampleCount:samples.length,verifiedHistoryResults:historyResults,
 clearHistorySummary:{cases:clearHistory.length,templatesWithBenefitActions:clearHistory.filter(row=>row.actualTemplate.route==='state_change').length,candidateValidationPassed:clearHistory.filter(row=>row.candidateValidation?.length===0).length,candidateValidationBlocked:clearHistory.filter(row=>!!row.candidateValidation?.length).length,note:'只描述这组已核对语义的英文样本；不是全站准确率，也没有调用模型。'},evidenceCompletenessDifferences,
 guardSummary:{cases:guardResults.length,rejected:guardResults.filter(r=>r.rejected).length,specificReasonsMatched:guardResults.filter(r=>r.expectedReasonFound).length},guardResults,
 publicSnapshot:{serverTime:data.serverTime,version:publicResponse.version,counts:{events:data.events.length,publications:data.publications.length,articles:data.articles.length,evidence:data.evidence.length},currentPublicActions:publicActions(data).map(({action})=>({kind:action.kind,stage:action.stage,eligibility:action.eligibility,statementAt:action.statementAt})),articleOrigins:counts(data.articles.map(a=>({route:a.contentOrigin??'historical_import'})))},
 installedHistoricalTemplateSummary:{evidenceCount:historicalEvidence.length,routes:counts(installedHistoryResults),note:'按现有证据重新走模板/校验的只读结果，不代表再次发布，也不把旧导入状态当正确答案。'},installedHistoryResults,
 limitations:['expected候选来自人工核对的事实标注，校验通过不等于模型自动抽取成功。','公开补全文只验证当前可见正文，不证明历史当时已采到，也不凭空建立父子关系。','辅助归档的标题、分类和摘要不能独立证明福利动作。','历史回放和合成规则测试均不能替代真实智能服务调用、真实新消息链路与连续运行验收。'],
};
await mkdir(qa,{recursive:true});
const reportName=process.env.RADAR_RULE_REPORT??'history-repair-rules-20261010.json';
if(!/^history-repair-rules-[\w-]+\.json$/.test(reportName))throw new Error('回放报告路径须位于本项目验收目录');
await writeFile(path.join(qa,reportName),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sampleCount:report.sampleCount,guardSummary:report.guardSummary,clearHistorySummary:report.clearHistorySummary,evidenceCompletenessDifferences,historicalRoutes:report.installedHistoricalTemplateSummary,historyResults:historyResults.map(r=>({key:r.key,route:r.actualTemplate.route,expected:r.expected.map(a=>`${a.kind}:${a.stage}`),candidateValidation:r.candidateValidation}))},null,2));
if(guardResults.some(r=>!r.rejected||!r.expectedReasonFound))process.exitCode=1;
