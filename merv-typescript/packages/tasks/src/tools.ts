import { MAX_ARTIFACT_IDS, visible, type Caller } from '@merv/contracts';
import type { Context } from 'cordis';
import type { ToolDefinition } from '@merv/api/types';
import { z } from 'zod';
import type { Task } from './models.js';

const requestId = z.string().min(1).max(200);
const id = z.string().min(1);
const revision = z.number().int().nonnegative();
const text = (max: number) => z.string().min(1).max(max);
const line = (what: string, max: number) => text(max).regex(/^[^\r\n]*$/, `A ${what} is one line`);
const claim = {
  taskId: id,
  purpose: z.enum(['work', 'review']),
  expectedRevision: revision,
  claimId: id.optional(),
};
/** Compact reminder; the complete record remains available through its reference. */
function reminder(task: Task) {
  const {
    workflow,
    workStarts,
    dependencies,
    dependents,
    contextInputs,
    checks,
    deliveryConfirmations,
    guidance,
    ...record
  } = task;
  return {
    ...record,
    workflow: { state: workflow.state, revision: workflow.revision },
    references: [
      { tool: 'task.get', arguments: { taskId: task.id, full: true } },
      { tool: 'workflow.assignment', arguments: { instanceId: task.id } },
      ...guidance.references,
    ],
  };
}

