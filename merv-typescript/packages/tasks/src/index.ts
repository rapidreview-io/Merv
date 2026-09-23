import {
  check,
  clip,
  createService,
  digest,
  excludedFromReview,
  inTransaction,
  mapAsync,
  MervError,
  newId,
  now,
  plain,
  recorded,
  releasedLease,
  reviewHistory,
  visible,
  type Artifacts,
  type Caller,
  type CodeUnit,
  type ContextBuild,
  type ContextBuilder,
  type ContextInput,
  type ContextPackage,
  type ContextRegistration,
  type Data,
  type ProcessGraph,
  type ReviewRequest,
  type Reviews,
  type Role,
  type Scope,
  type ServiceTaskCreator,
  type Sql,
  type State,
  type Task,
  type TaskCheckpoint,
  type TaskCheckpointInput,
  type TaskConfirmation,
  type TaskContext,
  type TaskCreate,
  type TaskDelivery,
  type TaskDeliveryCode,
  type TaskFailure,
  type TaskMarkFailed,
  type TaskRecord,
  type TaskReissue,
  type TaskReview,
  type Tasks,
  type TaskTypeDefinition,
  type Transaction,
  type WorkflowAssignmentContent,
  type WorkflowCheckContext,
  type WorkflowDefinition,
  type WorkflowExecutionReferences,
  type WorkflowLease,
  type WorkflowPolicy,
  type Workflows,
  type WorkflowSnapshot,
} from '@merv/contracts';
import type { Context } from 'cordis';
import { types as nodeTypes } from 'node:util';
import { z } from 'zod';
import { postgresMigrations } from './index.postgres.js';

import type { Code, CodeCapture } from '@merv/code-research/types';
import { RESERVED_CONTEXT_INPUTS, TASK_TYPES, TYPE_REQUIRED_CHECKS } from './definitions.js';
import {
  acceptanceChecks,
  renderAssessment,
  renderBrief,
  renderDeliveredCommit,
  validateConfirmations,
} from './evidence.js';
import { taskExecutionPolicy, type TaskWorkspace } from './execution-policy.js';

export type {
  Task,
  TaskCreate,
  TaskDelivery,
  TaskFailure,
  TaskMarkFailed,
  TaskRecord,
  TaskReissue,
  TaskReview,
  Tasks,
} from '@merv/contracts';

/** Rejected rounds a task remembers; later ones push the oldest out, which no repair still needs. */
const REJECTED_REVIEWS_KEPT = 50;
/**
 * What the earlier rounds may add to the optional feedback section. The section is dropped whole
 * when it does not fit, so they stay small beside the latest pinned assessment.
 */
const REVIEW_HISTORY_CHARS = 4000;

/** Tasks have fixed routes; inspect only an ordinary optional data property. */
function rejectReviewReturn(input: object): void {
  const message = 'Task reviews have fixed return routes and do not accept returnTo';
  check(
    input && typeof input === 'object' && !nodeTypes.isProxy(input),
    'invalid_review_return',
    message,
  );
  const prototype = Object.getPrototypeOf(input);
  check(prototype === Object.prototype || prototype === null, 'invalid_review_return', message);
  const descriptor = Object.getOwnPropertyDescriptor(input, 'returnTo');
  check(
    !descriptor || ('value' in descriptor && descriptor.value === undefined),
    'invalid_review_return',
    message,
  );
}

/** The published scratch-task graph. Edge order is part of its fingerprint; never reorder it. */
export const TASK_WORKFLOW: WorkflowDefinition = {
  name: 'task',
  version: 2,
  managed: true,
  initial: 'in_progress',
  states: ['in_progress', 'in_review', 'done', 'failed'],
  terminal: ['done', 'failed'],
  edges: [
    { from: 'in_progress', action: 'submit_delivery', to: 'in_review' },
    { from: 'in_review', action: 'reissue_review', to: 'in_review' },
    { from: 'in_review', action: 'accept', to: 'done' },
    { from: 'in_review', action: 'revise', to: 'in_progress' },
    { from: 'in_review', action: 'fail_review', to: 'failed' },
    { from: 'in_progress', action: 'mark_failed', to: 'failed' },
    { from: 'in_review', action: 'mark_failed', to: 'failed' },
  ],
};
/**
 * A published execution policy is immutable, so a task's private Git checkout belongs to the
 * workflow version it was created on and is never a field that a later edit could contradict.
 * Version 3 starts from the runner's central head; version 4 from the accepted task the
 * creator named. Version 5 derives and pins a base in Code's repository on the first lease;
 * references() only reads it. Its driver carries each producer lease's writer generation.
 * Version 6 is service-owned: only its internal binding supplies the fixed base.
 * Live tasks keep their version: nothing is ever upgraded into Git.
 */
const workspaces: Record<number, TaskWorkspace> = {
  2: 'none',
  3: 'central',
  4: 'reference',
  5: 'code',
  6: 'resolution',
};
export const taskWorkspace = (version: number): TaskWorkspace => workspaces[version] ?? 'none';
const taskVersion = (
  workspace: TaskCreate['workspace'],
  baseTaskId: string | undefined,
  hosted: boolean,
): number =>
  workspace !== 'git' ? TASK_WORKFLOW.version : baseTaskId !== undefined ? 4 : hosted ? 5 : 3;
/** Whether Code derives and pins the base, rather than the creator naming a task. */
const derivedBase = (version: number) => version === 5 || serviceOwned(version);
/** Only the internal service binding may create these tasks; their producer has no credential. */
const serviceOwned = (version: number) => version === TASK_WORKFLOW_SERVICE.version;
/** The same graph as version 2; only the execution policies registered beside it differ. */
export const TASK_WORKFLOW_GIT: WorkflowDefinition = { ...TASK_WORKFLOW, version: 3 };
export const TASK_WORKFLOW_GIT_BASED: WorkflowDefinition = { ...TASK_WORKFLOW, version: 4 };
export const TASK_WORKFLOW_GIT_HOSTED: WorkflowDefinition = { ...TASK_WORKFLOW, version: 5 };
export const TASK_WORKFLOW_SERVICE: WorkflowDefinition = {
  ...TASK_WORKFLOW,
  version: 6,
  states: ['in_progress', 'in_review', 'suspended', 'done'],
  terminal: ['done'],
  edges: [
    ...TASK_WORKFLOW.edges.map((edge) =>
      edge.to === 'failed' ? { ...edge, to: 'suspended' } : edge,
    ),
    { from: 'in_review', action: 'revise_suspended', to: 'suspended' },
    { from: 'suspended', action: 'resume', to: 'in_progress' },
  ],
};
/** What Tasks asks of Code; a test may bind exactly this much. */
type TaskCode = Pick<
  Code,
  | 'capture'
  | 'acceptUnit'
  | 'declareUnit'
  | 'baseStatus'
  | 'pinBase'
  | 'basePin'
  | 'unit'
  | 'hosted'
  | 'reserveWriter'
  | 'writerStatus'
  | 'bindServiceTasks'
>;
interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  goal: string;
  checks: string;
  producer_id: string;
  brief_id: string;
  delivery_ids: string;
  review_id: string | null;
  created_at: string;
  type_name: string;
  type_version: number;
  context_inputs: string;
  evidence_version: 2;
}
interface TaskLeaseRow {
  id: string;
  project_id: string;
  task_id: string;
  revision: number;
  actor_id: string;
  source_actor_id: string;
  purpose: 'work' | 'review';
  review_id: string | null;
  claim_id: string | null;
  receipt: string;
  pinned_artifacts: string;
  checkpoints: string;
  released_at: string | null;
}
/** What only a Git task's producer must know; the published recipes stay as they are. */
const GIT_DELIVERY =
  'This is a Git task: work in the private Git checkout prepared for this assignment. Record the work with code.commit (expectedHead is the HEAD of your local checkout), wait until code.operation reports it succeeded, then pass that operation’s commandId to task.submit_delivery. The commit must be your own, made in this assignment: if an earlier worker committed but did not deliver, commit again, which succeeds even when nothing changed. artifactIds may be empty, and a met confirmation that cites no evidenceIds is backed by the delivered commit.';
const GIT_REVIEW =
  'This is a Git task: the read-only checkout prepared for this assignment is pinned to the exact delivered commit named by the ‘Delivered commit’ record in your evidence; do not substitute another branch or a newer head. Cite that record’s artifact id in the findings the commit supports. Only this leased review, working in that checkout, can pass the task.';
/**
 * Reviews admits an interactive claim without asking Tasks, and a claimed review can no longer be
 * leased. The reviewer is told before claiming, because afterwards only a reissue frees the task.
 */
const GIT_CLAIM =
  'This is a Git task: only a leased review worker, whose runner prepares a checkout of the delivered commit, can pass it. Claim it only as that worker. A claim made without a lease can return or fail the task but never pass it, and blocks every leased reviewer until the producer or an admin replaces the review with task.reissue_review.';
const normalized = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

/** Owns task rules and the atomic integration between generic workflow and assessment services. */
/**
 * How often a review may return a task for changes. After that many returns the next delivery
 * waits for a human, who reviews it by hand or allows another round. It is deployed policy
 * and not part of the published graph, so it covers every live task of every version.
 */
export const TASK_LIMITS = { reviewRounds: 3 };
const configuration = z
  .object({
    limits: z
      .object({ reviewRounds: z.number().int().min(1).max(1000).default(TASK_LIMITS.reviewRounds) })
      .strict()
      .default({}),
  })
  .strict()
  .default({});

