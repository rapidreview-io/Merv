import { createService } from '@merv/contracts';
import type { Context } from 'cordis';
import type {} from '@merv/sessions/types';
import type {} from './types.js';
import type {} from '@merv/code/service';
import type {} from '@merv/api/types';
import { z } from 'zod';
import { SandboxCheckRunner } from './checks.js';
import { CodeService } from './service.js';

export const codePlugin = {
  name: 'merv-code-work',
  /** `mainLanding`: accepted work lands on Merv's main on the local research baseline (landing.ts). */
  Config: z
    .object({ mainLanding: z.boolean().default(false) })
    .strict()
    .default({}),
  inject: ['code', 'state', 'scope', 'sessions', 'workflows', 'reviews', 'domainEvents'],
  async apply(ctx: Context, config: { mainLanding?: boolean } = {}) {
    await ctx.effect(async function* () {
      const service = await createService(
        new CodeService(
          ctx.state,
          ctx.scope,
          ctx.sessions,
          ctx.workflows,
          ctx.reviews,
          ctx.code,
          {},
          config,
        ),
      );
      yield () => service.close();
      // Checks use a service actor; leased workers cannot invoke this runner.
      ctx.inject(
        ['sbxMerv', 'sbxObjects', 'sbxPipelines', 'sbxRegistry', 'sbxJobs', 'sbxSnapshots'],
        (ctx) => {
          ctx.effect(() => service.bindChecks(new SandboxCheckRunner(ctx)));
        },
      );
      ctx.inject(['tools'], (ctx) => {
        ctx.effect(() => service.bindGuidance(ctx.tools));
      });
      // New projects initialize automatically; old unbound projects initialize on new work.
      yield await ctx.domainEvents.subscribe({
        id: 'code.projects.v1',
        types: ['project.created'],
        from: 'now',
        handle: async (event, tx) => await service.projectCreated(event.projectId, tx),
      });
      // The startup pass covers earlier transitions; this cursor retains later ones.
      yield await ctx.domainEvents.subscribe({
        id: 'code.reconcile.v1',
        types: ['workflow.transition'],
        from: 'now',
        handle: async (event, tx) => await service.transitioned(event, tx),
      });
      await service.reconcileAll();
      yield ctx.provide('codeWork', service);
    });
  },
};
export default codePlugin;
