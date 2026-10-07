import {
  check,
  childRequest,
  clip,
  folded,
  inTransaction,
  MervError,
  now,
  plain,
  recorded,
  visible,
  type Artifact,
  type Caller,
  type Data,
  type Transaction,
  type WorkflowCheckContext,
  type WorkflowTransition,
} from '@merv/contracts';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import {
  DELIVERY_REPORT_CRITERION,
  RESERVED_CONTEXT_INPUTS,
  reportsDelivery,
} from './definitions.js';
import {
  composedBriefTitle,
  renderAssessment,
  renderBrief,
  renderDeliveredCommit,
  validateConfirmations,
} from './evidence.js';
import type {
  Task,
  TaskConfirmation,
  TaskCreate,
  TaskDelivery,
  TaskDeliveryCode,
  TaskFailure,
  TaskMarkFailed,
  TaskReview,
} from './types.js';
import type { TasksContext } from './index.js';
import { producing, serviceOwned, taskVersion } from './workflow.js';
import { rejectReviewReturn } from './policy.js';
import { contextInputs, contextType, newestType } from './context.js';
import { isProducer, producerOrAdmin, unleased } from './lease.js';
import { reviewAction } from './policy.js';

// Creating a task, and the commands that move it: delivery, failure and review, with
// the guards each runs. Each runs on TaskService (index.ts) as its TasksContext.

/** Rejected rounds a task remembers; later ones push the oldest out, which no repair still needs. */
const REJECTED_REVIEWS_KEPT = 50;

/** A command's taskId, where given, names the workflow it moves. */
function sameTask(snapshot: WorkflowSnapshot, input: Data | undefined): void {
  check(
    !input || input.taskId === undefined || input.taskId === snapshot.id,
    'invalid_input',
    'taskId must match this workflow',
  );
}

/** A command's expectedRevision, where given, is the revision it moves. */
function sameRevision(snapshot: WorkflowSnapshot, input: Data | undefined, message: string) {
  check(
    !input || input.expectedRevision === undefined || input.expectedRevision === snapshot.revision,
    'revision_conflict',
    message,
    409,
  );
}

/** At most this many Done-when checks, so a delivery's confirmations always fit a workflow move. */
const MAX_CHECKS = 200;

