import { excludedFromReview, releasedLease, visible, recorded, mapAsync } from '@merv/contracts';
import { clip, createService } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import { types as nodeTypes } from 'node:util';
import {
  check,
  digest,
  inTransaction,
  now,
  newId,
  type Artifacts,
  type Caller,
  type ProcessGraph,
  type Reviews,
  type Scope,
  type Sql,
  type State,
  type Task,
  type TaskRecord,
  type TaskCreate,
  type TaskDelivery,
  type TaskReview,
  type TaskReissue,
  type TaskMarkFailed,
  type TaskFailure,
  type TaskConfirmation,
  type Tasks,
  type Transaction,
  type WorkflowDefinition,
  type Workflows,
  type ContextBuilder,
  type ContextRegistration,
  type ContextInput,
  type ContextPackage,
  type ContextBuild,
  type WorkflowSnapshot,
  type WorkflowAssignmentContent,
  type WorkflowExecutionReferences,
  type TaskContext,
  type TaskTypeDefinition,
  type TaskCheckpoint,
  type TaskCheckpointInput,
  type ReviewRequest,
  type WorkflowPolicy,
  type WorkflowCheckContext,
  type WorkflowLease,
  type Role,
  type Data,
} from '@merv/contracts';

import { taskExecutionPolicy } from './execution-policy.js';
import { TASK_TYPES, RESERVED_CONTEXT_INPUTS } from './definitions.js';
import {
  acceptanceChecks,
  renderBrief,
  renderAssessment,
  validateConfirmations,
} from './evidence.js';

export type {
  Task,
  TaskRecord,
  TaskCreate,
  TaskDelivery,
  TaskReview,
  TaskReissue,
  TaskMarkFailed,
  TaskFailure,
  Tasks,
} from '@merv/contracts';

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

export const TASK_WORKFLOW_V1: WorkflowDefinition = {
  name: 'task',
  version: 1,
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
  ],
};
/** Keep the persisted v1 graph unchanged; new tasks use v2. */
export const TASK_WORKFLOW: WorkflowDefinition = {
  ...TASK_WORKFLOW_V1,
  version: 2,
  edges: [
    ...TASK_WORKFLOW_V1.edges,
    { from: 'in_progress', action: 'mark_failed', to: 'failed' },
    { from: 'in_review', action: 'mark_failed', to: 'failed' },
  ],
};
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
  evidence_version: 1 | 2;
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
const normalized = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

