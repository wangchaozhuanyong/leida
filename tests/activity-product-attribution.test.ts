import test from 'node:test';
import assert from 'node:assert/strict';
import type {Evidence} from '../src/lib/types';
import {buildAutomaticTemplate,canUseNewsOnlyAttribution,evidenceFingerprint} from '../src/server/automatic-content';
import {hasCompleteContext,hasStandaloneContext} from '../src/server/source-context';
import {validateDraft} from '../src/server/domain';
import {fingerprintChange} from '../src/server/worker';

const text='GPT-6.1 Sol 在 Codex 和 Work 中的默认上下文长度已从 272k 提升至 500k，有助于减少上下文压缩，并在长时间任务中保留更多上下文。';
function excerpt(extra:Partial<Evidence>={}):Evidence {
  return {id:'day7',hash:'day7-hash',sourceId:'activity-archive',messageId:'2109430343346581527',url:'https://x.com/thsottiaux/status/2109430343346581527',text,publishedAt:'2026-10-11T23:45:59Z',collectedAt:'2026-10-11T23:47:37Z',provenance:'archive',textOrigin:'archive_excerpt',contextComplete:false,historical:false,metadata:{sourceGroup:'codex-resets',category:'product',activityDay:7,activity:{id:'challenge-28',title:'Tibo 的 28 天挑战',startsOn:'2026-10-05',days:28,timezone:'America/Los_Angeles',rules:'每天改进或重置'}},...extra};
}

test('已采集 Day7 中文摘录自动生成署名产品消息，不升级证据或产生重置动作',()=>{
  const e=excerpt(),before=structuredClone(e),draft=buildAutomaticTemplate([e])!;
  assert.ok(draft);assert.equal(draft.publicationMode,'news_only');assert.equal(draft.category,'activity');assert.equal(draft.activityId,'challenge-28');assert.equal(draft.activityDay,7);
  assert.deepEqual(draft.actions,[]);assert.match(draft.summary,/公开归档收录产品动态/);assert.ok(draft.summary.includes(text));assert.deepEqual(draft.evidenceIds,[e.id]);
  assert.equal(hasCompleteContext(e,[e]),false);assert.equal(canUseNewsOnlyAttribution(draft,[e]),true);assert.deepEqual(validateDraft(draft,[e],true),[]);assert.deepEqual(e,before);
});

test('同一严格事实支持产品分类，英语不会被当作已翻译或已重置',()=>{
  const english='Day 7/\n\nWe have increased default context length for GPT-6.1 Sol to 500k when used through Codex & Work, up from 272k or an ~ 80% increase.';
  assert.equal(hasStandaloneContext(text,'product'),true);assert.equal(hasStandaloneContext(english,'product'),true);assert.equal(hasStandaloneContext(english,'reset'),false);
  const e=excerpt({sourceId:'tibo-public',text:english,textOrigin:'original',contextComplete:true,metadata:{sourceGroup:'fxembed:thsottiaux',category:'product'}});
  assert.equal(buildAutomaticTemplate([e]),undefined);
});

test('未知来源、人工补录、缺少活动归属不能借同一摘录自动发布',()=>{
  const base=excerpt();
  for(const extra of [{sourceId:'unknown'},{sourceId:'reset-archive'},{provenance:'manual' as const},{metadata:{...base.metadata,sourceGroup:'unknown'}},{metadata:{...base.metadata,activity:undefined}},{metadata:{...base.metadata,activity:{...base.metadata!.activity!,id:'other-challenge'}}},{metadata:{...base.metadata,category:'reset' as const}}]){
    assert.equal(buildAutomaticTemplate([excerpt(extra)]),undefined);
  }
});

test('非法活动天数和规则、显式父帖、尾部截断不能自动变成产品消息',()=>{
  const base=excerpt();
  for(const day of [undefined,0,29,7.5,NaN])assert.equal(buildAutomaticTemplate([excerpt({metadata:{...base.metadata,activityDay:day}})]),undefined);
  assert.equal(buildAutomaticTemplate([excerpt({metadata:{...base.metadata,activity:{...base.metadata!.activity!,days:99}}})]),undefined);
  assert.equal(buildAutomaticTemplate([excerpt({parentId:'2109045220411351517'})]),undefined);
  for(const ending of ['…',' [truncated]',' 需要说明的是，我们已经'])assert.equal(buildAutomaticTemplate([excerpt({text:text+ending})]),undefined);
});

