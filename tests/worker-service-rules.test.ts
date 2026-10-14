import test from 'node:test';
import assert from 'node:assert/strict';
import {partitionAutomaticActions,isStaleMachineConflict,publishedTemplateArticle,samePublishedContent,automaticCorrection,mixedAutomaticEventTitle,automaticNewsContextUpgrade} from '../src/server/service';
import {fingerprintChange,canEnrich,resolveLinkedEvents,actionIdentityEvidence} from '../src/server/worker';
import {gatherEvidenceContext} from '../src/server/source-context';
import {buildAutomaticTemplate} from '../src/server/automatic-content';
import type {Article,BenefitAction,Candidate,DraftContent,Evidence,RadarEvent} from '../src/lib/types';

const previousAt='2026-10-10T10:00:00.000Z',olderAt='2026-10-10T09:00:00.000Z',newerAt='2026-10-10T11:00:00.000Z';
const action=(patch:Partial<BenefitAction>={}):BenefitAction=>({id:'card',kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'所有账户',evidenceIds:['e'],statementAt:previousAt,evidenceQuote:'我们已为所有账户发放重置卡。',...patch});
const event=(patch:Partial<RadarEvent>={}):RadarEvent=>({id:'event',title:'当前完成公告',version:3,status:'published',actions:[action()],evidenceIds:['e'],publicationId:'pub',updatedAt:previousAt,...patch});
const evidence=(patch:Partial<Evidence>={}):Evidence=>({id:'e',sourceId:'source',messageId:'2300000000000012345',url:'https://x.com/fixture/status/2300000000000012345',text:'我们已为所有账户发放重置卡。',textOrigin:'original',hash:'fixture',publishedAt:previousAt,collectedAt:previousAt,contextComplete:true,historical:false,provenance:'archive',...patch});
const draft=(patch:Partial<DraftContent>={}):DraftContent=>({title:'完成公告',summary:'公开来源称所有账户重置卡已发放。',translation:'',category:'reset',actions:[action()],evidenceIds:['e'],eventId:'event',publicationMode:'state_change',contentOrigin:'template',...patch});
const article=(patch:Partial<Article>={}):Article=>({id:'article',eventId:'event',title:'完成公告',summary:'公开来源称所有账户重置卡已发放。',translation:'',category:'reset',evidenceIds:['e'],version:1,status:'published',publicationId:'pub',publishedAt:previousAt,updatedAt:previousAt,publicationMode:'state_change',contentOrigin:'template',...patch});
const candidate=(patch:Partial<Candidate>={}):Candidate=>({id:'candidate',evidenceId:'e',status:'published',humanEdited:false,version:2,reasons:[],content:draft(),createdAt:previousAt,updatedAt:previousAt,automation:{state:'ready',reasonCodes:[],dependencyIds:[],articleId:'article',templatePublished:true},...patch});

test('完整福利预告的旧产品祖先不阻断完成回复关联同一轮',()=>{
 const product=evidence({id:'product',messageId:'2108000000000000000',url:'https://x.com/thsottiaux/status/2108000000000000000',text:'Codex mobile app is now available.'});
 const promise=evidence({id:'promise',messageId:'2109000000000000000',url:'https://x.com/thsottiaux/status/2109000000000000000',text:'We will reset usage for all Codex accounts within 2 hours.',parentId:product.messageId});
 const complete=evidence({id:'complete',messageId:'2109132167112782291',url:'https://x.com/thsottiaux/status/2109132167112782291',text:'Put the reset in the bag. All propagated.',parentId:promise.messageId,contextComplete:false});
 const all=[complete,promise,product],context=gatherEvidenceContext(complete,all);
 assert.deepEqual(context.map(item=>item.id),['complete','promise','product'],'完整祖先链继续保存');
 const reset=event({id:'round',actions:buildAutomaticTemplate([promise,product])!.actions,evidenceIds:[promise.id,product.id]});
 const productEvent=event({id:'product-event',actions:[],evidenceIds:[product.id]});
 const unrelatedSibling=evidence({...product,id:'sibling',messageId:'2108500000000000000',url:'https://x.com/thsottiaux/status/2108500000000000000',parentId:product.messageId});
 assert.deepEqual(resolveLinkedEvents(promise,gatherEvidenceContext(promise,all),[productEvent],all),[],'新的独立福利预告不追加到旧产品事件');
 assert.deepEqual(resolveLinkedEvents(complete,context,[productEvent,reset,event({id:'sibling-event',actions:[],evidenceIds:[unrelatedSibling.id]})],[...all,unrelatedSibling]).map(item=>item.id),[reset.id]);
 assert.equal(buildAutomaticTemplate(context)!.actions[0].stage,'claimed_complete');
 assert.equal(actionIdentityEvidence(promise,gatherEvidenceContext(promise,all)).id,promise.id);
 assert.equal(actionIdentityEvidence(complete,context).id,promise.id);
});

