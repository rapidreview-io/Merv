import type { Context } from 'cordis';
import type { Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type {} from './types.js';
export const researchUiPlugin = {
  name: 'merv-research-ui',
  inject: ['research', 'ui'],
  apply(ctx: Context) {
    const research = ctx.research;
    // The wave of work, framed by its cycle: it stands under Home at the head of the rail.
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
        // The cycles frame the Work page, which reaches them; the rail does not list them.
        group: 'hidden',
        order: 14,
        path: '/research',
        workflow: 'research',
        view: { kind: 'research' },
        home: {
          tool: 'research.list',
          keep: [
            'id',
            'name',
            'ownerId',
            'workflow',
            'researchDependencies',
            'progress',
            'reflectionId',
            'automation',
          ],
        },
        // A cycle stops on its own wave or consolidation, declared after the work it reflects
        // on, which may fail and stop nothing.
        needs: {
          name: 'name',
          owner: 'ownerId',
          stops: ['dependency_failed', 'integration_failed'],
        },
        read: async (caller) => JSON.parse(JSON.stringify(await research.list(caller))) as Json,
        // Open work: a cycle that has not yet completed, been abandoned or failed.
        status: async (caller) => ({ count: await research.active(caller) }),
      }),
    );
  },
};
export default researchUiPlugin;
