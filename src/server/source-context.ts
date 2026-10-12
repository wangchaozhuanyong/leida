import type { Evidence } from '../lib/types';
import { extractBenefitClaims, extractReplyClaims, hasDayEndDeadline, isTruncatedBenefitText, type BenefitClaim } from './benefit-rules';

function namespace(evidence: Evidence): string {
  const account = evidence.url.match(/^https:\/\/(?:x|twitter)\.com\/([^/?#]+)\/status\/[^/?#]+(?:[?#].*)?$/i)?.[1];
  return account ? `x:${account.toLowerCase()}` : `source:${evidence.sourceId}`;
}

export function isExplicitParent(child: Evidence, parent: Evidence, allowManual = false): boolean {
  return Boolean(child.parentId && child.parentId === parent.messageId &&
    child.id !== parent.id && (allowManual || parent.provenance !== 'manual') &&
    namespace(child) === namespace(parent));
}

/** Only follow relationships present in source data; nearby timestamps are not evidence. */
export function gatherEvidenceContext(primary: Evidence, all: Evidence[]): Evidence[] {
  const result = [primary];
  const seen = new Set([`${namespace(primary)}:${primary.messageId}`]);
  let current = primary;
  for (let depth = 0; depth < 20 && current.parentId; depth++) {
    const parent = all.filter(e => isExplicitParent(current, e))
      .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt) || b.id.localeCompare(a.id))[0];
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
  if (isTruncatedText(evidence.text)) return false;
  if (visited.has(evidence.id)) return false;
  if (evidence.provenance === 'manual') {
    if (!allowManual) return false;
    if (evidence.contextComplete) return true;
    // Human review may resolve an incomplete reply through an explicitly cited
    // parent, without rewriting the original evidence's completeness flag.
  }
  // An archive description never becomes original evidence because an old flag says complete.
  if (evidence.textOrigin === 'archive_excerpt') return false;
  if (evidence.contextComplete && (evidence.textOrigin === 'structured' || hasStandaloneContext(evidence.text,'reset') || hasStandaloneContext(evidence.text,'product'))) return true;
  const next = new Set(visited).add(evidence.id);
  const parent = cited.filter(e => isExplicitParent(evidence, e, allowManual))
    .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt) || b.id.localeCompare(a.id))[0];
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
  const direct = extractBenefitClaims(evidence.text,evidence.publishedAt);
  if (direct.length) return direct.map(claim => withArchivedDayEnd(evidence, claim));
  const parent = cited.filter(item => isExplicitParent(evidence,item,allowManual)).sort((a,b)=>b.collectedAt.localeCompare(a.collectedAt)||b.id.localeCompare(a.id))[0];
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
