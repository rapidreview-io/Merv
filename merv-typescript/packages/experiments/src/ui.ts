import type { Context } from 'cordis';
import { check } from '@merv/contracts';
import type { Json } from '@merv/contracts';
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
        // One record, with the gate it stands at: the process graph is derived from the
        // same record, so the page reads both in one answer rather than two.
        read: async (caller, params) => {
          const id = params?.id;
          check(
            typeof id === 'string' && id.length > 0,
            'invalid_input',
            'params.id names the record',
          );
          return JSON.parse(
            JSON.stringify({
              experiment: await experiments.get(caller, id),
              process: await experiments.process(caller, id),
            }),
          ) as Json;
        },
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
