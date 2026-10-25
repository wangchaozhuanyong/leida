import type { CadenceObservation } from '../lib/reset-cadence';
import type { Evidence, Source } from '../lib/types';
import { benefitClauses, benefitStage, extractBenefitClaims, isTruncatedBenefitText } from './benefit-rules';
import { directEvidenceBenefitClaims, evidenceBenefitClaims, gatherEvidenceContext, isExplicitParent } from './source-context';

/** Auxiliary training series: public reset statements, never a reader's actual balance. */
const archiveOrigin = 'https://codex-resets.com';
const normalize = (text: string) => text.replace(/[’‘]/g, "'").replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const publicAudience = /\beveryone(?:'s)?\b|\b(?:all|every)\b.{0,80}\b(?:users?|accounts?|plans?|subscriptions?)\b|\bpaid\s+(?:users?|accounts?|plans?|subscriptions?)\b|\byou\s+all\b|全局|所有|全部|每个人|每(?:一)?位/iu;
const limitedAudience = /\b(?:some|certain|selected|subset|specific|affected)\s+(?:\w+\s+){0,3}(?:users?|accounts?)\b|\b\d[\d,]*(?:\.\d+)?[km]?\s+(?:\w+\s+){0,2}(?:users?|accounts?)\b|部分(?:用户|账户)|特定(?:用户|账户)|选定|定向|仅(?:你|我|个人|该账户)/iu;
const privateAction = /\b(?:my|your|our)\s+(?:team|accounts?|workspace|(?:usage\s+|rate\s+)?limits?)\b|\b(?:purchased?|buy|bought|redeem(?:ed|ing)?|referral|invitation|my reset|just you|your account only)\b|购买|兑换|私人|自行(?:用卡|重置)|主动用卡/iu;
const futureAction = /\b(?:will|would|could|might|may|maybe|perhaps|scheduled|plan(?:ned)?\s+to|going\s+to|incoming|by\s+EOD)\b|(?:将|计划|预计|可能|稍后|待).{0,40}(?:重置|发放|到账)|结束前/iu;
const negatedAction = /\b(?:no|not|never|won't|cannot|can't|haven't|hasn't|didn't)\b.{0,35}\b(?:reset|give|given|load|loaded|credit|grant|propagat|complete)|\b(?:reset|resets)\b.{0,30}\b(?:not|never|cancelled|canceled|withdrawn)\b|(?:尚未|没有|并未|不会|取消|撤回|不再).{0,25}(?:重置|发放|到账)|(?:重置|发放).{0,20}(?:取消|撤回)/iu;
const usageReset = /\b(?:usage(?:\s+limits?)?|rate\s+limits?|limits?)\b.{0,100}\breset\b|\breset\b.{0,100}\b(?:usage(?:\s+limits?)?|rate\s+limits?|limits?)\b|(?:用量|使用(?:限制|限额|额度|量)|速率限制).{0,60}重置|重置.{0,60}(?:用量|使用(?:限制|限额|额度|量)|速率限制)/iu;
const bankedReset = /\bbanked\s+resets?\b|\breset\s+bank\b|重置卡|储备重置|备用重置|累积(?:重置)?额度/iu;
const presentOrPast = /\b(?:have|has)\s+(?:now\s+|already\s+|just\s+|been\s+|fully\s+)*(?:reset|added|given|loaded|credited|granted)\b|\b(?:are|is)\s+(?:now\s+)?(?:resetting|giving|loading|crediting|granting)\b|\b(?:usage\s+limits?|rate\s+limits?|limits?)\s+have\s+(?:now\s+)?been\s+reset\b|^(?:added|credited|granted|loaded)\b|\benjoy\s+(?:a\s+)?(?:(?:full|nice)\s+)?reset\b|\bnew\s+usage\s+reset\b|(?:已|已经|正在|再次).{0,25}(?:重置|发放|加载|存入|添加)/iu;

// Auxiliary grammar may recover a missing action/audience, never erase an
// explicit membership condition that the shared claim parser could not verify.
const explicitEligibility = /\b(?:if|unless|except|excluding|eligible|created|registered|upgraded|regions?|countr(?:y|ies))\b|\b(?:users?|accounts?|plans?|subscriptions?|everyone)\s+(?:in|from|with|without|who|that|having|older|younger)\b|符合资格|创建|注册|升级|地区|区域|国家|除了|排除|除.{0,25}以外/iu;
const unrestrictedClaim = (claim: ReturnType<typeof extractBenefitClaims>[number]) => claim.scope === 'public' &&
  !/（(?:资格原文|地区原文|限定范围)[:：]/u.test(claim.eligibility) &&
  // A readable historical product announcement is not proof of an unrestricted audience.
  !/用户（原帖未列明具体套餐）/u.test(claim.eligibility);

function strictTime(value:string):number {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN;
  const year=Number(value.slice(0,4)),month=Number(value.slice(5,7)),day=Number(value.slice(8,10));
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59)return NaN;
  return Date.parse(value);
}
function publishedTime(value:string):number {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)?strictTime(`${value}T00:00:00Z`):strictTime(value);
}

