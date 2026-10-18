import {referenceCompletionClaim} from './reference-reset-source';
import { createHash } from 'node:crypto';
import type { CandidateAutomation, DraftContent, Evidence, BenefitAction } from '../lib/types';
import { evidenceBenefitClaims, hasCompleteContext, hasStandaloneContext, isTruncatedText, isCampaignResetShorthand, isVerifiedCampaignCalendar, originalConflict, campaignMembership } from './source-context';
import { AUTOMATIC_RULES_VERSION, benefitStage, eligibilityKey } from './benefit-rules';
export { AUTOMATIC_RULES_VERSION } from './benefit-rules';

export function isTruncated(text:string):boolean {
  return isTruncatedText(text);
}
export function isClearlyUnrelated(evidence:Evidence):boolean {
 return /^(?:@\S+\s*)?(?:嘘+|哈+|哈哈|谢谢|thank\s+you|thanks|shh+|lol)[!！。.,，\s]*$/i.test(evidence.text.trim());
}

export function evidenceFingerprint(evidence:Evidence[]):string {
  const inputs=createHash('sha256').update(JSON.stringify(evidence.map(item=>({id:item.id,hash:item.hash,parentId:item.parentId,contextComplete:item.contextComplete,textOrigin:item.textOrigin,metadata:item.metadata})).sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex');
  return `${AUTOMATIC_RULES_VERSION}:${inputs}`;
}

export function classifyBlockers(reasons:string[],evidence:Evidence[]):CandidateAutomation {
  const conflict=reasons.some(reason=>/冲突|关联不明|多轮|多个事件|人工更正|人工保护|资格.*变化|动作资格|状态.*回退|属于另一事件/.test(reason));
  const codes=reasons.map(reason=>/上下文|父帖|完整证据|原承诺|福利类型|缺少.*声明/.test(reason)?'missing_context':/时间|时区/.test(reason)?'ambiguous_time':/冲突|资格|关联|多轮|人工/.test(reason)?'fact_conflict':'validation_pending');
  return {state:reasons.length?(conflict?'conflict':'waiting_evidence'):'ready',reasonCodes:[...new Set(codes)],dependencyIds:[...new Set(evidence.filter(item=>item.parentId&&!evidence.some(parent=>parent.messageId===item.parentId)).map(item=>item.parentId!))],inputFingerprint:evidenceFingerprint(evidence),evaluatedAt:new Date().toISOString()};
}

/** Templates only state mechanically recoverable facts. Auxiliary labels never establish a benefit. */
export function buildAutomaticTemplate(evidence:Evidence[]):DraftContent|undefined {
  const primary=evidence[0];
  if(!primary||primary.provenance==='manual')return;
  const membership=campaignMembership(primary,evidence);
  // Keep complete supporting statements; older unrelated ancestors remain saved
  // for lineage but must not become required publication citations.
  if(hasCompleteContext(primary,evidence))evidence=evidence.filter(item=>hasCompleteContext(item,evidence)||isVerifiedCampaignCalendar(item,evidence));
  const base:DraftContent={title:'',summary:'',translation:'',category:'product',actions:[],evidenceIds:evidence.map(item=>item.id),publicationMode:'news_only',contentOrigin:'template'};
  const attachment=primary.metadata?.activity;
  if(attachment&&primary.metadata?.activityDay){base.activityId=attachment.id;base.activityDay=primary.metadata.activityDay;base.category='activity';}
  else if(membership){Object.assign(base,membership);base.category='activity';}
  if(primary.sourceId==='official-status'){
    const labels:Record<string,string>={investigating:'正在调查',identified:'已定位问题',monitoring:'正在监测恢复',resolved:'事件已解决',postmortem:'发布事故分析'};
    const status=labels[primary.metadata?.status??''];
    return {...base,title:`Codex 官方服务状态${status?'：'+status:'更新'}`,summary:`官方状态页发布了 Codex 服务${status?'进展：'+status:'相关进展'}。此记录不代表重置或发卡承诺，具体影响可查看对应原文。`};
  }
  if(primary.sourceId==='official-releases'){
    const tag=primary.metadata?.versionTag??primary.text.match(/^Codex\s+(\S+)/)?.[1];
    if(!tag||!/^[\w.+-]{1,80}$/.test(tag))return;
    return {...base,title:`Codex 官方稳定版本发布：${tag}`,summary:`官方发布了 Codex 稳定版本 ${tag}。已保存发布说明；完整中文改动会在智能服务可用后自动补充。`};
  }
  const review=resetReview(primary,evidence);
  if(review&&(review.reviewStatus==='targeted_update'||isTruncated(primary.text)||originalConflict(primary,evidence)||isCampaignResetShorthand(primary)))return {...base,...review,category:'reset'};
  if(isTruncated(primary.text))return;
  const complete=hasCompleteContext(primary,evidence);
  const claims=evidenceBenefitClaims(primary,evidence);
  const supported=claims.filter(claim=>claim.scope==='public');
  if(complete&&supported.length){
    const occurrences=new Map<string,number>();
    const actions:BenefitAction[]=supported.map(claim=>{
      const ordinal=(occurrences.get(claim.kind)??0)+1;occurrences.set(claim.kind,ordinal);
      return {id:`template:${primary.messageId}:${claim.kind}${ordinal>1?':'+ordinal:''}`,kind:claim.kind,stage:claim.stage,eligibility:claim.eligibility,scope:claim.scope,statementAt:primary.publishedAt,evidenceIds:evidence.map(item=>item.id),evidenceQuote:claim.quote,expectedAt:claim.expectedAt,timeNote:claim.timeNote};
    });
    const name=(kind:BenefitAction['kind'])=>kind==='banked_reset'?'重置卡':'用量重置';
    const label:Record<BenefitAction['stage'],string>={promised:'发放预告',in_progress:'发放中',claimed_complete:'公告称已完成',cancelled:'公告宣布取消'};
    const title=referenceCompletionClaim(primary)?'参考来源确认：用量重置已完成':actions.map(action=>`${name(action.kind)}：${label[action.stage]}`).join('；');
    const sourceTime=new Date(primary.publishedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
    const summary=actions.map(action=>`${name(action.kind)}${label[action.stage]}，适用对象：${action.eligibility}。${action.expectedAt?`预计时间：${new Date(action.expectedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）。`:''}${action.timeNote??''}`).join('\n');
    if(title.length>160||summary.length>2100||actions.some(action=>action.evidenceQuote!.length>3000))return;
    return {...base,title,summary:`${referenceCompletionClaim(primary)?'AIPlanWatch 将对应原帖记录为公共额度重置；原帖仅为简短完成表达，福利类型采用参考项目分类，未虚构回复关系。':''}根据${primary.provenance==='archive'?'公开归档保存的原帖':'公开原文'}，${summary}\n原文发布时间：${sourceTime}（北京时间）。这是中文事实摘要，个人账户是否到账尚未观测。`,category:base.activityId?'activity':'reset',publicationMode:'state_change',actions};
  }
  if(complete&&claims.length&&claims.every(claim=>claim.scope!=='public'))return {...base,title:'定向重置相关动态',category:base.activityId?'activity':'reset',summary:`公开原文提到面向限定账户的重置相关安排。此条只记录定向动态，不计入公共发放次数；具体资格请查看原文。`};
  if(review)return {...base,...review,category:'reset'};
  // A fixed activity archive may supply a Chinese product excerpt, while its
  // evidence remains auxiliary. Never turn a mixed benefit statement into news.
  const contextLengthExcerpt=attributedContextLengthUpdate(primary);
  if(contextLengthExcerpt)return {...base,title:'活动产品动态：默认上下文长度提升',summary:`公开归档收录产品动态：“${contextLengthExcerpt}”。此条仅作产品消息记录，完整细节请查看原文。`};
  if(!/[\u3400-\u9fff]/.test(primary.text)){
    const summary=primary.metadata?.summary;
    if(primary.provenance==='archive'&&summary&&/[\u3400-\u9fff]/.test(summary)&&!isTruncated(summary)&&/重置|额度|发卡|落地|传播|发放/.test(summary))return attributedNews({...primary,text:summary},base);
    return;
  }
  if(complete&&hasStandaloneContext(primary.text,'product'))return {...base,title:primary.metadata?.title&&/[\u3400-\u9fff]/.test(primary.metadata.title)?primary.metadata.title.slice(0,160):'Codex 产品功能更新',summary:`${primary.provenance==='archive'?'公开归档收录的产品动态':'公开产品动态'}：${primary.text.slice(0,1800)}`,translation:primary.text.slice(0,12000)};
  // A full Chinese excerpt may be reported as an attributed message, never as a new distribution.
  if(primary.provenance==='archive'&&/重置|额度|发卡|落地|传播|发放/.test(primary.text))return attributedNews(primary,base);
}

function attributedContextLengthUpdate(primary:Evidence):string|undefined {
  const day=primary.metadata?.activityDay,activity=primary.metadata?.activity;
  const excerpt=primary.textOrigin==='archive_excerpt'?primary.text:primary.textOrigin==='original'?primary.metadata?.summary:undefined;
  if(!excerpt||primary.sourceId!=='activity-archive'||primary.provenance!=='archive'||
     primary.url!==`https://x.com/thsottiaux/status/${primary.messageId}`||
     primary.metadata?.sourceGroup!=='codex-resets'||primary.metadata?.category!=='product'||
     activity?.id!=='challenge-28'||activity.days!==28||typeof day!=='number'||!Number.isInteger(day)||day<1||day>activity.days||
     primary.parentId||excerpt.length>1700||isTruncated(primary.text)||isTruncated(excerpt)||
     /reset|banked|quota|重置|发卡|存卡|额度|落地|发放/i.test(primary.text+'\n'+excerpt)||
     !hasStandaloneContext(excerpt,'product'))return;
  // Match the whole supported excerpt; extra unparsed sentences may contain a
  // correction or qualification and must stay pending rather than be ignored.
  const match=excerpt.match(/^(GPT-\d+(?:\.\d+)?(?:\s+[A-Za-z][\w-]*)?)\s+在\s+Codex\s+和\s+Work\s+中的默认上下文长度已从\s*(\d+(?:\.\d+)?)\s*([km]?)\s*提升至\s*(\d+(?:\.\d+)?)\s*([km]?)(?:，有助于减少上下文压缩，并在长时间任务中保留更多上下文)?。?$/i);
  if(!match)return;
  const scale=(unit:string)=>unit.toLowerCase()==='m'?1_000_000:unit.toLowerCase()==='k'?1000:1;
  const before=Number(match[2])*scale(match[3]),after=Number(match[4])*scale(match[5]);
  if(!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||before<=0||after<=before)return;
  if(primary.textOrigin==='original'){
    // Keep the archive attribution after successful original enrichment only
    // when model, day and both numeric facts agree. Unsupported extra sentences
    // remain pending; this is a finite fact template, not a general translation.
    const original=primary.text.replace(/\s+/g,' ').trim();
    const head=original.match(/^Day (\d+)\/ We have increased default context length for (GPT-\d+(?:\.\d+)?(?: [A-Za-z][\w-]*)?) to (\d+(?:\.\d+)?)([km]?) when used through Codex & Work, up from (\d+(?:\.\d+)?)([km]?) or an ~ \d+(?:\.\d+)?% increase\./i);
    if(!head||Number(head[1])!==day||head[2].toLowerCase()!==match[1].toLowerCase()||Number(head[3])*scale(head[4])!==after||Number(head[5])*scale(head[6])!==before)return;
    const tail=original.slice(head[0].length).trim();
    const supportedTail='We will go higher in the future, but it helps reduce occurrence of compactions and with tasks that require keeping a lot of context and nuance over periods of time. It was carefully tested and is the new sweet spot for most of our users. You can still override it if you want to be higher our lower, with maximum context length of '+head[2]+' of 1M.';
    if(tail&&tail!==supportedTail)return;
  }
  return excerpt;
}

function attributedNews(primary:Evidence,base:DraftContent):DraftContent {
  return {...base,title:'公开归档收录重置相关动态',category:base.activityId?'activity':'reset',summary:`公开归档收录消息：“${primary.text.slice(0,1700)}”。此条仅作消息记录，福利类型、资格或对应轮次尚待确认。`};
}

export function canUseNewsOnlyAttribution(content:DraftContent,evidence:Evidence[]):boolean {
  if(content.publicationMode!=='news_only'||content.contentOrigin!=='template'||content.actions.length)return false;
  const expected=buildAutomaticTemplate(evidence);
  return !!expected&&expected.publicationMode==='news_only'&&expected.title===content.title&&expected.summary===content.summary;
}

export function hasExplicitCorrectionText(text:string):boolean {
  return benefitStage(text)==='cancelled'||/\b(?:correction|correct(?:ed)?|actually|instead)\b|更正|纠正|改为|调整为/i.test(text);
}

export function normalizedEligibility(value:string):string {
  return eligibilityKey(value);
}

/** A visible source record is separate from a qualified public benefit. */
export function resetReview(primary:Evidence,context:Evidence[]):Pick<DraftContent,'title'|'summary'|'reviewStatus'|'reviewReasons'>|undefined {
  const text=primary.text.replace(/[’‘]/g,"'");
  const campaign=/over the next \d+ days, each day we['’]ll either ship/i.test(text)&&/full reset/i.test(text);
  const incident=/\bPro\s+500\b/i.test(text)&&(/didn't get the reset|investigating/i.test(text)||/^All fixed\./i.test(text)&&context.some(e=>e.id!==primary.id&&primary.parentId===e.messageId&&/Pro 500.*(?:didn[’']t get the reset)/i.test(e.text)));
  const explicit=/(?:resets? (?:all propagated|has been processed|coming next week)|promised a reset|reset (?:will|by|in)|(?:^|\n)\s*Day \d+\/\s*Reset|(?:重置|发卡|存卡).{0,50}(?:预告|安排|传播|发放|已)|(?:will|promis|ship|give|load).{0,50}\b(?:reset|banked)\b)/i.test(text);
  const reply=/^(?:done(?: and dusted)?|it['’]s done|all fixed)[.!]?$/i.test(text.trim())&&context.some(e=>e.id!==primary.id&&/reset|重置/i.test(e.text));
  if(!incident&&!campaign&&!explicit&&!reply&&!isCampaignResetShorthand(primary))return;
  if(!campaign&&!incident&&(/[?？]/.test(text)||/\b(?:can['’]t|won['’]t|didn['’]t)|the day we reach perfection/i.test(text)||/\b(?:if|unless|would|could|maybe|hypothetical|not|never|cannot|cancelled)\b|假设|希望|传闻/i.test(text)))return;
  if(incident)return {title:'Pro 500 重置异常跟踪',summary:/^All fixed\./i.test(text)?'作者回复称 Pro 500 相关异常已修复。此记录只跟踪受影响用户，不新增全体重置次数，个人账户到账尚未观测。':'作者报告部分 Pro 500 用户未如期收到重置，正在调查并表示将补偿。此记录不代表全体用户新增一次重置。',reviewStatus:'targeted_update',reviewReasons:['仅涉及原文所述 Pro 500 异常及后续处理，不作为公共发放完成声明。']};
  const reasons:string[]=[];
  if(originalConflict(primary,context))reasons.push('同一消息存在相互冲突的原文版本，等待核对。');
  if(isTruncatedText(text)||primary.textOrigin==='archive_excerpt')reasons.push('保存的正文为摘要或存在截断，等待完整原文。');
  if(primary.parentId&&!context.some(e=>e.messageId===primary.parentId))reasons.push('缺少原文明确引用的父帖。');
  if(isCampaignResetShorthand(primary))reasons.push('活动简写已收录；套餐资格和具体发放安排仍需后续声明核对。');
  if(campaign)reasons.push('这是活动规则，不能据此认定每天已进行重置。');
  if(!reasons.length)reasons.push('原文涉及重置安排或完成表述，福利类型、适用资格或对应轮次尚未完全核清。');
  return {title:campaign?'活动规则收录待确认':'重置相关消息待确认',summary:'已保存公开来源消息。'+reasons.join('')+'此条不计入已重置、已发卡或预测准确率；请查看原文依据。',reviewStatus:'pending',reviewReasons:reasons};
}