export async function createTask(
  ctx: TasksContext,
  caller: Caller,
  input: TaskCreate,
  transaction?: Transaction,
  service?: { provider: string; baseReference?: string },
): Promise<Task> {
  caller = structuredClone(caller);
  input = plain<TaskCreate>(input);
  const body = service ? { input, service } : input;
  return await inTransaction(ctx.state, transaction, async (tx) => {
    await ctx.scope.require(caller, 'write', tx);
    return await ctx.command(tx, caller, input.requestId, 'create', body, async () => {
      const typeName = input.type ?? 'task.work',
        typeVersion = input.typeVersion ?? newestType(ctx, typeName);
      const type = ctx.types.get(`${typeName}@${typeVersion}`)?.definition;
      check(
        type?.kind === 'work',
        'task_type_unavailable',
        'An active work task type/version is required',
        409,
      );
      check(
        (input.workspace === undefined || input.workspace === 'git') &&
          input.baseTaskId === undefined,
        'invalid_workspace',
        'New tasks always use Git. Omit workspace or use git, and use dependsOn for accepted code dependencies; baseTaskId is retired.',
      );
      await ctx.code.ensureRepository(caller, tx);
      const inputIds = input.contextInputs ?? {};
      check(
        inputIds && typeof inputIds === 'object' && !Array.isArray(inputIds),
        'invalid_context',
        'Context inputs must map section keys to artifact IDs',
      );
      const custom = type.recipe.sections.filter((s) => !RESERVED_CONTEXT_INPUTS.has(s.key));
      check(
        Object.keys(inputIds).every((key) => custom.some((s) => s.key === key)),
        'invalid_context',
        'Unknown or reserved task context input',
      );
      for (const section of custom) {
        const ids = Object.hasOwn(inputIds, section.key) ? inputIds[section.key] : [];
        check(
          Array.isArray(ids) &&
            ids.every((id) => typeof id === 'string' && id.length > 0) &&
            new Set(ids).size === ids.length,
          'invalid_context',
          'Context inputs must contain distinct artifact IDs',
        );
        check(
          !section.required || ids.length > 0,
          'context_missing',
          `Missing required context: ${section.key}`,
        );
        await ctx.artifacts.getAll(caller, ids, tx);
      }
      // The brief renders the title and each check on its own numbered line.
      const line = (value: unknown) =>
        typeof value === 'string' && visible(value) && !/[\r\n]/.test(value);
      check(
        line(input.title) && typeof input.goal === 'string' && visible(input.goal),
        'invalid_brief',
        'Task title must be one nonempty line and the goal nonempty',
      );
      check(
        Array.isArray(input.checks) && input.checks.length > 0 && input.checks.every(line),
        'invalid_checks',
        'Task requires at least one nonempty single-line Done-when check',
      );
      check(
        input.checks.length <= MAX_CHECKS,
        'invalid_checks',
        `A task has at most ${MAX_CHECKS} Done-when checks`,
      );
      check(
        new Set(input.checks.map(folded)).size === input.checks.length,
        'invalid_checks',
        'Done-when checks must be distinct',
      );
      const checks = [...input.checks];
      let brief: Artifact;
      let content: string;
      if (input.briefId === undefined) {
        // A brief rendered here is checked as written: its input is plain text, without NUL or
        // a lone surrogate, so it reads back unchanged. It is the producer's own text document.
        content = renderBrief({ ...input, checks }, true);
        brief = await ctx.artifacts.create(
          caller,
          { title: composedBriefTitle(input.title), content },
          tx,
        );
      } else {
        brief = await ctx.artifacts.get(caller, input.briefId, tx);
        check(
          brief.createdBy === caller.actorId,
          'forbidden',
          'The brief must belong to the task producer',
          403,
        );
        check(
          brief.size > 0 && brief.mediaType.startsWith('text/'),
          'invalid_brief',
          'The brief must be a nonempty text document',
        );
        const document = await ctx.artifacts.read(caller, brief.id, undefined, tx);
        check(
          document.encoding === 'utf8',
          'invalid_brief',
          'The brief must contain valid UTF-8 text',
        );
        content = document.content;
      }
      // The brief is embedded whole in every work context: it must leave the recipe room.
      check(
        content.length <= 32_000,
        'invalid_brief',
        'The brief (goal and checks) must fit 32,000 characters',
      );
      const text = folded(content);
      check(
        text.includes(folded(input.goal)) && checks.every((item) => text.includes(folded(item))),
        'invalid_brief',
        'The pinned brief must contain the task goal and every Done-when check',
      );
      // Once Code keeps the project's history, new Git work lives there and nowhere else.
      const version = taskVersion(!!service);
      const workflow = await (
        await ctx.registration(version)
      ).start(
        caller,
        {
          workflow: 'task',
          version,
          requestId: childRequest(caller, 'task', 'create', input.requestId),
          ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
          data: {
            title: input.title,
            goal: input.goal,
            checks,
            producerId: caller.actorId,
            briefId: brief.id,
            evidenceVersion: 2,
            // Other plugins read a Git task's choice and base here without injecting Tasks.
            workspace: 'git',
          },
        },
        tx,
      );
      await tx.run(
        'INSERT INTO tasks (id, project_id, title, goal, checks, producer_id, brief_id, created_at,type_name,type_version,context_inputs,evidence_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2)',
        workflow.id,
        caller.projectId,
        input.title,
        input.goal,
        JSON.stringify(checks),
        caller.actorId,
        brief.id,
        now(),
        typeName,
        typeVersion,
        JSON.stringify(inputIds),
      );
      await ctx.code.declareUnit(caller, workflow.id, tx, service?.baseReference);
      await recorded(ctx.state, tx, caller, 'task.created', workflow.id, {
        briefId: brief.id,
        evidenceVersion: 2,
      });
      const task = await ctx.hydrate(caller, await ctx.row(tx, caller, workflow.id), tx);
      // Render what every work context embeds, or the task could never begin. A session's
      // lease is on its own task, so the check reads as the session's actor.
      const { session: _session, ...owner } = caller;
      const subject = { id: task.id, revision: task.workflow.revision };
      const inputs = await contextInputs(ctx, owner, task, 'work', undefined, tx);
      // The brief is rendered as the text in hand rather than read back.
      if (inputs.brief) inputs.brief.items[0].body = { text: content };
      await contextType(ctx, task, 'work')
        .context.preview(owner, { subject, inputs }, tx)
        .catch((error: unknown) => {
          check(
            !(error instanceof MervError && error.code === 'context_too_large'),
            'invalid_brief',
            'The goal and checks leave no room in the work context; shorten them',
          );
          throw error;
        });
      return task;
    });
  });
}

