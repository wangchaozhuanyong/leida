import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DraftContent, Evidence } from '../src/lib/types';
import { parseArchive, parseReleases, retryAtFromHeaders, sourceDefinitions, SourceStructureError } from '../src/server/ingestion';
import { gatherEvidenceContext, hasCompleteContext, hasStandaloneContext } from '../src/server/source-context';
import { validateDraft } from '../src/server/domain';

const at = '2026-10-09T00:00:00Z';
function evidence(id:string,extra:Partial<Evidence>={}):Evidence {
  return {id,sourceId:'reset-archive',messageId:id,url:`https://x.com/thsottiaux/status/${id}`,text:'We will load a banked reset for all paid accounts.',publishedAt:at,collectedAt:at,hash:id,contextComplete:true,historical:false,provenance:'archive',...extra};
}
const releases = sourceDefinitions.find(s=>s.id==='official-releases')!;
const release = {id:123,tag_name:'rust-v1.2.3',name:'1.2.3',body:'## New Features\nAdded support for a new connector.',draft:false,prerelease:false,html_url:'https://github.com/openai/codex/releases/tag/rust-v1.2.3',published_at:at};

test('公开官方版本只收录稳定发布，保留官方身份和原文',()=>{
  const rows=parseReleases(JSON.stringify([release,{...release,id:124,prerelease:true},{...release,id:125,draft:true}]),releases,at);
  assert.equal(rows.length,1);
  assert.equal(rows[0].provenance,'official');
  assert.equal(rows[0].sourceId,'official-releases');
  assert.equal(rows[0].messageId,'release:123');
  assert.equal(rows[0].contextComplete,true);
  assert.match(rows[0].text,/Added support/);
  assert.equal(releases.intervalMinutes,5);
});

test('官方版本字段或外部链接异常不能作为正常产品发布',()=>{
  assert.throws(()=>parseReleases('{}',releases),SourceStructureError);
  assert.throws(()=>parseReleases(JSON.stringify([{...release,html_url:'https://elsewhere.invalid/release'}]),releases),SourceStructureError);
  assert.throws(()=>parseReleases(JSON.stringify([{...release,published_at:'yesterday'}]),releases),SourceStructureError);
});

test('归档完整性需要类型、资格、声明，长文和完成关键词不补足上下文',()=>{
  assert.equal(hasStandaloneContext('We will load a banked reset for all paid accounts.','reset'),true);
  assert.equal(hasStandaloneContext('Confirmed landed across all accounts. '+ 'More updates soon. '.repeat(12),'reset'),false);
  assert.equal(hasStandaloneContext('We will load a banked reset for all paid accounts…','reset'),false);
  assert.equal(hasStandaloneContext('As promised, we have loaded a banked reset for all paid accounts.','reset'),false);
  assert.equal(hasStandaloneContext('Codex 客户端新增连接器支持。','product'),true);
});

test('明确使用限制、限额与使用量等价词和句中修辞省略号不误拦',()=>{
  const complete=[
    '为了庆祝……我已经为所有 ChatGPT Work 和 Codex 的付费用户重置了使用限制。祝大家玩得开心！',
    '我们已为所有 Codex 和 ChatGPT Work 用户重置了使用限制。',
    '哎呀……我又搞了一次。所有付费用户的 Codex 和 ChatGPT Work 使用限额已重置，尽情使用吧。',
    '我们现在已为 ChatGPT Work 和 Codex 的所有付费订阅重置了使用额度。',
    '我们将在今天为所有 Plus、Pro 和 Business 用户进行完整的累积额度重置。',
    '所有付费用户的使用量已重置。',
  ];
  for(const text of complete)assert.equal(hasStandaloneContext(text,'reset'),true,text);
  assert.equal(hasStandaloneContext('我们已经重置了使用限制。','reset'),false,'没有资格范围');
  assert.equal(hasStandaloneContext('所有付费用户都可以查看自己的使用限额。','reset'),false,'没有重置声明');
  assert.equal(hasStandaloneContext(complete[0]+' 需要说明的是，我们已经','reset'),false,'有真实句尾截断');
  assert.equal(hasStandaloneContext(complete[0]+'……','reset'),false,'句尾省略仍需补全');
  assert.equal(hasStandaloneContext(complete[0]+' [truncated]','reset'),false,'来源截断标记');
});

