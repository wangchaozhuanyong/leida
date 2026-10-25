/** @typedef {import('../../src/lib/types').PublicData} PublicData */
/** @typedef {import('../../src/lib/types').Publication} Publication */
/** @typedef {import('../../src/lib/types').BenefitAction} BenefitAction */
/** @typedef {import('../../src/lib/types').Article} Article */
/** @typedef {import('../../src/lib/types').RadarEvent} RadarEvent */
const {publicNewsGroups, homeNewsGroups} = require('./public-feed');
const {uniqueDisplayEvidence} = require('./evidence-display');
const {resetObservations,observedEvidence}=require('./reset-observations');
const dayMs = 86400000;
const actionLabels = { automatic_reset: '用量重置', banked_reset: '重置卡' };
const preferenceDefaults = { announcement: true, result: true, activity: false, correction: true };
const validTime = value => !!value && Number.isFinite(Date.parse(value));
function referenceCadenceView(value,now) {
 if(!value||value.modelVersion!=='conditional-empirical-global-20261018-1'||value.status!=='ready'||!validTime(value.generatedAt)||!validTime(value.validUntil)||Date.parse(value.generatedAt)>Date.parse(now)||Date.parse(value.validUntil)<=Date.parse(now)||value.sampleCount<20||value.comparableCount<10||!Array.isArray(value.horizons)||value.horizons.length!==3||!value.horizons.every((p,i)=>p.hours===[24,48,72][i]&&typeof p.probability==='number'&&Number.isFinite(p.probability)&&p.probability>=0&&p.probability<=1&&(i===0||p.probability>=value.horizons[i-1].probability)))return null;
 return value.horizons.map(p=>({hours:p.hours,label:Math.round(p.probability*100)+'%'}));
}
function sourceStatus(sources) {
  const automated=sources.filter(s=>s.id!=='manual');
  if(!automated.length)return {label:'自动更新暂未启用',warning:true};
  if(automated.every(s=>s.status==='paused'))return {label:'自动更新已暂停',warning:true};
  const active=automated.filter(s=>s.status!=='paused');
  if(active.every(s=>s.status==='unconnected'))return {label:'等待首次更新',warning:true};
  if(active.some(s=>['failed','delayed','unconnected'].includes(s.status)))return {label:'部分消息更新延迟',warning:true};
  if(active.every(s=>s.status==='healthy'&&validTime(s.lastSuccessAt)))return {label:'自动检查公开消息',warning:false};
  return {label:'等待首次更新',warning:true};
}
// 微信设备未必具备完整 Intl 时区实现。北京时间使用 UTC+8，不依赖设备时区。
function dateKey(value) {
  const date = new Date(new Date(value).getTime() + 8 * 3600000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}
function displayTime(value) {
  if (!validTime(value)) return '暂无记录';
  const valueInZone = new Date(Date.parse(value) + 8 * 3600000).toISOString();
  return `${valueInZone.slice(0, 10)} ${valueInZone.slice(11, 16)}`;
}
function elapsed(value, now) {
  if (!validTime(value) || !validTime(now)) return '暂无记录';
  const minutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(value)) / 60000));
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes}分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)}小时前` : `${Math.floor(minutes / 1440)}天前`;
}
function completionTime(value) {
  return validTime(value) ? displayTime(value).replace(/-/g, '/') : '暂无记录';
}
/** Each completed round remains visible even when its benefit kind repeats. */
function completedBenefits(data) {
  const now = Date.parse(data.serverTime);
  if (!Number.isFinite(now)) return [];
  return publicActions(data).filter(({ action, publication }) => action.stage === 'claimed_complete'
    && validTime(action.statementAt) && Date.parse(action.statementAt) <= now
    && validTime(publication.publishedAt) && Date.parse(publication.publishedAt) <= now)
    .sort((a, b) => Date.parse(b.action.statementAt) - Date.parse(a.action.statementAt) || a.action.id.localeCompare(b.action.id));
}
function recentCompletedBenefits(data) { return completedBenefits(data).slice(0,5); }
/** Per-kind latest state remains useful for posters and current announcement selection. */
function latestCompletedBenefits(data) {
  const seen=new Set();
  return completedBenefits(data)
    .filter(({ action }) => { if (seen.has(action.kind)) return false; seen.add(action.kind); return true; });
}
/** Elapsed public completion time has no expiry; it is not an account balance. */
function completionElapsed(action, now) {
  if (action?.stage !== 'claimed_complete') return undefined;
  const age = Date.parse(now) - Date.parse(action.statementAt);
  if (!Number.isFinite(age) || age < 0) return undefined;
  const seconds = Math.floor(age / 1000), days = Math.floor(seconds / 86400);
  const parts = [...(days ? [{value: days, unit: '天'}] : []),
    {value: Math.floor(seconds % 86400 / 3600), unit: '小时'},
    {value: Math.floor(seconds % 3600 / 60), unit: '分钟'}, {value: seconds % 60, unit: '秒'}];
  return { parts, label: parts.map(part => `${part.value}${part.unit}`).join(''),
    lead: action.kind === 'banked_reset' ? '距最近一次确认发放重置卡' : '距最近一次确认重置' };
}
/** @param {Article} article */
const articleSourceTime = article => article.sourcePublishedAt ?? article.publishedAt;
/** @param {Article[]} articles */
const sortedArticles = articles => articles.slice().sort((a, b) => Date.parse(articleSourceTime(b)) - Date.parse(articleSourceTime(a)));
/** @param {Publication} publication */
const isNewsOnly = publication => publication.mode === 'news_only' || publication.article.publicationMode === 'news_only';
/** @param {PublicData} data @param {RadarEvent} event */
const currentPublication = (data, event) => data.publications.find(item => item.id === event.publicationId);
/** @param {PublicData} data @param {RadarEvent} event */
function statePublication(data, event) {
  const current = currentPublication(data, event);
  if (current && !isNewsOnly(current)) return current;
  return data.publications.filter(item => item.eventId === event.id && !isNewsOnly(item)).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
}
/** @param {Publication} publication */
function publicationSourceTime(publication) {
  if (isNewsOnly(publication)) return articleSourceTime(publication.article);
  const times = [publication.article.sourcePublishedAt, ...publication.event.actions.map(action => action.statementAt)].filter(validTime);
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || publication.article.publishedAt;
}
function comparePublications(a, b) {
  return Date.parse(publicationSourceTime(b)) - Date.parse(publicationSourceTime(a)) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id);
}
/** @param {PublicData} data */
const sortedPublications = data => data.events.filter(item => item.status !== 'merged').map(item => currentPublication(data, item)).filter(Boolean).sort(comparePublications);
/** @param {PublicData} data */
const sortedStatePublications = data => {const observed=new Set(resetObservations(data).map(o=>o.publicationId));return data.events.filter(item=>item.status!=='merged').map(item=>data.publications.find(p=>p.id===item.publicationId&&(observed.has(p.id)||!isNewsOnly(p)))||data.publications.filter(p=>p.eventId===item.id&&(observed.has(p.id)||!isNewsOnly(p))).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0]).filter(Boolean).sort(comparePublications);};
/** @param {PublicData} data */
function publicActions(data) {
  const seen = new Set();
  return data.events.filter(event => event.status === 'published').flatMap(event => {
    const publication = statePublication(data, event);
    if (!publication || publicationWithdrawn(data, publication)) return [];
    return publication.event.actions.filter(action => {
      if (action.scope !== 'public' || seen.has(action.id)) return false;
      seen.add(action.id); return true;
    }).map(action => ({ action, event: publication.event, publication }));
  });
}
/** @param {Article} article @param {import('../../src/lib/types').Evidence[]} evidence */
function isHistoricalArticle(article, evidence) {
  if (article.historical) return true;
  const cited = evidence.filter(item => article.evidenceIds.includes(item.id));
  const first = Date.parse(article.publishedAt);
  if (cited.length && cited.length === new Set(article.evidenceIds).size) return cited.every(item => {
    const published = Date.parse(item.publishedAt), collected = Date.parse(item.collectedAt);
    return item.historical || !Number.isFinite(published) || !Number.isFinite(collected) || collected - published > dayMs || !Number.isFinite(first) || first - published > dayMs;
  });
  const source = Date.parse(article.sourcePublishedAt || '');
  return Number.isFinite(source) && Number.isFinite(first) && first - source > dayMs;
}
/** @param {PublicData} data @param {string} [currentTime] */
function upcomingActions(data, currentTime) {
  const now = Date.parse(currentTime === undefined ? data && data.serverTime : currentTime);
  if (!Number.isFinite(now)) return [];
  return publicActions(data).filter(item => ['promised', 'in_progress'].includes(item.action.stage) && validTime(item.action.statementAt) && Date.parse(item.action.statementAt) <= now && validTime(item.publication.publishedAt) && Date.parse(item.publication.publishedAt) <= now)
    .filter(item => !isHistoricalArticle(item.publication.article, data.evidence) || (item.action.expectedAt && Date.parse(item.action.expectedAt) > now)).sort((a, b) => Date.parse(b.action.statementAt) - Date.parse(a.action.statementAt));
}
/** Preserve the source's approximate point, scheduled point or deadline; expiry never claims completion. */
function announcementCountdown(action, now) {
  if (!action || !['promised', 'in_progress'].includes(action.stage)) return { status: 'inactive', label: '等待下一次预告' };
  if (!validTime(action.expectedAt) || !validTime(now)) return { status: 'unknown', label: '时间待明确' };
  const minutes = Math.ceil((Date.parse(action.expectedAt) - Date.parse(now)) / 60000);
  if (minutes <= 0) return { status: 'expired', label: '已过预计时间 · 等待确认' };
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), remainder = minutes % 60;
  const duration = `${days ? `${days}天` : ''}${hours ? `${hours}小时` : ''}${remainder ? `${remainder}分钟` : ''}`;
  const approximate = /^原文近似时间/.test(action.timeNote || ''), point = /^原文预计时刻/.test(action.timeNote || '');
  return { status: 'upcoming', label: approximate ? `约${duration}后` : point ? `预计${duration}后` : `预计${duration}内` };
}
function validOutlookAction(value) {
  return !!value && ['actionId', 'eventId', 'publicationId'].every(key => typeof value[key] === 'string' && !!value[key])
    && ['automatic_reset', 'banked_reset'].includes(value.kind) && ['promised', 'in_progress', 'claimed_complete', 'cancelled'].includes(value.stage)
    && validTime(value.statementAt) && (value.expectedAt === undefined || validTime(value.expectedAt)) && (value.timeNote === undefined || typeof value.timeNote === 'string');
}
function outlookAction(item, data) {
  const previous = data?.publications.filter(p=>p.eventId===item.event.id && p.id!==item.publication.id && !isNewsOnly(p) && Date.parse(p.publishedAt)<Date.parse(item.publication.publishedAt)).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)).flatMap(p=>p.event.actions.filter(a=>a.id===item.action.id&&a.kind===item.action.kind&&a.scope==='public'&&['promised','in_progress'].includes(a.stage)&&validTime(a.expectedAt)))[0];
  return { actionId: item.action.id, eventId: item.event.id, publicationId: item.publication.id, kind: item.action.kind, stage: item.action.stage, statementAt: item.action.statementAt,
    ...(previous?.expectedAt && item.action.expectedAt && Date.parse(previous.expectedAt)!==Date.parse(item.action.expectedAt) ? {previousExpectedAt:previous.expectedAt} : {}),
    ...(validTime(item.action.expectedAt) ? { expectedAt: item.action.expectedAt } : {}), ...(item.action.timeNote ? { timeNote: item.action.timeNote } : {}) };
}
function activeOutlookStatus(action, now) {
  const countdown = announcementCountdown(action, now);
  return countdown.status === 'expired' ? 'overdue' : action.stage === 'in_progress' ? 'in_progress' : countdown.status === 'upcoming' ? 'scheduled' : 'announced';
}
/** The server projection is authoritative; historical experiments never drive the next deadline. */
function resetOutlookModel(data, kind) {
  const empty = { status: 'monitoring', active: null, latestCompletion: null, lastResolved: null };
  if (!data || !validTime(data.serverTime)) return empty;
  // Rebuild observations from published evidence; an unchecked server projection
  // must not turn an arbitrary timestamp into a reset observation.
  const latestObservation = resetObservations(data).find(item => !kind || item.kind === kind);
  const observation = latestObservation ? { latestObservation } : {};
  const supplied = kind ? data.forecasts?.outlook?.byKind?.[kind] : data.forecasts && data.forecasts.outlook;
  if (supplied !== undefined) {
    if (!supplied || !['scheduled', 'announced', 'in_progress', 'overdue', 'completed', 'cancelled', 'monitoring'].includes(supplied.status)) return empty;
    const matchesKind=value=>!kind||value?.kind===kind;
    const latestCompletion = matchesKind(supplied.latestCompletion) && validOutlookAction(supplied.latestCompletion) && supplied.latestCompletion.stage === 'claimed_complete' ? supplied.latestCompletion : null;
    const lastResolved = matchesKind(supplied.lastResolved) && validOutlookAction(supplied.lastResolved) && ['claimed_complete', 'cancelled'].includes(supplied.lastResolved.stage) && validTime(supplied.lastResolved.resolvedAt) ? supplied.lastResolved : null;
    const active = ['scheduled', 'announced', 'in_progress', 'overdue'].includes(supplied.status) && matchesKind(supplied.active) && validOutlookAction(supplied.active) && ['promised', 'in_progress'].includes(supplied.active.stage) ? supplied.active : null;
    return { status: active ? activeOutlookStatus(active, data.serverTime) : ['completed', 'cancelled'].includes(supplied.status) ? supplied.status : 'monitoring', active, latestCompletion, lastResolved, ...observation,
      ...(supplied.latestResolutions?{latestResolutions:Object.fromEntries(['automatic_reset','banked_reset'].filter(kind=>validOutlookAction(supplied.latestResolutions[kind])&&['claimed_complete','cancelled'].includes(supplied.latestResolutions[kind].stage)).map(kind=>[kind,supplied.latestResolutions[kind]]))}:{}),
      ...(Array.isArray(supplied.pendingReview)?{pendingReview:supplied.pendingReview.filter(validOutlookAction)}:{}),
      ...(validTime(supplied.latestGlobalCompletionAt)?{latestGlobalCompletionAt:supplied.latestGlobalCompletionAt}:{}),evidenceCutoffAt: validTime(supplied.evidenceCutoffAt) ? supplied.evidenceCutoffAt : undefined };
  }
  // Old API versions can still display published announcements, never cadence or cases.
  const now = Date.parse(data.serverTime), actions = publicActions(data).filter(item=>!kind||item.action.kind===kind);
  const facts = actions.filter(item => validTime(item.action.statementAt) && Date.parse(item.action.statementAt) <= now && validTime(item.publication.publishedAt) && Date.parse(item.publication.publishedAt) <= now).sort((a, b) => Date.parse(b.action.statementAt) - Date.parse(a.action.statementAt));
  const completed = facts.find(item => item.action.stage === 'claimed_complete');
  const resolved = facts.find(item => ['claimed_complete', 'cancelled'].includes(item.action.stage));
  const globalCompleted=facts.find(item=>item.action.kind==='automatic_reset'&&item.action.stage==='claimed_complete');
  const latestResolutions={};
  facts.filter(item=>['claimed_complete','cancelled'].includes(item.action.stage)).forEach(item=>{latestResolutions[item.action.kind]??={...outlookAction(item),resolvedAt:item.action.statementAt};});
  const pendingAll=upcomingActions(data).filter(item=>!kind||item.action.kind===kind),needsReview=item=>!!latestResolutions[item.action.kind]&&Date.parse(latestResolutions[item.action.kind].statementAt)>Date.parse(item.action.statementAt);
  const pendingReview=pendingAll.filter(needsReview).map(item=>outlookAction(item,data)),pending=pendingAll.find(item=>!needsReview(item)&&(!resolved||Date.parse(item.action.statementAt)>=Date.parse(resolved.action.statementAt)||Date.parse(item.action.expectedAt||'')>=Date.parse(resolved.action.statementAt)));
  return { ...empty,...observation,...(Object.keys(latestResolutions).length?{latestResolutions}:{}),...(pendingReview.length?{pendingReview}:{}),...(globalCompleted?{latestGlobalCompletionAt:globalCompleted.action.statementAt}:{}), status: pending ? activeOutlookStatus(pending.action, data.serverTime) : resolved ? resolved.action.stage === 'claimed_complete' ? 'completed' : 'cancelled' : 'monitoring', active: pending ? outlookAction(pending, data) : null, latestCompletion: completed ? outlookAction(completed) : null, lastResolved: resolved ? { ...outlookAction(resolved), resolvedAt: resolved.action.statementAt } : null };
}
/** @param {BenefitAction} action @param {string} now */
const stageText = (action, now) => ['promised', 'in_progress'].includes(action.stage) && announcementCountdown(action, now).status === 'expired' ? '已过预计时间 · 等待确认' : ({ promised: '发放预告', in_progress: '进行中', claimed_complete: '公告称已完成', cancelled: '已取消' }[action.stage]);
function calendarDays(now) {
  const end = new Date(`${dateKey(now)}T12:00:00+08:00`);
  const monday = (end.getUTCDay() + 6) % 7;
  const start = end.getTime() - (25 * 7 + monday) * dayMs;
  return Array.from({ length: 182 }, (_, index) => dateKey(start + index * dayMs));
}
function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(url) && !/[\u0000-\u0020]/.test(url) ? url : undefined;
}
/** @param {PublicData} data @param {Publication} publication */
function publicationWithdrawn(data, publication) {
  return data.events.some(event => event.id === publication.eventId && event.status === 'withdrawn') || data.articles.some(article => article.id === publication.articleId && article.status === 'withdrawn') || publication.event.status === 'withdrawn' || publication.article.status === 'withdrawn';
}
/** @param {Publication} publication */
function sharePath(publication) {
  return `/pages/detail/index?publicationId=${encodeURIComponent(publication.id)}`;
}
/** @param {PublicData} data @param {Publication} publication */
function publicationCard(data, publication) {
  const actions = isNewsOnly(publication) ? [] : publication.event.actions;
  const withdrawn = publicationWithdrawn(data, publication);
  const kinds = [...new Set(actions.map(action => actionLabels[action.kind]))].join('＋');
  return {
    id: publication.id, path: sharePath(publication), title: publication.article.title, summary: publicArticleSummary(publication.article), reviewStatus: publication.article.reviewStatus || '', reviewReasons: publicReviewMessage(publication.article),
    time: displayTime(publicationSourceTime(publication)), historical: isHistoricalArticle(publication.article, data.evidence),
    label: withdrawn ? '已撤回' : isNewsOnly(publication) ? '来源消息' : kinds || (publication.article.category === 'activity' ? '活动动态' : '产品更新'),
    note: withdrawn ? '已撤回，不能作为当前发放依据' : isNewsOnly(publication) ? '具体安排以发布方公告为准' : '公开公告',
    tone: withdrawn ? 'muted' : actions.some(action => action.kind === 'banked_reset') ? 'purple' : 'cyan', withdrawn
  };
}
/** @param {PublicData} data @param {string} [selected] */
function calendarModel(data, selected) {
  const days = calendarDays(data.serverTime), byDate = new Map();
  const actions = publicActions(data).filter(item => ['claimed_complete', 'in_progress'].includes(item.action.stage) && dateKey(item.action.statementAt) >= days[0] && dateKey(item.action.statementAt) <= dateKey(data.serverTime));
  actions.forEach(item => { const key = dateKey(item.action.statementAt); byDate.set(key, [...(byDate.get(key) || []), item]); });
  const dayModels = days.map(value => {
    const items = byDate.get(value) || [], done = items.filter(item => item.action.stage === 'claimed_complete');
    const reset = done.some(item => item.action.kind === 'automatic_reset'), card = done.some(item => item.action.kind === 'banked_reset');
    return { date: value, day: Number(value.slice(8)), selected: value === selected, future: value > dateKey(data.serverTime), tone: reset && card ? 'both' : reset ? 'cyan' : card ? 'purple' : items.length ? 'pending' : '', count: done.length, ongoing: items.length - done.length };
  });
  const weeks = Array.from({ length: 26 }, (_, index) => ({ id: `week-${index}`, month: `${Number(days[index * 7].slice(5, 7))}月`, days: dayModels.slice(index * 7, (index + 1) * 7) }));
  const selectedItems = (byDate.get(selected) || []).map(item => ({ id: item.action.id, label: actionLabels[item.action.kind], stage: stageText(item.action, data.serverTime), path: sharePath(item.publication), tone: item.action.kind === 'banked_reset' ? 'purple' : 'cyan' }));
  return { weeks, recentDays: dayModels.filter(item => !item.future).slice(-7), selected, selectedItems, completedCount: actions.filter(item => item.action.stage === 'claimed_complete').length };
}
/** @param {PublicData} data @param {typeof preferenceDefaults} preferences @param {string[]} read */
function noticeModel(data, preferences, read) {
  return data.notices.filter(notice => notice.status === 'active' && (notice.origin === 'admin' || notice.categories.some(category => ['announcement','result','correction'].includes(category)))).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(notice => ({ ...notice, summary:publicNoticeSummary(notice, data.publications), time: displayTime(notice.createdAt), read: read.includes(notice.id), path: data.publications.some(item => item.id === notice.publicationId) ? `/pages/detail/index?publicationId=${encodeURIComponent(notice.publicationId)}` : '', missing: notice.origin !== 'admin' && !data.publications.some(item => item.id === notice.publicationId) }));
}
/** Public reading copy; ingestion metadata remains unchanged in the stored article. */
function publicArticleSummary(article) {
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
function publicReviewMessage(article) {
  return article.reviewStatus === 'pending' ? '这条消息尚不能确认重置或发卡，请等待后续公告。'
    : article.reviewStatus === 'targeted_update' ? '仅涉及部分账户，具体适用范围请查看原文。' : '';
}
function publicSourceNotes(article, actions = []) {
  const reference = article.summary.match(/^AIPlanWatch 将对应原帖记录为公共额度重置；[^。]*。/)?.[0];
  return [...new Set([...(reference ? [reference] : []), ...(article.reviewReasons ?? []), ...actions.map(action => action.timeNote).filter(note => !!note)])];
}
function publicEligibility(action) {
  return action.eligibility.replace(/^公开额度重置（依据 AIPlanWatch 分类，适用套餐以原公告为准）$/, '暂未明确').trim() || '暂未明确';
}
function publicNoticeSummary(notice, publications = []) {
  const publication = publications.find(p => p.id === notice.publicationId);
  return notice.origin === 'admin' || !publication ? notice.summary : publicArticleSummary({...publication.article, summary:notice.summary});
}
function publicArticleContent(article) {
  const translation = article.translation?.trim() || '', summary = publicArticleSummary(article).trim() || translation;
  const normalized = value => value.replace(/[\s\u200b\ufeff]+/g, '');
  const hasAdditionalContent = !!translation && normalized(translation) !== normalized(summary) && normalized(translation) !== normalized(article.summary);
  return { summary, body: translation || summary, hasAdditionalContent };
}
/** @param {PublicData} data @param {{publicationId?:string}} query */
function resolveDetail(data, query) {
  const publication = data.publications.find(item => item.id === query.publicationId);
  if (!publication) return { missing: true, title: '未找到指定发布版本', explanation: '这条记录可能尚未发布，请返回查看公开公告。' };
  const currentEvent = data.events.find(item => item.id === publication.eventId);
  const currentArticle = data.articles.find(item => item.id === publication.articleId);
  if (!currentEvent || !currentArticle) return { missing: true, title: '关联记录暂时缺失', explanation: '保留指定版本入口，稍后重新加载。' };
  const withdrawn = publicationWithdrawn(data, publication), merged = currentEvent.status === 'merged';
  const targetEvent = merged && data.events.find(item => item.id === currentEvent.mergedInto);
  const targetPublication = targetEvent && currentPublication(data, targetEvent);
  const newsOnly = isNewsOnly(publication);
  const isOld = (newsOnly ? currentArticle.publicationId : currentEvent.publicationId) !== publication.id;
  const current = newsOnly ? data.publications.find(item => item.id === currentArticle.publicationId) : currentPublication(data, currentEvent);
  const observationKeys=p=>p&&isNewsOnly(p)?[...new Set(data.evidence.filter(e=>p.article.evidenceIds.includes(e.id)).map(e=>observedEvidence(e,data.serverTime)).filter(Boolean).map(o=>o.kind+':'+o.observedAt))].sort():[];
  const oldObservations=observationKeys(publication),newObservations=observationKeys(current);
  const observationSourceUpdate=!!(isOld&&!withdrawn&&!merged&&current&&current.articleId===publication.articleId&&current.eventId===publication.eventId&&oldObservations.length&&JSON.stringify(oldObservations)===JSON.stringify(newObservations));
  const ids = new Set([...(isNewsOnly(publication) ? publication.article.evidenceIds : publication.event.evidenceIds), ...(publication.article.contextEvidenceIds || [])]);
  const evidence = uniqueDisplayEvidence(data.evidence.filter(item => ids.has(item.id))
    .sort((a,b) => Number(b.provenance === 'official') - Number(a.provenance === 'official')));
  return {
    missing: false, publicationId: publication.id, title: publication.article.title, ...publicArticleContent(publication.article), reviewStatus: publication.article.reviewStatus || '', reviewReasons: publicReviewMessage(publication.article),
    time: displayTime(articleSourceTime(publication.article)),
    historical: isHistoricalArticle(publication.article, data.evidence), newsOnly, withdrawn, merged, isOld, observationSourceUpdate,
    version: newsOnly ? publication.article.version : publication.event.version, cutoff: displayTime(publication.cutoffAt), publishedAt: displayTime(publication.publishedAt),
    canShare: !withdrawn && !merged, mergePath: targetPublication ? sharePath(targetPublication) : '', latestPath: !merged && isOld && current ? sharePath(current) : '',
    actions: newsOnly ? [] : publication.event.actions.map(action => ({ id: action.id, label: actionLabels[action.kind], stage: stageText(action, isOld || merged ? publication.cutoffAt : data.serverTime), eligibility: publicEligibility(action), scope: { public: '普发', targeted: '定向', private: '私人' }[action.scope], expectedAt: action.expectedAt ? displayTime(action.expectedAt) : '暂未明确', quote: action.evidenceQuote || '' })),
    sourceNotes: publicSourceNotes(publication.article, newsOnly ? [] : publication.event.actions),
    updates: (publicNewsGroups(data).find(group=>group.updates.some(p=>p.id===publication.id))?.updates || []).filter(p=>p.id!==publication.id).map(p=>({id:p.id,title:p.article.title,time:displayTime(publicationSourceTime(p)),path:sharePath(p)})),
    evidence: evidence.map(item => {
      const observation=observedEvidence(item,item.collectedAt);
      return {id:item.id,name:observation?.sourceName||(data.sources.find(source=>source.id===item.sourceId)?.name||'原文记录').replace('（辅助来源）','').replace('（免费）',''),label:observation?'来源观测':{official:'官方原文',archive:'第三方收录',manual:'补充来源'}[item.provenance],text:item.text,origin:observation?'来源记录了用量重置，个人到账尚未核验；观测时间与原帖发布时间分别保留。':item.textOrigin==='archive_excerpt'?'仅收录原文片段':item.textOrigin==='structured'?'来源摘要':'',complete:item.contextComplete,observed:!!observation,time:displayTime(item.publishedAt),url:observation?.sourceUrl||safeUrl(item.url)||'',referenceUrl:observation?.referenceUrl||''};
    })
  };
}
/** Count calendar dates in the configured zone, without assuming every device has Intl. */
function activityDayNumber(activity, now) {
  if (!activity || !Number.isInteger(activity.days) || activity.days < 1 || activity.days > 366 || !/^\d{4}-\d{2}-\d{2}$/.test(activity.startsOn) || !validTime(now)) return undefined;
  const start = Date.parse(`${activity.startsOn}T00:00:00Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== activity.startsOn) return undefined;
  let localDate;
  if (activity.timezone === 'Asia/Shanghai') localDate = dateKey(now);
  else if (activity.timezone === 'UTC') localDate = new Date(now).toISOString().slice(0, 10);
  else { try { localDate = new Intl.DateTimeFormat('sv-SE', { timeZone: activity.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)); } catch (_) { return undefined; } }
  const day = Math.floor((Date.parse(`${localDate}T00:00:00Z`) - start) / dayMs) + 1;
  return Number.isFinite(day) ? day : undefined;
}
function activityHomeVisible(activity, now) {
  const day = activityDayNumber(activity, now);
  return activity.showOnHome !== false && day !== undefined && day <= activity.days + 3;
}
/** @param {PublicData} data @param {string} id @param {number|null} [day] */
function activityModel(data, id, day) {
  const activity = data.activities.find(item => item.id === id);
  if (!activity) return { missing: true };
  const actualDay = activityDayNumber(activity, data.serverTime) ?? null;
  const selected = Math.max(1, Math.min(activity.days, Number(day) || (actualDay === null ? 1 : actualDay)));
  const source=data.sources.find(s=>s.id==='activity-archive');
  const sourceDelayed=!source||source.status!=='healthy';
  const byDay=new Map(), seen=new Set();
  for(const item of activity.items){
    const article=data.articles.find(a=>a.id===item.articleId&&a.eventId===item.eventId);
    const publication=article&&data.publications.find(p=>p.id===article.publicationId&&p.articleId===article.id&&p.eventId===item.eventId);
    if(!publication||seen.has(item.day+':'+article.id))continue;
    seen.add(item.day+':'+article.id);
    const evidence=data.evidence.filter(e=>publication.article.evidenceIds.includes(e.id));
    const actions=isNewsOnly(publication)?[]:publication.event.actions;
    const observed=evidence.some(e=>observedEvidence(e,data.serverTime));
    const primary=data.evidence.find(e=>e.id===publication.article.evidenceIds[0]);
    // Context proves a relationship, not another product update on this activity day.
    const types=[];
    if(observed||actions.some(a=>a.kind==='automatic_reset'))types.push({kind:'automatic_reset',label:'额度重置',tone:'teal'});
    if(actions.some(a=>a.kind==='banked_reset'))types.push({kind:'banked_reset',label:'重置卡',tone:'violet'});
    if(!types.length){
      if(article.category==='reset'||primary?.metadata?.category==='reset')types.push({kind:'reset_message',label:'重置消息',tone:'teal'});
      else if(article.category==='product'||primary?.metadata?.category==='product')types.push({kind:'improvement',label:'改进',tone:'blue'});
      else types.push({kind:'unknown',label:'活动动态',tone:'slate'});
    }
    const withdrawn=publicationWithdrawn(data,publication);
    const stages=[...new Set(actions.map(a=>a.stage==='claimed_complete'?'发布者完成声明':a.stage==='promised'?'已预告':a.stage==='in_progress'?'已宣布开始':a.stage==='cancelled'?'已取消':'待核对'))];
    const stage=withdrawn?'已撤回':observed?'来源观测':stages.join(' · ')|| (types.some(t=>t.kind==='reset_message')?'完成情况待核对':types.some(t=>t.kind==='improvement')?'公开产品消息':'公开活动消息');
    const entry={...publicationCard(data,publication),types,stage,sourceTime:Date.parse(publicationSourceTime(publication))||0};
    byDay.set(item.day,[...(byDay.get(item.day)||[]),entry]);
  }
  const recorded=new Set([...byDay].filter(([,entries])=>entries.some(e=>!e.withdrawn)).map(([day])=>day));
  const dateFor=value=>{const date=new Date(Date.parse(activity.startsOn+'T00:00:00Z')+(value-1)*86400000);return Number.isFinite(date.getTime())?`${date.getUTCMonth()+1}/${date.getUTCDate()}`:'';};
  const days=Array.from({length:activity.days},(_,index)=>{
    const value=index+1,entries=byDay.get(value)||[],types=[...new Map(entries.filter(e=>!e.withdrawn).flatMap(e=>e.types).map(t=>[t.kind,t])).values()];
    const future=actualDay!==null&&value>actualDay;
    const missing=activity.items.some(i=>i.day===value)&&!entries.length;
    const state=types.length?'recorded':future?'future':actualDay===value&&!sourceDelayed&&!missing?'waiting':'unverified';
    const label=types.length>1?'多项':types.length?types[0].kind==='automatic_reset'?'重置':types[0].label:state==='future'?'未开始':state==='waiting'?'待公布':'待核对';
    return {value,selected:selected===value,today:actualDay===value,recorded:recorded.has(value),date:dateFor(value),state,label,tone:types.length>1?'blue':types[0]?.tone||(state==='waiting'?'amber':'slate'),types,accessibility:`第${value}天，${dateFor(value)}，${types.length?types.map(t=>t.label).join('、'):label}`};
  });
  const entries=(byDay.get(selected)||[]).sort((a,b)=>a.sourceTime-b.sourceTime||a.id.localeCompare(b.id));
  const selectedState=days[selected-1].state;
  return { missing: false, id: activity.id, title: activity.title, rules: activity.rules, startsOn: activity.startsOn, timezone: activity.timezone === 'Asia/Shanghai' ? '北京时间' : activity.timezone === 'America/Los_Angeles' ? '美国西部时间' : '活动指定时区', selected,
    phase: actualDay === null ? '此设备暂不支持活动时区，请手动选日期' : actualDay < 1 ? '尚未开始' : actualDay > activity.days ? '活动已结束' : `第${actualDay}天 / 共${activity.days}天`,
    recordedDays: recorded.size,days,entries,selectedDate:dateFor(selected),sourceDelayed,lastSuccessAt:source?.lastSuccessAt?displayTime(source.lastSuccessAt):'',
    progress:actualDay===null?0:Math.max(0,Math.min(100,actualDay/activity.days*100)),
    emptyTitle:selectedState==='future'?'这一天尚未开始':selectedState==='waiting'?'等待当天公布':'当日资料待核对',
    emptyText:selectedState==='future'?'这一天尚未到来，有公开进展后更新。':selectedState==='waiting'?'暂未收录当天公开结果，收到有效消息后更新。':sourceDelayed?'来源更新延迟，暂不能判断当天是否已公布结果。':'暂无完整已收录进展，不代表活动没有发生。' };
}
const validProbability = value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const validInterval = value => value === null || Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1) && value[0] <= value[1];
const stringList = value => Array.isArray(value) && value.every(item => typeof item === 'string' && !!item);
function validEstimate(value) {
  return !!value && validProbability(value.p24) && validProbability(value.p48) && validInterval(value.interval24) && validInterval(value.interval48)
    && (value.p24 === null ? value.interval24 === null : value.interval24 !== null) && (value.p48 === null ? value.interval48 === null : value.interval48 !== null)
    && (value.p24 === null || value.p48 === null || value.p24 <= value.p48)
    && Array.isArray(value.counts) && value.counts.length === 3 && value.counts.every(item => Number.isSafeInteger(item) && item >= 0)
    && Number.isSafeInteger(value.sampleCount) && value.sampleCount === value.counts.reduce((sum, item) => sum + item, 0)
    && Array.isArray(value.prior) && value.prior.length === 3 && value.prior.every(item => typeof item === 'number' && Number.isFinite(item) && item > 0);
}
function validCoverage(value) { return !!value && ['unverified', 'gap', 'verified'].includes(value.status) && stringList(value.sourceIds) && typeof value.reason === 'string'; }
function validWindows(value, signalAt) {
  return !!value && validTime(signalAt) && validTime(value[24]) && validTime(value[48]) && Date.parse(value[24]) === Date.parse(signalAt) + 24 * 3600000 && Date.parse(value[48]) === Date.parse(signalAt) + 48 * 3600000;
}
function validForecastOutcome(value, item) {
  return !!value && typeof value.id === 'string' && !!value.id && value.caseId === item.id && value.target === item.target
    && ['promised', 'in_progress', 'claimed_complete', 'cancelled', 'unknown'].includes(value.stage) && stringList(value.evidenceIds)
    && validTime(value.observedAt) && (value.announcementAt === undefined || validTime(value.announcementAt))
    && ['explicit_source', 'causal_unique', 'unmatched'].includes(value.relation) && typeof value.relationVerified === 'boolean'
    && value.actualDelivery === 'unobserved' && typeof value.reason === 'string' && typeof value.signature === 'string'
    && (value.invalidated === undefined || typeof value.invalidated === 'boolean');
}
function validateForecastSnapshot(value) {
  return validEstimate(value) && typeof value.id === 'string' && !!value.id && typeof value.caseId === 'string' && !!value.caseId
    && typeof value.title === 'string' && !!value.title && !!safeUrl(value.url) && typeof value.sourceId === 'string' && !!value.sourceId
    && ['automatic_reset', 'banked_reset'].includes(value.target) && typeof value.signature === 'string' && !!value.signature
    && [value.signalAt, value.collectedAt, value.generatedAt, value.evidenceCutoffAt].every(validTime) && validWindows(value.windows, value.signalAt)
    && typeof value.ruleVersion === 'string' && typeof value.modelVersion === 'string' && stringList(value.trainingSampleIds) && stringList(value.referenceSampleIds)
    && ['experimental_seed', 'verified_live', 'insufficient', 'late', 'already_known'].includes(value.basis) && validCoverage(value.coverage)
    && typeof value.late === 'boolean' && !!value.lateWindows && typeof value.lateWindows[24] === 'boolean' && typeof value.lateWindows[48] === 'boolean'
    && typeof value.explanation === 'string' && value.trainingApplied === false && value.calibrated === false
    && (!['late', 'already_known'].includes(value.basis) || value.p24 === null && value.p48 === null)
    && (value.target !== 'banked_reset' || value.p24 === null && value.p48 === null);
}
function validateForecastPublicData(value) {
  if (!value || !['ready', 'unavailable'].includes(value.status) || typeof value.ruleVersion !== 'string' || typeof value.modelVersion !== 'string' || !validTime(value.generatedAt) || !Array.isArray(value.cases)) return false;
  if (value.watch !== undefined && !validateResetWatch(value.watch)) return false;
  const reference = value.reference;
  if (!validEstimate(reference) || !stringList(reference.sampleIds) || reference.coverage !== 'unverified' || reference.calibrated !== false || typeof reference.method !== 'string' || typeof reference.note !== 'string') return false;
  return new Set(value.cases.map(item => item && item.id)).size === value.cases.length && value.cases.every(item => item && typeof item.id === 'string' && !!item.id && ['automatic_reset', 'banked_reset'].includes(item.target)
    && typeof item.title === 'string' && typeof item.snapshotId === 'string' && validWindows(item.windows, item.signalAt) && validCoverage(item.coverage) && typeof item.late === 'boolean'
    && ['watching', 'elapsed', 'observed', 'paused'].includes(item.status) && Array.isArray(item.outcomes)
    && new Set(item.outcomes.map(outcome => outcome && outcome.id)).size === item.outcomes.length && item.outcomes.every(outcome => validForecastOutcome(outcome, item))
    && (item.snapshot === undefined || validateForecastSnapshot(item.snapshot) && item.snapshot.caseId === item.id && item.snapshot.id === item.snapshotId && item.snapshot.target === item.target));
}
function watchTime(value) {
  if(typeof value!=='string'||value.length>64||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN;
  const year=Number(value.slice(0,4)),month=Number(value.slice(5,7)),day=Number(value.slice(8,10));
  if (month<1 || month>12 || day<1 || day>new Date(Date.UTC(year,month,0)).getUTCDate() || Number(value.slice(11,13))>23 || Number(value.slice(14,16))>59 || Number(value.slice(17,19))>59) return NaN;
  return Date.parse(value);
}
function validWatchSource(value) {
  if(value.sourceType===undefined||value.sourceType==='x_post')return typeof value.sourceUrl==='string'&&/^https:\/\/x\.com\/thsottiaux\/status\/\d{15,20}$/.test(value.sourceUrl);
  if(value.sourceType!=='observed')return false;
  return value.sourceUrl===undefined||typeof value.sourceUrl==='string'&&value.sourceUrl.length<=2048&&!!safeUrl(value.sourceUrl)&&value.sourceUrl.startsWith('https://');
}
function validateResetWatch(value) {
  if (!value || !['active','none','unavailable'].includes(value.status) || !Number.isFinite(watchTime(value.checkedAt))) return false;
  const s=value.scheduledReset;
  if(s!==undefined&&(!s||typeof s!=='object'||value.status!=='none'||typeof s.id!=='string'||!s.id.trim()||s.id.length>64||!['automatic_reset','banked_reset'].includes(s.kind)||!validWatchSource(s)||typeof s.text!=='string'||!s.text.trim()||s.text.length>4000||!Number.isFinite(watchTime(s.announcedAt))||watchTime(s.announcedAt)>watchTime(value.checkedAt)||s.scheduledFor!==null&&(!Number.isFinite(watchTime(s.scheduledFor))||watchTime(s.scheduledFor)<watchTime(s.announcedAt))))return false;
  if (value.status !== 'active') return value.signal === undefined;
  const signal=value.signal;
  if (!signal || !['elevated','strong'].includes(signal.level) || !validWatchSource(signal)
    || typeof signal.text !== 'string' || !signal.text.trim() || signal.text.length>4000 || typeof signal.forecastWindow !== 'string' || !signal.forecastWindow.trim() || signal.forecastWindow.length>200
    || signal.chancePercent!==undefined&&signal.chancePercent!==null&&(!Number.isInteger(signal.chancePercent)||signal.chancePercent<0||signal.chancePercent>100)) return false;
  const observed=watchTime(signal.observedAt),expires=watchTime(signal.expiresAt),checked=watchTime(value.checkedAt);
  return Number.isFinite(observed) && Number.isFinite(expires) && observed<=checked && expires>observed;
}
function activeResetWatch(watch, now, resolvedAt) {
  if (!validateResetWatch(watch) || watch.status !== 'active') return null;
  const current=Date.parse(now),signal=watch.signal,resolved=Date.parse(resolvedAt);
  if (!Number.isFinite(current) || watchTime(watch.checkedAt)>current || watchTime(signal.observedAt)>current || watchTime(signal.expiresAt)<=current || Number.isFinite(resolved)&&resolved>=watchTime(signal.observedAt)) return null;
  return signal;
}
function activeResetSchedule(watch,now) {
  if(!validateResetWatch(watch)||!watch.scheduledReset)return null;
  const current=Date.parse(now),s=watch.scheduledReset;
  if(!Number.isFinite(current)||watchTime(watch.checkedAt)>current||watchTime(s.announcedAt)>current)return null;
  return s;
}
function resetWatchWindow(value) {
  const hours=value.trim().match(/^(?:within|in(?: the next)?)\s+(\d+(?:\.\d+)?)\s+hours?\.?$/i);
  if(hours)return `${hours[1]}小时内`;
  if(/^(?:within|in(?: the next)?)\s+(?:a\s+)?few\s+hours\.?$/i.test(value.trim()))return '数小时内';
  return value;
}
function probabilityText(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? `${Number((value * 100).toFixed(1))}%` : null; }
function intervalText(value) { return value ? `${probabilityText(value[0])}—${probabilityText(value[1])}` : '样本不足'; }
function forecastPath(snapshot) { return `/pages/methodology/index?snapshot=${encodeURIComponent(snapshot.id)}`; }
function forecastSnapshotModel(snapshot, serverTime) {
  if (!validateForecastSnapshot(snapshot)) return null;
  const expired24 = validTime(serverTime) && Date.parse(serverTime) >= Date.parse(snapshot.windows[24]);
  const expired48 = validTime(serverTime) && Date.parse(serverTime) >= Date.parse(snapshot.windows[48]);
  const noAdvanceForecast = ['late', 'already_known'].includes(snapshot.basis);
  return { id: snapshot.id, title: snapshot.target === 'banked_reset' ? '重置卡实验预测' : '用量重置实验预测', signalTitle: /[\u3400-\u9fff]/.test(snapshot.title) ? snapshot.title : '官方用量异常信号', target: actionLabels[snapshot.target], label: '实验预测',
    probability24: probabilityText(snapshot.p24), probability48: probabilityText(snapshot.p48), interval24: noAdvanceForecast ? '不适用' : intervalText(snapshot.interval24), interval48: noAdvanceForecast ? '不适用' : intervalText(snapshot.interval48), sampleCount: snapshot.sampleCount,
    observedSampleCount: snapshot.trainingSampleIds.length, referenceCount: snapshot.referenceSampleIds.length, prior: snapshot.prior.join('、'), counts: snapshot.counts.join('、'),
    signalAt: displayTime(snapshot.signalAt), generatedAt: displayTime(snapshot.generatedAt), cutoff: displayTime(snapshot.evidenceCutoffAt), window24: displayTime(snapshot.windows[24]), window48: displayTime(snapshot.windows[48]),
    expired24, expired48, late: snapshot.late, missing: snapshot.p24 === null && snapshot.p48 === null, emptyProbabilityText: noAdvanceForecast ? '不作提前预测' : '样本不足', url: safeUrl(snapshot.url), path: forecastPath(snapshot),
    basisText: { experimental_seed: '使用选定历史样本作实验参考', verified_live: '使用已核验的既往样本', insufficient: '样本不足，暂不显示概率', late: '资料晚采，不作为提前预测', already_known: '已知公告，非提前预测' }[snapshot.basis],
    coverageText: snapshot.coverage.status === 'verified' ? '来源覆盖已核验' : snapshot.coverage.status === 'gap' ? '来源覆盖存在缺口' : '实验参考，连续来源覆盖未核验',
    windowNote: '从首次合格信号计算，刷新不重开窗口。', deliveryNote: `预测对象是公开${snapshot.target === 'banked_reset' ? '重置卡' : '额度重置'}公告；个人到账未观测。` };
}
function currentForecast(data) {
  if (!data || !validTime(data.serverTime) || !validateForecastPublicData(data.forecasts) || data.forecasts.status !== 'ready' || upcomingActions(data).length) return null;
  const now = Date.parse(data.serverTime);
  const candidate = data.forecasts.cases.filter(item => {
    const snapshot = item.snapshot;
    return item.target === 'automatic_reset' && item.status === 'watching' && !item.late && item.coverage.status !== 'gap' && snapshot && !snapshot.late && !['late', 'already_known'].includes(snapshot.basis) && snapshot.coverage.status !== 'gap'
      && snapshot.p24 !== null && snapshot.p48 !== null && now >= Date.parse(snapshot.signalAt) && now >= Date.parse(snapshot.generatedAt) && now < Date.parse(snapshot.windows[24])
      && item.coverage.sourceIds.length && item.coverage.sourceIds.every(id => data.sources.some(source => source.id === id && source.status === 'healthy'));
  }).sort((a, b) => Date.parse(b.signalAt) - Date.parse(a.signalAt))[0];
  return candidate ? forecastSnapshotModel(candidate.snapshot, data.serverTime) : null;
}
function forecastReferenceModel(data) {
  if (!validateForecastPublicData(data)) return null;
  return { label: '历史实验参考', sampleCount: data.reference.sampleCount, probability24: probabilityText(data.reference.p24), probability48: probabilityText(data.reference.p48), interval24: intervalText(data.reference.interval24), interval48: intervalText(data.reference.interval48), counts: data.reference.counts.join('、'), prior: data.reference.prior.join('、'), note: '选定历史样本，连续来源覆盖未核验；这是实验参考，不是当前发放预告或准确率。' };
}
function forecastOutcomeModel(snapshot, data) {
  const note = '后续记录，不改原快照；个人到账未观测。';
  const unavailable = { available: false, entries: [], message: '后续记录暂不可用，不能据此判断没有公告。', note };
  if (!validateForecastSnapshot(snapshot) || !validateForecastPublicData(data) || data.status !== 'ready') return unavailable;
  const item = data.cases.find(value => value.id === snapshot.caseId && value.target === snapshot.target);
  if (!item) return unavailable;
  const entries = item.outcomes.slice().sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.id.localeCompare(a.id)).map(outcome => {
    const announced = Date.parse(outcome.announcementAt || ''), signal = Date.parse(snapshot.signalAt);
    const canLocate = outcome.stage !== 'unknown' && outcome.relationVerified && outcome.relation !== 'unmatched' && Number.isFinite(announced);
    const windowText = !canLocate ? '窗口位置未知' : announced < signal || announced > Date.parse(snapshot.windows[48]) ? '窗口外' : announced <= Date.parse(snapshot.windows[24]) ? '24小时内' : '24—48小时内';
    return { id: outcome.id, stage: outcome.invalidated ? '结局已失效，保持未知' : { promised: '发放预告', in_progress: '进行中', claimed_complete: '公告称已完成', cancelled: '已取消', unknown: '结局未知' }[outcome.stage],
      announcementAt: validTime(outcome.announcementAt) ? displayTime(outcome.announcementAt) : '未取得明确公告时间', observedAt: displayTime(outcome.observedAt), windowText,
      relationNote: outcome.relationVerified && outcome.relation !== 'unmatched' ? '已关联对应信号' : '缺少明确关联依据',
      reason: /[\u3400-\u9fff]/.test(outcome.reason) ? outcome.reason : outcome.stage === 'unknown' ? '未找到可核对的对应公告，不代表没有发放。' : '依据已关联的公开公告记录。' };
  });
  return { available: true, entries, message: entries.length ? '按后续观测时间排列，最新记录在前。' : '尚无已关联的后续记录；不代表没有公告或不会发放。', note };
}
module.exports = { publicNewsGroups, homeNewsGroups, publicSourceNotes, publicEligibility, publicReviewMessage, publicNoticeSummary,referenceCadenceView, publicArticleSummary, publicArticleContent, sourceStatus, actionLabels, recentCompletedBenefits, preferenceDefaults, dateKey, displayTime, elapsed, completionTime, latestCompletedBenefits, completionElapsed, articleSourceTime, sortedArticles, isNewsOnly, currentPublication, statePublication, publicationSourceTime, sortedPublications, sortedStatePublications, publicActions, isHistoricalArticle, upcomingActions, announcementCountdown, resetOutlookModel, stageText, calendarDays, safeUrl, sharePath, publicationWithdrawn, publicationCard, calendarModel, noticeModel, resolveDetail, activityDayNumber, activityHomeVisible, activityModel, validateForecastSnapshot, validateForecastPublicData, validateResetWatch, activeResetWatch, activeResetSchedule, resetWatchWindow, probabilityText, forecastPath, forecastSnapshotModel, currentForecast, forecastReferenceModel, forecastOutcomeModel };
