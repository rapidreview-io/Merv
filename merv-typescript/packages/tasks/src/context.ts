import { requireDependencies } from '@merv/workflows/rules';
import { leaseReceipt } from '@merv/workflows/lease-rows';
import {
  check,
  clip,
  sha256Hex,
  type Caller,
  type ContextBuild,
  type ContextInput,
  type ContextItem,
  type ContextPackage,
  type ReviewRequest,
  type Transaction,
  type WorkflowAssignmentContent,
  type WorkflowCheckContext,
  type WorkflowExecutionReferences,
} from '@merv/contracts';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import { artifactItem, textItem } from '@merv/context-builder/artifact-item';
import { renderBrief } from './evidence.js';
import type { Task, TaskContext } from './types.js';
import type { TaskRow, TasksContext } from './index.js';
import {
  GIT_CLAIM,
  GIT_SUBMISSION_CLAIM,
  GIT_DELIVERY,
  GIT_SUBMISSION,
  GIT_SUBMISSION_REVIEW,
  GIT_REVIEW,
  RESOLUTION_PAPER,
  serviceOwned,
  SOURCE_VERIFICATION,
} from './workflow.js';
import {
  currentLease,
  isProducer,
  leaseArtifactIds,
  producerOrAdmin,
  visibleCheckpoints,
} from './lease.js';
import { reviewCommit } from './policy.js';
import { artifactReview, requireArtifactReview } from './legacy-artifact-review.js';

// A task's work and review contexts, and the assignment each of its states offers. Each runs
// on TaskService (index.ts) as its TasksContext.

/** A context input before it becomes items: one text, or artifacts listed by ID. */
type Source = { text: string } | { artifactIds: string[] } | ContextInput;
/**
 * How each section's items are embedded. The task, its brief, revision feedback and the review
 * criteria are always embedded. Background and saved-progress evidence are references;
 * other small evidence fits by priority. Each artifact above 8,000 bytes is a reference.
 */
const ITEM_RULES: Record<string, Pick<ContextItem, 'embed' | 'priority'>> = {
  task: { embed: 'always' },
  brief: { embed: 'always' },
  feedback: { embed: 'always' },
  assessment: { embed: 'always' },
  evidence: { priority: 800 },
  recovery: { priority: 600 },
  taskBackground: { embed: 'never', priority: 500 },
  checkpoints: { priority: 400 },
  checkpointEvidence: { embed: 'never', priority: 300 },
};

