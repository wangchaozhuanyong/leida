import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAutomaticTemplate,canUseNewsOnlyAttribution,classifyBlockers,evidenceFingerprint,hasExplicitCorrectionText,isClearlyUnrelated} from '../src/server/automatic-content';
import {hasCancellation,validateDraft,noticeKey} from '../src/server/domain';
import {automaticCorrection} from '../src/server/service';
import {posterSvg} from '../src/server/poster';
import type {Evidence,DraftContent,BenefitAction,RadarEvent,Publication} from '../src/lib/types';
const at='2026-10-09T12:00:00Z';
const ev=(text:string,extra:Partial<Evidence>={}):Evidence=>({id:'e',sourceId:'reset-archive',messageId:'p',url:'https://x.com/thsottiaux/status/2108040921044639779',text,hash:'test',publishedAt:at,collectedAt:at,contextComplete:true,historical:false,provenance:'archive',...extra});
const action=(extra:Partial<BenefitAction>={}):BenefitAction=>({id:'card',kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'付费账户',statementAt:at,evidenceIds:['e'],evidenceQuote:'We have loaded banked resets for all paid accounts.',...extra});
const draft=(a:BenefitAction):DraftContent=>({title:'重置卡进展',summary:'根据公开原文记录福利进展。',translation:'',category:'reset',actions:[a],evidenceIds:a.evidenceIds,publicationMode:'state_change'});
const event=(actions:BenefitAction[]):RadarEvent=>({id:'event',title:'事件',version:1,status:'published',actions,evidenceIds:['old'],publicationId:'pub-old',updatedAt:at});

