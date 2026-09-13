import type { Context } from 'cordis';
import { z } from 'zod';
import type { Caller, TaskCreate, TaskDelivery, TaskReview, TaskReissue } from '@merv/contracts';

const requestId = z.string().min(1).max(200);
const id = z.string().min(1);
export const taskToolsPlugin = {
  name: 'merv-task-tools',
  inject: ['tools', 'tasks'],
  apply(ctx: Context) {
    const definitions = [
      {
        name: 'task.create',
        description:
          'Create a durable task with an immutable brief. The text brief must include the goal and every Done-when check. The current actor becomes the producer.',
        inputSchema: z
          .object({
            title: z.string().min(1),
            goal: z.string().min(1),
            checks: z.array(z.string().min(1)).min(1),
            briefId: id,
            requestId,
          })
          .strict(),
        handler: (caller: Caller, input: TaskCreate) => ctx.tasks.create(caller, input),
      },
      {
        name: 'task.get',
        description:
          'Read task status, workflow revision, pinned brief, delivery, and current review ID.',
        inputSchema: z.object({ taskId: id }).strict(),
        readOnly: true,
        handler: (caller: Caller, input: { taskId: string }) => ctx.tasks.get(caller, input.taskId),
      },
      {
        name: 'task.list',
        description: 'List tasks in the current project.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: (caller: Caller) => ctx.tasks.list(caller),
      },
      {
        name: 'task.submit_delivery',
        description:
          'Submit immutable delivery artifacts and enter independent review atomically. At least one text document must address every Done-when check verbatim. expectedRevision is the task workflow revision.',
        inputSchema: z
          .object({
            taskId: id,
            artifactIds: z.array(id).min(1),
            expectedRevision: z.number().int().nonnegative(),
            requestId,
          })
          .strict(),
        handler: (caller: Caller, input: TaskDelivery) => ctx.tasks.submitDelivery(caller, input),
      },
      {
        name: 'task.reissue_review',
        description:
          'Producer/operator: replace an open review claim while preserving exactly the same evidence. Use when a reviewer is unavailable or revoked. Supersedes the old review and advances the task revision atomically; requires a reason.',
        inputSchema: z
          .object({
            taskId: id,
            expectedRevision: z.number().int().nonnegative(),
            reason: z.string().min(1),
            requestId,
          })
          .strict(),
        handler: (caller: Caller, input: TaskReissue) => ctx.tasks.reissueReview(caller, input),
      },
      {
        name: 'review.submit',
        description:
          'Apply an independent reviewer’s verdict and task transition in one transaction: pass→done, needs_changes→in_progress, fail→failed. Claim with review.start first. expectedRevision is the pinned task workflow revision.',
        inputSchema: z
          .object({
            reviewId: id,
            verdict: z.enum(['pass', 'needs_changes', 'fail']),
            notes: z.string().min(1),
            expectedRevision: z.number().int().nonnegative(),
            requestId,
          })
          .strict(),
        handler: (caller: Caller, input: TaskReview) => ctx.tasks.submitReview(caller, input),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default taskToolsPlugin;
