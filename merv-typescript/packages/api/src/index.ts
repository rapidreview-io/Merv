import type { Context } from 'cordis';
import type {} from './types.js';
import { z } from 'zod';
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
  Config: z.object({}).strict().default({}),
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
  Config: z
    .object({
      host: z
        .string()
        .refine((host) => host.trim().length > 0, 'API host must be nonblank')
        .optional(),
      port: z.number().int().min(0).max(65535).optional(),
      maxBodyBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      allowedOrigins: z
        .array(
          z.string().refine((origin) => {
            if (origin === 'null') return true;
            try {
              const url = new URL(origin);
              return (
                (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin
              );
            } catch {
              return false;
            }
          }, 'Allowed origins must be exact HTTP(S) origins or null'),
        )
        .optional(),
    })
    .strict()
    .default({}),
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