/** With a proposed delivery, answers the commit and confirmations it checked, for reuse. */
export async function checkDelivery(
  ctx: TasksContext,
  { caller, snapshot: current, tx, input: proposed }: WorkflowCheckContext,
): Promise<
  | {
      commit: Awaited<ReturnType<typeof deliveredCommit>>;
      confirmations: TaskConfirmation[];
    }
  | undefined
> {
  check(
    !caller.conversation,
    'conversation_task_producer_forbidden',
    'Agent conversations direct tasks; a worker must submit the delivery',
    403,
  );
  await ctx.scope.require(caller, 'write', tx);
  const row = await ctx.row(tx, caller, current.id);
  check(
    await isProducer(ctx, caller, row, current, tx),
    'forbidden',
    'Only this task’s producer may submit its delivery',
    403,
  );
  await unleased(ctx, caller, row.id, current.revision, tx);
  check(
    current.state === 'in_progress',
    'invalid_transition',
    'Task must be in progress to submit a delivery',
    409,
  );
  if (!proposed) return undefined;
  sameTask(current, proposed);
  sameRevision(current, proposed, 'Task revision changed; refresh the task before submitting');
  const input = proposed as unknown as TaskDelivery;
  check(
    Array.isArray(input.artifactIds) &&
      new Set(input.artifactIds).size === input.artifactIds.length &&
      input.artifactIds.every((id) => typeof id === 'string' && id.length > 0),
    'invalid_delivery',
    'Delivery requires a list of distinct artifacts',
  );
  const commit = await deliveredCommit(ctx, caller, current, input.commandId, tx);
  // No task's brief is a delivery, this task's least of all; nor is a record Merv rendered
  // for an earlier delivery, which every delivery records in history. A Git task that
  // delivers its commit alone names no artifact to look up.
  if (input.artifactIds.length) {
    const placeholders = input.artifactIds.map(() => '?').join(',');
    const briefs = await tx.all<{ brief_id: string }>(
      `SELECT brief_id FROM tasks WHERE project_id=? AND brief_id IN (${placeholders})`,
      caller.projectId,
      ...input.artifactIds,
    );
    check(briefs.length === 0, 'invalid_delivery', 'A task brief cannot serve as a delivery');
    const rendered = await ctx.workflows.moves(
      caller.projectId,
      {
        action: 'submit_delivery',
        keys: ['deliveryAssessmentId', 'deliveryCodeArtifactId'],
        values: input.artifactIds,
      },
      tx,
    );
    check(
      !rendered,
      'invalid_delivery',
      'A confirmation sheet or commit record Merv rendered for a delivery cannot serve as evidence',
    );
  }
  const artifacts = await ctx.artifacts.getAll(caller, input.artifactIds, tx);
  const captures = new Set((await ctx.captureArtifactIds(caller.projectId, row.id, tx)) ?? []);
  check(
    artifacts.every(
      (item) => (item.createdBy === caller.actorId || captures.has(item.id)) && item.size > 0,
    ),
    'invalid_delivery',
    'Delivery artifacts must be nonempty and belong to the producer',
  );
  return {
    commit,
    confirmations: validateConfirmations(
      input.confirmations,
      JSON.parse(row.checks),
      input.artifactIds,
    ),
  };
}

