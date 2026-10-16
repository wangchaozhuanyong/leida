import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BenefitAction, DraftContent, Evidence, RadarEvent } from '../lib/types';
import { evidenceBenefitClaims, hasCompleteContext, isTruncatedText, isVerifiedCampaignCalendar } from './source-context';
import { canUseNewsOnlyAttribution, normalizedEligibility } from './automatic-content';
import { benefitClauses, benefitKinds, benefitStage, eligibilityMatches, extractReplyClaims } from './benefit-rules';
export class DomainError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
const date = z.string().datetime({ offset: true });
export const actionSchema = z.object({ id:z.string().min(1).max(180),kind:z.enum(['automatic_reset','banked_reset']),stage:z.enum(['promised','in_progress','claimed_complete','cancelled']),eligibility:z.string().min(1).max(400),scope:z.enum(['public','targeted','private']),expectedAt:date.optional(),timeNote:z.string().max(300).optional(),evidenceIds:z.array(z.string()).min(1),statementAt:date,evidenceQuote:z.string().min(2).max(3000).optional() });
export const draftSchema = z.object({ title:z.string().trim().min(2).max(160), summary:z.string().trim().min(2).max(2400), translation:z.string().max(12000), category:z.enum(['reset','product','activity']), eventId:z.string().optional(), actions:z.array(actionSchema).max(20), evidenceIds:z.array(z.string()).min(1).max(30), contextEvidenceIds:z.array(z.string()).max(20).optional(), activityId:z.string().optional(), activityDay:z.number().int().min(1).max(366).optional(),publicationMode:z.enum(['news_only','state_change']).optional(),contentOrigin:z.enum(['template','generated']).optional(),reviewStatus:z.enum(['pending','targeted_update']).optional(),reviewReasons:z.array(z.string().min(1).max(300)).max(10).optional() });
const benefitWords = /reset|重置|发卡|存卡|额度|banked/i;
export function hasCompletion(text: string): boolean { return !isTruncatedText(text)&&benefitClauses(text).some(clause=>benefitStage(clause)==='claimed_complete'&&(benefitKinds(clause).length>0||/confirmed\s+landed|已确认.{0,12}(?:落地|到账)/i.test(clause))); }
export function isBenefitText(text: string): boolean { return benefitWords.test(text); }
export function hasCancellation(text:string):boolean {
 return benefitClauses(text).some(clause=>benefitStage(clause)==='cancelled');
}
export function hasAmbiguousTimeNote(note: string): boolean {
  if (!note.trim()) return false;
  // Only neutral fixed-offset display notes may pass without review. Abbreviations
  // such as PST/EOD and free-form deadlines need their intended meaning checked.
  return !/^(?:(?:已)?(?:统一)?(?:换算|转换)(?:为|成)?|统一使用|原文|北京时间|中国标准时间|(?:UTC|GMT)(?:[+-](?:0?[0-9]|1[0-4])(?::[0-5][0-9])?)?|[\s（）(),，。:：])+$/i.test(note.trim());
}
export function validateDraft(content: DraftContent, evidence: Evidence[], automatic = false): string[] {
  const reasons:string[] = [];
  const all = new Map(evidence.map(e => [e.id,e]));
  const cited = content.evidenceIds.map(e => all.get(e));
  if (cited.some(e => !e)) reasons.push('引用的原文不存在');
  const supplemental = (content.contextEvidenceIds??[]).map(id=>all.get(id));
  if ((content.contextEvidenceIds??[]).some(id=>!content.evidenceIds.includes(id))||supplemental.some(e=>!e||!hasCompleteContext(e,evidence,true))) reasons.push('补充上下文须引用已保存的完整原文');
  const validCited = cited.filter((e): e is Evidence => Boolean(e));
  const newsOnly=content.publicationMode==='news_only';
  if(content.reviewStatus&&(!newsOnly||content.actions.length||!content.reviewReasons?.length))reasons.push('待确认或定向跟踪必须说明原因且不能包含福利动作');
  if(newsOnly&&content.actions.length)reasons.push('仅新闻更新不能包含福利动作');
  const attributed=canUseNewsOnlyAttribution(content,validCited)||(!automatic&&newsOnly&&content.actions.length===0&&/公开归档|消息记录|来源/.test(content.summary));
  if (cited.some(e => e && !hasCompleteContext(e,validCited,!automatic) && !isVerifiedCampaignCalendar(e,validCited) && !(!automatic && !isTruncatedText(e.text) && supplemental.some(parent=>parent&&hasCompleteContext(parent,evidence,true))))&&!attributed) reasons.push('原文上下文不完整，请补充父帖或完整证据');
  if (!/[\u3400-\u9fff]/.test(content.title) || !/[\u3400-\u9fff]/.test(content.summary)) reasons.push('标题和摘要必须使用中文');
  if (/已(?:全部)?(?:发放|到账|重置|落地)|发放完成/.test(content.title) && !content.actions.some(a=>a.stage==='claimed_complete')) reasons.push('标题宣称完成，但动作尚无完成状态');
  if (content.category === 'reset' && content.actions.length === 0&&!newsOnly) reasons.push('重置新闻必须明确至少一个福利动作');
  if (content.activityId && !content.activityDay) reasons.push('请填写活动天数');
  if (content.actions.length && cited.every(e => e?.sourceId === 'official-status')) reasons.push('故障状态记录不能证明福利发放');
  const seen = new Set<string>();
  for (const action of content.actions) {
    if (seen.has(action.id)) reasons.push('福利动作编号重复'); seen.add(action.id);
    const actionEvidence = action.evidenceIds.map(e => all.get(e));
    if (action.evidenceIds.some(e => !content.evidenceIds.includes(e))) reasons.push('动作证据必须包含在文章证据内');
    if (actionEvidence.some(e => !e)) { reasons.push('动作缺少有效证据'); continue; }
    const text = actionEvidence.map(e => e?.text ?? '').join('\n');
    const quote = action.evidenceQuote ?? '';
    const statement=actionEvidence.find(e=>e?.text.includes(quote));
    if (!quote || !statement) {reasons.push('每项动作需要原文中的准确证据片段');continue;}
    const namedPlans=['plus','pro','business'].filter(plan=>new RegExp(`\\b${plan}\\b`,'i').test(quote));
    const candidatePlans=['plus','pro','business'].filter(plan=>new RegExp(`\\b${plan}\\b`,'i').test(action.eligibility));
    if(namedPlans.length&&namedPlans.join(',')!==candidatePlans.join(','))reasons.push('具体套餐资格与原文不一致，不能扩展或替换套餐');
    if(!namedPlans.length&&/paid|付费/i.test(quote)&&(!/付费|paid/i.test(action.eligibility)||candidatePlans.length))reasons.push('原文限定付费资格，不能扩大为所有账户或替换成部分套餐');
    if(/free|免费/i.test(quote)&&!/free|免费/i.test(action.eligibility))reasons.push('原文限定免费资格，不能扩大为所有账户');
    if(action.scope==='public'&&/just (?:you|your)|your account only|my account|private|仅你|仅该账户|私人|个人结转/i.test(quote))reasons.push('个人或定向证据不能标记普发');
    if(action.scope==='public'&&/selected|subset|specific\s+(?:users|accounts)|affected\s+(?:users|accounts)|\b\d+[km]?\s+(?:users|accounts)|部分|特定|选定|受(?:故障)?影响|定向补偿/i.test(quote))reasons.push('部分或受影响账户的定向补偿不能标记普发');
    if (action.kind === 'automatic_reset' && /banked|重置卡|存卡|备用重置/i.test(quote) && !/usage|用量|使用额度/i.test(quote)) reasons.push('重置卡证据不能证明用量已重置');
    if (action.kind === 'banked_reset' && !/banked|重置卡|存卡|备用重置/i.test(text)) reasons.push('证据未明确指向重置卡');
    if (action.kind === 'banked_reset' && /usage|用量|使用额度/i.test(quote)&&!/banked|重置卡|存卡|备用重置/i.test(quote)) reasons.push('用量重置声明不能证明重置卡动作');
    if (!isBenefitText(text)) reasons.push('原文未明确说明福利类型，需补全原承诺');
    let semantics=evidenceBenefitClaims(statement,validCited,!automatic);
    // Explicit human association is retained, but arbitrary citations never unlock automatic replies.
    if(!semantics.length&&!automatic&&!isTruncatedText(statement.text)&&supplemental.length){
      const parents=supplemental.flatMap(parent=>parent?evidenceBenefitClaims(parent,validCited,true):[]);
      semantics=extractReplyClaims(statement.text,statement.publishedAt,parents);
    }
    const matches=semantics.filter(claim=>claim.kind===action.kind&&(quote.includes(claim.quote)||claim.quote===statement.text&&quote===statement.text));
    const semantic=matches.find(claim=>claim.stage===action.stage);
    if(!semantic){
      if(action.stage==='claimed_complete')reasons.push('缺少明确完成声明，不能标记已发放');
      else if(action.stage==='cancelled')reasons.push('缺少肯定的取消或撤回声明');
      else if(action.stage==='in_progress')reasons.push('缺少进行中声明');
      else reasons.push('缺少明确承诺原文');
      if(!matches.length)reasons.push('福利类型、资格或动作关系缺少完整证据，不能借用其他句子的声明');
    }else{
      if(!eligibilityMatches(semantic.eligibility,action.eligibility))reasons.push('套餐、付费、免费或其他资格限制与原文不一致，不能扩大适用账户');
      if(semantic.scope!==action.scope)reasons.push('个人或定向补偿证据不能标记普发');
      if(action.expectedAt&&(!semantic.expectedAt||Date.parse(action.expectedAt)!==Date.parse(semantic.expectedAt)))reasons.push('预计时间缺少明确时区或原文依据，不能强配精确截止');
      if(action.timeNote&&automatic&&hasAmbiguousTimeNote(action.timeNote)&&action.timeNote!==semantic.timeNote)reasons.push('时间歧义说明必须忠实引用原文，不得自行猜测');
      if(semantic.timeNote?.includes('未生成精确截止')&&action.expectedAt)reasons.push('时间存在歧义，不得生成精确截止');
    }
    if (Math.abs(Date.parse(action.statementAt)-Date.parse(statement.publishedAt))>60_000) reasons.push('声明时间必须对应动作引用原文的发布时间');
  }
  if (automatic && cited.some(e => e?.provenance === 'manual')) reasons.push('人工补录需要审核');
  return [...new Set(reasons)];
}
export function mergeActions(previous: BenefitAction[], incoming: BenefitAction[], correction = false): BenefitAction[] {
  const result = new Map(previous.map(a => [a.id,a]));
  const rank = { promised: 1, in_progress: 2, claimed_complete: 3, cancelled: 4 };
  for (const action of incoming) {
    const old = result.get(action.id);
    if (old && !correction) {
      if (Date.parse(action.statementAt) < Date.parse(old.statementAt)) continue;
      if (old.kind !== action.kind || old.scope !== action.scope || normalizedEligibility(old.eligibility) !== normalizedEligibility(action.eligibility)) throw new DomainError('动作资格或类型变化，需要明确更正证据');
      if (rank[action.stage] < rank[old.stage]) throw new DomainError('完成状态不能由普通进展回退，请使用人工更正');
    }
    if(old&&Date.parse(action.statementAt)<Date.parse(old.statementAt))continue;
    result.set(action.id, {...action,evidenceIds:[...new Set([...(old?.evidenceIds ?? []),...action.evidenceIds])]});
  }
  return [...result.values()];
}
export function assertVersion(record: {version:number} | undefined, version: unknown): void { if (!record) throw new DomainError('记录不存在',404); if (typeof version !== 'number' || record.version !== version) throw new DomainError('内容已更新，请保留编辑并刷新对比后重试',409); }
export function noticeKey(event: RadarEvent, previous?: RadarEvent): string | undefined {
  const changes = event.actions.filter(a => (a.scope === 'public'||previous?.actions.some(p=>p.id===a.id&&p.scope==='public')) && !previous?.actions.some(p => p.id === a.id && p.stage === a.stage && p.scope === a.scope && normalizedEligibility(p.eligibility) === normalizedEligibility(a.eligibility) && p.expectedAt === a.expectedAt && p.timeNote === a.timeNote));
  if (!changes.length) return undefined;
  return hash(event.id+'|'+changes.map(a => `${a.id}:${a.stage}:${a.scope}:${normalizedEligibility(a.eligibility)}:${a.expectedAt??''}:${a.timeNote??''}`).sort().join('|'));
}
export function safeTemplate(e: Evidence): DraftContent {
  return { title:e.sourceId === 'official-status' ? '官方状态更新待核对' : '新收录内容待核对', summary:'已保存来源原文，中文事实与上下文等待核对。', translation:'', category:'product', actions:[], evidenceIds:[e.id] };
}
export function requireReason(reason: unknown): string { if (typeof reason !== 'string' || reason.trim().length < 2 || reason.length > 1000) throw new DomainError('请填写至少两个字的操作原因'); return reason.trim(); }
