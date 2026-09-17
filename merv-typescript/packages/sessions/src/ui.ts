import type { Context } from 'cordis';
import type { Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type {} from './types.js';

export const sessionsUiPlugin = {
  name: 'merv-sessions-ui',
  inject: ['sessions', 'ui'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.ui.register({
        id: 'sessions',
        label: 'Sessions',
        group: 'work',
        order: 24,
        path: '/sessions',
        view: { kind: 'sessions' },
        // The rail asks for one integer on every shell poll, so it is read as one.
        status: async (caller) => ({ count: await ctx.sessions.liveSessionCount(caller) }),
        read: async (caller) => (await ctx.sessions.projectStatus(caller)) as unknown as Json,
      }),
    );
  },
};
export default sessionsUiPlugin;