/** Embed at most 8,000 paper chars, 4,000 per section; resolution work uses references only. */
export function taskPaper(paper: ContextInput, resolution: boolean): ContextInput {
  let room = resolution ? 0 : 8000;
  const embedded = new Set<string>();
  for (const item of [...paper.items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
    if (!('text' in item.body)) continue;
    const text = item.body.text;
    if (!embedded.has(text) && text.length <= Math.min(4000, room)) {
      room -= text.length;
      embedded.add(text);
    }
  }
  return {
    items: paper.items.map((item) => {
      const text = 'text' in item.body ? item.body.text : undefined;
      return {
        ...item,
        priority: (item.priority ?? 0) - 1000,
        embed: text !== undefined && embedded.has(text) ? item.embed : 'never',
      };
    }),
  };
}

export async function context(
  ctx: TasksContext,
  caller: Caller,
  input: TaskContext,
): Promise<ContextPackage> {
  ({ caller, input } = structuredClone({ caller, input }));
  // The preview reads artifact bytes under the writer lock. The Context Builder README gives
  // the seam that moves them out: a lock-free preview between two short transactions.
  return await ctx.state.transaction(async (tx) => {
    const { task, review } = await assignment(ctx, caller, input, tx);
    const type = contextType(ctx, task, input.purpose);
    const subject = {
      id: task.id,
      revision: task.workflow.revision,
      ...(input.claimId ? { claimId: input.claimId } : {}),
    };
    // Replay before rebuilding live inputs or reading retained artifact bytes.
    const previous = await type.context.replay(caller, { subject, requestId: input.requestId }, tx);
    if (previous) return previous;
    const preview = await type.context.preview(
      caller,
      { subject, inputs: await contextInputs(ctx, caller, task, input.purpose, review, tx) },
      tx,
    );
    return await type.context.build(caller, { requestId: input.requestId, preview }, tx);
  });
}

/**
 * A task created without an explicit version takes the newest recipe published for its type;
 * an existing task keeps the version it was created with, whose recipe stays registered.
 */
export function newestType(ctx: TasksContext, name: string): number {
  let newest = 1;
  for (const key of ctx.types.keys()) {
    const at = key.lastIndexOf('@');
    if (key.slice(0, at) === name) newest = Math.max(newest, Number(key.slice(at + 1)));
  }
  return newest;
}

/**
 * A task's work recipe must still be registered;
 * every task is reviewed with task.review@5.
 */
export function contextType(
  ctx: TasksContext,
  task: Pick<Task, 'type' | 'typeVersion'>,
  purpose: 'work' | 'review',
) {
  const work = `${task.type}@${task.typeVersion}`;
  // The artifact-review recovery retains task.work@2's immutable identity. Its next visit
  // uses the item renderer without adding the report requirement introduced by work@5.
  // Do not register an alias: newly created tasks cannot select the retired recipe.
  const type =
    ctx.types.get(purpose === 'work' ? work : 'task.review@5') ??
    (purpose === 'work' && work === 'task.work@2' ? ctx.types.get('task.work@4') : undefined);
  check(type, 'task_type_unavailable', 'Task context recipe is unavailable', 503);
  return type;
}

/** The saved context and read-only workflow assignment use exactly the same recipe inputs. */
export async function contextInputs(
  ctx: TasksContext,
  caller: Caller,
  task: Task,
  purpose: 'work' | 'review',
  review: ReviewRequest | undefined,
  tx: Transaction,
): Promise<Record<string, ContextInput>> {
  const type = contextType(ctx, task, purpose);
  const rendered =
    purpose === 'work' &&
    (await ctx.artifacts.get(caller, task.briefId, tx)).hash ===
      sha256Hex(renderBrief(task, task.workflow.version >= 46 ? 'ordinary' : true));
  const assignmentTask = {
    id: task.id,
    title: task.title,
    briefId: task.briefId,
    producerId: task.producerId,
    reviewId: task.reviewId,
    expectedRevision: task.workflow.revision,
    ...(purpose === 'review'
      ? { goal: task.goal, deliveryCode: task.deliveryCode }
      : rendered
        ? {}
        : { acceptanceChecks: task.acceptanceChecks }),
  };
  // Worker contexts retain the offer's project and paper even if they later change; the
  // paper's items carry the Problem, which is the project's Introduction.
  const receipt = caller.session
    ? await leaseReceipt(tx, await currentLease(ctx, caller, task.id, task.workflow.revision, tx))
    : null;
  const project = receipt?.project ?? (await ctx.scope.project(caller, tx));
  const projectPaper = taskPaper(
    receipt
      ? (receipt.paper as unknown as ContextInput)
      : await ctx.paper.contextInput(caller, type.definition.recipe.maxChars, tx),
    serviceOwned(task.workflow.version),
  );
  const taskMetadata =
    JSON.stringify(assignmentTask) +
    `\n\nProject (as pinned when this work was offered):\n${JSON.stringify(project)}`;
  let inputs: Record<string, Source>;
  if (purpose === 'review') {
    check(review, 'invalid_context', 'Missing review assignment');
    inputs = {
      task: { text: taskMetadata },
      projectPaper,
      assessment: {
        text: JSON.stringify({
          id: review.id,
          subjectRevision: review.subjectRevision,
          snapshotHash: review.snapshotHash,
          claimId: review.claimId,
          status: review.status,
          artifactIds: review.artifactIds,
          criteria: review.criteria,
          requiredCriteria: review.requiredCriteria,
          formatVersion: review.formatVersion,
        }),
      },
      evidence: { artifactIds: review.artifactIds },
      taskBackground: Object.values(task.contextInputs).flat().length
        ? { artifactIds: [...new Set(Object.values(task.contextInputs).flat())] }
        : { text: 'No additional task background was specified.' },
    };
    if (review.recovery) inputs.recovery = { text: JSON.stringify(review.recovery) };
  } else {
    inputs = {
      ...Object.fromEntries(
        Object.entries(task.contextInputs).map(([key, artifactIds]) => [key, { artifactIds }]),
      ),
      task: { text: taskMetadata },
      projectPaper,
      brief: { artifactIds: [task.briefId] },
    };
    const notes = task.workflow.data.revisionContext;
    const previous =
      typeof notes === 'string' && task.reviewId
        ? await ctx.reviews.get(caller, task.reviewId, tx)
        : null;
    const reviewIds = [
      task.reviewId,
      ...(Array.isArray(task.workflow.data.rejectedReviewIds)
        ? task.workflow.data.rejectedReviewIds
        : []),
    ];
    const items: ContextItem[] = [];
    if (typeof notes === 'string') {
      const findings = previous ? clip(JSON.stringify(previous.findings), 16_000) : '';
      items.push(
        textItem(
          `feedback:${task.id}`,
          'Latest corrections',
          `${notes}\nLatest findings (read review.get for the complete assessment):\n${findings}`,
          {
            embed: 'always',
            refs: [{ tool: 'task.get', input: { taskId: task.id, full: true } }],
          },
        ),
      );
    }
    for (const reviewId of new Set(reviewIds)) {
      if (typeof reviewId !== 'string') continue;
      items.push(
        textItem(`review:${reviewId}`, 'Read findings before revising', '', {
          embed: 'never',
          refs: [{ tool: 'review.get', input: { reviewId } }],
        }),
      );
    }
    inputs.feedback = { items };
  }

  const checkpoints = await visibleCheckpoints(
    ctx,
    caller,
    { taskId: task.id, purpose, reviewId: task.reviewId, revision: task.workflow.revision },
    tx,
  );
  if (checkpoints.length) {
    // Only the newest body competes for space; every checkpoint keeps its retrieval link.
    inputs.checkpoints = {
      items: checkpoints.map((checkpoint, index) =>
        textItem(
          `checkpoints:${checkpoint.id}`,
          `Saved ${checkpoint.createdAt} at revision ${checkpoint.revision}`,
          JSON.stringify(checkpoint),
          {
            embed: index === checkpoints.length - 1 ? 'fit' : 'never',
            priority: ITEM_RULES.checkpoints!.priority! + index,
            refs: [{ tool: 'task.get', input: { taskId: task.id, checkpointId: checkpoint.id } }],
          },
        ),
      ),
    };
    const artifactIds = [...new Set(checkpoints.flatMap((c) => c.artifactIds))];
    if (artifactIds.length) inputs.checkpointEvidence = { artifactIds };
  }
  // The inputs the recipe takes, as it takes them: each text becomes one item and each artifact
  // one item named by its title, embedded as ITEM_RULES says.
  const titles = new Map(type.definition.recipe.sections.map((s) => [s.key, s.title]));
  const result: Record<string, ContextInput> = {};
  for (const [key, input] of Object.entries(inputs)) {
    if (!titles.has(key)) continue;
    const rule = ITEM_RULES[key] ?? { priority: 500 };
    if ('items' in input) {
      result[key] = input;
      continue;
    }
    result[key] = {
      items:
        'text' in input
          ? [
              textItem(`${key}:${task.id}`, titles.get(key)!, input.text, {
                ...rule,
                refs: [
                  key === 'assessment' || key === 'recovery'
                    ? { tool: 'review.get', input: { reviewId: task.reviewId } }
                    : { tool: 'task.get', input: { taskId: task.id, full: true } },
                ],
              }),
            ]
          : (await ctx.artifacts.getAll(caller, input.artifactIds, tx)).map((artifact) =>
              artifactItem(artifact, {
                id: `${key}:${artifact.id}`,
                ...rule,
                ...(artifact.id === task.briefId
                  ? { embed: 'always' as const }
                  : artifact.size > 8000
                    ? { embed: 'never' as const }
                    : {}),
              }),
            ),
    };
  }
  return result;
}

/** Admission uses domain facts only: never hydrate/evaluate here, which would recurse. */
export async function workflowAssignmentFacts(ctx: TasksContext, context: WorkflowCheckContext) {
  const purpose = context.snapshot.state === 'in_review' ? ('review' as const) : ('work' as const);
  const facts = await assignmentFacts(
    ctx,
    context.caller,
    {
      taskId: context.snapshot.id,
      expectedRevision: context.snapshot.revision,
      purpose,
    },
    context.tx,
    true,
    context.snapshot,
  );
  // An assignment check may answer 503 as a blocker, so the Code gates live here and never in
  // the action rules a bare task.get evaluates: a stored Git task stays readable while Code is unavailable.
  if (artifactReview(facts.workflow.version))
    await requireArtifactReview(context.tx, context.caller.projectId, facts.workflow.id);
  else if (facts.review)
    await reviewCommit(ctx, context.caller, facts.workflow, facts.review, context.tx);
  else {
    await ctx.code.requireLeasable(
      context.caller,
      { unitId: facts.workflow.id, writer: true },
      context.tx,
    );
  }
  contextType(ctx, { type: facts.row.type_name, typeVersion: facts.row.type_version }, purpose);
  return { ...facts, purpose };
}

export async function workflowAssignment(
  ctx: TasksContext,
  context: WorkflowCheckContext,
): Promise<WorkflowAssignmentContent> {
  const { caller, tx } = context;
  const { row, review, purpose } = await workflowAssignmentFacts(ctx, context);
  const task = await ctx.hydrate(caller, row, tx);
  const type = contextType(ctx, task, purpose);
  const subject: ContextBuild['subject'] = {
    id: task.id,
    revision: task.workflow.revision,
    ...(review?.claimId ? { claimId: review.claimId } : {}),
  };
  const preview = await type.context.preview(
    caller,
    {
      subject,
      inputs: await contextInputs(ctx, caller, task, purpose, review, tx),
    },
    tx,
  );
  const needsClaim = purpose === 'review' && review?.status === 'requested';
  const assisting = purpose === 'work' && !(await isProducer(ctx, caller, row, task.workflow, tx));
  const instruction = assisting
    ? 'Support the assigned producer using this task context and save useful checkpoints. Only the assigned producer may submit the delivery; return your evidence to that producer.'
    : needsClaim
      ? 'Claim the review with review.start, then refresh workflow.assignment for your current claim before assessing or submitting. Reading or beginning this assignment does not claim the review.' +
        (artifactReview(task.workflow.version)
          ? ''
          : ` ${task.workflow.version >= 46 ? GIT_SUBMISSION_CLAIM : GIT_CLAIM}`)
      : 'Follow context.prompt → Expected output.' +
        // A brief the caller supplied never carries these words, so the assignment always does.
        (artifactReview(task.workflow.version)
          ? ' Review the original pinned artifacts; this delivery makes no Git claim.'
          : ` ${task.workflow.version >= 46 ? (purpose === 'work' ? GIT_SUBMISSION : GIT_SUBMISSION_REVIEW) : purpose === 'work' ? GIT_DELIVERY : GIT_REVIEW}`);
  return {
    role: purpose === 'review' ? 'reviewer' : 'producer',
    label: `${purpose === 'review' ? 'Review' : 'Work'}: ${task.title}`,
    name: task.title,
    brief: `${serviceOwned(task.workflow.version) ? `${RESOLUTION_PAPER}\n\n` : ''}${SOURCE_VERIFICATION}\n\nRecover this assignment with workflow.assignment; task.get returns current context; use full:true for history or checkpointId for a saved note. Open artifact references with artifact.read and review references with review.get.`,
    references: [
      { kind: 'task', id: task.id, label: task.title },
      ...task.guidance.references,
      ...preview.sources
        .filter(
          (source) =>
            !task.guidance.references.some(
              (ref) => ref.kind === 'artifact' && ref.id === source.id,
            ),
        )
        .map((source) => ({ kind: 'artifact', id: source.id, label: source.title })),
    ],
    handoff: {
      instruction,
      tools:
        purpose === 'review'
          ? needsClaim
            ? ['review.start', 'workflow.assignment']
            : ['review.submit']
          : assisting
            ? []
            : ['task.submit_delivery'],
    },
    execution: {
      readOnly: purpose === 'review',
      // Workflows replaces this projection from the fixed execution declaration.
      tools: [],
    },
    context: preview,
  };
}

export async function workflowExecutionReferences(
  ctx: TasksContext,
  { caller, snapshot, tx, dependencies }: WorkflowCheckContext,
): Promise<WorkflowExecutionReferences> {
  const row = await ctx.row(tx, caller, snapshot.id);
  const review = row.review_id ? await ctx.reviews.get(caller, row.review_id, tx) : undefined;
  const contextInputs = JSON.parse(row.context_inputs) as Record<string, string[]>;
  const lease = caller.session
    ? await currentLease(ctx, caller, snapshot.id, snapshot.revision, tx)
    : null;
  return {
    // This assignment permits project compute.
    computeKind: 'task',
    ...(snapshot.version >= 46 ? { gitPolicy: 'approval-v1' } : {}),
    // Conflict resolution is service work: it gets no compute.
    ...(serviceOwned(snapshot.version) || artifactReview(snapshot.version)
      ? { computeProfile: 'none' }
      : {}),
    artifacts: lease
      ? await leaseArtifactIds(ctx, caller, lease, tx)
      : [
          ...new Set([
            row.brief_id,
            ...(await ctx.captureArtifactIds(caller.projectId, row.id, tx)),
            ...(JSON.parse(row.delivery_ids) as string[]),
            ...Object.values(contextInputs).flat(),
            ...(review?.artifactIds ?? []),
          ]),
        ].sort(),
    dependencies: (dependencies ?? []).map((dependency) => dependency.id).sort(),
    // What the runner bases the checkout on: the reviewer's on exactly the delivered commit, a
    // based producer's on the commit its accepted prerequisite delivered, once a lease pinned it
    // (an interactive producer has no checkout).
    ...(artifactReview(snapshot.version)
      ? {}
      : snapshot.state === 'in_review' && review
        ? {
            code: await reviewCommit(ctx, caller, snapshot, review, tx),
            ...(snapshot.version >= 46
              ? {
                  submission: (
                    snapshot.data.deliveryCode as unknown as import('./models.js').TaskDeliveryCode
                  ).sessionId,
                }
              : {}),
          }
        : await ctx.code
            .basePin(caller, snapshot.id, tx)
            .then((pin): { base?: string } => (pin ? { base: pin.reference } : {}))),
    ...((await isProducer(ctx, caller, row, snapshot, tx)) ? { producerTaskId: row.id } : {}),
    ...(review ? { reviewId: review.id } : {}),
    ...(review?.status === 'started' && review.reviewerId === caller.actorId && review.claimId
      ? { claimId: review.claimId }
      : {}),
  };
}

export async function assignmentFacts(
  ctx: TasksContext,
  caller: Caller,
  input: Omit<TaskContext, 'requestId'>,
  tx: Transaction,
  allowUnclaimedReview = false,
  /** The instance as the caller's own transaction already read it. */
  known?: WorkflowSnapshot,
): Promise<{ row: TaskRow; workflow: WorkflowSnapshot; review?: ReviewRequest }> {
  check(
    input.purpose !== 'work' || !caller.conversation,
    'conversation_task_producer_forbidden',
    'Agent conversations direct tasks; a worker must produce the work',
    403,
  );
  await ctx.scope.require(caller, input.purpose === 'review' ? 'review' : 'write', tx);
  check(
    input.purpose === 'review' || input.purpose === 'work',
    'invalid_context',
    'Unknown context purpose',
  );
  const row = await ctx.row(tx, caller, input.taskId);
  const workflow = known ?? (await ctx.workflows.get(caller, row.id, tx));
  ctx.registration(workflow.version);
  check(
    workflow.revision === input.expectedRevision,
    'revision_conflict',
    `Expected revision ${input.expectedRevision}, found ${workflow.revision}`,
    409,
  );
  if (input.purpose === 'review') {
    check(
      workflow.state === 'in_review' && row.review_id,
      'invalid_transition',
      'Task is not awaiting review',
      409,
    );
    const review = await ctx.reviews.get(caller, row.review_id, tx);
    if (allowUnclaimedReview) {
      // Activation is not a claim. An eligible reviewer may inspect the open pinned request.
      await ctx.reviews.checkStart(caller, review.id, tx);
      check(
        review.subjectRevision === workflow.revision,
        'stale_claim',
        'Review snapshot must match this task revision',
        409,
      );
    } else {
      check(
        review.status === 'started' && review.reviewerId === caller.actorId,
        'review_independence',
        'Claim the review before using its assignment',
        403,
      );
      check(input.claimId, 'invalid_input', 'A review assignment names its claimId');
      check(
        review.claimId === input.claimId && review.subjectRevision === workflow.revision,
        'stale_claim',
        'Assignment must identify the current review claim',
        409,
      );
      await ctx.reviews.checkSubmit(caller, review.id, undefined, tx);
    }
    return { row, workflow, review };
  }
  check(
    workflow.state === 'in_progress',
    'invalid_transition',
    'Task is not awaiting producer work',
    409,
  );
  await producerOrAdmin(ctx, caller, row, workflow, tx);
  check(input.claimId === undefined, 'invalid_context', 'Producer work does not use review claims');
  return { row, workflow };
}

export async function assignment(
  ctx: TasksContext,
  caller: Caller,
  input: TaskContext,
  tx: Transaction,
): Promise<{ task: Task; review?: ReviewRequest }> {
  const { row, review } = await assignmentFacts(ctx, caller, input, tx);
  if (input.purpose === 'work')
    requireDependencies((await ctx.workflows.prerequisites(caller, [row.id], tx)).get(row.id)!);
  return { task: await ctx.hydrate(caller, row, tx), review };
}
