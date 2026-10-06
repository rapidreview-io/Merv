import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type { Caller } from '@merv/contracts';
import { z } from 'zod';
import { budgetSchema, dispatchSchema, haltSchema, releaseHoldSchema } from './dispatch.js';
import type { SessionBudgetInput, Sessions, UsageQuery } from './types.js';
import { systemStatus } from './system-status.js';

/** Optional tools over usage, budgets and stuck work; authority lives with the Sessions provider. */
export const sessionsToolsPlugin = {
  name: 'merv-sessions-tools',
  inject: ['sessions', 'tools'],
  apply(ctx: Context) {
    const sessions = ctx.sessions;
    ctx.effect(() =>
      ctx.tools.register({
        name: 'system.status',
        description:
          'Read operational status. People and Pi receive project dispatch, Fleet allocations, exhausted unclaimed Fleet retry blockers and model-budget wait status, runners, sessions, caller-admissible waiting work and blockers, including unusable workspace drivers. A leased worker receives only its own authenticated session and model-budget wait status.',
        readOnly: true,
        inputSchema: z.object({}).strict(),
        handler: async (caller: Caller) => await systemStatus(caller, sessions),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'usage.read',
        description:
          'Read what closed sessions cost: for the project, or with instanceId for that workflow instance together with everything it depends on and fans out to. Set includeDependencies false for the one instance alone. Wall-clock is measured by Merv from activation to close. Tokens and model are self-reported by the launching machine and unverified; reportedSessions says how many sessions reported, and accounting states what Merv cannot know. budgets lists the budgets in force and which dimensions are exceeded.',
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
        conversation: 'propose',
        description:
          'Project admin only, never a leased worker. Set a budget on the project, or with instanceId on that instance and its dependency closure. Give maxWallMinutes or maxTokens; null clears a dimension and an omitted one is kept. A reached budget only pauses automatic dispatch with reason budget_exceeded: nothing running is stopped and people can still begin work by hand. Raising or clearing it resumes dispatch. Setting the same values again changes nothing. Only wall-clock is measured by Merv; a token budget trusts unverified self-reports and is judged only while every session in its scope that was activated reported usage — otherwise it pauses automatic dispatch with reason usage_unavailable until the report arrives or that bound is cleared. An instance budget whose dependency closure is too large to walk cannot be judged either: it pauses every automatic offer with reason usage_unavailable until its bounds are cleared. A budget covers worker sessions only, never the charges of a remote job.',
        inputSchema: budgetSchema,
        handler: async (caller: Caller, input: SessionBudgetInput) =>
          await sessions.dispatch.setBudget(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'session.stuck',
        description:
          'Read everything in the project that stopped moving, and why. Never for a leased worker. Kinds: session_idle (an active session with no Merv tool call for idleNoticeSeconds; a runner heartbeat is not progress), dispatch_held (a target whose launches failed maxLaunchFailures times and is withheld from automatic dispatch), dispatch_failing (failing but still retried; listed, not counted in total), work_blocked (work another plugin published a blocker for, such as a Code base that cannot be derived yet; it is never offered, and next names the recovery), work_deferred (three machines in a row took this work and could not prepare its checkout, because the place its history lives was away, busy or full; nothing counts that, so it is offered again and again, and code names the cause), ready_quiet (a ready step no session has taken for quietReadySeconds since its last revision change, operator steps included), dispatch_disabled, no_live_runner and runner_refusing (a live runner refused the same way for refusalSeconds). Each item carries since, forSeconds, code, why and next. why and next are advice; the server enforces every guard where it commits. At most 200 items; counts cover all of them.',
        readOnly: true,
        inputSchema: z.object({}).strict(),
        handler: async (caller: Caller) => await sessions.dispatch.stuck(caller),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'session.release_hold',
        conversation: 'propose',
        description:
          'Project admin only, never a leased worker. Let automatic dispatch offer a held target again, after its cause is fixed: resets the failed-attempt count of one instance revision (instanceId and expectedRevision from a dispatch_held item of session.stuck) and records the reason. Idempotent by requestId; the same requestId with different input is request_conflict. hold_not_found when nothing is counted against the target, hold_not_held when it is still being retried. To not run the work at all, end or revise the record instead: a hold names one revision.',
        inputSchema: releaseHoldSchema,
        handler: async (
          caller: Caller,
          input: Parameters<Sessions['dispatch']['releaseHold']>[1],
        ) => await sessions.dispatch.releaseHold(caller, input),
      }),
    );
    // The project controls a person uses from the Sessions page, as tools.
    ctx.effect(() =>
      ctx.tools.register({
        name: 'session.dispatch',
        act: {
          title: ({ enabled }) => (enabled === false ? 'Pause dispatch' : 'Start dispatch'),
          says: 'enabled',
        },
        description:
          "Project admin only, never a leased worker. Turn automatic dispatch of ready work to machines on or off for the project, and choose with ownMachines whether it goes only to the project's own runners (true) or also to machines Fleet rents (false). Turning dispatch on or off also clears every failed-launch count, as the go-ahead for the whole project. Fleet's machines here act as, and are paid for by, the project's owner (its longest-standing signed-in operator), whoever changed either.",
        conversation: 'propose',
        inputSchema: dispatchSchema,
        handler: async (
          caller: Caller,
          input: Parameters<Sessions['dispatch']['setDispatch']>[1],
        ) => await sessions.dispatch.setDispatch(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'session.halt',
        act: { title: ({ sessionId }) => (sessionId ? 'Halt lease' : 'Halt all leases') },
        description:
          'Project admin only, never a leased worker. Close one offered or active session with sessionId, or, without it, turn automatic dispatch off and close every one in the project. reason is recorded (default operator_halt). Answers how many were halted.',
        conversation: 'propose',
        inputSchema: haltSchema,
        handler: async (caller: Caller, input: { sessionId?: string; reason?: string }) =>
          await sessions.dispatch.halt(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'session.find',
        description:
          'Find the current and latest worker session for one workflow instanceId. Use current.id as the destination for session.message; no current session means there is no live worker to address.',
        readOnly: true,
        inputSchema: z.object({ instanceId: z.string().min(1).max(200) }).strict(),
        handler: async (caller: Caller, input: { instanceId: string }) =>
          await sessions.findSession(caller, input.instanceId),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'session.message',
        description:
          'Queue a durable message for one offered or active worker session by sessionId. This does not interrupt local computation or prove the worker has read it. A pending message is shown at the next Merv tool boundary and must be acknowledged before another write can commit. Reuse requestId after an uncertain response.',
        inputSchema: z
          .object({
            sessionId: z.string().min(1).max(200),
            body: z.string().min(1).max(8000),
            requestId: z.string().min(1).max(200),
          })
          .strict(),
        handler: async (
          caller: Caller,
          input: { sessionId: string; body: string; requestId: string },
        ) => await sessions.messaging.message(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'session.messages',
        description:
          'Read durable messages and worker acknowledgements for a session. A worker may omit sessionId to read its own queue. Messages are queued until acknowledged; an acknowledgement may carry a substantive reply.',
        readOnly: true,
        inputSchema: z.object({ sessionId: z.string().min(1).max(200).optional() }).strict(),
        handler: async (caller: Caller, input: { sessionId?: string }) =>
          await sessions.messaging.messages(caller, input.sessionId),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'session.message.ack',
        description:
          'Assigned worker only: acknowledge one queued message after reading it. Include a short reply explaining what you will do or why you cannot apply it. The acknowledgement is durable and idempotent by requestId; it records receipt, not incorporation into submitted evidence.',
        conversation: 'never',
        inputSchema: z
          .object({
            messageId: z.string().min(1).max(200),
            reply: z.string().min(1).max(8000).optional(),
            requestId: z.string().min(1).max(200),
          })
          .strict(),
        handler: async (
          caller: Caller,
          input: { messageId: string; reply?: string; requestId: string },
        ) => await sessions.messaging.acknowledgeMessage(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'session.observe',
        description:
          'Anyone who can read the project, never a leased worker: one agent, named by agentId, with its assignments (each session’s workflow, state and tools) and its latest 100 Merv calls, in-flight ones first.',
        readOnly: true,
        inputSchema: z.object({ agentId: z.string().min(1).max(200) }).strict(),
        handler: async (caller: Caller, input: { agentId: string }) =>
          await sessions.observations.read(caller, input.agentId),
      }),
    );
    ctx.effect(() =>
      ctx.tools.contributeInstructions(
        "To steer an assigned agent, use session.find with the work's instanceId to find its current session, then session.message with that sessionId. Messages address sessions, not the work itself. Read the session's messages and responses with session.messages. A queued message has not necessarily been received or acted on, and an ended session cannot receive it. A worker may acknowledge with a reply, which is not proof that a correction was incorporated. Messaging does not stop compute or change an approved plan. For work that should end, use the existing halt and terminal work actions, then create replacement work with better instructions if appropriate; preserve and refer to the earlier evidence. session.stuck says why work is not moving and returns Merv's own guidance on it.",
      ),
    );
  },
};
export default sessionsToolsPlugin;