export const taskToolsPlugin = {
  name: 'merv-task-tools',
  inject: ['tools', 'tasks'],
  apply(ctx: Context) {
    // Guidance names each rule's tool as its caller calls it.
    const guided = async (caller: Caller, task: Promise<object>) =>
      ctx.tools.guidance(caller, await task);
    const definitions: ToolDefinition[] = [
      {
        name: 'task.checkpoint',
        // Leased workers' and Pi's (as the two below); no MCP client is listed it.
        for: 'conversations',
        description:
          'Save attributed progress for this task assignment. Checkpoints are unverified notes for continuity, not a delivery or verdict. Review checkpoints require the current claimId.',
        inputSchema: z.strictObject({
          ...claim,
          notes: text(16000),
          artifactIds: z.array(id).max(50).optional(),
          requestId,
        }),
        handler: (caller, input) => guided(caller, ctx.tasks.checkpoint(caller, input)),
      },
      {
        name: 'task.context',
        for: 'conversations',
        description:
          'Build and persist the starting context from this task type’s versioned recipe. Work context requires the producer/operator. Review context requires a current independent claimId from review.start. Returns the complete context package with source hashes.',
        inputSchema: z.object({ ...claim, requestId }).strict(),
        handler: (caller, input) => guided(caller, ctx.tasks.context(caller, input)),
      },
      {
        name: 'task.submit_delivery',
        for: 'conversations',
        description:
          'Submit immutable delivery artifacts and enter independent review atomically. Supply one confirmation per numbered acceptance check: checkNumber, met/not_met status, at most 50 evidenceIds from artifactIds, and notes describing verification or the unmet condition. A met claim requires evidence. Merv pins the confirmations alongside the evidence; the reviewer decides whether the goal was achieved. Every new task uses Git and requires commandId: this leased worker’s own code.commit operation, once code.operation reports it succeeded. Its artifactIds may be empty, files are optional alongside the commit, a met claim that cites no evidenceIds is backed by the delivered commit, and Merv pins a rendered record of the commit for the review. expectedRevision is the task workflow revision.',
        inputSchema: z.strictObject({
          taskId: id,
          // Only a Git task may deliver its commit alone, and only Tasks knows which task is one.
          artifactIds: z.array(id).max(MAX_ARTIFACT_IDS),
          commandId: id.optional(),
          confirmations: z
            .array(
              z.strictObject({
                checkNumber: z.number().int().positive(),
                status: z.enum(['met', 'not_met']),
                evidenceIds: z.array(id),
                notes: text(2000),
              }),
            )
            .min(1)
            .optional(),
          expectedRevision: revision,
          requestId,
        }),
        handler: (caller, input) => guided(caller, ctx.tasks.submitDelivery(caller, input)),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
    ctx.effect(() =>
      ctx.tools.noun('task.read', {
        tier: 'core',
        readOnly: true,
        summary: 'Read tasks and saved checkpoints.',
        description:
          'Read tasks: list (the project’s tasks as records) and get (one task with its revision, pinned evidence, review, prerequisites, dependents and your workflow guidance, or one saved checkpoint).',
        actions: {
          list: {
            description:
              'List compact task summaries, 20 per page (maximum 100). Follow next and each task reference for complete context.',
            input: z
              .object({
                offset: z.number().int().nonnegative().default(0),
                limit: z.number().int().min(1).max(100).default(20),
              })
              .strict(),
            was: ['task.list'],
            handler: async (caller, { offset, limit }) => {
              const tasks = await ctx.tasks.list(caller);
              return ctx.tools.guidance(caller, {
                items: tasks.slice(offset, offset + limit).map(({ id, title, workflow }) => ({
                  id,
                  title,
                  state: workflow.state,
                  reference: { tool: 'task.get', arguments: { taskId: id } },
                })),
                total: tasks.length,
                next:
                  offset + limit < tasks.length
                    ? { tool: 'task.list', arguments: { offset: offset + limit, limit } }
                    : null,
              });
            },
          },
          get: {
            description:
              'Recover the goal, numbered checks, current state and delivery references. Set full:true for the complete record, dependencies, work starts and workflow guidance. With checkpointId, read that saved checkpoint. workflow.assignment refreshes the assigned context.',
            input: z
              .object({ taskId: id, checkpointId: id.optional(), full: z.boolean().optional() })
              .strict(),
            was: ['task.get'],
            handler: async (caller, input) =>
              input.checkpointId === undefined
                ? await guided(
                    caller,
                    ctx.tasks
                      .get(caller, input.taskId)
                      .then((task) => (input.full ? task : reminder(task))),
                  )
                : await ctx.tasks.savedCheckpoint(caller, input.taskId, input.checkpointId),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('task.write', {
        tier: 'core',
        summary: 'Create or stop durable tasks.',
        description:
          'Change tasks: create (a durable task with a goal and numbered checks, pinned as its brief) and mark_failed (stop an active task with a specific reason).',
        actions: {
          create: {
            summary:
              'Create an immutable goal/numbered-check brief; optional briefId must contain both. Actor becomes producer; delivery needs evidence refs and verification for every check. dependsOn is fixed at creation, same-project work; context/delivery await success. Type defaults task.work; use experiment/reflection tools for those. Private managed Git checkout uses accepted dependencies/main; conflicts await reviewed resolution; missing storage/init blocks work, never scratch. code.commit’s commandId pins the reviewed delivery; GitHub is optional sync/publication. Only a leased reviewer at that checkout can pass. Unleased review is possible after review_rounds exhaustion but can only fail.',
            description:
              'Create a durable task. Merv renders and pins its goal and numbered checks as an immutable brief. Optional briefId uses your own text brief, which must include the goal and checks. Every new task requires a delivery confirmation for each check with evidence references and verification notes. The current actor becomes the producer. Optional dependsOn names existing work items in this project; work context and delivery wait until each succeeds. Dependencies are set at creation. Type defaults to task.work; experiments are planned through the experiment tools, and reflections through the reflection tools, not as tasks. Every new task has a private managed Git checkout, even without GitHub. Record work with code.commit and deliver that operation’s commandId. The independent reviewer inspects that exact commit. Code derives the base from accepted dependsOn prerequisites and project main. Conflicting dependency branches wait for reviewed resolution. Repository initialization or missing Code storage blocks work; it never falls back to scratch. GitHub is optional synchronization and publication. Only a leased reviewer in the pinned checkout can pass a task; a review claimed without a lease, possible only once review_rounds is used up, can only fail it.',
            input: z.strictObject({
              title: line('title', 300),
              goal: text(16000),
              checks: z.array(line('check', 2000)).min(1).max(20),
              briefId: id.optional(),
              type: z.string().min(1).optional(),
              typeVersion: z.number().int().positive().optional(),
              contextInputs: z.record(z.array(id)).optional(),
              dependsOn: z
                .union([z.array(z.string()), z.string()])
                .nullable()
                .optional(),
              requestId,
            }),
            was: ['task.create'],
            handler: (caller, input) => guided(caller, ctx.tasks.create(caller, input)),
          },
          mark_failed: {
            act: { title: 'Mark task failed' },
            description:
              'Producer/operator: stop an active task with a specific reason, closing any unfinished review and preserving evidence. Service-owned tasks suspend until a project administrator (or their agent) resumes them; other tasks end terminally. Use only when the task cannot or should not continue. expectedRevision is the current task workflow revision.',
            input: z.strictObject({
              taskId: id,
              expectedRevision: revision,
              reason: text(16000).refine(visible),
              requestId,
            }),
            was: ['task.mark_failed'],
            handler: (caller, input) => guided(caller, ctx.tasks.markFailed(caller, input)),
          },
        },
      }),
    );
    // A main agent works with a person; a Fleet worker produces the tasks it directs.
    ctx.effect(() =>
      ctx.tools.contributeInstructions(
        "When you create a task, direct its goal and checks, then leave production to a Fleet worker. You may read the task, propose next work, and create artifacts, but never start work context, save work checkpoints, or submit a task delivery yourself. task.read get with full:true returns Merv's own guidance for a task: follow it.",
      ),
    );
  },
};
export default taskToolsPlugin;
