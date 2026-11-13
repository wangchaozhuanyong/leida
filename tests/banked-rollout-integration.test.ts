import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, list, one, put, insert } from '../src/db';
import type { Article, Candidate, Evidence, Job, Notice, Publication, RadarEvent, Source } from '../src/lib/types';
import { statusPosterSnapshot } from '../src/lib/status-timeline';
import { buildAutomaticTemplate, evidenceFingerprint } from '../src/server/automatic-content';
import { getPublicRead } from '../src/server/public-read';
import { createEvidence, defaultSite } from '../src/server/service';
import { contextFor, runOne, scheduleDue } from '../src/server/worker';
import { homeResetStatus, selectedHomeStatus } from '../miniprogram/utils/home-reset-status';
import { observedEvidence } from '../src/lib/reset-observations';
import { REFERENCE_SOURCES } from '../src/server/reference-reset-source';
import { collectSource } from '../src/server/ingestion';
import { TIBORESET_OBSERVATION_SOURCE as tracker, parseTiboresetObservations } from '../src/server/tiboreset-observation-source';

const monitorText='The banked reset Tibo announced landed on our monitoring accounts.';
const observationPage=(id:string,stamp:string,text=monitorText,postLink='')=>`<section id="log"><ul><li class="log-item" data-kind="other">
  <div class="log-item-meta"><time class="log-item-abs" datetime="${stamp}"></time><span class="pill">Note</span></div>
  <p class="log-item-text"><a class="log-item-title" href="/r/${id}">${text}</a></p>${postLink}</li></ul></section>`;

test('核对实际发卡观测条目及其时间，普通公告和无效报告不能进入观测',()=>{
  const id='2121007235465577607', stamp='2026-11-12T22:28:26Z', collectedAt='2026-11-13T03:00:00Z';
  const rows=parseTiboresetObservations(observationPage(id,stamp),collectedAt);
  assert.equal(rows.length,1);
  const evidence={...rows[0],id:'verified-report',hash:'fixture',historical:false};
  const observed=observedEvidence(evidence,collectedAt)!;
  assert.equal(observed.kind,'banked_reset');
  assert.equal(observed.observedAt,'2026-11-12T22:28:26.000Z');
  assert.equal(observed.sourceUrl,'https://tiboreset.com/r/'+id);
  assert.equal(observedEvidence({...evidence,url:'https://x.com/thsottiaux/status/'+id},collectedAt),null);
  assert.equal(observedEvidence({...evidence,publishedAt:'2026-11-12T22:29:00.000Z'},collectedAt),null);
  assert.equal(observedEvidence(evidence,'2026-11-12T22:29:00Z'),null);
  assert.equal(parseTiboresetObservations(observationPage(id,stamp,'The banked reset should land soon.'),collectedAt).length,0);
  assert.equal(parseTiboresetObservations(observationPage(id,stamp),'2026-11-16T00:00:00Z').length,0);
  assert.throws(()=>parseTiboresetObservations(observationPage(id,stamp,monitorText,'<a class="log-item-link" href="https://x.com/">X</a>'),collectedAt));
  assert.throws(()=>parseTiboresetObservations(observationPage(id,'2026-11-12T22:29:00Z'),collectedAt));
});

