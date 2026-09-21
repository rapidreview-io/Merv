import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type { Caller } from '@merv/contracts';
import { z } from 'zod';
import type { SessionBudgetInput, UsageQuery } from './types.js';

/** Optional tools over usage and budgets; authority lives with the Sessions provider. */
export const sessionsToolsPlugin = {
  name: 'merv-sessions-tools',
  inject: ['sessions', 'tools'],
  apply(ctx: Context) {
    const sessions = ctx.sessions;
    ctx.effect(() =>
      ctx.tools.register({
        name: 'usage.read',
        description:
          'Read what closed sessions cost: for the project, or with instanceId for that workflow instance together with everything it depends on and fans out to (a research cycle id gives the cycle). Set includeDependencies false for the one instance alone. Wall-clock is measured by Merv from activation to close. Tokens, cost and model are self-reported by the launching machine and unverified; reportedSessions says how many sessions reported, and accounting states what Merv cannot know. budgets lists the budgets in force and which dimensions are exceeded.',
        readOnly: true,
        inputSchema: z
          .object({
            instanceId: z.string().min(1).optional(),
            includeDependencies: z.boolean().optional(),
          })
          .strict(),
        handler: async (caller: Caller, input: UsageQuery) => await sessions.usage(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'usage.set_budget',
        description:
          'Project admin only, never a leased worker. Set a budget on the project, or with instanceId on that instance and its dependency closure (a research cycle id budgets the cycle). Give maxWallMinutes, maxCostUsd or maxTokens; null clears a dimension and an omitted one is kept. A reached budget only pauses automatic dispatch with reason budget_exceeded: nothing running is stopped and people can still begin work by hand. Raising or clearing it resumes dispatch. Setting the same values again changes nothing. Only wall-clock is measured by Merv; a cost or token budget trusts unverified self-reports.',
        inputSchema: z
          .object({
            instanceId: z.string().min(1).optional(),
            maxWallMinutes: z.number().int().min(1).max(5_256_000).nullable().optional(),
            maxCostUsd: z.number().positive().max(1e6).nullable().optional(),
            maxTokens: z.number().int().min(1).max(1e13).nullable().optional(),
          })
          .strict(),
        handler: async (caller: Caller, input: SessionBudgetInput) =>
          await sessions.setBudget(caller, input),
      }),
    );
  },
};
export default sessionsToolsPlugin;
