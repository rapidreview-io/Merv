import { reviewHistory } from '@merv/reviews/rules';
import { requireDependencies } from '@merv/workflows/rules';
import {
  check,
  clip,
  mapAsync,
  sha256Hex,
  type Caller,
  type ContextBuild,
  type ContextInput,
  type ContextItem,
  type ContextPackage,
  type ContextRecipeDefinition,
  type Data,
  type ReviewRequest,
  type Transaction,
  type WorkflowAssignmentContent,
  type WorkflowCheckContext,
  type WorkflowExecutionReferences,
  type WorkflowSnapshot,
} from '@merv/contracts';
import { computeGuidance } from '@merv/sandboxes/compute-capability';
import { artifactItem, textItem } from '@merv/context-builder/artifact-item';
import { renderBrief } from './evidence.js';
import type { Task, TaskContext } from './types.js';
import type { TaskRow, TasksContext } from './index.js';
import {
  GIT_CLAIM,
  GIT_DELIVERY,
  GIT_REVIEW,
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

// A task's work and review contexts, and the assignment each of its states offers. Each runs
// on TaskService (index.ts) as its TasksContext.

/**
 * What the earlier rounds may add to the optional feedback section. The section is dropped whole
 * when it does not fit, so they stay small beside the latest pinned assessment.
 */
const REVIEW_HISTORY_CHARS = 4000;
/**
 * The most the latest pinned assessment adds to the always-embedded feedback, which also holds
 * that round's notes (up to 16,000 characters) beside a brief of up to 32,000, so a task returned
 * with any valid review still has a work context.
 */
const PINNED_ASSESSMENT_CHARS = 16_000;

/** The latest assessment whole, or abbreviated to PINNED_ASSESSMENT_CHARS with review.get named. */
function pinnedAssessment(review: ReviewRequest): string {
  const { id: reviewId, snapshotHash, artifactIds, verdict, notes, criteria } = review;
  const { synopsis, findings, evidence } = review;
  const assessment = {
    reviewId,
    snapshotHash,
    artifactIds,
    verdict,
    notes,
    criteria,
    synopsis,
    findings,
    evidence,
  };
  const whole = JSON.stringify(assessment);
  if (whole.length <= PINNED_ASSESSMENT_CHARS) return whole;
  // The notes are the feedback's own text and the criteria the brief's checks.
  const short = JSON.stringify({ ...assessment, notes: undefined, criteria: undefined });
  const more = `\n(Abbreviated for room: read review.get ${reviewId} for the whole assessment.)`;
  return clip(short, PINNED_ASSESSMENT_CHARS - more.length) + more;
}

/** A context input before it becomes items: one text, or artifacts listed by ID. */
type Source = { text: string } | { artifactIds: string[] } | ContextInput;
/**
 * How each section's items are embedded. The task, its brief, revision feedback and the review
 * criteria are always embedded; the rest fit while they can, highest priority first. A custom
 * input section is fit at 500, like the task background.
 */
const ITEM_RULES: Record<string, Pick<ContextItem, 'embed' | 'priority'>> = {
  task: { embed: 'always' },
  brief: { embed: 'always' },
  feedback: { embed: 'always' },
  assessment: { embed: 'always' },
  evidence: { priority: 800 },
  recovery: { priority: 600 },
  taskBackground: { priority: 500 },
  checkpoints: { priority: 400 },
  checkpointEvidence: { priority: 300 },
};

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
  const type = ctx.types.get(purpose === 'work' ? work : 'task.review@5');
  check(type, 'task_type_unavailable', 'Task context recipe is unavailable', 503);
  return type;
}

/** The project, without its Introduction: Paper writes it from the Problem, whose sections
 * the paper's own items carry. */
