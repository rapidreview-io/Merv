import { visible } from '@merv/contracts';
import type { Context } from 'cordis';
import type {} from './types.js';
import { z } from 'zod';
import '@merv/contracts';
import type {} from '@merv/identity/types';
import { ApiServer, type HttpOptions } from './http.js';
import { ToolRegistry } from './registry.js';

export { ApiServer, describeTool } from './http.js';
export type { HttpOptions } from './http.js';
export { ToolRegistry } from './registry.js';
export type { ToolDescription } from './registry.js';

/** Runs `fn` in a snapshot scope when a state store is present: no writer lock, writes refused. */
const snapshotIn =
  (ctx: Context) =>
  <T>(fn: () => Promise<T>): Promise<T> => {
    const state = ctx.get('state');
    return state ? state.snapshot(fn) : fn();
  };

export const toolsPlugin = {
  name: 'merv-tools',
  Config: z.object({}).strict().default({}),
  inject: ['scope'],
  apply(ctx: Context) {
    ctx.effect(function* () {
      // Read-only tools run in a snapshot scope when a state store is present.
      const tools = new ToolRegistry(ctx.scope, ctx.scope.toolPolicy, snapshotIn(ctx));
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
        .refine((host) => visible(host), 'API host must be nonblank')
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
  inject: ['scope', 'tools', 'identity'],
  async apply(ctx: Context, config: HttpOptions = {}) {
    await ctx.effect(async function* () {
      // GET routes are reads; with a state store present they run in a snapshot scope.
      const api = new ApiServer(
        ctx.scope,
        ctx.tools,
        { ...config, snapshot: snapshotIn(ctx) },
        ctx.identity,
      );
      yield () => api.stop();
      await api.start();
      yield ctx.provide('api', api);
    });
  },
};

export default apiPlugin;
