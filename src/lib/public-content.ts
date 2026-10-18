import type { Article, BenefitAction, Notice, Publication } from './types';

/** Remove known template process copy only; never rewrite manually edited summaries or evidence. */
export function publicArticleSummary(article: Article): string {
  if (article.contentOrigin !== 'template' || article.manualFields?.includes('summary')) return article.summary;
  return article.summary
    .replace(/^AIPlanWatch 将对应原帖记录为公共额度重置；原帖仅为简短完成表达，福利类型采用参考项目分类，未虚构回复关系。/, 'AIPlanWatch 已收录本次额度重置完成消息。')
    .replace(/原文承诺日终前完成，预计最晚时间已换算为北京时间（UTC\+8）；(?:按原文PST字面UTC-8换算，未自行改用当地夏令时；)?这是公告预计时间，仍待实际确认。/g, '预计时间仅供参考，以实际发放为准。')
    .replace(/（依据 AIPlanWatch 分类，适用套餐以原公告为准）/g, '（适用套餐暂未明确）')
    .replace(/(?:原文近似时间：约略预计时刻，并非最晚截止，未给出误差范围；|原文预计时刻：并非最晚截止；)?按原文(?:PST|PDT)字面UTC-(?:7|8)换算，未自行改用当地夏令时；这是公告预计时间，仍待实际确认。/g, '预计时间仅供参考，以实际发放为准。')
    .replace(/原文预计时间：[^\n]*?；日期、精度或时区尚不明确，未生成精确截止。/g, '具体发放时间暂未明确。')
    .replace(/已换算为北京时间（UTC\+8）/g, '北京时间')
    .replace(/^已保存公开来源消息。活动简写已收录；套餐资格和具体发放安排仍需后续声明核对。此条不计入已重置、已发卡或预测准确率；请查看原文依据。$/, '发布方提及后续活动，具体安排仍待明确。')
    .replace('已保存发布说明；完整中文改动会在智能服务可用后自动补充。', '更新细节请查看官方发布说明。')
    .replace(/^公开归档收录(?:产品动态|消息)：[“「]([\s\S]*?)[”」]。此条仅作(?:产品)?消息记录，完整细节请查看原文。$/, '$1')
    .replace(/根据(?:公开归档保存的原帖|公开原文)，/g, '')
    .replace(/\s*原文发布时间：[^。\n]*。这是中文事实摘要，/g, ' ')
    .trim();
}

/** Uncertain evidence stays uncertain, without publishing reviewer work notes. */
export function publicReviewMessage(article: Pick<Article, 'reviewStatus'>): string {
  return article.reviewStatus === 'pending' ? '这条消息尚不能确认重置或发卡，请等待后续公告。'
    : article.reviewStatus === 'targeted_update' ? '仅涉及部分账户，具体适用范围请查看原文。' : '';
}
export function publicSourceNotes(article: Article, actions: BenefitAction[] = []): string[] {
  const reference = article.summary.match(/^AIPlanWatch 将对应原帖记录为公共额度重置；[^。]*。/)?.[0];
  return [...new Set([...(reference ? [reference] : []), ...(article.reviewReasons ?? []), ...actions.map(action => action.timeNote).filter((note): note is string => !!note)])];
}
export function publicEligibility(action: BenefitAction): string {
  return action.eligibility.replace(/^公开额度重置（依据 AIPlanWatch 分类，适用套餐以原公告为准）$/, '暂未明确').trim() || '暂未明确';
}

/** Use the notice's own text and frozen publication metadata; admin messages stay verbatim. */
export function publicNoticeSummary(notice: Notice, publications: Publication[] = []): string {
  const publication = publications.find(p => p.id === notice.publicationId);
  return notice.origin === 'admin' || !publication ? notice.summary : publicArticleSummary({...publication.article, summary:notice.summary});
}
