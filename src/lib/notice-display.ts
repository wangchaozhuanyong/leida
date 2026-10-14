import type { Notice } from './types';

export const customerNotice = (notice: Notice) => notice.status === 'active' &&
  (notice.origin === 'admin' || notice.categories.some(category => ['announcement','result','correction'].includes(category)));
