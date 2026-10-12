import { transaction } from '../db';
import type { PublicData, Source } from '../lib/types';
import { hash } from './domain';
import { PUBLIC_HISTORY_RULE_VERSION } from '../lib/history';
import {forecastRevision} from '../lib/forecast-display';
import {getPublicForecast} from './forecast';

interface RevisionParts {
  publicationCount: number;
  publicationKey: string;
  siteVersion: number;
  activities: { id: string; version: number }[];
  sources: PublicData['sources'];
  forecasts: unknown;
}

function revision(parts: RevisionParts): string {
  return hash(JSON.stringify({
    historyRuleVersion: PUBLIC_HISTORY_RULE_VERSION,
    ...parts,
    activities: parts.activities.slice().sort((a, b) => a.id.localeCompare(b.id)),
    sources: parts.sources.map(({ id, status, lastSuccessAt }) => ({ id, status, lastSuccessAt }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  })).slice(0, 24);
}

export function publicRevision(data: PublicData): string {
  return revision({
    publicationCount: data.publications.length,
    publicationKey: data.publications.map(p => p.id).sort().at(-1) ?? '',
    siteVersion: data.site.version,
    activities: data.activities.map(({ id, version }) => ({ id, version })),
    sources: data.sources,
    forecasts: forecastRevision(data.forecasts),
  });
}

// Only public change metadata is read; unpublished candidates and AI configuration stay private.
export async function getPublicVersion(): Promise<string> {
  return transaction(async c => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const publications = await c.query('SELECT count(*)::int AS count, coalesce(max(id), \'\') AS key FROM radar_publications');
    const site = await c.query("SELECT (payload->>'version')::int AS version FROM radar_settings WHERE id='site'");
    const activities = await c.query("SELECT id, (payload->>'version')::int AS version FROM radar_activities");
    const sourceRows = await c.query('SELECT payload FROM radar_sources');
    const sources = sourceRows.rows.map(({ payload }: { payload: Source }) => {
      let status = payload.status;
      if (payload.enabled && status === 'paused') status = payload.lastSuccessAt ? 'healthy' : 'unconnected';
      if (payload.enabled && payload.lastSuccessAt && Date.now() - Date.parse(payload.lastSuccessAt) > payload.intervalMinutes * 3 * 60_000) status = 'delayed';
      return { id: payload.id, name: payload.name, status, lastSuccessAt: payload.lastSuccessAt };
    });
    const forecasts=await getPublicForecast(c);
    return revision({ publicationCount: publications.rows[0].count, publicationKey: publications.rows[0].key,
      siteVersion: site.rows[0]?.version ?? 1, activities: activities.rows, sources, forecasts:forecastRevision(forecasts) });
  });
}