test('预计、否定、传言、数值倒退及非明确产品主体留待核对',()=>{
  for(const value of [text.replace('已从','预计从'),text.replace('已从','未从'),'传言：'+text,'并非'+text,text+' 此消息错误，尚未实施。',text+' 以上说法不实，实际没有提升。',text+' 该更新已撤回。',text+' 这不是已经实施的更新。',text+' 前面那句话是瞎说的。',text+' 但仅对一部分测试账号生效。',text.replace('272k','800k'),text.replace('500k','272k'),text.replace('272k','0k'),text.replace('500k','500ka'),text.replace('GPT-6.1 Sol 在 Codex 和 Work 中的','某产品的')]){
    assert.equal(buildAutomaticTemplate([excerpt({text:value})]),undefined,value);
  }
});

test('混合重置、发卡、定向资格句仍不能由产品归档模板自动声明',()=>{
  for(const ending of [' 已为所有用户重置用量。',' 已发放重置卡。',' Banked resets are available.',' We will reset usage for all paid accounts.',' 部分账户额度也增加了。']){
    const e=excerpt({text:text+ending}),draft=buildAutomaticTemplate([e]);
    assert.ok(!draft?.title.includes('默认上下文长度提升'));assert.deepEqual(draft?.actions??[],[]);assert.equal(hasCompleteContext(e,[e]),false);
  }
});

test('同量级单位换算正确，新闻摘要被改成发卡不能通过模板归因',()=>{
  const e=excerpt({text:text.replace('272k','0.272m').replace('500k','0.5m')}),draft=buildAutomaticTemplate([e])!;
  assert.ok(draft);assert.equal(canUseNewsOnlyAttribution({...draft,summary:'已为所有付费账户发卡。'},[e]),false);
  assert.ok(validateDraft({...draft,summary:'已为所有付费账户发卡。'},[e],true).length);
});

test('活动归档成功补核原文后仍能引用中文摘录，只接受同日同模型同数值',()=>{
  const english='Day 7/\n\nWe have increased default context length for GPT-6.1 Sol to 500k when used through Codex & Work, up from 272k or an ~ 80% increase.';
  const base=excerpt(),e=excerpt({text:english,textOrigin:'original',contextComplete:true,metadata:{...base.metadata,summary:text}}),before=structuredClone(e);
  const draft=buildAutomaticTemplate([e])!;
  assert.ok(draft);assert.equal(draft.publicationMode,'news_only');assert.deepEqual(draft.actions,[]);assert.ok(draft.summary.includes(text));assert.ok(!draft.summary.includes('Day 7/'));assert.deepEqual(validateDraft(draft,[e],true),[]);assert.deepEqual(e,before);
  for(const value of [english.replace('Day 7','Day 8'),english.replace('GPT-6.1 Sol','GPT-6.1 Astra'),english.replace('500k','600k'),english.replace('272k','300k'),english+' This has not actually shipped.',english+' Available to selected accounts only.'])assert.equal(buildAutomaticTemplate([excerpt({...e,text:value})]),undefined,value);
  assert.equal(buildAutomaticTemplate([excerpt({...e,metadata:{...e.metadata,summary:undefined}})]),undefined);
  assert.equal(buildAutomaticTemplate([excerpt({url:'https://x.com/other/status/2109430343346581527'})]),undefined);
});

test('新规则指纹让已等待 Day7 可重评，仍保持相同证据输入',()=>{
  const fingerprint=evidenceFingerprint([excerpt()]),old='benefit-rules-20261012-4:'+fingerprint.split(':')[1];
  assert.equal(fingerprintChange(old,fingerprint),'rules');assert.equal(buildAutomaticTemplate([excerpt()])?.publicationMode,'news_only');
});
