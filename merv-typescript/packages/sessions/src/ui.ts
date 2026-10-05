import type { Context } from 'cordis';
import { check, keyId, keyKind, type Json } from '@merv/contracts';
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
        read: async (caller, params) => {
          if (params?.agentId !== undefined) {
            check(
              typeof params.agentId === 'string',
              'invalid_input',
              'params.agentId names the agent',
            );
            return (await ctx.sessions.agentObservation(caller, params.agentId)) as unknown as Json;
          }
          return (await ctx.sessions.projectStatus(caller)) as unknown as Json;
        },
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
            ? await ctx.sessions.runningPanel(read.caller, keyId(key), read.route)
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
