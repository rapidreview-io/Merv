import type {
  TaskCreate,
  TaskDelivery,
  TaskMarkFailed,
  TaskContext,
  TaskCheckpointInput,
} from './types.js';
import type { Task } from './models.js';
import { visible } from '@merv/contracts';
import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { z } from 'zod';
import type { Caller } from '@merv/contracts';

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
          'Create a durable task. Merv renders and pins its goal and numbered checks as an immutable brief. Optional briefId uses your own text brief, which must include the goal and checks. Every new task requires a delivery confirmation for each check with evidence references and verification notes. The current actor becomes the producer. Optional dependsOn names existing work items in this project; work context and delivery wait until each succeeds. Dependencies are set at creation. Type defaults to task.work; experiments are planned through the experiment tools, and reflections through the reflection tools, not as tasks. Every new task has a private managed Git checkout, even without GitHub. Record work with code.commit and deliver that operation’s commandId. The independent reviewer inspects that exact commit. Code derives the base from accepted dependsOn prerequisites and project main. Conflicting dependency branches wait for reviewed resolution. Repository initialization or missing Code storage blocks work; it never falls back to scratch. GitHub is optional synchronization and publication. Only a leased reviewer in the pinned checkout can pass a task; a review claimed without a lease, possible only once review_rounds is used up, can only fail it.',
        inputSchema: z
          .object({
            title: z
              .string()
              .min(1)
              .max(300)
              .regex(/^[^\r\n]*$/, 'A title is one line'),
            goal: z.string().min(1).max(16000),
            checks: z
              .array(
                z
                  .string()
                  .min(1)
                  .max(2000)
                  .regex(/^[^\r\n]*$/, 'A check is one line'),
              )
              .min(1)
              .max(20),
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
          'Read task status, workflow revision, pinned evidence, current review ID, live prerequisites and dependents, and caller-specific workflow guidance. With checkpointId, read that one saved checkpoint instead, as a context names it.',
        inputSchema: z.object({ taskId: id, checkpointId: id.optional() }).strict(),
        readOnly: true,
        handler: async (caller: Caller, input: { taskId: string; checkpointId?: string }) =>
          input.checkpointId === undefined
            ? await ctx.tasks.get(caller, input.taskId)
            : await ctx.tasks.savedCheckpoint(caller, input.taskId, input.checkpointId),
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
        act: { title: 'Submit delivery' },
        description:
          'Submit immutable delivery artifacts and enter independent review atomically. Supply one confirmation per numbered acceptance check: checkNumber, met/not_met status, at most 50 evidenceIds from artifactIds, and notes describing verification or the unmet condition. A met claim requires evidence. Merv pins the confirmations alongside the evidence; the reviewer decides whether the goal was achieved. Every new task uses Git and requires commandId: this leased worker’s own code.commit operation, once code.operation reports it succeeded. Its artifactIds may be empty, files are optional alongside the commit, a met claim that cites no evidenceIds is backed by the delivered commit, and Merv pins a rendered record of the commit for the review. expectedRevision is the task workflow revision.',
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
        receipt: (task: Task) => ({
          summary: {
            id: task.id,
            state: task.workflow.state,
            revision: task.workflow.revision,
            reviewId: task.reviewId,
          },
          reread: ['task.get', 'workflow.status_and_next'],
        }),
      },
      {
        name: 'task.mark_failed',
        act: { title: 'Mark task failed' },
        conversation: 'propose' as const,
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
        receipt: (task: Task) => ({
          summary: { id: task.id, state: task.workflow.state, revision: task.workflow.revision },
          reread: ['task.get', 'workflow.status_and_next'],
        }),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
    // A main agent works with a person; a Fleet worker produces the tasks it directs.
    ctx.effect(() =>
      ctx.tools.contributeInstructions(
        "When you create a task, direct its goal and checks, then leave production to a Fleet worker. You may read the task, propose next work, and create artifacts, but never start work context, save work checkpoints, or submit a task delivery yourself. task.get returns Merv's own guidance for a task: follow it.",
      ),
    );
  },
};
export default taskToolsPlugin;
