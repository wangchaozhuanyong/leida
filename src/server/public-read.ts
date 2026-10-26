import { transaction, type Client } from '../db';
import type { Activity, Article, Evidence, PublicData, Publication, RadarEvent, Source } from '../lib/types';
import type { PublicReadEnvelope, PublicReadOptions, PublicView } from '../lib/public-read';
import { projectPublicHistory } from '../lib/history';
import { publicActions, completedPublicActions, publicationSourceTime, recentCompletedBenefits } from '../lib/public-facts';
import { publicNewsGroups, homeNewsGroups } from '../lib/public-feed';
import { publicResetOutlook } from '../lib/reset-outlook';
import {resetObservations,resetObservationSources} from '../lib/reset-observations';
import { activityDayNumber } from '../lib/activity-display';
import { getPublicForecast, forecastTablesAvailable } from './forecast';
import { hash } from './domain';
import {forecastSourceAvailable} from '../lib/forecast';
import { publicCached } from './public-cache';
import { configuredPublicRpc } from './cloudbase/public-config';
import {resetWatchVersion} from './reset-watch';

const views: PublicView[] = ['home', 'history', 'news', 'detail', 'activity', 'notices', 'methodology', 'state', 'calendar'];
const fail = () => { throw Object.assign(new Error('公开读取参数无效，请重新打开页面'), { status: 400 }); };
export function parsePublicRead(params: URLSearchParams): PublicReadOptions {
  const view = params.get('view') as PublicView;
  if (!views.includes(view)) return fail();
  const id = params.get('id') || undefined, version = params.get('version') || undefined;
  const entity = params.get('entity') as PublicReadOptions['entity'];
  if ([id, version].some(value => value && !/^[A-Za-z0-9._-]{1,180}$/.test(value))) return fail();
  if (view === 'detail' && (!id || !['events', 'articles', 'sources', 'publications'].includes(entity!))) return fail();
  if (view === 'activity' && !id) return fail();
  const filter = params.get('filter') || 'all';
  if (view === 'history' && !['all', 'automatic_reset', 'banked_reset'].includes(filter) || view === 'news' && !['all', 'reset', 'product', 'activity'].includes(filter)) return fail();
  const day = params.has('day') ? Number(params.get('day')) : undefined;
  if (day !== undefined && (!Number.isInteger(day) || day < 1 || day > 366)) return fail();
  const publications = params.getAll('publication');
  if (publications.length > 50 || publications.some(value => !/^[A-Za-z0-9._-]{1,180}$/.test(value))) return fail();
  const cursor = params.get('cursor') || undefined;
  if (cursor && cursor.length > 1000) return fail();
  return { view, id, entity, version, filter, day, publications, cursor };
}
export function publicSources(rows: Source[], timestamp: string): PublicData['sources'] {
  return rows.map(source => {
    let status = source.status;
    if (!source.enabled || source.kind === 'manual') status = 'paused';
    else if (status === 'paused') status = source.lastSuccessAt ? 'healthy' : 'unconnected';
    if (source.enabled && source.kind !== 'manual' && source.lastSuccessAt && Date.parse(timestamp) - Date.parse(source.lastSuccessAt) > (source.effectiveIntervalMinutes ?? source.intervalMinutes) * 3 * 60000) status = 'delayed';
    return { id: source.id, name: source.name, status, lastSuccessAt: source.lastSuccessAt };
  });
}
/** Shared opaque version calculation; inputs come from one database snapshot. */
export function finishPublicVersion(parts: unknown[], rows: Source[], timestamp: string) {
  const sources = publicSources(rows, timestamp);
  const complete = [...parts, rows.map(p => [p.id, p.enabled, p.validated, p.publicationPaused, p.kind, p.url, p.status, p.effectiveIntervalMinutes ?? p.intervalMinutes, forecastSourceAvailable(p,timestamp), sources.find(s => s.id === p.id)?.status])];
  const contentVersion = hash(JSON.stringify(complete)).slice(0, 24);
  return { version: hash(JSON.stringify([contentVersion, sources])).slice(0, 24), contentVersion, sources, serverTime: timestamp };
}
/** Hash public metadata inside PostgreSQL. No historical snapshot/training payload crosses this boundary. */
export async function readPublicVersion(client: Client, timestamp = new Date().toISOString()) {
  const rows = await client.query("SELECT payload FROM radar_sources ORDER BY id");
  const tables = ['events', 'articles', 'publications', 'notices', 'activities'];
  const parts: unknown[] = [];
  for (const table of tables) {
    const result = await client.query(`SELECT md5(coalesce(string_agg(id || md5(payload::text), ',' ORDER BY id), '')) AS digest FROM radar_${table}`);
    parts.push(result.rows[0].digest);
  }
  const settings = await client.query("SELECT payload FROM radar_settings WHERE id IN ('site','forecast_runtime') ORDER BY id");
  parts.push(settings.rows.map(row => { const p = row.payload; return p.id === 'site' ? p : { id: p.id, status: p.status, cadenceSnapshotId: p.cadenceSnapshotId, cadenceSnapshotIds:p.cadenceSnapshotIds,cadenceEvaluationByKind:p.cadenceEvaluationByKind,...(p.referenceSignal?{referenceSignal:p.referenceSignal}:{}),...(p.referenceCadencePublic?{referenceCadencePublic:p.referenceCadencePublic,referenceExpired:Date.parse(p.referenceCadencePublic.validUntil)<=Date.parse(timestamp)}:{}) }; }));
  // Deadlines and source health can change without a new publication row.
  const deadlines = await client.query("SELECT payload->>'id' AS id, a->>'id' AS action, a->>'expectedAt' AS deadline FROM radar_events CROSS JOIN LATERAL jsonb_array_elements(payload->'actions') a WHERE a->>'expectedAt' IS NOT NULL ORDER BY id, action");
  parts.push(deadlines.rows.map(row => [row.id, row.action, Date.parse(row.deadline) <= Date.parse(timestamp)]));
  if (await forecastTablesAvailable(client)) {
    const cases = await client.query("SELECT id, md5(payload::text) AS digest, payload->'windows'->>'24' AS w24, payload->'windows'->>'48' AS w48 FROM radar_forecast_cases ORDER BY id");
    const snapshots = await client.query("SELECT id, payload->>'validUntil' AS until, payload->>'generatedAt' AS generated FROM radar_forecast_snapshots WHERE id IN (SELECT jsonb_each_text.value FROM radar_settings CROSS JOIN LATERAL jsonb_each_text(coalesce(payload->'cadenceSnapshotIds','{}'::jsonb)) WHERE id='forecast_runtime') OR id=(SELECT payload->>'cadenceSnapshotId' FROM radar_settings WHERE id='forecast_runtime') OR id IN (SELECT payload->>'snapshotId' FROM radar_forecast_cases) ORDER BY id");
    const outcomes = await client.query("SELECT md5(coalesce(string_agg(id || md5(payload::text), ',' ORDER BY id), '')) AS digest FROM radar_forecast_outcomes");
    parts.push(cases.rows.map(row => [row.id, row.digest, Date.parse(row.w24) <= Date.parse(timestamp), Date.parse(row.w48) <= Date.parse(timestamp)]), snapshots.rows.map(row => [row.id, Date.parse(row.until) <= Date.parse(timestamp), Date.parse(row.generated) > Date.parse(timestamp)]), outcomes.rows[0].digest);
  }
  return finishPublicVersion(parts, rows.rows.map(row => row.payload as Source), timestamp);
}
const getStoredLightPublicVersion = async () => {
  const rpc=configuredPublicRpc();
  if(rpc)return (await import('./cloudbase/public-read')).createCloudbasePublicReader(rpc).version();
  return publicCached('light-version', () => transaction(async client => {
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const state = await readPublicVersion(client);
  return { version: state.version, contentVersion: state.contentVersion };
  }));
};

