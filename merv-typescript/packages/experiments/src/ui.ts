import type { Context } from 'cordis';
import { check } from '@merv/contracts';
import type { Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type {} from './types.js';
import { EXPERIMENT_STATES } from './running.js';

export const experimentsUiPlugin = {
  name: 'merv-experiments-ui',
  inject: ['experiments', 'ui'],
  apply(ctx: Context) {
    const experiments = ctx.experiments;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'experiments',
        label: 'Experiments',
        // Reached from the Work page and its records; the rail does not list it.
        group: 'hidden',
        order: 16,
        path: '/experiments',
        workflow: 'experiment',
        states: EXPERIMENT_STATES,
        view: { kind: 'experiments' },
        home: {
          tool: 'experiment.list',
          keep: ['id', 'name', 'intent', 'ownerId', 'conclusion', 'workflow', 'settled', 'failed'],
          list: async (caller) => await experiments.summaries(caller),
        },
        needs: {
          name: 'name',
          owner: 'ownerId',
          reads: { design_review: 'Review this design', experiment_review: 'Review these results' },
        },
        // One record, with the stage it stands at and its history, both from one graph read
        // without running an action's check: the page polls this and draws no action.
        read: async (caller, params) => {
          const id = params?.id;
          check(
            typeof id === 'string' && id.length > 0,
            'invalid_input',
            'params.id names the record',
          );
          return JSON.parse(
            JSON.stringify({
              ...(await experiments.page(caller, id)),
              codeUnit: await experiments.codeUnit(caller, id),
            }),
          ) as Json;
        },
        // Open work: an experiment still on its way to a result. A complete,
        // abandoned or failed record is read, not worked, so it is not counted.
        status: async (caller) => ({ count: (await experiments.occupancy(caller)).active }),
      }),
    );
    // On the Running page: open experiments in the work lane, and the sidebar of each.
    ctx.effect(() =>
      ctx.ui.contribute({
        owner: 'experiments',
        kinds: ['work'],
        workflows: ['experiment'],
        lanes: ['work'],
        nodes: async (read) => ({ nodes: await experiments.running(read.caller, read.include) }),
        panel: async (read, key) => await experiments.runningPanel(read.caller, key, read.route),
      }),
    );
  },
};
export default experimentsUiPlugin;
