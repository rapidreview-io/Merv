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
    // The Running page's Sessions lane, the lease sidebars and the Sessions rows on work. The
    // marks and the lane's line are one reading of dispatch, taken once per answer.
    const dispatch = (read: RunningRead) =>
      read.once('dispatch', () => ctx.sessions.runningMarks(read.caller));
    ctx.effect(() =>
      ctx.ui.contribute({
        owner: 'sessions',
        kinds: ['session'],
        lanes: ['sessions'],
        marks: async (read) => (await dispatch(read)).marks,
        nodes: async (read) => await ctx.sessions.running(read.caller),
        summary: async (read) => (await dispatch(read)).summary,
        panel: async (read, key) =>
          keyKind(key) === 'session'
            ? await ctx.sessions.runningPanel(read.caller, keyId(key))
            : null,
        sections: async (read, keys) => {
          const work = keys.filter((key) => keyKind(key) === 'work').map(keyId);
          return work.length ? await ctx.sessions.runningWork(read.caller, work) : [];
        },
      }),
    );
  },
};
export default sessionsUiPlugin;
