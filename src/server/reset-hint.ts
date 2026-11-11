import type {PublicResetHint} from '../lib/forecast';
import {benefitStage, excludedBenefitAssertion, isTruncatedBenefitText} from './benefit-rules';
import {languageKinds, speechDisposition} from './benefit-language';

const DAY = 86400000;
const pacific = new Intl.DateTimeFormat('en-CA', {
  timeZone:'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit',
});
const pacificOffset = new Intl.DateTimeFormat('en-US', {
  timeZone:'America/Los_Angeles', timeZoneName:'longOffset',
});
const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const dayLabels = ['周日','周一','周二','周三','周四','周五','周六'];
const relativeDays: Record<string, number> = {today:0,tomorrow:1,今天:0,今日:0,明天:1,明日:1,后天:2};
const hedge = /\b(?:perhaps|maybe|might|may|could|possibly|considering|thinking about|leaning toward|tempted to|would be a good time)\b|可能|或许|也许|考虑/i;

function dayHint(text:string, publishedAt:number):{dayLabel:string;expiresAt:string}|undefined {
  // A named day is a calendar clue. Keep vague or conflicting dates as undated hints.
  if(/\b(?:last|next|this past)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|上[周星期]|下周/.test(text.toLowerCase()))return;
  const days=[...text.matchAll(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b|(?:周|星期)[一二三四五六日天]|今天|今日|明天|明日|后天/gi)];
  if(days.length!==1)return;
  const token=days[0][0].toLowerCase();
  const reference=Date.parse(pacific.format(publishedAt)+'T00:00:00Z');
  const weekday=weekdays.indexOf(token);
  const chineseDay=dayLabels.indexOf('周'+token.at(-1)?.replace('天','日'));
  const named=weekday>=0?weekday:chineseDay;
  const shift=relativeDays[token]??(named-new Date(reference).getUTCDay()+7)%7;
  const date=new Date(reference+shift*DAY);
  const next=new Date(date.getTime()+DAY);
  // Pacific midnight occurs before its local 02:00 DST transition. At UTC
  // midnight the offset is still the same as that upcoming local midnight.
  const offset=pacificOffset.formatToParts(next)
    .find(part=>part.type==='timeZoneName')?.value.replace('GMT','');
  if(!offset)return;
  return {dayLabel:dayLabels[date.getUTCDay()],expiresAt:new Date(next.toISOString().slice(0,10)+'T00:00:00'+offset).toISOString()};
}

/** Extract a public hint without assigning a formal benefit stage or delivery deadline. */
export function interpretResetHint(text:string,publishedAt:string):PublicResetHint|undefined {
  const at=Date.parse(publishedAt);
  if(!Number.isFinite(at)||isTruncatedBenefitText(text)||excludedBenefitAssertion(text)||/[?？]/.test(text))return;
  const ownText=text.replace(/“[^”]*(?:”|$)|"[^"]*(?:"|$)|https?:\/\/\S+/g,' ');
  const canonicalText=ownText.replace(/\breset\s+cards?\b/gi,'banked reset');
  const voice=speechDisposition(canonicalText);
  if(voice==='denied'||voice==='reported'||/\b(?:not|never|won['’]t|no plans?|no joke|just kidding|joking|hypothetical|if|unless|cancel\w*|withdraw\w*)\b|开玩笑|假设|如果|取消|撤回/i.test(ownText))return;
  const kinds=languageKinds(canonicalText);
  if(kinds.length!==1)return;
  const clauses=canonicalText.split(/[.!;。！；]/).map(part=>part.trim()).filter(Boolean);
  const mention=clauses.findIndex(part=>languageKinds(part).includes(kinds[0])&&hedge.test(part));
  if(mention<0||clauses.some(part=>languageKinds(part).length&&benefitStage(part)))return;
  if(/\b(?:use|apply|spend)\b.{0,50}\bbanked reset\b|\b(?:my|your|our own)\s+(?:banked reset|quota)\b|使用.{0,20}重置卡/i.test(clauses[mention]))return;
  const assertedStage=benefitStage(clauses[mention].replace(hedge,'').replace(/\s+/g,' '));
  if(assertedStage==='claimed_complete'||assertedStage==='in_progress')return;
  const prefix=clauses[mention-1];
  // A preceding Codex framing sentence can supply the day of a linked hint.
  const timing=dayHint(clauses[mention],at)
    ?? (/^(?:perhaps|maybe)\s+also\b/i.test(clauses[mention])&&/\bcodex\w*\b/i.test(prefix??'') ? dayHint(prefix,at) : undefined);
  return {kind:kinds[0],expiresAt:new Date(at+2*DAY).toISOString(),...timing};
}


/** A short reply may borrow the topic from a verified parent. The date and
 * uncertainty must come from the reply, which can only produce a weak hint. */
export function interpretResetReplyHint(text:string,publishedAt:string,kind:PublicResetHint['kind']):PublicResetHint|undefined {
  const at=Date.parse(publishedAt);
  if(!Number.isFinite(at)||isTruncatedBenefitText(text)||speechDisposition(text)==='denied'||speechDisposition(text)==='reported')return;
  const timing=dayHint(text,at);
  if(!timing)return;
  const body=text.replace(/^@\w+\s+/,'').replace(/[.!。！]+$/,'').trim();
  const day='(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
  const reply='(?:(?:we |i )?(?:should|might|may) (?:be able to )?(?:get (?:it|that) (?:done|out)|have (?:it|that) (?:done|ready)|finish (?:it|that)|do (?:it|that)|be ready)|(?:should|might|may) work)';
  if(!new RegExp('^(?:'+day+'[, ]+'+reply+'|'+reply+'(?: by| on)? '+day+'|'+day+'[, ]+(?:should|might|may) work)$','i').test(body)&&
     !/^(?:今天|今日|明天|明日|后天|(?:周|星期)[一二三四五六日天])(?:应该|可能|或许)(?:能|可以)?(?:搞定|完成|就绪|发放|到账)$/.test(body))return;
  return {kind,...timing};
}
