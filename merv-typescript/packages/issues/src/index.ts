import { bootMaintenance } from '@merv/contracts/maintenance';
import type { Context } from 'cordis';
import type {} from '@merv/sessions/types';
import { z } from 'zod';
import { slackConfig, slackSink } from './alerts.js';
import { issueMigrations } from './schema.js';
import { IssueStore } from './store.js';
import { floods, pin, quiet, type Traces } from './watch.js';

export { IssueStore } from './store.js';

export const Config = z
  .object({ alerts: z.object({ slack: slackConfig.optional() }).strict().default({}) })
  .strict()
  .default({});

/**
 * Issues: the store owners report to, its watches and its alerts. Nothing injects it: an owner's
 * `reporter(ctx)` looks it up at each report, so it may be absent, reloading or failing.
 */
export const issuesPlugin = {
  name: 'merv-issues',
  Config,
  inject: ['state'],
  apply(ctx: Context, config: z.infer<typeof Config>) {
    ctx.effect(async function* () {
      await ctx.state.migrate('issues', issueMigrations);
      const slack = config.alerts.slack;
      const store = new IssueStore(ctx.state, slack && slackSink(slack));
      const scan = await floods(ctx.state, store);
      // Sessions is looked up at each pass, never injected.
      const traces: Traces = (ids) => ctx.get('sessions')?.running.platformTrace(ids);
      // Every pass waits while boot maintenance holds the process.
      const pass = (task: () => Promise<unknown>) => () =>
        void (bootMaintenance.active || task().catch(() => {}));
      const timers = (
        [
          [1_000, () => store.flush()],
          [30_000, () => store.alertPass()],
          [60_000, () => Promise.all([quiet(ctx.state), pin(ctx.state, traces)])],
          [300_000, scan],
        ] as const
      ).map(([ms, task]) => {
        const timer = setInterval(pass(task), ms);
        timer.unref();
        return timer;
      });
      // What a previous process left owed, a crash loop's included, is sent at once.
      pass(() => store.alertPass())();
      yield async () => {
        for (const timer of timers) clearInterval(timer);
        await store.drain();
      };
      yield ctx.provide('issues', store);
    });
  },
};

export default issuesPlugin;
