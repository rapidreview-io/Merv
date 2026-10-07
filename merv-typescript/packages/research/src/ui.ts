import type { Context } from 'cordis';
import type { Json } from '@merv/contracts';
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
  // An approved plan that continues: open its work and the next cycle, or complete without them.
  {
    when: 'asks',
    name: 'nextWave',
    moves: [
      { label: 'Create next wave', input: { nextWave: 'create' } },
      { label: 'Skip next wave', input: { nextWave: 'skip' } },
    ],
  },
  // A consolidation task that ended without acceptance: inject a fresh one.
  {
    when: 'refused',
    name: 'integration_failed',
    moves: [{ label: 'Retry consolidation', input: { retryIntegration: true } }],
  },
  // A wave that ended unapproved stops its cycle, though work it reflects on may fail and still
  // be read: the wave where it stands, and the end the gate offers instead.
  {
    when: 'refused',
    name: 'dependency_failed',
    moves: [
      {
        label: 'End cycle',
        tool: 'research.end',
        failed: 'reflection',
        input: { outcome: 'abandoned', reason: 'The wave this cycle reflected on was abandoned.' },
      },
    ],
  },
] satisfies ResearchAnswer[];
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
            'reflectionId',
            'automation',
            'writable',
            // An ended cycle nothing follows yet is the one a new cycle started beside it follows.
            'successorId',
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
