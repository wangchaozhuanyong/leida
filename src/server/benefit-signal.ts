import {ownBenefitClause} from './benefit-language';
import type { Evidence } from '../lib/types';
import { benefitClauses, benefitKinds, benefitStage, benefitTime, extractBenefitClaims, isTruncatedBenefitText, type BenefitClaim } from './benefit-rules';

export const UNKNOWN_BENEFIT_AUDIENCE = '适用范围未说明';
const clean = (s:string) => s.replace(/https?:\/\/\S+/g, '').replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim();
// This is an additional interpretation of an original, never an archive label
// or a model's confidence. Missing audience does not mean all accounts.
export function originalBenefitSignal(item:Evidence):BenefitClaim[] {
  if (!eligibleOriginal(item)||item.parentId) return [];
  return benefitClauses(item.text).flatMap(quote => {
    if(!ownBenefitClause(item.text,quote))return [];
    const kinds=benefitKinds(quote),stage=benefitStage(quote);
    if(kinds.length!==1||!stage||extractBenefitClaims(quote,item.publishedAt).length||
      /\b(?:no|not|never|if|unless|only|except|excluding|selected|specific|affected|users?|accounts?|plans?|groups?|cohorts?|teams?|members?|subscribers?|paid|free|plus|pro|business|regions?|countr\w*|eligible|someone|report\w*|rumou?r\w*|said|says|my|your|our)\b|部分|个人|付费|免费|套餐|账户|用户|据说|传闻|否认|取消了传闻/i.test(quote))return [];
    // An unparsed recipient/condition is not a missing recipient. Preserve
    // it for review instead of silently dropping e.g. 'for UK' or 'without X'.
    const audienceText=quote.replace(/\b(?:going|plan|scheduled)\s+to\b/gi,'').replace(/\bto\s+(?:celebrate|thank|help|enable)\b[^.!?]*[.!]?$/i,'');
    if(/\b(?:for|to|from)\b|\b(?:resets?|cards?)\s+(?:with|without|who|that)\b/i.test(audienceText))return [];
    // Require an actual benefit predicate, not "banked" in a product launch.
    if(!/\b(?:will|going\s+to|plan\s+to|scheduled|have|has|added|credited|granted|loaded|reset\w*|landing|landed|rolling\s+out)\b|将|计划|预计|已发放|正在发放/i.test(quote))return [];
    const time=stage==='promised'||stage==='in_progress'?benefitTime(quote,item.publishedAt):{};
    const relative=quote.match(/\b(?:next|coming)\s+(two|three|\d{1,2})\s+days?\b/i)?.[0];
    return [{kind:kinds[0],stage,scope:'public' as const,eligibility:UNKNOWN_BENEFIT_AUDIENCE,quote,...time,
      ...(relative&&!time.expectedAt?{timeNote:`原文安排：${relative}；未公布具体发放时刻。`}:{})}];
  });
}

