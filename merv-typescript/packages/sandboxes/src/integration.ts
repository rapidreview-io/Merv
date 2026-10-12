import type { Context } from 'cordis';
import { SandboxRuns, sandboxRunMigrations } from './sandbox-runs.js';
import { SandboxEvidence } from './sandbox-evidence.js';
import { historicalEvidenceDownloads } from './historical-evidence.js';

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
  ],
  async apply(ctx: Context, config: { legacyCaptures?: { namespace: string } } = {}) {
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
      const runTimer = setInterval(() => runs.reconcile().catch(() => {}), 1000);
      const evidenceTimer = setInterval(() => evidence.reconcile().catch(() => {}), 5000);
      runTimer.unref();
      evidenceTimer.unref();
      void runs.reconcile().catch(() => {});
      void evidence.reconcile().catch(() => {});
      yield async () => {
        clearInterval(runTimer);
        clearInterval(evidenceTimer);
        await runs.close();
        await evidence.close();
      };
      yield ctx.sessions.registerLaunchConnections((session) => runs.launchConnections(session));
    });
  },
};
export default sandboxIntegrationPlugin;