export async function projectContext(
  ctx: TasksContext,
  caller: Caller,
  tx: Transaction,
): Promise<Data> {
  const project = await ctx.scope.project(caller, tx);
  return { id: project.id, name: project.name, contextRevision: project.contextRevision ?? 0 };
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
  // Reverse links change when downstream work is added, independently of this assignment. The
  // checks reach a worker in the brief and a reviewer in the criteria, the goal in the brief,
  // the last round's notes in the feedback, and the delivery's confirmations in its pinned
  // sheet: each is embedded once, and task.get has all. A producer's own brief need not number
  // the checks, so a worker is given them numbered unless Merv rendered the brief.
  const {
    dependents: _dependents,
    checks: _checks,
    settled: _settled,
    failed: _failed,
    composed: _composed,
    acceptanceChecks,
    ...record
  } = task;
  const { deliveryConfirmations: _confirmations, deliveryIds: _deliveryIds, ...rest } = record;
  const { goal: _goal, workflow, ...work } = rest;
  const { deliveryIds: _ids, ...reviewData } = workflow.data;
  const { revisionContext: _feedback, ...data } = reviewData;
  const rendered =
    purpose === 'work' &&
    (await ctx.artifacts.get(caller, task.briefId, tx)).hash === sha256Hex(renderBrief(task, true));
  const assignmentTask =
    purpose === 'work'
      ? { ...work, ...(rendered ? {} : { acceptanceChecks }), workflow: { ...workflow, data } }
      : { ...rest, workflow: { ...workflow, data: reviewData } };
  // Worker contexts retain the offer's Introduction and paper even if they later change.
  const receipt = caller.session
    ? (JSON.parse(
        (await currentLease(ctx, caller, task.id, task.workflow.revision, tx)).receipt,
      ) as Data)
    : null;
  const project = receipt?.project ?? (await projectContext(ctx, caller, tx));
  const projectPaper = receipt
    ? (receipt.paper as unknown as ContextInput)
    : await ctx.paper.contextInput(caller, type.definition.recipe.maxChars, tx);
  const taskMetadata =
    JSON.stringify(assignmentTask) +
    `\n\nProject Introduction (captured project context):\n${JSON.stringify(project)}`;
  let inputs: Record<string, Source>;
  if (purpose === 'review') {
    check(review, 'invalid_context', 'Missing review assignment');
    inputs = {
      task: { text: taskMetadata },
      projectPaper,
      assessment: { text: JSON.stringify(review) },
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
    if (typeof task.workflow.data.revisionContext === 'string') {
      const previous = task.reviewId ? await ctx.reviews.get(caller, task.reviewId, tx) : null;
      const earlier = reviewHistory(
        await mapAsync(
          (Array.isArray(task.workflow.data.rejectedReviewIds)
            ? (task.workflow.data.rejectedReviewIds as string[])
            : []
          ).filter((id) => id !== task.reviewId),
          async (id) => {
            const review = await ctx.reviews.get(caller, id, tx);
            return { review, label: `Submitted evidence: ${review.artifactIds.join(', ')}` };
          },
        ),
        REVIEW_HISTORY_CHARS,
      );
      inputs.feedback = {
        text:
          task.workflow.data.revisionContext +
          (previous?.status === 'submitted' &&
          (previous.notes ||
            previous.synopsis ||
            previous.findings.length ||
            Object.keys(previous.evidence).length)
            ? '\n\nPinned review assessment (verify cited evidence before revising):\n' +
              pinnedAssessment(previous)
            : '') +
          (earlier.rounds.length
            ? '\n\nEarlier review rounds, oldest first (each was answered by a later delivery; do not reintroduce what they rejected):\n' +
              JSON.stringify(earlier)
            : ''),
      };
    }
  }
  const checkpoints = await visibleCheckpoints(
    ctx,
    caller,
    task.id,
    purpose,
    task.reviewId,
    task.workflow.revision,
    tx,
  );
  if (checkpoints.length) {
    // One item each, newest first to be embedded, and each read back alone by its ID.
    inputs.checkpoints = {
      items: checkpoints.map((checkpoint, index) =>
        textItem(
          `checkpoints:${checkpoint.id}`,
          `Saved ${checkpoint.createdAt} at revision ${checkpoint.revision}`,
          JSON.stringify(checkpoint),
          {
            priority: ITEM_RULES.checkpoints!.priority! + index,
            refs: [{ tool: 'task.get', input: { taskId: task.id, checkpointId: checkpoint.id } }],
          },
        ),
      ),
    };
    const artifactIds = [...new Set(checkpoints.flatMap((c) => c.artifactIds))];
    if (artifactIds.length) inputs.checkpointEvidence = { artifactIds };
  }
  inputs = Object.fromEntries(
    Object.entries(inputs).filter(([key]) =>
      type.definition.recipe.sections.some((section) => section.key === key),
    ),
  );
  return await contextItems(ctx, caller, task, inputs, type, tx);
}

/**
 * The inputs as the recipe takes them: each text becomes one item and each artifact one
 * item named by its title, embedded as ITEM_RULES says.
 */
export async function contextItems(
  ctx: TasksContext,
  caller: Caller,
  task: Task,
  inputs: Record<string, Source>,
  type: { definition: ContextRecipeDefinition },
  tx: Transaction,
): Promise<Record<string, ContextInput>> {
  const titles = new Map(type.definition.recipe.sections.map((s) => [s.key, s.title]));
  const result: Record<string, ContextInput> = {};
  for (const [key, input] of Object.entries(inputs)) {
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
                    : { tool: 'task.get', input: { taskId: task.id } },
                ],
              }),
            ]
          : await mapAsync(input.artifactIds, async (id) =>
              artifactItem(await ctx.artifacts.get(caller, id, tx), {
                id: `${key}:${id}`,
                ...rule,
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
  if (facts.review)
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
        ` ${GIT_CLAIM}`
      : type.definition.recipe.outputInstructions +
        // A brief the caller supplied never carries these words, so the assignment always does.
        ` ${purpose === 'work' ? GIT_DELIVERY : GIT_REVIEW}`;
  return {
    role: purpose === 'review' ? 'reviewer' : 'producer',
    label: `${purpose === 'review' ? 'Review' : 'Work'}: ${task.title}`,
    name: task.title,
    brief:
      `${type.definition.recipe.instructions}\n\nGoal: ${task.goal}\n\nDone when:\n${task.checks.map((check, i) => `${i + 1}. ${check}`).join('\n')}\n\n${instruction}\n\n${SOURCE_VERIFICATION}` +
      (serviceOwned(task.workflow.version)
        ? ''
        : computeGuidance(purpose === 'review' ? 'check' : 'execute')),
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
    // The native Sandboxes work kind a task binds compute under.
    computeKind: 'task',
    // Conflict resolution is service work: it gets no compute.
    ...(serviceOwned(snapshot.version) ? { computeProfile: 'none' } : {}),
    artifacts: lease
      ? await leaseArtifactIds(ctx, caller, lease, tx)
      : [
          ...new Set([
            row.brief_id,
            ...((await ctx.captureArtifactIds(caller.projectId, row.id, tx)) ?? []),
            ...(JSON.parse(row.delivery_ids) as string[]),
            ...Object.values(contextInputs).flat(),
            ...(review?.artifactIds ?? []),
          ]),
        ].sort(),
    dependencies: (dependencies ?? []).map((dependency) => dependency.id).sort(),
    // What the runner bases the checkout on: the reviewer's on exactly the delivered commit, a
    // based producer's on the commit its accepted prerequisite delivered.
    ...(snapshot.state === 'in_review' && review
      ? { code: await reviewCommit(ctx, caller, snapshot, review, tx) }
      : await pinnedBase(ctx, caller, snapshot, tx)),
    ...((await isProducer(ctx, caller, row, snapshot, tx)) ? { producerTaskId: row.id } : {}),
    ...(review ? { reviewId: review.id } : {}),
    ...(review?.status === 'started' && review.reviewerId === caller.actorId && review.claimId
      ? { claimId: review.claimId }
      : {}),
  };
}

/**
 * A derived base is only ever read here. Until a lease has pinned one there is none to name:
 * an interactive producer has no checkout, and a leased one always finds its pin.
 */
export async function pinnedBase(
  ctx: TasksContext,
  caller: Caller,
  snapshot: WorkflowSnapshot,
  tx: Transaction,
): Promise<{ base?: string }> {
  const pin = await ctx.code.basePin(caller, snapshot.id, tx);
  return pin ? { base: pin.reference } : {};
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