test('共享产品父帖的独立完整声明不借父帖生成相撞的动作编号',()=>{
 const product=evidence({id:'product',messageId:'2093811840258293947',text:'We crossed 25M users. More good news soon.'});
 const first=evidence({id:'first',messageId:'2094251180121854309',text:'We have now reset usage for all paid subscriptions for ChatGPT Work and Codex.',parentId:product.messageId});
 const second=evidence({...first,id:'second',messageId:'2094252447271366730'});
 const all=[second,first,product],existing=event({id:'first-event',actions:buildAutomaticTemplate([first,product])!.actions,evidenceIds:[first.id,product.id]});
 const before=structuredClone(all);
 assert.equal(actionIdentityEvidence(first,[first,product]).id,first.id);
 assert.equal(actionIdentityEvidence(second,[second,product]).id,second.id);
 assert.deepEqual(resolveLinkedEvents(second,[second,product],[existing],all),[],'非福利父帖不证明两个独立声明属于同一轮');
 assert.deepEqual(all,before);
});

test('未补齐的显式父编号和同一福利轮次的两个事件仍保留关联冲突',()=>{
 const parent=evidence({id:'promise',messageId:'2109000000000000000',url:'https://x.com/thsottiaux/status/2109000000000000000',text:'We will load a banked reset for all paid accounts.'});
 const child=evidence({id:'complete',messageId:'2109132167112782291',url:'https://x.com/thsottiaux/status/2109132167112782291',text:'Confirmed landed across all accounts.',parentId:parent.messageId,contextComplete:false});
 const first=event({id:'first',evidenceIds:[parent.id]}),second=event({id:'second',evidenceIds:[parent.id]});
 assert.deepEqual(resolveLinkedEvents(child,[child,parent],[first,second],[child,parent]).map(item=>item.id),['first','second']);
 assert.deepEqual(resolveLinkedEvents(child,[child],[first],[child,parent]).map(item=>item.id),['first']);
});

test('已保存原文但明确父帖尚待补齐时允许后续补证重试',()=>{
 const child=evidence({url:'https://x.com/thsottiaux/status/2108040921044639779',text:'Confirmed landed across all accounts.',parentId:'2107800000000000000',contextComplete:false});
 assert.equal(canEnrich(child),true);assert.equal(canEnrich({...child,contextComplete:true}),false);assert.equal(canEnrich({...child,provenance:'manual'}),false);
 assert.equal(canEnrich({...child,parentId:undefined}),false);
});

