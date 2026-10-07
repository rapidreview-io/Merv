import { REVIEW_VERDICTS } from '@merv/reviews/rules';
import { CheckedTransitions } from '@merv/workflows/rules';
import type { LeaseRow } from '@merv/workflows/lease-rows';
import {
  bound,
  check,
  createService,
  digest,
  inTransaction,
  MervError,
  plain,
  receipted,
  visible,
  type Artifact,
  type Artifacts,
  type Caller,
  type ContextBuilder,
  type ContextRecipeDefinition,
  type ContextRegistration,
  type Reviews,
  type Scope,
  type Sql,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import type { ProcessGraph } from '@merv/workflows/models';
import type { Context } from 'cordis';
import { postgresMigrations } from './index.postgres.js';

import type { Code } from '@merv/code-work/types';
import type { Sandboxes } from '@merv/sandboxes/types';
import type { Paper } from '@merv/paper/types';
import { TASK_TYPES } from './definitions.js';
import { acceptanceChecks, composedBrief } from './evidence.js';
import { resolutionTasks } from './resolution-brief.js';
import type {
  ServiceTaskCreator,
  Task,
  TaskCheckpoint,
  TaskConfirmation,
  TaskCreate,
  TaskDeliveryCode,
  TaskFailure,
  TaskRecord,
  Tasks,
} from './types.js';
import type { CodeUnit } from '@merv/code-work/models';
import {
  serviceOwned,
  serviceWorkflow,
  TASK_LIMITS,
  TASK_WORKFLOW,
  taskContract,
  taskVersions,
} from './workflow.js';
import { checkpoint, leasedClaim, visibleCheckpoints } from './lease.js';
import { workflowPolicy } from './policy.js';
import { assignmentFacts, context } from './context.js';
import { history, running, runningPanel } from './running.js';
import {
  closeUnstarted,
  createTask,
  markFailed,
  submitDelivery,
  submitReview,
} from './commands.js';

export type {
  Task,
  TaskCreate,
  TaskDelivery,
  TaskFailure,
  TaskMarkFailed,
  TaskRecord,
  TaskReview,
  Tasks,
} from './types.js';
export { serviceWorkflow, TASK_LIMITS, TASK_WORKFLOW, taskWorkspace } from './workflow.js';

export interface TaskRow {
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
/** A task's lease: what it pins besides the step, its claim and its receipt. */
export type TaskLeaseRow = LeaseRow<{
  purpose: 'work' | 'review';
  pinnedArtifacts: Artifact[];
  checkpoints: TaskCheckpoint[];
}>;
/** What the modules (lease.ts, policy.ts, context.ts, running.ts, commands.ts) read of the service. */
export type TasksContext = Pick<
  TaskService,
  | 'artifacts'
  | 'captureArtifactIds'
  | 'checked'
  | 'code'
  | 'command'
  | 'hydrate'
  | 'limits'
  | 'paper'
  | 'process'
  | 'projectRecord'
  | 'registration'
  | 'reviews'
  | 'row'
  | 'scope'
  | 'state'
  | 'types'
  | 'workflows'
>;
export class TaskService implements Tasks {
  // Lease hooks and checkpoints (lease.ts), the workflow policy (policy.ts), contexts and
  // assignments (context.ts), the Running page (running.ts) and the commands (commands.ts) run
  // on this service as their TasksContext; the Tasks contract's share of them is bound here.
  readonly checkpoint = bound(this, checkpoint);
  readonly context = bound(this, context);
  readonly running = bound(this, running);
  readonly runningPanel = bound(this, runningPanel);
  readonly history = bound(this, history);
  readonly markFailed = bound(this, markFailed);
  readonly closeUnstarted = bound(this, closeUnstarted);
  readonly submitDelivery = bound(this, submitDelivery);
  readonly submitReview = bound(this, submitReview);
  private closed = false;
  private sandboxes?: Pick<Sandboxes, 'captures'>;
  private releaseReviewOwner?: () => void;
  private releaseServiceTasks?: () => void;
  private readonly registrations = new Map<number, Awaited<ReturnType<Workflows['register']>>>();
  /** Guards a command has run itself, by the transition it is making in that transaction. */
  readonly checked = new CheckedTransitions();
  readonly types = new Map<
    string,
    { definition: ContextRecipeDefinition; context: ContextRegistration }
  >();
  constructor(
    readonly state: State,
    readonly scope: Scope,
    readonly artifacts: Artifacts,
    readonly workflows: Workflows,
    readonly reviews: Reviews,
    private readonly contextBuilder: ContextBuilder,
    readonly code: Code,
    readonly paper: Paper,
    readonly limits = TASK_LIMITS,
  ) {}

  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('tasks', postgresMigrations);
    try {
      for (const version of Object.keys(taskVersions).map(Number)) {
        this.registrations.set(
          version,
          await this.workflows.register(
            { ...(serviceOwned(version) ? serviceWorkflow : TASK_WORKFLOW), version },
            workflowPolicy(this, version),
          ),
        );
      }
      for (const definition of TASK_TYPES) await this.registerType(definition);
      this.releaseReviewOwner = this.reviews.registerSubmitOwner({
        id: 'tasks',
        owns: async (review, tx) =>
          !!(await tx.get(
            'SELECT id FROM tasks WHERE id=? AND project_id=?',
            review.subjectId,
            review.projectId,
          )),
        submit: async (caller, input, tx) => await this.submitReview(caller, input, tx),
        guidance:
          'Task reviews reject returnTo and paperChanges: pass completes the task, needs_changes returns it for work, and fail ends ordinary tasks or suspends service tasks. task.context and review checkpoints take the claimId.',
        // Only the task's own current review has a pool of leased reviewers to shut out, and
        // the owner deciding as owner may shut them out.
        claim: async (caller, review, tx) => {
          const row = await this.row(tx, caller, review.subjectId);
          const snapshot = await this.workflows.get(caller, row.id, tx);
          this.registration(snapshot.version);
          if (row.review_id === review.id && !review.override)
            await leasedClaim(this, caller, snapshot, tx);
        },
        overrides: ['leased_review_required'],
        // A Git task passes only from a leased reviewer in a checkout of the delivered commit
        // (checkoutReviewer), unless its owner decides as owner.
        verdicts: async (caller, review) =>
          caller.session || review.override ? REVIEW_VERDICTS : ['needs_changes', 'fail'],
        // Only needs_changes returns a task: fail ends it, or suspends a service task.
        returning: ['needs_changes'],
        // A task carries the claims of its newest delivery only, so they stand beside the
        // review of that delivery and beside no earlier one.
        claims: async (caller, review, tx) =>
          (await this.row(tx, caller, review.subjectId)).review_id === review.id
            ? (((await this.workflows.get(caller, review.subjectId, tx)).data
                .deliveryConfirmations as unknown as TaskConfirmation[] | undefined) ?? [])
            : [],
      });
      this.releaseServiceTasks = this.code.bindServiceTasks(
        resolutionTasks(this.serviceTasks('code')),
      );
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  withdrawReviewOwner(): void {
    this.releaseReviewOwner?.();
    this.releaseReviewOwner = undefined;
  }

  dispose(): void {
    this.closed = true;
    this.withdrawReviewOwner();
    this.releaseServiceTasks?.();
    this.releaseServiceTasks = undefined;
    for (const registration of this.registrations.values()) registration.dispose();
    this.registrations.clear();
    for (const type of this.types.values()) type.context.dispose();
    this.types.clear();
  }

  registration(version: number): Awaited<ReturnType<Workflows['register']>> {
    taskContract(version);
    const registration = this.registrations.get(version);
    check(registration, 'workflow_unavailable', 'This task workflow version is unavailable', 503);
    return registration;
  }

  async registerType(definition: ContextRecipeDefinition): Promise<() => void> {
    check(!this.closed, 'tasks_closed', 'Tasks is closed', 503);
    definition = plain<ContextRecipeDefinition>(definition, 'invalid_recipe');
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

  async row(sql: Sql, caller: Caller, taskId: string): Promise<TaskRow> {
    // Guidance's callbacks each read the row; one snapshot reads it once.
    const row = await this.state.remember(`tasks:row:${caller.projectId}:${taskId}`, () =>
      sql.get<TaskRow>(
        'SELECT * FROM tasks WHERE id = ? AND project_id = ?',
        taskId,
        caller.projectId,
      ),
    );
    check(row, 'not_found', 'Task not found in this project', 404);
    return { ...row };
  }
  async projectRecord(caller: Caller, row: TaskRow, tx?: Transaction): Promise<TaskRecord> {
    return (await this.projectRecords(caller, [row], tx))[0];
  }
  /** Each row's record; the workflow facts of all of them are read at once. */
  private async projectRecords(
    caller: Caller,
    rows: TaskRow[],
    tx?: Transaction,
  ): Promise<TaskRecord[]> {
    const facts = await this.workflows.records(
      caller,
      rows.map((row) => row.id),
      tx,
    );
    const found = rows.map((row) => {
      const item = facts.get(row.id);
      check(item, 'not_found', 'Workflow instance not found', 404);
      return item;
    });
    const ends = await this.workflows.ends(
      found.map((item) => item.snapshot),
      tx,
    );
    const briefs = await this.artifacts.getAll(
      caller,
      rows.map((row) => row.brief_id),
      tx,
    );
    return rows.map((row, index) => {
      const { snapshot: workflow, workStarts, dependencies, dependents } = found[index];
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
        composed: composedBrief(briefs[index]),
        deliveryIds: JSON.parse(row.delivery_ids),
        reviewId: row.review_id,
        workflow: { ...workflow, data },
        ...ends[index],
        workStarts,
        failure: (workflow.data.failure as unknown as TaskFailure | undefined) ?? null,
        dependencies,
        dependents,
        createdAt: row.created_at,
        type: row.type_name,
        typeVersion: row.type_version,
        contextInputs: JSON.parse(row.context_inputs),
        ...(workflow.data.workspace === 'git' ? { workspace: 'git' as const } : {}),
        ...(typeof baseTaskId === 'string' ? { baseTaskId } : {}),
        ...(deliveryCode && typeof deliveryCodeArtifactId === 'string'
          ? { deliveryCode: deliveryCode as unknown as TaskDeliveryCode, deliveryCodeArtifactId }
          : {}),
      };
    });
  }
  async hydrate(caller: Caller, row: TaskRow, tx?: Transaction): Promise<Task> {
    return {
      ...(await this.projectRecord(caller, row, tx)),
      guidance: await this.workflows.evaluate(caller, row.id, {}, tx),
    };
  }

  /** Captures, read from Sandboxes; it attaches compute to leases itself. */
  bindSandboxes(service: Pick<Sandboxes, 'captures'>): () => void {
    this.sandboxes = service;
    return () => {
      if (this.sandboxes === service) this.sandboxes = undefined;
    };
  }
  async captureArtifactIds(projectId: string, workId: string, tx: Transaction): Promise<string[]> {
    return (await this.sandboxes?.captures(projectId, workId, tx)) ?? [];
  }
  async command<T>(
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
    return await receipted(tx, caller, requestId, digest(input), fn, {
      table: 'task_commands',
      operation,
    });
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
        return await createTask(
          this,
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
    return await createTask(this, caller, input, transaction);
  }

  /**
   * What Code holds for a task: its pinned base, where a base stands, its acceptance. Null
   * while Code is unavailable or knows no such unit. It is kept off the task record, which work
   * contexts embed and hash.
   */
  async codeUnit(caller: Caller, taskId: string): Promise<CodeUnit | null> {
    caller = structuredClone(caller);
    try {
      return await this.code.unit(caller, taskId);
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
  /**
   * One saved checkpoint. A work checkpoint reads back for anyone who may read the project,
   * whatever the task's state; a leased worker, and anyone reading a review's checkpoint, reads
   * only what their own current context lists, filtered as it filters it. Any other is not found.
   */
  async savedCheckpoint(caller: Caller, taskId: string, checkpointId: string) {
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const saved = await tx.get<{ purpose: 'work' | 'review'; checkpoint: string }>(
        'SELECT purpose,checkpoint FROM task_checkpoints WHERE project_id=? AND task_id=? AND id=?',
        caller.projectId,
        taskId,
        checkpointId,
      );
      check(saved, 'not_found', 'This task has no checkpoint with that ID', 404);
      if (!caller.session && saved.purpose === 'work')
        return JSON.parse(saved.checkpoint) as TaskCheckpoint;
      const listed = async () => {
        const workflow = await this.workflows.get(caller, taskId, tx);
        const { row } = await assignmentFacts(
          this,
          caller,
          { taskId, purpose: saved.purpose, expectedRevision: workflow.revision },
          tx,
          true,
          workflow,
        );
        return (
          await visibleCheckpoints(
            this,
            caller,
            taskId,
            saved.purpose,
            row.review_id,
            workflow.revision,
            tx,
          )
        ).find((checkpoint) => checkpoint.id === checkpointId);
      };
      const found = await listed().catch((error: unknown) => {
        // A caller without the assignment is shown no more than a missing checkpoint shows.
        if (error instanceof MervError && error.status < 500) return undefined;
        throw error;
      });
      check(found, 'not_found', 'Your context lists no checkpoint with that ID', 404);
      return found;
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
      return await this.projectRecords(
        caller,
        await tx.all<TaskRow>(
          'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id',
          caller.projectId,
        ),
        tx,
      );
    });
  }
  /** The records; guidance is per reader and per moment, so task.get carries it. */
  async list(caller: Caller): Promise<TaskRecord[]> {
    return await this.records(caller);
  }
  async active(caller: Caller): Promise<number> {
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return (await this.workflows.open('task', caller.projectId, tx)).length;
    });
  }
}

export const tasksPlugin = {
  name: 'merv-tasks',
  inject: [
    'state',
    'scope',
    'artifacts',
    'workflows',
    'reviews',
    'contextBuilder',
    'codeWork',
    'paper',
  ],
  async apply(ctx: Context) {
    const tasks = await createService(
      new TaskService(
        ctx.state,
        ctx.scope,
        ctx.artifacts,
        ctx.workflows,
        ctx.reviews,
        ctx.contextBuilder,
        ctx.codeWork,
        ctx.paper,
      ),
    );
    ctx.inject(['sandboxes'], (ctx) => {
      ctx.effect(() => tasks.bindSandboxes(ctx.sandboxes));
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