/** Owns task rules and the atomic integration between generic workflow and assessment services. */
export class TaskService implements Tasks {
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
  ) {
    this.initialize = async () => {
      await state.migrate('tasks', [
        {
          version: 1,
          postgres: postgresMigrations[1],
          sql: `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
        checks TEXT NOT NULL, producer_id TEXT NOT NULL, brief_id TEXT NOT NULL,
        delivery_ids TEXT NOT NULL DEFAULT '[]', review_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX tasks_project ON tasks(project_id, created_at);
      CREATE TABLE task_commands (
        project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
        operation TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(project_id, actor_id, request_id)
      );
    `,
        },
        {
          version: 2,
          postgres: postgresMigrations[2],
          sql: `
      CREATE TRIGGER tasks_brief_immutable BEFORE UPDATE OF project_id, title, goal, checks, producer_id, brief_id, created_at ON tasks
        BEGIN SELECT RAISE(ABORT, 'A task brief is immutable'); END;
    `,
        },
        {
          version: 3,
          postgres: postgresMigrations[3],
          sql: `
        ALTER TABLE tasks ADD COLUMN type_name TEXT NOT NULL DEFAULT 'task.work';
        ALTER TABLE tasks ADD COLUMN type_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE tasks ADD COLUMN context_inputs TEXT NOT NULL DEFAULT '{}';
        CREATE TRIGGER tasks_context_immutable BEFORE UPDATE OF type_name,type_version,context_inputs ON tasks
          BEGIN SELECT RAISE(ABORT,'Task type and context inputs are immutable'); END;
      `,
        },
        {
          version: 4,
          postgres: postgresMigrations[4],
          sql: `
        CREATE TABLE task_checkpoints(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,purpose TEXT NOT NULL,revision INTEGER NOT NULL,review_id TEXT,checkpoint TEXT NOT NULL);
        CREATE INDEX task_checkpoints_target ON task_checkpoints(project_id,task_id,purpose,revision);
        CREATE TRIGGER task_checkpoints_immutable BEFORE UPDATE ON task_checkpoints BEGIN SELECT RAISE(ABORT,'Checkpoints are immutable'); END;
        CREATE TRIGGER task_checkpoints_no_delete BEFORE DELETE ON task_checkpoints BEGIN SELECT RAISE(ABORT,'Checkpoints are durable'); END;
      `,
        },
        {
          version: 5,
          postgres: postgresMigrations[5],
          sql: `
        ALTER TABLE tasks ADD COLUMN evidence_version INTEGER NOT NULL DEFAULT 1 CHECK(evidence_version IN (1,2));
        CREATE TRIGGER tasks_evidence_version_immutable BEFORE UPDATE OF evidence_version ON tasks
          BEGIN SELECT RAISE(ABORT,'Task evidence contract is immutable'); END;
        `,
        },
        {
          version: 6,
          postgres: postgresMigrations[6],
          sql: `CREATE TABLE task_leases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,revision INTEGER NOT NULL,actor_id TEXT NOT NULL UNIQUE,source_actor_id TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('work','review')),review_id TEXT,claim_id TEXT,receipt TEXT NOT NULL,pinned_artifacts TEXT NOT NULL,checkpoints TEXT NOT NULL,released_at TEXT);
        CREATE UNIQUE INDEX task_lease_active ON task_leases(project_id,task_id,revision) WHERE released_at IS NULL;
        CREATE TRIGGER task_lease_identity_immutable BEFORE UPDATE OF id,project_id,task_id,revision,actor_id,source_actor_id,purpose,review_id,claim_id,receipt,pinned_artifacts,checkpoints ON task_leases BEGIN SELECT RAISE(ABORT,'Lease assignment provenance is immutable'); END;
        CREATE TRIGGER task_lease_no_delete BEFORE DELETE ON task_leases BEGIN SELECT RAISE(ABORT,'Lease assignment provenance is durable'); END;`,
        },
        {
          version: 7,
          rebuild: true,
          postgres: postgresMigrations[7],
          sql: `CREATE TEMP TABLE task_leases_backup AS SELECT * FROM task_leases;
DROP TRIGGER task_lease_identity_immutable;
DROP TRIGGER task_lease_no_delete;
DROP TABLE task_leases;
CREATE TABLE task_leases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,revision INTEGER NOT NULL,actor_id TEXT NOT NULL,source_actor_id TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('work','review')),review_id TEXT,claim_id TEXT,receipt TEXT NOT NULL,pinned_artifacts TEXT NOT NULL,checkpoints TEXT NOT NULL,released_at TEXT);
        CREATE UNIQUE INDEX task_lease_active ON task_leases(project_id,task_id,revision) WHERE released_at IS NULL;
        CREATE TRIGGER task_lease_identity_immutable BEFORE UPDATE OF id,project_id,task_id,revision,actor_id,source_actor_id,purpose,review_id,claim_id,receipt,pinned_artifacts,checkpoints ON task_leases BEGIN SELECT RAISE(ABORT,'Lease assignment provenance is immutable'); END;
        CREATE TRIGGER task_lease_no_delete BEFORE DELETE ON task_leases BEGIN SELECT RAISE(ABORT,'Lease assignment provenance is durable'); END;
INSERT INTO task_leases SELECT * FROM task_leases_backup;
DROP TABLE task_leases_backup;`,
        },
      ]);
      try {
        for (const definition of [TASK_WORKFLOW_V1, TASK_WORKFLOW]) {
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

  withdrawReviewOwner(): void {
    this.releaseReviewOwner?.();
    this.releaseReviewOwner = undefined;
  }

  dispose(): void {
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
      if (row.producer_id !== caller.actorId) await this.scope.require(caller, 'admin', tx);
      await this.workflows.checkDependencies(caller, snapshot.id, tx);
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
    this.contextType({ type: row.type_name, typeVersion: row.type_version }, 'review');
    return 'reviewer';
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
        tx.dialect === 'postgres'
          ? `SELECT checkpoint FROM task_checkpoints WHERE project_id=? AND task_id=? AND purpose=? AND (?='work' OR (review_id=? AND revision=?)) AND (CAST(? AS TEXT) IS NULL OR (checkpoint::jsonb #>> '{actorId}')=?) ORDER BY _merv_rowid DESC LIMIT 20`
          : `SELECT checkpoint FROM task_checkpoints WHERE project_id=? AND task_id=? AND purpose=? AND (?='work' OR (review_id=? AND revision=?)) AND (? IS NULL OR json_extract(checkpoint,'$.actorId')=?) ORDER BY rowid DESC LIMIT 20`,
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
          execution: taskExecutionPolicy('work'),
          references: async (context) => await this.workflowExecutionReferences(context),
          lease: this.leaseHooks(),
        },
        {
          state: 'in_review',
          check: async (context) => {
            await this.workflowAssignmentFacts(context);
          },
          build: async (context) => await this.workflowAssignment(context),
          execution: taskExecutionPolicy('review'),
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
            snapshot.state === 'in_progress'
              ? 'delivery_required'
              : recovering
                ? 'review_recovery_pending'
                : review?.status === 'requested'
                  ? 'review_required'
                  : 'independent_review',
          waiting:
            snapshot.state === 'in_progress'
              ? 'The task producer must complete and submit the delivery.'
              : recovering
                ? 'The reviewer no longer has access. Recovery must reopen the claim before another reviewer can begin.'
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
              label: 'Submitted delivery',
            })),
            ...(row.review_id
              ? [{ kind: 'review', id: row.review_id, label: 'Current independent review' }]
              : []),
          ],
        };
      },
      actions: [
        {
          name: 'submit_delivery',
          states: ['in_progress'],
          transitions: ['submit_delivery'],
          requiresDependencies: true,
          tool: 'task.submit_delivery',
          instruction:
            'Read the task context and inspect any completed prerequisites through their referenced records. Complete the pinned brief and retain evidence for every check. When returning for changes, read the previous review with review.get and address its findings. For evidenceVersion 2, submit confirmations with each checkNumber, met/not_met status, evidenceIds from the submitted artifacts, and notes explaining your verification or what remains unmet. Submit for independent review, then stop producer work while the review is pending.',
          requiredInput: async ({ caller, snapshot, tx }) =>
            (await this.row(tx, caller, snapshot.id)).evidence_version === 2
              ? ['artifactIds', 'confirmations']
              : ['artifactIds'],
          arguments: taskArguments,
          check: async (context) => {
            await this.checkDelivery(context);
          },
        },
        {
          name: 'submit_review',
          states: ['in_review'],
          transitions: ['accept', 'revise', 'fail_review'],
          tool: 'review.submit',
          instruction:
            'Read the review context and independently inspect the pinned evidence. Submit a verdict with verification notes. For formatVersion 2, include a short plain synopsis and one finding per numbered criterion: met, not_met, not_verified or waived, cited pinned evidenceIds and verification, correction or explicit waiver reasons. Pass requires every criterion met or explicitly waived; also judge whether the overall goal was achieved. Stop after the verdict; its task transition is automatic.',
          requiredInput: async (context) =>
            (await this.currentReview(context)).formatVersion === 2
              ? ['verdict', 'notes', 'synopsis', 'findings']
              : ['verdict', 'notes'],
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
            'Claim this independent review, then refresh its guidance and read the context for your new assignment.',
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
          // The v1 command upgrades and closes atomically; it is an auxiliary action
          // there so guidance can expose it without rewriting the pinned graph.
          ...(version >= 2 ? { transitions: ['mark_failed'] } : {}),
          tool: 'task.mark_failed',
          suggested: false,
          requiredInput: ['reason'],
          arguments: taskArguments,
          instruction:
            'Only when this task cannot or should not continue: record a specific reason to end it as failed. Any unfinished review is closed and its evidence is retained. This is a terminal decision.',
          check: async (context) => {
            await this.checkFailure(context);
          },
        },
      ],
    };
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
    if (context.input && context.transition) {
      const action = { pass: 'accept', needs_changes: 'revise', fail: 'fail_review' }[
        context.input.verdict as 'pass' | 'needs_changes' | 'fail'
      ];
      check(
        context.transition === action,
        'invalid_verdict',
        'The transition must match the submitted verdict',
      );
    }
  }

  async registerType(definition: TaskTypeDefinition): Promise<() => void> {
    check(
      definition.kind !== 'work' ||
        ['task', 'brief'].every((key) =>
          definition.recipe.sections.some((section) => section.key === key && section.required),
        ),
      'invalid_recipe',
      'Work task recipes must require task and brief sections',
    );
    const context = await this.contextBuilder.register(definition);
    const value = { definition: structuredClone(definition), context };
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

  async create(caller: Caller, input: TaskCreate, transaction?: Transaction): Promise<Task> {
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(tx, caller, input.requestId, 'create', input, async () => {
        const typeName = input.type ?? 'task.work',
          typeVersion = input.typeVersion ?? this.newestType(typeName);
        const type = this.types.get(`${typeName}@${typeVersion}`)?.definition;
        check(
          type?.kind === 'work',
          'task_type_unavailable',
          'An active work task type/version is required',
          409,
        );
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
        const brief =
          input.briefId === undefined
            ? await this.artifacts.create(
                caller,
                {
                  title: clip(`Task brief: ${input.title}`, 300),
                  content: renderBrief(input),
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
            input.checks.every((item) => text.includes(normalized(item))),
          'invalid_brief',
          'The pinned brief must contain the task goal and every Done-when check',
        );
        const workflow = await (
          await this.registration(TASK_WORKFLOW.version)
        ).start(
          caller,
          {
            workflow: 'task',
            version: TASK_WORKFLOW.version,
            requestId: `${caller.actorId}:task:create:${input.requestId}`,
            ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
            data: {
              title: input.title,
              goal: input.goal,
              checks: input.checks,
              producerId: caller.actorId,
              briefId: brief.id,
              evidenceVersion: 2,
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
          JSON.stringify(input.checks),
          caller.actorId,
          brief.id,
          now(),
          typeName,
          typeVersion,
          JSON.stringify(contextInputs),
        );
        await recorded(this.state, tx, caller, 'task.created', workflow.id, {
          briefId: brief.id,
          evidenceVersion: 2,
        });
        return await this.hydrate(caller, await this.row(tx, caller, workflow.id), tx);
      });
    });
  }

  async get(caller: Caller, taskId: string): Promise<Task> {
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await this.hydrate(caller, await this.row(tx, caller, taskId), tx);
    });
  }
  async process(caller: Caller, taskId: string): Promise<ProcessGraph> {
    return await this.workflows.process(caller, taskId);
  }
  async record(caller: Caller, taskId: string, transaction?: Transaction): Promise<TaskRecord> {
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await this.projectRecord(caller, await this.row(tx, caller, taskId), tx);
    });
  }
  async records(caller: Caller, transaction?: Transaction): Promise<TaskRecord[]> {
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
          ...(task.evidenceVersion === 2
            ? { mode: await this.contextBuilder.mode(caller, review.artifactIds, 48_000, tx) }
            : {}),
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
        inputs.feedback = {
          text:
            task.workflow.data.revisionContext +
            (previous?.status === 'submitted' &&
            (previous.synopsis || previous.findings.length || Object.keys(previous.evidence).length)
              ? '\n\nPinned review assessment (verify cited evidence before revising):\n' +
                JSON.stringify({
                  reviewId: previous.id,
                  snapshotHash: previous.snapshotHash,
                  criteria: previous.criteria,
                  synopsis: previous.synopsis,
                  findings: previous.findings,
                  evidence: previous.evidence,
                })
              : ''),
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
      if (artifactIds.length)
        inputs.checkpointEvidence = {
          artifactIds,
          ...(task.evidenceVersion === 2 ? { mode: 'auto' as const } : {}),
        };
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
    const instruction = assisting
      ? 'Support the assigned producer using this task context and save useful checkpoints. Only the assigned producer may submit the delivery; return your evidence to that producer.'
      : needsClaim
        ? 'Claim the review with review.start, then refresh workflow.assignment for your current claim before assessing or submitting. Reading or beginning this assignment does not claim the review.'
        : type.definition.recipe.outputInstructions;
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
      ...((await this.isProducer(caller, row, snapshot, tx)) ? { producerTaskId: row.id } : {}),
      ...(review ? { reviewId: review.id } : {}),
      ...(review?.status === 'started' && review.reviewerId === caller.actorId && review.claimId
        ? { claimId: review.claimId }
        : {}),
    };
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
    await this.scope.require(caller, 'read');
    return await this.state.transaction(
      async (sql) =>
        await mapAsync(
          await sql.all<TaskRow>(
            'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id',
            caller.projectId,
          ),
          async (row) => await this.projectRecord(caller, row, sql),
        ),
    );
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
    check(
      Array.isArray(input.artifactIds) &&
        input.artifactIds.length > 0 &&
        new Set(input.artifactIds).size === input.artifactIds.length &&
        input.artifactIds.every((id) => typeof id === 'string' && id.length > 0),
      'invalid_delivery',
      'Delivery requires a nonempty list of distinct artifacts',
    );
    // No task's brief is a delivery, this task's least of all; nor is the confirmation
    // sheet Merv rendered for an earlier delivery, which every delivery records in history.
    const placeholders = input.artifactIds.map(() => '?').join(',');
    const briefs = await tx.all<{ brief_id: string }>(
      `SELECT brief_id FROM tasks WHERE project_id=? AND brief_id IN (${placeholders})`,
      caller.projectId,
      ...input.artifactIds,
    );
    check(briefs.length === 0, 'invalid_delivery', 'A task brief cannot serve as a delivery');
    const rendered = await tx.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wf_history WHERE project_id=? AND action='submit_delivery' AND (${input.artifactIds
        .map(() => 'data_json LIKE ?')
        .join(' OR ')})`,
      caller.projectId,
      ...input.artifactIds.map((id) => `%"deliveryAssessmentId":"${id}"%`),
    );
    check(
      !rendered?.n,
      'invalid_delivery',
      'A confirmation sheet Merv rendered for a delivery cannot serve as evidence',
    );
    const artifacts = await mapAsync(
      input.artifactIds,
      async (id) => await this.artifacts.get(caller, id, tx),
    );
    check(
      artifacts.every((item) => item.createdBy === caller.actorId && item.size > 0),
      'invalid_delivery',
      'Delivery artifacts must be nonempty and belong to the producer',
    );
    if (row.evidence_version === 2) {
      validateConfirmations(input.confirmations, JSON.parse(row.checks), input.artifactIds);
      return;
    }
    const briefHash = (await this.artifacts.get(caller, row.brief_id, tx)).hash;
    const documents = artifacts.filter(
      (item) => item.mediaType.startsWith('text/') && item.hash !== briefHash,
    );
    check(
      documents.length > 0,
      'invalid_delivery',
      'Delivery requires a text assessment document distinct from the brief',
    );
    const contents = await mapAsync(
      documents,
      async (item) => await this.artifacts.read(caller, item.id),
    );
    check(
      contents.every((item) => item.encoding === 'utf8'),
      'invalid_delivery',
      'Text delivery documents must contain valid UTF-8 text',
    );
    const text = normalized(contents.map((item) => item.content).join('\n'));
    const checks: string[] = JSON.parse(row.checks);
    check(
      checks.every((item) => text.includes(normalized(item))),
      'invalid_delivery',
      'Delivery documents must address every Done-when check using its exact wording',
    );
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

  async markFailed(caller: Caller, input: TaskMarkFailed): Promise<Task> {
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(tx, caller, input.requestId, 'mark_failed', input, async () => {
        check(
          Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
          'invalid_revision',
          'Expected revision must be a nonnegative integer',
        );
        const row = await this.row(tx, caller, input.taskId);
        let current = await this.workflows.get(caller, row.id, tx);
        await this.checkFailure({ caller, snapshot: current, tx, input: { ...input } });
        const reviewId = current.state === 'in_review' ? row.review_id : null;
        if (current.version === 1) {
          current = await (
            await this.registration(TASK_WORKFLOW.version)
          ).upgrade(
            caller,
            {
              instanceId: row.id,
              fromVersion: 1,
              expectedRevision: input.expectedRevision,
              requestId: `${caller.actorId}:task:failure-upgrade:${input.requestId}`,
            },
            tx,
          );
        }
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
            data: { outcome: input.reason, failure: { ...failure } },
          },
          tx,
        );
        if (reviewId) await this.reviews.supersede(caller, reviewId, tx);
        await recorded(this.state, tx, caller, 'task.failed', row.id, { ...failure });
        return await this.hydrate(caller, await this.row(tx, caller, row.id), tx);
      });
    });
  }

  async submitDelivery(caller: Caller, input: TaskDelivery): Promise<Task> {
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(tx, caller, input.requestId, 'submit_delivery', input, async () => {
        const row = await this.row(tx, caller, input.taskId);
        const checks: string[] = JSON.parse(row.checks);
        const current = await this.workflows.get(caller, row.id, tx);
        await this.checkDelivery({ caller, snapshot: current, tx, input: { ...input } });
        await this.workflows.checkDependencies(caller, row.id, tx);
        const confirmations =
          row.evidence_version === 2
            ? validateConfirmations(input.confirmations, checks, input.artifactIds)
            : [];
        const assessment =
          row.evidence_version === 2
            ? await this.artifacts.create(
                caller,
                {
                  title: clip(`Delivery confirmations: ${row.title}`, 300),
                  content: renderAssessment(checks, confirmations),
                },
                tx,
              )
            : null;
        const deliveryIds = [...input.artifactIds, ...(assessment ? [assessment.id] : [])];
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
              ...(assessment
                ? {
                    deliveryConfirmations: confirmations.map((item) => ({ ...item })),
                    deliveryAssessmentId: assessment.id,
                  }
                : {}),
            },
          },
          tx,
        );
        const review = await this.reviews.request(
          caller,
          {
            subjectId: row.id,
            subjectRevision: moved.revision,
            producerId: caller.actorId,
            administrativeActorId: row.producer_id,
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
            ...(row.evidence_version === 2 ? { formatVersion: 2 as const } : {}),
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
        });
        return await this.hydrate(caller, await this.row(tx, caller, row.id), tx);
      });
    });
  }

  async reissueReview(caller: Caller, input: TaskReissue): Promise<Task> {
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
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'review', tx);
      rejectReviewReturn(input);
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
        const action = { pass: 'accept', needs_changes: 'revise', fail: 'fail_review' }[
          input.verdict
        ];
        await (
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
  async apply(ctx: Context) {
    const tasks = await createService(
      new TaskService(
        ctx.state,
        ctx.scope,
        ctx.artifacts,
        ctx.workflows,
        ctx.reviews,
        ctx.contextBuilder,
      ),
    );
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