test('明确父帖属性被保存，不把普通链接或邻近帖子推定为父帖',()=>{
  const html=(parent:string)=>`<li class="log-item" data-tweet-id="222" ${parent}><span data-datetime="${at}"></span><p class="log-item-text">We will load a banked reset for all paid accounts.</p><a class="log-item-link" href="https://x.com/thsottiaux/status/222">原文</a><a href="https://x.com/thsottiaux/status/111">关联链接</a></li>`;
  const row=parseArchive(html('data-parent-id="111"'),sourceDefinitions[1],at)[0];
  assert.equal(row.parentId,'111');
  assert.equal(row.contextComplete,false);
  assert.equal(parseArchive(html(''),sourceDefinitions[1],at)[0].parentId,undefined);
});

test('父链跨同作者归档补齐，选最新版本，不修改原文',()=>{
  const child=evidence('300',{parentId:'200',contextComplete:false});
  const middle=evidence('200',{parentId:'100',contextComplete:false,sourceId:'activity-archive'});
  const old=evidence('old',{messageId:'100',url:'https://x.com/thsottiaux/status/100',collectedAt:'2026-10-08T00:00:00Z'});
  const latest=evidence('latest',{messageId:'100',url:'https://x.com/thsottiaux/status/100'});
  const chain=gatherEvidenceContext(child,[old,child,middle,latest]);
  assert.deepEqual(chain.map(e=>e.id),['300','200','latest']);
  assert.equal(hasCompleteContext(child,chain),true);
  assert.equal(child.contextComplete,false);
});

test('不把其他平台、其他作者或人工历史摘要当自动父帖',()=>{
  const child=evidence('300',{parentId:'100',contextComplete:false});
  for(const parent of [evidence('100',{url:'https://github.com/openai/codex/releases/tag/v1'}),evidence('100',{url:'https://x.com/other/status/100'}),evidence('100',{provenance:'manual',historical:true})]){
    assert.deepEqual(gatherEvidenceContext(child,[child,parent]),[child]);
    assert.equal(hasCompleteContext(child,[child,parent]),false);
  }
  const manual=evidence('100',{provenance:'manual'});
  assert.equal(hasCompleteContext(child,[child,manual],true),true);
});

test('人工审核可沿已引用的明确父链补证，原始不完整标记保留且自动模式仍拒绝',()=>{
  const parent=evidence('manual-parent',{sourceId:'manual',provenance:'manual',url:'https://example.org/parent'});
  const child=evidence('manual-child',{sourceId:'manual',provenance:'manual',url:'https://example.org/child',parentId:parent.messageId,contextComplete:false,text:'Confirmed landed across all accounts.'});
  const before=structuredClone([child,parent]);
  const content:DraftContent={title:'公告称重置卡已发放',summary:'完整父帖与完成回复表明付费账户重置卡已发放。',translation:'',category:'reset',evidenceIds:[child.id,parent.id],actions:[{id:'manual-card',kind:'banked_reset',stage:'claimed_complete',eligibility:'付费账户',scope:'public',statementAt:at,evidenceIds:[child.id,parent.id],evidenceQuote:child.text}]};
  assert.equal(hasCompleteContext(child,[child,parent],true),true);
  assert.deepEqual(validateDraft(content,[child,parent],false),[]);
  assert.deepEqual([child,parent],before,'补证不修改原始证据');
  assert.equal(hasCompleteContext(child,[child,parent]),false);
  assert.ok(validateDraft(content,[child,parent],true).some(reason=>reason.includes('人工补录')));
  assert.equal(content.contextEvidenceIds,undefined,'明确父链不依赖额外人工关联字段');
});

test('人工补证保留多级父链、最新版本与循环保护',()=>{
  const root=evidence('root',{sourceId:'manual',provenance:'manual',url:'https://example.org/root'});
  const middle=evidence('middle',{sourceId:'manual',provenance:'manual',url:'https://example.org/middle',parentId:root.messageId,contextComplete:false,text:'As promised.'});
  const child=evidence('child',{sourceId:'manual',provenance:'manual',url:'https://example.org/child',parentId:middle.messageId,contextComplete:false,text:'Confirmed landed across all accounts.'});
  assert.equal(hasCompleteContext(child,[child,middle,root],true),true);
  const cyclicRoot={...root,contextComplete:false,parentId:child.messageId};
  assert.equal(hasCompleteContext(child,[child,middle,cyclicRoot],true),false);
  const latestRoot={...root,id:'new-root',contextComplete:false,collectedAt:'2026-10-10T00:00:00Z'};
  assert.equal(hasCompleteContext(child,[child,middle,root,latestRoot],true),false,'新版缺上下文不借旧版完整标记');
});

