import type { Context } from 'cordis';
import { keyId, keyKind, type Json } from '@merv/contracts';
import type { RunningRead } from '@merv/ui/types';
import type {} from './types.js';

export const sessionsUiPlugin = {
  name: 'merv-sessions-ui',
  inject: ['sessions', 'ui'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.ui.register({
        id: 'sessions',
        // Reached from the Work page, which shows what is live; the rail does not list it.
        label: 'Agents and machines',
        group: 'hidden',
        order: 24,
        path: '/sessions',
        view: { kind: 'sessions' },
        read: async (caller) =>
          (await ctx.sessions.dispatch.projectStatus(caller)) as unknown as Json,
      }),
    );
    // The Running page's Sessions lane and the lease sidebars. The
    // marks and the lane's line are one reading of dispatch, taken once per answer.
    const dispatch = (read: RunningRead) =>
      read.once('dispatch', () => ctx.sessions.running.marks(read.caller));
    ctx.effect(() =>
      ctx.ui.contribute({
        owner: 'sessions',
        kinds: ['session'],
        lanes: ['sessions'],
        marks: async (read) => (await dispatch(read)).marks,
        nodes: async (read) => await ctx.sessions.running.nodes(read.caller),
        summary: async (read) => (await dispatch(read)).summary,
        panel: async (read, key) =>
          keyKind(key) === 'session'
            ? await ctx.sessions.running.panel(read.caller, keyId(key), read.route)
            : null,
      }),
    );
  },
};
export default sessionsUiPlugin;