/**
 * The commit a Git task delivers is this worker's own code.commit. Its receipt already exists
 * when the worker submits, so a review is never requested
 * on a commit no runner has recorded. Every condition is a separate defence: the session is
 * what stops a successor from delivering its predecessor's commit.
 */
export async function deliveredCommit(
  ctx: TasksContext,
  caller: Caller,
  snapshot: WorkflowSnapshot,
  commandId: unknown,
  tx: Transaction,
) {
  check(
    typeof commandId === 'string' && commandId.length > 0 && caller.session,
    'task_commit_required',
    'A Git task delivers this worker’s own successful code.commit; only a leased worker can obtain one',
    409,
  );
  const checked = await ctx.code.checkCapture(
    caller,
    { kind: 'code-commit', commandId },
    {
      unitId: snapshot.id,
      revision: snapshot.revision,
      workflow: producing,
      sessionId: caller.session.id,
      actorId: caller.actorId,
    },
    tx,
  );
  check(
    checked.status !== 'foreign',
    'task_commit_provenance',
    'Deliver a commit this worker made for this task revision',
    409,
  );
  check(
    checked.status !== 'pending',
    'task_commit_pending',
    'Wait for code.operation to report succeeded',
    409,
  );
  check(
    checked.status === 'ready',
    'task_commit_failed',
    'The code.commit operation did not succeed; commit again and deliver that operation',
    409,
  );
  return checked.capture;
}

export async function checkFailure(
  ctx: TasksContext,
  { caller, snapshot, tx, input }: WorkflowCheckContext,
): Promise<void> {
  await ctx.scope.require(caller, 'write', tx);
  const row = await ctx.row(tx, caller, snapshot.id);
  await producerOrAdmin(ctx, caller, row, snapshot, tx);
  sameTask(snapshot, input);
  check(
    snapshot.state === 'in_progress' || snapshot.state === 'in_review',
    'invalid_transition',
    'Only an active task can be marked failed',
    409,
  );
  sameRevision(snapshot, input, 'Task changed; refresh it before marking it failed');
  check(
    !input ||
      (typeof input.reason === 'string' && visible(input.reason) && input.reason.length <= 16000),
    'invalid_reason',
    'A specific reason of 1–16000 characters is required to mark a task failed',
  );
  if (snapshot.state === 'in_review') {
    check(row.review_id, 'stale_review', 'The task has no current review', 409);
    const review = await ctx.reviews.get(caller, row.review_id, tx);
    check(
      review.status === 'requested' || review.status === 'started',
      'review_closed',
      'Only an unfinished review can be closed by withdrawing a task',
      409,
    );
  }
}

/**
 * One task command: in its transaction and under its requestId, `run` moves the task and names
 * it, and the command answers with the task as it then stands.
 */
export async function taskCommand(
  ctx: TasksContext,
  caller: Caller,
  transaction: Transaction | undefined,
  permission: 'write' | 'review',
  operation: string,
  input: { requestId: string },
  run: (tx: Transaction) => Promise<string>,
): Promise<Task> {
  return await inTransaction(ctx.state, transaction, async (tx) => {
    await ctx.scope.require(caller, permission, tx);
    return await ctx.command(tx, caller, input.requestId, operation, input, async () => {
      const taskId = await run(tx);
      return await ctx.hydrate(caller, await ctx.row(tx, caller, taskId), tx);
    });
  });
}

/**
 * A command's transition and the sandbox step that follows it. `checked` is what the command
 * found when it ran the action's guard on `current` itself: the transition runs that guard
 * again in this transaction, and only that run takes it instead of checking twice.
 */
export async function advance(
  ctx: TasksContext,
  caller: Caller,
  current: WorkflowSnapshot,
  transition: Omit<WorkflowTransition, 'instanceId' | 'expectedRevision'> & {
    expectedRevision?: number;
  },
  tx: Transaction,
  checked?: unknown,
): Promise<WorkflowSnapshot> {
  const moved = await ctx.checked.take(
    tx,
    { instanceId: current.id, revision: current.revision, action: transition.action },
    () =>
      ctx
        .registration(current.version)
        .transition(
          caller,
          { instanceId: current.id, expectedRevision: current.revision, ...transition },
          tx,
        ),
    checked,
  );
  return moved;
}

