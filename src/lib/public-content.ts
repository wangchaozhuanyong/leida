import type { Article } from './types';

/** Remove known template process copy only; never rewrite manually edited summaries or evidence. */
export function publicArticleSummary(article: Article): string {
  if (article.contentOrigin !== 'template' || article.manualFields?.includes('summary')) return article.summary;
  return article.summary
    .replace('已保存发布说明；完整中文改动会在智能服务可用后自动补充。', '更新细节请查看官方发布说明。')
    .replace(/^公开归档收录(?:产品动态|消息)：[“「]([\s\S]*?)[”」]。此条仅作(?:产品)?消息记录，完整细节请查看原文。$/, '$1')
    .replace(/^根据(?:公开归档保存的原帖|公开原文)，/, '')
    .replace(/\s*原文发布时间：[^。\n]*。这是中文事实摘要，/g, ' ')
    .trim();
}
