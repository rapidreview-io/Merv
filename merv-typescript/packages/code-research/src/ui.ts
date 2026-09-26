import type { Context } from 'cordis';
import type { Json } from '@merv/contracts';
import type { RunningRead } from '@merv/ui/types';
import type {} from './types.js';

export const codeUiPlugin = {
  name: 'merv-code-ui',
  inject: ['codeResearch', 'ui'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.ui.register({
        id: 'code',
        label: 'Code',
        group: 'work',
        order: 25,
        path: '/code',
        view: { kind: 'code' },
        // `commands` are the commit receipts; the store transfers of the same name are
        // inside status. A sealed proposal is read on the record that made it, not here.
        read: async (caller) =>
          ({
            commands: await ctx.codeResearch.list(caller),
            status: await ctx.codeResearch.status(caller),
          }) as unknown as Json,
      }),
    );
    // The Running page: the work Code holds for a person, its check machines, and the Code
    // section of work with a unit. The marks and the lane line are one read per answer.
    const holds = (read: RunningRead) =>
      read.once('holds', () => ctx.codeResearch.runningHolds(read.caller));
    ctx.effect(() =>
      ctx.ui.contribute({
        owner: 'code-research',
        kinds: ['check'],
        lanes: ['hardware'],
        marks: async (read) => (await holds(read)).marks,
        // A read that failed is already named where its marks stand, in the work lane.
        summary: async (read) => (await holds(read).catch(() => null))?.summary ?? null,
        nodes: async (read) => ({ nodes: await ctx.codeResearch.runningChecks(read.caller) }),
        panel: async (read, key) => await ctx.codeResearch.runningPanel(read.caller, key),
        sections: async (read, keys) => await ctx.codeResearch.runningCode(read.caller, keys),
      }),
    );
  },
};
export default codeUiPlugin;