test('人工父链仍拒绝缺引用、错误编号、跨来源作者与截断',()=>{
  const parent=evidence('parent',{sourceId:'manual',provenance:'manual',url:'https://example.org/parent'});
  const child=evidence('child',{sourceId:'manual',provenance:'manual',url:'https://example.org/child',parentId:parent.messageId,contextComplete:false,text:'Confirmed landed across all accounts.'});
  assert.equal(hasCompleteContext(child,[child],true),false);
  assert.equal(hasCompleteContext({...child,parentId:'wrong'},[child,parent],true),false);
  assert.equal(hasCompleteContext(child,[child,{...parent,sourceId:'other'}],true),false);
  assert.equal(hasCompleteContext({...child,text:child.text+' [truncated]'},[child,parent],true),false);
  assert.equal(hasCompleteContext(child,[child,{...parent,text:parent.text+'…'}],true),false);
  const xChild={...child,messageId:'manual_child_hash',url:'https://x.com/thsottiaux/status/300',parentId:'manual_parent_hash'};
  const xParent={...parent,messageId:'manual_parent_hash',url:'https://x.com/thsottiaux/status/100'};
  assert.equal(hasCompleteContext(xChild,[xChild,xParent],true),true,'明确关系使用实际保存的人工消息编号');
  assert.equal(hasCompleteContext({...xChild,parentId:'100'},[xChild,xParent],true),false,'原站编号不自动等同人工消息编号');
  assert.equal(hasCompleteContext(xChild,[xChild,{...xParent,url:'https://x.com/other/status/100'}],true),false);
});

test('循环父链和新版不完整父帖不能使用旧版完整标记放行',()=>{
  const child=evidence('300',{parentId:'100',contextComplete:false});
  const old=evidence('old',{messageId:'100',collectedAt:'2026-10-08T00:00:00Z'});
  const latest=evidence('latest',{messageId:'100',parentId:'300',contextComplete:false});
  assert.equal(hasCompleteContext(child,[child,old,latest]),false);
  assert.equal(gatherEvidenceContext(child,[child,old,latest]).length,2);
});

test('明确时区与原文截止可以自动发布，捏造歧义说明不能通过',()=>{
  const e=evidence('100',{text:'We will load a banked reset for all paid accounts by 2026-10-09T16:00:00Z.'});
  const draft:DraftContent={title:'付费账户重置卡发放预告',summary:'公告承诺向付费账户发放重置卡。',translation:'',category:'reset',evidenceIds:[e.id],actions:[{id:'a',kind:'banked_reset',stage:'promised',eligibility:'付费账户',scope:'public',statementAt:at,expectedAt:'2026-10-10T00:00:00+08:00',evidenceIds:[e.id],evidenceQuote:e.text,timeNote:'已换算为北京时间（UTC+8）'}]};
  assert.deepEqual(validateDraft(draft,[e],true),[]);
  draft.actions[0].timeNote='原文时区可能不明确';
  assert.ok(validateDraft(draft,[e],true).some(r=>r.includes('歧义')));
  for(const note of ['EOD PST','PST 当天结束之前','北京时间 15:00 或 16:00','当地时间晚上']){
    draft.actions[0].timeNote=note;
    assert.ok(validateDraft(draft,[e],true).some(r=>r.includes('歧义')),note);
  }
});

test('自动模式不能靠随意引用完整原文绕过缺失父链，人工核对入口保留',()=>{
  const child=evidence('300',{contextComplete:false,text:'Codex improvements are live.'});
  const unrelated=evidence('100');
  const draft:DraftContent={title:'产品更新',summary:'已收录产品更新。',translation:'',category:'product',actions:[],evidenceIds:[child.id,unrelated.id],contextEvidenceIds:[unrelated.id]};
  assert.ok(validateDraft(draft,[child,unrelated],true).some(r=>r.includes('上下文')));
  assert.deepEqual(validateDraft(draft,[child,unrelated],false),[]);
});

test('尊重来源限流响应，至少等待五分钟',()=>{
  const current=Date.parse(at);
  assert.equal(retryAtFromHeaders(new Headers({'retry-after':'1200'}),current),'2026-10-09T00:20:00.000Z');
  assert.equal(retryAtFromHeaders(new Headers({'x-ratelimit-reset':String((current+3600_000)/1000)}),current),'2026-10-09T01:00:00.000Z');
  assert.equal(retryAtFromHeaders(new Headers(),current),'2026-10-09T00:05:00.000Z');
});