export async function getLightPublicVersion() {
  const state=await getStoredLightPublicVersion(),watch=undefined;
  const now = new Date().toISOString();
  return {version: resetWatchVersion(state.version, watch, now), contentVersion: resetWatchVersion(state.contentVersion, watch, now)};
}

// Compatibility facts contain dates, qualifications and actions, but no original bodies.
const articleSummary = `(payload - 'translation' - 'summary') || jsonb_build_object('translation','', 'summary',left(payload->>'summary',360))`;
const thinPublication = `(payload - 'article') || jsonb_build_object('article', ((payload->'article') - 'translation' - 'summary') || jsonb_build_object('translation','', 'summary',left(payload->'article'->>'summary',360)))`;
// Retain bounded observation proof in compact reads; ordinary original bodies stay omitted.
const thinEvidence = `CASE WHEN payload->>'sourceId' IN ('reset-archive','aiplanwatch-reference','codexlimits-observations') AND payload->>'messageId' LIKE 'observed-%' THEN payload ELSE (payload - 'text' - 'metadata') || jsonb_build_object('text','') END`;
export async function readPublicFacts(client: Client, timestamp: string): Promise<PublicData> {
  const events = (await client.query('SELECT payload FROM radar_events ORDER BY created_at DESC,id')).rows.map(row => row.payload as RadarEvent);
  const articles = (await client.query(`SELECT ${articleSummary} AS payload FROM radar_articles ORDER BY created_at DESC,id`)).rows.map(row => row.payload as Article);
  const publications = (await client.query(`SELECT ${thinPublication} AS payload FROM radar_publications ORDER BY created_at DESC,id`)).rows.map(row => row.payload as Publication);
  const evidence = (await client.query(`SELECT ${thinEvidence} AS payload FROM radar_evidence WHERE id IN (SELECT jsonb_array_elements_text(payload->'article'->'evidenceIds') FROM radar_publications)`)).rows.map(row => row.payload as Evidence);
  return projectPublicHistory({ events, articles, publications, evidence, activities: [], notices: [], sources: [], site: { name: '模钥重置雷达', description: '', autoPublish: false, version: 1 }, serverTime: timestamp });
}