function newsContextFixture(oldSourceId='reset-archive'){
 const childId='2108040921044639779',parentId='2107800000000000000';
 const oldPrimary=evidence({id:'old-child',sourceId:oldSourceId,messageId:childId,url:`https://twitter.com/thsottiaux/status/${childId}`,text:'已确认在所有账户落地。',textOrigin:'archive_excerpt',contextComplete:false});
 const primary=evidence({id:'enriched-child',sourceId:'reset-archive',messageId:childId,url:`https://x.com/thsottiaux/status/${childId}`,text:'Confirmed landed across all accounts. https://t.co/verifiedParent',parentId,textOrigin:'original',contextComplete:false});
 const parent=evidence({id:'parent-evidence',sourceId:'reset-archive',messageId:parentId,url:`https://x.com/thsottiaux/status/${parentId}`,text:'We will load a banked reset for all paid accounts.',publishedAt:olderAt,collectedAt:newerAt,textOrigin:'original',contextComplete:true});
 const target=event({id:'parent-target',title:'重置卡公开预告',actions:[action({id:'parent-card',stage:'promised',eligibility:'所有付费账户',evidenceIds:[parent.id],statementAt:olderAt,evidenceQuote:parent.text})],evidenceIds:[parent.id],publicationId:'parent-publication'});
 const duplicate=event({id:'old-news-event',title:'等待补充上下文的公开动态',actions:[],evidenceIds:[oldPrimary.id],publicationId:'old-news-publication'});
 const oldArticle=article({id:'old-news-article',eventId:duplicate.id,title:duplicate.title,summary:'公开动态已保存，等待对应原承诺。',evidenceIds:[oldPrimary.id],publicationMode:'news_only',contentOrigin:'template',publicationId:duplicate.publicationId});
 const content=draft({title:'重置卡：公告称已完成',summary:'公开原文及明确父帖表明所有付费账户的重置卡已发放。',eventId:target.id,evidenceIds:[primary.id,parent.id],contextEvidenceIds:[parent.id],actions:[action({id:'child-card',eligibility:'所有付费账户',evidenceIds:[primary.id,parent.id],statementAt:previousAt,evidenceQuote:primary.text})]});
 return {primary,parent,oldPrimary,content,duplicate,target,evidence:[primary,parent,oldPrimary],articles:[oldArticle],oldArticle};
}
function upgradedArticle(input:ReturnType<typeof newsContextFixture>){return automaticNewsContextUpgrade(input.primary,input.content,input.duplicate,input.target,input.evidence,input.articles);}

