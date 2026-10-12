import type { ActionKind, ActionStage, BenefitAction } from '../lib/types';

/** Change only when fact interpretation changes, so unchanged inputs are evaluated once. */
export const AUTOMATIC_RULES_VERSION = 'benefit-rules-20261012-7';
export interface BenefitClaim {
  kind: ActionKind; stage: ActionStage; eligibility: string; scope: BenefitAction['scope'];
  quote: string; expectedAt?: string; timeNote?: string;
}
interface Qualification { label: string; key: string; scope: BenefitAction['scope']; }
const normalize = (text: string) => text.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const banked = /banked\s*(?:resets?|重置)|重置卡|存卡|备用重置|累积(?:重置)?额度/i;
const usage = /(?:usage(?:\s+limits?)?|rate\s+limits?|用量|使用(?:额度|限制|限额|量)).{0,40}(?:reset|重置)|(?:reset|重置).{0,40}(?:usage(?:\s+limits?)?|rate\s+limits?|用量|使用(?:额度|限制|限额|量))/i;
const globalReset = /\bglobal\s+(?:(?:usage|rate\s+limits?)\s+)?reset\b|全局(?:用量)?重置/i;
const dayEndDeadline = /\b(?:by|before)\s+(?:the\s+)?(?:end\s+of\s+(?:the\s+)?(?:day|today|tomorrow)|EOD)\b|(?:今日|今天|当日|当天|明天)结束(?:之)?前|日终(?:之)?前/i;
const excluded = /\b(?:purchase[ds]?|buy|bought|referral|invitation|invite[ds]?|redeem(?:ed|ing)?|carry(?:ing)? over|carried over|my resets?|my account|just you|your account only|inventory|store|stock|option)\b|购买|邀请|推荐奖励|个人结转|私人|仅你|仅该账户|自行使用|主动用卡|商店|库存|已有的重置卡/i;
const targeted = /\b(?:some|certain|selected|subset|specific|affected)\s+(?:\w+\s+){0,3}(?:users?|accounts?)|\b\d[\d,]*(?:\.\d+)?[km]?\s+(?:\w+\s+){0,2}(?:users?|accounts?)\b|部分|特定|选定|受(?:故障)?影响|定向补偿/i;

export function isTruncatedBenefitText(text: string): boolean {
  if (/\[(?:truncated|内容截断)\]|【(?:内容)?截断】/i.test(text)) return true;
  const tail = text.trim().replace(/\s*https?:\/\/\S+\s*$/, '').trim().replace(/[”’"'）)\]】]+$/, '');
  // These are evidence gaps, not a claim that every other sentence is complete.
  return /(?:…|\.{3})\s*$|(?:而是|但是|并且|包括|例如|分别是|以及|这些|因为|已经|即将|我们已|要求如下|具体要求如下|has been|we have|will be|but a|but|and|including|such as)\s*[:：,，]?\s*$/i.test(tail) || /(?:^|\n)\s*(?:[-*•]|\d+[.)、])\s*$/.test(tail);
}

export function benefitKinds(text: string): ActionKind[] {
  const result: ActionKind[] = [];
  if (banked.test(text)) result.push('banked_reset');
  if (usage.test(text) || globalReset.test(text)) result.push('automatic_reset');
  return result;
}

export function hasDayEndDeadline(text: string): boolean {
  return dayEndDeadline.test(normalize(text));
}

/** Preserve source slices; qualification and tense never come from another sentence. */
export function benefitClauses(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[。！？；;\n]|[.!?](?=\s|$)/g)) {
    const end = match.index! + match[0].length;
    const sentence = text.slice(start, end).trim();
    if (sentence) result.push(sentence);
    start = end;
  }
  const ending = text.slice(start).trim();
  if (ending) result.push(ending);
  return result.flatMap(sentence => {
    if (benefitKinds(sentence).length < 2) return [sentence];
    const separators = [...sentence.matchAll(/，|,(?=\s)|\band\b|并且|同时|并(?=向|为)|而(?=重置卡|用量)/gi)];
    for (const separator of separators) {
      const left = sentence.slice(0, separator.index).trim();
      const right = sentence.slice(separator.index! + separator[0].length).trim();
      if (benefitKinds(left).length === 1 && benefitKinds(right).length === 1) return [left, right];
    }
    return [sentence];
  });
}

