import { createService } from '@merv/contracts';
import type { Context } from 'cordis';
import type {} from '@merv/sessions/types';
import type {} from './types.js';
import { CodeService } from './service.js';

export const codePlugin = {
  name: 'merv-code',
  inject: ['state', 'scope', 'sessions', 'artifacts'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const service = await createService(
        new CodeService(ctx.state, ctx.scope, ctx.sessions, ctx.artifacts),
      );
      yield () => service.close();
      yield ctx.provide('code', service);
    });
  },
};
export default codePlugin;
