import type { Context } from 'cordis';
import type {} from '@merv/ui/types';
import type { ResearchAnswer } from './models.js';
import type {} from './types.js';

/** What a cycle's gate may ask of its owner, and what each choice sends, first to apply first. */
const answers = [
  // A definition still unwritten is written on the paper.
  {
    when: 'refused',
    name: 'research_definition_required',
    moves: [{ label: 'Write the definition', row: 'paper' }],
  },
  // An automatic run stopped by a changed definition goes on once its owner accepts it.
  {
    when: 'stopped',
    name: 'research_definition_changed',
    moves: [{ label: 'Accept changed definition' }],
  },
  // A consolidation task that ended without acceptance: inject a fresh one.
  {
    when: 'refused',
    name: 'integration_failed',
    moves: [{ label: 'Retry consolidation', input: { retryIntegration: true } }],
  },
] satisfies ResearchAnswer[];
export const researchUiPlugin = {
  name: 'merv-research-ui',
  inject: ['research', 'ui'],
  apply(ctx: Context) {
    const research = ctx.research;
    // The work, framed by its cycle: it stands under Home at the head of the rail.
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
        label: 'Rounds',
        // The cycles frame the Work page, which reaches them; the rail does not list them.
        group: 'hidden',
        order: 14,
        path: '/research',
        workflow: 'research',
        view: { kind: 'research', answers },
        home: {
          list: async (caller) => await research.home(caller),
          keep: [
            'id',
            'name',
            'ownerId',
            'workflow',
            'researchDependencies',
            'progress',
            'automation',
            'writable',
            // An ended cycle nothing follows yet is the one a new cycle started beside it follows.
            'successorId',
          ],
        },
        // A cycle stops on its own consolidation, declared after the work it waits on, which
        // may fail and stop nothing.
        needs: {
          name: 'name',
          owner: 'ownerId',
          stops: ['integration_failed'],
        },
        // One cycle and the stage it stands at, read without running an action's check: its
        // page polls this and draws no action (its move reads its own gate).
        page: (caller, id) => research.page(caller, id),
        // Open work: a cycle that has not yet completed, been abandoned or failed.
        status: async (caller) => ({ count: await research.active(caller) }),
      }),
    );
  },
};
export default researchUiPlugin;