function isQuestionOrHypothesis(text: string): boolean {
  return /[?？]/.test(text) || /^(?:what|why|when|would|could|should|can|did|does|do|has|have|is|are)\b.*[?？]$/i.test(text) ||
    /\b(?:if|unless)\b.{0,100}\b(?:would|could|might|may)\b|\bif\s+(?:we|i|a reset|the reset|banked resets?)\b|\b(?:might|maybe|perhaps|would)\b|如果.{0,50}(?:可能|也许|会不会)|如果(?:已|已经|我们)|假如|是否|会不会|建议|希望/i.test(text);
}

export function benefitStage(text: string): ActionStage | undefined {
  const s = normalize(text);
  if (isQuestionOrHypothesis(s) || excluded.test(s)) return;
  // "No banked resets have been loaded" denies the benefit itself, even though
  // its verb otherwise resembles a completion. Do not treat unrelated "no
  // delays/issues" wording as a negated benefit.
  if (/\bno\s+(?:(?:further|additional|more|new|extra|global|automatic)\s+)*(?:banked\s+resets?|usage(?:\s+limits?)?(?:\s+resets?)?|rate\s+limits?(?:\s+resets?)?|resets?)\b/i.test(s)) return;
  if (globalReset.test(s) && /\b(?:no|not|never|won't|cannot|can't|might|may|could|possible|potential|rumou?rs?|rumou?red|unconfirmed|hope|wish)\b|\b(?:only|just)\s+(?:for\s+)?(?:you|me|my|your|one|a\s+single)\b|\b(?:my|your|our)\s+(?:team|account|workspace)\b|不会|并无|没有|未有|传闻|据说|可能|或许|希望|假设|(?:仅|只)(?:为|给|针对)?(?:你|我|个人)/i.test(s)) return;
  if(/\b(?:users?|customers?|subscribers?|accounts?|people|members?)\s+(?:have|has)\s+(?:already\s+|now\s+|just\s+|fully\s+)*(?:added|loaded|given|granted|deposited|reset)\b|(?:用户|账户|客户)(?:已|已经).{0,12}(?:自行|主动)(?:添加|重置|使用)/i.test(s))return;
  if (/(?:not|never|won't|haven't|hasn't|didn't|cannot|can't|not yet).{0,35}(?:reset|giv|add|load|credit|grant|land|propagat|complet|cancel|withdraw)|(?:尚未|没有|并未|未曾|不会|不再|不).{0,15}(?:发放|重置|添加|存入|到账|落地|取消|撤回)/i.test(s) && !/不再发放/.test(s)) return;
  if (/\b(?:cancelled|canceled|withdrawn|withdrew|cancel|withdraw)\b|取消|撤回|不再发放/i.test(s)) return 'cancelled';
  if (/\b(?:will|(?:we|i|they)'ll|going to|scheduled to|plan to|should|expect(?:ed)?)\b.{0,80}(?:reset|giv|add|load|credit|grant|land|propagat|complet|be there|be showing)|将(?:会|于)?|计划|预计|安排|承诺|(?:改为|调整为)(?:稍后|之后|以后).{0,12}(?:发放|重置)/i.test(s)) return 'promised';
  if (/\blanding\b.{0,60}(?:\btomorrow\b|\btoday\b|\bsoon\b|\bin\b|\bby\b|\d{1,2}(?::\d{2})?\s*[ap]m\b)/i.test(s)) return 'promised';
  if (/\b(?:are|is|we're)\s+(?:now\s+)?(?:giving|loading|crediting|granting|reset{1,2}ing)|\b(?:loading|rolling out|propagating|in progress)\b|正在|发放中|传播中|加载中/i.test(s)) return 'in_progress';
  if (/\b(?:have|has)\s+(?:now\s+|already\s+|just\s+|been\s+|fully\s+)*(?:reset|added|credited|granted|given|loaded|deposited|landed|propagated|completed)\b|^(?:added|credited|granted|loaded)\b|\b(?:confirmed|fully|all)\s+(?:landed|propagated|credited|loaded|completed)\b|\b(?:reset|resets)\s+(?:have\s+)?(?:all\s+)?(?:landed|propagated|completed)\b|已(?:经|全部)?(?:为.{0,80})?(?:确认|重置|发放|到账|落地|传播|加载|存入|添加)|全部.{0,20}(?:落地|传播)/i.test(s)) return 'claimed_complete';
  if (/^all\s+reset\s+for\s+everyone[.!]?$/i.test(s)) return 'claimed_complete';
  // The original's short announcement omits "will", but a global action with
  // a prospective deadline still states a promise, not a completed reset.
  if (globalReset.test(s) && /^(?:a\s+)?global\b|^(?:全局|今日|今天|当日|当天|明天)/i.test(s) && hasDayEndDeadline(s) && !/\b(?:yesterday|last\s+(?:day|week))\b|昨天|昨日|上周/i.test(s)) return 'promised';
}

function qualification(text: string, inferredAudience?: string): Qualification | undefined {
  const s = normalize(text);
  if (excluded.test(s) || /not all|并非所有|不是所有/i.test(s)) return;
  if(/\b(?:except|excluding)\b|除了|排除|除.{0,25}以外/i.test(s))return;
  const plans = ['Plus', 'Pro', 'Business'].filter(plan => new RegExp(`\\b${plan}\\b`, 'i').test(s));
  const paid = /\bpaid\b|付费/i.test(s);
  const free = /\bfree\b|免费/i.test(s);
  const universal = /\b(?:all|every)\b.{0,70}\b(?:users?|accounts?|plans?|subscriptions?)\b|\beveryone(?:'s)?\b|所有|全部|每(?:一)?位|每个|每个人/i.test(s);
  const global = globalReset.test(s);
  if (!plans.length && !paid && !free && !universal && !global && !targeted.test(s)) return;
  const products = [/ChatGPT\s*Work/i.test(s) ? 'ChatGPT Work' : '', /\bCodex\b/i.test(s) ? 'Codex' : ''].filter(Boolean);
  const audience = products.length ? products.join('和') : /\bChatGPT\b/i.test(s) ? 'ChatGPT' : inferredAudience ?? '';
  let label = plans.length ? `${plans.join('、')}套餐账户` : paid ? `付费${audience}账户` : free ? `免费${audience}账户` : /all\s+plans|所有套餐|全部套餐/i.test(s) ? `所有套餐的${audience || ''}用户` : `所有${audience}账户`;
  if (global && !plans.length && !paid && !free && !universal) label = '全局范围（原帖未列明具体套餐）';
  const missingModel = s.match(/(?:don't|do not|haven't|without|no)\s+(?:have\s+)?access\s+to\s+([\w.-]+)/i)?.[1] ?? s.match(/尚未(?:获得|拥有|开通)\s*([\w.-]+)\s*(?:访问)?权限/i)?.[1];
  if (missingModel) label = `尚未获得${missingModel}访问权限的${paid ? '付费' : ''}${audience || 'ChatGPT'}账户`;
  // Unknown explicit membership modifiers must not silently become a bare plan.
  // Only the verified no-model-access condition is translated by this template.
  if (/地区|区域|订阅(?:满|至少|时长)|至少\s*\d+\s*天/i.test(s) || /权限/.test(s)&&!missingModel) return;
  for(const modifier of s.matchAll(/\b(?:users?|accounts?|plans?|subscriptions?)\s+((?:in|from|with|without|who|that|created|registered|upgraded|having|older|younger)\b(?:\.(?=\d)|[^.!])*)/gi)) {
    // A complete relative-time phrase is not membership. Retain decimal dots,
    // but do not exempt a following region, condition or other qualifier.
    if(/^in\s+(?:the next\s+)?(?:~\s*|about\s+|approximately\s+|roughly\s+)?(?:(?:\d+(?:\.\d+)?|a few|few|a couple of)\s+(?:hours?|minutes?)(?:\s+(?:and\s+)?\d+(?:\.\d+)?\s+minutes?)?|an?\s+(?:hour|minute)(?:\s+(?:and\s+)?\d+(?:\.\d+)?\s+minutes?)?|(?:hour|minute)(?:\s+(?:and\s+)?\d+(?:\.\d+)?\s+minutes?)?)(?:\s+or\s+so)?\s*$/i.test(modifier[1].trim()))continue;
    const knownMissing=/^(?:(?:that|who)\s+(?:do not|don't)\s+(?:have\s+)?access\s+to|without\s+access\s+to)\s+[\w.-]+\s*$/i.test(modifier[1].trim());
    if(!missingModel||!knownMissing)return;
  }
  // Other eligibility conditions are deliberately not collapsed into a plan name.
  const eligibilityText = s.replace(dayEndDeadline, '').trim();
  if (/\b(?:if|unless|eligible|created|registered|upgraded|before|after|region|country)\b|符合资格|创建|注册|升级|地区|国家|之前|之后|点前/i.test(eligibilityText)) {
    const condition = eligibilityText.match(/(?:\bif\b|\bunless\b|符合资格|(?:在|于).{0,40}(?:之前|之后|点前).{0,20}(?:创建|注册|升级)|(?:created|registered|upgraded|before|after|创建|注册|升级).{0,100}|(?:region|country|地区|国家).{0,60}).*/i)?.[0];
    if (!condition || /before|after|之前|之后|点前/i.test(condition) && (fixedOffset(condition)===undefined || !/\d{4}[-年]\d{1,2}[-月]\d{1,2}/.test(condition))) return;
    label += `（资格原文：${condition.trim()}）`;
  }
  const region=s.match(/\b(?:in|from)\s+(?:China|the United States|Europe|EU|UK)\b|(?:中国|美国|欧洲|英国)(?:地区|区域)?/i)?.[0];
  if(region)label+=`（地区原文：${region}）`;
  const scope = targeted.test(s) ? 'targeted' : 'public';
  if (scope === 'targeted') label += `（限定范围：${s.match(/(?:some|certain|selected|subset|specific|affected).{0,100}|\d+[km]?\s+(?:users?|accounts?).{0,80}|部分.{0,80}|特定.{0,80}|受(?:故障)?影响.{0,80}/i)?.[0] ?? '定向账户'}）`;
  return { label, key: eligibilityKey(label), scope };
}

export function eligibilityKey(value: string): string {
  let s = normalize(value).toLowerCase();
  // Translate only this verified bare audience; product, plan and other
  // modifiers remain in the key rather than collapsing all targeted groups.
  s=s.replace(/\baffected\s+(?:accounts?|users?)\b/g,'受影响账户');
  s=s.replace(/([（(]限定范围[:：][^（）()]*)\.(?=[）)])/g,'$1');
  s=s.replace(/chatgpt\s*work\s*(?:and|和|与|、|\/)\s*codex|codex\s*(?:and|和|与|、|\/)\s*chatgpt\s*work/g,'codex&chatgptwork');
  s = s.replace(/accounts?|users?|帐号|账号|用户/g, '账户').replace(/所有|全部|每个|每位|每一位|每个人|\ball\b|\beveryone(?:'s)?\b/g, 'all');
  s = s.replace(/\bpaid\b/g, '付费').replace(/\bfree\b/g, '免费').replace(/(?:套餐)?账户/g, '账户').replace(/[\s，。,:：、()（）'的]/g, '');
  const plans=['plus','pro','business'].filter(plan=>new RegExp(`\\b${plan}\\b`,'i').test(value));
  if(plans.length){const remainder=s.replace(/(?:plus|pro|business)(?:(?:and|和|与|、|、|,|\/)\s*(?:plus|pro|business))*/g,'').replace(/^all/, '').replace(/套餐/g,'');return `plans:${plans.join(',')}:${remainder}`;}
  // Only bare synonymous audiences collapse; product/condition/region text is retained.
  if (/^(?:all)?付费账户$/.test(s)) return 'paid';
  if (/^(?:all)?免费账户$/.test(s)) return 'free';
  if (/^(?:all)?账户$/.test(s)) return 'all';
  return s;
}

export function eligibilityMatches(source: string, candidate: string): boolean {
  if (eligibilityKey(source) === eligibilityKey(candidate)) return true;
  const expected = qualification(source);
  const actual = qualification(candidate);
  return Boolean(expected && actual && expected.key === actual.key);
}

function fixedOffset(text: string): number | undefined {
  const zones = [...text.matchAll(/北京时间|中国标准时间|\b(?:PST|PDT|(?:UTC|GMT)(?:\s*[+-]\d{1,2}(?::?\d{2})?)?)\b/gi)];
  const offsets = new Set<number>();
  for (const zone of zones) {
    const token = zone[0].toUpperCase();
    if (/北京时间|中国标准时间/.test(token)) { offsets.add(480); continue; }
    if (token === 'PST' || token === 'PDT') { offsets.add(token === 'PST' ? -480 : -420); continue; }
    const match = token.match(/^(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!match) {
      if (/^\s*[+-]/.test(text.slice(zone.index! + zone[0].length))) return;
      offsets.add(0); continue;
    }
    if (Number(match[2]) > 14 || Number(match[3] ?? 0) > 59 || Number(match[2]) === 14 && Number(match[3] ?? 0) !== 0) return;
    offsets.add((match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)));
  }
  // Each clock must be bound to its own zone before supporting dual-clock text.
  // Never apply a later UTC annotation to an earlier PST clock.
  return offsets.size === 1 ? [...offsets][0] : undefined;
}

function validIsoBenefitTime(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/);
  if (!match) return false;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  return hour < 24 && minute < 60 && Number(match[6] ?? 0) < 60 &&
    calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day &&
    (match[7] === 'Z' || Number(match[8]) < 14 && Number(match[9]) < 60 || Number(match[8]) === 14 && Number(match[9]) === 0);
}

export function benefitTime(text: string, publishedAt: string): Pick<BenefitClaim, 'expectedAt' | 'timeNote'> {
  const s = normalize(text);
  if(!Number.isFinite(Date.parse(publishedAt)))return {timeNote:'原帖发布时间无效，未生成精确预计时间。'};
  if(/\b(?:created|upgraded)\b.{0,80}\b(?:before|after)\b|(?:注册|创建|升级).{0,60}(?:前|之后)|(?:前|之后).{0,30}(?:注册|创建|升级)/i.test(s))return {timeNote:'原文时间用于账户资格截止，不作为发放截止。'};
  if (/有效期|过期|到期失效|自行使用|expire|valid for|use (?:it|the reset)|apply (?:it|the reset)/i.test(s)) return { timeNote: '原文描述重置卡使用或有效期，不作为发放截止。' };
  const offset = fixedOffset(s);
  const namedZone = s.match(/\b(PST|PDT)\b/i)?.[1]?.toUpperCase();
  const zoneNote = namedZone ? `按原文${namedZone}字面${namedZone === 'PST' ? 'UTC-8' : 'UTC-7'}换算，未自行改用当地夏令时；这是公告预计时间，仍待实际确认。` : '已换算为北京时间（UTC+8）';
  const approximate = /~|\b(?:about|approximately|roughly|around|or so)\b|约|大约/i.test(s);
  const note = approximate ? `原文近似时间：约略预计时刻，并非最晚截止，未给出误差范围；${zoneNote}` : zoneNote;
  const pointNote = approximate || /\b(?:by|before|within)\b|(?:小时|分钟)内|最晚|之前|点前/i.test(s) ? note : `原文预计时刻：并非最晚截止；${note}`;
  const isoTimes = [...s.matchAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/g)];
  if(isoTimes.length>1&&(isoTimes.some(item=>!validIsoBenefitTime(item[0]))||new Set(isoTimes.map(item=>Date.parse(item[0]))).size>1))return {timeNote:'原文包含多个不同或无效时刻，尚未确认唯一预计时间。'};
  const iso = isoTimes[0];
  if (iso && validIsoBenefitTime(iso[0]) && Number.isFinite(Date.parse(iso[0]))) return { expectedAt: new Date(iso[0]).toISOString(), timeNote: pointNote };
  // Named PST/PDT is interpreted literally and disclosed. EOD without a zone
  // still has no UTC deadline; an estimate never proves delivery.
  if (hasDayEndDeadline(s) && offset !== undefined && Number.isFinite(Date.parse(publishedAt)) && !/\d{4}[-年]/.test(s)) {
    const sourceDay = new Date(Date.parse(publishedAt) + offset * 60_000);
    const days = /\btomorrow\b|明天/i.test(s) ? 1 : /\byesterday\b|昨日|昨天/i.test(s) ? -1 : 0;
    const deadline = Date.UTC(sourceDay.getUTCFullYear(), sourceDay.getUTCMonth(), sourceDay.getUTCDate() + days + 1) - offset * 60_000;
    return { expectedAt: new Date(deadline).toISOString(), timeNote: approximate ? note : `原文承诺日终前完成，预计最晚时间已换算为北京时间（UTC+8）；${note}` };
  }
  const absolute = s.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日)?\s*(?:at|于)?\s*(\d{1,2}):(\d{2})/i);
  if (absolute && offset !== undefined) {
    const [year, month, day, hour, minute] = absolute.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    if (hour < 24 && minute < 60 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return { expectedAt: new Date(date.getTime() - offset * 60_000).toISOString(), timeNote: pointNote };
  }
  const relative = s.match(/(?:\bin\s+(?:the\s+next\s+)?|\bwithin\s+|发布后|接下来|在)(?:~\s*|about\s+|approximately\s+|roughly\s+|约|大约)?(\d+(?:\.\d+)?|an?|一|二|两|三|四|五|六|七|八|九|十)?\s*(hours?|minutes?|小时|分钟)(?:(?:\s+(?:and\s+)?|\s*(?:和|又)\s*|(?<=小时))(\d+(?:\.\d+)?)\s*(minutes?|分钟))?(?:内)?/i);
  if (relative) {
    const numbers: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const amount = !relative[1] ? /^(?:hour|minute)$/i.test(relative[2]) ? 1 : NaN : /^an?$/i.test(relative[1]) ? 1 : numbers[relative[1]] ?? Number(relative[1]);
    const hours = /hours?|小时/i.test(relative[2]);
    const minutes = relative[3] === undefined ? 0 : Number(relative[3]);
    const duration = amount * (hours ? 3_600_000 : 60_000) + minutes * 60_000;
    const remainder = s.slice(relative.index! + relative[0].length);
    // Do not silently use the first component of a range or an unsupported
    // compound duration. Limits apply to the total duration, not the unit count.
    const extraDuration = /^\s*(?:(?:and|or|to|until)\b|[-–—/,]|(?:和|又))?\s*(?:~\s*|about\s+|approximately\s+|roughly\s+|约|大约)?(?:\d|an?\b|half\b|一|二|两|三|四|五|六|七|八|九|十)/i.test(remainder);
    if (!extraDuration && amount >= 0 && (relative[3] === undefined || hours && minutes >= 0 && minutes < 60) && duration > 0 && duration <= 48 * 3_600_000 && Number.isFinite(Date.parse(publishedAt))) return { expectedAt: new Date(Date.parse(publishedAt) + duration).toISOString(), timeNote: pointNote };
  }
  const local = s.match(/(今天|明天|后天|today|tomorrow)\s*(?:at|于)?\s*(\d{1,2}):(\d{2})/i);
  if (local && offset !== undefined && Number(local[2]) < 24 && Number(local[3]) < 60) {
    const sourceDay = new Date(Date.parse(publishedAt) + offset * 60_000);
    const days = /明天|tomorrow/i.test(local[1]) ? 1 : /后天/.test(local[1]) ? 2 : 0;
    return { expectedAt: new Date(Date.UTC(sourceDay.getUTCFullYear(), sourceDay.getUTCMonth(), sourceDay.getUTCDate() + days, Number(local[2]), Number(local[3])) - offset * 60_000).toISOString(), timeNote: pointNote };
  }
  const clock12 = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (clock12 && offset !== undefined && Number.isFinite(Date.parse(publishedAt))) {
    const hour = Number(clock12[1]), minute = Number(clock12[2] ?? 0);
    if (hour >= 1 && hour <= 12 && minute < 60) {
      const sourceDay = new Date(Date.parse(publishedAt) + offset * 60_000);
      const days = /\btomorrow\b|明天/i.test(s) ? 1 : /\byesterday\b|昨日|昨天/i.test(s) ? -1 : /后天/.test(s) ? 2 : 0;
      const hour24 = hour % 12 + (clock12[3].toLowerCase() === 'pm' ? 12 : 0);
      return { expectedAt: new Date(Date.UTC(sourceDay.getUTCFullYear(), sourceDay.getUTCMonth(), sourceDay.getUTCDate() + days, hour24, minute) - offset * 60_000).toISOString(), timeNote: pointNote };
    }
  }
  if (hasDayEndDeadline(s) || /\b(?:PST|PDT|EOD|tomorrow|today|hours?|minutes?)\b|\d{4}[-年]|明天|后天|今晚|今日|今天|稍后|小时|分钟|日终|当地时间/i.test(s)) return { timeNote: `原文预计时间：${s.slice(0,180)}；日期、精度或时区尚不明确，未生成精确截止。` };
  return {};
}

/** Finite supported assertions only. Unknown grammar is left for enrichment/generation. */
export function extractBenefitClaims(text: string, publishedAt: string): BenefitClaim[] {
  if (isTruncatedBenefitText(text)) return [];
  const clauses = benefitClauses(text);
  const claims: BenefitClaim[] = [];
  for (let index = 0; index < clauses.length; index++) {
    const clause = clauses[index];
    const next = clauses[index + 1];
    // A product reset followed by a direct invitation to burn usage identifies
    // a usage action. It does not assert paid plans or expand to every plan.
    const productUsageAnnouncement = /^your\s+(?:Codex\s+and\s+ChatGPT\s+Work|ChatGPT\s+Work\s+and\s+Codex)\s+reset\s+will\s+land\b/i.test(normalize(clause)) &&
      !!next && /^I\s+challenge\s+you\s+to\s+burn\s+(?:as\s+much\s+)?usage\b/i.test(normalize(next)) &&
      !excluded.test(text) && !targeted.test(text) &&
      !/\b(?:banked|not|never|unconfirmed|rumou?rs?|maybe|only|except|excluding|selected|specific|affected|if|unless|created|registered|upgraded|region|country)\b|\b(?:my|your|our)\s+accounts?\b/i.test(text);
    const kinds = productUsageAnnouncement ? ['automatic_reset' as const] : benefitKinds(clause);
    if (kinds.length !== 1 || /^(?:as (?:mentioned|promised)|previously|yesterday|see (?:above|parent))\b|之前提到|接上|参见父帖/i.test(clause)) continue;
    const stage = benefitStage(clause);
    // A possessive "everyone's account" may refer to one explicitly introduced
    // product-user audience in this same original post. It never lends plan/region/tense.
    const antecedents=clauses.slice(0,index).filter(item=>/(?:active\s+)?users\s+(?:who\s+are\s+(?:now\s+)?using|across|of)\b/i.test(item)&&/\bCodex\b|ChatGPT\s*Work/i.test(item));
    const antecedent=/\beveryone(?:'s|’s)\s+(?:paid\s+)?accounts?\b/i.test(clause)&&!(/\bCodex\b|ChatGPT/i.test(clause))&&antecedents.length===1?antecedents[0]:undefined;
    const inferredAudience=antecedent?[/ChatGPT\s*Work/i.test(antecedent)?'ChatGPT Work':'',/\bCodex\b/i.test(antecedent)?'Codex':''].filter(Boolean).join('和'):undefined;
    // A directly following "For all paid users ..." sentence qualifies the
    // preceding single action, not a different action elsewhere in the post.
    const audienceFollowup = next && benefitKinds(next).length === 0 && /^(?:for|to)\s+(?:all|every|paid|plus|pro|business)\b/i.test(next) ? next : undefined;
    const predicate = clause.match(/\bwe\s+have\s+(?:now\s+|just\s+|already\s+)*reset\s+usage\b/i);
    const milestonePrefix = predicate?.index !== undefined && /\b(?:hit|reached)\b.{0,40}\bactive\s+users\b.{0,40}\b(?:to celebrate|celebrat)/i.test(clause.slice(0, predicate.index));
    let audienceClause = milestonePrefix ? clause.slice(predicate!.index) : clause;
    // In "credit every user with a BANKED reset", "with" introduces the
    // delivered object, not an existing-membership condition on the user.
    const deliveryObject = audienceClause.match(/\bcredit\s+.{0,120}\b(?:users?|accounts?)\s+(with\s+(?:a|one|the)\s+banked\s+reset)\b/i);
    if (deliveryObject) audienceClause = audienceClause.slice(0, audienceClause.indexOf(deliveryObject[1], deliveryObject.index));
    // The purpose of spending restored usage is not account eligibility.
    audienceClause = audienceClause.split(/\s+so\s+that\s+you\s+can\b/i)[0];
    const productAudience: Qualification | undefined = productUsageAnnouncement ? {label:'Codex和ChatGPT Work用户（原帖未列明具体套餐）',key:eligibilityKey('Codex和ChatGPT Work用户（原帖未列明具体套餐）'),scope:'public'} : undefined;
    const audience = qualification(`${audienceClause}${audienceFollowup ? ' ' + audienceFollowup : ''}`,inferredAudience) ?? productAudience;
    if (!stage || !audience) continue;
    // A neighboring time sentence may qualify this one action, never a different benefit.
    const following = clauses.slice(index + (audienceFollowup ? 2 : 1), index + 4);
    const timeCandidate = following.find((item, position) =>
      !following.slice(0, position).some(other => benefitKinds(other).length) &&
      (position === 0 || /^(?:First one will land|Lands?\b)/i.test(item)) &&
      /^(?:Should be showing|First one will land|Will be there|Lands?\b|预计|将在|应在)/i.test(item));
    const timeFollowup = timeCandidate && benefitKinds(timeCandidate).length === 0 && /^(?:Should be showing|First one will land|Will be there|Lands?\b|预计|将在|应在)/i.test(timeCandidate) ? timeCandidate : undefined;
    const last = timeFollowup ?? audienceFollowup ?? (productUsageAnnouncement ? next : undefined);
    const quote = last || antecedent ? text.slice(text.indexOf(antecedent??clause), last?text.indexOf(last,text.indexOf(clause))+last.length:text.indexOf(clause)+clause.length) : clause;
    claims.push({ kind: kinds[0], stage, eligibility: audience.label, scope: audience.scope, quote, ...(stage === 'claimed_complete' || stage === 'cancelled' ? {} : benefitTime(quote, publishedAt)) });
  }
  return claims;
}

/** Replies inherit only an explicit parent claim, with one unambiguous benefit audience. */
export function extractReplyClaims(text: string, publishedAt: string, parents: BenefitClaim[]): BenefitClaim[] {
  const kinds = benefitKinds(text);
  if (isTruncatedBenefitText(text) || parents.length !== 1 || kinds.length > 1 || kinds.length === 1 && kinds[0] !== parents[0].kind || excluded.test(text)) return [];
  // An explicit-kind reply still requires its saved parent when it omits the
  // audience. Accept direct reset assertions, not reports about another user.
  if (kinds.length && !/^(?:the\s+)?(?:banked\s+resets?|(?:usage|rate)\s+limits?(?:\s+reset)?|global\s+reset)\b|^(?:重置卡|用量重置)/i.test(normalize(text))) return [];
  const clauses = benefitClauses(text);
  const statement = clauses.find(clause => benefitStage(clause) && /land(?:ed|ing)?|propagated|credited|loaded|completed|be there|^all\s+reset\s+for\s+everyone|\b(?:cancel(?:led|ed)?|withdraw(?:n)?|withdrew)\b|已确认|落地|到账|传播|取消|撤回/i.test(clause)) ?? text;
  if (/\b(?:rumou?rs?|unconfirmed|alleged|reports?|someone|a user)\b|传闻|据说|有人称/i.test(text)) return [];
  const stage = benefitStage(statement);
  if (!stage || !/land(?:ed|ing)?|propagated|credited|loaded|completed|be there|^all\s+reset\s+for\s+everyone|\b(?:cancel(?:led|ed)?|withdraw(?:n)?|withdrew)\b|已确认|落地|到账|传播|取消|撤回/i.test(statement)) return [];
  if (/\bnot all\b|\b(?:except|excluding|only for|selected|specific|affected)\b|并非所有|不是所有|仅|部分|定向/i.test(text)) return [];
  if (clauses.some(clause => /\b(?:not|never|no|won't|haven't|hasn't|didn't|unconfirmed|rumou?rs?)\b.{0,40}\b(?:reset|land|propagat|load|credit|complete|account)/i.test(clause))) return [];
  if (clauses.filter(clause => clause !== statement).some(clause => {
    const other = benefitStage(clause);
    return !!other && other !== stage && /reset|land|propagat|load|credit|cancel|withdraw/i.test(clause);
  })) return [];
  const parent = parents[0];
  const explicit = qualification(text);
  // "All accounts" in a reply does not expand its parent's qualified accounts.
  if (explicit && eligibilityKey(explicit.label) !== 'all' && !eligibilityMatches(parent.eligibility, explicit.label)) return [];
  const nextStage = stage === 'promised' && parent.stage === 'in_progress' ? 'in_progress' : stage;
  return [{ ...parent, stage: nextStage, quote: text, expectedAt: undefined, timeNote: undefined, ...(nextStage === 'claimed_complete' || nextStage === 'cancelled' ? {} : benefitTime(statement, publishedAt)) }];
}