interface Cursor { at: string; publishedAt: string; id: string; view: string; filter: string; }
export const encodePublicCursor = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString('base64url');
export function decodeCursor(value: string | undefined, options: PublicReadOptions): Cursor | undefined {
  if (!value) return;
  try { const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()); if (parsed.view !== options.view || parsed.filter !== options.filter || typeof parsed.id !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || !Number.isFinite(Date.parse(parsed.publishedAt))) return fail(); return parsed; } catch { return fail(); }
}
/** Group before paging, using existing lightweight public facts; no database mutation. */
export function paginatePublicNews(facts: PublicData, options: PublicReadOptions) {
  const cursor = decodeCursor(options.cursor, options);
  const groups = publicNewsGroups(facts).filter(group => !options.filter || options.filter === 'all' || group.category === options.filter);
  const rows = groups.map(group => ({group, id:group.latest.id, at:publicationSourceTime(group.latest), publishedAt:group.latest.publishedAt}));
  const after = rows.filter(row => !cursor || Date.parse(row.at) < Date.parse(cursor.at)
    || Date.parse(row.at) === Date.parse(cursor.at) && (Date.parse(row.publishedAt) < Date.parse(cursor.publishedAt)
    || Date.parse(row.publishedAt) === Date.parse(cursor.publishedAt) && row.id > cursor.id));
  const visible = after.slice(0, 20), last = visible.at(-1);
  const selected = new Set(visible.flatMap(row => row.group.updates.map(p => p.id).concat(row.id)));
  return {selected, page:{ids:visible.map(row=>row.id), total:rows.length, nextCursor:after.length > 20 && last
    ? encodePublicCursor({at:last.at,publishedAt:last.publishedAt,id:last.id,view:options.view,filter:options.filter || 'all'}) : null}};
}
async function getStoredPublicRead(options: PublicReadOptions): Promise<PublicReadEnvelope> {
  const rpc=configuredPublicRpc();
  if(rpc)return (await import('./cloudbase/public-read')).createCloudbasePublicReader(rpc).read(options);
  const key = JSON.stringify(options);
  const result = await publicCached(`read:${key}`, () => transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const now = new Date().toISOString(), state = await readPublicVersion(client, now);
    const site = (await client.query("SELECT payload FROM radar_settings WHERE id='site'")).rows[0]?.payload;
    const empty: PublicData = { events: [], articles: [], publications: [], evidence: [], notices: [], activities: [], sources: state.sources, site: site || { name: '模钥重置雷达', description: '', autoPublish: false, version: 1 }, serverTime: now };
    if (options.view === 'state') return { data: empty, version: state.version, contentVersion: state.contentVersion };
    const facts = ['home','methodology','calendar','news','history','activity'].includes(options.view) ? await readPublicFacts(client, now) : {...empty};
    const activities: Activity[] = (await client.query('SELECT payload FROM radar_activities')).rows.map(row => row.payload);
    const selected = new Set<string>();
    let page: PublicReadEnvelope['page'];
    let extraEvidence: string[] = [];
    const detailed = options.view === 'detail' || options.view === 'activity';
    if (options.view === 'news') {
      const grouped = paginatePublicNews(facts, options);
      grouped.selected.forEach(id => selected.add(id));
      page = grouped.page;
    } else if (options.view === 'history') {
      // Filtering, ordering and the 20-row window happen in SQL, never Array.slice pagination.
      const cursor = decodeCursor(options.cursor, options), args: unknown[] = [options.filter || 'all',resetObservations(facts).map(o=>o.publicationId)];
      const history = options.view === 'history';
      const from = history ? `FROM radar_events e LEFT JOIN radar_publications current ON current.id=e.payload->>'publicationId' JOIN LATERAL (SELECT CASE WHEN current.id IS NOT NULL AND (current.id=ANY($2::text[]) OR coalesce(current.payload->>'mode',current.payload->'article'->>'publicationMode','state_change')<>'news_only') THEN current.payload ELSE (SELECT p.payload FROM radar_publications p WHERE p.payload->>'eventId'=e.id AND (p.payload->>'id'=ANY($2::text[]) OR coalesce(p.payload->>'mode',p.payload->'article'->>'publicationMode','state_change')<>'news_only') ORDER BY (p.payload->>'publishedAt')::timestamptz DESC,p.id LIMIT 1) END AS payload) p ON p.payload IS NOT NULL` : 'FROM radar_articles a JOIN radar_publications p ON p.id=a.payload->>\'publicationId\'';
      const at = history ? `coalesce(greatest((p.payload->'article'->>'sourcePublishedAt')::timestamptz, (SELECT max((action->>'statementAt')::timestamptz) FROM jsonb_array_elements(p.payload->'event'->'actions') action)), (p.payload->'article'->>'publishedAt')::timestamptz)` : `coalesce((a.payload->>'sourcePublishedAt')::timestamptz,(a.payload->>'publishedAt')::timestamptz)`;
      const where = history ? `e.payload->>'status'<>'merged' AND (jsonb_array_length(p.payload->'event'->'actions')>0 OR p.payload->>'id'=ANY($2::text[])) AND ($1='all' OR ($1='automatic_reset' AND p.payload->>'id'=ANY($2::text[])) OR EXISTS (SELECT 1 FROM jsonb_array_elements(p.payload->'event'->'actions') action WHERE action->>'kind'=$1))` : `($1='all' OR a.payload->>'category'=$1)`;
      const base = `SELECT p.payload->>'id' AS id, ${at} AS at, (p.payload->>'publishedAt')::timestamptz AS published ${from} WHERE ${where}`;
      const count = await client.query(`SELECT count(*)::int AS total FROM (${base}) records`, args);
      const after = cursor ? (args.push(cursor.at,cursor.publishedAt,cursor.id), ' WHERE (at<$3::timestamptz OR (at=$3::timestamptz AND (published<$4::timestamptz OR (published=$4::timestamptz AND id>$5))))') : '';
      const rows = (await client.query(`SELECT * FROM (${base}) records${after} ORDER BY at DESC, published DESC, id ASC LIMIT 21`, args)).rows;
      const visible = rows.slice(0, 20); visible.forEach(row => selected.add(row.id));
      page = { ids: visible.map(row => row.id), total: count.rows[0].total, nextCursor: rows.length > 20 ? encodePublicCursor({ at: new Date(visible.at(-1)!.at).toISOString(), publishedAt:new Date(visible.at(-1)!.published).toISOString(), id: visible.at(-1)!.id, view: options.view, filter: options.filter || 'all' }) : null };
    } else if (options.view === 'home' || options.view === 'methodology') {
      const outlook = publicResetOutlook(facts);
      for (const lane of Object.values(outlook.byKind ?? {})) for (const round of [lane.active,lane.latestCompletion,lane.lastResolved,lane.latestObservation]) if (round) selected.add(round.publicationId);
      for (const id of [outlook.active?.publicationId, outlook.latestCompletion?.publicationId, outlook.lastResolved?.publicationId]) if (id) selected.add(id);
      const actions = publicActions(facts).sort((a,b) => Date.parse(b.action.statementAt)-Date.parse(a.action.statementAt));
      recentCompletedBenefits(facts).forEach(item=>selected.add(item.publication.id));
      for (const kind of ['automatic_reset','banked_reset']) { const item = actions.find(item => item.action.kind === kind && item.action.stage === 'claimed_complete' && Date.parse(item.action.statementAt) <= Date.parse(now) && Date.parse(item.publication.publishedAt) <= Date.parse(now)); if (item) selected.add(item.publication.id); }
      homeNewsGroups(facts).forEach(group => {selected.add(group.latest.id);if(group.observation)group.observation.sources.forEach(source=>selected.add(source.publicationId));});
      // Keep bounded proof beyond the three news cards, so a later source's
      // report cannot hide an earlier observation needed by the same round.
      resetObservationSources(facts).slice(0,10).forEach(item=>selected.add(item.publicationId));
    } else if (options.view === 'calendar') {
      publicActions(facts).forEach(item => selected.add(item.publication.id));
      resetObservationSources(facts).forEach(item => selected.add(item.publicationId));
      // Cross-source display dedup can choose A while a completion cites B.
      // Retain B's published proof so clients can verify that direct citation.
      const cited = new Set(completedPublicActions(facts).flatMap(item => item.action.evidenceIds));
      for (const evidence of facts.evidence.filter(item => cited.has(item.id))) {
        resetObservations({...facts, evidence:[evidence]}).forEach(item => selected.add(item.publicationId));
      }
    } else if (options.view === 'activity') {
      const activity = activities.find(item => item.id === options.id);
      const day = options.day || (activity ? Math.max(1, Math.min(activity.days, activityDayNumber(activity, now) || 1)) : 1);
      // Keep the small activity calendar in one coherent read. Selecting a day
      // is a local filter; fixed daily shares still validate against that day.
      const items=activity?.items || [];
      const dayItems=items.filter(item=>item.day===day);
      const rows=await client.query("SELECT payload->>'publicationId' AS publication FROM radar_articles WHERE id=ANY($1::text[])",[items.map(item=>item.articleId)]);
      rows.rows.forEach(row=>selected.add(row.publication));
      // Include public reset facts independently of campaign links. The client
      // groups them by the activity timezone and retains their evidence grade.
      const resetFacts=[...completedPublicActions(facts).map(({action,publication})=>({at:action.statementAt,id:publication.id})),...resetObservationSources(facts).map(item=>({at:item.observedAt,id:item.publicationId}))];
      if(activity)for(const fact of resetFacts){const value=activityDayNumber(activity,fact.at);if(value!==undefined&&value>=1&&value<=activity.days)selected.add(fact.id);}
      if(options.publications?.length){const fixed=await client.query("SELECT id FROM radar_publications WHERE id=ANY($1::text[]) AND payload->>'articleId'=ANY($2::text[])",[options.publications,dayItems.map(item=>item.articleId)]);fixed.rows.forEach(row=>selected.add(row.id));}
    } else if (options.view === 'notices') {
      empty.notices = (await client.query('SELECT payload FROM radar_notices')).rows.map(row => row.payload);
      empty.notices.forEach(notice => selected.add(notice.publicationId));
    } else if (options.view === 'detail') {
      if(options.entity==='events'||options.entity==='articles'){
        const field=options.entity==='events'?'eventId':'articleId';
        const rows=await client.query(`SELECT id FROM radar_publications WHERE payload->>'${field}'=$1`,[options.id]);rows.rows.forEach(row=>selected.add(row.id));
      } else if(options.entity==='publications')selected.add(options.id!);
      else {
        const rows=await client.query("SELECT id FROM radar_publications WHERE (payload->'article'->'evidenceIds') @> $1::jsonb OR coalesce(payload->'article'->'contextEvidenceIds','[]'::jsonb) @> $1::jsonb",[JSON.stringify([options.id])]);
        if(rows.rows.length){extraEvidence.push(options.id!);rows.rows.forEach(row=>selected.add(row.id));}
      }
    }
    let selectedFacts:Publication[]=(await client.query(`SELECT ${thinPublication} AS payload FROM radar_publications WHERE id=ANY($1::text[])`,[[...selected]])).rows.map(row=>row.payload);
    if(detailed&&selectedFacts.length){
      const events:RadarEvent[]=(await client.query('SELECT payload FROM radar_events WHERE id=ANY($1::text[])',[selectedFacts.map(p=>p.eventId)])).rows.map(row=>row.payload);
      const articles:Article[]=(await client.query(`SELECT ${articleSummary} AS payload FROM radar_articles WHERE id=ANY($1::text[])`,[selectedFacts.map(p=>p.articleId)])).rows.map(row=>row.payload);
      for(const event of events)selected.add(event.publicationId);
      for(const article of articles)selected.add(article.publicationId);
      const merged=events.map(e=>e.mergedInto).filter(Boolean);
      if(merged.length){const targets=await client.query('SELECT payload FROM radar_events WHERE id=ANY($1::text[])',[merged]);targets.rows.forEach(row=>selected.add(row.payload.publicationId));}
      selectedFacts=(await client.query(`SELECT ${thinPublication} AS payload FROM radar_publications WHERE id=ANY($1::text[])`,[[...selected]])).rows.map(row=>row.payload);
    }
    const eventIds = [...new Set(selectedFacts.map(p => p.eventId))], articleIds = [...new Set(selectedFacts.map(p => p.articleId))];
    const articleSql = detailed ? 'payload' : articleSummary;
    const pubSql = detailed ? 'payload' : thinPublication;
    empty.events = (await client.query('SELECT payload FROM radar_events WHERE id=ANY($1::text[]) ORDER BY created_at DESC,id', [eventIds])).rows.map(row => row.payload);
    empty.articles = (await client.query(`SELECT ${articleSql} AS payload FROM radar_articles WHERE id=ANY($1::text[])`, [articleIds])).rows.map(row => row.payload);
    empty.publications = (await client.query(`SELECT ${pubSql} AS payload FROM radar_publications WHERE id=ANY($1::text[])`, [[...selected]])).rows.map(row => row.payload);
    const evidenceIds = [...new Set([...extraEvidence, ...selectedFacts.flatMap(p => [...p.article.evidenceIds, ...p.event.evidenceIds, ...p.event.actions.flatMap(a=>a.evidenceIds), ...(p.article.contextEvidenceIds || [])])])];
    empty.evidence = (await client.query(`SELECT ${detailed ? 'payload' : thinEvidence} AS payload FROM radar_evidence WHERE id=ANY($1::text[])`, [evidenceIds])).rows.map(row => row.payload);
    if (detailed) { const parentIds = empty.evidence.map(e => e.parentId).filter(Boolean); if (parentIds.length) { const parents = await client.query('SELECT payload FROM radar_evidence WHERE id=ANY($1::text[]) OR payload->>\'messageId\'=ANY($1::text[])', [parentIds]); const ids = new Set(empty.evidence.map(e => e.id)); empty.evidence.push(...parents.rows.map(row => row.payload as Evidence).filter(e => !ids.has(e.id))); } }
    if(page){const positions=new Map(page.ids.map((id,index)=>[id,index]));empty.publications.sort((a,b)=>(positions.get(a.id)??0)-(positions.get(b.id)??0));empty.articles.sort((a,b)=>(positions.get(a.publicationId)??0)-(positions.get(b.publicationId)??0));}
    empty.activities = activities;
    if (options.view === 'home' || options.view === 'methodology') empty.forecasts = await getPublicForecast(client, now, facts, options.view === 'home' ? 'home' : true);
    // Preserve the full factual outlook even when only the newest three news cards are returned.
    const data = projectPublicHistory(empty);
    return { data, version: state.version, contentVersion: state.contentVersion, ...(page ? { page } : {}) };
  }));
  return { ...result, data: { ...result.data, serverTime: new Date().toISOString() } };
}

/** Facts and public observations come from the same persisted worker result. */
export async function getPublicRead(options: PublicReadOptions): Promise<PublicReadEnvelope> {
  const result=await getStoredPublicRead(options);
  const now=new Date().toISOString();
  return {...result,data:{...result.data,serverTime:now},version:resetWatchVersion(result.version,undefined,now),contentVersion:resetWatchVersion(result.contentVersion,undefined,now)};
}