/** Archive timestamps alone cannot establish precision, even when encoded as ISO. */
function timePrecision(evidence:Evidence,source:Source):CadenceObservation['timePrecision'] {
  const at=strictTime(evidence.publishedAt);
  if(Number.isFinite(at)){
    if(evidence.provenance==='official'&&['original','structured'].includes(evidence.textOrigin??''))return 'exact';
    if(source.id==='tibo-public'&&source.kind==='timeline'&&source.url==='https://api.fxtwitter.com/2/profile/thsottiaux/statuses'&&evidence.textOrigin==='original'&&evidence.metadata?.sourceGroup==='fxembed:thsottiaux')return 'exact';
    const post=canonicalUrl(evidence.url)?.match(/^https:\/\/x\.com\/thsottiaux\/status\/(\d{15,20})$/)?.[1];
    if(post){
      try{
        const identity=BigInt(post),timestamp=Number((identity>>22n)+1288834974657n);
        if(identity>0n&&identity<=0xffffffffffffffffn&&Number.isSafeInteger(timestamp)&&Math.abs(timestamp-at)<=1000)return 'exact';
      }catch { /* An unverified archive time remains historical only. */ }
    }
  }
  return /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?Z)?$/.test(evidence.publishedAt)?'date':'unknown';
}

function canonicalUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return;
    const post = url.pathname.match(/^\/thsottiaux\/status\/(\d+)\/?$/i);
    if (['x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(url.hostname.toLowerCase()) && post) return `https://x.com/thsottiaux/status/${post[1]}`;
    if (url.hostname === 'status.openai.com' && /^\/incidents\/[a-z0-9]+\/?$/i.test(url.pathname)) return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  } catch { /* An invalid link cannot identify a source statement. */ }
}

function trustedEvidence(evidence: Evidence, source: Source): boolean {
  if (!source.enabled || !source.validated || source.kind === 'manual' || evidence.provenance === 'manual') return false;
  const url = canonicalUrl(evidence.url);
  if (!url) return false;
  if (url.startsWith('https://status.openai.com/')) {
    try { return evidence.provenance === 'official' && source.kind === 'status' && new URL(source.url).hostname === 'status.openai.com'; } catch { return false; }
  }
  const postId = url.split('/').at(-1);
  if (evidence.messageId !== postId && !evidence.messageId.startsWith('observed-')) return false;
  if (evidence.provenance === 'official') return true;
  if(evidence.provenance==='archive'&&source.id==='tibo-public'&&source.kind==='timeline'&&source.url==='https://api.fxtwitter.com/2/profile/thsottiaux/statuses')return evidence.textOrigin==='original'&&evidence.metadata?.sourceGroup==='fxembed:thsottiaux';
  return evidence.provenance === 'archive' && source.id === 'reset-archive' && source.kind === 'archive' && source.url === `${archiveOrigin}/zh-CN`;
}

/** The existing activity adapter supplies a calendar only, never a reset assertion. */
function trustedCampaignCalendar(evidence:Evidence,source:Source):boolean {
  const url=canonicalUrl(evidence.url);
  return source.enabled&&source.validated&&source.id==='activity-archive'&&source.kind==='activity'&&source.url===`${archiveOrigin}/tibo-28`&&evidence.provenance==='archive'&&evidence.textOrigin==='archive_excerpt'&&evidence.metadata?.sourceGroup==='codex-resets'&&!!evidence.metadata.activity&&!!url?.startsWith('https://x.com/thsottiaux/status/')&&(evidence.messageId===url.split('/').at(-1)||evidence.messageId.startsWith('observed-'));
}

interface CadenceStatement {kind:CadenceObservation['kind'];evidenceIds:string[];proofEvidenceIds?:string[];}
const versionMeaning=(item:Evidence)=>`${normalize(item.text)}|${item.parentId??''}|${item.textOrigin??''}|${item.publishedAt}|${JSON.stringify(item.metadata?.activity??null)}`;

