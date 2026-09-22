import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from './types.js';

/** Optional machine HTTP controls; command authority stays with the Code provider. */
export const codeApiPlugin = {
  name: 'merv-code-api',
  inject: ['api', 'codeResearch'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.api.registerCode(ctx.codeResearch));
  },
};
export default codeApiPlugin;
