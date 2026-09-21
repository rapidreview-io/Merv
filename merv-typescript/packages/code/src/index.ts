import { createService } from '@merv/contracts';
import type { Context } from 'cordis';
import type {} from '@merv/sessions/types';
import type {} from './types.js';
import { CodeService } from './service.js';
import { githubConfig } from './github-client.js';

export const codePlugin = {
  name: 'merv-code',
  inject: ['state', 'scope', 'sessions', 'artifacts', 'workflows', 'domainEvents'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const service = await createService(
        new CodeService(
          ctx.state,
          ctx.scope,
          ctx.sessions,
          ctx.artifacts,
          ctx.workflows,
          githubConfig(),
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
