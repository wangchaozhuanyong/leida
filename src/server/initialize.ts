import { insert, transaction } from '../db';
import { sourceDefinitions } from './ingestion';
import { defaultAI } from './ai';
import { defaultSite } from './service';
import type { Activity } from '../lib/types';

/** Initial configuration only. Never imports history or overwrites existing rows. */
export async function initializeRadarDefaults(): Promise<void> {
  await transaction(async client => {
    for (const source of sourceDefinitions) await insert('sources', { ...source, enabled: false }, client);
    await insert('settings', { id: 'site', ...defaultSite }, client);
    await insert('settings', defaultAI, client);
    const activity: Activity = { id: 'challenge-28', title: '连续28天更新活动', timezone: 'America/Los_Angeles', startsOn: '2026-10-05', days: 28, rules: '按活动当地日期记录公开更新。产品改进与重置卡分别记录；暂无收录不表示当天没有更新。', version: 1, items: [] };
    await insert('activities', activity, client);
  });
}
