import { visible } from '@merv/contracts';
import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { z } from 'zod';
import { taskCreateToolSchema } from './input.js';
import type {
  Caller,
  TaskCreate,
  TaskDelivery,
  TaskReissue,
  TaskMarkFailed,
  TaskContext,
  TaskCheckpointInput,
} from '@merv/contracts';

const requestId = z.string().min(1).max(200);
const id = z.string().min(1);
export const taskToolsPlugin = {
  name: 'merv-task-tools',
  inject: ['tools', 'tasks'],
  apply(ctx: Context) {
    const definitions = [
      {
        name: 'task.checkpoint',
        description:
          'Save attributed progress for this task assignment. Checkpoints are unverified notes for continuity, not a delivery or verdict. Review checkpoints require the current claimId.',
        inputSchema: z
          .object({
            taskId: id,
            purpose: z.enum(['work', 'review']),
            expectedRevision: z.number().int().nonnegative(),
            claimId: id.optional(),
            notes: z.string().min(1).max(16000),
            artifactIds: z.array(id).max(50).optional(),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: TaskCheckpointInput) =>
          await ctx.tasks.checkpoint(caller, input),
      },
      {
        name: 'task.context',
        description:
          'Build and persist the starting context from this task type’s versioned recipe. Work context requires the producer/operator. Review context requires a current independent claimId from review.start. Returns the complete context package with source hashes.',
        inputSchema: z
          .object({
            taskId: id,
            purpose: z.enum(['work', 'review']),
            expectedRevision: z.number().int().nonnegative(),
            claimId: id.optional(),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: TaskContext) =>
          await ctx.tasks.context(caller, input),
      },
      {
        name: 'task.create',
        description:
          'Create a durable task. Merv renders and pins its goal and numbered checks as an immutable brief. Optional briefId uses your own text brief, which must include the goal and checks. Every new task requires a delivery confirmation for each check with evidence references and verification notes. The current actor becomes the producer. Optional dependsOn names existing work items in this project; work context and delivery wait until each succeeds. Dependencies are set at creation. Type defaults to task.work. experiment.plan requires research and constraints artifact IDs in contextInputs, and Merv appends a required feasibility check to its checks (and rendered brief) that the delivery review cannot waive; a briefId of your own must contain that check; project.reflection requires experiments and projectKnowledge. Optional workspace "git" (default none; requires Code) gives the producing worker a private Git checkout: it records its work with code.commit and delivers that commit, which the independent reviewer inspects in a read-only checkout pinned to it, so a code repository is never split into artifacts. Until an administrator binds and imports the project, the checkout uses the runner’s central base. In a hosted project Code derives and pins the base from accepted dependencies, looking through code-less successes and using imported main when there is no contributing commit. Several commits share an automatic merge; conflicts wait for one reviewed resolution task. Unverified or unimported code shows code_base_pending; code_merge_required means automatic merging is disabled. Blocked work is never launched. Optional baseTaskId is the older explicit form: it names one Git task, which must also be in dependsOn, whose accepted delivered commit becomes the base. The workspace is fixed at creation. Only a leased reviewer, working in that pinned checkout, can pass a Git task; an interactive reviewer may return or fail it.',
        inputSchema: taskCreateToolSchema,
        handler: async (caller: Caller, input: TaskCreate) => await ctx.tasks.create(caller, input),
      },
      {
        name: 'task.get',
        description:
          'Read task status, workflow revision, pinned evidence, current review ID, live prerequisites and dependents, and caller-specific workflow guidance.',
        inputSchema: z.object({ taskId: id }).strict(),
        readOnly: true,
        handler: async (caller: Caller, input: { taskId: string }) =>
          await ctx.tasks.get(caller, input.taskId),
      },
      {
        name: 'task.list',
        description:
          'List the tasks in the current project as records; task.get adds your guidance.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller: Caller) => await ctx.tasks.list(caller),
      },
      {
        name: 'task.submit_delivery',
        description:
          'Submit immutable delivery artifacts and enter independent review atomically. Supply one confirmation per numbered acceptance check: checkNumber, met/not_met status, evidenceIds from artifactIds, and notes describing verification or the unmet condition. A met claim requires evidence. Merv pins the confirmations alongside the evidence; the reviewer decides whether the goal was achieved. A Git task (workspace "git") also requires commandId: this leased worker’s own code.commit operation, once code.operation reports it succeeded. Its artifactIds may be empty, files are optional alongside the commit, a met claim that cites no evidenceIds is backed by the delivered commit, and Merv pins a rendered record of the commit for the review. Every other task requires at least one artifact and takes no commandId. expectedRevision is the task workflow revision.',
        inputSchema: z
          .object({
            taskId: id,
            // Only a Git task may deliver its commit alone, and only Tasks knows which task is one.
            artifactIds: z.array(id),
            commandId: id.optional(),
            confirmations: z
              .array(
                z
                  .object({
                    checkNumber: z.number().int().positive(),
                    status: z.enum(['met', 'not_met']),
                    evidenceIds: z.array(id),
                    notes: z.string().min(1).max(2000),
                  })
                  .strict(),
              )
              .min(1)
              .optional(),
            expectedRevision: z.number().int().nonnegative(),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: TaskDelivery) =>
          await ctx.tasks.submitDelivery(caller, input),
      },
      {
        name: 'task.mark_failed',
        description:
          'Producer/operator: stop an active task with a specific reason, closing any unfinished review and preserving evidence. Service-owned tasks suspend until a human operator resumes them; other tasks end terminally. Use only when the task cannot or should not continue. expectedRevision is the current task workflow revision.',
        inputSchema: z
          .object({
            taskId: id,
            expectedRevision: z.number().int().nonnegative(),
            reason: z.string().min(1).max(16000).refine(visible),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: TaskMarkFailed) =>
          await ctx.tasks.markFailed(caller, input),
      },
      {
        name: 'task.reissue_review',
        description:
          'Producer/operator: replace an open review claim while preserving exactly the same evidence. Use when a reviewer is unavailable or revoked. Supersedes the old review and advances the task revision atomically; requires a reason.',
        inputSchema: z
          .object({
            taskId: id,
            expectedRevision: z.number().int().nonnegative(),
            reason: z.string().min(1).max(2000),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: TaskReissue) =>
          await ctx.tasks.reissueReview(caller, input),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default taskToolsPlugin;