test('逐项筛旧声明；旧预告与旧取消不进入当前动作，也不修改输入',()=>{
 for(const stage of ['promised','cancelled'] as const){
  const incoming=draft({actions:[action({stage,statementAt:olderAt,eligibility:'付费账户'})]});
  const saved=structuredClone(incoming),split=partitionAutomaticActions(incoming,event({manualFields:['title','actions.card.stage']}));
  assert.deepEqual(split.current,[]);assert.equal(split.stale.length,1);assert.deepEqual(incoming,saved);
  assert.equal(automaticCorrection(incoming,event(),[evidence({publishedAt:olderAt})]),false);
 }
});
test('一条消息含旧动作和新动作，只过滤旧动作',()=>{
 const fresh=action({id:'usage',kind:'automatic_reset',stage:'promised',statementAt:newerAt,evidenceQuote:'我们将重置所有账户用量。'});
 const split=partitionAutomaticActions(draft({actions:[action({statementAt:olderAt,stage:'promised'}),fresh]}),event());
 assert.deepEqual(split.current,[fresh]);assert.equal(split.stale.length,1);
});
test('混合旧新声明仅派生当前事件标题，文章保留原句并保护人工标题',()=>{
 const raw=draft({title:'重置卡将发放，用量重置已完成',actions:[action({statementAt:olderAt,stage:'promised'}),action({id:'usage',kind:'automatic_reset',statementAt:newerAt})]});
 const saved=structuredClone(raw),split=partitionAutomaticActions(raw,event()),effective={...raw,actions:split.current};
 assert.equal(mixedAutomaticEventTitle(effective,event(),!!split.stale.length),'用量重置与重置卡进展');
 assert.equal(mixedAutomaticEventTitle(effective,event({title:'站长核对后的标题',manualFields:['title']}),true),'站长核对后的标题');
 assert.equal(mixedAutomaticEventTitle({...effective,publicationMode:'news_only',actions:[]},event(),true),undefined,'纯旧归档不生成当前事件标题');
 assert.equal(mixedAutomaticEventTitle(effective,event(),false),undefined,'只有新声明沿用原有发布规则');
 assert.deepEqual(raw,saved,'派生事件标题不能改写原文章或证据动作');
});
test('同刻不同事实仍为冲突，类型错误也不能被旧时间掩盖',()=>{
 assert.throws(()=>partitionAutomaticActions(draft({actions:[action({stage:'cancelled'})]}),event()),/相同声明时间/);
 const wrongKind=action({kind:'automatic_reset',statementAt:olderAt});
 assert.throws(()=>partitionAutomaticActions(draft({actions:[wrongKind]}),event()),/福利类型冲突/);
});
test('新的明确取消继续核对每个动作的真实更正证据',()=>{
 const raw=evidence({id:'cancel',text:'更正：取消为所有账户发放重置卡。',publishedAt:newerAt});
 const cancellation=action({stage:'cancelled',statementAt:newerAt,evidenceIds:[raw.id],evidenceQuote:raw.text});
 assert.equal(automaticCorrection(draft({actions:[cancellation],evidenceIds:[raw.id]}),event(),[raw]),true);
 assert.throws(()=>automaticCorrection(draft({actions:[{...cancellation,evidenceQuote:'我们将发放重置卡。'}],evidenceIds:[raw.id]}),event(),[raw]),/明确更正证据/);
});
test('规则变更仅解除可证明严格旧动作的机器误冲突',()=>{
 const blocked=candidate({status:'pending',reasons:['动作资格或状态变化缺少明确更正证据，存在事实冲突'],content:draft({actions:[action({statementAt:olderAt,stage:'promised'})]}),automation:{state:'conflict',reasonCodes:['fact_conflict'],dependencyIds:[]}});
 assert.equal(isStaleMachineConflict(blocked,event()),true);
 assert.equal(isStaleMachineConflict({...blocked,humanEdited:true},event()),false);
 assert.equal(isStaleMachineConflict({...blocked,reasons:[...blocked.reasons,'活动来源规则与人工配置冲突，暂缓关联']},event()),false);
 assert.equal(isStaleMachineConflict({...blocked,content:draft({actions:[action({statementAt:newerAt,stage:'promised'})]})},event()),false);
 assert.equal(isStaleMachineConflict({...blocked,content:draft({actions:[action({statementAt:previousAt,stage:'promised'})]})},event()),false);
 assert.equal(isStaleMachineConflict(blocked,event({status:'withdrawn'})),false);
});
test('处理签名区别规则变更与实际证据变化，兼容旧纯hash',()=>{
 const first='a'.repeat(64),second='b'.repeat(64);
 assert.equal(fingerprintChange(undefined,`rules-1:${first}`),'new');
 assert.equal(fingerprintChange(first,`rules-1:${first}`),'rules');
 assert.equal(fingerprintChange(`rules-1:${first}`,`rules-2:${first}`),'rules');
 assert.equal(fingerprintChange(`rules-1:${first}`,`rules-1:${second}`),'evidence');
 assert.equal(fingerprintChange(`rules-1:${first}`,`rules-1:${first}`),'none');
});
test('实际已发布文章决定模板类型，不跟随失败候选中的临时模式',()=>{
 const actual=article({publicationMode:'news_only'}),failedDraft=candidate({content:draft({publicationMode:'state_change'})});
 assert.equal(publishedTemplateArticle(failedDraft,evidence(),[evidence()],[actual],[event()])?.publicationMode,'news_only');
 assert.equal(publishedTemplateArticle(candidate({content:draft({publicationMode:'news_only'})}),evidence(),[evidence()],[article()],[event()])?.publicationMode,'state_change');
});
test('已撤回、被人工编辑或原帖身份不匹配的文章不会自动补充',()=>{
 assert.equal(publishedTemplateArticle(candidate(),evidence(),[evidence()],[article({status:'withdrawn'})],[event()]),undefined);
 assert.equal(publishedTemplateArticle(candidate(),evidence(),[evidence()],[article()],[event({status:'withdrawn'})]),undefined);
 assert.equal(publishedTemplateArticle(candidate({humanEdited:true}),evidence(),[evidence()],[article()],[event()]),undefined);
 assert.equal(publishedTemplateArticle(candidate(),evidence(),[evidence(),evidence({id:'other',url:'https://x.com/fixture/status/999',messageId:'999'})],[article({evidenceIds:['other']})],[event()]),undefined);
});
test('只有来源、文章内容与当前动作均不变时复用发布版本',()=>{
 assert.equal(samePublishedContent(draft(),article(),event()),true);
 assert.equal(samePublishedContent(draft({contentOrigin:'generated'}),article(),event()),true,'生成来源标签不制造一个相同正文版本');
 assert.equal(samePublishedContent(draft({summary:'新的摘要'}),article(),event()),false);
 assert.equal(samePublishedContent(draft({evidenceIds:['e','parent']}),article(),event()),false,'新增真实引用需要证据版本');
 assert.equal(samePublishedContent(draft({publicationMode:'news_only',actions:[]}),article(),event()),false,'福利升级或模式改变需要版本');
 assert.equal(samePublishedContent(draft(),article(),event({actions:[action({stage:'promised',statementAt:olderAt})]})),false);
});
test('仅新闻无动作不会借关联事件制造事实变化，撤回仍不能复用',()=>{
 const news=draft({publicationMode:'news_only',actions:[]}),published=article({publicationMode:'news_only'});
 assert.equal(samePublishedContent(news,published,event()),true);
 assert.equal(samePublishedContent(news,published,event({status:'withdrawn'})),false);
 assert.equal(samePublishedContent({...news,activityId:'activity',activityDay:1},published,event()),false,'不能把未关联的新活动当作无变化');
});