test('已收录的发卡原文和观测走真实采集发布，预测、正计时、海报及记录一致', {
  skip: process.env.RADAR_ROLLOUT_INTEGRATION !== '1',
}, async () => {
  const database = new URL(process.env.DATABASE_URL!);
  assert.equal(database.hostname, '127.0.0.1');
  assert.equal(database.port, '55489');
  assert.match(database.pathname, /^\/radar_qa_rollout(?:_[a-z0-9]+)?$/);
  const oldFetch = globalThis.fetch;
  let body='';
  globalThis.fetch = async url => {
    assert.equal(String(url),tracker.url,'隔离回归禁止外部请求');
    assert.ok(body);
    return new Response(body);
  };
  try {
    const now = Date.now();
    const at = new Date(now - 3_600_000).toISOString();
    const hintAt = new Date(now - 4 * 3_600_000).toISOString();
    const windowEnd = new Date(now + 5 * 3_600_000).toISOString();
    const messageId = ((BigInt(Date.parse(at)) - 1288834974657n) << 22n).toString();
    const source: Source = {
      id: 'tibo-public', name: '隔离测试原文', kind: 'timeline', url: 'https://example.invalid/rollout',
      enabled: true, validated: true, status: 'healthy', lastSuccessAt: new Date(now).toISOString(),
      intervalMinutes: 10, nextRunAt: '2100-01-01T00:00:00Z', version: 1,
    };
    await put('sources', source);
    await put('sources', {...source, id: 'reset-archive', kind: 'archive', url: 'https://codex-resets.com/zh-CN'});
    for(const definition of REFERENCE_SOURCES.filter(item=>item.id!==tracker.id)){
      await put('sources',definition.id==='aiplanwatch-signals'?{...definition,enabled:true,validated:true,status:'healthy',
        lastSuccessAt:source.lastSuccessAt,referenceSnapshotAt:source.lastSuccessAt,nextRunAt:source.nextRunAt}:definition);
    }
    await put('settings', {...defaultSite, id: 'site'});
    await put('settings', {
      id: 'forecast_runtime', status: 'ready', referenceSignal: {
        id: '2120410480204525936', text: 'Perhaps Thursday for a banked reset.',
        sourceUrl: 'https://x.com/thsottiaux/status/2120410480204525936',
        sourceName: 'AIPlanWatch', publishedAt: hintAt, recordedAt: hintAt,
        hint: {kind: 'banked_reset', dayLabel: '周四', expiresAt: windowEnd},
      },
    });
    const input = {
      sourceId: source.id, messageId,
      url: 'https://x.com/thsottiaux/status/' + messageId,
      text: 'We shipped some good updates to dots today and the banked reset has been activated and should land in everyones accounts sometime soon!',
      publishedAt: at, collectedAt: at, contextComplete: false, historical: false,
      provenance: 'archive' as const, textOrigin: 'original' as const,
      metadata: {sourceGroup: 'fxembed:thsottiaux', category: 'reset' as const},
    };
    const saved = await createEvidence(input);
    const excerpt = await createEvidence({
      ...input, sourceId: 'reset-archive', textOrigin: 'archive_excerpt',
      text: '公开归档记录发放已经启动，将陆续到账。', metadata: {sourceGroup: 'codex-resets', category: 'reset'},
    });
    const evidenceIds = [excerpt.evidence.id, saved.evidence.id];
    const storedEvidence = await list<typeof saved.evidence>('evidence');
    const event: RadarEvent = {
      id: 'event-rollout', title: '重置相关消息待确认', status: 'published', version: 1,
      actions: [], evidenceIds, updatedAt: at, publicationId: 'pub-before-rollout',
    };
    const article: Article = {
      id: 'article-rollout', eventId: event.id, publicationId: event.publicationId, title: event.title,
      summary: '旧规则未读出发放进展。', translation: '', category: 'reset', evidenceIds,
      status: 'published', version: 1, publishedAt: at, updatedAt: at, sourcePublishedAt: at,
      publicationMode: 'news_only', contentOrigin: 'template', reviewStatus: 'pending',
      reviewReasons: ['保存的正文为摘要或存在截断，等待完整原文。'],
    };
    const old: Publication = {
      id: event.publicationId, eventId: event.id, articleId: article.id, event, article,
      cutoffAt: at, publishedAt: at, reason: '隔离旧数据', mode: 'news_only', contentOrigin: 'template',
    };
    await put('events', event);
    await put('articles', article);
    await insert('publications', old);
    const draft = buildAutomaticTemplate([saved.evidence])!;
    assert.equal(draft.actions[0]?.stage, 'in_progress');
    const original = saved.candidate!;
    const originalContext = contextFor(original, storedEvidence.find(item => item.id === saved.evidence.id)!, storedEvidence);
    await put('candidates', {
      ...original,
      automation: {
        state: 'configuration', reasonCodes: ['ai_unconfigured', 'semantic_pending'], dependencyIds: [],
        inputFingerprint: evidenceFingerprint(originalContext).replace('-rollout-activation-1', ''),
      },
    } satisfies Candidate);
    const archive = excerpt.candidate!;
    const archivedCandidate: Candidate = {
      ...archive, status: 'published', content: {...article, actions: [], eventId: event.id}, reasons: [],
      automation: {
        state: 'deferred', reasonCodes: ['ambiguous_kind_or_audience'], dependencyIds: [],
        articleId: article.id, templatePublished: true,
      },
    };
    const archiveContext = contextFor(archivedCandidate, storedEvidence.find(item => item.id === excerpt.evidence.id)!, storedEvidence);
    await put('candidates', {
      ...archivedCandidate,
      automation: {...archivedCandidate.automation!, inputFingerprint: evidenceFingerprint(archiveContext)},
    } satisfies Candidate);
    const readHome = async () => (await getPublicRead({view:'home'})).data;
    const before = await readHome();
    assert.equal(homeResetStatus(before).primary.state, 'estimated');
    const oldPoster = statusPosterSnapshot(before)!;
    assert.equal(oldPoster.validUntil, windowEnd);

    const schedule = () => scheduleDue({allowTemplates: true, allowEnrichment: false, skipSources: true});
    const work = () => runOne({
      schedule: false, allowTemplates: true, enrich: async () => undefined, enrichQuoted: async () => [],
      generate: async () => { throw new Error('发放进展须由规则处理'); },
      wechat: async () => { throw new Error('禁止发送真实提醒'); },
    });
    await schedule();
    await schedule();
    const queued = (await list<Job>('jobs')).filter(job => job.candidateId === original.id && job.status === 'queued');
    assert.equal(queued.length, 1);
    assert.equal(await work(), true);
    const current = await one<Article>('articles', article.id);
    assert.equal(current?.publicationMode, 'state_change');
    assert.equal(current?.title, '重置卡：发放中');
    assert.equal((await one<RadarEvent>('events', event.id))?.actions[0]?.stage, 'in_progress');
    assert.deepEqual(await one<Publication>('publications', old.id), old);
    assert.equal((await list<Article>('articles')).length, 1);
    const after = (await getPublicRead({view:'home', version: current?.publicationId})).data;
    const card = homeResetStatus(after).primary;
    assert.equal(card.kind, 'banked_reset');
    assert.equal(card.state, 'estimated');
    assert.equal(card.hero.title, '周四可能发放');
    assert.equal(card.timeAt, windowEnd);
    assert.equal(card.expectedAt, windowEnd);
    assert.ok(card.metric);
    const poster = statusPosterSnapshot(after)!;
    assert.notEqual(poster.round, oldPoster.round);
    assert.equal(poster.title, card.hero.title);
    assert.equal(poster.publicationId, current?.publicationId);
    assert.equal(poster.validUntil, windowEnd);
    assert.equal(selectedHomeStatus(after, 'banked_reset', windowEnd)?.hero.metric, '0秒');
    assert.deepEqual((await list<Notice>('notices')).map(notice => notice.categories), [['announcement']]);

    const snapshots = await list<Publication>('publications');
    assert.equal((await createEvidence(input)).created, false);
    await schedule();
    assert.equal(await work(), false);
    assert.deepEqual(await list<Publication>('publications'), snapshots);

    const observedAt=new Date(Math.floor((now-2_400_000)/1000)*1000).toISOString();
    const observedId=((BigInt(Date.parse(observedAt))-1288834974657n)<<22n).toString();
    body=observationPage(observedId,observedAt);
    await scheduleDue({skipGeneration:true});
    const collector=await one<Source>('sources',tracker.id);
    assert.ok(collector?.enabled&&collector.publicationPaused);
    const untilPublished=async(check:()=>Promise<boolean>)=>{
      for(let attempt=0;attempt<30;attempt++){
        await work();
        if(await check())return;
        await schedule();
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.fail('已排队的发卡观测必须完成发布');
    };
    await untilPublished(async()=>(await list<Article>('articles')).some(article=>article.title==='重置卡到账观测'));
    const sourceEvidence=(await list<Evidence>('evidence')).find(item=>item.sourceId===tracker.id)!;
    assert.ok(sourceEvidence.historical,'新来源首批保持静默');
    assert.equal((await collectSource(tracker.id)).created,0);
    const observedHome=(await getPublicRead({view:'home',version:'arrived-rollout'})).data;
    const arrived=homeResetStatus(observedHome).primary;
    assert.equal(arrived.state,'observed');assert.equal(arrived.kind,'banked_reset');
    assert.equal(arrived.hero.title,'距离上次发卡（观测）');assert.equal(arrived.clockAt,observedAt);
    const history=await getPublicRead({view:'history',filter:'banked_reset',version:'arrived-history'});
    const observedPublication=history.data.publications.find(p=>p.id===arrived.publicationId)!;
    assert.equal(observedPublication.article.title,'重置卡到账观测');
    assert.equal(observedPublication.event.actions.length,0);
    assert.equal(statusPosterSnapshot(observedHome).statementAt,observedAt);
    assert.equal(statusPosterSnapshot(observedHome).publicationId,arrived.publicationId);
    assert.deepEqual((await list<Notice>('notices')).map(notice=>notice.categories), [['announcement']]);

    const confirmedAt = new Date(now - 1_800_000).toISOString();
    const confirmedId = ((BigInt(Date.parse(confirmedAt)) - 1288834974657n) << 22n).toString();
    await createEvidence({
      ...input, messageId: confirmedId, url: 'https://x.com/thsottiaux/status/' + confirmedId,
      text: 'The banked reset has landed in everyone’s accounts.',
      publishedAt: confirmedAt, collectedAt: confirmedAt, parentId: messageId, contextComplete: true,
    });
    await schedule();
    await untilPublished(async()=>(await one<RadarEvent>('events',event.id))?.actions[0]?.stage==='claimed_complete');
    const completed = (await getPublicRead({view:'home', version:'confirmed-rollout'})).data;
    const confirmed = homeResetStatus(completed).primary;
    assert.equal(confirmed.state, 'completed');
    assert.equal(confirmed.clockAt, observedAt);
    assert.equal(confirmed.hero.title, '距离上次发卡');
    assert.equal(statusPosterSnapshot(completed)?.statementAt, observedAt);
    assert.deepEqual((await one<RadarEvent>('events', event.id))?.actions.map(action => action.stage), ['claimed_complete']);
    assert.deepEqual(await one<Publication>('publications', old.id), old);
    assert.equal((await list('wechat_deliveries')).length, 0);

    const plannedAt = new Date(now - 900_000).toISOString();
    const startedAt = new Date(now - 600_000).toISOString();
    const deadline = new Date(now + 3_600_000).toISOString();
    const planEventId = 'event-with-deadline';
    const timedAction = {...draft.actions[0], id:'action-with-deadline', stage:'promised' as const,
      statementAt:plannedAt, expectedAt:deadline, timeNote:'原文最晚期限', evidenceIds:[]};
    const progressAction = {...timedAction, stage:'in_progress' as const, statementAt:startedAt,
      expectedAt:undefined, timeNote:'发布者更新了消息'};
    for(const [id, action] of [['prior-timed', timedAction], ['current-untimed', progressAction]] as const){
      const snapshot: Publication = {
        ...old, id:'pub-'+id, eventId:planEventId, articleId:'article-'+id,
        publishedAt:action.statementAt, cutoffAt:action.statementAt, mode:'state_change',
        event:{...event,id:planEventId,publicationId:'pub-'+id,updatedAt:action.statementAt,actions:[action],evidenceIds:[]},
        article:{...article,id:'article-'+id,eventId:planEventId,publicationId:'pub-'+id,
          publishedAt:action.statementAt, updatedAt:action.statementAt, sourcePublishedAt:action.statementAt,
          publicationMode:'state_change',evidenceIds:[]},
      };
      await put('events',snapshot.event);
      await put('articles',snapshot.article);
      await insert('publications',snapshot);
    }
    const compact = (await getPublicRead({view:'home',version:'compact-timing'})).data;
    const upcoming = selectedHomeStatus(compact,'banked_reset')!;
    assert.equal(upcoming.state,'scheduled');
    assert.equal(upcoming.timeAt,deadline);
    assert.equal(upcoming.timeQualifier,'前');
    assert.equal(upcoming.publicationId,'pub-current-untimed');
    assert.equal(upcoming.timingPublicationId,'pub-prior-timed');
    assert.equal(statusPosterSnapshot(compact).publicationId,'pub-prior-timed');
    assert.equal(selectedHomeStatus(compact,'banked_reset',deadline)?.hero.metric,'0秒');
    const afterLimit = new Date(Date.parse(deadline) + 86_400_000).toISOString();
    const closed = selectedHomeStatus(compact,'banked_reset',afterLimit)!;
    assert.equal(closed.roundNotice?.label,'本轮发卡等待确认已结束');
    assert.equal(closed.timeAt,observedAt);
  } finally {
    globalThis.fetch = oldFetch;
    await pool.end();
  }
});
