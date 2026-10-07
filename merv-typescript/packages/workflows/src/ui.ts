import type { Context } from 'cordis';
import { runningKey, type RunningMark, type Workflows } from '@merv/contracts';
import type {} from '@merv/ui/types';

/**
 * Work whose rounds are used up, or that waits for another round to move on, marked on its own
 * card in the words every owner's work shares, with the move only a project admin makes: one
 * more round, the reason written, each press its own request. The card's owner says the rest;
 * its own red outranks the mark, which then lends it this control.
 */
export function limitMarks({ admin, items }: Awaited<ReturnType<Workflows['escalated']>>) {
  return items.map(({ instanceId, limit }): RunningMark => ({
    key: runningKey('work', instanceId),
    ...(limit.exhausted
      ? {
          says: ['Every round of ', { mono: limit.name }, ' is used · ', { count: limit.used }],
          who: 'A project admin allows another round, or a person takes the next step by hand or ends it',
        }
      : {
          says: ['Waits for another round of ', { mono: limit.name }],
          who: 'A project admin allows another round',
        }),
    ...(admin
      ? {
          action: {
            label: 'Allow another round',
            verb: 'extend',
            tool: 'workflow.extend_limit',
            input: { instanceId, limit: limit.name, additional: 1 },
            allowed: true,
            guard: {
              title: 'Allow another round?',
              consequence:
                'The work may be returned once more. Past that round it waits for a person again.',
            },
            ask: { field: 'reason', label: 'Reason', value: 'One more round is worth it' },
            requestId: true,
          },
        }
      : {}),
  }));
}

export const workflowsUiPlugin = {
  name: 'merv-workflows-ui',
  inject: ['workflows', 'ui'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.ui.contribute({
        owner: 'workflows',
        marks: async (read) => limitMarks(await ctx.workflows.escalated(read.caller)),
      }),
    );
  },
};
export default workflowsUiPlugin;
