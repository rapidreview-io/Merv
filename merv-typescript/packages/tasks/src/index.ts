import type { Context } from 'cordis';
import {
  check,
  digest,
  now,
  type Artifacts,
  type Caller,
  type Reviews,
  type Scope,
  type Sql,
  type State,
  type Task,
  type TaskCreate,
  type TaskDelivery,
  type TaskReview,
  type TaskReissue,
  type Tasks,
  type Transaction,
  type WorkflowDefinition,
  type Workflows,
} from '@merv/contracts';

export type {
  Task,
  TaskCreate,
  TaskDelivery,
  TaskReview,
  TaskReissue,
  Tasks,
} from '@merv/contracts';

export const TASK_WORKFLOW: WorkflowDefinition = {
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
}
const normalized = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

/** Owns task rules and the atomic integration between generic workflow and assessment services. */
export class TaskService implements Tasks {
  private registration: ReturnType<Workflows['register']>;
  constructor(
    private state: State,
    private scope: Scope,
    private artifacts: Artifacts,
    private workflows: Workflows,
    private reviews: Reviews,
  ) {
    state.migrate('tasks', [
      {
        version: 1,
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
        sql: `
      CREATE TRIGGER tasks_brief_immutable BEFORE UPDATE OF project_id, title, goal, checks, producer_id, brief_id, created_at ON tasks
        BEGIN SELECT RAISE(ABORT, 'A task brief is immutable'); END;
    `,
      },
    ]);
    this.registration = workflows.register(TASK_WORKFLOW);
  }

  dispose(): void {
    this.registration.dispose();
  }

