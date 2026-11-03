import { createRequire } from 'node:module';
import { posterSvg } from '../src/server/poster';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import type { Article, Evidence, PublicData, Publication } from '../src/lib/types';
import { publicArticleContent } from '../src/components/public/model';
import { ArticlePage, EventPage, EvidencePage } from '../src/components/public/PublicApp';
import { publicArticleTitle, publicArticleSummary } from '../src/lib/public-content';

const time = '2026-10-16T01:00:00.000Z';
const article: Article = { id: 'a', eventId: 'e', publicationId: 'p', title: '公告标题', summary: '额度提高至 20 次。', translation: '', category: 'reset', version: 1, status: 'published', evidenceIds: ['source'], publishedAt: time, updatedAt: time, contentOrigin: 'template' };
const evidence: Evidence = { id: 'source', sourceId: 'archive', messageId: 'message', url: 'https://example.com/original', text: 'Original text.', publishedAt: time, collectedAt: time, hash: 'hash', contextComplete: false, historical: false, provenance: 'archive', textOrigin: 'archive_excerpt', metadata: { title: '内部收录标题', summary: '内部辅助摘要' } };
const fixture = (changes: Partial<Article> = {}): PublicData => {
  const item = { ...article, ...changes };
  const publication: Publication = { id: 'p', eventId: 'e', articleId: 'a', article: item, cutoffAt: time, publishedAt: time, mode: 'state_change', reason: '', event: { id: 'e', title: item.title, version: 1, status: 'published', publicationId: 'p', updatedAt: time, evidenceIds: ['source'], actions: [{ id: 'action', kind: 'automatic_reset', stage: 'promised', scope: 'public', eligibility: '所有用户', statementAt: time, evidenceIds: ['source'] }] } };
  return { articles: [item], events: [publication.event], publications: [publication], evidence: [structuredClone(evidence)], notices: [], activities: [], sources: [{ id: 'archive', name: '公开来源（辅助来源）', status: 'healthy', lastSuccessAt: time }], site: { name: '模钥重置雷达', description: '', autoPublish: true, version: 1 }, serverTime: time };
};
const renderArticle = (data: PublicData) => renderToStaticMarkup(createElement(ArticlePage, { data, id: 'a', onPoster() {} }));
const renderEvent = (data: PublicData) => renderToStaticMarkup(createElement(SearchParamsContext.Provider, { value: new URLSearchParams() }, createElement(EventPage, { data, id: 'e', onPoster() {}, onShare: async () => {} })));

test('摘要相同、空正文和仅排版不同的正文只显示一次公告内容', () => {
  for (const translation of ['', article.summary, '\n 额度提高至\u200b 20 次。\t']) {
    const data = fixture({ translation });
    assert.equal(publicArticleContent(data.articles[0]).hasAdditionalContent, false);
    for (const html of [renderArticle(data), renderEvent(data)]) {
      assert.match(html, /公告内容/);
      assert.equal((html.match(/额度提高至 20 次。/g) || []).length, 1);
      assert.doesNotMatch(html, /中文摘要|阅读全文|完整内容<\/summary>/);
    }
  }
});

test('模板清理前后相同的正文都不制造第二份内容', () => {
  const summary = '根据公开归档保存的原帖，额度提高至 20 次。';
  for (const translation of [summary, '额度提高至 20 次。']) {
    assert.deepEqual(publicArticleContent({ ...article, summary, translation }), { summary: '额度提高至 20 次。', body: translation, hasAdditionalContent: false });
  }
});

test('摘要为空时正文成为唯一公告内容，空内容有可理解提示', () => {
  const data = fixture({ summary: ' ', translation: '完整说明 30 次。' });
  assert.deepEqual(publicArticleContent(data.articles[0]), { summary: '完整说明 30 次。', body: '完整说明 30 次。', hasAdditionalContent: false });
  const html = renderArticle(data);
  assert.equal((html.match(/完整说明 30 次。/g) || []).length, 1);
  assert.doesNotMatch(html, /阅读全文/);
  assert.match(renderArticle(fixture({ summary: '', translation: '' })), /暂无可展示的公告内容，请查看来源/);
});

