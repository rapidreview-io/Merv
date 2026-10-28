import type { Context } from 'cordis';
import { z } from 'zod';
import { reporter, swallowed } from '@merv/contracts/issues';
import { SandboxRuns, sandboxRunMigrations } from './sandbox-runs.js';
import { SandboxEvidence } from './sandbox-evidence.js';
import { SandboxComputeWaits } from './compute-waits.js';
import { historicalEvidenceDownloads } from './historical-evidence.js';
import { sandboxesPeoplePlugin } from './people.js';
import { sandboxesCreditsPlugin } from './credits.js';

const usd = z.string().regex(/^(?=.*[1-9])\d{1,9}(\.\d{1,6})?$/);
const Config = z
  .object({
    legacyCaptures: z.object({ namespace: z.string() }).optional(),
    // Positive USD, to 6 places, each person's own account is granted once per provider, or
    // { monthly } on the 1st of every month.
    newPersonCredits: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        z.union([usd, z.object({ monthly: usd }).strict()]),
      )
      .default({}),
  })
  .strict()
  .default({});

export const sandboxIntegrationPlugin = {
  name: 'merv-sandbox-integration',
  inject: [
    'state',
    'scope',
    'workflows',
    'domainEvents',
    'sessions',
    'artifacts',
    'sbxMerv',
    'sbxPipelines',
    'sbxObjects',
    'sbxAccounts',
    'sbxJobs',
    'sbxRegistry',
  ],
  Config,
  async apply(ctx: Context, config: z.output<typeof Config> = Config.parse({})) {
    ctx.plugin(sandboxesPeoplePlugin, { newPersonCredits: config.newPersonCredits });
    ctx.plugin(sandboxesCreditsPlugin);
    await ctx.effect(async function* () {
      await ctx.state.migrate('sandbox-runs', sandboxRunMigrations);
      const issues = reporter(ctx);
      const runs = new SandboxRuns(ctx.state, ctx.scope, ctx.workflows, ctx.sbxMerv);
      runs.issues = issues;
      const evidence = new SandboxEvidence(
        ctx.state,
        ctx.scope,
        ctx.artifacts,
        ctx.sbxPipelines,
        ctx.sbxObjects,
        ctx.sbxAccounts,
        Date.now,
        ctx.sbxJobs,
      );
      await evidence.initialize();
      yield ctx.provide('sandboxEvidence', evidence);
      yield ctx.artifacts.registerFileProvider('sbx-evidence', evidence);
      const historical = historicalEvidenceDownloads(
        ctx.state,
        ctx.sbxObjects,
        config.legacyCaptures?.namespace,
      );
      yield ctx.artifacts.registerFileProvider('sandboxes-native', historical);
      yield ctx.artifacts.registerFileProvider('sandboxes', historical);
      yield await ctx.domainEvents.subscribe({
        id: 'sandboxes.runs.v1',
        types: ['session.closed', 'workflow.transition'],
        from: 'now',
        handle: (event, tx) => runs.event(event, tx),
      });
      // Each pass now and on its interval; a failed one is retried by the next.
      const repeat = (where: string, pass: () => Promise<void>, ms: number) => {
        const failed = swallowed(issues, where);
        void pass().catch(failed);
        return setInterval(() => pass().catch(failed), ms).unref();
      };
      const runTimer = repeat('sandboxes.runs', () => runs.reconcile(), 1000);
      const evidenceTimer = repeat('sandboxes.evidence', () => evidence.reconcile(), 5000);
      yield async () => {
        clearInterval(runTimer);
        clearInterval(evidenceTimer);
        await runs.close();
        await evidence.close();
      };
      yield ctx.sessions.registerLaunchConnections((session) => runs.launchConnections(session));
      // Where a waiting visit's jobs and workflows stand, which Sessions asks (session.await_compute).
      yield ctx.sessions.computeWaits.register(
        new SandboxComputeWaits(
          ctx.state,
          ctx.sbxMerv,
          ctx.sbxJobs,
          ctx.sbxPipelines,
          ctx.sbxRegistry,
          evidence,
        ),
      );
    });
  },
};
export default sandboxIntegrationPlugin;
