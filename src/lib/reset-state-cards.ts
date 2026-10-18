/** One presentation model for the website and the native miniprogram. */
export {resetStateCards} from '../../miniprogram/utils/reset-state-cards.js';
export type ResetStateCard = ReturnType<typeof import('../../miniprogram/utils/reset-state-cards.js').resetStateCards>['cards'][number];
