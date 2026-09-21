import { createService } from '@merv/contracts';
import type { Context } from 'cordis';
import type {} from '@merv/sessions/types';
import type {} from './types.js';
import { z } from 'zod';
import { CodeService } from './service.js';
import { githubConfig } from './github-client.js';

const bytes = z.number().int().positive().safe();
const configuration = z
  .object({
    /** Where Code keeps one repository per project. Without it the server keeps none. */
    repositories: z
      .object({
        root: z.string().refine((root) => root.startsWith('/'), 'The root is an absolute path'),
        quotaBytes: bytes.optional(),
        reservedFreeBytes: bytes.optional(),
        sweepSeconds: z.number().int().min(1).max(86_400).optional(),
        drainSeconds: z.number().int().min(1).max(3600).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .default({});

export const codePlugin = {
  name: 'merv-code',
  Config: configuration,
  inject: ['state', 'scope', 'sessions', 'artifacts', 'workflows', 'domainEvents'],
  async apply(ctx: Context, config: z.infer<typeof configuration> = {}) {
    await ctx.effect(async function* () {
      const service = await createService(
        new CodeService(
          ctx.state,
          ctx.scope,
          ctx.sessions,
          ctx.artifacts,
          ctx.workflows,
          githubConfig(),
          undefined,
          config.repositories && { config: config.repositories },
        ),
      );
      yield () => service.close();
      // The cursor starts now because the start-up pass below covers everything before it;
      // afterwards the consumer catches up on whatever ended while Code was unloaded.
      yield await ctx.domainEvents.subscribe({
        id: 'code.reconcile.v1',
        types: ['workflow.transition'],
        from: 'now',
        handle: async (event, tx) => await service.transitioned(event, tx),
      });
      await service.reconcileAll();
      yield ctx.provide('code', service);
    });
  },
};
export default codePlugin;
