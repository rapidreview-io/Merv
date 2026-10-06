import { CheckedTransitions } from '@merv/workflows/rules';
import type { LeaseRow } from '@merv/workflows/lease-rows';
import {
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
  type ProcessGraph,
  type Reviews,
  type Scope,
  type Sql,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import type { Context } from 'cordis';
import { z } from 'zod';
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
import {
  acquireLease,
  checkpoint,
  checkpointRows,
  currentLease,
  isProducer,
  leaseArtifactIds,
  leasedClaim,
  leaseHooks,
  leaseRole,
  producerOrAdmin,
  unleased,
  visibleCheckpoints,
} from './lease.js';
import {
  checkoutReviewer,
  checkTaskReview,
  currentReview,
  reviewAction,
  reviewCommit,
  workflowPolicy,
} from './policy.js';
import {
  assignment,
  assignmentFacts,
  context,
  contextInputs,
  contextItems,
  contextType,
  newestType,
  pinnedBase,
  projectContext,
  workflowAssignment,
  workflowAssignmentFacts,
  workflowExecutionReferences,
} from './context.js';
import { liveLeases, running, runningPanel, standing } from './running.js';
import {
  advance,
  checkDelivery,
  checkFailure,
  checkReissue,
  createTask,
  deliveredCommit,
  markFailed,
  reissueReview,
  submitDelivery,
  submitReview,
  taskCommand,
} from './commands.js';

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
  // Lease hooks and checkpoints (lease.ts), the workflow policy (policy.ts), contexts and
  // assignments (context.ts), the Running page (running.ts) and the commands (commands.ts).
  // Only the Tasks contract is public; the rest are theirs.
  readonly leaseHooks = leaseHooks;
  readonly leasedClaim = leasedClaim;
  readonly leaseRole = leaseRole;
  readonly currentLease = currentLease;
  readonly acquireLease = acquireLease;
  readonly leaseArtifactIds = leaseArtifactIds;
  readonly unleased = unleased;
  readonly isProducer = isProducer;
  readonly producerOrAdmin = producerOrAdmin;
  readonly checkpointRows = checkpointRows;
  readonly visibleCheckpoints = visibleCheckpoints;
  readonly checkpoint = checkpoint;
  readonly workflowPolicy = workflowPolicy;
  readonly reviewAction = reviewAction;
  readonly currentReview = currentReview;
  readonly checkTaskReview = checkTaskReview;
  readonly reviewCommit = reviewCommit;
  readonly checkoutReviewer = checkoutReviewer;
  readonly context = context;
  readonly newestType = newestType;
  readonly contextType = contextType;
  readonly projectContext = projectContext;
  readonly contextInputs = contextInputs;
  readonly contextItems = contextItems;
  readonly workflowAssignmentFacts = workflowAssignmentFacts;
  readonly workflowAssignment = workflowAssignment;
  readonly workflowExecutionReferences = workflowExecutionReferences;
  readonly pinnedBase = pinnedBase;
  readonly assignmentFacts = assignmentFacts;
  readonly assignment = assignment;
  readonly running = running;
  readonly runningPanel = runningPanel;
  readonly liveLeases = liveLeases;
  readonly standing = standing;
  readonly createTask = createTask;
  readonly checkDelivery = checkDelivery;
  readonly deliveredCommit = deliveredCommit;
  readonly checkReissue = checkReissue;
  readonly checkFailure = checkFailure;
  readonly taskCommand = taskCommand;
  readonly advance = advance;
  readonly markFailed = markFailed;
  readonly submitDelivery = submitDelivery;
  readonly reissueReview = reissueReview;
  readonly submitReview = submitReview;
  closed = false;
  code?: Code;
  sandboxes?: Pick<Sandboxes, 'captures'>;
  codeBinding?: symbol;
  releaseReviewOwner?: () => void;
  readonly registrations = new Map<number, Awaited<ReturnType<Workflows['register']>>>();
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
    readonly contextBuilder: ContextBuilder,
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
            this.workflowPolicy(version),
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
            await this.leasedClaim(caller, snapshot, tx);
        },
        // A task carries the claims of its newest delivery only, so they stand beside the
        // review of that delivery and beside no earlier one.
        claims: async (caller, review, tx) =>
          (await this.row(tx, caller, review.subjectId)).review_id === review.id
            ? (((await this.workflows.get(caller, review.subjectId, tx)).data
                .deliveryConfirmations as unknown as TaskConfirmation[] | undefined) ?? [])
            : [],
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** The optional Cordis child owns this binding, not the task lifecycle. */
  bindCode(code: Code): () => void {
    check(!this.closed, 'tasks_closed', 'Tasks is closed', 503);
    const binding = Symbol('code');
    this.codeBinding = binding;
    this.code = code;
    const release = code.bindServiceTasks(resolutionTasks(this.serviceTasks('code')));
    return () => {
      release();
      if (this.codeBinding !== binding) return;
      this.codeBinding = undefined;
      this.code = undefined;
    };
  }

  /** Current tasks require Code-managed Git. */
  requireCode(): Code {
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
  async projectRecords(caller: Caller, rows: TaskRow[], tx?: Transaction): Promise<TaskRecord[]> {
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
        const { row } = await this.assignmentFacts(
          caller,
          { taskId, purpose: saved.purpose, expectedRevision: workflow.revision },
          tx,
          true,
          workflow,
        );
        return (
          await this.visibleCheckpoints(
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
  inject: ['state', 'scope', 'artifacts', 'workflows', 'reviews', 'contextBuilder', 'paper'],
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
        ctx.paper,
        config.limits,
      ),
    );
    ctx.inject(['codeWork'], (ctx) => {
      ctx.effect(() => tasks.bindCode(ctx.codeWork));
    });
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
