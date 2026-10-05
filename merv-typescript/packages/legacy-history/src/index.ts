import type { Context } from 'cordis';
import { initializeLegacyHistory, LegacyHistoryReader } from './history.js';
import type {} from './types.js';

/** The immutable archive of research imported from the previous server: a reader, no tools. */
export const legacyHistoryPlugin = {
  name: 'merv-legacy-history',
  inject: ['state', 'scope'],
  async apply(ctx: Context) {
    await initializeLegacyHistory(ctx.state);
    ctx.provide('legacyHistory', new LegacyHistoryReader(ctx.state, ctx.scope));
  },
};
export default legacyHistoryPlugin;