test('不同数值、资格限定及更长正文保留阅读全文，不做模糊合并', () => {
  for (const translation of ['额度提高至 30 次。', '额度提高至 20 次，仅限 Pro 用户。', '额度提高至 20 次。请在明天查看账户。']) {
    const data = fixture({ translation });
    assert.equal(publicArticleContent(data.articles[0]).hasAdditionalContent, true);
    for (const html of [renderArticle(data), renderEvent(data)]) {
      assert.match(html, /中文摘要/);
      assert.match(html, /<summary>阅读全文<\/summary>/);
      assert.ok(html.includes(translation));
    }
  }
});

test('来源折叠保留原文、真实出处与片段提示，隐藏内部辅助字段', () => {
  const data = fixture();
  data.publications[0].reason = '规则核验通过，自动发布';
  const before = JSON.stringify(data);
  for (const html of [renderArticle(data), renderEvent(data)]) {
    assert.match(html, /<summary><span>查看来源/);
    assert.match(html, /第三方收录/);
    assert.match(html, /Original text\./);
    assert.match(html, /href="https:\/\/example.com\/original"/);
    assert.match(html, /只收录了部分原文/);
    assert.doesNotMatch(html, /辅助归档|内部收录标题|内部辅助摘要|本站采集|附加标题|附加摘要|官方原文|记录信息|版本说明|规则核验通过|自动发布/);
  }
  const native = createRequire(import.meta.url)('../miniprogram/utils/model.js');
  const detail = native.resolveDetail(data, { publicationId: 'p' });
  assert.equal('reason' in detail, false);
  assert.equal(detail.evidence[0].text, evidence.text);
  assert.equal(detail.evidence[0].url, evidence.url);
  assert.equal(JSON.stringify(data), before);
});

test('同一原文相同正文同时间去重并优先官方，内容不同的来源保留', () => {
  const data = fixture();
  data.evidence[0].url = 'https://example.com/official';
  data.evidence.push({ ...evidence, id: 'official', provenance: 'official', contextComplete: true, textOrigin: 'original', url: 'https://example.com/official' });
  data.evidence.push({ ...evidence, id: 'different', text: 'A different claim.', url: 'https://example.com/different' });
  data.articles[0].evidenceIds.push('official', 'different');
  const html = renderArticle(data);
  assert.equal((html.match(/Original text\./g) || []).length, 1);
  assert.match(html, /href="https:\/\/example.com\/official"/);
  assert.match(html, /href="https:\/\/example.com\/different"/);
  assert.doesNotMatch(html, /href="https:\/\/example.com\/original"|相同内容的另外/);
  assert.match(html, /官方原文/);
  assert.match(html, /第三方收录/);
});

test('原文详情只呈现读者可理解的来源信息且不冒充官方', () => {
  const html = renderToStaticMarkup(createElement(EvidencePage, { data: fixture(), id: 'source' }));
  assert.match(html, /第三方收录/);
  assert.match(html, /收录内容/);
  assert.match(html, /Original text\./);
  assert.match(html, /打开原文/);
  assert.doesNotMatch(html, /辅助归档|来源结构化|本站采集|内部收录标题|内部辅助摘要|官方原文/);
});


test('网页、小程序卡片及公告海报使用相同客户摘要，内部处理说明不进入分享图',()=>{
  const require=createRequire(import.meta.url),native=require('../miniprogram/utils/model.js'),poster=require('../miniprogram/utils/poster.js');
  const data=fixture({summary:'根据公开归档保存的原帖，额度提高至 20 次。\n原文发布时间：2026/10/16 09:00（北京时间）。这是中文事实摘要，个人账户是否到账尚未观测。'}),p=data.publications[0],before=JSON.stringify(data);
  const summary=publicArticleContent(p.article).summary;
  assert.equal(native.publicationCard(data,p).summary,summary);assert.equal(poster.posterInput(data,p.id).summary,summary);
  const image=posterSvg(p,'测试雷达');assert.doesNotMatch(image,/根据公开归档保存的原帖|这是中文事实摘要/);assert.match(image,/额度提高至 20 次/);
  assert.equal(JSON.stringify(data),before);
  const manual=fixture({...data.articles[0],manualFields:['summary']});assert.equal(native.publicationCard(manual,manual.publications[0]).summary,manual.articles[0].summary);
});

