import type {Evidence} from '../lib/types';
import {benefitClauses} from './benefit-rules';
import {ownBenefitClause} from './benefit-language';
import {evidenceBenefitClaims} from './source-context';

/** Internal coverage ledger. Unresolved clauses stay in the candidate workflow;
 * they are not public facts, extra distributions, or training observations. */
export function analyzeBenefitEvidence(primary:Evidence,context:Evidence[]) {
  const claims=evidenceBenefitClaims(primary,context);
  const unresolved=benefitClauses(primary.text).filter(clause=>{
    if(!ownBenefitClause(primary.text,clause)||claims.some(c=>c.quote.includes(clause)||clause.includes(c.quote)))return false;
    if(!/\b(?:reset\w*|banked|refill\w*|refresh\w*|replenish\w*|restor\w*|quota|allowance)\b|重置|发卡|额度恢复/i.test(clause))return false;
    // Product/usage instructions and isolated changes to capacity are not
    // announcements of a new reset. They must not create perpetual retries.
    if(/\b(?:apply|redeem|purchase|bought|expire|valid for|inventory|stock|option)\b|自行使用|有效期|库存/i.test(clause))return false;
    if(/\b(?:doubled?|increas\w*|extra|top(?:ped)? up)\b|提高上限|追加|补贴/i.test(clause)&&!/\breset\w*\b|重置/i.test(clause))return false;
    return true;
  });
  return {claims,unresolved};
}
