import type { Context } from 'cordis';
import { z } from 'zod';
import type {} from '@merv/api/types';
import { SandboxRuns, sandboxRunMigrations } from './sandbox-runs.js';
import { SandboxEvidence } from './sandbox-evidence.js';
import { SandboxComputeWaits } from './compute-waits.js';
import { historicalEvidenceDownloads } from './historical-evidence.js';
import { sandboxesPeoplePlugin } from './people.js';
import { sandboxesCreditsPlugin } from './credits.js';

const Config = z
  .object({
    legacyCaptures: z.object({ namespace: z.string() }).optional(),
    // Positive USD, to 6 places, each person's own account is granted once per provider.
    newPersonCredits: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        z.string().regex(/^(?=.*[1-9])\d{1,9}(\.\d{1,6})?$/),
      )
      .default({}),
  })
  .strict()
  .default({});

/** The Sandboxes tools the 2026-10-20 consolidation retired, which answer where they went for one
 *  release: `sandboxes.job_status` is `sandboxes.job with action=status`. */
const moved: Record<string, string> = {
  'sandbox.extend': 'sandboxes.sandbox_renew',
  'sandbox.release': 'sandboxes.sandbox_delete',
  'sandboxes.providers_list': 'sandboxes.sandbox_providers',
  'sandboxes.usage_report': 'sandboxes.spend_report',
};
export const retired = (name: string) => {
  const [, tool, action] =
    /^(sandboxes\.(?:sandbox|job|storage|workflow|access|spend))_([a-z]+)$/.exec(
      moved[name] ?? name,
    ) ?? [];
  return !!tool && `${tool} with action=${action}`;
};

export const sandboxIntegrationPlugin = {
  name: 'merv-sandbox-integration',
  inject: [
    'state',
    'scope',
    'tools',
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
      const runs = new SandboxRuns(ctx.state, ctx.scope, ctx.workflows, ctx.sbxMerv);
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
      const runTimer = setInterval(() => runs.reconcile().catch(() => {}), 1000).unref();
      const evidenceTimer = setInterval(() => evidence.reconcile().catch(() => {}), 5000).unref();
      void runs.reconcile().catch(() => {});
      void evidence.reconcile().catch(() => {});
      yield async () => {
        clearInterval(runTimer);
        clearInterval(evidenceTimer);
        await runs.close();
        await evidence.close();
      };
      yield ctx.tools.rename(retired);
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