export async function markFailed(
  ctx: TasksContext,
  caller: Caller,
  input: TaskMarkFailed,
  transaction?: Transaction,
): Promise<Task> {
  ({ caller, input } = structuredClone({ caller, input }));
  return await taskCommand(ctx, caller, transaction, 'write', 'mark_failed', input, async (tx) => {
    check(
      Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
      'invalid_revision',
      'Expected revision must be a nonnegative integer',
    );
    const row = await ctx.row(tx, caller, input.taskId);
    const current = await ctx.workflows.get(caller, row.id, tx);
    await checkFailure(ctx, { caller, snapshot: current, tx, input: { ...input } });
    const reviewId = current.state === 'in_review' ? row.review_id : null;
    const failure: TaskFailure = {
      reason: input.reason,
      actorId: caller.actorId,
      createdAt: now(),
      reviewId,
    };
    await advance(
      ctx,
      caller,
      current,
      {
        action: 'mark_failed',
        input: { ...input, expectedRevision: current.revision },
        requestId: childRequest(caller, 'task', 'failure', input.requestId),
        data: {
          outcome: input.reason,
          failure: { ...failure },
          ...(serviceOwned(current.version) ? { revisionContext: input.reason } : {}),
        },
      },
      tx,
      true,
    );
    if (reviewId) await ctx.reviews.supersede(caller, reviewId, tx);
    await recorded(
      ctx.state,
      tx,
      caller,
      serviceOwned(current.version) ? 'task.suspended' : 'task.failed',
      row.id,
      { ...failure },
    );
    return row.id;
  });
}

/**
 * Fails a task of this project that nobody started, for a coordinator whose selected work
 * waits on an input that ended without success: one still in progress with no work ever
 * started on it. False, with nothing changed, for anything else.
 */
export async function closeUnstarted(
  ctx: TasksContext,
  caller: Caller,
  taskId: string,
  reason: string,
  requestId: string,
  tx: Transaction,
): Promise<boolean> {
  const row = await tx.get<{ id: string }>(
    'SELECT id FROM tasks WHERE id=? AND project_id=?',
    taskId,
    caller.projectId,
  );
  if (!row) return false;
  const current = await ctx.workflows.get(caller, row.id, tx);
  if (current.state !== 'in_progress') return false;
  if ((await ctx.workflows.workStarts(caller, row.id, tx)).length) return false;
  await markFailed(
    ctx,
    caller,
    { taskId, expectedRevision: current.revision, reason, requestId },
    tx,
  );
  return true;
}

