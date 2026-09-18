import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { z } from 'zod';
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
          'Create a durable task. Merv renders and pins its goal and numbered checks as an immutable brief. Optional briefId uses your own text brief, which must include the goal and checks. Every new task requires a delivery confirmation for each check with evidence references and verification notes. The current actor becomes the producer. Optional dependsOn names existing work items in this project; work context and delivery wait until each succeeds. Dependencies are set at creation. Type defaults to task.work. experiment.plan requires research and constraints artifact IDs in contextInputs; project.reflection requires experiments and projectKnowledge.',
        inputSchema: z
          .object({
            title: z.string().min(1).max(300),
            goal: z.string().min(1).max(16000),
            checks: z.array(z.string().min(1).max(2000)).min(1).max(50),
            briefId: id.optional(),
            type: z.string().min(1).optional(),
            typeVersion: z.number().int().positive().optional(),
            contextInputs: z.record(z.array(id)).optional(),
            dependsOn: z
              .union([z.array(z.string()), z.string()])
              .nullable()
              .optional(),
            requestId,
          })
          .strict(),
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
        description: 'List tasks in the current project.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller: Caller) => await ctx.tasks.list(caller),
      },
      {
        name: 'task.submit_delivery',
        description:
          'Submit immutable delivery artifacts and enter independent review atomically. At evidenceVersion 2, supply one confirmation per numbered acceptance check: checkNumber, met/not_met status, evidenceIds from artifactIds, and notes describing verification or the unmet condition. A met claim requires evidence. Merv pins the confirmations alongside the evidence; the reviewer decides whether the goal was achieved. Legacy evidenceVersion 1 tasks require a text delivery addressing every check verbatim. expectedRevision is the task workflow revision.',
        inputSchema: z
          .object({
            taskId: id,
            artifactIds: z.array(id).min(1),
            confirmations: z
              .array(
                z
                  .object({
                    checkNumber: z.number().int().positive(),
                    status: z.enum(['met', 'not_met']),
                    evidenceIds: z.array(id),
                    notes: z.string().min(1).max(16000),
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
          'Producer/operator: end an active task as failed with a specific reason. Closes any unfinished review, preserves its evidence and prior verdicts, and prevents further work on this task. This is terminal; use only when the task cannot or should not continue. expectedRevision is the current task workflow revision.',
        inputSchema: z
          .object({
            taskId: id,
            expectedRevision: z.number().int().nonnegative(),
            reason: z
              .string()
              .min(1)
              .max(16000)
              .refine((value) => value.trim().length > 0),
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