  private row(sql: Sql, caller: Caller, taskId: string): TaskRow {
    const row = sql.get<TaskRow>(
      'SELECT * FROM tasks WHERE id = ? AND project_id = ?',
      taskId,
      caller.projectId,
    );
    check(row, 'not_found', 'Task not found in this project', 404);
    return row;
  }
  private hydrate(caller: Caller, row: TaskRow, tx?: Transaction): Task {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      goal: row.goal,
      checks: JSON.parse(row.checks),
      producerId: row.producer_id,
      briefId: row.brief_id,
      deliveryIds: JSON.parse(row.delivery_ids),
      reviewId: row.review_id,
      workflow: this.workflows.get(caller, row.id, tx),
      createdAt: row.created_at,
    };
  }
  private command<T>(
    tx: Transaction,
    caller: Caller,
    requestId: string,
    operation: string,
    input: unknown,
    fn: () => T,
  ): T {
    check(
      typeof requestId === 'string' && requestId.trim().length > 0,
      'invalid_request',
      'requestId is required',
    );
    const hash = digest(input);
    const old = tx.get<{ operation: string; input_hash: string; result: string }>(
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
    const result = fn();
    tx.run(
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

  create(caller: Caller, input: TaskCreate): Task {
    return this.state.transaction((tx) => {
      this.scope.require(caller, 'write', tx);
      return this.command(tx, caller, input.requestId, 'create', input, () => {
        check(
          typeof input.title === 'string' &&
            input.title.trim() &&
            typeof input.goal === 'string' &&
            input.goal.trim(),
          'invalid_brief',
          'Task title and goal must be nonempty',
        );
        check(
          Array.isArray(input.checks) &&
            input.checks.length > 0 &&
            input.checks.every((item) => typeof item === 'string' && item.trim()),
          'invalid_checks',
          'Task requires at least one nonempty Done-when check',
        );
        check(
          new Set(input.checks.map(normalized)).size === input.checks.length,
          'invalid_checks',
          'Done-when checks must be distinct',
        );
        const brief = this.artifacts.get(caller, input.briefId, tx);
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
        const document = this.artifacts.read(caller, brief.id);
        check(
          document.encoding === 'utf8',
          'invalid_brief',
          'The brief must contain valid UTF-8 text',
        );
        const text = normalized(document.content);
        check(
          text.includes(normalized(input.goal)) &&
            input.checks.every((item) => text.includes(normalized(item))),
          'invalid_brief',
          'The pinned brief must contain the task goal and every Done-when check',
        );
        const workflow = this.registration.start(
          caller,
          {
            workflow: 'task',
            version: 1,
            requestId: `${caller.actorId}:task:create:${input.requestId}`,
            data: {
              title: input.title,
              goal: input.goal,
              checks: input.checks,
              producerId: caller.actorId,
              briefId: input.briefId,
            },
          },
          tx,
        );
        tx.run(
          'INSERT INTO tasks (id, project_id, title, goal, checks, producer_id, brief_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          workflow.id,
          caller.projectId,
          input.title,
          input.goal,
          JSON.stringify(input.checks),
          caller.actorId,
          input.briefId,
          now(),
        );
        this.state.appendEvent(tx, {
          projectId: caller.projectId,
          actorId: caller.actorId,
          type: 'task.created',
          subjectId: workflow.id,
          data: { briefId: input.briefId },
        });
        return this.hydrate(caller, this.row(tx, caller, workflow.id), tx);
      });
    });
  }

  get(caller: Caller, taskId: string): Task {
    this.scope.require(caller, 'read');
    return this.state.read((sql) => this.hydrate(caller, this.row(sql, caller, taskId)));
  }
  list(caller: Caller): Task[] {
    this.scope.require(caller, 'read');
    return this.state.read((sql) =>
      sql
        .all<TaskRow>(
          'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id',
          caller.projectId,
        )
        .map((row) => this.hydrate(caller, row)),
    );
  }

  submitDelivery(caller: Caller, input: TaskDelivery): Task {
    return this.state.transaction((tx) => {
      this.scope.require(caller, 'write', tx);
      return this.command(tx, caller, input.requestId, 'submit_delivery', input, () => {
        const row = this.row(tx, caller, input.taskId);
        check(
          row.producer_id === caller.actorId,
          'forbidden',
          'Only this task’s producer may submit its delivery',
          403,
        );
        const current = this.workflows.get(caller, input.taskId, tx);
        check(
          current.state === 'in_progress',
          'invalid_transition',
          'Task must be in progress to submit a delivery',
          409,
        );
        check(
          current.revision === input.expectedRevision,
          'revision_conflict',
          'Task revision changed; refresh the task before submitting',
          409,
        );
        check(
          Array.isArray(input.artifactIds) &&
            input.artifactIds.length > 0 &&
            new Set(input.artifactIds).size === input.artifactIds.length,
          'invalid_delivery',
          'Delivery requires a nonempty list of distinct artifacts',
        );
        check(
          !input.artifactIds.includes(row.brief_id),
          'invalid_delivery',
          'The brief cannot serve as the delivery',
        );
        const artifacts = input.artifactIds.map((id) => this.artifacts.get(caller, id, tx));
        check(
          artifacts.every((item) => item.createdBy === caller.actorId && item.size > 0),
          'invalid_delivery',
          'Delivery artifacts must be nonempty and belong to the producer',
        );
        const briefHash = this.artifacts.get(caller, row.brief_id, tx).hash;
        const documents = artifacts.filter(
          (item) => item.mediaType.startsWith('text/') && item.hash !== briefHash,
        );
        check(
          documents.length > 0,
          'invalid_delivery',
          'Delivery requires a text assessment document distinct from the brief',
        );
        const contents = documents.map((item) => this.artifacts.read(caller, item.id));
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
        const moved = this.registration.transition(
          caller,
          {
            instanceId: row.id,
            expectedRevision: input.expectedRevision,
            action: 'submit_delivery',
            requestId: `${caller.actorId}:task:delivery:${input.requestId}`,
            data: { deliveryIds: input.artifactIds },
          },
          tx,
        );
        const review = this.reviews.request(
          caller,
          {
            subjectId: row.id,
            subjectRevision: moved.revision,
            producerId: row.producer_id,
            artifactIds: [row.brief_id, ...input.artifactIds],
            criteria: checks,
            requestId: `${caller.actorId}:task:delivery:${input.requestId}`,
          },
          tx,
        );
        tx.run(
          'UPDATE tasks SET delivery_ids = ?, review_id = ? WHERE id = ? AND project_id = ?',
          JSON.stringify(input.artifactIds),
          review.id,
          row.id,
          caller.projectId,
        );
        this.state.appendEvent(tx, {
          projectId: caller.projectId,
          actorId: caller.actorId,
          type: 'task.delivery_submitted',
          subjectId: row.id,
          data: {
            reviewId: review.id,
            snapshotHash: review.snapshotHash,
            artifactIds: input.artifactIds,
          },
        });
        return this.hydrate(caller, this.row(tx, caller, row.id), tx);
      });
    });
  }

  reissueReview(caller: Caller, input: TaskReissue): Task {
    return this.state.transaction((tx) => {
      this.scope.require(caller, 'write', tx);
      return this.command(tx, caller, input.requestId, 'reissue_review', input, () => {
        const row = this.row(tx, caller, input.taskId);
        if (row.producer_id !== caller.actorId) this.scope.require(caller, 'admin', tx);
        check(
          typeof input.reason === 'string' && input.reason.trim(),
          'invalid_reason',
          'A reason is required to reissue a review',
        );
        const current = this.workflows.get(caller, row.id, tx);
        check(
          current.state === 'in_review' && row.review_id,
          'invalid_transition',
          'Only a task awaiting review can reissue its review',
          409,
        );
        check(
          current.revision === input.expectedRevision,
          'revision_conflict',
          'Task revision changed; refresh the task before reissuing review',
          409,
        );
        const previous = this.reviews.get(caller, row.review_id, tx);
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
        this.reviews.supersede(caller, previous.id, tx);
        const moved = this.registration.transition(
          caller,
          {
            instanceId: row.id,
            expectedRevision: current.revision,
            action: 'reissue_review',
            requestId: `${caller.actorId}:task:reissue:${input.requestId}`,
            data: { reviewReissueReason: input.reason },
          },
          tx,
        );
        const review = this.reviews.request(
          caller,
          {
            subjectId: row.id,
            subjectRevision: moved.revision,
            producerId: row.producer_id,
            artifactIds: previous.artifactIds,
            criteria: previous.criteria,
            requestId: `${caller.actorId}:task:reissue:${input.requestId}`,
          },
          tx,
        );
        tx.run(
          'UPDATE tasks SET review_id = ? WHERE id = ? AND project_id = ?',
          review.id,
          row.id,
          caller.projectId,
        );
        this.state.appendEvent(tx, {
          projectId: caller.projectId,
          actorId: caller.actorId,
          type: 'task.review_reissued',
          subjectId: row.id,
          data: {
            previousReviewId: previous.id,
            reviewId: review.id,
            reason: input.reason,
            snapshotHash: review.snapshotHash,
          },
        });
        return this.hydrate(caller, this.row(tx, caller, row.id), tx);
      });
    });
  }

  submitReview(caller: Caller, input: TaskReview): Task {
    return this.state.transaction((tx) => {
      this.scope.require(caller, 'review', tx);
      return this.command(tx, caller, input.requestId, 'submit_review', input, () => {
        const review = this.reviews.get(caller, input.reviewId, tx);
        const row = this.row(tx, caller, review.subjectId);
        const current = this.workflows.get(caller, row.id, tx);
        check(
          row.review_id === review.id && current.state === 'in_review',
          'stale_review',
          'This review no longer belongs to the current task submission',
          409,
        );
        check(
          current.revision === input.expectedRevision &&
            review.subjectRevision === current.revision,
          'revision_conflict',
          'Task changed since the review snapshot was pinned',
          409,
        );
        const submitted = this.reviews.submit(
          caller,
          {
            reviewId: input.reviewId,
            verdict: input.verdict,
            notes: input.notes,
            requestId: `${caller.actorId}:task:review:${input.requestId}`,
          },
          tx,
        );
        const action = { pass: 'accept', needs_changes: 'revise', fail: 'fail_review' }[
          submitted.verdict!
        ];
        this.registration.transition(
          caller,
          {
            instanceId: row.id,
            expectedRevision: current.revision,
            action,
            requestId: `${caller.actorId}:task:review:${input.requestId}`,
            data: {
              verdict: submitted.verdict,
              reviewId: submitted.id,
              outcome: submitted.verdict === 'pass' ? submitted.notes : null,
              revisionContext: submitted.verdict === 'pass' ? null : submitted.notes,
            },
          },
          tx,
        );
        this.state.appendEvent(tx, {
          projectId: caller.projectId,
          actorId: caller.actorId,
          type: 'task.review_applied',
          subjectId: row.id,
          data: { reviewId: submitted.id, verdict: submitted.verdict, action },
        });
        return this.hydrate(caller, this.row(tx, caller, row.id), tx);
      });
    });
  }
}

export const tasksPlugin = {
  name: 'merv-tasks',
  inject: ['state', 'scope', 'artifacts', 'workflows', 'reviews'],
  apply(ctx: Context) {
    const tasks = new TaskService(ctx.state, ctx.scope, ctx.artifacts, ctx.workflows, ctx.reviews);
    // Keep the graph registration until every consumer of Tasks has been disposed.
    ctx.effect(function* () {
      yield () => tasks.dispose();
      yield ctx.provide('tasks', tasks);
    });
  },
};
export default tasksPlugin;