export async function submitDelivery(
  ctx: TasksContext,
  caller: Caller,
  input: TaskDelivery,
): Promise<Task> {
  caller = structuredClone(caller);
  input = plain<TaskDelivery>(input);
  check(
    !caller.conversation,
    'conversation_task_producer_forbidden',
    'Agent conversations direct tasks; a worker must submit the delivery',
    403,
  );
  return await taskCommand(
    ctx,
    caller,
    undefined,
    'write',
    'submit_delivery',
    input,
    async (tx) => {
      const row = await ctx.row(tx, caller, input.taskId);
      const checks: string[] = JSON.parse(row.checks);
      const current = await ctx.workflows.get(caller, row.id, tx);
      ctx.registration(current.version);
      const delivered = (await checkDelivery(ctx, {
        caller,
        snapshot: current,
        tx,
        input: { ...input },
      }))!;
      const commit = delivered.commit;
      // Reviews pins artifacts and knows nothing of commits, so the commit enters the review
      // as a rendered record: pinned and hashed like any evidence, and citable by a finding.
      const codeArtifact = await ctx.artifacts.create(
        caller,
        {
          title: clip(`Delivered commit: ${row.title}`, 300),
          content: renderDeliveredCommit(row.title, commit),
        },
        tx,
      );
      // A met claim that cites no file is backed by the delivered commit, which is always there.
      const confirmations = delivered.confirmations.map((item) =>
        item.status === 'met' && !item.evidenceIds.length
          ? { ...item, evidenceIds: [codeArtifact.id] }
          : item,
      );
      const assessment = await ctx.artifacts.create(
        caller,
        {
          title: clip(`Delivery confirmations: ${row.title}`, 300),
          content: renderAssessment(checks, confirmations),
        },
        tx,
      );
      const deliveryIds = [...input.artifactIds, codeArtifact.id, assessment.id];
      const deliveryCode: TaskDeliveryCode = {
        ref: { kind: 'code-commit', commandId: input.commandId! },
        sessionId: commit.provenance.sessionId,
        revision: commit.provenance.revision,
        headOid: commit.workspace.headOid,
        treeOid: commit.workspace.treeOid ?? null,
      };
      const moved = await advance(
        ctx,
        caller,
        current,
        {
          expectedRevision: input.expectedRevision,
          action: 'submit_delivery',
          input: { ...input },
          requestId: childRequest(caller, 'task', 'delivery', input.requestId),
          data: {
            deliveryIds,
            deliveryConfirmations: confirmations.map((item) => ({ ...item })),
            deliveryAssessmentId: assessment.id,
            deliveryCode: { ...deliveryCode },
            deliveryCodeArtifactId: codeArtifact.id,
          },
        },
        tx,
        delivered,
      );
      const review = await ctx.reviews.request(
        caller,
        {
          subjectId: row.id,
          subjectRevision: moved.revision,
          // Whichever service created it, a service task is Git work, and only Code can name
          // who wrote what it stands on.
          ...(serviceOwned(current.version) ? { provenanceOwner: 'code' } : {}),
          producerId: caller.actorId,
          // A service owns the task but never directs a worker. Reviews retains the
          // authenticated runner source as the delivery's administrative authority.
          administrativeActorId: serviceOwned(current.version)
            ? (await ctx.scope.authorityActor(caller, tx)).id
            : row.producer_id,
          // Captures are service-authored evidence, already checked as owned by this task.
          // Pin them through Reviews' ordinary input contract rather than changing authorship.
          pinnedInputIds: [
            ...(caller.session ? [row.brief_id] : []),
            ...((await ctx.captureArtifactIds(caller.projectId, row.id, tx)) ?? []).filter((id) =>
              input.artifactIds.includes(id),
            ),
          ],
          // Neither the owner nor the authority that directed a worker is independent of its delivery.
          ...(caller.session
            ? {
                excludedActorIds: [
                  ...new Set([row.producer_id, (await ctx.scope.authorityActor(caller, tx)).id]),
                ],
              }
            : {}),
          artifactIds: [row.brief_id, ...deliveryIds],
          criteria: reportsDelivery(row.type_name, row.type_version)
            ? [...checks, DELIVERY_REPORT_CRITERION]
            : checks,
          formatVersion: 2,
          requestId: childRequest(caller, 'task', 'delivery', input.requestId),
        },
        tx,
      );
      await tx.run(
        'UPDATE tasks SET delivery_ids = ?, review_id = ? WHERE id = ? AND project_id = ?',
        JSON.stringify(deliveryIds),
        review.id,
        row.id,
        caller.projectId,
      );
      await recorded(ctx.state, tx, caller, 'task.delivery_submitted', row.id, {
        reviewId: review.id,
        snapshotHash: review.snapshotHash,
        artifactIds: deliveryIds,
        headOid: deliveryCode.headOid,
      });
      return row.id;
    },
  );
}