test('否定取消不能从模板或模型成为取消声明',()=>{
 const e=ev('所有用户的重置卡发放不会取消，计划按公告发放。');
 assert.equal(hasCancellation(e.text),false);assert.notEqual(buildAutomaticTemplate([e])?.actions[0]?.stage,'cancelled');
 const d=draft(action({stage:'cancelled',eligibility:'所有账户',evidenceQuote:e.text}));assert.ok(validateDraft(d,[e],true).some(reason=>reason.includes('肯定')));
 assert.equal(hasExplicitCorrectionText('only your account'),false);assert.equal(hasExplicitCorrectionText('仅限你的账户'),false);
});
test('中文双动作分别绑定资格与阶段，含歧义时间的预告不借用完成',()=>{
 const mixed=ev('已为所有账户重置用量，重置卡将于明天为所有付费账户发放。');
 const d=buildAutomaticTemplate([mixed])!;assert.equal(d.publicationMode,'state_change');assert.equal(d.actions.length,2);
 assert.equal(d.actions.find(a=>a.kind==='automatic_reset')?.stage,'claimed_complete');
 assert.equal(d.actions.find(a=>a.kind==='banked_reset')?.stage,'promised');
 assert.equal(d.actions.find(a=>a.kind==='banked_reset')?.expectedAt,undefined);assert.deepEqual(validateDraft(d,[mixed],true),[]);
 const clear=ev('已为所有付费账户发放重置卡。');const ready=buildAutomaticTemplate([clear])!;
 assert.equal(ready.actions[0].kind,'banked_reset');assert.equal(ready.actions[0].stage,'claimed_complete');assert.deepEqual(validateDraft(ready,[clear],true),[]);
});
test('辅助归档标题不可构成动作，截断正文只发布待确认消息',()=>{
 const e=ev('已确认在所有账户落地。',{contextComplete:false,metadata:{title:'给所有人一张重置卡',benefitKind:'banked_reset'}});
 const d=buildAutomaticTemplate([e])!;assert.equal(d.publicationMode,'news_only');assert.equal(d.actions.length,0);assert.equal(canUseNewsOnlyAttribution(d,[e]),true);assert.deepEqual(validateDraft(d,[e],true),[]);
 for(const text of ['因此……重置已经','因此……重置已经… https://t.co/test']){
  const e=ev(text,{contextComplete:false}),pending=buildAutomaticTemplate([e])!;
  assert.equal(pending.reviewStatus,'pending');assert.equal(pending.publicationMode,'news_only');assert.deepEqual(pending.actions,[]);assert.deepEqual(validateDraft(pending,[e],true),[]);
 }
});
test('原帖补成英文后可沿用归档中文消息，不能借翻译确认发卡',()=>{
 const e=ev('Confirmed landed across all accounts.',{contextComplete:false,textOrigin:'original',metadata:{summary:'已确认在所有账户落地。'}});
 const d=buildAutomaticTemplate([e])!;assert.equal(d.publicationMode,'news_only');assert.equal(d.actions.length,0);assert.match(d.summary,/公开归档/);assert.deepEqual(validateDraft(d,[e],true),[]);
});
test('套餐集合和免费资格准确核对，不能改写为其他人群',()=>{
 const plus=ev('Correction: we have loaded banked resets for Plus accounts only.');
 assert.ok(validateDraft(draft(action({eligibility:'Pro套餐账户',evidenceQuote:plus.text})),[plus],true).some(reason=>reason.includes('套餐')));
 assert.deepEqual(validateDraft(draft(action({eligibility:'Plus套餐账户',evidenceQuote:plus.text})),[plus],true),[]);
 const free=ev('We have loaded banked resets for all free accounts.');assert.ok(validateDraft(draft(action({eligibility:'所有账户',evidenceQuote:free.text})),[free],true).some(reason=>reason.includes('免费')));
});
test('用量已完成证据不能套用成重置卡已完成',()=>{
 const e=ev('We have reset usage limits for all accounts. Banked resets will be loaded tomorrow.');
 assert.ok(validateDraft(draft(action({eligibility:'所有账户',evidenceQuote:'We have reset usage limits for all accounts.'})),[e],true).some(reason=>reason.includes('不能证明重置卡')));
});
test('部分套餐或受影响账户不能变成普发',()=>{
 const chinese=ev('已发放重置卡给部分 Pro 账户。');assert.equal(buildAutomaticTemplate([chinese])?.publicationMode,'news_only');
 const english=ev('We have loaded banked resets for selected Pro accounts affected by the outage.');
 assert.ok(validateDraft(draft(action({eligibility:'Pro套餐账户',evidenceQuote:english.text})),[english],true).some(reason=>reason.includes('定向补偿')));
});
test('自动更正按每个动作验证，不能由另一动作取消授权回退',()=>{
 const old=event([action({statementAt:'2026-10-08T12:00:00Z'}),action({id:'usage',kind:'automatic_reset',statementAt:'2026-10-08T12:00:00Z'})]);
 const e=ev('We have cancelled banked resets for all paid accounts. We will reset usage for all paid accounts.');
 const content={...draft(action({stage:'cancelled',evidenceQuote:'We have cancelled banked resets for all paid accounts.'})),actions:[action({stage:'cancelled',evidenceQuote:'We have cancelled banked resets for all paid accounts.'}),action({id:'usage',kind:'automatic_reset',stage:'promised',evidenceQuote:'We will reset usage for all paid accounts.'})]};
 assert.throws(()=>automaticCorrection(content,old,[e]),/明确更正证据/);
 assert.equal(automaticCorrection(draft(content.actions[0]),old,[e]),true);
});
test('公开资格变为定向补偿仍产生更正语义',()=>{
 const before=event([action()]),after={...before,actions:[action({scope:'targeted'})]};assert.ok(noticeKey(after,before));
 assert.equal(noticeKey({...before,actions:[action({eligibility:'全部付费用户'})]},before),undefined);
});
test('指纹只跟随证据输入变化，不因采集时间变化收费',()=>{
 const e=ev('测试');assert.equal(evidenceFingerprint([e]),evidenceFingerprint([{...e,collectedAt:'2026-10-09T13:00:00Z'}]));
 assert.notEqual(evidenceFingerprint([e]),evidenceFingerprint([{...e,metadata:{summary:'补齐'}}]));
 assert.equal(classifyBlockers([],[e]).state,'ready');assert.equal(classifyBlockers(['原文上下文不完整'],[e]).state,'waiting_evidence');assert.equal(classifyBlockers(['人工保护字段冲突'],[e]).state,'conflict');
 assert.equal(isClearlyUnrelated(ev('@theo 嘘嘘嘘')),true);assert.equal(isClearlyUnrelated(ev('完成了')),false);
});
test('仅新闻海报不附已有事件的福利动作',()=>{
 const a={id:'article',eventId:'event',title:'公开消息记录',summary:'仅新闻更新',translation:'',category:'product' as const,version:1,status:'published' as const,publicationId:'pub',evidenceIds:['e'],publishedAt:at,updatedAt:at,publicationMode:'news_only' as const};
 const p:Publication={id:'pub',eventId:'event',articleId:a.id,article:a,event:event([action()]),publishedAt:at,cutoffAt:at,reason:'test',mode:'news_only'};
 const svg=posterSvg({...p,article:{...a,version:7}},'模钥重置雷达');assert.ok(!svg.includes('适用范围：'));assert.match(svg,/仅新闻更新/);assert.doesNotMatch(svg,/第7版/);
});
