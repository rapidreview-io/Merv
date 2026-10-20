import { visible } from '@merv/contracts';
import type { Context } from 'cordis';
import { z } from 'zod';
import { AgentCallLog, callLogMigrations } from './call-log.js';
import { ApiServer, type HttpOptions } from './http.js';
import { ToolRegistry } from './registry.js';

export { ApiServer } from './http.js';
export { ToolRegistry } from './registry.js';

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
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      // Outside agents' calls are logged where a state store is present (agent_tool_calls).
      const state = ctx.get('state');
      let log: AgentCallLog | undefined;
      if (state) {
        await state.migrate('agent_tool_calls', callLogMigrations);
        const calls = (log = new AgentCallLog(state));
        const flush = () => calls.flush().catch(() => {});
        const timer = setInterval(flush, 500);
        timer.unref();
        yield async () => {
          clearInterval(timer);
          await flush();
        };
      }
      // Read-only tools run in a snapshot scope when a state store is present, except those
      // that call a service outside Merv (ToolDefinition.openWorld).
      const tools = new ToolRegistry(
        ctx.scope,
        ctx.scope.toolPolicy,
        snapshotIn(ctx),
        log && ((call) => log.push(call)),
      );
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
      // GET /tools is a read; with a state store present it runs in a snapshot scope.
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
