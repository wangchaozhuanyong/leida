import type {ActionKind,ActionStage} from '../lib/types';

// Shared evidence interpretation, used before publishing and before training.
// These predicates describe an action, not a model's confidence or an audience.
const resetObject=/\b(?:reset\w*|refill\w*|refresh\w*|replenish\w*)\b|\brestor\w*\b.{0,90}\b(?:full|entire|consumed)\b|\b(?:full|entire|consumed)\b.{0,90}\brestor\w*\b|重置|恢复(?:全部|完整|已用)/i;
const usageObject=/\busage(?:\s+limits?)?\b|\brate\s+limits?\b|\bCodex\s+(?:limits?|quotas?|allowance)\b|\bconsumed\b.{0,30}\bquota\b|用量|使用(?:额度|限制|限额|量)/i;
export const bankedObject=/\b(?:reserve|stored|saved)\s+(?:resets?|reset\s+cards?)\b|banked\s*(?:resets?|重置)|\bresets?\b[\s.…,:;—-]{1,20}banked\b|^(?:banked(?:\s+resets?)?|重置卡)\s*\d{1,2}\s*(?:\/|of)\s*\d{1,2}[.!。！]?\s*$|reset\s+bank|重置卡|存卡|备用重置|累积(?:重置)?额度/i;
const benefitNoun=/\b(?:resets?|banked|reserve|stored|saved|usage|limits?|quotas?|allowance)\b|重置|额度|发卡/i;
const actionVerb=/\b(?:reset\w*|refill\w*|refresh\w*|replenish\w*|restor\w*|giv\w*|grant\w*|load\w*|credit\w*|issu\w*|deliver\w*|send|sent|available|ready|land\w*|complet\w*|propagat\w*)\b|重置|发放|恢复|到账|取消|撤回/i;

export function speechDisposition(text:string):'own'|'denied'|'reported'|'uncertain' {
  const s=text.replace(/[’‘]/g,"'").trim();
  if(/\b(?:someone|somebody|they|a user|users)\s+(?:said|says?|reports?|reported|claims?|claimed)\b|\b(?:rumou?rs?|unconfirmed|allegedly)\b|\baccording to\b|\b(?:quoting|quote:)\b|据说|传闻|有人(?:说|称)|用户(?:称|报告)|转述/i.test(s))return 'reported';
  if(/\b(?:a user|users?|customers?|subscribers?|accounts?|people|members?)\s+(?:have|has)\s+(?:already\s+|now\s+|just\s+|fully\s+)*(?:reset|refilled|refreshed|replenished|restored|added|loaded|given|granted)\b/i.test(s))return 'reported';
  // A negative auxiliary governs its following action. "No delays" does not
  // negate a later reset; a negative noun phrase does (including new aliases).
  if(/\b(?:not|never|won't|haven't|hasn't|didn't|cannot|can't)\b.{0,90}/i.test(s)){
    const tail=s.match(/\b(?:not|never|won't|haven't|hasn't|didn't|cannot|can't)\b([^.!?;]*)/i)?.[1]??'';
    if(actionVerb.test(tail))return 'denied';
  }
  for(const m of s.matchAll(/\bno\s+([^,;.!?]*?)(?=\b(?:is|are|was|were|has|have|will|can)\b|[,;.!?]|$)/gi))if(benefitNoun.test(m[1]))return 'denied';
  if(/(?:尚未|没有|并未|未曾|不会|不).{0,15}(?:发放|重置|恢复|到账|取消|撤回)/.test(s)&&!/不再发放/.test(s))return 'denied';
  if(/[?？]|\b(?:maybe|perhaps|might|hypothetically)\b|\b(?:if|unless)\b.{0,90}\b(?:would|could|may)\b|假设|假如|是否|会不会/i.test(s))return 'uncertain';
  return 'own';
}

/** Do not promote text inside quotations to the author's own declaration.
 * Scope is the clause/quote, not a whole-post blacklist of words like rumour. */
export function ownBenefitClause(whole:string,clause:string):boolean {
  if(speechDisposition(clause)!=='own')return false;
  const at=whole.indexOf(clause);
  if(at<0)return false;
  for(const match of whole.matchAll(/“[^”]*(?:”|$)|"[^"]*(?:"|$)/g)){
    if(at>=match.index!&&at<match.index!+match[0].length)return false;
  }
  return true;
}

export function languageKinds(text:string):ActionKind[] {
  const kinds:ActionKind[]=[];
  if(bankedObject.test(text))kinds.push('banked_reset');
  const related=text.split(/[.!?;。！？；]/).some(clause=>{
    const usage=clause.match(usageObject),action=clause.match(resetObject);
    return usage?.index!==undefined&&action?.index!==undefined&&Math.abs(usage.index-action.index)<=90;
  });
  if(related||/\breset(?:ting)?\s+(?:the\s+)?limits?\b/i.test(text)||/\bglobal\s+(?:(?:usage|rate\s+limits?)\s+)?reset\b|全局(?:用量)?重置/i.test(text))kinds.push('automatic_reset');
  return kinds;
}
export function languageStage(text:string):ActionStage|undefined {
  if(speechDisposition(text)!=='own'||!languageKinds(text).length)return;
  const s=text.replace(/[’‘]/g,"'");
  const recovery='(?:reset|refresh|refill|replenish|restore)';
  if(new RegExp(`\\b(?:will|going to|plan to|scheduled to|expect(?:ed)?)\\b.{0,90}\\b${recovery}\\w*\\b`,'i').test(s)||
    new RegExp(`^${recovery}ting\\b.{0,100}\\b(?:tomorrow|later|next|soon)\\b`,'i').test(s)||
    /^resetting\b.{0,100}\b(?:tomorrow|later|next|soon)\b/i.test(s))return 'promised';
  if(/\b(?:are|is|we're)\s+(?:now\s+)?(?:refreshing|refilling|replenishing|restoring)\b/i.test(s))return 'in_progress';
  if(/\b(?:have|has|we've|i've)\s+(?:now\s+|already\s+|just\s+|fully\s+|been\s+)*(?:refreshed|refilled|replenished|restored)\b|\b(?:are|is)\s+(?:now\s+|fully\s+)*(?:reset|refilled|replenished|restored)\b/i.test(s))return 'claimed_complete';
}