test('既有模板的未知范围和重复到账说明统一整理，不改事实、时间或已保存版本',()=>{
  const native=createRequire(import.meta.url)('../miniprogram/utils/model.js');
  const data=fixture({summary:'重置卡公告称已完成，适用对象：适用范围未说明。发布者报告第 2/2 批重置卡已发放，本系列发放已结束；个人到账以账户显示为准。 实际到账以账户显示为准。'});
  const before=structuredClone(data),summary=publicArticleSummary(data.articles[0]);
  assert.equal(native.publicationCard(data,data.publications[0]).summary,summary);
  assert.doesNotMatch(summary,/适用对象：适用范围未说明|个人到账/);
  assert.match(summary,/第 2\/2 批/);assert.match(summary,/适用范围以原文为准/);
  assert.equal(summary.match(/实际到账以账户显示为准/g)?.length,1);
  const archive=fixture({title:'公开归档收录重置相关动态',summary:'公开归档收录消息：“公开归档已安排用量重置，预计最晚2026/10/25 15:00:00（北京时间）；原帖内容待核对。”。此条仅作消息记录，福利类型、资格或对应轮次尚待确认。'});
  const card=native.publicationCard(archive,archive.publications[0]);
  assert.equal(card.title,'重置相关消息');assert.equal(card.title,publicArticleTitle(archive.articles[0]));
  assert.equal(card.summary,publicArticleSummary(archive.articles[0]));
  assert.match(card.summary,/预计最晚2026\/10\/25 15:00:00（北京时间）/);assert.match(card.summary,/发放情况待确认/);
  assert.doesNotMatch(card.summary,/公开归档|原帖内容待核对|福利类型、资格或对应轮次/);
  for(const html of [renderArticle(archive),renderEvent(archive)])assert.doesNotMatch(html,/公开归档收录重置相关动态/);
  const poster=createRequire(import.meta.url)('../miniprogram/utils/poster.js').posterInput(archive,'p');
  assert.equal(poster.title,card.title);assert.equal(poster.summary,card.summary);
  assert.deepEqual(data,before);
});

test('待确认的旧消息保持待确认，手工修改的标题摘要与原文保持原样',()=>{
  const native=createRequire(import.meta.url)('../miniprogram/utils/model.js');
  const data=fixture({reviewStatus:'pending',summary:'已保存公开来源消息。保存的正文为摘要或存在截断，等待完整原文。此条不计入已重置、已发卡或预测准确率；请查看原文依据。'});
  assert.equal(publicArticleSummary(data.articles[0]),'这条消息提及重置，具体安排和完成情况待确认。');
  assert.equal(native.publicationCard(data,data.publications[0]).summary,publicArticleSummary(data.articles[0]));
  assert.equal(data.articles[0].reviewStatus,'pending');
  for(const [note,expected] of [['原文最晚期限：北京时间','预计为最晚时间，以实际发放为准。'],['原文预计时刻：并非最晚截止；北京时间','预计时间仅供参考，以实际发放为准。']]){
    const item={...article,summary:`预计时间：2026/10/24 02:00:00（北京时间）。${note} 实际到账以账户显示为准。`};
    assert.match(publicArticleSummary(item),/2026\/10\/24 02:00:00（北京时间）/);assert.ok(publicArticleSummary(item).includes(expected));
    assert.equal(native.publicArticleSummary(item),publicArticleSummary(item));
  }
  for(const contentOrigin of ['generated',undefined] as const){const item={...data.articles[0],contentOrigin,title:'公开归档收录重置相关动态'};assert.equal(publicArticleSummary(item),item.summary);assert.equal(publicArticleTitle(item),item.title);}
  const item:Article={...data.articles[0],title:'公开归档收录重置相关动态',manualFields:['summary','title']};
  assert.equal(publicArticleSummary(item),item.summary);assert.equal(publicArticleTitle(item),item.title);
  assert.equal(native.publicArticleSummary(item),item.summary);assert.equal(native.publicArticleTitle(item),item.title);
  assert.equal(data.evidence[0].text,evidence.text);
});
