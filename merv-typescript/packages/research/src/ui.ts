import type { Context } from 'cordis';
import type { Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type {} from './types.js';
export const researchUiPlugin = {
  name: 'merv-research-ui',
  inject: ['research', 'ui'],
  apply(ctx: Context) {
    const research = ctx.research;
    // The wave of work, framed by its cycle: it leads the rail, and a project opens on it.
    ctx.effect(() =>
      ctx.ui.register({
        id: 'work',
        label: 'Work',
        group: 'lead',
        order: 14,
        path: '/work',
        view: { kind: 'work' },
      }),
    );
    ctx.effect(() =>
      ctx.ui.register({
        id: 'research',
        label: 'Cycles',
        group: 'work',
        order: 14,
        path: '/research',
        view: { kind: 'research' },
        home: { tool: 'research.list', keep: ['id', 'name', 'ownerId', 'workflow'] },
        read: async (caller) => JSON.parse(JSON.stringify(await research.list(caller))) as Json,
        // Open work: a cycle that has not yet completed, been abandoned or failed.
        status: async (caller) => ({ count: await research.active(caller) }),
      }),
    );
  },
};
export default researchUiPlugin;
