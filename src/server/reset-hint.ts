import type {PublicResetHint,ResetSignalReview} from '../lib/forecast';
import type {Evidence} from '../lib/types';
import {benefitClauses, benefitStage, benefitTime, benefitTimingText, excludedBenefitAssertion, isTruncatedBenefitText} from './benefit-rules';
import {languageKinds, speechDisposition} from './benefit-language';

const DAY = 86400000;
export const RESET_SIGNAL_WINDOW_MS = 2 * DAY;
export const RESET_SIGNAL_LOOKBACK_MS = 8 * DAY;
const pacific = new Intl.DateTimeFormat('en-CA', {
  timeZone:'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit',
});
const pacificOffset = new Intl.DateTimeFormat('en-US', {
  timeZone:'America/Los_Angeles', timeZoneName:'longOffset',
});
const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const dayLabels = ['周日','周一','周二','周三','周四','周五','周六'];
const relativeDays: Record<string, number> = {today:0,tomorrow:1,今天:0,今日:0,明天:1,明日:1,后天:2};
const dayPattern=/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b|(?:周|星期)[一二三四五六日天]|今天|今日|明天|明日|后天/gi;
const calendarDate=/\b(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日)?/;
const clockPattern=/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b|(\d{1,2})点(?:(\d{1,2})分?)?/i;
const zonePattern=/北京时间|中国标准时间|\b(?:PST|PDT|PT|EST|EDT|ET|(?:UTC|GMT)(?:\s*[+-]\d{1,2}(?::?\d{2})?)?)\b/gi;
type SourceZone=number|'pacific'|'eastern';
const easternDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const easternOffset=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'longOffset'});
const hedge = /\b(?:perhaps|maybe|might|may|could|possibly|considering|thinking about|leaning toward|tempted to|would be a good time|on the table|under consideration|toying with)\b|可能|或许|也许|考虑/i;
const future = /\b(?:will|going to|plan(?:ning)? to|intend to|should|expect(?:ing)?|scheduled|upcoming)\b|将(?:会|于)?|计划|打算|预计|拟|准备/i;
const issuance = /\b(?:issu\w*|send\w*|giv\w*|deliver\w*|grant\w*|load\w*|drop\w*|hand\w* out|put\w* out|land\w*|coming|reset\w*|refill\w*|refresh\w*|replenish\w*|restor\w*)\b|重置|发放|发卡|到账|补(?:发|张)|恢复/i;
const past = /\b(?:yesterday|last (?:week|month|night)|previously|used to|(?:may|might|could|must) have)\b|昨天|上(?:周|月)|曾经|此前/i;
const tutorial = /\b(?:how to|guide to|how (?:do|can) (?:i|you)|(?:if|when) you (?:use|redeem))\b|教程|如何|怎么使用/i;
const personal = /\b(?:use|apply|spend|redeem)\b.{0,50}\b(?:banked|reset card)|\b(?:my|our own|your own) (?:account|banked reset|reset card|quota)\b|(?:个人|我自己的).{0,15}(?:账户|额度|重置卡)|(?:使用|兑换).{0,12}重置卡/i;
const hypothetical = /\b(?:no joke|just kidding|joking|hypothetical|if|unless|cancel\w*|withdraw\w*)\b|开玩笑|假设|如果|取消|撤回/i;
const denial = /\b(?:not|never|won['’]t|no plans?)\b|不再|不会|尚未|未曾|并未|没有|暂不|取消|撤回/i;
const stop = /\b(?:cancel(?:led|ed)?|withdraw(?:n)?|called off|scrapped)\b|取消|撤回/i;
const noIssuance=/\b(?:no (?:more|further|new)|(?:not|never|won['’]t) (?:be |ever )?(?:issu\w*|giv\w*|send\w*|deliver\w*|grant\w*|do(?:ing)?|reset\w*))\b|不再发放|不再重置|不会发放|不会重置/i;
const deferred=/\b(?:not yet|not (?:today|tonight|tomorrow|this (?:week|month))|reschedul\w*|postpon\w*|delay\w*|push(?:ed|ing)? back)\b|(?:今天|今日|今晚|明天|本周)(?:暂时)?(?:不|不会)|暂不|还没|尚未|延后|改期|推迟/i;
const limitedTiming=/\b(?:today|tonight|tomorrow|until|before|this (?:week|month))\b|今天|今日|今晚|明天|本周|之前|以后|之后/i;
const cancellationUncertain=/\b(?:not|never|haven['’]t|didn['’]t|isn['’]t|wasn['’]t|without)\s+(?:been\s+)?(?:cancel|withdraw)|\b(?:might|maybe|may|perhaps|if|unless|reported|heard)\b|\bno\s+(?:reset\s+)?cancellations?\b|(?:没有|未|不会|不再|并未|并没有|未曾|无需|不用|暂不|未决定|不打算)(?:予以)?(?:取消|撤回)|可能|或许|据说/i;

function canonical(text:string):string {
  return text.replace(/\breset\s+cards?\b/gi,'banked reset').replace(/储备卡|备用卡|充值卡/g,'重置卡');
}

function ownText(text:string):string {
  return text.replace(/“[^”]*(?:”|$)|"[^"]*(?:"|$)|https?:\/\/\S+/g,' ').trim();
}

export function resetSignalKinds(text:string):PublicResetHint['kind'][] {
  const clean=canonical(text);
  const kinds=languageKinds(clean);
  if(/额度.{0,6}重置|重置.{0,6}额度|\b(?:quota|allowance|limit)\s+reset\b/i.test(clean)&&!kinds.includes('automatic_reset'))kinds.push('automatic_reset');
  if(/发卡/.test(clean)&&!kinds.includes('banked_reset'))kinds.push('banked_reset');
  return kinds;
}

export function mentionsResetSignal(text:string):boolean {
  return resetSignalKinds(text).length>0||/\b(?:banked|reset(?:s|ting)?|refill(?:s|ing)?)\b|重置|发卡/.test(text.toLowerCase());
}

export function excludedResetSignal(text:string):boolean {
  const clean=ownText(text);
  return !clean||excludedBenefitAssertion(clean)||tutorial.test(clean)||personal.test(clean)||past.test(clean)||
    ['denied','reported'].includes(speechDisposition(clean))||denial.test(clean)||hypothetical.test(clean)||
    /\b(?:only (?:for|to)|a single|selected|affected)\s+(?:\w+\s+){0,3}(?:accounts?|users?)\b|仅限.{0,12}(?:账户|用户)|部分(?:受影响)?用户/i.test(clean);
}

export function isResetSignalDelay(text:string):boolean {
  return benefitClauses(ownText(text)).some(clause=>deferred.test(clause)||noIssuance.test(clause)&&limitedTiming.test(clause));
}

/** A withdrawn arrangement can end a clock. A delay or "not yet" cannot. */
export function cancelsResetSignal(text:string):boolean {
  const clean=ownText(text).replace(/[’‘]/g,"'");
  if(/[?？]/.test(clean)||cancellationUncertain.test(clean)||past.test(clean)||personal.test(clean)||speechDisposition(clean)==='reported')return false;
  return benefitClauses(clean).some(clause=>resetSignalKinds(clause).length===1&&(
    stop.test(clause)||noIssuance.test(clause)&&!isResetSignalDelay(clause)
  ))||isContextualCancellation(clean);
}

export function isContextualCancellation(text:string):boolean {
  const body=ownText(text).replace(/[’‘]/g,"'").replace(/^@\w+\s+/,'').replace(/[.!。！]+$/,'').trim();
  return /^(?:(?:it|this|that)(?:'s|\s+(?:is|has been|will be))\s+(?:cancelled|canceled|withdrawn|called off|scrapped)|we(?:'ve|\s+(?:have|will))\s+(?:cancel(?:led|ed)?|withdrawn?|called off|scrapped)\s+(?:it|this|that)|(?:已|已经|本轮|这次|这项安排|我们决定)(?:已|将|正式|决定)?(?:取消|撤回)(?:了)?)$/i.test(body);
}

function zoneMinutes(at:number,zone:'pacific'|'eastern'):number {
  const formatter=zone==='pacific'?pacificOffset:easternOffset;
  const value=formatter.formatToParts(at).find(part=>part.type==='timeZoneName')?.value;
  const match=value?.match(/GMT([+-])(\d{2}):(\d{2})/);
  return match?(match[1]==='-'?-1:1)*(Number(match[2])*60+Number(match[3])):NaN;
}

function sourceOffset(text:string):SourceZone|undefined {
  const zones=new Set([...text.matchAll(zonePattern)].map(match=>match[0].toUpperCase().replace(/\s+/g,'')));
  if(zones.size>1)return;
  const [zone]=zones;
  if(!zone||zone==='PT')return 'pacific';
  if(zone==='ET')return 'eastern';
  if(zone==='北京时间'||zone==='中国标准时间')return 480;
  if(zone==='PST'||zone==='PDT')return zone==='PST'?-480:-420;
  if(zone==='EST'||zone==='EDT')return zone==='EST'?-300:-240;
  if(zone==='UTC'||zone==='GMT')return 0;
  const match=zone.match(/^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if(!match)return;
  const minutes=Number(match[3]??0),hours=Number(match[2]);
  if(minutes>=60||hours>14||hours===14&&minutes)return;
  return (match[1]==='-'?-1:1)*(hours*60+minutes);
}

function calendarDay(text:string,publishedAt:number,offset:SourceZone):number|undefined {
  if(!Number.isFinite(publishedAt)||/\b(?:last|this past)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|上[周星期]/i.test(text))return;
  const days=[...text.matchAll(dayPattern)];
  const date=text.match(calendarDate);
  if(days.length>1||days.length&&date)return;
  if(date){
    const [,year,month,day]=date.map(Number),at=Date.UTC(year,month-1,day),calendar=new Date(at);
    if(calendar.getUTCFullYear()===year&&calendar.getUTCMonth()===month-1&&calendar.getUTCDate()===day)return at;
    return;
  }
  const localDate=typeof offset==='number'?new Date(publishedAt+offset*60_000).toISOString().slice(0,10):
    (offset==='pacific'?pacific:easternDate).format(publishedAt);
  const reference=Date.parse(localDate+'T00:00:00Z');
  if(!days.length)return reference;
  const token=days[0][0].toLowerCase(),weekday=weekdays.indexOf(token);
  const named=weekday>=0?weekday:dayLabels.indexOf('周'+token.at(-1)?.replace('天','日'));
  const relative=relativeDays[token];
  if(relative!==undefined)return reference+relative*DAY;
  const shift=(named-new Date(reference).getUTCDay()+7)%7;
  return reference+(shift+(/\bnext\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|下周/i.test(text)&&shift===0?7:0))*DAY;
}

function wallClock(at:number,offset:SourceZone):number|undefined {
  if(typeof offset==='number')return at-offset*60_000;
  // Validate the target wall time in both nearby offsets. A DST gap or an
  // ambiguous hour cannot manufacture an exact deadline.
  const offsets=new Set([zoneMinutes(at-DAY,offset),zoneMinutes(at+DAY,offset)]);
  const matches=[...offsets].filter(Number.isFinite).map(value=>at-value*60_000).filter(utc=>utc+zoneMinutes(utc,offset)*60_000===at);
  if(matches.length===1)return matches[0];
}

function dayHint(text:string,publishedAt:number):{dayLabel:string;expiresAt:string}|undefined {
  if((![...text.matchAll(dayPattern)].length&&!calendarDate.test(text))||clockPattern.test(text))return;
  const offset=sourceOffset(text);
  if(offset===undefined)return;
  const day=calendarDay(text,publishedAt,offset);
  const expires=day===undefined?undefined:wallClock(day+DAY,offset);
  if(expires!==undefined&&expires>publishedAt)return {dayLabel:dayLabels[new Date(day!).getUTCDay()],expiresAt:new Date(expires).toISOString()};
}

export function resetHintTiming(kind:PublicResetHint['kind'], text:string, publishedAt:string):PublicResetHint|undefined {
  // Normalize only the duration phrase. Account eligibility and card expiry
  // still go through the same temporal role checks as formal announcements.
  const numbers:Record<string,number>={a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,twelve:12,twenty:20,'twenty-four':24,'forty-eight':48,'seventy-two':72};
  const duration=text.replace(/\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty-four|twenty|forty-eight|seventy-two)\s+(hours?|minutes?|days?|weeks?)\b/gi,(_,number:string,unit:string)=>numbers[number.toLowerCase()]+' '+unit)
    .replace(/\b(\d+(?:\.\d+)?)\s+(days?|weeks?)\b/gi,(_,value:string,unit:string)=>Number(value)*(unit.toLowerCase().startsWith('day')?24:168)+' hours')
    .replace(/(?<!\d)(?:在)?(\d+|[一二两三四五六七八九十])\s*(天|周)内/g,(_,value:string,unit:string)=>{
      const amount=Number(value)||'一二三四五六七八九十'.indexOf(value.replace('两','二'))+1;
      return '在'+amount*(unit==='天'?24:168)+'小时内';
    })
    .replace(/(?<![\d在])(\d+|[一二两三四五六七八九十])\s*(小时|分钟)内/g,'在$1$2内');
  const at=Date.parse(publishedAt);
  if(!Number.isFinite(at))return;
  const fallback:PublicResetHint={kind,expiresAt:new Date(at+RESET_SIGNAL_WINDOW_MS).toISOString(),windowBasis:'fallback_48h'};
  const delivery=benefitTimingText(duration);
  if(delivery.reason)return fallback;
  const timing=delivery.text;
  const iso=/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(timing);
  const wall=timing.match(clockPattern);
  if(!wall&&/\b(?:by|before)\s+(?:the\s+)?(?:end of (?:the )?(?:day|today|tomorrow)|EOD)\b|(?:今日|今天|明天|当日|当天)结束(?:之)?前|日终(?:之)?前/i.test(timing)){
    const offset=sourceOffset(timing),day=offset===undefined?undefined:calendarDay(timing,at,offset);
    const deadline=day===undefined||offset===undefined?undefined:wallClock(day+DAY,offset);
    if(deadline===undefined||deadline<=at)return;
    return {kind,expiresAt:new Date(deadline).toISOString(),windowBasis:'source_time',timeNote:'原文最晚期限：发布者所述日期结束前'};
  }
  if(!wall||iso){
    const time=benefitTime(timing,publishedAt,Infinity);
    if(time.expectedAt)return Date.parse(time.expectedAt)>at?{kind,expiresAt:time.expectedAt,windowBasis:'source_time',timeNote:time.timeNote}:undefined;
  }
  if(wall&&!iso){
    const offset=sourceOffset(timing);
    const day=offset===undefined?undefined:calendarDay(timing,at,offset);
    const hour=wall[3]?Number(wall[1])%12+(wall[3].toLowerCase()==='pm'?12:0):Number(wall[4]??wall[6]);
    const minute=Number(wall[2]??wall[5]??wall[7]??0);
    const remaining=timing.slice(wall.index!+wall[0].length);
    const multiple=clockPattern.test(remaining);
    const expires=day===undefined||offset===undefined||multiple||hour>=24||minute>=60||
      wall[3]&&(Number(wall[1])<1||Number(wall[1])>12)?undefined:wallClock(day+(hour*60+minute)*60_000,offset);
    if(expires!==undefined&&expires>at){
      const timeNote=/\b(?:around|about|approximately|roughly)\b|大约|左右/i.test(timing)?'原文近似时间':/\b(?:by|before)\b|最晚|之前|点前/i.test(timing)?'原文最晚期限':'原文预计时刻';
      return {kind,expiresAt:new Date(expires).toISOString(),windowBasis:'source_time',timeNote};
    }
    return;
  }
  const day=dayHint(timing,at);
  if(day)return {kind,...day};
  if(iso||calendarDate.test(timing)||[...timing.matchAll(dayPattern)].length||
    /\b(?:EOD|end of (?:the )?day)\b|日终|当天结束/i.test(timing))return;
  return fallback;
}

/** Extract a public hint without assigning a formal benefit stage or delivery deadline. */
export function interpretResetHint(text:string,publishedAt:string):PublicResetHint|undefined {
  const at=Date.parse(publishedAt);
  if(!Number.isFinite(at)||isTruncatedBenefitText(text)||/[?？]/.test(text)||excludedResetSignal(text))return;
  const canonicalText=canonical(ownText(text));
  const kinds=resetSignalKinds(canonicalText);
  if(kinds.length!==1)return;
  const clauses=benefitClauses(canonicalText);
  const mention=clauses.findIndex(part=>resetSignalKinds(part).includes(kinds[0])&&hedge.test(part));
  if(mention<0||clauses.some(part=>resetSignalKinds(part).length&&['claimed_complete','in_progress','cancelled'].includes(benefitStage(part)??'')))return;
  const assertedStage=benefitStage(clauses[mention].replace(hedge,'').replace(/\s+/g,' '));
  if(assertedStage==='claimed_complete'||assertedStage==='in_progress')return;
  const prefix=clauses[mention-1];
  // A preceding Codex framing sentence can supply the day of a linked hint.
  const timing=resetHintTiming(kinds[0],timedSignalClause(clauses,mention,publishedAt,kinds[0]),publishedAt);
  const framed=timing?.windowBasis==='fallback_48h'&&/^(?:perhaps|maybe)\s+also\b/i.test(clauses[mention])&&/\bcodex\w*\b/i.test(prefix??'')?dayHint(prefix,at):undefined;
  return framed?{kind:kinds[0],...framed}:timing;
}

/** A clear forward action with an uncommon verb or a short dated headline. */
export function interpretForwardResetSignal(text:string,publishedAt:string):PublicResetHint|undefined {
  if(!Number.isFinite(Date.parse(publishedAt))||isTruncatedBenefitText(text)||/[?？]/.test(text)||excludedResetSignal(text))return;
  const clean=canonical(ownText(text)),kinds=resetSignalKinds(clean);
  if(kinds.length!==1)return;
  const clauses=benefitClauses(clean);
  const action=clauses.findIndex(clause=>{
    if(!resetSignalKinds(clause).includes(kinds[0])||!issuance.test(clause)||['claimed_complete','in_progress','cancelled'].includes(benefitStage(clause)??''))return false;
    return future.test(clause)||/\b(?:coming|up next|on the way)\b|即将|随后发放/i.test(clause)||
      /^(?:\d+|[一二两三四五六七八九十])\s*(?:小时|分钟)内|^(?:banked reset|(?:global|usage) reset)\s+(?:by|within)\b/i.test(clause);
  });
  return action>=0?resetHintTiming(kinds[0],timedSignalClause(clauses,action,publishedAt,kinds[0]),publishedAt):undefined;
}

/** A following delivery sentence may supply the time of an otherwise untimed clause. */
function timedSignalClause(clauses:string[],index:number,at:string,kind:PublicResetHint['kind']):string {
  const action=clauses[index],next=clauses[index+1];
  if(!next||resetSignalKinds(next).length||!/^(?:(?:it|that) (?:should|will|might) (?:land|be out)|we (?:should|will|might) (?:get it out|ship it)|(?:预计|应该|会)?\s*(?:发放|到账))/i.test(next))return action;
  const following=interpretResetReplyHint(next,at,kind);
  if(!following||following.windowBasis==='fallback_48h')return action;
  return action.replace(/[.!。！]$/,'')+' '+next;
}

/** A short reply may borrow the topic from a verified parent. The date and
 * uncertainty must come from the reply, which can only produce a weak hint. */
export function interpretResetReplyHint(text:string,publishedAt:string,kind:PublicResetHint['kind']):PublicResetHint|undefined {
  const at=Date.parse(publishedAt);
  if(!Number.isFinite(at)||isTruncatedBenefitText(text)||/[?？]/.test(text)||excludedResetSignal(text))return;
  const body=text.replace(/^@\w+\s+/,'').replace(/[.!。！]+$/,'').trim();
  const day='(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
  const reply='(?:(?:we |i )?(?:should|might|may) (?:be able to )?(?:get (?:it|that) (?:done|out)|have (?:it|that) (?:done|ready)|finish (?:it|that)|do (?:it|that)|be ready)|(?:should|might|may) work)';
  const dated=new RegExp('^(?:'+day+'[, ]+'+reply+'|'+reply+'(?: by| on)? '+day+'|'+day+'[, ]+(?:should|might|may) work)$','i').test(body)||
    /^(?:今天|今日|明天|明日|后天|(?:周|星期)[一二三四五六日天])(?:应该|可能|或许|会)(?:能|可以)?(?:搞定|完成|就绪|发放|到账)$/.test(body);
  const followup=/^(?:(?:it|that) (?:should|will|might) (?:land|be (?:out|ready))|we (?:should|will|might) (?:get it (?:done|out)|ship it)|(?:it|that)'?s (?:coming|on the way)|(?:改为)?(?:预计|应该|会)?\s*(?:发放|到账|重置|完成))(?:\s+(?:within|in|by|at|on|soon|later|today|tomorrow)\b.{0,100}|\s*(?:在|于|最晚|\d|[一二两三四五六七八九十]小时).{0,100})?$/i.test(body);
  return dated||followup?resetHintTiming(kind,body,publishedAt):undefined;
}

/** Only a recent original can leave a semantic decision. Dates are always
 * calculated locally from the cited clause; the model supplies no timestamp. */
export function acceptResetSignalReview(value:unknown,context:Evidence[],reviewedAt:string):ResetSignalReview|undefined {
  const primary=context[0];
  if(!primary||!value||typeof value!=='object'||!Number.isFinite(Date.parse(reviewedAt)))return;
  const answer=value as Record<string,unknown>;
  const {disposition,kind,quote}=answer;
  if((disposition!=='future'&&disposition!=='pending'&&disposition!=='excluded')||typeof quote!=='string'||!quote.trim()||
    quote.length>900||!primary.text.includes(quote)||primary.textOrigin!=='original'||isTruncatedBenefitText(primary.text))return;
  if(disposition!=='future')return {disposition,quote,evidenceIds:context.map(e=>e.id),reviewedAt};
  if((kind!=='automatic_reset'&&kind!=='banked_reset')||/[?？]/.test(quote)||excludedResetSignal(quote)||
    !benefitClauses(primary.text).some(clause=>quote.includes(clause))||
    !ownText(primary.text).includes(quote)||excludedResetSignal(primary.text)||['claimed_complete','in_progress','cancelled'].includes(benefitStage(quote)??''))return;
  if(!mentionsResetSignal(quote)&&/\b(?:extra|additional|doubl\w*|increas\w*)\b.{0,24}\b(?:usage|quota|limits?|capacity)\b|(?:补贴|提高|追加).{0,16}(?:用量|额度|上限)/i.test(quote))return;
  const kinds=resetSignalKinds(quote);
  if(kinds.length&&(kinds.length!==1||kinds[0]!==kind))return;
  if(primary.parentId&&!context.some(item=>item.messageId===primary.parentId&&item.textOrigin==='original'&&!isTruncatedBenefitText(item.text)))return;
  return {disposition,kind,quote,evidenceIds:context.map(e=>e.id),reviewedAt};
}
