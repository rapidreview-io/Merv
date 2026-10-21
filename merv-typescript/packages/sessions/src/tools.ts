import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type { Caller } from '@merv/contracts';
import { z } from 'zod';
import { budgetSchema, dispatchSchema, haltSchema } from './budgets.js';
import { releaseHoldSchema } from './dispatch.js';
import type { ComputeWaitInput, QuestionResolution } from './types.js';
import { systemStatus } from './system-status.js';

const id = z.string().min(1).max(200);
const body = z.string().min(1).max(8000);
const byInstance = z.object({ instanceId: id }).strict();
const byThread = z.object({ threadId: id }).strict();
const toThread = z.object({ threadId: id, body, requestId: id }).strict();

/** Optional tools over usage, budgets and stuck work; authority lives with the Sessions provider. */
export const sessionsToolsPlugin = {
  name: 'merv-sessions-tools',
  inject: ['sessions', 'tools'],
  apply(ctx: Context) {
    const sessions = ctx.sessions;
    ctx.effect(() =>
      ctx.tools.noun('project.read', {
        tier: 'core',
        readOnly: true,
        summary: 'Read operations (status first) and usage/budgets.',
        description:
          'status (dispatch, machines, sessions, waiting work, budgets and blockers) and usage (closed-session costs and budgets).',
        actions: {
          status: {
            description:
              "Read operational status. People and Pi receive project dispatch, Fleet allocations, exhausted unclaimed Fleet retry blockers and model-budget wait status, runners, sessions, caller-admissible waiting work and blockers, including unusable workspace drivers. budgets reports cumulative project/dependency limits and usage, separate from Fleet's daily modelBudget; withheld steps immediately name their covering budgets and recovery action. A leased worker receives only its own authenticated session, its work item's lineage (its threads and their visits, with runners) and model-budget wait status.",
            input: z.object({}).strict(),
            was: ['system.status'],
            handler: async (caller) => await systemStatus(caller, sessions),
          },
          usage: {
            summary:
              'Closed-session usage/budgets: project or instanceId with dependencies/fan-out (includeDependencies:false for only it). Merv measures activation-to-close time; tokens/models are unverified launcher reports (reportedSessions/accounting indicate coverage/unknowns). Fleet use is bounded by the person’s daily token limit (project.read status modelBudget). Merv does not price sessions; unpriced worker/model/review costs do not justify asking the owner.',
            description:
              "Read what closed sessions cost: for the project, or with instanceId for that workflow instance together with everything it depends on and fans out to. Set includeDependencies false for the one instance alone. Wall-clock is measured by Merv from activation to close. Tokens and model are self-reported by the launching machine and unverified; reportedSessions says how many sessions reported, and accounting states what Merv cannot know. budgets lists the budgets in force and which dimensions are exceeded. Merv prices no session in money: a Fleet-hosted worker's model use is bounded by its person's daily Fleet token limit (system.status modelBudget), so unpriced worker, model or review charges are no reason to ask the owner.",
            input: z.strictObject({
              instanceId: z.string().min(1).optional(),
              includeDependencies: z.boolean().optional(),
            }),
            was: ['usage.read'],
            handler: async (caller, input) => await sessions.usage(caller, input),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('session.read', {
        tier: 'core',
        readOnly: true,
        for: 'people',
        summary: 'Read worker sessions, threads and stalls; no leased workers.',
        description:
          'Read worker sessions, never as a leased worker: find (the current and latest session of a work item), threads (its workers and their visits), messages (what passed between a thread and its people), calls (a thread’s Merv calls) and stuck (what in the project stopped moving, and why).',
        actions: {
          find: {
            description:
              'Find current/latest session for instanceId; no current session means no live worker. Use threadId with session.message for its live or next visit.',
            input: byInstance,
            was: ['session.find'],
            handler: async (caller, input) => await sessions.findSession(caller, input.instanceId),
          },
          threads: {
            description:
              'Work-item readers, no leased worker: instanceId’s stage/role threads oldest first, with state, live/dormant/retired status and ordered visits: status, offered/started/ended times, outcome/close code, launch/resume, harness and runner.',
            input: byInstance,
            was: ['session.threads'],
            handler: async (caller, input) => ({
              threads: await sessions.threads.list(caller, input.instanceId),
            }),
          },
          messages: {
            description:
              'Work-item readers, no leased worker: threadId’s messages oldest first, acknowledgements/replies, and session.ask_owner questions with whether a message answered each. Get threadId from session.threads.',
            input: byThread,
            was: ['session.thread_messages'],
            handler: async (caller, input) =>
              await sessions.messaging.thread(caller, input.threadId),
          },
          calls: {
            description:
              'Project readers, no leased worker: thread’s newest 100 calls, in-flight first, with visit/tool/status/timing/token-size estimates and all-call totals. Metadata only, no arguments/results. Get threadId from session.threads.',
            input: byThread,
            was: ['session.observe'],
            handler: async (caller, input) =>
              await sessions.observations.calls(caller, input.threadId),
          },
          stuck: {
            description:
              'Project stalls (no leased workers), with since/forSeconds/code/why/next; advice never bypasses commit guards. Kinds include idle sessions (no Merv calls for idleNoticeSeconds; heartbeat is not progress), held/failing dispatch, blocked/deferred work (checkout preparation failed on three machines), compute waits (auto-resume), ready work (immediate covering budget blocks with scope/usage/bounds; otherwise quietReadySeconds since revision), disabled dispatch, no runner and repeated runner refusals (refusalSeconds). At most 200 items; counts cover all; dispatch_failing/work_waiting are listed but excluded from total. next gives recovery.',
            input: z.object({}).strict(),
            was: ['session.stuck'],
            handler: async (caller) => await sessions.dispatch.stuck(caller),
          },
        },
      }),
    );
    // The project controls a person uses from the Sessions page, and their messages to workers.
    ctx.effect(() =>
      ctx.tools.noun('session.write', {
        tier: 'core',
        summary: 'Message or ask workers; admin-only dispatch, halt, release_hold and budget.',
        description:
          'Steer worker sessions: message (queue a message for a thread’s worker), ask (a short inquiry visit to any thread’s agent), dispatch (automatic dispatch on or off), halt (one session, or all with dispatch off), release_hold (offer a held target again) and budget (a project or instance budget). All but message and ask are a project admin’s.',
        actions: {
          message: {
            summary:
              'Queue to threadId from session.find/threads for the live/next work visit. Ended work accepts only answers. Answers all session.ask_owner questions and ends session.await_compute waits, reoffering work immediately. Does not interrupt local compute or prove receipt. Until acknowledged, the message is carried by refusals of every subsequent Merv call. Send one consolidated message, never status-only; request replies only if needed. Retry requestId after uncertain responses.',
            description:
              "Queue a durable message for a worker by threadId (a stage's worker, from session.find or session.threads), which its live visit or, once its work comes back, its next visit reads. A thread whose work has ended takes a message only as an answer. A message answers every question its agent asked with session.ask_owner, and dispatch then offers the work again. It also ends a wait its agent started with session.await_compute, which brings that work back at once. This does not interrupt local computation or prove the worker has read it. A pending message refuses the worker's next Merv call, carrying the message, and every one after it until the worker acknowledges it, so put what you have to say in one message rather than several, send none only to ask for status, and ask for a reply only when you need one. Reuse requestId after an uncertain response.",
            input: toThread,
            was: ['session.message'],
            handler: async (caller, input) => await sessions.messaging.message(caller, input),
          },
          ask: {
            summary:
              'Project writers: ask threadId (session.threads/Agents), live/dormant/retired. Read-only inquiry resumes saved conversation without work lease; work/conversation unchanged, next work visit learns exchange. session.thread_messages returns reply/inquiry status. One inquiry/thread (inquiry_busy); saved conversation required (inquiry_unkept). 10 minutes to launch, 10 to answer; tokens charged to you. Retry same requestId.',
            description:
              "Ask any thread's agent a question (threadId, from session.threads or the Agents page), live, dormant or retired: whoever may write in the project. A short inquiry visit resumes that agent's saved conversation, with read-only tools and no lease on its work, answers, and stops; its reply arrives on the question's message in session.thread_messages, where its inquiry status says queued, running, answered, unanswered or expired. It never moves the work or changes the agent's conversation: the agent's next work visit resumes as it left off and is told of the exchange. One question at a time per thread (inquiry_busy); a thread that kept no conversation cannot be asked (inquiry_unkept). The visit has 10 minutes to be taken by a machine and 10 to answer, and a model-token budget charged to you. Reuse requestId after an uncertain response.",
            input: toThread,
            was: ['session.ask_thread'],
            handler: async (caller, input) => ({
              inquiry: await sessions.inquiries.ask(caller, input),
            }),
          },
          dispatch: {
            summary:
              'Admin only, no worker: toggle automatic dispatch; ownMachines:true limits to project runners, false permits Fleet. Toggling clears all failed-launch counts. Fleet always acts as and bills the project owner/admin (Settings → Members).',
            description:
              "Project admin only, never a leased worker. Turn automatic dispatch of ready work to machines on or off for the project, and choose with ownMachines whether it goes only to the project's own runners (true) or also to machines Fleet rents (false). Turning dispatch on or off also clears every failed-launch count, as the go-ahead for the whole project. Fleet's machines here act as, and are paid for by, the project's owner (its admin, billed in Settings → Members), whoever changed either.",
            input: dispatchSchema,
            was: ['session.dispatch'],
            handler: async (caller, input) => await sessions.dispatch.setDispatch(caller, input),
          },
          halt: {
            description:
              'Project admin only, never a leased worker. Close one offered or active session with sessionId, or, without it, turn automatic dispatch off and close every one in the project. reason is recorded (default operator_halt). Answers how many were halted.',
            input: haltSchema,
            was: ['session.halt'],
            handler: async (caller, input) => await sessions.dispatch.halt(caller, input),
          },
          release_hold: {
            summary:
              'Admin only, no worker: after fixing the cause, reset one held revision’s failed-launch count using instanceId/expectedRevision from session.stuck and reason. Same requestId/input replays; changed input: request_conflict. No count: hold_not_found; still retrying: hold_not_held. Holds are revision-specific; end/revise work to stop it permanently.',
            description:
              'Project admin only, never a leased worker. Let automatic dispatch offer a held target again, after its cause is fixed: resets the failed-attempt count of one instance revision (instanceId and expectedRevision from a dispatch_held item of session.stuck) and records the reason. Idempotent by requestId; the same requestId with different input is request_conflict. hold_not_found when nothing is counted against the target, hold_not_held when it is still being retried. To not run the work at all, end or revise the record instead: a hold names one revision.',
            input: releaseHoldSchema,
            was: ['session.release_hold'],
            handler: async (caller, input) => await sessions.dispatch.releaseHold(caller, input),
          },
          budget: {
            summary:
              'Admin only, no worker: project or instanceId dependency-closure budget. maxWallMinutes/maxTokens: null clears, omission preserves; unchanged values are a no-op. Exhaustion pauses automatic dispatch (budget_exceeded); raising/clearing resumes. Running/manual work continues. Wall time measured; tokens trust self-reports. Missing activated-session reports or oversized closure pauses with usage_unavailable until reported/bounds cleared. Worker sessions only, not remote jobs.',
            description:
              'Project admin only, never a leased worker. Set a budget on the project, or with instanceId on that instance and its dependency closure. Give maxWallMinutes or maxTokens; null clears a dimension and an omitted one is kept. A reached budget only pauses automatic dispatch with reason budget_exceeded: nothing running is stopped and people can still begin work by hand. Raising or clearing it resumes dispatch. Setting the same values again changes nothing. Only wall-clock is measured by Merv; a token budget trusts unverified self-reports and is judged only while every session in its scope that was activated reported usage — otherwise it pauses automatic dispatch with reason usage_unavailable until the report arrives or that bound is cleared. An instance budget whose dependency closure is too large to walk cannot be judged either: it pauses every automatic offer with reason usage_unavailable until its bounds are cleared. A budget covers worker sessions only, never the charges of a remote job.',
            input: budgetSchema,
            was: ['usage.set_budget'],
            handler: async (caller, input) => await sessions.dispatch.setBudget(caller, input),
          },
        },
      }),
    );
    for (const definition of [
      {
        name: 'session.messages',
        tier: 'worker' as const,
        description:
          "Assigned worker only: read your queue, oldest first: the messages to your thread that await your acknowledgement, those sent to its earlier visits included, and, in a visit that did not continue the thread's conversation, the ones earlier visits acknowledged, with their replies; call it without sessionId. acknowledged counts the thread's acknowledged messages, which all: true lists in full. While a message waits, every other Merv call you make is refused with session_message_pending: acknowledge each with session.message.ack, whose reply may say what you will do. A person reads a thread's messages with session.thread_messages.",
        readOnly: true,
        inputSchema: z.strictObject({
          all: z
            .boolean()
            .optional()
            .describe('Also list the messages already acknowledged, with their replies'),
          sessionId: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe('Not needed: your queue is your own session’s, and one given must be it'),
        }),
        handler: async (caller: Caller, input: { sessionId?: string; all?: boolean }) =>
          await sessions.messaging.messages(caller, input),
      },
      {
        name: 'session.question.resolve',
        for: 'conversations' as const,
        description:
          'Bound question responder only: answer the exact worker question, or escalate it as needs_you with what you investigated and the decision still needed. Repaired work counts as answered. Investigation failure counts as needs_you. Answering queues your explanation and releases the question blocker; escalation leaves the worker blocked. Reuse requestId after an uncertain response. A question already answered by a person, or whose revision moved, cannot be resolved.',
        inputSchema: z.strictObject({
          questionId: id,
          expectedRevision: z.number().int().nonnegative(),
          outcome: z.enum(['answered', 'needs_you']),
          body,
          requestId: id,
        }),
        handler: (caller: Caller, input: QuestionResolution) =>
          sessions.messaging.resolve(caller, input),
      },
      {
        name: 'session.ask_owner',
        description:
          'Assigned worker only: end this visit with a question for the owner, when the work cannot go on without their decision or an action only a person can take (an operator’s fix, access, budget) and no tool can settle it. Your session closes at once, without counting as a failed launch; the work waits, withheld from dispatch, until an answer is queued to your thread. An optional responder may investigate and answer on the owner’s behalf; otherwise the question goes to the owner. The work then comes back to you in this same conversation, and the answer is the queued message you read with session.messages and acknowledge. Stop after calling it. Ask one self-contained question that says what you need and the options you see; a visit that keeps no conversation cannot ask.',
        tier: 'worker' as const,
        inputSchema: z.object({ question: z.string().min(1).max(4000) }).strict(),
        handler: async (caller: Caller, input: { question: string }) => ({
          question: await sessions.messaging.ask(caller, input),
          ended: true,
          next: 'Your visit has ended. Stop now: the owner’s answer reaches you when the work comes back.',
        }),
      },
      {
        name: 'session.await_compute',
        description:
          'Assigned worker only: end this visit to wait for Sandboxes jobs or workflows of this work that run for more than about 15 minutes, instead of sleeping or polling. Your session closes at once, uncounted, and they keep running. The work comes back to you in this conversation once all have ended or one fails (a workflow once its captures register), when someone messages your thread, or by the result’s until: after minutes, or 15 minutes before a machine they run on reaches its lease end, so you can renew it or move on. Commit first, and release machines that run none of them. Stop after calling it.',
        tier: 'worker' as const,
        inputSchema: z.strictObject({
          jobIds: z
            .array(id)
            .max(20)
            .optional()
            .describe('Sandboxes job ids of this work; with workflowIds, 1–20 distinct ids in all'),
          workflowIds: z
            .array(id)
            .max(20)
            .optional()
            .describe('Sandboxes workflow ids of this work; with jobIds, 1–20 distinct ids in all'),
          reason: z
            .string()
            .min(1)
            .max(1000)
            .describe(
              'What runs and what you will do with it; shown to people and given back to you',
            ),
          minutes: z
            .number()
            .int()
            .min(1)
            .max(10_080)
            .optional()
            .describe('The longest the wait may last, at least 5; 1440 (a day) when left out'),
        }),
        handler: async (caller: Caller, input: ComputeWaitInput) => ({
          wait: await sessions.computeWaits.await(caller, input),
          ended: true,
          next: 'Your visit has ended. Stop now: the work comes back to you in this conversation by until.',
        }),
      },
      {
        name: 'session.message.ack',
        description:
          'Assigned worker only: acknowledge one queued message after reading it. Include a short reply explaining what you will do or why you cannot apply it. The acknowledgement and its reply are durable and written once: the same requestId and reply return it again, and anything else for an acknowledged message is request_conflict, so this is no channel for later notes. It records receipt, not incorporation into submitted evidence. An inquiry visit answers its question with this reply, which ends the visit.',
        tier: 'worker' as const,
        inputSchema: z.strictObject({
          messageId: id,
          reply: body.optional(),
          requestId: id,
        }),
        handler: async (
          caller: Caller,
          input: { messageId: string; reply?: string; requestId: string },
        ) => {
          const message = await sessions.messaging.acknowledgeMessage(caller, input);
          // The reply to a question to an agent (an inquiry) is its visit's answer.
          return message.inquiry
            ? {
                ...message,
                ended: true,
                next: 'Your answer is delivered and this inquiry visit has ended. Stop now.',
              }
            : message;
        },
      },
    ])
      ctx.effect(() => ctx.tools.register(definition));
    ctx.effect(() =>
      ctx.tools.contributeInstructions(
        "To steer an assigned agent, use session.read find with the work's instanceId to find its thread, then session.write message with that threadId, which its live visit or its next one reads. A thread's messages and the questions its agent asked are in session.read messages; a message to the thread answers them. A queued message has not necessarily been received or acted on, and an ended session cannot receive it. A worker may acknowledge with a reply, which is not proof that a correction was incorporated. Messaging does not stop compute or change an approved plan. For work that should end, use the existing halt and terminal work actions, then create replacement work with better instructions if appropriate; preserve and refer to the earlier evidence. session.read stuck says why work is not moving and returns Merv's own guidance on it.",
      ),
    );
  },
};
export default sessionsToolsPlugin;
