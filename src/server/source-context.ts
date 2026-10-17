import type { Evidence } from '../lib/types';
import { extractBenefitClaims, extractReplyClaims, hasDayEndDeadline, isTruncatedBenefitText, type BenefitClaim } from './benefit-rules';

export function namespace(evidence: Evidence): string {
  const account = evidence.url.match(/^https:\/\/(?:x|twitter)\.com\/([^/?#]+)\/status\/[^/?#]+(?:[?#].*)?$/i)?.[1];
  return account ? `x:${account.toLowerCase()}` : `source:${evidence.sourceId}`;
}

export function isExplicitParent(child: Evidence, parent: Evidence, allowManual = false): boolean {
  return Boolean(child.parentId && child.parentId === parent.messageId &&
    child.id !== parent.id && Date.parse(parent.publishedAt)<=Date.parse(child.publishedAt) && (allowManual || parent.provenance !== 'manual') &&
    namespace(child) === namespace(parent));
}

/** Only follow relationships present in source data; nearby timestamps are not evidence. */
export function gatherExplicitEvidenceContext(primary: Evidence, all: Evidence[]): Evidence[] {
  const result = [primary];
  const seen = new Set([`${namespace(primary)}:${primary.messageId}`]);
  let current = primary;
  for (let depth = 0; depth < 20 && current.parentId; depth++) {
    const parent = selectOriginal(all.filter(e => isExplicitParent(current, e)));
    if (!parent) break;
    const key = `${namespace(parent)}:${parent.messageId}`;
    if (seen.has(key)) break;
    seen.add(key);
    result.push(parent);
    current = parent;
  }
  return result;
}

export function hasCompleteContext(evidence: Evidence, cited: Evidence[], allowManual = false, visited = new Set<string>()): boolean {
  if (isTruncatedText(evidence.text) || originalConflict(evidence,cited)) return false;
  if (visited.has(evidence.id)) return false;
  if (evidence.provenance === 'manual') {
    if (!allowManual) return false;
    if (evidence.contextComplete) return true;
    // Human review may resolve an incomplete reply through an explicitly cited
    // parent, without rewriting the original evidence's completeness flag.
  }
  // An archive description never becomes original evidence because an old flag says complete.
  if (evidence.textOrigin === 'archive_excerpt') return false;
  if (campaignClaim(evidence,cited) || isCampaignRule(evidence)) return true;
  if (evidence.contextComplete && (evidence.textOrigin === 'structured' || hasStandaloneContext(evidence.text,'reset') || hasStandaloneContext(evidence.text,'product'))) return true;
  const next = new Set(visited).add(evidence.id);
  const parent = selectOriginal(cited.filter(e => isExplicitParent(evidence, e, allowManual)));
  return Boolean(parent && hasCompleteContext(parent, cited, allowManual, next));
}

export function isTruncatedText(text: string): boolean {
  return isTruncatedBenefitText(text);
}

export function hasStandaloneContext(text: string, category: 'reset' | 'product'): boolean {
  // Truncated text and implicit references must be resolved, irrespective of text length.
  if (isTruncatedText(text) || /^\s*@/.test(text)) return false;
  // A complete present assertion with its own kind and audience does not need
  // a parent just because its foreword mentions yesterday's announcement.
  if (category === 'reset' && extractBenefitClaims(text, '2000-01-01T00:00:00Z').length > 0) return true;
  if (/(?:见|参见|接上|回复)(?:父帖|上文|上一条)|之前提到|上次|昨天提到|\b(?:as (?:mentioned|promised)|previously|yesterday|see (?:above|parent))\b/i.test(text)) return false;
  if (category === 'product') {
    return /codex|chatgpt|gpt[-\s]\d|\bapi\b|plugin|模型|客户端|命令行|应用|连接器|插件|功能|版本/i.test(text) &&
      /发布|上线|新增|支持|修复|更新|改进|推出|默认上下文长度已从\s*\d+(?:\.\d+)?[km]?\s*提升至\s*\d+(?:\.\d+)?[km]?|shipped|released|introduc|added|support|improv|fixed|can now|\bnow\b|rolling out|is live|public beta|saves|faster|available|go from|optimized|\bwe have increased default context length\b/i.test(text);
  }
  return extractBenefitClaims(text, '2000-01-01T00:00:00Z').length > 0;
}

/** Shared by template and model validation; only an explicit saved parent may supply a referent. */
export function evidenceBenefitClaims(evidence: Evidence, cited: Evidence[], allowManual = false, visited = new Set<string>()): BenefitClaim[] {
  if (visited.has(evidence.id) || !hasCompleteContext(evidence,cited,allowManual)) return [];
  const direct = directEvidenceBenefitClaims(evidence,cited);
  if (direct.length) return direct.map(claim => withArchivedDayEnd(evidence, claim));
  const parent = selectOriginal(cited.filter(item => isExplicitParent(evidence,item,allowManual)));
  if (!parent) return [];
  return extractReplyClaims(evidence.text,evidence.publishedAt,evidenceBenefitClaims(parent,cited,allowManual,new Set(visited).add(evidence.id)));
}

/** The fixed archive's linked schedule is an attributed estimate, never an
 * original clock time or evidence that the reset has completed. */
function withArchivedDayEnd(evidence: Evidence, claim: BenefitClaim): BenefitClaim {
  const schedule = evidence.metadata?.scheduledReset;
  if (!schedule || claim.expectedAt || claim.stage !== 'promised' || claim.scope !== 'public' ||
      !hasDayEndDeadline(claim.quote) || evidence.textOrigin !== 'original' || !evidence.contextComplete ||
      evidence.sourceId !== 'reset-archive' || evidence.provenance !== 'archive' ||
      evidence.metadata?.sourceGroup !== 'codex-resets' || schedule.sourceUrl !== 'https://codex-resets.com/zh-CN' ||
      schedule.kind !== claim.kind) return claim;
  const postId = evidence.url.match(/^https:\/\/(?:x|twitter)\.com\/thsottiaux\/status\/(\d+)(?:[?#].*)?$/i)?.[1];
  const published = Date.parse(evidence.publishedAt);
  const deadline = Date.parse(schedule.expectedAt);
  if (postId !== evidence.messageId || !Number.isFinite(published) || !Number.isFinite(deadline) ||
      !validScheduleTimestamp(schedule.expectedAt) ||
      deadline <= published || deadline - published > 36 * 3_600_000) return claim;
  return { ...claim, expectedAt: new Date(deadline).toISOString(), timeNote: '预计最晚时间采用 Codex Resets 归档的日终换算（北京时间 UTC+8）；原帖仅承诺日终前，归档换算仅供参考，仍待实际重置确认。' };
}

function validScheduleTimestamp(value: string): boolean {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/);
  if (!match) return false;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return hour < 24 && minute < 60 && Number(match[6] ?? 0) < 60 &&
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day &&
    (match[7] === 'Z' || Number(match[8]) < 14 && Number(match[9]) < 60 || Number(match[8]) === 14 && Number(match[9]) === 0);
}

/** Complete originals outrank later excerpts. Divergent originals need review. */
export function selectOriginal(versions: Evidence[]): Evidence | undefined {
  return [...versions].sort((a,b)=>Number(b.textOrigin==='original'&&!isTruncatedText(b.text))-Number(a.textOrigin==='original'&&!isTruncatedText(a.text)) || b.collectedAt.localeCompare(a.collectedAt)||b.id.localeCompare(a.id))[0];
}
export function originalConflict(item:Evidence,all:Evidence[]):boolean {
  if(item.textOrigin!=='original')return false;
  const clean=(s:string)=>s.replace(/\s*https?:\/\/t\.co\/\S+/g,'').replace(/(?:https?:\/\/)?\bpic\.twitter\.com\/[A-Za-z0-9]+\b/gi,'').replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim();
  return all.some(other=>other.id!==item.id&&namespace(other)===namespace(item)&&other.messageId===item.messageId&&other.textOrigin==='original'&&!isTruncatedText(other.text)&&!isTruncatedText(item.text)&&
    (clean(other.text)!==clean(item.text)||!!other.parentId&&!!item.parentId&&other.parentId!==item.parentId));
}
function isCampaignRule(item:Evidence):boolean {
  return item.textOrigin==='original'&&item.provenance!=='manual'&&!isTruncatedText(item.text)&&/over the next (\d+) days, each day we[’']ll either ship one thing.{0,160}codex\/work users or ship a full reset\./i.test(item.text);
}
export function isCampaignResetShorthand(item:Evidence):boolean {
  return item.textOrigin==='original'&&!isTruncatedText(item.text)&&/(?:^|\n)\s*Day\s+\d+\s*\/\s*(?:Le\s+limit\s+)?Reset[.!]?\s*(?:https:\/\/t\.co\/[A-Za-z0-9]+\s*)?$/i.test(item.text)&&
    !/\b(?:banked|not|never|cancel|cancelled|only|except|if|maybe|hypothetical)\b/i.test(item.text);
}
function localDay(at:string,zone:string):string|undefined {
  try {const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));return ['year','month','day'].map(k=>parts.find(p=>p.type===k)?.value).join('-');} catch{return;}
}
/** The archive supplies a calendar, not the benefit assertion. Verify that
 * calendar against an original Day 1 with an explicit campaign parent. */
function campaignProof(item:Evidence,all:Evidence[]):Evidence[]|undefined {
  if(item.textOrigin!=='original'||item.provenance==='manual'||originalConflict(item,all))return;
  const days=Number(item.text.match(/(?:^|\n)\s*(?:Roundup of )?Day\s+(\d+)\s*\//i)?.[1]);
  if(!Number.isInteger(days)||days<1)return;
  const matches:Evidence[][]=[];
  for(const rule of all.filter(e=>namespace(e)===namespace(item)&&isCampaignRule(e)&&!originalConflict(e,all)&&Date.parse(e.publishedAt)<=Date.parse(item.publishedAt))) {
    const total=Number(rule.text.match(/next (\d+) days/i)?.[1]);
    if(days>total)continue;
    const anchors=all.filter(e=>namespace(e)===namespace(item)&&e.textOrigin==='original'&&!isTruncatedText(e.text)&&e.parentId===rule.messageId&&/^Day 1\//i.test(e.text)&&!originalConflict(e,all)&&Date.parse(e.publishedAt)<=Date.parse(item.publishedAt));
    const calendars=all.filter(e=>namespace(e)===namespace(item)&&e.metadata?.activity?.days===total&&e.metadata?.activity?.startsOn&&e.metadata?.activity?.timezone);
    const valid=new Map<string,Evidence>();
    for(const calendar of calendars){
      const a=calendar.metadata!.activity!;
      const date=localDay(item.publishedAt,a.timezone);
      if(!anchors.some(e=>localDay(e.publishedAt,a.timezone)===a.startsOn)||!date)continue;
      const day=(Date.parse(date+'T00:00:00Z')-Date.parse(a.startsOn+'T00:00:00Z'))/86400000+1;
      if(day===days)valid.set(JSON.stringify([a.id,a.startsOn,a.timezone,total]),calendar);
    }
    if(valid.size===1)matches.push([rule,anchors[0],[...valid.values()][0]]);
    else if(valid.size>1)return;
  }
  const unique=new Map(matches.map(proof=>[namespace(proof[0])+':'+proof[0].messageId,proof]));
  return unique.size===1?[...unique.values()][0]:undefined;
}
export function campaignClaim(item:Evidence,all:Evidence[]):BenefitClaim|undefined {
  if(item.textOrigin!=='original'||isTruncatedText(item.text)||originalConflict(item,all))return;
  const processed=item.text.match(/(?:Therefore\s*\.\.\.\s*)?(the reset has been processed[.!]?)/i);
  const lineage=gatherExplicitEvidenceContext(item,all);
  const dayItem=isCampaignResetShorthand(item)?item:processed?lineage.slice(1).find(e=>/(?:^|\n)\s*(?:Roundup of )?Day\s+\d+\s*\//i.test(e.text)):undefined;
  if(!dayItem||!campaignProof(dayItem,all))return;
  if(processed&&/\b(?:not|never|only|except|if|maybe|banked|cancelled)\b/i.test(item.text))return;
  return {kind:'automatic_reset',stage:processed?'claimed_complete':'promised',scope:'public',eligibility:'活动中的Codex/Work用户（原帖未列明具体套餐及到账资格）',quote:processed?processed[1]:item.text};
}
export function directEvidenceBenefitClaims(item:Evidence,all:Evidence[]):BenefitClaim[] {
  const direct=extractBenefitClaims(item.text,item.publishedAt);
  const campaign=campaignClaim(item,all);
  return direct.length?direct:campaign?[campaign]:[];
}
export function gatherEvidenceContext(primary:Evidence,all:Evidence[]):Evidence[] {
  const lineage=gatherExplicitEvidenceContext(primary,all);
  const dayItem=lineage.find(e=>/(?:^|\n)\s*(?:Roundup of )?Day\s+\d+\s*\//i.test(e.text));
  const proof=dayItem?campaignProof(dayItem,all):undefined;
  const versions=all.filter(e=>e.textOrigin==='original'&&lineage.some(p=>namespace(p)===namespace(e)&&p.messageId===e.messageId));
  return [...new Map([...lineage,...(proof??[]),...versions].map(e=>[e.id,e])).values()];
}

export function isVerifiedCampaignCalendar(item:Evidence,all:Evidence[]):boolean {
  return !!item.metadata?.activity&&all.some(day=>campaignProof(day,all)?.some(proof=>proof.id===item.id));
}

/** Follow explicit reply lineage to its verified campaign day. Publication
 * dates alone never establish membership, including a reply on the next day. */
export function campaignMembership(item:Evidence,all:Evidence[]):{activityId:string;activityDay:number}|undefined {
  if(item.provenance==='manual')return;
  const day=gatherExplicitEvidenceContext(item,all).find(e=>/(?:^|\n)\s*(?:Roundup of )?Day\s+\d+\s*\//i.test(e.text));
  if(!day)return;
  const proof=campaignProof(day,all),activity=proof?.find(e=>e.metadata?.activity)?.metadata?.activity;
  if(!activity)return;
  const ids=new Set(all.filter(e=>namespace(e)===namespace(day)&&e.metadata?.activity?.startsOn===activity.startsOn&&e.metadata.activity.timezone===activity.timezone&&e.metadata.activity.days===activity.days).map(e=>e.metadata!.activity!.id));
  if(ids.size!==1)return;
  return {activityId:activity.id,activityDay:Number(day.text.match(/(?:^|\n)\s*(?:Roundup of )?Day\s+(\d+)\s*\//i)![1])};
}

export function processingObstacles(context:Evidence[]):{codes:string[];missing:boolean;conflict:boolean} {
  const primary=context[0];
  if(!primary)return {codes:['rule_unsupported'],missing:false,conflict:false};
  const codes:string[]=[];
  if(context.some(e=>originalConflict(e,context)))codes.push('evidence_conflict');
  if(context.some(e=>isTruncatedText(e.text)||e.textOrigin==='archive_excerpt'&&!isVerifiedCampaignCalendar(e,context)&&!context.some(o=>o.textOrigin==='original'&&o.messageId===e.messageId&&namespace(o)===namespace(e)&&!isTruncatedText(o.text))))codes.push('truncated_body');
  if(context.some(e=>e.parentId&&!context.some(p=>isExplicitParent(e,p))))codes.push('missing_parent');
  if(!evidenceBenefitClaims(primary,context).length&&/reset|重置|banked/i.test(primary.text))codes.push('ambiguous_kind_or_audience');
  if(!codes.length)codes.push('rule_unsupported');
  return {codes,missing:codes.includes('truncated_body')||codes.includes('missing_parent'),conflict:codes.includes('evidence_conflict')};
}
