import test from 'node:test';
import assert from 'node:assert/strict';
import {extractBenefitClaims} from '../src/server/benefit-rules';
import {publicHistoryEvidence,refreshHistoryOriginalContext} from '../src/lib/reset-history-candidates';
import {evidenceBenefitClaims,gatherEvidenceContext,hasStandaloneContext,originalConflict} from '../src/server/source-context';

// Exact clauses retained in the project's public original cache for these posts.
const at='2026-03-08T02:42:13.120Z';
const investigation='We don’t have evidence of a widespread issue with codex usage being drained faster than it should but there are enough reports and we have reset rate limits for plus & pro subscriptions while we work towards wrapping up our investigation over the coming 1-3 days.';
const completedGreeting='Enjoy reset usage limits for all paid users for Codex and ChatGPT Work.';

test('2030474136024400173 调查未来时间不改变同句已经重置的阶段与资格',()=>{
 const [claim]=extractBenefitClaims(investigation,at);
 assert.equal(claim.kind,'automatic_reset');assert.equal(claim.stage,'claimed_complete');assert.equal(claim.scope,'public');assert.equal(claim.eligibility,'Plus、Pro套餐账户');
 assert.equal(claim.expectedAt,undefined);assert.ok(investigation.includes(claim.quote));assert.ok(!/investigation|1-3/.test(claim.quote));
});

test('调查同句的未来、否认、假设不能被裁成已完成片段',()=>{
 for(const text of [
  'We will reset rate limits for all paid users while we work towards wrapping up our investigation over the coming 1-3 days.',
  'If we have reset rate limits for all paid users while we work towards wrapping up our investigation, it might help.',
  'We have not reset rate limits for all paid users while we work towards wrapping up our investigation.',
 ])assert.ok(!extractBenefitClaims(text,at).some(claim=>claim.stage==='claimed_complete'),text);
 assert.equal(extractBenefitClaims('We will reset rate limits for all paid users while we investigate over the coming days.',at)[0]?.stage,'promised');
});

test('2078320950488297917 完成祝语仅支持明确全部付费用户及产品的窄句式',()=>{
 const actual=completedGreeting;
 const [claim]=extractBenefitClaims(actual,at);
 assert.equal(claim.stage,'claimed_complete');assert.equal(claim.kind,'automatic_reset');assert.equal(claim.scope,'public');
 for(const text of ['Enjoy a nice reset everyone. Landing tomorrow.','Enjoy a full reset of your usage limits for Codex.','Enjoy reset usage limits for selected paid users of Codex and ChatGPT Work.','Enjoy reset usage limits for all paid users of Codex and ChatGPT Work. Landing in the next hour.'])assert.ok(!extractBenefitClaims(text,at).some(item=>item.stage==='claimed_complete'),text);
 assert.equal(extractBenefitClaims(actual+' Landing tomorrow.',at)[0]?.stage,'promised');
});

test('209380/209425 英文原帖与旧中文译文并存不伪造原文冲突，也不删除译文',()=>{
 const examples=[
  {id:'2093801758665715784',at:'2026-08-23T00:00:00Z',text:'We are reseting usage for all paid users of Codex and ChatGPT Work.',translation:'我们正在重置所有 Codex 和 ChatGPT Work 付费用户的用量。',stage:'in_progress'},
  {id:'2094251180121854309',at:'2026-08-24T00:00:00Z',text:'What I wanted to say yesterday is that we hit 25M active users and to celebrate we have now reset usage for all paid subscriptions for ChatGPT Work and Codex.',translation:'为了庆祝，我们现在已为ChatGPT Work和Codex的所有付费订阅重置了使用额度。',stage:'claimed_complete'},
 ];
 for(const example of examples){
  const publishedAt=new Date(Number((BigInt(example.id)>>22n)+1288834974657n)).toISOString();
  const shared={messageId:example.id,url:`https://x.com/thsottiaux/status/${example.id}`,publishedAt,collectedAt:'2026-10-14T00:00:00Z',contextComplete:false,provenance:'archive',textOrigin:'original'};
  const originals=refreshHistoryOriginalContext(publicHistoryEvidence({records:[{...shared,id:'english',sourceId:'tibo-public',text:example.text,metadata:{sourceGroup:'fxembed:thsottiaux'}},{...shared,id:'chinese',sourceId:'reset-archive',text:example.translation,metadata:{sourceGroup:'codex-resets'}}]},'2026-10-16T12:00:00Z'),text=>hasStandaloneContext(text,'reset'));
  assert.equal(originals.length,2);assert.equal(originals[1].textOrigin,'archive_excerpt');assert.equal(originals[1].text,example.translation);assert.equal(originalConflict(originals[0],originals),false);
  assert.equal(originals[0].contextComplete,true);assert.equal(originals[1].contextComplete,false);
  assert.equal(evidenceBenefitClaims(originals[0],gatherEvidenceContext(originals[0],originals))[0]?.stage,example.stage);
 }
});

test('原文完整性重算不升格摘要、结构化正文、预告祝语或缺父帖的完成短句',()=>{
 const publishedAt='2026-10-02T21:18:48.417Z',base={id:'fixture',sourceId:'tibo-public',messageId:'2106131810921136451',url:'https://x.com/thsottiaux/status/2106131810921136451',publishedAt,collectedAt:'2026-10-14T00:00:00Z',provenance:'archive',contextComplete:false};
 const rows=publicHistoryEvidence({records:[{...base,text:completedGreeting,textOrigin:'original'},{...base,id:'excerpt',text:completedGreeting,textOrigin:'archive_excerpt'},{...base,id:'structured',text:completedGreeting,textOrigin:'structured'},{...base,id:'bare',text:'It is done.',textOrigin:'original'},{...base,id:'future-greeting',text:'Enjoy a nice reset everyone. Landing tomorrow.',textOrigin:'original'}]},'2026-10-16T12:00:00Z');
 const refreshed=refreshHistoryOriginalContext(rows,text=>hasStandaloneContext(text,'reset'));
 assert.equal(refreshed[0].contextComplete,true);assert.ok(refreshed.slice(1).every(record=>!record.contextComplete));
 assert.deepEqual(rows.map(record=>record.contextComplete),Array(5).fill(false));
});