export class TaskService implements Tasks {
  private closed = false;
  private code?: TaskCode;
  private codeBinding?: symbol;
  private releaseReviewOwner?: () => void;
  private registrations = new Map<number, Awaited<ReturnType<Workflows['register']>>>();
  private types = new Map<
    string,
    { definition: TaskTypeDefinition; context: ContextRegistration }
  >();
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
    private artifacts: Artifacts,
    private workflows: Workflows,
    private reviews: Reviews,
    private contextBuilder: ContextBuilder,
    private limits = TASK_LIMITS,
  ) {
    this.initialize = async () => {
      await state.migrate('tasks', [
        {
          version: 1,
          sql: postgresMigrations[1],
        },
        {
          version: 2,
          sql: postgresMigrations[2],
        },
        {
          version: 3,
          sql: postgresMigrations[3],
        },
        {
          version: 4,
          sql: postgresMigrations[4],
        },
        {
          version: 5,
          sql: postgresMigrations[5],
        },
        {
          version: 6,
          sql: postgresMigrations[6],
        },
        {
          version: 7,
          sql: postgresMigrations[7],
        },
        {
          version: 8,
          sql: postgresMigrations[8],
        },
      ]);
      try {
        for (const definition of [
          TASK_WORKFLOW,
          TASK_WORKFLOW_GIT,
          TASK_WORKFLOW_GIT_BASED,
          TASK_WORKFLOW_GIT_HOSTED,
          TASK_WORKFLOW_SERVICE,
        ]) {
          this.registrations.set(
            definition.version,
            await workflows.register(definition, this.workflowPolicy(definition.version)),
          );
        }
        for (const definition of TASK_TYPES) await this.registerType(definition);
        this.releaseReviewOwner = reviews.registerSubmitOwner({
          id: 'tasks',
          owns: async (review, tx) =>
            !!(await tx.get(
              'SELECT id FROM tasks WHERE id=? AND project_id=?',
              review.subjectId,
              review.projectId,
            )),
          submit: async (caller, input, tx) => await this.submitReview(caller, input, tx),
        });
      } catch (error) {
        this.dispose();
        throw error;
      }
    };
  }

  /** The optional Cordis child owns this binding, not the task lifecycle. */
  bindCode(code: TaskCode): () => void {
    check(!this.closed, 'tasks_closed', 'Tasks is closed', 503);
    const binding = Symbol('code');
    this.codeBinding = binding;
    this.code = code;
    const release = code.bindServiceTasks(this.serviceTasks('code'));
    return () => {
      release();
      if (this.codeBinding !== binding) return;
      this.codeBinding = undefined;
      this.code = undefined;
    };
  }

  /** Only a Git task asks for Code, so a scratch task never notices that it is unloaded. */
  private requireCode(): TaskCode {
    check(this.code, 'code_unavailable', 'Git tasks require Code captures', 503);
    return this.code;
  }

  withdrawReviewOwner(): void {
    this.releaseReviewOwner?.();
    this.releaseReviewOwner = undefined;
  }

  dispose(): void {
    this.closed = true;
    this.withdrawReviewOwner();
    for (const registration of this.registrations.values()) registration.dispose();
    this.registrations.clear();
    for (const type of this.types.values()) type.context.dispose();
    this.types.clear();
  }

  private registration(version: number): Awaited<ReturnType<Workflows['register']>> {
    const registration = this.registrations.get(version);
    check(registration, 'workflow_unavailable', 'This task workflow version is unavailable', 503);
    return registration;
  }

  private leaseHooks(): NonNullable<NonNullable<WorkflowPolicy['assignments']>[number]['lease']> {
    return {
      label: async ({ caller, snapshot, tx }) => (await this.row(tx, caller, snapshot.id)).title,
      role: async (context): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> =>
        await this.leaseRole(context),
      excludes: async ({ caller, snapshot, tx }, actorId) => {
        const row = await this.row(tx, caller, snapshot.id);
        return (
          snapshot.state === 'in_review' &&
          !!row.review_id &&
          excludedFromReview(await this.reviews.get(caller, row.review_id, tx), actorId)
        );
      },
      acquire: async (context) => await this.acquireLease(context),
      check: async ({ caller, snapshot, tx }, receipt) => {
        const lease = await this.currentLease(caller, snapshot.id, snapshot.revision, tx);
        check(
          digest(receipt) === digest(JSON.parse(lease.receipt)),
          'stale_lease',
          'Lease ownership receipt no longer matches',
          409,
        );
        if (lease.purpose === 'review') {
          const review = await this.reviews.checkSubmit(caller, lease.review_id!, undefined, tx);
          check(
            review.claimId === lease.claim_id && review.subjectRevision === snapshot.revision,
            'stale_claim',
            'Lease no longer owns its review claim',
            409,
          );
        }
      },
      outputs: async ({ caller, snapshot, tx }) => {
        await this.currentLease(caller, snapshot.id, snapshot.revision, tx);
        return {
          artifacts: (await this.artifacts.authored(caller, tx)).map((artifact) => artifact.id),
        };
      },
      release: async ({ lease, reason, tx }) => await this.releaseLease(lease, reason, tx),
    };
  }

  private async leaseRole({ caller, snapshot, tx }: WorkflowCheckContext): Promise<Role> {
    check(!caller.session, 'forbidden', 'A leased worker cannot delegate another assignment', 403);
    const row = await this.row(tx, caller, snapshot.id);
    if (snapshot.state === 'in_progress') {
      await this.scope.require(caller, 'write', tx);
      // Version 6 is created only by the service binding; its runner remains a producer.
      if (row.producer_id !== caller.actorId && !serviceOwned(snapshot.version))
        await this.scope.require(caller, 'admin', tx);
      await this.workflows.checkDependencies(caller, snapshot.id, tx);
      if (taskWorkspace(snapshot.version) !== 'none') this.requireCode();
      await this.requireBase(caller, snapshot, tx);
      this.contextType({ type: row.type_name, typeVersion: row.type_version }, 'work');
      return 'producer';
    }
    check(
      snapshot.state === 'in_review' && row.review_id,
      'lease_unavailable',
      'Task has no review to lease',
      409,
    );
    await this.scope.require(caller, 'review', tx);
    const review = await this.reviews.get(caller, row.review_id, tx);
    check(
      review.status === 'requested' && review.subjectRevision === snapshot.revision,
      'review_unavailable',
      'Review is already claimed or no longer current',
      409,
    );
    if (taskWorkspace(snapshot.version) !== 'none')
      await this.reviewCommit(caller, snapshot, review, tx);
    this.contextType({ type: row.type_name, typeVersion: row.type_version }, 'review');
    return 'reviewer';
  }

  /**
   * Refuses work whose base Code cannot derive, with Code's own blocker code. This only reads:
   * it runs under lease admission, the dispatch candidate scan and every assignment check.
   * The refusal makes the task no candidate at all, so it is never launched and never held;
   * Code publishes the reason where status and the stuck report find it.
   */
  private async requireBase(
    caller: Caller,
    snapshot: WorkflowSnapshot,
    tx: Transaction,
  ): Promise<void> {
    if (!derivedBase(snapshot.version)) return;
    const base = await this.requireCode().baseStatus(caller, snapshot.id, tx);
    if (base.status === 'blocked')
      throw new MervError(base.blockers[0]!.code, base.blockers[0]!.message, 409);
    // The last writer's machine still owes its final capture, or an operator must fence it.
    const writer = await this.requireCode().writerStatus(caller, snapshot.id, tx);
    if (writer.blocked) throw new MervError(writer.blocked.code, writer.blocked.message, 409);
  }

  private async currentLease(
    caller: Caller,
    taskId: string,
    revision: number,
    tx: Transaction,
  ): Promise<TaskLeaseRow> {
    check(caller.session, 'stale_lease', 'This task operation requires its lease worker', 403);
    const lease = await tx.get<TaskLeaseRow>(
      'SELECT * FROM task_leases WHERE id=? AND project_id=? AND task_id=? AND revision=? AND actor_id=? AND released_at IS NULL',
      caller.session.id,
      caller.projectId,
      taskId,
      revision,
      caller.actorId,
    );
    check(lease, 'stale_lease', 'This worker no longer owns the task assignment', 409);
    return lease;
  }

  private async acquireLease(
    context: WorkflowCheckContext & { source: Caller; leaseId: string },
  ): Promise<Data> {
    const { caller, source, snapshot, tx, leaseId } = context;
    const role = await this.leaseRole({ ...context, caller: source });
    check(
      caller.session?.id === leaseId && caller.projectId === source.projectId,
      'invalid_lease',
      'Worker does not match the offered lease',
      403,
    );
    await this.scope.require(caller, role === 'reviewer' ? 'review' : 'write', tx);
    const row = await this.row(tx, caller, snapshot.id);
    const purpose = role === 'reviewer' ? 'review' : 'work';
    // The base is fixed with the lease it serves: Workflows reads references() right after
    // this hook in the same transaction, and a refused offer takes the pin back with it.
    if (purpose === 'work' && derivedBase(snapshot.version)) {
      await this.requireCode().pinBase(source, { unitId: snapshot.id, leaseId }, tx);
      await this.requireCode().reserveWriter(source, { unitId: snapshot.id, leaseId }, tx);
    }
    const review =
      purpose === 'review' ? await this.reviews.start(caller, row.review_id!, tx) : undefined;
    const checkpoints = await this.checkpointRows(
      caller,
      snapshot.id,
      purpose,
      row.review_id,
      snapshot.revision,
      tx,
    );
    const ids = [
      ...new Set([
        row.brief_id,
        ...(JSON.parse(row.delivery_ids) as string[]),
        ...Object.values(JSON.parse(row.context_inputs) as Record<string, string[]>).flat(),
        ...(review?.artifactIds ?? []),
        ...checkpoints.flatMap((checkpoint) => checkpoint.artifactIds),
      ]),
    ];
    // The authenticated source approves existing task continuity evidence exactly once.
    const pinnedArtifacts = await mapAsync(
      ids,
      async (id) => await this.artifacts.get(source, id, tx),
    );
    const receipt: Data = {
      leaseId,
      taskId: snapshot.id,
      revision: snapshot.revision,
      actorId: caller.actorId,
      purpose,
      reviewId: review?.id ?? null,
      claimId: review?.claimId ?? null,
      project: await this.projectContext(source, tx),
    };
    await tx.run(
      'INSERT INTO task_leases(id,project_id,task_id,revision,actor_id,source_actor_id,purpose,review_id,claim_id,receipt,pinned_artifacts,checkpoints) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      leaseId,
      caller.projectId,
      snapshot.id,
      snapshot.revision,
      caller.actorId,
      source.actorId,
      purpose,
      review?.id ?? null,
      review?.claimId ?? null,
      JSON.stringify(receipt),
      JSON.stringify(pinnedArtifacts),
      JSON.stringify(checkpoints),
    );
    return receipt;
  }

  private async releaseLease(lease: WorkflowLease, reason: string, tx: Transaction): Promise<void> {
    await releasedLease(tx, this.reviews, 'task_leases', lease, reason, {
      task_id: lease.instanceId,
    });
  }

  private async leaseArtifactIds(
    caller: Caller,
    lease: TaskLeaseRow,
    tx: Transaction,
  ): Promise<string[]> {
    const pinned = JSON.parse(lease.pinned_artifacts) as { id: string }[];
    return [
      ...new Set([
        ...pinned.map((artifact) => artifact.id),
        ...(await this.artifacts.authored(caller, tx)).map((artifact) => artifact.id),
      ]),
    ].sort();
  }

  /** An interactive delivery yields to a worker that holds the revision, as every domain's submission does. */
  private async unleased(caller: Caller, taskId: string, revision: number, tx: Transaction) {
    if (caller.session) return;
    check(
      !(await tx.get(
        "SELECT id FROM task_leases WHERE project_id=? AND task_id=? AND revision=? AND purpose='work' AND released_at IS NULL",
        caller.projectId,
        taskId,
        revision,
      )),
      'task_leased',
      'A worker session holds this revision; the operator who offered it can halt it, or wait for its handoff',
      409,
    );
  }

  private async isProducer(
    caller: Caller,
    row: TaskRow,
    snapshot: WorkflowSnapshot,
    tx: Transaction,
  ): Promise<boolean> {
    if (!caller.session) return row.producer_id === caller.actorId;
    return (await this.currentLease(caller, row.id, snapshot.revision, tx)).purpose === 'work';
  }

  private async checkpointRows(
    caller: Caller,
    taskId: string,
    purpose: 'work' | 'review',
    reviewId: string | null,
    revision: number,
    tx: Transaction,
    actorId?: string,
  ): Promise<TaskCheckpoint[]> {
    return (
      await tx.all<{ checkpoint: string }>(
        `SELECT checkpoint FROM task_checkpoints WHERE project_id=? AND task_id=? AND purpose=? AND (?='work' OR (review_id=? AND revision=?)) AND (CAST(? AS TEXT) IS NULL OR (checkpoint::jsonb #>> '{actorId}')=?) ORDER BY _merv_rowid DESC LIMIT 20`,
        caller.projectId,
        taskId,
        purpose,
        purpose,
        reviewId,
        revision,
        actorId ?? null,
        actorId ?? null,
      )
    )
      .map((row) => JSON.parse(row.checkpoint) as TaskCheckpoint)
      .reverse();
  }

  private workflowPolicy(version: number): WorkflowPolicy {
    const taskArguments = ({ snapshot }: WorkflowCheckContext): Data => ({
      taskId: snapshot.id,
      expectedRevision: snapshot.revision,
    });
    return {
      successStates: ['done'],
      dependencyFailureAction: 'mark_failed',
      limits: [
        {
          name: 'review_rounds',
          from: serviceOwned(version) ? 'in_progress' : 'in_review',
          actions: serviceOwned(version) ? ['submit_delivery', 'mark_failed'] : ['revise'],
          max: this.limits.reviewRounds,
        },
      ],
      ...(serviceOwned(version)
        ? {
            limitExtended: async (context: WorkflowCheckContext) => {
              if (context.snapshot.state !== 'suspended') return;
              await this.registration(version).transition(
                context.caller,
                {
                  instanceId: context.snapshot.id,
                  expectedRevision: context.snapshot.revision,
                  action: 'resume',
                  requestId: `task:resume:${context.input!.requestId}`,
                  input: context.input,
                },
                context.tx,
              );
            },
          }
        : {}),
      assignments: [
        {
          state: 'in_progress',
          requiresDependencies: true,
          check: async (context) => {
            await this.workflowAssignmentFacts(context);
            const { caller, snapshot, tx } = context;
            await this.unleased(caller, snapshot.id, snapshot.revision, tx);
          },
          build: async (context) => await this.workflowAssignment(context),
          execution: taskExecutionPolicy('work', taskWorkspace(version)),
          references: async (context) => await this.workflowExecutionReferences(context),
          lease: this.leaseHooks(),
        },
        {
          state: 'in_review',
          check: async (context) => {
            await this.workflowAssignmentFacts(context);
          },
          build: async (context) => await this.workflowAssignment(context),
          execution: taskExecutionPolicy('review', taskWorkspace(version)),
          references: async (context) => await this.workflowExecutionReferences(context),
          lease: this.leaseHooks(),
        },
      ],
      describe: async ({ caller, snapshot, tx, dependencies }) => {
        const row = await this.row(tx, caller, snapshot.id);
        const review = row.review_id ? await this.reviews.get(caller, row.review_id, tx) : null;
        const recovering =
          review?.status === 'started' &&
          review.reviewerId &&
          !(await this.scope.eligible(caller.projectId, review.reviewerId, 'review', tx));
        return {
          label: row.title,
          gate:
            snapshot.state === 'suspended'
              ? 'suspended'
              : snapshot.state === 'in_progress'
                ? 'delivery_required'
                : recovering
                  ? 'review_recovery_pending'
                  : review?.waiting
                    ? 'review_provenance_blocked'
                    : review?.status === 'requested'
                      ? 'review_required'
                      : 'independent_review',
          waiting:
            snapshot.state === 'suspended'
              ? 'This service task is suspended. A signed-in human operator can resume this same task with workflow.extend_limit (review_rounds), or cancel/replan its waiters.'
              : snapshot.state === 'in_progress'
                ? 'The task producer must complete and submit the delivery.'
                : recovering
                  ? 'The reviewer no longer has access. Recovery must reopen the claim before another reviewer can begin.'
                  : review?.waiting
                    ? review.waiting
                    : review?.status === 'requested'
                      ? 'Wait for an independent reviewer to claim this review. The producer cannot review its own work.'
                      : 'An independent review is in progress. Wait for its verdict; no producer transition is needed.',
          references: [
            ...(dependencies ?? []).map((dependency) => ({
              kind: 'workflow',
              id: dependency.id,
              label: `Prerequisite: ${dependency.name || dependency.id}`,
            })),
            { kind: 'artifact', id: row.brief_id, label: 'Pinned brief' },
            ...(JSON.parse(row.delivery_ids) as string[]).map((id) => ({
              kind: 'artifact',
              id,
              label:
                id === snapshot.data.deliveryCodeArtifactId
                  ? 'Delivered commit'
                  : 'Submitted delivery',
            })),
            ...(row.review_id
              ? [{ kind: 'review', id: row.review_id, label: 'Current independent review' }]
              : []),
          ],
        };
      },
      actions: [
        ...(serviceOwned(version)
          ? [
              {
                name: 'resume',
                states: ['suspended'],
                transitions: ['resume'],
                tool: 'workflow.extend_limit',
                suggested: false,
                instruction:
                  'A signed-in human operator extends review_rounds to resume this same task.',
                check: async ({ caller, tx, snapshot }: WorkflowCheckContext) => {
                  check(
                    caller.human && !caller.session && !caller.key,
                    'forbidden',
                    'Only a signed-in human operator resumes service work',
                    403,
                  );
                  await this.scope.require(caller, 'admin', tx);
                  const limit = await this.workflows.limitStatus(
                    caller,
                    snapshot.id,
                    'review_rounds',
                    tx,
                  );
                  check(
                    !limit.exhausted,
                    'workflow_limit_exhausted',
                    'Extend review_rounds before resuming',
                    409,
                  );
                },
              },
            ]
          : []),
        {
          name: 'submit_delivery',
          states: ['in_progress'],
          transitions: ['submit_delivery'],
          requiresDependencies: true,
          tool: 'task.submit_delivery',
          instruction:
            'Read the task context and inspect any completed prerequisites through their referenced records. Complete the pinned brief and retain evidence for every check. When returning for changes, read the previous review with review.get and address its findings. Submit confirmations with each checkNumber, met/not_met status, evidenceIds from the submitted artifacts, and notes explaining your verification or what remains unmet. Submit for independent review, then stop producer work while the review is pending.',
          // A Git task also needs the commandId of this worker's own successful code.commit,
          // and only a leased worker can obtain one; guidance says so before the refusal does.
          requiredInput: ({ snapshot }) =>
            taskWorkspace(snapshot.version) === 'none'
              ? ['artifactIds', 'confirmations']
              : ['artifactIds', 'commandId', 'confirmations'],
          arguments: taskArguments,
          check: async (context) => {
            await this.checkDelivery(context);
          },
        },
        {
          name: 'submit_review',
          states: ['in_review'],
          transitions: [
            'accept',
            'revise',
            'fail_review',
            ...(serviceOwned(version) ? ['revise_suspended'] : []),
          ],
          tool: 'review.submit',
          instruction:
            'Read the review context and independently inspect the pinned evidence. Submit a verdict with verification notes. Include a short plain synopsis and one finding per numbered criterion: met, not_met, not_verified or waived, cited pinned evidenceIds and verification, correction or explicit waiver reasons. Pass requires every criterion met or explicitly waived, and a criterion the review names in requiredCriteria met, never waived; also judge whether the overall goal was achieved. Stop after the verdict; its task transition is automatic.',
          requiredInput: ['verdict', 'notes', 'synopsis', 'findings'],
          arguments: async (context) => {
            const review = await this.currentReview(context);
            return {
              reviewId: review.id,
              claimId: review.claimId,
              expectedRevision: context.snapshot.revision,
            };
          },
          check: async (context) => {
            await this.checkTaskReview(context);
          },
        },
        {
          name: 'start_review',
          states: ['in_review'],
          tool: 'review.start',
          instruction:
            'Claim this independent review, then refresh its guidance and read the context for your new assignment.' +
            (taskWorkspace(version) === 'none' ? '' : ` ${GIT_CLAIM}`),
          arguments: async (context) => ({ reviewId: (await this.currentReview(context)).id }),
          check: async (context) => {
            const review = await this.currentReview(context);
            check(
              !context.input ||
                context.input.reviewId === undefined ||
                context.input.reviewId === review.id,
              'stale_review',
              'reviewId must match this task submission',
              409,
            );
            await this.reviews.checkStart(context.caller, review.id, context.tx);
          },
        },
        {
          name: 'reissue_review',
          states: ['in_review'],
          transitions: ['reissue_review'],
          tool: 'task.reissue_review',
          suggested: false,
          requiredInput: ['reason'],
          arguments: taskArguments,
          instruction:
            'Only if the current review needs replacement: give a reason to supersede it while preserving the evidence. Normal progress waits for the reviewer.',
          check: async (context) => {
            await this.checkReissue(context);
          },
        },
        {
          name: 'mark_failed',
          states: ['in_progress', 'in_review'],
          transitions: ['mark_failed'],
          tool: 'task.mark_failed',
          suggested: false,
          requiredInput: ['reason'],
          arguments: taskArguments,
          instruction: serviceOwned(version)
            ? 'Suspend this service task with a specific reason. Its evidence and waiters are retained; a human operator can extend review_rounds to resume the same task.'
            : 'Only when this task cannot or should not continue: record a specific reason to end it as failed. Any unfinished review is closed and its evidence is retained. This is a terminal decision.',
          check: async (context) => {
            await this.checkFailure(context);
          },
        },
      ],
    };
  }

  private async reviewAction(
    context: WorkflowCheckContext,
    verdict: 'pass' | 'needs_changes' | 'fail',
  ): Promise<string> {
    if (verdict === 'needs_changes' && serviceOwned(context.snapshot.version)) {
      const limit = await this.workflows.limitStatus(
        context.caller,
        context.snapshot.id,
        'review_rounds',
        context.tx,
      );
      if (limit.exhausted) return 'revise_suspended';
    }
    return { pass: 'accept', needs_changes: 'revise', fail: 'fail_review' }[verdict];
  }

  private async currentReview({
    caller,
    snapshot,
    tx,
    input,
  }: WorkflowCheckContext): Promise<ReviewRequest> {
    const row = await this.row(tx, caller, snapshot.id);
    check(
      snapshot.state === 'in_review' &&
        row.review_id &&
        (!input?.reviewId || input.reviewId === row.review_id),
      'stale_review',
      'This review no longer belongs to the current task submission',
      409,
    );
    const review = await this.reviews.get(caller, row.review_id, tx);
    check(
      review.subjectRevision === snapshot.revision,
      'revision_conflict',
      'Task changed since the review snapshot was pinned',
      409,
    );
    return review;
  }

  private async checkTaskReview(context: WorkflowCheckContext): Promise<void> {
    await this.scope.require(context.caller, 'review', context.tx);
    if (context.input) rejectReviewReturn(context.input);
    const review = await this.currentReview(context);
    await this.reviews.checkSubmit(
      context.caller,
      review.id,
      context.input as unknown as Omit<TaskReview, 'requestId'> | undefined,
      context.tx,
    );
    // Only a proposed verdict asks Code: the committing transition always carries its input, so
    // this is re-checked there, while guidance read with Code unloaded still answers.
    if (context.input && taskWorkspace(context.snapshot.version) !== 'none') {
      const headOid = await this.reviewCommit(context.caller, context.snapshot, review, context.tx);
      if (context.input.verdict === 'pass') await this.checkoutReviewer(context, review, headOid);
    }
    if (context.input && context.transition) {
      const action = await this.reviewAction(
        context,
        context.input.verdict as 'pass' | 'needs_changes' | 'fail',
      );
      check(
        context.transition === action,
        'invalid_verdict',
        'The transition must match the submitted verdict',
      );
    }
  }

  /**
   * The commit under review is re-derived from Code on every admission and verdict, never trusted
   * from the record alone: the receipt must still be the one the delivery sealed, and the review
   * must pin the rendered record of it. The producing revision is the stored one, because a
   * reissued review advances the task's revision without a new delivery.
   */
  private async reviewCommit(
    caller: Caller,
    snapshot: WorkflowSnapshot,
    review: ReviewRequest,
    tx: Transaction,
  ): Promise<string> {
    const code = this.requireCode();
    const delivered = snapshot.data.deliveryCode as unknown as TaskDeliveryCode | undefined;
    const recordId = snapshot.data.deliveryCodeArtifactId;
    check(
      delivered?.ref?.kind === 'code-commit' &&
        typeof recordId === 'string' &&
        review.artifactIds.includes(recordId),
      'task_commit_required',
      'This Git task’s review does not pin a delivered commit',
      409,
    );
    const capture = await code.capture(caller, delivered.ref, tx),
      p = capture.provenance;
    check(
      p.projectId === caller.projectId &&
        p.instanceId === snapshot.id &&
        p.sessionId === delivered.sessionId &&
        p.revision === delivered.revision &&
        p.workflow.name === 'task' &&
        taskWorkspace(p.workflow.version) !== 'none' &&
        p.workflow.state === 'in_progress' &&
        !p.readOnly &&
        capture.status === 'ready' &&
        capture.workspace?.headOid === delivered.headOid,
      'task_commit_provenance',
      'The delivered commit no longer matches the receipt its delivery sealed',
      409,
    );
    return delivered.headOid;
  }

  /**
   * A Git task passes only from the leased reviewer of this review, and only once its runner has
   * attached the read-only checkout at the delivered commit. Sessions fixes that attachment and
   * refuses any other base, and a runner without the objects never attaches, so the attachment is
   * the server-side fact that the reviewer could fetch what it accepts. An actor with no checkout
   * at all — an interactive reviewer — may return or fail the task but cannot pass it.
   */
  private async checkoutReviewer(
    { caller, snapshot, tx }: WorkflowCheckContext,
    review: ReviewRequest,
    headOid: string,
  ): Promise<void> {
    check(
      caller.session,
      'task_commit_unfetched',
      'Only a leased reviewer, working in the checkout pinned to the delivered commit, can pass a Git task. Return or fail it, or have the review replaced with task.reissue_review so a leased worker can claim it',
      409,
    );
    const lease = await this.currentLease(caller, snapshot.id, snapshot.revision, tx);
    check(
      lease.purpose === 'review' && lease.review_id === review.id,
      'stale_lease',
      'This worker does not hold the lease of the current review',
      409,
    );
    const own = await this.requireCode().capture(
      caller,
      { kind: 'session-final', sessionId: caller.session.id },
      tx,
    );
    check(
      own.attachedBaseOid === headOid,
      'task_commit_unfetched',
      'This review’s runner has not attached a checkout of the delivered commit',
      409,
    );
  }

  async registerType(definition: TaskTypeDefinition): Promise<() => void> {
    check(!this.closed, 'tasks_closed', 'Tasks is closed', 503);
    definition = plain<TaskTypeDefinition>(definition, 'invalid_recipe');
    check(
      definition.kind !== 'work' ||
        ['task', 'brief'].every((key) =>
          definition.recipe.sections.some((section) => section.key === key && section.required),
        ),
      'invalid_recipe',
      'Work task recipes must require task and brief sections',
    );
    const context = await this.contextBuilder.register(definition);
    if (this.closed) context.dispose();
    check(!this.closed, 'tasks_closed', 'Tasks closed during type registration', 503);
    const value = { definition, context };
    const key = `${definition.name}@${definition.version}`;
    this.types.set(key, value);
    return () => {
      if (this.types.get(key) === value) {
        context.dispose();
        this.types.delete(key);
      }
    };
  }

  private async row(sql: Sql, caller: Caller, taskId: string): Promise<TaskRow> {
    const row = await sql.get<TaskRow>(
      'SELECT * FROM tasks WHERE id = ? AND project_id = ?',
      taskId,
      caller.projectId,
    );
    check(row, 'not_found', 'Task not found in this project', 404);
    // Version 1 evidence was retired with its records (tasks migration 8); none can remain.
    check(
      row.evidence_version === 2,
      'task_unavailable',
      'Task evidence version 1 is retired',
      500,
    );
    return row;
  }
  private async projectRecord(caller: Caller, row: TaskRow, tx?: Transaction): Promise<TaskRecord> {
    const workflow = await this.workflows.get(caller, row.id, tx);
    // The instance data repeats the brief the record already carries; it is not sent twice.
    const {
      title: _title,
      goal: _goal,
      checks: _checks,
      deliveryConfirmations: _confirmations,
      workspace: _workspace,
      baseTaskId,
      deliveryCode,
      deliveryCodeArtifactId,
      ...data
    } = workflow.data;
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      goal: row.goal,
      checks: JSON.parse(row.checks),
      evidenceVersion: row.evidence_version,
      acceptanceChecks: acceptanceChecks(JSON.parse(row.checks)),
      deliveryConfirmations:
        (workflow.data.deliveryConfirmations as unknown as TaskConfirmation[] | undefined) ?? [],
      deliveryAssessmentId: (workflow.data.deliveryAssessmentId as string | undefined) ?? null,
      producerId: row.producer_id,
      briefId: row.brief_id,
      deliveryIds: JSON.parse(row.delivery_ids),
      reviewId: row.review_id,
      workflow: { ...workflow, data },
      workStarts: await this.workflows.workStarts(caller, row.id, tx),
      failure: (workflow.data.failure as unknown as TaskFailure | undefined) ?? null,
      ...(await this.workflows.dependencies(caller, row.id, tx)),
      createdAt: row.created_at,
      type: row.type_name,
      typeVersion: row.type_version,
      contextInputs: JSON.parse(row.context_inputs),
      ...(taskWorkspace(workflow.version) === 'none' ? {} : { workspace: 'git' as const }),
      ...(typeof baseTaskId === 'string' ? { baseTaskId } : {}),
      ...(deliveryCode && typeof deliveryCodeArtifactId === 'string'
        ? { deliveryCode: deliveryCode as unknown as TaskDeliveryCode, deliveryCodeArtifactId }
        : {}),
    };
  }
  private async hydrate(caller: Caller, row: TaskRow, tx?: Transaction): Promise<Task> {
    return {
      ...(await this.projectRecord(caller, row, tx)),
      guidance: await this.workflows.evaluate(caller, row.id, {}, tx),
    };
  }
  private async command<T>(
    tx: Transaction,
    caller: Caller,
    requestId: string,
    operation: string,
    input: unknown,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    check(
      typeof requestId === 'string' && visible(requestId),
      'invalid_request',
      'requestId is required',
    );
    const hash = digest(input);
    const old = await tx.get<{ operation: string; input_hash: string; result: string }>(
      'SELECT operation, input_hash, result FROM task_commands WHERE project_id = ? AND actor_id = ? AND request_id = ?',
      caller.projectId,
      caller.actorId,
      requestId,
    );
    if (old) {
      check(
        old.operation === operation && old.input_hash === hash,
        'request_conflict',
        'requestId was already used with different input',
        409,
      );
      return JSON.parse(old.result) as T;
    }
    const result = await fn();
    await tx.run(
      'INSERT INTO task_commands VALUES (?, ?, ?, ?, ?, ?)',
      caller.projectId,
      caller.actorId,
      requestId,
      operation,
      hash,
      JSON.stringify(result),
    );
    return result;
  }

  /** The binding captures its provider; a public create can never select this version. */
  serviceTasks(provider: string): ServiceTaskCreator {
    return {
      create: async (input, tx) => {
        input = structuredClone(input);
        this.state.assertTransaction(tx);
        check(
          (input.baseReference === undefined) === (input.dependsOn?.length ?? 0) > 0,
          'invalid_base',
          'A service task names its base commit or the prerequisites it derives one from',
        );
        const caller = await this.scope.serviceActor(provider, input.projectId, tx);
        return await this.createTask(
          caller,
          {
            title: input.title,
            goal: input.goal,
            checks: input.checks,
            workspace: 'git',
            requestId: input.requestId,
            dependsOn: input.dependsOn,
          },
          tx,
          { provider, baseReference: input.baseReference },
        );
      },
    };
  }

  async create(caller: Caller, input: TaskCreate, transaction?: Transaction): Promise<Task> {
    return await this.createTask(caller, input, transaction);
  }

  private async createTask(
    caller: Caller,
    input: TaskCreate,
    transaction?: Transaction,
    service?: { provider: string; baseReference?: string },
  ): Promise<Task> {
    caller = structuredClone(caller);
    input = plain<TaskCreate>(input);
    const body = service ? { input, service } : input;
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(tx, caller, input.requestId, 'create', body, async () => {
        const typeName = input.type ?? 'task.work',
          typeVersion = input.typeVersion ?? this.newestType(typeName);
        const type = this.types.get(`${typeName}@${typeVersion}`)?.definition;
        check(
          type?.kind === 'work',
          'task_type_unavailable',
          'An active work task type/version is required',
          409,
        );
        const required = TYPE_REQUIRED_CHECKS[typeName] ?? [];
        check(
          input.workspace === undefined || input.workspace === 'none' || input.workspace === 'git',
          'invalid_workspace',
          'A task workspace is none or git',
        );
        check(
          input.baseTaskId === undefined || input.workspace === 'git',
          'invalid_workspace',
          'Only a Git task can start from another task’s delivered commit',
        );
        const git = input.workspace === 'git';
        if (git) this.requireCode();
        if (input.baseTaskId !== undefined) {
          const base = await tx.get<{ id: string }>(
            'SELECT id FROM tasks WHERE id=? AND project_id=?',
            input.baseTaskId,
            caller.projectId,
          );
          const delivered = base ? await this.workflows.get(caller, base.id, tx) : null;
          check(
            delivered &&
              taskWorkspace(delivered.version) !== 'none' &&
              delivered.state !== 'failed',
            'invalid_workspace_base',
            'baseTaskId must name a Git task of this project that has not failed',
          );
        }
        const contextInputs = input.contextInputs ?? {};
        check(
          contextInputs && typeof contextInputs === 'object' && !Array.isArray(contextInputs),
          'invalid_context',
          'Context inputs must map section keys to artifact IDs',
        );
        const custom = type.recipe.sections.filter((s) => !RESERVED_CONTEXT_INPUTS.has(s.key));
        check(
          Object.keys(contextInputs).every((key) => custom.some((s) => s.key === key)),
          'invalid_context',
          'Unknown or reserved task context input',
        );
        for (const section of custom) {
          const ids = Object.hasOwn(contextInputs, section.key) ? contextInputs[section.key] : [];
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
          for (const id of ids) await this.artifacts.get(caller, id, tx);
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
          new Set(input.checks.map(normalized)).size === input.checks.length,
          'invalid_checks',
          'Done-when checks must be distinct',
        );
        // The type's required checks are the server's, so a caller cannot leave them out; one the
        // caller already wrote is kept where they put it.
        const checks = [
          ...input.checks,
          ...required.filter(
            (item) => !input.checks.some((own) => normalized(own) === normalized(item)),
          ),
        ];
        const brief =
          input.briefId === undefined
            ? await this.artifacts.create(
                caller,
                {
                  title: clip(`Task brief: ${input.title}`, 300),
                  content: renderBrief({ ...input, checks }, git),
                },
                tx,
              )
            : await this.artifacts.get(caller, input.briefId, tx);
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
        const document = await this.artifacts.read(caller, brief.id);
        check(
          document.encoding === 'utf8',
          'invalid_brief',
          'The brief must contain valid UTF-8 text',
        );
        // The brief is embedded whole in every work context: it must leave the recipe room.
        check(
          document.content.length <= 32_000,
          'invalid_brief',
          'The brief (goal and checks) must fit 32,000 characters',
        );
        const text = normalized(document.content);
        check(
          text.includes(normalized(input.goal)) &&
            checks.every((item) => text.includes(normalized(item))),
          'invalid_brief',
          'The pinned brief must contain the task goal and every Done-when check',
        );
        // Once Code keeps the project's history, new Git work lives there and nowhere else.
        const hosted =
          input.workspace === 'git' &&
          input.baseTaskId === undefined &&
          (await this.requireCode().hosted(caller, tx));
        const version = service
          ? TASK_WORKFLOW_SERVICE.version
          : taskVersion(input.workspace, input.baseTaskId, hosted);
        const workflow = await (
          await this.registration(version)
        ).start(
          caller,
          {
            workflow: 'task',
            version,
            requestId: `${caller.actorId}:task:create:${input.requestId}`,
            ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
            data: {
              title: input.title,
              goal: input.goal,
              checks,
              producerId: caller.actorId,
              briefId: brief.id,
              evidenceVersion: 2,
              // Other plugins read a Git task's choice and base here without injecting Tasks.
              ...(git ? { workspace: 'git' } : {}),
              ...(input.baseTaskId === undefined ? {} : { baseTaskId: input.baseTaskId }),
            },
          },
          tx,
        );
        // Only a prerequisite is sure to be accepted, and its commit final, before work starts.
        check(
          input.baseTaskId === undefined ||
            (await this.workflows.dependencies(caller, workflow.id, tx)).dependencies.some(
              (dependency) => dependency.id === input.baseTaskId,
            ),
          'invalid_workspace_base',
          'baseTaskId must also be one of the task’s dependsOn prerequisites',
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
          JSON.stringify(contextInputs),
        );
        if (derivedBase(workflow.version))
          await this.requireCode().declareUnit(caller, workflow.id, tx, service?.baseReference);
        await recorded(this.state, tx, caller, 'task.created', workflow.id, {
          briefId: brief.id,
          evidenceVersion: 2,
        });
        return await this.hydrate(caller, await this.row(tx, caller, workflow.id), tx);
      });
    });
  }

  /**
   * What Code holds for a task: its pinned base, where a base stands, its acceptance. Null
   * while Code is unloaded or knows no such unit. It is kept off the task record, which work
   * contexts embed and hash.
   */
  async codeUnit(caller: Caller, taskId: string): Promise<CodeUnit | null> {
    caller = structuredClone(caller);
    try {
      return (await this.code?.unit(caller, taskId)) ?? null;
    } catch (error) {
      if (error instanceof MervError && [404, 503].includes(error.status)) return null;
      throw error;
    }
  }

  async get(caller: Caller, taskId: string): Promise<Task> {
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await this.hydrate(caller, await this.row(tx, caller, taskId), tx);
    });
  }
  async process(caller: Caller, taskId: string): Promise<ProcessGraph> {
    caller = structuredClone(caller);
    return await this.workflows.process(caller, taskId);
  }
  async record(caller: Caller, taskId: string, transaction?: Transaction): Promise<TaskRecord> {
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await this.projectRecord(caller, await this.row(tx, caller, taskId), tx);
    });
  }
  async records(caller: Caller, transaction?: Transaction): Promise<TaskRecord[]> {
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await mapAsync(
        await tx.all<TaskRow>(
          'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id',
          caller.projectId,
        ),
        async (row) => await this.projectRecord(caller, row, tx),
      );
    });
  }
  async context(caller: Caller, input: TaskContext): Promise<ContextPackage> {
    ({ caller, input } = structuredClone({ caller, input }));
    return await this.state.transaction(async (tx) => {
      const { task, review } = await this.assignment(caller, input, tx);
      const type = this.contextType(task, input.purpose);
      const subject = {
        id: task.id,
        revision: task.workflow.revision,
        ...(input.claimId ? { claimId: input.claimId } : {}),
      };
      // Replay before rebuilding live inputs or reading retained artifact bytes.
      const previous = await type.context.replay(
        caller,
        { subject, requestId: input.requestId },
        tx,
      );
      if (previous) return previous;
      return await type.context.build(
        caller,
        {
          subject,
          inputs: await this.contextInputs(caller, task, input.purpose, review, tx),
          requestId: input.requestId,
        },
        tx,
      );
    });
  }

  /**
   * A task created without an explicit version takes the newest recipe published for its type;
   * an existing task keeps the version it was created with, whose recipe stays registered.
   */
  private newestType(name: string): number {
    let newest = 1;
    for (const key of this.types.keys()) {
      const at = key.lastIndexOf('@');
      if (key.slice(0, at) === name) newest = Math.max(newest, Number(key.slice(at + 1)));
    }
    return newest;
  }

  private contextType(task: Pick<Task, 'type' | 'typeVersion'>, purpose: 'work' | 'review') {
    const key = purpose === 'review' ? 'task.review@3' : `${task.type}@${task.typeVersion}`;
    const type = this.types.get(key);
    check(type, 'task_type_unavailable', 'Task context recipe is unavailable', 503);
    return type;
  }

  private async projectContext(caller: Caller, tx: Transaction): Promise<Data> {
    const project = await this.scope.project(caller, tx);
    return {
      id: project.id,
      name: project.name,
      summary: project.summary ?? '',
      contextRevision: project.contextRevision ?? 0,
    };
  }

  /** The saved context and read-only workflow assignment use exactly the same recipe inputs. */
  private async contextInputs(
    caller: Caller,
    task: Task,
    purpose: 'work' | 'review',
    review: ReviewRequest | undefined,
    tx: Transaction,
  ): Promise<Record<string, ContextInput>> {
    const type = this.contextType(task, purpose);
    // Reverse links change when downstream work is added, independently of this assignment.
    const { dependents: _dependents, ...assignmentTask } = task;
    // Worker contexts retain the offer's Introduction even if an operator later changes it.
    // Old immutable lease receipts without this field remain exactly as they were.
    const project = caller.session
      ? (
          JSON.parse(
            (await this.currentLease(caller, task.id, task.workflow.revision, tx)).receipt,
          ) as Data
        ).project
      : await this.projectContext(caller, tx);
    const taskMetadata =
      JSON.stringify(assignmentTask) +
      (project === undefined
        ? ''
        : `\n\nProject Introduction (captured project context):\n${JSON.stringify(project)}`);
    let inputs: Record<string, ContextInput>;
    if (purpose === 'review') {
      check(review, 'invalid_context', 'Missing review assignment');
      inputs = {
        task: { text: taskMetadata },
        assessment: { text: JSON.stringify(review) },
        evidence: {
          artifactIds: review.artifactIds,
          mode: await this.contextBuilder.mode(caller, review.artifactIds, 48_000, tx),
        },
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
        brief: { artifactIds: [task.briefId] },
      };
      if (typeof task.workflow.data.revisionContext === 'string') {
        const previous = task.reviewId ? await this.reviews.get(caller, task.reviewId, tx) : null;
        const earlier = reviewHistory(
          await mapAsync(
            (Array.isArray(task.workflow.data.rejectedReviewIds)
              ? (task.workflow.data.rejectedReviewIds as string[])
              : []
            ).filter((id) => id !== task.reviewId),
            async (id) => {
              const review = await this.reviews.get(caller, id, tx);
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
                JSON.stringify({
                  reviewId: previous.id,
                  snapshotHash: previous.snapshotHash,
                  artifactIds: previous.artifactIds,
                  verdict: previous.verdict,
                  notes: previous.notes,
                  criteria: previous.criteria,
                  synopsis: previous.synopsis,
                  findings: previous.findings,
                  evidence: previous.evidence,
                })
              : '') +
            (earlier.rounds.length
              ? '\n\nEarlier review rounds, oldest first (each was answered by a later delivery; do not reintroduce what they rejected):\n' +
                JSON.stringify(earlier)
              : ''),
          omitted: Array.from(
            { length: earlier.omittedRounds },
            (_, index) => `feedback:round:${index + 1}`,
          ),
        };
      }
    }
    let checkpoints = await this.checkpointRows(
      caller,
      task.id,
      purpose,
      task.reviewId,
      task.workflow.revision,
      tx,
      caller.session ? caller.actorId : undefined,
    );
    if (caller.session) {
      const lease = await this.currentLease(caller, task.id, task.workflow.revision, tx);
      const frozen = JSON.parse(lease.checkpoints) as TaskCheckpoint[];
      const frozenIds = new Set(frozen.map((checkpoint) => checkpoint.id));
      checkpoints = [
        ...frozen,
        ...checkpoints.filter((checkpoint) => !frozenIds.has(checkpoint.id)),
      ];
      const allowed = new Set(await this.leaseArtifactIds(caller, lease, tx));
      checkpoints = checkpoints.map((checkpoint) => ({
        ...checkpoint,
        artifactIds: checkpoint.artifactIds.filter((id) => allowed.has(id)),
      }));
    }
    if (checkpoints.length) {
      inputs.checkpoints = { text: JSON.stringify(checkpoints) };
      const artifactIds = [...new Set(checkpoints.flatMap((c) => c.artifactIds))];
      if (artifactIds.length) inputs.checkpointEvidence = { artifactIds, mode: 'auto' };
    }
    inputs = Object.fromEntries(
      Object.entries(inputs).filter(([key]) =>
        type.definition.recipe.sections.some((section) => section.key === key),
      ),
    );
    return inputs;
  }

  /** Admission uses domain facts only: never hydrate/evaluate here, which would recurse. */
  private async workflowAssignmentFacts(context: WorkflowCheckContext) {
    const purpose =
      context.snapshot.state === 'in_review' ? ('review' as const) : ('work' as const);
    const facts = await this.assignmentFacts(
      context.caller,
      {
        taskId: context.snapshot.id,
        expectedRevision: context.snapshot.revision,
        purpose,
      },
      context.tx,
      true,
    );
    // An assignment check may answer 503 as a blocker, so the Code gates live here and never in
    // the action rules a bare task.get evaluates: a stored Git task stays readable without Code.
    if (taskWorkspace(facts.workflow.version) !== 'none') {
      if (facts.review)
        await this.reviewCommit(context.caller, facts.workflow, facts.review, context.tx);
      else {
        this.requireCode();
        await this.requireBase(context.caller, facts.workflow, context.tx);
      }
    }
    this.contextType({ type: facts.row.type_name, typeVersion: facts.row.type_version }, purpose);
    return { ...facts, purpose };
  }

  private async workflowAssignment(
    context: WorkflowCheckContext,
  ): Promise<WorkflowAssignmentContent> {
    const { caller, tx } = context;
    const { row, review, purpose } = await this.workflowAssignmentFacts(context);
    const task = await this.hydrate(caller, row, tx);
    const type = this.contextType(task, purpose);
    const subject: ContextBuild['subject'] = {
      id: task.id,
      revision: task.workflow.revision,
      ...(review?.claimId ? { claimId: review.claimId } : {}),
    };
    const preview = await type.context.preview(
      caller,
      {
        subject,
        inputs: await this.contextInputs(caller, task, purpose, review, tx),
      },
      tx,
    );
    const needsClaim = purpose === 'review' && review?.status === 'requested';
    const assisting =
      purpose === 'work' && !(await this.isProducer(caller, row, task.workflow, tx));
    const git = taskWorkspace(task.workflow.version) !== 'none';
    const instruction = assisting
      ? 'Support the assigned producer using this task context and save useful checkpoints. Only the assigned producer may submit the delivery; return your evidence to that producer.'
      : needsClaim
        ? 'Claim the review with review.start, then refresh workflow.assignment for your current claim before assessing or submitting. Reading or beginning this assignment does not claim the review.' +
          (git ? ` ${GIT_CLAIM}` : '')
        : type.definition.recipe.outputInstructions +
          // A brief the caller supplied never carries these words, so the assignment always does.
          (git ? ` ${purpose === 'work' ? GIT_DELIVERY : GIT_REVIEW}` : '');
    return {
      role: purpose === 'review' ? 'reviewer' : 'producer',
      label: `${purpose === 'review' ? 'Review' : 'Work'}: ${task.title}`,
      brief: `${type.definition.recipe.instructions}\n\nGoal: ${task.goal}\n\nDone when:\n${task.checks.map((check, i) => `${i + 1}. ${check}`).join('\n')}\n\n${instruction}`,
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

  private async workflowExecutionReferences({
    caller,
    snapshot,
    tx,
    dependencies,
  }: WorkflowCheckContext): Promise<WorkflowExecutionReferences> {
    const row = await this.row(tx, caller, snapshot.id);
    const review = row.review_id ? await this.reviews.get(caller, row.review_id, tx) : undefined;
    const contextInputs = JSON.parse(row.context_inputs) as Record<string, string[]>;
    const lease = caller.session
      ? await this.currentLease(caller, snapshot.id, snapshot.revision, tx)
      : null;
    return {
      artifacts: lease
        ? await this.leaseArtifactIds(caller, lease, tx)
        : [
            ...new Set([
              row.brief_id,
              ...(JSON.parse(row.delivery_ids) as string[]),
              ...Object.values(contextInputs).flat(),
              ...(review?.artifactIds ?? []),
            ]),
          ].sort(),
      dependencies: (dependencies ?? []).map((dependency) => dependency.id).sort(),
      // What the runner bases the checkout on: the reviewer's on exactly the delivered commit, a
      // based producer's on the commit its accepted prerequisite delivered.
      ...(taskWorkspace(snapshot.version) === 'none'
        ? {}
        : snapshot.state === 'in_review' && review
          ? { code: await this.reviewCommit(caller, snapshot, review, tx) }
          : derivedBase(snapshot.version)
            ? await this.pinnedBase(caller, snapshot, tx)
            : taskWorkspace(snapshot.version) === 'reference'
              ? { base: await this.baseCommit(caller, snapshot, tx) }
              : {}),
      ...((await this.isProducer(caller, row, snapshot, tx)) ? { producerTaskId: row.id } : {}),
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
  private async pinnedBase(
    caller: Caller,
    snapshot: WorkflowSnapshot,
    tx: Transaction,
  ): Promise<{ base?: string }> {
    const pin = await this.requireCode().basePin(caller, snapshot.id, tx);
    return pin ? { base: pin.reference } : {};
  }

  /**
   * Only an accepted task's commit is a base: done is terminal, so the OID a persistent checkout
   * fixes at its first launch can never move under the work built on it.
   */
  private async baseCommit(
    caller: Caller,
    snapshot: WorkflowSnapshot,
    tx: Transaction,
  ): Promise<string> {
    const baseTaskId = snapshot.data.baseTaskId;
    const base =
      typeof baseTaskId === 'string'
        ? await tx.get<{ id: string }>(
            'SELECT id FROM tasks WHERE id = ? AND project_id = ?',
            baseTaskId,
            caller.projectId,
          )
        : undefined;
    const delivered = base ? await this.workflows.get(caller, base.id, tx) : undefined;
    const headOid = (delivered?.data.deliveryCode as unknown as TaskDeliveryCode | undefined)
      ?.headOid;
    check(
      delivered?.state === 'done' &&
        typeof headOid === 'string' &&
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headOid),
      'task_base_unavailable',
      'The base task has not been accepted with a delivered commit',
      409,
    );
    return headOid;
  }

  private async assignmentFacts(
    caller: Caller,
    input: Omit<TaskContext, 'requestId'>,
    tx: Transaction,
    allowUnclaimedReview = false,
  ): Promise<{ row: TaskRow; workflow: WorkflowSnapshot; review?: ReviewRequest }> {
    await this.scope.require(caller, input.purpose === 'review' ? 'review' : 'write', tx);
    check(
      input.purpose === 'review' || input.purpose === 'work',
      'invalid_context',
      'Unknown context purpose',
    );
    const row = await this.row(tx, caller, input.taskId);
    const workflow = await this.workflows.get(caller, row.id, tx);
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
      const review = await this.reviews.get(caller, row.review_id, tx);
      if (allowUnclaimedReview) {
        // Activation is not a claim. An eligible reviewer may inspect the open pinned request.
        await this.reviews.checkStart(caller, review.id, tx);
        check(
          review.subjectRevision === workflow.revision,
          'stale_claim',
          'Review snapshot must match this task revision',
          409,
        );
      } else {
        check(
          review.status === 'started' &&
            review.reviewerId === caller.actorId &&
            review.producerId !== caller.actorId,
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
        await this.reviews.checkSubmit(caller, review.id, undefined, tx);
      }
      return { row, workflow, review };
    }
    check(
      workflow.state === 'in_progress',
      'invalid_transition',
      'Task is not awaiting producer work',
      409,
    );
    if (!(await this.isProducer(caller, row, workflow, tx)))
      await this.scope.require(caller, 'admin', tx);
    check(
      input.claimId === undefined,
      'invalid_context',
      'Producer work does not use review claims',
    );
    return { row, workflow };
  }

  private async assignment(
    caller: Caller,
    input: TaskContext,
    tx: Transaction,
  ): Promise<{ task: Task; review?: ReviewRequest }> {
    const { row, review } = await this.assignmentFacts(caller, input, tx);
    if (input.purpose === 'work') await this.workflows.checkDependencies(caller, row.id, tx);
    return { task: await this.hydrate(caller, row, tx), review };
  }
  async checkpoint(caller: Caller, input: TaskCheckpointInput): Promise<TaskCheckpoint> {
    caller = structuredClone(caller);
    input = plain<TaskCheckpointInput>(input);
    return await this.state.transaction(async (tx) => {
      // The committed answer replays even after the task moved on; the assignment is
      // checked only for a checkpoint that has yet to be written.
      return await this.command(tx, caller, input.requestId, 'checkpoint', input, async () => {
        const { task, review } = await this.assignment(caller, input, tx);
        check(
          typeof input.notes === 'string' && visible(input.notes) && input.notes.length <= 16000,
          'invalid_checkpoint',
          'Checkpoint notes must contain 1–16000 characters',
        );
        const artifactIds = input.artifactIds ?? [];
        check(
          Array.isArray(artifactIds) &&
            artifactIds.length <= 50 &&
            new Set(artifactIds).size === artifactIds.length,
          'invalid_checkpoint',
          'Checkpoint artifact IDs must be distinct, at most 50',
        );
        if (caller.session) {
          const allowed = new Set(
            await this.leaseArtifactIds(
              caller,
              await this.currentLease(caller, task.id, task.workflow.revision, tx),
              tx,
            ),
          );
          check(
            artifactIds.every((id) => allowed.has(id)),
            'execution_arguments_forbidden',
            'Checkpoint evidence must be frozen input or this worker’s own output',
            403,
          );
        }
        for (const id of artifactIds) await this.artifacts.get(caller, id, tx);
        const result: TaskCheckpoint = {
          id: newId('checkpoint'),
          taskId: task.id,
          actorId: caller.actorId,
          purpose: input.purpose,
          revision: task.workflow.revision,
          reviewId: review?.id ?? null,
          claimId: review?.claimId ?? null,
          notes: input.notes,
          artifactIds,
          createdAt: now(),
        };
        await tx.run(
          'INSERT INTO task_checkpoints(id,project_id,task_id,purpose,revision,review_id,checkpoint) VALUES(?,?,?,?,?,?,?)',
          result.id,
          caller.projectId,
          task.id,
          input.purpose,
          result.revision,
          result.reviewId,
          JSON.stringify(result),
        );
        await recorded(this.state, tx, caller, 'task.checkpoint_saved', task.id, {
          checkpointId: result.id,
          purpose: input.purpose,
          revision: result.revision,
        });
        return result;
      });
    });
  }
  /** The records; guidance is per reader and per moment, so task.get carries it. */
  async list(caller: Caller): Promise<TaskRecord[]> {
    return await this.records(caller);
  }

  private async checkDelivery({
    caller,
    snapshot: current,
    tx,
    input: proposed,
  }: WorkflowCheckContext): Promise<void> {
    await this.scope.require(caller, 'write', tx);
    const row = await this.row(tx, caller, current.id);
    check(
      await this.isProducer(caller, row, current, tx),
      'forbidden',
      'Only this task’s producer may submit its delivery',
      403,
    );
    await this.unleased(caller, row.id, current.revision, tx);
    check(
      current.state === 'in_progress',
      'invalid_transition',
      'Task must be in progress to submit a delivery',
      409,
    );
    if (!proposed) return;
    const input = proposed as unknown as TaskDelivery;
    check(
      input.taskId === undefined || input.taskId === current.id,
      'invalid_input',
      'taskId must match this workflow',
    );
    check(
      input.expectedRevision === undefined || current.revision === input.expectedRevision,
      'revision_conflict',
      'Task revision changed; refresh the task before submitting',
      409,
    );
    const git = taskWorkspace(current.version) !== 'none';
    check(
      Array.isArray(input.artifactIds) &&
        (git || input.artifactIds.length > 0) &&
        new Set(input.artifactIds).size === input.artifactIds.length &&
        input.artifactIds.every((id) => typeof id === 'string' && id.length > 0),
      'invalid_delivery',
      'Delivery requires a nonempty list of distinct artifacts',
    );
    check(
      git || input.commandId === undefined,
      'task_commit_required',
      'A scratch task cannot attach an unrelated commit',
      409,
    );
    if (git) await this.deliveredCommit(caller, current, input.commandId, tx);
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
      const rendered = await tx.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM wf_history WHERE project_id=? AND action='submit_delivery' AND (${input.artifactIds
          .map(() => 'data_json LIKE ? OR data_json LIKE ?')
          .join(' OR ')})`,
        caller.projectId,
        ...input.artifactIds.flatMap((id) => [
          `%"deliveryAssessmentId":"${id}"%`,
          `%"deliveryCodeArtifactId":"${id}"%`,
        ]),
      );
      check(
        !rendered?.n,
        'invalid_delivery',
        'A confirmation sheet or commit record Merv rendered for a delivery cannot serve as evidence',
      );
    }
    const artifacts = await mapAsync(
      input.artifactIds,
      async (id) => await this.artifacts.get(caller, id, tx),
    );
    check(
      artifacts.every((item) => item.createdBy === caller.actorId && item.size > 0),
      'invalid_delivery',
      'Delivery artifacts must be nonempty and belong to the producer',
    );
    validateConfirmations(input.confirmations, JSON.parse(row.checks), input.artifactIds, git);
  }

  /**
   * The commit a Git task delivers is this worker's own code.commit. Its receipt already exists
   * when the worker submits, so a review is never requested
   * on a commit no runner has recorded. Every condition is a separate defence: the session is
   * what stops a successor from delivering its predecessor's commit.
   */
  private async deliveredCommit(
    caller: Caller,
    snapshot: WorkflowSnapshot,
    commandId: unknown,
    tx: Transaction,
  ): Promise<CodeCapture & { workspace: NonNullable<CodeCapture['workspace']> }> {
    check(
      typeof commandId === 'string' && commandId.length > 0 && caller.session,
      'task_commit_required',
      'A Git task delivers this worker’s own successful code.commit; only a leased worker can obtain one',
      409,
    );
    const capture = await this.requireCode().capture(
        caller,
        { kind: 'code-commit', commandId },
        tx,
      ),
      p = capture.provenance;
    check(
      p.projectId === caller.projectId &&
        p.instanceId === snapshot.id &&
        p.sessionId === caller.session.id &&
        p.actorId === caller.actorId &&
        p.revision === snapshot.revision &&
        p.workflow.name === 'task' &&
        taskWorkspace(p.workflow.version) !== 'none' &&
        p.workflow.state === 'in_progress' &&
        !p.readOnly,
      'task_commit_provenance',
      'Deliver a commit this worker made for this task revision',
      409,
    );
    check(
      capture.status !== 'pending',
      'task_commit_pending',
      'Wait for code.operation to report succeeded',
      409,
    );
    const { workspace } = capture;
    check(
      capture.status === 'ready' && workspace,
      'task_commit_failed',
      'The code.commit operation did not succeed; commit again and deliver that operation',
      409,
    );
    return { ...capture, workspace };
  }

  private async checkReissue({
    caller,
    snapshot: current,
    tx,
    input,
  }: WorkflowCheckContext): Promise<void> {
    await this.scope.require(caller, 'write', tx);
    const row = await this.row(tx, caller, current.id);
    check(
      !input || input.taskId === undefined || input.taskId === current.id,
      'invalid_input',
      'taskId must match this workflow',
    );
    if (!(await this.isProducer(caller, row, current, tx)))
      await this.scope.require(caller, 'admin', tx);
    check(
      !input || (typeof input.reason === 'string' && input.reason.trim()),
      'invalid_reason',
      'A reason is required to reissue a review',
    );
    check(
      current.state === 'in_review' && row.review_id,
      'invalid_transition',
      'Only a task awaiting review can reissue its review',
      409,
    );
    check(
      !input || input.expectedRevision === undefined || current.revision === input.expectedRevision,
      'revision_conflict',
      'Task revision changed; refresh the task before reissuing review',
      409,
    );
    const previous = await this.reviews.get(caller, row.review_id, tx);
    check(
      previous.status === 'requested' || previous.status === 'started',
      'review_closed',
      'Only an open, unsubmitted review can be reissued',
      409,
    );
    check(
      previous.subjectRevision === current.revision,
      'stale_review',
      'The open review no longer matches the task revision',
      409,
    );
  }

  private async checkFailure({ caller, snapshot, tx, input }: WorkflowCheckContext): Promise<void> {
    await this.scope.require(caller, 'write', tx);
    const row = await this.row(tx, caller, snapshot.id);
    if (!(await this.isProducer(caller, row, snapshot, tx)))
      await this.scope.require(caller, 'admin', tx);
    check(
      !input || input.taskId === undefined || input.taskId === snapshot.id,
      'invalid_input',
      'taskId must match this workflow',
    );
    check(
      snapshot.state === 'in_progress' || snapshot.state === 'in_review',
      'invalid_transition',
      'Only an active task can be marked failed',
      409,
    );
    check(
      !input ||
        input.expectedRevision === undefined ||
        input.expectedRevision === snapshot.revision,
      'revision_conflict',
      'Task changed; refresh it before marking it failed',
      409,
    );
    check(
      !input ||
        (typeof input.reason === 'string' && visible(input.reason) && input.reason.length <= 16000),
      'invalid_reason',
      'A specific reason of 1–16000 characters is required to mark a task failed',
    );
    if (snapshot.state === 'in_review') {
      check(row.review_id, 'stale_review', 'The task has no current review', 409);
      const review = await this.reviews.get(caller, row.review_id, tx);
      check(
        review.status === 'requested' || review.status === 'started',
        'review_closed',
        'Only an unfinished review can be closed by withdrawing a task',
        409,
      );
    }
  }

  async markFailed(
    caller: Caller,
    input: TaskMarkFailed,
    transaction?: Transaction,
  ): Promise<Task> {
    ({ caller, input } = structuredClone({ caller, input }));
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(tx, caller, input.requestId, 'mark_failed', input, async () => {
        check(
          Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
          'invalid_revision',
          'Expected revision must be a nonnegative integer',
        );
        const row = await this.row(tx, caller, input.taskId);
        const current = await this.workflows.get(caller, row.id, tx);
        await this.checkFailure({ caller, snapshot: current, tx, input: { ...input } });
        const reviewId = current.state === 'in_review' ? row.review_id : null;
        const failure: TaskFailure = {
          reason: input.reason,
          actorId: caller.actorId,
          createdAt: now(),
          reviewId,
        };
        await (
          await this.registration(current.version)
        ).transition(
          caller,
          {
            instanceId: row.id,
            expectedRevision: current.revision,
            action: 'mark_failed',
            input: { ...input, expectedRevision: current.revision },
            requestId: `${caller.actorId}:task:failure:${input.requestId}`,
            data: {
              outcome: input.reason,
              failure: { ...failure },
              ...(serviceOwned(current.version) ? { revisionContext: input.reason } : {}),
            },
          },
          tx,
        );
        if (reviewId) await this.reviews.supersede(caller, reviewId, tx);
        await recorded(
          this.state,
          tx,
          caller,
          serviceOwned(current.version) ? 'task.suspended' : 'task.failed',
          row.id,
          { ...failure },
        );
        return await this.hydrate(caller, await this.row(tx, caller, row.id), tx);
      });
    });
  }

  async submitDelivery(caller: Caller, input: TaskDelivery): Promise<Task> {
    caller = structuredClone(caller);
    input = plain<TaskDelivery>(input);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(tx, caller, input.requestId, 'submit_delivery', input, async () => {
        const row = await this.row(tx, caller, input.taskId);
        const checks: string[] = JSON.parse(row.checks);
        const current = await this.workflows.get(caller, row.id, tx);
        await this.checkDelivery({ caller, snapshot: current, tx, input: { ...input } });
        await this.workflows.checkDependencies(caller, row.id, tx);
        const git = taskWorkspace(current.version) !== 'none';
        const commit = git
          ? await this.deliveredCommit(caller, current, input.commandId, tx)
          : null;
        // Reviews pins artifacts and knows nothing of commits, so the commit enters the review
        // as a rendered record: pinned and hashed like any evidence, and citable by a finding.
        const codeArtifact = commit
          ? await this.artifacts.create(
              caller,
              {
                title: clip(`Delivered commit: ${row.title}`, 300),
                content: renderDeliveredCommit(row.title, commit),
              },
              tx,
            )
          : null;
        // A met claim that cites no file is backed by the delivered commit, which is always there.
        const confirmations = validateConfirmations(
          input.confirmations,
          checks,
          input.artifactIds,
          git,
        ).map((item) =>
          codeArtifact && item.status === 'met' && !item.evidenceIds.length
            ? { ...item, evidenceIds: [codeArtifact.id] }
            : item,
        );
        const assessment = await this.artifacts.create(
          caller,
          {
            title: clip(`Delivery confirmations: ${row.title}`, 300),
            content: renderAssessment(checks, confirmations),
          },
          tx,
        );
        const deliveryIds = [
          ...input.artifactIds,
          ...(codeArtifact ? [codeArtifact.id] : []),
          assessment.id,
        ];
        const deliveryCode: TaskDeliveryCode | null = commit
          ? {
              ref: { kind: 'code-commit', commandId: input.commandId! },
              sessionId: commit.provenance.sessionId,
              revision: commit.provenance.revision,
              headOid: commit.workspace.headOid,
              treeOid: commit.workspace.treeOid ?? null,
            }
          : null;
        const moved = await (
          await this.registration((await this.workflows.get(caller, row.id, tx)).version)
        ).transition(
          caller,
          {
            instanceId: row.id,
            expectedRevision: input.expectedRevision,
            action: 'submit_delivery',
            input: { ...input },
            requestId: `${caller.actorId}:task:delivery:${input.requestId}`,
            data: {
              deliveryIds,
              deliveryConfirmations: confirmations.map((item) => ({ ...item })),
              deliveryAssessmentId: assessment.id,
              ...(deliveryCode && codeArtifact
                ? { deliveryCode: { ...deliveryCode }, deliveryCodeArtifactId: codeArtifact.id }
                : {}),
            },
          },
          tx,
        );
        // The checks a task type requires are the ones its review may not waive. They are found
        // by their text, because the caller may have written one of them anywhere in the list.
        const requiredCriteria = (TYPE_REQUIRED_CHECKS[row.type_name] ?? [])
          .map((item) => checks.findIndex((own) => normalized(own) === normalized(item)) + 1)
          .filter((number) => number > 0);
        const review = await this.reviews.request(
          caller,
          {
            subjectId: row.id,
            subjectRevision: moved.revision,
            ...(serviceOwned(current.version)
              ? {
                  provenanceOwner: (
                    await this.scope.require(
                      { projectId: caller.projectId, actorId: row.producer_id },
                      'read',
                      tx,
                    )
                  ).serviceOwner,
                }
              : {}),
            producerId: caller.actorId,
            // A service owns the task but never directs a worker. Reviews retains the
            // authenticated runner source as the delivery's administrative authority.
            administrativeActorId: serviceOwned(current.version)
              ? (await this.scope.authorityActor(caller, tx)).id
              : row.producer_id,
            // Neither the owner nor the authority that directed a worker is independent of its delivery.
            ...(caller.session
              ? {
                  pinnedInputIds: [row.brief_id],
                  excludedActorIds: [
                    ...new Set([row.producer_id, (await this.scope.authorityActor(caller, tx)).id]),
                  ],
                }
              : {}),
            artifactIds: [row.brief_id, ...deliveryIds],
            criteria: checks,
            formatVersion: 2,
            ...(requiredCriteria.length ? { requiredCriteria } : {}),
            requestId: `${caller.actorId}:task:delivery:${input.requestId}`,
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
        await recorded(this.state, tx, caller, 'task.delivery_submitted', row.id, {
          reviewId: review.id,
          snapshotHash: review.snapshotHash,
          artifactIds: deliveryIds,
          ...(deliveryCode ? { headOid: deliveryCode.headOid } : {}),
        });
        return await this.hydrate(caller, await this.row(tx, caller, row.id), tx);
      });
    });
  }

  async reissueReview(caller: Caller, input: TaskReissue): Promise<Task> {
    ({ caller, input } = structuredClone({ caller, input }));
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(tx, caller, input.requestId, 'reissue_review', input, async () => {
        const row = await this.row(tx, caller, input.taskId);
        const current = await this.workflows.get(caller, row.id, tx);
        check(
          row.review_id,
          'invalid_transition',
          'Only a task awaiting review can reissue its review',
          409,
        );
        const previous = await this.reviews.get(caller, row.review_id, tx);
        const moved = await (
          await this.registration(current.version)
        ).transition(
          caller,
          {
            instanceId: row.id,
            expectedRevision: current.revision,
            action: 'reissue_review',
            input: { ...input },
            requestId: `${caller.actorId}:task:reissue:${input.requestId}`,
            data: { reviewReissueReason: input.reason },
          },
          tx,
        );
        await this.reviews.supersede(caller, previous.id, tx);
        const review = await this.reviews.reissue(
          caller,
          {
            reviewId: previous.id,
            subjectRevision: moved.revision,
            requestId: `${caller.actorId}:task:reissue:${input.requestId}`,
          },
          tx,
        );
        await tx.run(
          'UPDATE tasks SET review_id = ? WHERE id = ? AND project_id = ?',
          review.id,
          row.id,
          caller.projectId,
        );
        await recorded(this.state, tx, caller, 'task.review_reissued', row.id, {
          previousReviewId: previous.id,
          reviewId: review.id,
          reason: input.reason,
          snapshotHash: review.snapshotHash,
        });
        return await this.hydrate(caller, await this.row(tx, caller, row.id), tx);
      });
    });
  }

  async submitReview(caller: Caller, input: TaskReview, transaction?: Transaction): Promise<Task> {
    caller = structuredClone(caller);
    rejectReviewReturn(input);
    input = plain<TaskReview>(input);
    check(
      input.paperChanges === undefined,
      'paper_edits_unavailable',
      'Only experiment and reflection reviewers update the paper with a verdict',
    );
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'review', tx);
      return await this.command(tx, caller, input.requestId, 'submit_review', input, async () => {
        const review = await this.reviews.get(caller, input.reviewId, tx);
        const row = await this.row(tx, caller, review.subjectId);
        const current = await this.workflows.get(caller, row.id, tx);
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
        await this.reviews.checkSubmit(caller, input.reviewId, input, tx);
        const action = await this.reviewAction({ caller, snapshot: current, tx }, input.verdict);
        const moved = await (
          await this.registration(current.version)
        ).transition(
          caller,
          {
            instanceId: row.id,
            expectedRevision: current.revision,
            action,
            input: { ...input },
            requestId: `${caller.actorId}:task:review:${input.requestId}`,
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
              // revisionContext holds one round, so the ids of all of them are kept beside it. A
              // task sent back before this list existed still names that round in reviewId.
              ...(input.verdict === 'pass'
                ? {}
                : {
                    rejectedReviewIds: [
                      ...(Array.isArray(current.data.rejectedReviewIds)
                        ? (current.data.rejectedReviewIds as string[])
                        : typeof current.data.revisionContext === 'string' &&
                            typeof current.data.reviewId === 'string'
                          ? [current.data.reviewId]
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
        );
        const submitted = await this.reviews.submit(
          caller,
          {
            reviewId: input.reviewId,
            claimId: input.claimId,
            verdict: input.verdict,
            notes: input.notes,
            ...(input.synopsis === undefined ? {} : { synopsis: input.synopsis }),
            ...(input.findings === undefined ? {} : { findings: input.findings }),
            ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
            requestId: `${caller.actorId}:task:review:${input.requestId}`,
          },
          tx,
        );
        // Every version records its success, so work created before automatic bases can still
        // be built on. With Code unloaded nothing is recorded, and a scratch task is later read
        // as code-less from its workflow version alone.
        if (input.verdict === 'pass' && this.code)
          await this.code.acceptUnit(
            caller,
            {
              unitId: row.id,
              terminalRevision: moved.revision,
              submissionRef: review.snapshotHash,
              reviewRef: review.id,
              // The accept guard has just re-derived a Git task's delivered commit from Code.
              codeRef:
                taskWorkspace(current.version) === 'none'
                  ? null
                  : (current.data.deliveryCode as unknown as TaskDeliveryCode).ref,
              reviewSessionId: caller.session?.id ?? null,
            },
            tx,
          );
        await recorded(this.state, tx, caller, 'task.review_applied', row.id, {
          reviewId: submitted.id,
          verdict: submitted.verdict,
          action,
        });
        return await this.hydrate(caller, await this.row(tx, caller, row.id), tx);
      });
    });
  }
}

export const tasksPlugin = {
  name: 'merv-tasks',
  inject: ['state', 'scope', 'artifacts', 'workflows', 'reviews', 'contextBuilder'],
  Config: configuration,
  async apply(ctx: Context, config: z.infer<typeof configuration>) {
    const tasks = await createService(
      new TaskService(
        ctx.state,
        ctx.scope,
        ctx.artifacts,
        ctx.workflows,
        ctx.reviews,
        ctx.contextBuilder,
        config.limits,
      ),
    );
    ctx.inject(['codeResearch'], (ctx) => {
      ctx.effect(() => tasks.bindCode(ctx.codeResearch));
    });
    // Keep the graph registration until every consumer of Tasks has been disposed.
    ctx.effect(function* () {
      yield () => tasks.dispose();
      yield ctx.provide('tasks', tasks);
      // Generic review.submit lives outside this provider's consumer graph. Stop
      // accepting new routed work before withdrawing Tasks and draining its tools.
      yield () => tasks.withdrawReviewOwner();
    });
  },
};
export default tasksPlugin;
