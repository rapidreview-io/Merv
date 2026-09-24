import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type {} from './types.js';
import { z } from 'zod';

/** Allocation requests are a server-owner capability, never an agent tool. */
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
        handler: (caller: Caller) => ctx.fleet.list(caller, 50),
      },
      {
        name: 'fleet.get',
        description:
          'Read one Fleet allocation. A requested shutdown is distinct from confirmed machine deletion.',
        inputSchema: target,
        readOnly: true,
        handler: (caller: Caller, input: { id: string }) => ctx.fleet.inspect(caller, input.id),
      },
      {
        name: 'fleet.drain',
        description:
          'Stop admission on this allocation, retain the current assignment’s results, then release its machine. Only its source or a project administrator can drain it.',
        inputSchema: target,
        handler: (caller: Caller, input: { id: string }) => ctx.fleet.drain(caller, input.id),
      },
      {
        name: 'fleet.halt',
        description:
          'Fence this allocation and request immediate machine deletion. In-flight work may be interrupted. Only its source or a project administrator can halt it.',
        inputSchema: target,
        handler: (caller: Caller, input: { id: string }) => ctx.fleet.cancel(caller, input.id),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default fleetToolsPlugin;
