import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from './types.js';

/** Optional transport adapter; session authority lives with the Sessions provider. */
export const sessionsApiPlugin = {
  name: 'merv-sessions-api',
  inject: ['sessions', 'api'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.api.registerSessions(ctx.sessions));
  },
};
export default sessionsApiPlugin;
