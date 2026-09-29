import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type {} from './types.js';
import type {} from './workflow.js';
import { present } from './running.js';
import { z } from 'zod';

/** Allocation requests are a server-owner capability, never an agent tool. The tools answer with
 *  the redacted view the Fleet page shows. */
const raiseLimit = 'Raise the Fleet daily token limit in Settings or wait for the UTC reset.';

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
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
    // Fleet's parts of system.status, where Sessions is loaded; the workflow's where it is too.
    ctx.inject(['sessions'], (ctx) => {
      const modelWait = async (caller: Caller) => {
        const budget = await ctx.get('fleetWorkflow')?.modelBudget(caller);
        if (!budget) return null;
        const { blocked, blockReason: reason, resetsAt } = budget;
        return { blocked, reason, resetsAt, ...(blocked ? { next: raiseLimit } : {}) };
      };
      ctx.effect(() =>
        ctx.sessions.contributeStatus('fleet', async (caller, project) => {
          if (!project) return undefined;
          const workflow = ctx.get('fleetWorkflow');
          const [allocations, modelBudget, retries] = await Promise.all([
            ctx.fleet.list(caller, 0),
            modelWait(caller),
            workflow?.retryStatus(caller, project.queue).catch(() => undefined),
          ]);
          return {
            available: true,
            modelBudget,
            retryBlocked: {
              available: retries !== undefined,
              truncated: project.queueTotal > project.queue.length,
              items: (retries ?? [])
                .filter((status) => status.state.startsWith('exhausted_'))
                .map((status) => ({
                  instanceId: status.instanceId,
                  expectedRevision: status.expectedRevision,
                  reason: `${status.unclaimedAttempts}/${status.attemptLimit} created Fleet machines ended before claiming work.`,
                  next: status.next,
                  ...(status.retryAvailable ? { tool: 'fleet.workflow_retry' } : {}),
                })),
            },
            allocations: allocations
              .filter(({ phase }) => phase !== 'released')
              .map(({ id, owner, phase, intent, error, createdAt }) => {
                return { id, owner: owner.kind, phase, intent, error, createdAt };
              }),
          };
        }),
      );
      ctx.effect(() =>
        ctx.sessions.contributeStatus('modelBudget', async (caller, project) =>
          project ? undefined : await modelWait(caller),
        ),
      );
    });
  },
};
export default fleetToolsPlugin;
