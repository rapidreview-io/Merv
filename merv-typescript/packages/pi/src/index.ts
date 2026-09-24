import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from '@merv/fleet/types';
import { check } from '@merv/contracts';
import { piConfig, type PiConfig } from './schema.js';
import { PiService } from './service.js';

export { PiService } from './service.js';
export type * from './types.js';
export type { PiConfig } from './schema.js';

export const piPlugin = {
  name: 'merv-pi',
  Config: piConfig,
  inject: ['state', 'scope', 'fleet', 'tools', 'blobs'],
  async apply(ctx: Context, config: PiConfig) {
    const parsed = piConfig.parse(config);
    check(
      !parsed.enabled || process.env[parsed.modelApiKeyEnv],
      'pi_configuration',
      'Pi model credentials are unavailable',
      503,
    );
    const pi = new PiService(ctx.state, ctx.scope, ctx.fleet, ctx.tools, ctx.blobs, parsed);
    await pi.initialize();
    ctx.effect(() => () => pi.close());
    ctx.provide('pi', pi);
  },
};
export default piPlugin;
