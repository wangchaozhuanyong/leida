import type { Notice } from './types';

/** Automatic delivery records remain available to the WeChat worker, not the inbox. */
export const customerNotice = (notice: Notice) => notice.status === 'active' && notice.origin === 'admin';
export const compareNotices = (a: Notice, b: Notice) => Number(b.pinned === true) - Number(a.pinned === true) ||
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id);
