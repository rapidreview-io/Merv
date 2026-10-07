import { createService } from '@merv/contracts';
import type { Context } from 'cordis';
import type {} from '@merv/sessions/types';
import type {} from './types.js';
import type {} from '@merv/code/service';
import { z } from 'zod';
import { CodeService } from './service.js';

export const codePlugin = {
  name: 'merv-code-work',
  /** No settings: several accepted commits are always merged into one base on the server. */
  Config: z.object({}).strict().default({}),
  inject: ['code', 'state', 'scope', 'sessions', 'workflows', 'reviews', 'domainEvents'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const service = await createService(
        new CodeService(ctx.state, ctx.scope, ctx.sessions, ctx.workflows, ctx.reviews, ctx.code),
      );
      yield () => service.close();
      // Where a deployment runs sandboxes, a project check reaches them through this one
      // capability; no tool does, so no leased worker can ever start or stop a machine.
      ctx.inject(['sandboxes'], (ctx) => {
        ctx.effect(() => service.bindChecks(ctx.sandboxes));
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
      // A rented machine that is gone for good ends the writer generation it owed a capture.
      yield await ctx.domainEvents.subscribe({
        id: 'code.writers.machine-gone.v1',
        types: ['session.machine_gone'],
        from: 'now',
        handle: async (event, tx) =>
          await service.machineGone(event.projectId, event.subjectId, tx),
      });
      await service.reconcileAll();
      yield ctx.provide('codeWork', service);
    });
  },
};
export default codePlugin;