test('仅完整明确父链允许把同一官方child的空动作模板新闻关联到原父预告，同源和跨源身份均可',()=>{
 for(const oldSourceId of ['reset-archive','activity-archive']){
  const fixture=newsContextFixture(oldSourceId),before=structuredClone(fixture),result=upgradedArticle(fixture);
  assert.deepEqual(result,fixture.oldArticle,oldSourceId);assert.equal(result?.publicationId,'old-news-publication','选择旧文章用于新增版本，不能覆盖旧publication');assert.deepEqual(fixture,before,'纯选择函数不改写任何输入');
 }
});

test('缺父链、完整性不足、跨作者父链或未关联父target不能自动升级新闻',()=>{
 const missing=newsContextFixture();missing.primary={...missing.primary,parentId:undefined};assert.equal(upgradedArticle(missing),undefined,'同时间或contextEvidenceIds不等于明确父链');
 const absent=newsContextFixture();absent.evidence=absent.evidence.filter(item=>item.id!==absent.parent.id);assert.equal(upgradedArticle(absent),undefined,'缺实际父正文');
 const incomplete=newsContextFixture();incomplete.evidence=incomplete.evidence.map(item=>item.id===incomplete.parent.id?{...item,text:'We will load it.',contextComplete:false}:item);assert.equal(upgradedArticle(incomplete),undefined,'父帖资格和福利未明确');
 const wrongAuthor=newsContextFixture();wrongAuthor.evidence=wrongAuthor.evidence.map(item=>item.id===wrongAuthor.parent.id?{...item,url:`https://x.com/other/status/${item.messageId}`} :item);assert.equal(upgradedArticle(wrongAuthor),undefined,'不能借其他作者父帖');
 const unrelatedTarget=newsContextFixture();unrelatedTarget.target={...unrelatedTarget.target,evidenceIds:['unrelated-target-evidence']};assert.equal(upgradedArticle(unrelatedTarget),undefined,'target须引用真实ancestor');
});

test('多主题target、kind/scope不匹配、旧事件已有动作或多动作新内容均拒绝自动迁移',()=>{
 const multiple=newsContextFixture();multiple.target={...multiple.target,actions:[...multiple.target.actions,action({id:'usage',kind:'automatic_reset'})]};assert.equal(upgradedArticle(multiple),undefined);
 const wrongKind=newsContextFixture();wrongKind.target={...wrongKind.target,actions:[{...wrongKind.target.actions[0],kind:'automatic_reset'}]};assert.equal(upgradedArticle(wrongKind),undefined);
 const wrongScope=newsContextFixture();wrongScope.target={...wrongScope.target,actions:[{...wrongScope.target.actions[0],scope:'targeted'}]};assert.equal(upgradedArticle(wrongScope),undefined);
 const oldAction=newsContextFixture();oldAction.duplicate={...oldAction.duplicate,actions:[action()]};assert.equal(upgradedArticle(oldAction),undefined,'有实际动作的旧事件不属于模板新闻修复');
 const manyIncoming=newsContextFixture();manyIncoming.content={...manyIncoming.content,actions:[...manyIncoming.content.actions,action({id:'another-usage',kind:'automatic_reset'})]};assert.equal(upgradedArticle(manyIncoming),undefined);
});