function statementKind(evidence: Evidence): CadenceObservation['kind'] | undefined {
  // The legacy completeness flag often reflects unsupported claim grammar.
  // Complete explicit text is inspected directly for auxiliary training only.
  if (isTruncatedBenefitText(evidence.text) || /(?:意思是|感谢大家的|我们已经|这些|具体如下|如下)[\s:：]*$/u.test(evidence.text.trim())) return;
  if (evidence.textOrigin === 'archive_excerpt' && !evidence.contextComplete && !/(?:[。！？.!?][”"')）\]]*|了)$/u.test(evidence.text.trim())) return;
  if (evidence.textOrigin !== 'original' && evidence.textOrigin !== 'structured' && evidence.textOrigin !== 'archive_excerpt') return;
  const kinds = new Set<CadenceObservation['kind']>();
  const clauses = benefitClauses(evidence.text).map(normalize);
  if (/\b(?:correction|retracted|withdrawn|cancelled|canceled)\b|更正|撤回|取消/iu.test(evidence.text) && clauses.some(clause => negatedAction.test(clause))) return;
  for (const [index, original] of clauses.entries()) {
    if (/[?？]/.test(original) || /^(?:if|unless|suppose|hypothetically)\b|\b(?:rumou?rs?|unconfirmed)\b|如果|假如|假设|传闻|据说/iu.test(original)) continue;
    // A milestone or an incident report before the assertion is not the reset's
    // eligibility. Keep all modifiers after the actual reset predicate.
    const predicate = original.match(/\b(?:we|i)\s+(?:have|are)\s+(?:(?:now|already|just)\s+)*(?:reset|resetting|added|giving|loading|loaded|credited|granted)\b/iu);
    const clause = predicate?.index ? original.slice(predicate.index) : original;
    if (/[?？]/.test(clause) || limitedAudience.test(clause) || privateAction.test(clause) || negatedAction.test(clause)) continue;
    if (futureAction.test(clause) && !presentOrPast.test(clause)) continue;
    const parsed = extractBenefitClaims(clause, evidence.publishedAt);
    const claims = parsed.filter(claim => unrestrictedClaim(claim) && (claim.stage === 'claimed_complete' || claim.stage === 'in_progress'));
    for (const claim of claims) kinds.add(claim.kind);
    if(!claims.length&&parsed.some(claim=>claim.scope==='public'&&/用户（原帖未列明具体套餐）/u.test(claim.eligibility)))kinds.add('unspecified');
    // A rejected or restricted finite claim must not enter via the wider
    // auxiliary fallback below. Valid relative timing stays in the parser path.
    if (parsed.length || explicitEligibility.test(clause)) continue;
    // Explicit propagation is a public statement even without an action kind.
    // It never turns a bare "Confirmed landed" or "It is done" into a reset.
    if (/\bresets?\s+(?:ha(?:s|ve)\s+)?(?:been\s+)?(?:all\s+)?propagated\s*(?:\.|\bto\s+(?:all\s+)?accounts?\b)|\bresets?\s+(?:have\s+)?(?:been\s+)?all\s+propagated\b|\ball\s+reset\s+for\s+everyone\b|(?:重置).{0,8}全部(?:已)?(?:传播|到账|完成)/iu.test(clause)) {
      kinds.add('unspecified'); continue;
    }
    const hasPublicScope = publicAudience.test(clause) || (!limitedAudience.test(original) && !privateAction.test(original) && publicAudience.test(original));
    const productContext = /\bCodex\b|ChatGPT\s*Work/iu.test(evidence.text);
    if (productContext && /(?:用户).{0,12}(?:再次)?获得(?:了)?一次重置/iu.test(clause) && !/将|计划|预计|可能/iu.test(clause)) { kinds.add('unspecified'); continue; }
    if (!presentOrPast.test(clause)) continue;
    // A public product reset assertion without an explicit all-user audience is
    // part of this message series, with eligibility and reset kind unspecified.
    if (!hasPublicScope) {
      if (productContext && (usageReset.test(clause) || bankedReset.test(clause))) kinds.add('unspecified');
      continue;
    }
    if (usageReset.test(clause) && !bankedReset.test(clause)) kinds.add('automatic_reset');
    if (bankedReset.test(clause) && !usageReset.test(clause)) kinds.add('banked_reset');
    if (bankedReset.test(clause) && usageReset.test(clause)) kinds.add('unspecified');
    if (!usageReset.test(clause) && !bankedReset.test(clause) && /\benjoy\s+a\s+(?:nice|full)\s+reset\b/iu.test(clause)) {
      // A greeting does not establish that delivery has begun when its next
      // sentence says the same reset will land later. Keep explicit ongoing
      // or completed assertions above independent of this narrow fallback.
      const next = clauses[index + 1] ?? '';
      const futureLanding = benefitStage(clause) === 'promised' ||
        /^(?:it\s+)?(?:lands?|landing|will\s+(?:land|be\s+there))\b/iu.test(next) &&
        (benefitStage(next) === 'promised' || /\b(?:in|by|tomorrow|today|soon|next)\b/iu.test(next));
      if (!futureLanding) kinds.add('unspecified');
    }
  }
  return kinds.size === 1 ? [...kinds][0] : kinds.size > 1 ? 'unspecified' : undefined;
}

function contextStatement(primary: Evidence, latest: Map<string, Evidence[]>,calendars:Map<string,Evidence[]>,latestEvidence:Evidence[]): CadenceStatement | undefined {
  if (!primary.parentId) return;
  if (privateAction.test(normalize(primary.text)) || limitedAudience.test(primary.text) || explicitEligibility.test(primary.text) || negatedAction.test(primary.text) || /^(?:if|unless|suppose|hypothetically)\b|如果|假如|假设/iu.test(primary.text.trim())) return;
  const chain = [primary];
  const seen = new Set([canonicalUrl(primary.url)!]);
  let current = primary;
  for (let depth = 0; current.parentId && depth < 20; depth++) {
    const matches = [...latest.values()].filter(versions => versions.some(parent => isExplicitParent(current, parent)));
    if (matches.length !== 1) return;
    const versions = matches[0];
    // Latest equally-timed copies must agree on the actual original and parent.
    // Otherwise the shared resolver's tie-break would silently pick a claim.
    const signatures = new Set(versions.map(versionMeaning));
    if (signatures.size !== 1 || versions.some(parent => !isExplicitParent(current, parent))) return;
    const parent = versions[0], url = canonicalUrl(parent.url)!;
    if (seen.has(url) || Date.parse(parent.publishedAt) > Date.parse(current.publishedAt)) return;
    if (parent.textOrigin !== 'original' && parent.textOrigin !== 'structured') return;
    seen.add(url); chain.push(...versions); current = parent;
  }
  if (current.parentId) return;
  // Campaign shorthand needs its original rule, original Day 1 and verified
  // calendar as well as the explicit reply chain. Only cutoff-filtered latest
  // evidence can supply that shared context; conflicting proof copies fail closed.
  const context=gatherEvidenceContext(primary,latestEvidence);
  for(const item of context){
    const url=canonicalUrl(item.url)!,statements=latest.get(url),calendarVersions=calendars.get(url),isCalendar=calendarVersions?.some(version=>version.id===item.id);
    const versions=isCalendar?calendarVersions:statements;
    if(!versions||new Set(versions.map(versionMeaning)).size!==1||item.metadata?.activity&&!isCalendar)return;
  }
  // A trailing conversational question must not erase the preceding explicit
  // completion clause. The shared resolver still supplies and checks its referent.
  const claims = benefitClauses(primary.text).flatMap(text => evidenceBenefitClaims({ ...primary, text }, context)).filter(claim => unrestrictedClaim(claim) && (claim.stage === 'claimed_complete' || claim.stage === 'in_progress'));
  if (!claims.length || new Set(claims.map(claim => claim.kind)).size !== 1) return;
  // Keep the entire verified chain for resolution above. Only the reply path
  // through its nearest unique benefit statement supports this particular
  // fact; an older product ancestor must not become a permanent round identity.
  const supportingParent = chain.findIndex(item => directEvidenceBenefitClaims(item,context).length > 0);
  if (supportingParent < 0) return;
  const support = directEvidenceBenefitClaims(chain[supportingParent],context);
  if (support.length !== 1 || !unrestrictedClaim(support[0]) || support[0].kind !== claims[0].kind) return;
  const lastSupportingUrl = canonicalUrl(chain[supportingParent].url);
  const supporting = chain.slice(0, supportingParent + 1);
  // Equally-timed identical source copies of that statement share its identity.
  for (let i = supportingParent + 1; i < chain.length && canonicalUrl(chain[i].url) === lastSupportingUrl; i++) supporting.push(chain[i]);
  const evidenceIds=[...new Set(supporting.map(item=>item.id))],chainIds=new Set(chain.map(item=>item.id));
  // Shared campaign proof determines first-known time, but is not a round
  // identity: otherwise every reset using the same calendar would merge.
  const proofEvidenceIds=[...new Set([...evidenceIds,...context.filter(item=>!chainIds.has(item.id)).map(item=>item.id)])];
  return { kind: claims[0].kind,evidenceIds,proofEvidenceIds };
}

/** Originals and structured source records outrank archive descriptions of the
 * same post. Within that evidence tier, the latest known version still wins:
 * corrections cannot retain an old positive. */
export function extractCadenceObservations(evidence: Evidence[], sources: Source[], cutoffAt: string): CadenceObservation[] {
  const cutoff = strictTime(cutoffAt);
  if (!Number.isFinite(cutoff)) return [];
  const bySource = new Map(sources.map(source => [source.id, source]));
  const latest = new Map<string, Evidence[]>();
  const calendars=new Map<string,Evidence[]>();
  const accepted:Evidence[]=[];
  for (const item of evidence) {
    const source = bySource.get(item.sourceId);
    const published = publishedTime(item.publishedAt), collected = strictTime(item.collectedAt);
    if (!source || !Number.isFinite(published) || !Number.isFinite(collected) || published > cutoff || collected > cutoff || collected<published || !trustedEvidence(item, source)&&!trustedCampaignCalendar(item,source)) continue;
    accepted.push(item);
    const url = canonicalUrl(item.url)!;
    // A later calendar excerpt for this URL cannot replace its original body.
    const versionsByPurpose=trustedEvidence(item,source)?latest:calendars,versions=versionsByPurpose.get(url);
    // A freshly polled translation may omit a reply's parent, its original
    // wording, or seconds. It is not a newer version of the original post.
    // Calendar definitions retain their independent latest-version rule.
    const originRank=(record:Evidence)=>versionsByPurpose===latest&&['original','structured'].includes(record.textOrigin??'')?1:0;
    const rankDifference=versions?originRank(item)-originRank(versions[0]):0;
    if (!versions || rankDifference>0 || rankDifference===0&&collected > Date.parse(versions[0].collectedAt)) versionsByPurpose.set(url, [item]);
    else if (rankDifference===0&&collected === Date.parse(versions[0].collectedAt)) versions.push(item);
  }
  const sameVersion=(item:Evidence)=>`${canonicalUrl(item.url)}|${versionMeaning(item)}`;
  const firstKnown=new Map<string,number>();
  for(const item of accepted){const signature=sameVersion(item),known=strictTime(item.collectedAt);firstKnown.set(signature,Math.min(firstKnown.get(signature)??Infinity,known));}
  const byId=new Map(accepted.slice().sort((a,b)=>strictTime(a.collectedAt)-strictTime(b.collectedAt)).map(item=>[item.id,item]));
  const latestEvidence=[...latest.values(),...calendars.values()].flat();
  const result: CadenceObservation[] = [];
  for (const [url, versions] of latest) {
    if(versions.some(version=>!trustedEvidence(version,bySource.get(version.sourceId)!)))continue;
    const statements = versions.map((version):CadenceStatement|undefined => {
      const directKind = statementKind(version);
      if(directKind==='unspecified')return contextStatement(version,latest,calendars,latestEvidence)??{kind:directKind,evidenceIds:[version.id]};
      return directKind ? { kind: directKind, evidenceIds: [version.id] } : contextStatement(version, latest,calendars,latestEvidence);
    });
    const kinds = statements.map(statement => statement?.kind);
    // Conflicting same-time source copies are not repaired by guessing.
    if (kinds.some(kind => kind === undefined) || new Set(kinds).size !== 1) continue;
    const item = versions[0];
    if(versions.some(version=>publishedTime(version.publishedAt)!==publishedTime(item.publishedAt)||timePrecision(version,bySource.get(version.sourceId)!)!==timePrecision(item,bySource.get(item.sourceId)!)))continue;
    const evidenceIds=[...new Set(statements.flatMap(statement => statement!.evidenceIds))].sort();
    const proofEvidenceIds=[...new Set(statements.flatMap(statement=>statement!.proofEvidenceIds??statement!.evidenceIds))];
    const precision=timePrecision(item,bySource.get(item.sourceId)!);
    const knownAt=Math.max(...proofEvidenceIds.map(id=>{const support=byId.get(id)!;return firstKnown.get(sameVersion(support))!;}));
    result.push({ id: `cadence:${url}`, evidenceIds, at: precision==='date'?item.publishedAt.slice(0,10):new Date(item.publishedAt).toISOString(), url, kind: kinds[0]!,timePrecision:precision,firstKnownAt:new Date(knownAt).toISOString() });
  }
  return result.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}
