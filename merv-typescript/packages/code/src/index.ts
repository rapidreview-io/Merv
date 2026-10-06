import { createService } from '@merv/contracts';
import type { Context } from 'cordis';
import { z } from 'zod';
import { CodeService } from './service.js';
import { githubConfig } from './github-client.js';

const bytes = z.number().int().positive().safe();
const configuration = z
  .object({
    finalizeGraceSeconds: z.number().int().min(1).max(86_400).optional(),
    repositories: z
      .object({
        root: z.string().refine((root) => root.startsWith('/'), 'The root is an absolute path'),
        quotaBytes: bytes.default(10 * 1024 ** 3),
        reservedFreeBytes: bytes.default(2 * 1024 ** 3),
      })
      .strict()
      .optional(),
  })
  .strict()
  .default({});

export const codePlugin = {
  name: 'merv-code',
  Config: configuration,
  inject: ['state', 'scope', 'domainEvents'],
  async apply(ctx: Context, config: z.infer<typeof configuration> = {}) {
    await ctx.effect(async function* () {
      const service = await createService(
        new CodeService(ctx.state, ctx.scope, config, githubConfig()),
      );
      yield () => service.close();
      // A session's attach and end open and end its writer generation. The cursor is durable,
      // so what happened while Code was unloaded is caught up on in order.
      yield await ctx.domainEvents.subscribe({
        id: 'code.writers.v1',
        types: ['session.workspace_attached', 'session.closed'],
        from: 'now',
        handle: async (event, tx) =>
          await service.writers.sessionChanged(
            event.projectId,
            event.subjectId,
            event.type === 'session.workspace_attached' ? 'attached' : 'closed',
            tx,
          ),
      });
      yield ctx.provide('code', service);
    });
  },
};
export default codePlugin;