test('人工来源、人工或生成新闻、文章和事件人工保护字段均拒绝自动升级',()=>{
 const manualPrimary=newsContextFixture();manualPrimary.primary={...manualPrimary.primary,provenance:'manual'};assert.equal(upgradedArticle(manualPrimary),undefined);
 const manualOld=newsContextFixture();manualOld.evidence=manualOld.evidence.map(item=>item.id===manualOld.oldPrimary.id?{...item,provenance:'manual'}:item);assert.equal(upgradedArticle(manualOld),undefined);
 for(const contentOrigin of [undefined,'generated'] as const){const fixture=newsContextFixture();fixture.articles=fixture.articles.map(item=>({...item,contentOrigin}));assert.equal(upgradedArticle(fixture),undefined,'只重关联可证明自动模板新闻');}
 const protectedArticle=newsContextFixture();protectedArticle.articles=protectedArticle.articles.map(item=>({...item,manualFields:['summary']}));assert.equal(upgradedArticle(protectedArticle),undefined);
 const protectedOld=newsContextFixture();protectedOld.duplicate={...protectedOld.duplicate,manualFields:['title']};assert.equal(upgradedArticle(protectedOld),undefined);
 const protectedTarget=newsContextFixture();protectedTarget.target={...protectedTarget.target,manualFields:['actions.parent-card.stage']};assert.equal(upgradedArticle(protectedTarget),undefined);
});

test('其他原帖文章、多个候选模板文章或被撤回记录不能自动选定迁移对象',()=>{
 const other=newsContextFixture(),otherEvidence=evidence({id:'other-post',messageId:'2108050000000000000',url:'https://x.com/thsottiaux/status/2108050000000000000'});other.evidence.push(otherEvidence);other.articles=other.articles.map(item=>({...item,evidenceIds:[otherEvidence.id]}));assert.equal(upgradedArticle(other),undefined);
 const ambiguous=newsContextFixture();ambiguous.articles.push({...ambiguous.oldArticle,id:'another-news-article'});assert.equal(upgradedArticle(ambiguous),undefined,'多个有效同原帖模板文章不猜');
 const wrongEvent=newsContextFixture();wrongEvent.articles=wrongEvent.articles.map(item=>({...item,eventId:'another-event'}));assert.equal(upgradedArticle(wrongEvent),undefined);
 const withdrawnArticle=newsContextFixture();withdrawnArticle.articles=withdrawnArticle.articles.map(item=>({...item,status:'withdrawn'}));assert.equal(upgradedArticle(withdrawnArticle),undefined);
 const withdrawnOld=newsContextFixture();withdrawnOld.duplicate={...withdrawnOld.duplicate,status:'withdrawn'};assert.equal(upgradedArticle(withdrawnOld),undefined);
 const withdrawnTarget=newsContextFixture();withdrawnTarget.target={...withdrawnTarget.target,status:'withdrawn'};assert.equal(upgradedArticle(withdrawnTarget),undefined);
});

test('父帖不能来自child之后，新动作不能回退既有target时间，拒绝路径也无输入破坏',()=>{
 const futureParent=newsContextFixture();futureParent.evidence=futureParent.evidence.map(item=>item.id===futureParent.parent.id?{...item,publishedAt:newerAt}:item);const before=structuredClone(futureParent);assert.equal(upgradedArticle(futureParent),undefined);assert.deepEqual(futureParent,before);
 const staleAction=newsContextFixture();staleAction.content={...staleAction.content,actions:[{...staleAction.content.actions[0],statementAt:'2026-10-10T08:00:00.000Z'}]};const staleBefore=structuredClone(staleAction);assert.equal(upgradedArticle(staleAction),undefined);assert.deepEqual(staleAction,staleBefore);
 const unrelatedOld=newsContextFixture(),other=evidence({id:'unrelated-old',messageId:'2108050000000000000',url:'https://x.com/thsottiaux/status/2108050000000000000'});unrelatedOld.evidence.push(other);unrelatedOld.duplicate={...unrelatedOld.duplicate,evidenceIds:[unrelatedOld.oldPrimary.id,other.id]};assert.equal(upgradedArticle(unrelatedOld),undefined,'旧event引用其他原帖说明主题不单一');
});