export async function submitReview(
  ctx: TasksContext,
  caller: Caller,
  input: TaskReview,
  transaction?: Transaction,
): Promise<Task> {
  caller = structuredClone(caller);
  rejectReviewReturn(input);
  input = plain<TaskReview>(input);
  check(
    (input as { paperChanges?: unknown }).paperChanges === undefined,
    'paper_edits_unavailable',
    'Only experiment and reflection reviewers update the paper with a verdict',
  );
  return await taskCommand(
    ctx,
    caller,
    transaction,
    'review',
    'submit_review',
    input,
    async (tx) => {
      const review = await ctx.reviews.get(caller, input.reviewId, tx);
      const row = await ctx.row(tx, caller, review.subjectId);
      const current = await ctx.workflows.get(caller, row.id, tx);
      check(
        row.review_id === review.id,
        'stale_review',
        'This review no longer belongs to the current task submission',
        409,
      );
      check(
        current.state === 'in_review',
        'review_closed',
        `This review has ended; the task is ${current.state}`,
        409,
      );
      check(
        review.subjectRevision === current.revision,
        'revision_conflict',
        'Task changed since the review snapshot was pinned',
        409,
      );
      check(
        current.revision === input.expectedRevision,
        'revision_conflict',
        `Expected revision ${input.expectedRevision}, found ${current.revision}`,
        409,
      );
      await ctx.reviews.checkSubmit(caller, input.reviewId, input, tx);
      const action = await reviewAction(ctx, { caller, snapshot: current, tx }, input.verdict);
      const moved = await advance(
        ctx,
        caller,
        current,
        {
          action,
          // Reviews keeps the whole verdict. The move carries the verdict, its notes and each
          // criterion's status, never their evidence, so a verdict Reviews accepts always fits
          // the workflow's own input limit.
          input: {
            reviewId: input.reviewId,
            claimId: input.claimId,
            verdict: input.verdict,
            expectedRevision: input.expectedRevision,
            requestId: input.requestId,
            ...(input.notes === undefined ? {} : { notes: input.notes }),
            ...(input.synopsis === undefined ? {} : { synopsis: input.synopsis }),
            ...(input.findings === undefined
              ? {}
              : {
                  findings: input.findings.map(({ criterionNumber, status }) => ({
                    criterionNumber,
                    status,
                  })),
                }),
          },
          requestId: childRequest(caller, 'task', 'review', input.requestId),
          data: {
            verdict: input.verdict,
            reviewId: input.reviewId,
            outcome:
              input.verdict === 'pass'
                ? typeof input.evidence?.outcome === 'string'
                  ? input.evidence.outcome.trim()
                  : input.synopsis?.trim() || input.notes
                : null,
            revisionContext: input.verdict === 'pass' ? null : input.notes,
            // revisionContext holds one round, so the ids of all of them are kept beside it.
            ...(input.verdict === 'pass'
              ? {}
              : {
                  rejectedReviewIds: [
                    ...(Array.isArray(current.data.rejectedReviewIds)
                      ? (current.data.rejectedReviewIds as string[])
                      : []),
                    input.reviewId,
                  ].slice(-REJECTED_REVIEWS_KEPT),
                }),
            ...(input.verdict === 'fail'
              ? {
                  failure: {
                    reason: input.synopsis?.trim() || input.notes,
                    actorId: caller.actorId,
                    createdAt: now(),
                    reviewId: input.reviewId,
                  } satisfies TaskFailure,
                }
              : {}),
          },
        },
        tx,
        review,
      );
      const submitted = await ctx.reviews.submit(
        caller,
        {
          reviewId: input.reviewId,
          claimId: input.claimId,
          verdict: input.verdict,
          notes: input.notes,
          ...(input.synopsis === undefined ? {} : { synopsis: input.synopsis }),
          ...(input.findings === undefined ? {} : { findings: input.findings }),
          ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
          requestId: childRequest(caller, 'task', 'review', input.requestId),
        },
        tx,
      );
      // Acceptance records the exact reviewed commit in the same transaction.
      if (input.verdict === 'pass')
        await ctx.code.acceptUnit(
          caller,
          {
            unitId: row.id,
            terminalRevision: moved.revision,
            submissionRef: review.snapshotHash,
            reviewRef: review.id,
            // The accept guard has just re-derived a Git task's delivered commit from Code.
            codeRef: (current.data.deliveryCode as unknown as TaskDeliveryCode).ref,
            reviewSessionId: caller.session?.id ?? null,
          },
          tx,
        );
      await recorded(ctx.state, tx, caller, 'task.review_applied', row.id, {
        reviewId: submitted.id,
        verdict: submitted.verdict,
        action,
      });
      return row.id;
    },
  );
}
