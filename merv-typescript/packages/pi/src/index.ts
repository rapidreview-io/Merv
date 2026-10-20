import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from '@merv/fleet/types';
import type {} from '@merv/sessions/types';
import { questionResponder } from './questions.js';
import { check } from '@merv/contracts';
import { piConfig, type PiConfig } from './schema.js';
import { PiService } from './service.js';
import { recordLookTool } from './record-look.js';

export { PiService } from './service.js';
export type * from './types.js';
export type { PiConfig } from './schema.js';

export const piPlugin = {
  name: 'merv-pi',
  Config: piConfig,
  inject: ['state', 'scope', 'fleet', 'tools', 'blobs'],
  async apply(ctx: Context, config: PiConfig) {
    // The service checks the configuration, naming the first field it refuses.
    const pi = new PiService(ctx.state, ctx.scope, ctx.fleet, ctx.tools, ctx.blobs, config);
    const { modelApiKeyEnv, host } = pi.config;
    check(
      process.env[modelApiKeyEnv] && process.env[host.credentialEnv],
      'pi_configuration',
      'Pi model or host credentials are unavailable',
      503,
    );
    // Before initialize: a start that fails after registering closes what it registered.
    ctx.effect(() => () => pi.close());
    await pi.initialize();
    ctx.provide('pi', pi);
    ctx.effect(() => ctx.tools.register(recordLookTool(ctx.tools)));
    ctx.inject(['sessions'], (ctx) => {
      ctx.effect(() => ctx.sessions.messaging.registerResponder(questionResponder(pi, ctx.scope)));
    });
  },
};
export default piPlugin;
