import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type {} from './types.js';
import { present } from './running.js';
import { z } from 'zod';

/** Allocation requests are a server-owner capability, never an agent tool. The tools answer with
 *  the redacted view the Fleet page shows. */
export const fleetToolsPlugin = {
  name: 'merv-fleet-tools',
  inject: ['fleet', 'tools'],
  apply(ctx: Context) {
    const target = z.object({ id: z.string().min(1).max(200) }).strict();
    const definitions = [
      {
        name: 'fleet.list',
        description:
          'List the project’s open Fleet allocations and its 50 latest ended ones, with machine lifecycle status.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller: Caller) => (await ctx.fleet.list(caller, 50)).map(present),
      },
      {
        name: 'fleet.get',
        description:
          'Read one Fleet allocation. A requested shutdown is distinct from confirmed machine deletion.',
        inputSchema: target,
        readOnly: true,
        handler: async (caller: Caller, input: { id: string }) =>
          present(await ctx.fleet.inspect(caller, input.id)),
      },
      {
        name: 'fleet.drain',
        conversation: 'propose' as const,
        description:
          'Stop admission on this allocation, retain the current assignment’s results, then release its machine. Only its source or a project administrator can drain it.',
        inputSchema: target,
        handler: async (caller: Caller, input: { id: string }) =>
          present(await ctx.fleet.drain(caller, input.id)),
      },
      {
        name: 'fleet.halt',
        conversation: 'propose' as const,
        description:
          'Fence this allocation and request immediate machine deletion. In-flight work may be interrupted. Only its source or a project administrator can halt it.',
        inputSchema: target,
        handler: async (caller: Caller, input: { id: string }) =>
          present(await ctx.fleet.cancel(caller, input.id)),
      },
      {
        name: 'fleet.project_limit',
        conversation: 'never' as const,
        description:
          'How many Fleet machines this project may run at once. A project administrator, signed in, can change it; machines already running finish their work.',
        inputSchema: z.object({ machines: z.number().int().min(1).max(64).optional() }).strict(),
        handler: async (caller: Caller, input: { machines?: number }) =>
          input.machines === undefined
            ? await ctx.fleet.projectLimit(caller)
            : await ctx.fleet.setProjectLimit(caller, input.machines),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default fleetToolsPlugin;
