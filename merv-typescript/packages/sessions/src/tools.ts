import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type { Caller } from '@merv/contracts';
import { z } from 'zod';
import type { SessionBudgetInput, Sessions, UsageQuery } from './types.js';

/** Optional tools over usage, budgets and stuck work; authority lives with the Sessions provider. */
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
          'Project admin only, never a leased worker. Set a budget on the project, or with instanceId on that instance and its dependency closure (a research cycle id budgets the cycle). Give maxWallMinutes, maxCostUsd or maxTokens; null clears a dimension and an omitted one is kept. A reached budget only pauses automatic dispatch with reason budget_exceeded: nothing running is stopped and people can still begin work by hand. Raising or clearing it resumes dispatch. Setting the same values again changes nothing. Only wall-clock is measured by Merv; a cost or token budget trusts unverified self-reports and is judged only while every closed session in its scope reported usage — otherwise it pauses automatic dispatch with reason usage_unavailable until the report arrives or that bound is cleared. A budget covers worker sessions only, never the charges of a remote job.',
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
    ctx.effect(() =>
      ctx.tools.register({
        name: 'session.stuck',
        description:
          'Read everything in the project that stopped moving, and why. Never for a leased worker. Kinds: session_idle (an active session with no Merv tool call for idleNoticeSeconds; a runner heartbeat is not progress), dispatch_held (a target whose launches failed maxLaunchFailures times and is withheld from automatic dispatch), dispatch_failing (failing but still retried; listed, not counted in total), work_blocked (work another plugin published a blocker for, such as a Code base that cannot be derived yet; it is never offered, and next names the recovery), work_deferred (three machines in a row took this work and could not prepare its checkout, because the place its history lives was away, busy or full; nothing counts that, so it is offered again and again, and code names the cause), ready_quiet (a ready step no session has taken for quietReadySeconds since its last revision change, operator steps included), dispatch_disabled, no_live_runner and runner_refusing (a live runner refused the same way for refusalSeconds). Each item carries since, forSeconds, code, why and next. why and next are advice; the server enforces every guard where it commits. At most 200 items; counts cover all of them.',
        readOnly: true,
        inputSchema: z.object({}).strict(),
        handler: async (caller: Caller) => await sessions.stuck(caller),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'session.release_hold',
        description:
          'Project admin only, never a leased worker. Let automatic dispatch offer a held target again, after its cause is fixed: resets the failed-attempt count of one instance revision (instanceId and expectedRevision from a dispatch_held item of session.stuck) and records the reason. Idempotent by requestId; the same requestId with different input is request_conflict. hold_not_found when nothing is counted against the target, hold_not_held when it is still being retried. To not run the work at all, end or revise the record instead: a hold names one revision.',
        inputSchema: z
          .object({
            instanceId: z.string().min(1).max(200),
            expectedRevision: z.number().int().nonnegative(),
            reason: z.string().min(1).max(500),
            requestId: z.string().min(1),
          })
          .strict(),
        handler: async (caller: Caller, input: Parameters<Sessions['releaseHold']>[1]) =>
          await sessions.releaseHold(caller, input),
      }),
    );
  },
};
export default sessionsToolsPlugin;