export function eligibleOriginal(item:Evidence):boolean {
  return item.textOrigin==='original'&&item.provenance!=='manual'&&!isTruncatedBenefitText(item.text)&&
    (item.contextComplete||item.sourceId==='tibo-public'&&item.metadata?.sourceGroup==='fxembed:thsottiaux')&&
    /^https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/[^/?#]+$/.test(item.url)&&item.url.endsWith('/'+item.messageId);
}

/** A counter is progress only inside an unambiguous, independently supported
 * series. It cannot supply its own audience, forecast or invented parentId. */
export function bankedProgress(text:string):{index:number;total:number}|undefined {
  // An activity day is a label. Keep the entire statement anchored so removing
  // a label never drops negation, audience restrictions or additional claims.
  const match=clean(text).match(/^(?:Day\s+[1-9]\d{0,2}\s*\/\s*)?(?:banked(?:\s+resets?)?|重置卡)\s*(\d{1,2})\s*\/\s*(\d{1,2})[.!。！]?$/i);
  if(!match)return;
  const index=Number(match[1]),total=Number(match[2]);
  return total>=2&&total<=10&&index>=1&&index<=total?{index,total}:undefined;
}
function seriesTotal(text:string):number|undefined {
  const value=clean(text).match(/\b(two|three|[2-9]|10)\s+banked\s+resets?\b/i)?.[1];
  return value?({two:2,three:3}[value.toLowerCase()]??Number(value)):undefined;
}
const author=(e:Evidence)=>e.url.match(/^https:\/\/(?:x|twitter)\.com\/([^/]+)\/status\//i)?.[1].toLowerCase();
const claims=(e:Evidence)=>extractBenefitClaims(e.text,e.publishedAt).length?extractBenefitClaims(e.text,e.publishedAt):originalBenefitSignal(e);
export function bankedSeriesContext(primary:Evidence,all:Evidence[]):Evidence[] {
  const progress=bankedProgress(primary.text);
  if(!progress||!eligibleOriginal(primary))return [];
  const at=Date.parse(primary.publishedAt);
  const prior=all.filter(e=>e.id!==primary.id&&eligibleOriginal(e)&&author(e)===author(primary)&&
    Date.parse(e.publishedAt)<at&&at-Date.parse(e.publishedAt)<=72*3600_000);
  // Every competing banked arrangement counts, including one with a different
  // total. Deduplicate original identities but never choose by latest time.
  const arrangements=prior.filter(e=>(!primary.parentId||primary.parentId===e.messageId)&&claims(e).some(c=>c.kind==='banked_reset'&&c.stage==='promised'));
  const unique=new Map(arrangements.map(e=>[e.messageId,e]));
  if(unique.size!==1)return [];
  const anchor=[...unique.values()][0],parentClaims=claims(anchor);
  const declaredTotal=seriesTotal(anchor.text);
  if(declaredTotal!==undefined&&declaredTotal!==progress.total||parentClaims.length!==1||parentClaims[0].scope!=='public'||
    primary.parentId&&primary.parentId!==anchor.messageId)return [];
  const after=prior.filter(e=>Date.parse(e.publishedAt)>=Date.parse(anchor.publishedAt));
  if(after.some(e=>e.id!==anchor.id&&(benefitKinds(e.text).includes('banked_reset')&&
    (['cancelled','claimed_complete'].includes(benefitStage(e.text)??'')||bankedProgress(e.text)?.total!==undefined&&
      (bankedProgress(e.text)!.total!==progress.total||bankedProgress(e.text)!.index>=progress.index)))))return [];
  const relevantIds=new Set([primary.messageId,anchor.messageId,...after.filter(e=>bankedProgress(e.text)).map(e=>e.messageId)]);
  const versions=new Map<string,Set<string>>();
  for(const e of all.filter(e=>eligibleOriginal(e)&&author(e)===author(primary)&&relevantIds.has(e.messageId)&&Date.parse(e.publishedAt)<=at)){
    const values=versions.get(e.messageId)??new Set<string>();values.add(JSON.stringify([clean(e.text),e.parentId??'',e.publishedAt]));versions.set(e.messageId,values);
  }
  if([...versions.values()].some(values=>values.size>1))return [];
  const supporting=after.filter(e=>bankedProgress(e.text)?.total===progress.total&&bankedProgress(e.text)!.index<progress.index);
  return [anchor,...supporting];
}
export function bankedSeriesClaim(primary:Evidence,context:Evidence[]):BenefitClaim|undefined {
  const progress=bankedProgress(primary.text),proof=bankedSeriesContext(primary,context);
  if(!progress||!proof.length)return;
  const parent=claims(proof[0])[0];
  return {...parent,quote:primary.text,stage:progress.index===progress.total?'claimed_complete':'in_progress',expectedAt:undefined,
    timeNote:`发布者报告重置卡发放进度 ${progress.index}/${progress.total}${progress.index<progress.total?'，后续批次待更新':'，本系列进度已完成'}；个人到账以账户显示为准。`};
}
