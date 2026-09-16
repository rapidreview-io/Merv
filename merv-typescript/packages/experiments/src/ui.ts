import type { Context } from 'cordis';
import type {} from '@merv/ui/types';
import type {} from './types.js';

export const experimentsUiPlugin = {
  name: 'merv-experiments-ui',
  inject: ['experiments', 'ui'],
  apply(ctx: Context) {
    const experiments = ctx.experiments;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'experiments',
        label: 'Experiments',
        group: 'work',
        order: 16,
        path: '/experiments',
        view: { kind: 'experiments' },
        // Open work: an experiment still on its way to a result. A complete,
        // abandoned or failed record is read, not worked, so it is not counted.
        status: async (caller) => ({
          count: (await experiments.list(caller)).filter(
            (experiment) =>
              !['complete', 'abandoned', 'failed'].includes(experiment.workflow.state),
          ).length,
        }),
      }),
    );
  },
};
export default experimentsUiPlugin;
