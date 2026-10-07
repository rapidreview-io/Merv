import { createService } from '@merv/contracts';
import type { Context } from 'cordis';
import { WorkflowsService } from './service.js';

export { WorkflowsService } from './service.js';
export type { WorkflowHistoryEntry } from './models.js';

export const workflowsPlugin = {
  name: 'merv-workflows',
  inject: ['state', 'scope'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const workflows = await createService(new WorkflowsService(ctx.state, ctx.scope));
      yield () => workflows.close();
      yield ctx.provide('workflows', workflows);
    });
  },
};

export default workflowsPlugin;
