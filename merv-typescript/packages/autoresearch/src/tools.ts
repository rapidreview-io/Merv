import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { z } from 'zod';
import type {} from './types.js';

const requestId = z.string().min(1).max(200);
const usd = z.number().min(0).max(100_000);

export const autoresearchToolsPlugin = {
  name: 'merv-autoresearch-tools',
  inject: ['autoresearch', 'tools'],
  apply(ctx: Context) {
    const autoresearch = ctx.autoresearch;
    ctx.effect(() =>
      ctx.tools.noun('autoresearch.read', {
        tier: 'deferred',
        readOnly: true,
        summary: 'Read whether autoresearch is on, its spend and the manager’s decisions.',
        description:
          'Read the project’s autoresearch: whether it is on, where its manager stands, the spend this round against the cap, the runs the manager started and its one-line decision at each wake, newest first.',
        actions: {
          status: {
            description:
              'Autoresearch’s settings, state, spend against the cap, wake count and limit, runs and decision lines.',
            input: z.strictObject({}),
            handler: (caller) => autoresearch.status(caller),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('autoresearch.write', {
        tier: 'deferred',
        for: 'people',
        summary: 'Turn autoresearch on or off, set its cap, pause, resume or end a round.',
        description:
          'Change the project’s autoresearch. configure (project admin): enabled, goal, capUsd (what a round may spend on Sandboxes compute), runEstimateUsd (held back per run while it runs) and wakeLimit (automatic wakes in a row before it waits for you); turning it on starts the manager. pause and resume stop and restart the loop; start_round begins a new round after one ended; end_round ends a waiting or paused round.',
        actions: {
          configure: {
            act: { title: 'Save autoresearch settings' },
            description:
              'Project admin: set autoresearch’s settings. Off by default; enabled: true needs a goal and starts the manager’s round at once. Raising capUsd while it is paused at the cap lets the manager go on.',
            input: z.strictObject({
              enabled: z.boolean().optional(),
              goal: z.string().min(1).max(4000).optional(),
              capUsd: usd.optional(),
              runEstimateUsd: usd.optional(),
              wakeLimit: z.number().int().min(1).max(1000).optional(),
              requestId,
            }),
            handler: (caller, input) => autoresearch.configure(caller, input),
          },
          pause: {
            act: { title: 'Pause autoresearch' },
            description: 'Stop the loop: the manager is not woken until you resume it.',
            input: z.strictObject({ requestId }),
            handler: (caller, input) => autoresearch.control(caller, 'pause', input),
          },
          resume: {
            act: { title: 'Resume autoresearch' },
            description:
              'Restart a paused loop: the manager reads what finished meanwhile, and its count of automatic wakes starts again.',
            input: z.strictObject({ requestId }),
            handler: (caller, input) => autoresearch.control(caller, 'resume', input),
          },
          start_round: {
            act: { title: 'Start a new round' },
            description:
              'Begin a new round after one ended, optionally with a new goal: the same manager continues, and the round’s spend starts from zero.',
            input: z.strictObject({ goal: z.string().min(1).max(4000).optional(), requestId }),
            handler: (caller, input) => autoresearch.control(caller, 'start_round', input),
          },
          end_round: {
            act: { title: 'End the round' },
            description:
              'End a waiting or paused round. Work already started keeps its own lifecycle.',
            input: z.strictObject({ summary: z.string().min(1).max(4000).optional(), requestId }),
            handler: (caller, input) => autoresearch.control(caller, 'end_round', input),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'autoresearch.decide',
        tier: 'worker',
        description:
          'Autoresearch manager only: end this visit with your decision. next "wait" waits for the work you started (you wake in this same conversation as soon as any of it ends); next "end" ends the round, with a summary of what it found. note is the one line the person reads about this decision, at most 200 characters. Stop after calling it.',
        inputSchema: z.strictObject({
          autoresearchId: z.string().min(1),
          expectedRevision: z.number().int().nonnegative(),
          note: z.string().min(1).max(200),
          next: z.enum(['wait', 'end']),
          summary: z.string().min(1).max(4000).optional(),
          requestId,
        }),
        handler: (caller, input) => autoresearch.decide(caller, input),
      }),
    );
  },
};
export default autoresearchToolsPlugin;
