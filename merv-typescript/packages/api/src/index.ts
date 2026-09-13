import type { Context } from 'cordis';
import '@merv/contracts';
import { ApiServer, type HttpOptions } from './http.js';
import { ToolRegistry } from './registry.js';

export { ApiServer, describeTool } from './http.js';
export type { HttpOptions } from './http.js';
export { ApiError, ToolRegistry } from './registry.js';
export type { ToolDescription } from './registry.js';

declare module 'cordis' {
  interface Context {
    api: ApiServer;
  }
}

export const toolsPlugin = {
  name: 'merv-tools',
  inject: ['scope'],
  apply(ctx: Context) {
    ctx.effect(function* () {
      const tools = new ToolRegistry(ctx.scope);
      yield () => tools.close();
      // The group disposes the service and drains consumers before closing its resource.
      yield ctx.provide('tools', tools);
    });
  },
};

export const apiPlugin = {
  name: 'merv-api',
  inject: ['scope', 'tools'],
  async apply(ctx: Context, config: HttpOptions = {}) {
    await ctx.effect(async function* () {
      const api = new ApiServer(ctx.scope, ctx.tools, config);
      yield () => api.stop();
      await api.start();
      yield ctx.provide('api', api);
    });
  },
};

export default apiPlugin;
