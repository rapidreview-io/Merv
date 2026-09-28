import { visible, recorded, createService, canonical, digest } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import {
  check,
  effectiveWorkspace,
  mapAsync,
  MervError,
  newId,
  now,
  ROLES,
  within,
} from '@merv/contracts';
import type {
  Caller,
  Role,
  Data,
  Scope,
  Sql,
  State,
  Transaction,
  WorkflowDefinition,
  Workflows,
  WorkflowSnapshot,
  WorkflowStart,
  WorkflowTransition,
  WorkflowPolicy,
  WorkflowEvaluationInput,
  WorkflowDecision,
  WorkflowOverview,
  WorkflowAddDependencies,
  WorkflowAssignment,
  WorkflowBegin,
  WorkflowWorkStart,
  WorkflowExecution,
  WorkflowExecutionReferences,
  WorkflowExecutionTarget,
  WorkflowDispatchCandidate,
  WorkflowLease,
  WorkflowLeaseOffer,
  WorkflowAssignmentRule,
  WorkflowHistoryEntry,
  WorkflowExtendLimit,
  WorkflowDependency,
  WorkflowLimitStatus,
  WorkflowLoopLimit,
  WorkflowProvidedBlocker,
  WorkflowProvidedBlockerInput,
  WorkflowPinned,
  WorkflowRelations,
  ProcessGraph,
} from '@merv/contracts';
import { processGraph } from './process.js';
import { clearBlockers, readBlockers, replaceBlockers } from './blockers.js';
import { DATA_LIMITS, workflowJson } from './json.js';
import { PinnedContracts, readPinned } from './pinned.js';
import { validateDefinition } from './definition.js';
import {
  checkAssignment,
  decision,
  enforceAction,
  readContext,
  throwStateFault,
  type EngineContext,
  validatePolicy,
} from './evaluation.js';
import { buildAssignment, readWorkStarts, workStartsAt } from './assignments.js';
import {
  limitFor,
  limitMessage,
  limitStatus,
  limitStatusOf,
  limitStatuses,
  limitStatusesOf,
} from './limits.js';
import {
  executionDisplay,
  executionFingerprint,
  executionReferences,
  persistExecution,
  executionMetadata,
} from './execution.js';
import {
  attachDependencies,
  detachDependencies,
  instanceRelations,
  normalizeDependencies,
  persistSuccess,
  prerequisites,
  prerequisitesOf,
  relations,
  requireDependencies,
} from './dependencies.js';

const migrations = Object.entries(postgresMigrations).map(([version, sql]) => ({
  version: Number(version),
  sql,
}));

/** The most instances one dependency closure is walked over. */
const closureLimit = 5000;
/** The most instances one statement reads facts for, or rechecks, keeping its binds bounded. */
const batchSize = 1000;
const batches = <T>(items: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(items.length / batchSize) }, (_, index) =>
    items.slice(index * batchSize, (index + 1) * batchSize),
  );

interface InstanceRow {
  id: string;
  project_id: string;
  workflow: string;
  version: number;
  state: string;
  revision: number;
  data_json: string;
  created_at: string;
  updated_at: string;
}
interface Registration {
  definition: WorkflowDefinition;
  policy?: WorkflowPolicy;
  registrationId: string;
}
/** One step as load() read it: the frozen context every callback of the call is given. */
interface Loaded {
  /** The instance as stored, which the closing recheck compares against. */
  row: InstanceRow;
  snapshot: WorkflowSnapshot;
  registration: Registration;
  rule: WorkflowAssignmentRule;
  context: EngineContext;
}
/** What one decision reads besides the instance, read for many instances at once. */
interface Facts {
  /** Whose callbacks decide, resolved once so the limits read and the decision agree. */
  registration?: Registration;
  /** The installed graph, else the pinned one: guidance still draws an unloaded version. */
  definition: WorkflowDefinition;
  dependencies: WorkflowDependency[];
  workStart: WorkflowWorkStart | null;
  limits: WorkflowLimitStatus[];
  blockers: WorkflowProvidedBlocker[];
}
export type { WorkflowHistoryEntry } from '@merv/contracts';

/** The instance and revision a command names, checked the same way wherever one is named. */
const checkInstance = (id: unknown) =>
  check(
    typeof id === 'string' && id.length > 0,
    'invalid_instance',
    'Workflow instance id is required',
  );
const checkRevision = (revision: unknown) =>
  check(
    Number.isSafeInteger(revision) && (revision as number) >= 0,
    'invalid_revision',
    'Expected revision must be a nonnegative integer',
  );

/**
 * An open instance of any stored version whose definition pauses starts of `workflow`. Only
 * that version's nonterminal states are looked for, on the (project, workflow, version, state)
 * index, so the ended instances that make up most of a project are never read; a version with
 * no nonterminal state never pauses anything.
 */
async function openBlocker(
  tx: Transaction,
  projectId: string,
  workflow: string,
): Promise<{ id: string; workflow: string } | undefined> {
  const blocking = (
    await tx.all<{ definition_json: string }>(
      `SELECT definition_json FROM wf_definitions WHERE (definition_json::jsonb -> 'blocksStarts') @> jsonb_build_array(?::text)`,
      workflow,
    )
  )
    .map((row) => JSON.parse(row.definition_json) as WorkflowDefinition)
    .map((definition) => ({
      definition,
      open: definition.states.filter((state) => !definition.terminal.includes(state)),
    }))
    .filter(({ open }) => open.length);
  if (!blocking.length) return undefined;
  return await tx.get<{ id: string; workflow: string }>(
    `SELECT id,workflow FROM wf_instances WHERE project_id=? AND (${blocking
      .map(
        ({ open }) => `(workflow=? AND version=? AND state IN (${open.map(() => '?').join(',')}))`,
      )
      .join(' OR ')}) LIMIT 1`,
    projectId,
    ...blocking.flatMap(({ definition, open }) => [definition.name, definition.version, ...open]),
  );
}

/** The role a step's lease rule gives its source, once the step's prerequisites are met. */
async function leaseRoleOf(rule: WorkflowAssignmentRule, context: EngineContext): Promise<Role> {
  if (rule.requiresDependencies) requireDependencies(context.dependencies);
  const role = await rule.lease!.role(context);
  check(ROLES.includes(role), 'invalid_workflow_policy', 'Lease role must be declared', 500);
  return role;
}

/** Durable graph engine. Domain programs enforce their own guards through managed handles. */
export class WorkflowsService implements Workflows {
  private readonly registrations = new Map<string, Registration>();
  private readonly contracts = new PinnedContracts();
  private closed = false;
  /**
   * Where a read runs: in the `tx` given, asserted, or else the ambient transaction; outside
   * any, in a read-only snapshot transaction of its own, which never waits for the writer lock.
   */
  private readonly read = async <T>(
    tx: Transaction | undefined,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    // With a place, `within` always hands over a transaction.
    await within(this.state, tx, (sql) => fn(sql as Transaction), 'read');
  /** Where a command runs: as a read does, but outside any transaction in a write one. */
  private readonly write = async <T>(
    tx: Transaction | undefined,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> => await within(this.state, tx, (sql) => fn(sql as Transaction), 'write');

  constructor(
    private readonly state: State,
    private readonly scope: Scope,
  ) {}

  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('workflows', migrations);
    await this.state.read(async (sql) => await this.contracts.preload(sql));
  }

  async register(
    input: WorkflowDefinition,
    policy?: WorkflowPolicy,
  ): Promise<Awaited<ReturnType<Workflows['register']>>> {
    this.assertOpen();
    const definition = validateDefinition(input);
    const validatedPolicy = validatePolicy(definition, policy);
    const key = `${definition.name}@${definition.version}`;
    check(
      !this.registrations.has(key),
      'workflow_already_registered',
      `${key} is already registered`,
      409,
    );
    const hash = digest(definition);
    const pinned = await this.state.transaction(async (tx) => {
      const existing = await tx.get<{ fingerprint: string }>(
        'SELECT fingerprint FROM wf_definitions WHERE name = ? AND version = ?',
        definition.name,
        definition.version,
      );
      check(
        !existing || existing.fingerprint === hash,
        'workflow_version_conflict',
        `${key} changed; publish a new version`,
        409,
      );
      if (!existing)
        await tx.run(
          'INSERT INTO wf_definitions (name, version, fingerprint, definition_json, created_at) VALUES (?, ?, ?, ?, ?)',
          definition.name,
          definition.version,
          hash,
          canonical(definition),
          now(),
        );
      await persistSuccess(tx, definition, validatedPolicy?.successStates);
      await persistExecution(tx, definition, validatedPolicy);
      return await readPinned(tx, definition.name, definition.version);
    });
    this.contracts.keep(pinned!);
    this.assertOpen();
    check(
      !this.registrations.has(key),
      'workflow_already_registered',
      `${key} is already registered`,
      409,
    );
    const registration = {
      definition,
      policy: validatedPolicy,
      registrationId: newId('execution'),
    };
    this.registrations.set(key, registration);
    return {
      dispose: () => {
        if (this.registrations.get(key) === registration) this.registrations.delete(key);
      },
      start: async (caller, input, tx) => {
        this.requireActive(registration);
        return await this.startInternal(caller, input, registration, tx);
      },
      transition: async (caller, input, tx) => {
        this.requireActive(registration);
        return await this.transitionInternal(caller, input, registration, tx);
      },
      addDependencies: async (caller, input, tx) => {
        this.requireActive(registration);
        return await this.addDependenciesInternal(caller, input, registration, tx);
      },
    };
  }

  catalog(): WorkflowDefinition[] {
    this.assertOpen();
    return [...this.registrations.values()]
      .map(({ definition }) => JSON.parse(canonical(definition)) as WorkflowDefinition)
      .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
  }

  async pinned(
    workflow: string,
    version: number,
    transaction?: Transaction,
  ): Promise<WorkflowPinned | null> {
    this.assertOpen();
    return await this.read(transaction, (tx) => this.contracts.get(tx, workflow, version));
  }

  /**
   * Computed from records on every read, in one snapshot; a stored copy could only drift.
   * With `checks: false` no program callback runs: the edges out of the current state carry
   * no status, and the gate is what the record says by itself. A view that draws only where
   * the work stands reads it so, because an action's check may read a submission's bytes.
   * A version whose program is not loaded is drawn from its pinned graph, with no status on
   * any edge.
   */
  async process(
    caller: Caller,
    instanceId: string,
    { checks = true }: { checks?: boolean } = {},
    transaction?: Transaction,
  ): Promise<ProcessGraph> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.read(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const [{ decision, facts }] = await this.guidance(
        caller,
        [await this.readRow(tx, caller.projectId, instanceId)],
        {},
        tx,
        checks,
      );
      const { dependencies, dependents } = await relations(
        tx,
        this.contracts,
        caller.projectId,
        instanceId,
      );
      const history = await this.historyIn(tx, caller.projectId, instanceId, false);
      return processGraph({
        definition: facts.definition,
        rules: facts.registration?.policy?.actions ?? [],
        history,
        decision,
        dependencies,
        dependents,
      });
    });
  }

  async evaluate(
    caller: Caller,
    instanceId: string,
    { ...query }: WorkflowEvaluationInput = {},
    transaction?: Transaction,
  ): Promise<WorkflowDecision> {
    this.assertOpen();
    caller = structuredClone(caller);
    check(
      query.input === undefined || typeof query.action === 'string',
      'invalid_input',
      'Preflight input requires an action',
    );
    if (query.action !== undefined)
      check(
        typeof query.action === 'string' && query.action.length,
        'invalid_action',
        'Action is required',
      );
    const input = query.input === undefined ? undefined : this.data(query.input);
    return await this.read(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const row = await this.readRow(tx, caller.projectId, instanceId);
      if (input && Object.hasOwn(input, 'expectedRevision'))
        check(
          input.expectedRevision === row.revision,
          'revision_conflict',
          'Workflow changed; refresh guidance before acting',
          409,
        );
      return (await this.guidance(caller, [row], { ...query, input }, tx, true))[0].decision;
    });
  }

  /**
   * What guidance reads besides each instance, for all of them at once: prerequisites in two
   * reads, the work starts at their revisions in one, published blockers in one, and each
   * loaded limit in two however many instances stand where it counts.
   */
  private async facts(
    tx: Transaction,
    projectId: string,
    rows: readonly InstanceRow[],
  ): Promise<Map<string, Facts>> {
    const found = new Map<string, Facts>();
    for (const part of batches(rows)) {
      const ids = part.map((row) => row.id);
      const registered = part.map((row) =>
        this.registrations.get(`${row.workflow}@${row.version}`),
      );
      const dependencies = await prerequisites(tx, projectId, ids);
      const starts = await workStartsAt(tx, projectId, part);
      const blockers = new Map(ids.map((id) => [id, [] as WorkflowProvidedBlocker[]]));
      for (const item of await readBlockers(tx, projectId, ids))
        blockers.get(item.instanceId)!.push(item);
      const limits = await limitStatusesOf(
        tx,
        part.map((row, index) => ({
          id: row.id,
          state: row.state,
          policy: registered[index]?.policy,
        })),
      );
      for (const [index, row] of part.entries()) {
        const registration = registered[index];
        const definition =
          registration?.definition ??
          (await this.contracts.get(tx, row.workflow, row.version))?.definition;
        check(definition, 'workflow_unavailable', 'The pinned definition is unavailable', 503);
        found.set(row.id, {
          registration,
          definition,
          dependencies: dependencies.get(row.id)!,
          workStart: starts.get(row.id) ?? null,
          limits: limits.get(row.id)!,
          blockers: blockers.get(row.id)!,
        });
      }
    }
    return found;
  }

  /**
   * The decision for each of several instances an authorized caller read: their facts at once,
   * then each one's callbacks in turn, and one recheck after all of them.
   */
  private async guidance(
    caller: Caller,
    rows: readonly InstanceRow[],
    query: WorkflowEvaluationInput,
    tx: Transaction,
    checks: boolean,
  ): Promise<{ decision: WorkflowDecision; facts: Facts }[]> {
    const facts = await this.facts(tx, caller.projectId, rows);
    const decided = await mapAsync(rows, async (row) => {
      const known = facts.get(row.id)!;
      const context = readContext({
        caller,
        snapshot: this.snapshot(row),
        tx,
        dependencies: known.dependencies,
      });
      return {
        facts: known,
        decision: await decision(
          known.definition,
          known.registration?.policy,
          context,
          query,
          known.workStart,
          known.limits,
          known.blockers,
          checks,
        ),
      };
    });
    // Without a registration no program callback ran.
    const installed = new Set(decided.flatMap(({ facts }) => facts.registration ?? []));
    if (installed.size)
      await this.recheck(tx, rows, 'Guidance callbacks must not change the workflow instance');
    for (const registration of installed) this.requireActive(registration);
    this.assertOpen();
    return decided;
  }

  async assignment(
    caller: Caller,
    instanceId: string,
    tx?: Transaction,
  ): Promise<WorkflowAssignment> {
    return await this.assignmentInternal(caller, instanceId, undefined, tx);
  }

  async dispatchCandidates(
    source: Caller,
    transaction?: Transaction,
    worker?: string,
  ): Promise<WorkflowDispatchCandidate[]> {
    source = structuredClone(source);
    this.assertOpen();
    return await this.read(transaction, async (tx) => {
      await this.scope.require(source, 'read', tx);
      check(!source.session, 'forbidden', 'A leased worker cannot schedule assignments', 403);
      // Only a step with a lease rule can be a candidate; finished work never is, and it is
      // most of a project's history.
      const leasable = (registration: Registration) =>
        (registration.policy?.assignments ?? []).filter((rule) => rule.lease && rule.execution);
      const registered = new Map(
        [...this.registrations].filter(([, registration]) => leasable(registration).length),
      );
      const steps = [...registered.values()].flatMap((registration) =>
        leasable(registration).map((rule) => [
          registration.definition.name,
          registration.definition.version,
          rule.state,
        ]),
      );
      if (!steps.length) return [];
      const rows = await tx.all<InstanceRow>(
        `SELECT * FROM wf_instances WHERE project_id=? AND (workflow,version,state) IN (${steps
          .map(() => '(?,?,?)')
          .join(',')}) ORDER BY created_at,id`,
        source.projectId,
        ...steps.flat(),
      );
      const candidates: WorkflowDispatchCandidate[] = [];
      for (const part of batches(rows)) {
        const found = part.map((row) => {
          const registration = registered.get(`${row.workflow}@${row.version}`)!;
          const rule = leasable(registration).find((rule) => rule.state === row.state)!;
          return { row, registration, rule };
        });
        const limits = await limitStatusesOf(
          tx,
          found.map(({ row, registration }) => ({
            id: row.id,
            state: row.state,
            policy: registration.policy,
          })),
        );
        // A reviewer leased at an exhausted limit could only have a needs_changes verdict
        // refused and rolled back, and the next poll would lease another. The work waits for
        // a human instead, who may still begin it by hand.
        const open = found.filter(({ row }) => !limits.get(row.id)!.some((item) => item.exhausted));
        const dependencies = await prerequisites(
          tx,
          source.projectId,
          open.map(({ row }) => row.id),
        );
        for (const { row, registration, rule } of open) {
          const lease = rule.lease!;
          const execution = rule.execution!;
          const snapshot = this.snapshot(row);
          // One frozen read serves every callback of the row; the recheck below closes them all.
          const context = readContext({
            caller: source,
            snapshot,
            tx,
            dependencies: dependencies.get(row.id)!,
          });
          try {
            const role = await leaseRoleOf(rule, context);
            const label = lease.label
              ? await lease.label(context)
              : `${snapshot.workflow}: ${snapshot.state}`;
            check(
              typeof label === 'string' && visible(label),
              'invalid_workflow_policy',
              'Dispatch labels must be nonempty',
              500,
            );
            const excluded =
              !!worker && !!lease.excludes && (await lease.excludes(context, worker));
            this.requireActive(registration);
            if (excluded) continue;
            candidates.push({
              instanceId: snapshot.id,
              projectId: source.projectId,
              expectedRevision: snapshot.revision,
              workflow: snapshot.workflow,
              version: snapshot.version,
              state: snapshot.state,
              role,
              readOnly: execution.readOnly,
              label,
              policyHash: executionFingerprint(execution),
              registrationId: registration.registrationId,
              workspace: effectiveWorkspace(execution),
              updatedAt: snapshot.updatedAt,
            });
          } catch (error) {
            // Domain admission refusals make a node ineligible. Malformed programs and State
            // faults fail visibly.
            if (!(error instanceof MervError) || ![403, 404, 409, 503].includes(error.status))
              throw error;
            throwStateFault(error);
          }
        }
      }
      // Refused rows too: a callback may write and then refuse.
      await this.recheck(tx, rows, 'Dispatch callbacks must not change the workflow instance');
      // Every row's callbacks have run: a source they revoked is refused here, and the scan
      // rolls back.
      await this.scope.require(source, 'read', tx);
      // Stable sorting preserves the creation/id order within each execution class.
      this.assertOpen();
      return candidates
        .filter(
          (item) =>
            this.registrations.get(`${item.workflow}@${item.version}`)?.registrationId ===
            item.registrationId,
        )
        .sort((left, right) => Number(right.readOnly) - Number(left.readOnly));
    });
  }

  async leaseRole(
    source: Caller,
    { ...target }: WorkflowExecutionTarget,
    transaction?: Transaction,
  ): Promise<Role> {
    source = structuredClone(source);
    return await this.read(transaction, async (tx) => {
      await this.scope.require(source, 'read', tx);
      const { role, row, registration } = await this.role(source, target, tx);
      await this.recheck(tx, [row], 'Lease role callbacks must not change the workflow instance');
      this.requireActive(registration);
      return role;
    });
  }

  /** The source's lease role, left for the caller's closing recheck. */
  private async role(
    source: Caller,
    target: WorkflowExecutionTarget,
    tx: Transaction,
  ): Promise<Loaded & { role: Role }> {
    const loaded = await this.load(source, target, 'lease', tx);
    const role = await leaseRoleOf(loaded.rule, loaded.context);
    this.requireActive(loaded.registration);
    return { ...loaded, role };
  }

  async offerLease(
    source: Caller,
    worker: Caller,
    { ...target }: WorkflowExecutionTarget & { leaseId: string },
    transaction?: Transaction,
  ): Promise<WorkflowLeaseOffer> {
    ({ source, worker } = structuredClone({ source, worker }));
    return await this.write(transaction, async (tx) => {
      await this.scope.require(source, 'read', tx);
      const {
        role,
        row,
        snapshot,
        registration,
        rule,
        context: sourced,
      } = await this.role(source, target, tx);
      check(
        (await this.scope.require(worker, 'read', tx)).role === role,
        'invalid_lease',
        'Worker role does not match the assignment',
        403,
      );
      check(
        source.projectId === worker.projectId && worker.session?.id === target.leaseId,
        'invalid_lease',
        'Lease must name its authenticated worker and source project',
        403,
      );
      // The worker sees the step the source was just admitted to; the closing recheck
      // refuses it if any callback below moved it.
      const context = readContext({
        caller: worker,
        snapshot,
        tx,
        dependencies: sourced.dependencies,
      });
      const step: Loaded = { row, snapshot, registration, rule, context };
      const receipt = executionMetadata(
        await rule.lease!.acquire(
          Object.freeze({ ...context, source: structuredClone(source), leaseId: target.leaseId }),
        ),
      );
      check(
        receipt && typeof receipt === 'object' && !Array.isArray(receipt),
        'invalid_workflow_policy',
        'Lease acquisition must return an object receipt',
        500,
      );
      this.requireActive(registration);
      // Only now: the execution's references read what acquire wrote (pinned artifacts, the
      // review claim, the Git base).
      await checkAssignment(rule, context);
      const execution = await this.executionOf(step);
      const lease: WorkflowLease = {
        leaseId: target.leaseId,
        instanceId: snapshot.id,
        expectedRevision: snapshot.revision,
        projectId: worker.projectId,
        actorId: worker.actorId,
        workflow: snapshot.workflow,
        version: snapshot.version,
        state: snapshot.state,
        policyHash: execution.policyHash,
        registrationId: execution.registrationId,
        receipt,
      };
      await rule.lease!.check(context, structuredClone(receipt));
      this.requireActive(registration);
      const assignment = await this.assignmentOf(worker, step, false, tx, execution);
      // The source is authorized again once every callback has run: one that revoked it is
      // refused here, and the offer rolls back.
      await this.scope.require(source, 'read', tx);
      await this.recheck(tx, [row], 'Lease acquisition must not transition the workflow');
      this.requireActive(registration);
      return { lease, assignment, execution };
    });
  }

  async checkLease(
    worker: Caller,
    lease: WorkflowLease,
    transaction?: Transaction,
    frozen?: WorkflowExecution,
  ): Promise<{ registrationId: string; references?: WorkflowExecutionReferences }> {
    worker = structuredClone(worker);
    lease = workflowJson(lease, 'invalid_lease', 400);
    if (frozen) frozen = workflowJson(frozen, 'invalid_execution_target', 400);
    return await this.read(transaction, async (tx) => {
      const { rule, registration, row, context } = await this.leaseStep(worker, lease, tx);
      let references: WorkflowExecutionReferences | undefined;
      if (frozen) {
        // The registration may have been reloaded since the offer; its caller fences that
        // with the generation this returns. The policy is fenced by its content.
        check(
          frozen.instanceId === lease.instanceId &&
            frozen.projectId === lease.projectId &&
            frozen.actorId === lease.actorId &&
            frozen.workflow === lease.workflow &&
            frozen.version === lease.version &&
            frozen.state === lease.state &&
            frozen.revision === lease.expectedRevision &&
            frozen.policyHash === lease.policyHash &&
            executionFingerprint(frozen.policy) === lease.policyHash,
          'execution_changed',
          'Frozen dispatch authority does not match this active lease',
          409,
        );
        references = executionMetadata(frozen.references);
        if (rule.lease!.outputs) {
          const extra = executionMetadata(
            await rule.lease!.outputs(context, executionMetadata(lease.receipt)),
          );
          for (const [key, ids] of Object.entries(extra)) {
            check(
              Object.hasOwn(references, key) &&
                Array.isArray(references[key]) &&
                Array.isArray(ids) &&
                ids.every((id) => typeof id === 'string' && id.length > 0),
              'invalid_workflow_policy',
              'Resource receipts may extend only declared reference arrays',
              500,
            );
            references[key] = [...new Set([...(references[key] as string[]), ...ids])].sort();
          }
        }
      }
      await this.recheck(tx, [row], 'Lease callbacks must not change the workflow instance');
      this.requireActive(registration);
      return { registrationId: registration.registrationId, ...(references && { references }) };
    });
  }

  /**
   * The lease's admitted step and its program's lease check, left for the caller's closing
   * recheck. References are read once, at the offer: whatever they refuse is either refused
   * here too, by the step's check and the lease check, or fixed once the offer has passed.
   */
  private async leaseStep(worker: Caller, lease: WorkflowLease, tx: Transaction): Promise<Loaded> {
    check(
      worker.actorId === lease.actorId &&
        worker.projectId === lease.projectId &&
        worker.session?.id === lease.leaseId,
      'invalid_lease',
      'Lease belongs to a different worker',
      403,
    );
    await this.scope.require(worker, 'read', tx);
    const step = await this.load(worker, lease, 'execution', tx);
    const { snapshot, rule, registration, context } = step;
    check(
      lease.policyHash === executionFingerprint(rule.execution!),
      'execution_changed',
      'The captured execution policy does not match this workflow state',
      409,
    );
    await checkAssignment(rule, context);
    check(
      snapshot.workflow === lease.workflow &&
        snapshot.version === lease.version &&
        snapshot.state === lease.state,
      'lease_changed',
      'Lease no longer names this workflow state',
      409,
    );
    check(rule.lease, 'lease_unavailable', 'This assignment no longer supports leases', 409);
    await rule.lease.check(context, executionMetadata(lease.receipt));
    this.requireActive(registration);
    return step;
  }

  async activateLease(
    worker: Caller,
    lease: WorkflowLease,
    transaction?: Transaction,
  ): Promise<WorkflowWorkStart> {
    worker = structuredClone(worker);
    lease = workflowJson(lease, 'invalid_lease', 400);
    return await this.write(transaction, async (tx) => {
      const { row, snapshot, registration } = await this.leaseStep(worker, lease, tx);
      await this.recheck(tx, [row], 'Execution callbacks must not change the workflow instance');
      const started = await this.markStarted(worker, snapshot, tx);
      this.requireActive(registration);
      return started;
    });
  }

  async releaseLease(
    lease: WorkflowLease,
    { ...input }: { reason: string },
    transaction?: Transaction,
  ): Promise<void> {
    // The same bounds as the offer that issued it: capping the whole lease as metadata refused
    // the release of a receipt the offer had accepted.
    lease = workflowJson(lease, 'invalid_lease', 400);
    executionMetadata(lease.receipt);
    await this.write(transaction, async (tx) => {
      check(
        typeof input.reason === 'string' && visible(input.reason) && input.reason.length <= 500,
        'invalid_reason',
        'Lease release requires a bounded reason',
      );
      const registration = this.definition(lease.workflow, lease.version);
      const rule = registration.policy?.assignments?.find((rule) => rule.state === lease.state);
      check(
        rule?.lease && rule.execution && executionFingerprint(rule.execution) === lease.policyHash,
        'lease_unavailable',
        'The pinned lease release authority is unavailable',
        503,
      );
      await rule.lease.release({ lease, reason: input.reason, tx });
      this.requireActive(registration);
    });
  }

  /** The execution an admitted step grants: its fixed policy and the references it names now. */
  private async executionOf({
    snapshot,
    registration,
    rule,
    context,
  }: Loaded): Promise<WorkflowExecution> {
    const references = await executionReferences(rule, context);
    this.requireActive(registration);
    return {
      instanceId: snapshot.id,
      projectId: context.caller.projectId,
      actorId: context.caller.actorId,
      workflow: snapshot.workflow,
      version: snapshot.version,
      state: snapshot.state,
      revision: snapshot.revision,
      policyHash: executionFingerprint(rule.execution!),
      registrationId: registration.registrationId,
      policy: structuredClone(rule.execution!),
      references,
    };
  }

  /**
   * The one entry read of a lease, execution or assignment: tenancy, the named revision, the
   * installed definition, the step's rule and its dependencies. Each purpose keeps its own
   * refusals.
   */
  private async load(
    caller: Caller,
    target: { instanceId: string; expectedRevision?: number },
    purpose: 'lease' | 'execution' | 'assignment',
    tx: Transaction,
  ): Promise<Loaded> {
    this.assertOpen();
    const row = await this.readRow(tx, caller.projectId, target.instanceId);
    const snapshot = this.snapshot(row);
    const expected = target.expectedRevision;
    // Whose hand moved the record is not the engine's question: Sessions reads a worker's own
    // handoff out of this conflict.
    check(
      expected === undefined || snapshot.revision === expected,
      'revision_conflict',
      {
        lease: 'Workflow changed before lease admission',
        execution: 'Workflow changed; refresh execution metadata before dispatch',
        assignment: `Expected revision ${expected}, found ${snapshot.revision}`,
      }[purpose],
      409,
    );
    const registration = this.definition(snapshot.workflow, snapshot.version);
    check(
      !registration.definition.terminal.includes(snapshot.state),
      'workflow_ended',
      {
        lease: `This work has ended as ${snapshot.state}; it takes no lease`,
        execution: 'This workflow has ended; it has no execution authority',
        assignment: 'This workflow has ended; it has no active assignment',
      }[purpose],
      409,
    );
    const rule = registration.policy?.assignments?.find((rule) => rule.state === snapshot.state);
    if (purpose === 'lease')
      check(
        rule?.lease && rule.execution,
        'lease_unavailable',
        'This assignment does not support leases',
        409,
      );
    else if (purpose === 'execution')
      check(
        rule?.execution,
        'execution_unavailable',
        'No fixed execution policy is registered for this workflow state',
        409,
      );
    check(
      rule,
      'assignment_unavailable',
      'The owning program has no assignment registered for this workflow step',
      409,
    );
    const context = readContext({
      caller,
      snapshot,
      tx,
      dependencies: await prerequisitesOf(tx, caller.projectId, snapshot.id),
    });
    return { row, snapshot, registration, rule, context };
  }

  async begin(caller: Caller, input: WorkflowBegin, tx?: Transaction): Promise<WorkflowAssignment> {
    checkRevision(input.expectedRevision);
    return await this.assignmentInternal(caller, input.instanceId, input.expectedRevision, tx);
  }

  async workStarts(
    caller: Caller,
    instanceId: string,
    transaction?: Transaction,
  ): Promise<WorkflowWorkStart[]> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.read(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.readSnapshot(tx, caller.projectId, instanceId);
      return await readWorkStarts(tx, caller.projectId, instanceId);
    });
  }

  /** Metadata-only activation shared by interactive begin and leased authentication. */
  private async markStarted(
    caller: Caller,
    snapshot: WorkflowSnapshot,
    tx: Transaction,
  ): Promise<WorkflowWorkStart> {
    const previous = (await workStartsAt(tx, caller.projectId, [snapshot])).get(snapshot.id);
    if (previous) return previous;
    const event = await recorded(this.state, tx, caller, 'workflow.work_started', snapshot.id, {
      workflow: snapshot.workflow,
      version: snapshot.version,
      state: snapshot.state,
      revision: snapshot.revision,
    });
    const workStart: WorkflowWorkStart = {
      instanceId: snapshot.id,
      projectId: caller.projectId,
      workflow: snapshot.workflow,
      version: snapshot.version,
      state: snapshot.state,
      revision: snapshot.revision,
      actorId: caller.actorId,
      startedAt: event.createdAt,
      eventId: event.id,
    };
    await tx.run(
      'INSERT INTO wf_work_starts (instance_id,project_id,workflow,version,state,revision,actor_id,started_at,event_id) VALUES (?,?,?,?,?,?,?,?,?)',
      snapshot.id,
      caller.projectId,
      snapshot.workflow,
      snapshot.version,
      snapshot.state,
      snapshot.revision,
      caller.actorId,
      workStart.startedAt,
      workStart.eventId,
    );
    return workStart;
  }

  private async assignmentInternal(
    caller: Caller,
    instanceId: string,
    expectedRevision: number | undefined,
    transaction?: Transaction,
  ): Promise<WorkflowAssignment> {
    this.assertOpen();
    caller = structuredClone(caller);
    checkInstance(instanceId);
    // Only `begin` names a revision, and it records a work start.
    const place = expectedRevision === undefined ? this.read : this.write;
    return await place(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const step = await this.load(caller, { instanceId, expectedRevision }, 'assignment', tx);
      await checkAssignment(step.rule, step.context);
      const assignment = await this.assignmentOf(caller, step, expectedRevision !== undefined, tx);
      await this.recheck(
        tx,
        [step.row],
        'Assignment callbacks must not change the workflow instance',
      );
      this.requireActive(step.registration);
      return assignment;
    });
  }

  /**
   * The packet for an admitted step, marking its start when `begin`. An execution the caller
   * already computed for this step is shown as it is.
   */
  private async assignmentOf(
    caller: Caller,
    step: Loaded,
    begin: boolean,
    tx: Transaction,
    execution?: WorkflowExecution,
  ): Promise<WorkflowAssignment> {
    const { snapshot, rule, context } = step;
    const workStart = begin
      ? await this.markStarted(caller, snapshot, tx)
      : ((await workStartsAt(tx, caller.projectId, [snapshot])).get(snapshot.id) ?? null);
    // A context provider may read guidance. It must see the marker this call is committing.
    const content = await buildAssignment(rule, context);
    if (rule.execution)
      content.execution = executionDisplay(execution ?? (await this.executionOf(step)));
    return {
      ...content,
      instanceId: snapshot.id,
      projectId: caller.projectId,
      actorId: caller.actorId,
      workflow: snapshot.workflow,
      version: snapshot.version,
      state: snapshot.state,
      revision: snapshot.revision,
      workStart,
    };
  }

  async overview(caller: Caller, transaction?: Transaction): Promise<WorkflowOverview> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.read(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const rows = await tx.all<InstanceRow>(
        'SELECT * FROM wf_instances WHERE project_id=? ORDER BY created_at,id',
        caller.projectId,
      );
      const workflows = (await this.guidance(caller, rows, {}, tx, true)).map(
        (item) => item.decision,
      );
      // Work whose prerequisite ended without succeeding: the engine resolves that gate
      // itself, to the ending action its program declares. Such a record is not ready for
      // anything and nothing will be dispatched for it, and counting it as ready is what
      // makes a project with nothing left to do look busy.
      const stalled = new Set(
        workflows
          .filter(
            (item) => item.available && !item.terminal && item.currentGate === 'dependency_failed',
          )
          .map((item) => item.instanceId),
      );
      // Work at an exhausted loop limit still names an action, since a human may accept or
      // end it, but nothing will be dispatched for it and it is not ready for a worker.
      const escalated = new Set(
        workflows
          .filter(
            (item) => item.available && !item.terminal && item.currentGate === 'loop_limit_reached',
          )
          .map((item) => item.instanceId),
      );
      const waiting = (id: string) => stalled.has(id) || escalated.has(id);
      return {
        projectId: caller.projectId,
        workflows,
        ready: workflows
          .filter((item) => item.nextAction && !waiting(item.instanceId))
          .map((item) => item.instanceId),
        blocked: workflows
          .filter(
            (item) =>
              item.available && !item.terminal && !item.nextAction && !waiting(item.instanceId),
          )
          .map((item) => item.instanceId),
        stalled: [...stalled],
        escalated: [...escalated],
        terminal: workflows.filter((item) => item.terminal).map((item) => item.instanceId),
        unavailable: workflows
          .filter((item) => !item.available && !item.terminal)
          .map((item) => item.instanceId),
      };
    });
  }

  /**
   * An engine command rather than a program's, so it reaches managed workflows too. It writes
   * a grant without changing an active assignment's revision, so a pinned review stays valid.
   * An owner may resume suspended work through its hook in this same transaction; if the
   * owner refuses, the allowance and the resume both roll back.
   */
  async extendLimit(
    caller: Caller,
    { ...input }: WorkflowExtendLimit,
    transaction?: Transaction,
  ): Promise<WorkflowLimitStatus> {
    this.assertOpen();
    caller = structuredClone(caller);
    this.requestId(input.requestId);
    checkInstance(input.instanceId);
    check(
      typeof input.limit === 'string' && input.limit.length > 0,
      'invalid_input',
      'A limit name is required',
    );
    check(
      Number.isSafeInteger(input.additional) && input.additional >= 1 && input.additional <= 100,
      'invalid_input',
      'additional must be an integer between 1 and 100',
    );
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    check(
      reason.length > 0 && reason.length <= 500,
      'invalid_input',
      'A reason of 1–500 characters is required',
    );
    const hash = digest({
      operation: 'extend_limit',
      actorId: caller.actorId,
      instanceId: input.instanceId,
      limit: input.limit,
      additional: input.additional,
      reason,
    });
    return await this.write(transaction, async (tx) => {
      check(!caller.session, 'forbidden', 'A leased worker cannot raise its own limit', 403);
      await this.scope.require(caller, 'admin', tx);
      const snapshot = await this.readSnapshot(tx, caller.projectId, input.instanceId);
      const registered = this.definition(snapshot.workflow, snapshot.version);
      const limit = registered.policy?.limits?.find((item) => item.name === input.limit);
      check(
        limit,
        'unknown_limit',
        `This ${snapshot.workflow} declares no limit ${input.limit}`,
        404,
      );
      const replay = await this.replay<{ id: string; status?: WorkflowLimitStatus }>(
        tx,
        caller.projectId,
        input.requestId,
        hash,
      );
      if (replay) {
        this.requireActive(registered);
        // A grant answers with what it recorded. One recorded before the status was kept
        // stored the instance instead, and is answered with the live status.
        return replay.status ?? (await limitStatus(tx, limit, snapshot.id));
      }
      check(
        !registered.definition.terminal.includes(snapshot.state),
        'invalid_transition',
        'Terminal workflow instances cannot be allowed more rounds',
        409,
      );
      await tx.run(
        'INSERT INTO wf_limit_grants (project_id,request_id,instance_id,limit_name,additional,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)',
        caller.projectId,
        input.requestId,
        snapshot.id,
        limit.name,
        input.additional,
        reason,
        caller.actorId,
        now(),
      );
      const status = await limitStatus(tx, limit, snapshot.id);
      // The grant has its own record, keyed by the instance like every receipt (the retirement
      // migrations match on its id). An owner's optional resume writes its own transition
      // receipt, so retrying this request cannot advance suspended work twice.
      await tx.run(
        'INSERT INTO wf_requests (project_id,request_id,fingerprint,response_json) VALUES (?,?,?,?)',
        caller.projectId,
        input.requestId,
        hash,
        canonical({ id: snapshot.id, status }),
      );
      await registered.policy?.limitExtended?.(
        { caller, snapshot, tx, input: { reason, requestId: input.requestId } },
        status,
      );
      await recorded(this.state, tx, caller, 'workflow.limit_extended', snapshot.id, {
        workflow: snapshot.workflow,
        version: snapshot.version,
        limit: limit.name,
        additional: input.additional,
        max: status.max,
        used: status.used,
        reason,
      });
      this.requireActive(registered);
      return status;
    });
  }

  async limitStatus(
    caller: Caller,
    instanceId: string,
    name: string,
    transaction?: Transaction,
  ): Promise<WorkflowLimitStatus> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.read(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const snapshot = await this.readSnapshot(tx, caller.projectId, instanceId);
      const limit = this.definition(snapshot.workflow, snapshot.version).policy?.limits?.find(
        (item) => item.name === name,
      );
      check(limit, 'unknown_limit', 'This workflow has no such limit', 404);
      return await limitStatus(tx, limit, instanceId);
    });
  }

  async dependencies(
    caller: Caller,
    instanceId: string,
    transaction?: Transaction,
  ): ReturnType<Workflows['dependencies']> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.read(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.readSnapshot(tx, caller.projectId, instanceId);
      return await relations(tx, this.contracts, caller.projectId, instanceId);
    });
  }

  async prerequisites(
    caller: Caller,
    instanceIds: readonly string[],
    transaction?: Transaction,
  ): Promise<Map<string, WorkflowDependency[]>> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.read(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await prerequisites(tx, caller.projectId, [...new Set(instanceIds)]);
    });
  }

  async limitStatusOf(
    caller: Caller,
    instanceIds: readonly string[],
    name: string,
    transaction?: Transaction,
  ): Promise<Map<string, WorkflowLimitStatus>> {
    this.assertOpen();
    caller = structuredClone(caller);
    const ids = [...new Set(instanceIds)];
    return await this.read(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      if (!ids.length) return new Map();
      // One read of the instances, then two per definition among them, never two per instance.
      const limits = new Map<string, { limit: WorkflowLoopLimit; ids: string[] }>();
      for (const row of await tx.all<InstanceRow>(
        `SELECT * FROM wf_instances WHERE project_id=? AND id IN (${ids.map(() => '?').join(',')})`,
        caller.projectId,
        ...ids,
      )) {
        const snapshot = this.snapshot(row);
        const at = `${snapshot.workflow}@${snapshot.version}`;
        const known = limits.get(at);
        if (known) {
          known.ids.push(snapshot.id);
          continue;
        }
        const limit = this.definition(snapshot.workflow, snapshot.version).policy?.limits?.find(
          (item) => item.name === name,
        );
        if (limit) limits.set(at, { limit, ids: [snapshot.id] });
      }
      const statuses = new Map<string, WorkflowLimitStatus>();
      for (const { limit, ids: some } of limits.values())
        for (const [id, status] of await limitStatusOf(tx, limit, some)) statuses.set(id, status);
      return statuses;
    });
  }

  async replaceBlockers(
    input: {
      projectId: string;
      instanceId: string;
      provider: string;
      blockers: WorkflowProvidedBlockerInput[];
    },
    tx: Transaction,
  ): Promise<void> {
    this.assertOpen();
    await this.readSnapshot(tx, input.projectId, input.instanceId);
    await replaceBlockers(tx, input);
  }

  async blockers(
    caller: Caller,
    instanceId?: string,
    transaction?: Transaction,
  ): Promise<WorkflowProvidedBlocker[]> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.read(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      if (instanceId !== undefined) await this.readSnapshot(tx, caller.projectId, instanceId);
      return await readBlockers(
        tx,
        caller.projectId,
        instanceId === undefined ? undefined : [instanceId],
      );
    });
  }

  systemPrerequisites(provider: string): ReturnType<Workflows['systemPrerequisites']> {
    check(
      typeof provider === 'string' && provider.trim().length > 0,
      'invalid_provider',
      'A provider is required',
    );
    return {
      replace: async (input, tx) => {
        input = structuredClone(input);
        this.assertOpen();
        this.state.assertTransaction(tx);
        const wanted = normalizeDependencies(input.dependencies);
        const source = await this.readSnapshot(tx, input.projectId, input.instanceId);
        const have = (
          await tx.all<{ target_id: string }>(
            "SELECT target_id FROM wf_dependencies WHERE project_id=? AND source_id=? AND kind='system' AND owner=?",
            input.projectId,
            input.instanceId,
            provider,
          )
        ).map((row) => row.target_id);
        await attachDependencies(
          tx,
          this.contracts,
          source,
          wanted.filter((id) => !have.includes(id)),
          { owner: provider },
        );
        const gone = have.filter((id) => !wanted.includes(id));
        if (gone.length)
          await tx.run(
            `DELETE FROM wf_dependencies WHERE project_id=? AND source_id=? AND kind='system' AND owner=? AND target_id IN (${gone.map(() => '?').join(',')})`,
            input.projectId,
            input.instanceId,
            provider,
            ...gone,
          );
      },
    };
  }

  async relations(
    projectId: string,
    instanceId: string,
    tx: Transaction,
  ): Promise<WorkflowRelations | null> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    return await instanceRelations(tx, this.contracts, projectId, instanceId);
  }

  /** Reads only what the instance depends on, never what depends on it. */
  async checkDependencies(
    caller: Caller,
    instanceId: string,
    transaction?: Transaction,
  ): Promise<void> {
    this.assertOpen();
    caller = structuredClone(caller);
    await this.read(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.readSnapshot(tx, caller.projectId, instanceId);
      requireDependencies(await prerequisitesOf(tx, caller.projectId, instanceId));
    });
  }

  /**
   * The children each loaded policy names for the instances given, as parent to children: one
   * call per version that declares them and batch of its instances, keeping each answer bounded.
   */
  private async children(
    tx: Transaction,
    projectId: string,
    rows: readonly { id: string; workflow: string; version: number }[],
  ): Promise<Map<string, string[]>> {
    const declaring = new Map<Registration, string[]>();
    for (const row of rows) {
      const registration = this.registrations.get(`${row.workflow}@${row.version}`);
      if (!registration?.policy?.children) continue;
      const ids = declaring.get(registration);
      if (ids) ids.push(row.id);
      else declaring.set(registration, [row.id]);
    }
    const found = new Map<string, string[]>();
    for (const [registration, all] of declaring)
      for (const ids of batches(all)) {
        const named = await registration.policy!.children!({
          projectId,
          instanceIds: Object.freeze(ids),
          tx,
        });
        check(
          typeof named === 'object' && named !== null && !Array.isArray(named),
          'invalid_workflow_policy',
          'Workflow children must be a record of instance id to child ids',
          500,
        );
        for (const id of ids) {
          const children = Object.hasOwn(named, id) ? named[id] : [];
          check(
            Array.isArray(children) && children.every((child) => typeof child === 'string'),
            'invalid_workflow_policy',
            'Workflow children must be lists of instance ids',
            500,
          );
          found.set(id, children);
        }
      }
    return found;
  }

  /** The provider freezes these roots before later dependencies can move a shared charge. */
  async sponsoringRoots(
    projectId: string,
    instanceIds: string[],
    tx: Transaction,
  ): Promise<string[]> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    const parents = new Map<string, Set<string>>();
    const link = (child: string, parent: string) => {
      if (!parents.has(child)) parents.set(child, new Set());
      parents.get(child)!.add(parent);
    };
    for (const row of await tx.all<{ source_id: string; target_id: string }>(
      "SELECT source_id,target_id FROM wf_dependencies WHERE project_id=? AND kind='declared'",
      projectId,
    ))
      link(row.target_id, row.source_id);
    // Only an instance of a version whose policy names children can be a parent without an edge.
    const declaring = [...this.registrations.values()].filter(
      (registration) => registration.policy?.children,
    );
    if (declaring.length)
      for (const [parent, children] of await this.children(
        tx,
        projectId,
        await tx.all<{ id: string; workflow: string; version: number }>(
          `SELECT id,workflow,version FROM wf_instances WHERE project_id=? AND (${declaring.map(() => '(workflow=? AND version=?)').join(' OR ')})`,
          projectId,
          ...declaring.flatMap(({ definition }) => [definition.name, definition.version]),
        ),
      ))
        for (const child of children) link(child, parent);
    const seen = new Set<string>(),
      roots = new Set<string>(),
      queue = [...instanceIds];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const above = parents.get(id);
      if (!above?.size) roots.add(id);
      else queue.push(...above);
    }
    // Policy children can form a cycle even though declared dependencies cannot.
    return [...(roots.size ? roots : new Set(instanceIds))].sort();
  }

  /**
   * Walked level by level: each level's instances are read at once, then their edges in one
   * read and their children in one call per version that declares them, so a policy can name
   * the children no dependency edge does. The bound keeps a pathological graph from holding a
   * read open. A closure past it is refused rather than cut short: every caller would act on
   * the part it was given as if it were the whole.
   */
  async dependencyClosure(
    caller: Caller,
    instanceId: string,
    transaction?: Transaction,
  ): Promise<string[]> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.read(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.readSnapshot(tx, caller.projectId, instanceId);
      const seen = new Set<string>();
      let frontier = [instanceId];
      while (frontier.length) {
        // A name with no instance here, gone or another project's, is no part of the closure.
        const level: { id: string; workflow: string; version: number }[] = [];
        for (const part of batches(frontier)) {
          level.push(
            ...(await tx.all<{ id: string; workflow: string; version: number }>(
              `SELECT id,workflow,version FROM wf_instances WHERE project_id=? AND id IN (${part.map(() => '?').join(',')})`,
              caller.projectId,
              ...part,
            )),
          );
          check(
            seen.size + level.length <= closureLimit,
            'closure_too_large',
            `This dependency closure covers more than ${closureLimit} workflow instances`,
            409,
          );
        }
        if (!level.length) break;
        for (const row of level) seen.add(row.id);
        const next = (
          await tx.all<{ target_id: string }>(
            `SELECT target_id FROM wf_dependencies WHERE project_id=? AND source_id IN (${level.map(() => '?').join(',')})`,
            caller.projectId,
            ...level.map((row) => row.id),
          )
        ).map((item) => item.target_id);
        for (const children of (await this.children(tx, caller.projectId, level)).values())
          next.push(...children);
        frontier = [...new Set(next)].filter((id) => !seen.has(id));
      }
      return [...seen];
    });
  }

  async get(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowSnapshot> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.read(tx, async (transaction) => {
      await this.scope.require(caller, 'read', transaction);
      return await this.readSnapshot(transaction, caller.projectId, instanceId);
    });
  }

  async list(caller: Caller, tx?: Transaction): Promise<WorkflowSnapshot[]> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.read(tx, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return (
        await tx.all<InstanceRow>(
          'SELECT * FROM wf_instances WHERE project_id = ? ORDER BY created_at, id',
          caller.projectId,
        )
      ).map(this.snapshot);
    });
  }

  async history(
    caller: Caller,
    instanceId: string,
    transaction?: Transaction,
  ): Promise<WorkflowHistoryEntry[]> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.read(transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.readSnapshot(tx, caller.projectId, instanceId);
      return await this.historyIn(tx, caller.projectId, instanceId, true);
    });
  }

  /**
   * The instance's history in revision order. A traversal reads it without `data`: a row's
   * data can be as large as the data it merged, and a traversal shows none of it.
   */
  private async historyIn(
    tx: Transaction,
    projectId: string,
    instanceId: string,
    data: true,
  ): Promise<WorkflowHistoryEntry[]>;
  private async historyIn(
    tx: Transaction,
    projectId: string,
    instanceId: string,
    data: false,
  ): Promise<Omit<WorkflowHistoryEntry, 'data'>[]>;
  private async historyIn(
    tx: Transaction,
    projectId: string,
    instanceId: string,
    data: boolean,
  ): Promise<(Omit<WorkflowHistoryEntry, 'data'> & { data?: Data })[]> {
    const rows = await tx.all<{
      instance_id: string;
      revision: number;
      action: string;
      actor_id: string;
      request_id: string;
      from_state: string | null;
      to_state: string;
      data_json?: string;
      created_at: string;
    }>(
      `SELECT instance_id,revision,action,actor_id,request_id,from_state,to_state,${data ? 'data_json,' : ''}created_at FROM wf_history WHERE project_id = ? AND instance_id = ? ORDER BY revision`,
      projectId,
      instanceId,
    );
    return rows.map((row) => ({
      instanceId: row.instance_id,
      revision: row.revision,
      action: row.action,
      actorId: row.actor_id,
      requestId: row.request_id,
      fromState: row.from_state,
      toState: row.to_state,
      ...(row.data_json === undefined ? {} : { data: JSON.parse(row.data_json) as Data }),
      createdAt: row.created_at,
    }));
  }

  private async startInternal(
    caller: Caller,
    { ...input }: WorkflowStart,
    owner: Registration,
    tx?: Transaction,
  ): Promise<WorkflowSnapshot> {
    this.assertOpen();
    caller = structuredClone(caller);
    const { name, version } = owner.definition;
    check(
      input.workflow === name && (input.version === undefined || input.version === version),
      'workflow_handle_mismatch',
      'The program handle only owns its registered workflow version',
      403,
    );
    this.requestId(input.requestId);
    const data = this.data(input.data);
    const dependsOn = normalizeDependencies(input.dependsOn);
    // The fingerprint names the set asked for, so a retry in another order, or with an empty
    // list for an omitted one, replays; the ids are attached in the order given.
    const sorted = [...dependsOn].sort();
    const hash = digest({
      operation: 'start',
      actorId: caller.actorId,
      workflow: name,
      version,
      data,
      ...(sorted.length ? { dependsOn: sorted } : {}),
    });
    return await this.write(tx, async (transaction) => {
      // A program authorizes its own commands, including reviewer-triggered repair.
      await this.scope.require(caller, 'read', transaction);
      // The fingerprint names this handle's workflow and version, so a replay is one of its own.
      const replay = await this.replay<WorkflowSnapshot>(
        transaction,
        caller.projectId,
        input.requestId,
        hash,
      );
      this.requireActive(owner);
      if (replay) return replay;
      const blocker = await openBlocker(transaction, caller.projectId, name);
      check(
        !blocker,
        'workflow_creation_paused',
        `New ${name} work is paused while ${blocker?.workflow} ${blocker?.id} is active. Existing work may continue.`,
        409,
      );
      const time = now();
      const snapshot: WorkflowSnapshot = {
        id: newId('wf'),
        projectId: caller.projectId,
        workflow: name,
        version,
        state: owner.definition.initial,
        revision: 0,
        data,
        createdAt: time,
        updatedAt: time,
      };
      await transaction.run(
        'INSERT INTO wf_instances (id, project_id, workflow, version, state, revision, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        snapshot.id,
        snapshot.projectId,
        snapshot.workflow,
        snapshot.version,
        snapshot.state,
        0,
        canonical(data),
        time,
        time,
      );
      // The id was just minted, so no edge can lead back to it.
      await attachDependencies(transaction, this.contracts, snapshot, dependsOn, { fresh: true });
      await this.record(
        transaction,
        caller,
        owner,
        snapshot,
        input.requestId,
        hash,
        'start',
        null,
        data,
        dependsOn.length ? { dependsOn } : {},
      );
      this.requireActive(owner);
      return snapshot;
    });
  }

  private async transitionInternal(
    caller: Caller,
    { ...input }: WorkflowTransition,
    owner: Registration,
    tx?: Transaction,
  ): Promise<WorkflowSnapshot> {
    this.assertOpen();
    caller = structuredClone(caller);
    this.requestId(input.requestId);
    checkInstance(input.instanceId);
    check(
      typeof input.action === 'string' && input.action.length > 0,
      'invalid_action',
      'Workflow action is required',
    );
    checkRevision(input.expectedRevision);
    const data = this.data(input.data);
    const proposed = input.input === undefined ? undefined : this.data(input.input);
    const hash = digest({
      operation: 'transition',
      actorId: caller.actorId,
      instanceId: input.instanceId,
      action: input.action,
      expectedRevision: input.expectedRevision,
      data,
      ...(proposed === undefined ? {} : { input: proposed }),
    });
    return await this.write(tx, async (transaction) => {
      // The program owns action-specific write/review policies; the engine still validates tenancy.
      await this.scope.require(caller, 'read', transaction);
      const row = await this.readRow(transaction, caller.projectId, input.instanceId);
      const before = this.snapshot(row);
      this.checkHandle(owner, before);
      const replay = await this.replay<WorkflowSnapshot>(
        transaction,
        caller.projectId,
        input.requestId,
        hash,
      );
      if (replay) {
        this.requireActive(owner);
        return replay;
      }
      check(
        before.revision === input.expectedRevision,
        'revision_conflict',
        `Expected revision ${input.expectedRevision}, found ${before.revision}`,
        409,
      );
      // A stale revision is named before a withdrawn handle, as when the registry was read here.
      this.requireActive(owner);
      const edge = owner.definition.edges.find(
        (edge) => edge.from === before.state && edge.action === input.action,
      );
      check(
        edge,
        'invalid_transition',
        `Action ${input.action} is unavailable from ${before.state}`,
        409,
      );
      // Checked before the owning rule so the caller learns the limit, not whichever domain
      // refusal would also apply, and inside this transaction so the refusal rolls back the
      // whole command that asked for the return.
      const limit = limitFor(owner.policy, before.state, edge.action);
      if (limit) {
        const status = await limitStatus(transaction, limit, before.id);
        check(!status.exhausted, 'loop_limit_reached', limitMessage(status, before.workflow), 409);
      }
      if (owner.policy) {
        const rule = owner.policy.actions.find(
          (rule) => rule.states.includes(before.state) && rule.transitions?.includes(edge.action),
        );
        check(rule, 'invalid_workflow_policy', 'Transition has no registered guard', 500);
        await enforceAction(
          rule,
          readContext({
            caller,
            snapshot: before,
            tx: transaction,
            input: proposed,
            transition: edge.action,
            dependencies: await prerequisitesOf(transaction, caller.projectId, before.id),
          }),
        );
      }
      await this.recheck(
        transaction,
        [row],
        'Transition checks must not change the workflow instance',
      );
      this.requireActive(owner);
      const after: WorkflowSnapshot = {
        ...before,
        state: edge.to,
        revision: before.revision + 1,
        data: { ...before.data, ...data },
        updatedAt: now(),
      };
      const update = await transaction.run(
        'UPDATE wf_instances SET state = ?, revision = ?, data_json = ?, updated_at = ? WHERE id = ? AND project_id = ? AND revision = ?',
        after.state,
        after.revision,
        canonical(after.data),
        after.updatedAt,
        after.id,
        caller.projectId,
        before.revision,
      );
      check(
        update.changes === 1,
        'revision_conflict',
        'Workflow changed while applying this action',
        409,
      );
      await this.record(
        transaction,
        caller,
        owner,
        after,
        input.requestId,
        hash,
        input.action,
        before.state,
        data,
      );
      // Ended work waits on nothing, and the provider that spoke may not be loaded to say so.
      if (owner.definition.terminal.includes(after.state))
        await clearBlockers(transaction, after.id);
      // Recorded on arrival, never from a read. A step that stays in the capped state (a
      // reissued review) is not a new arrival and says nothing new.
      if (after.state !== before.state)
        for (const arrived of await limitStatuses(transaction, owner.policy, after))
          if (arrived.exhausted)
            await recorded(this.state, transaction, caller, 'workflow.escalated', after.id, {
              workflow: after.workflow,
              version: after.version,
              revision: after.revision,
              state: after.state,
              limit: arrived.name,
              used: arrived.used,
              max: arrived.max,
            });
      this.requireActive(owner);
      return after;
    });
  }

  private async addDependenciesInternal(
    caller: Caller,
    { ...input }: WorkflowAddDependencies,
    owner: Registration,
    transaction?: Transaction,
  ): Promise<WorkflowSnapshot> {
    this.assertOpen();
    caller = structuredClone(caller);
    this.requestId(input.requestId);
    checkInstance(input.instanceId);
    checkRevision(input.expectedRevision);
    const dependsOn = normalizeDependencies(input.dependsOn);
    const drop = normalizeDependencies(input.drop ?? null).filter((id) => !dependsOn.includes(id));
    // Fingerprinted as sets, as at start; the ids are attached and dropped in the order given.
    const hash = digest({
      operation: 'add_dependencies',
      actorId: caller.actorId,
      instanceId: input.instanceId,
      expectedRevision: input.expectedRevision,
      dependsOn: [...dependsOn].sort(),
      ...(drop.length ? { drop: [...drop].sort() } : {}),
    });
    return await this.write(transaction, async (tx) => {
      // As at start and transition: the program authorizes its own commands.
      await this.scope.require(caller, 'read', tx);
      const before = await this.readSnapshot(tx, caller.projectId, input.instanceId);
      this.checkHandle(owner, before);
      const replay = await this.replay<WorkflowSnapshot>(
        tx,
        caller.projectId,
        input.requestId,
        hash,
      );
      if (replay) {
        this.requireActive(owner);
        return replay;
      }
      check(
        before.revision === input.expectedRevision,
        'revision_conflict',
        `Expected revision ${input.expectedRevision}, found ${before.revision}`,
        409,
      );
      check(
        !owner.definition.terminal.includes(before.state),
        'invalid_transition',
        'Terminal workflow instances cannot receive new dependencies',
        409,
      );
      const added = await attachDependencies(tx, this.contracts, before, dependsOn);
      const dropped = await detachDependencies(tx, before, drop);
      if (!added.length && !dropped.length) {
        await tx.run(
          'INSERT INTO wf_requests (project_id,request_id,fingerprint,response_json) VALUES (?,?,?,?)',
          caller.projectId,
          input.requestId,
          hash,
          canonical(before),
        );
        this.requireActive(owner);
        return before;
      }
      const after = { ...before, revision: before.revision + 1, updatedAt: now() };
      const changed = await tx.run(
        'UPDATE wf_instances SET revision=?,updated_at=? WHERE id=? AND project_id=? AND revision=?',
        after.revision,
        after.updatedAt,
        after.id,
        caller.projectId,
        before.revision,
      );
      check(
        changed.changes === 1,
        'revision_conflict',
        'Workflow changed while adding dependencies',
        409,
      );
      await this.record(
        tx,
        caller,
        owner,
        after,
        input.requestId,
        hash,
        dropped.length ? 'replan_dependencies' : 'add_dependencies',
        before.state,
        { dependsOn: added, dropped },
        { dependsOn: added, dropped },
      );
      this.requireActive(owner);
      return after;
    });
  }

  private definition(name: string, version: number): Registration {
    const registration = this.registrations.get(`${name}@${version}`);
    check(
      registration,
      'workflow_unavailable',
      `Workflow ${name}@${version} is not installed`,
      503,
    );
    return registration;
  }

  /** A handle commands only the instances of its own workflow version. */
  private checkHandle(owner: Registration, snapshot: WorkflowSnapshot): void {
    check(
      owner.definition.name === snapshot.workflow && owner.definition.version === snapshot.version,
      'workflow_handle_mismatch',
      'The program handle does not own this workflow instance',
      403,
    );
  }

  /**
   * After a group of callbacks: none of them wrote to the instances given. Their stored
   * columns are compared as read, so a rewrite to equal data in other bytes is refused too.
   * Every transaction under a snapshot root is read-only, so there nothing can have written.
   */
  private async recheck(
    tx: Transaction,
    rows: readonly InstanceRow[],
    message: string,
  ): Promise<void> {
    if (this.state.readScope) return;
    for (const part of batches(rows)) {
      const now = new Map(
        (
          await tx.all<InstanceRow>(
            `SELECT id,project_id,revision,state,data_json,updated_at FROM wf_instances WHERE id IN (${part.map(() => '?').join(',')})`,
            ...part.map((row) => row.id),
          )
        ).map((row) => [row.id, row]),
      );
      check(
        part.every((row) => {
          const stored = now.get(row.id);
          return (
            !!stored &&
            stored.project_id === row.project_id &&
            stored.revision === row.revision &&
            stored.state === row.state &&
            stored.data_json === row.data_json &&
            stored.updated_at === row.updated_at
          );
        }),
        'invalid_workflow_policy',
        message,
        500,
      );
    }
  }

  private requireActive(registration: Registration): void {
    check(
      this.registrations.get(
        `${registration.definition.name}@${registration.definition.version}`,
      ) === registration,
      'workflow_unavailable',
      'The workflow registration has been disposed',
      503,
    );
  }

  /** The response a request recorded: a snapshot for a command, `{id, status}` for a grant. */
  private async replay<T>(
    tx: Transaction,
    projectId: string,
    requestId: string,
    hash: string,
  ): Promise<T | undefined> {
    const row = await tx.get<{ fingerprint: string; response_json: string }>(
      'SELECT fingerprint, response_json FROM wf_requests WHERE project_id = ? AND request_id = ?',
      projectId,
      requestId,
    );
    if (!row) return undefined;
    check(
      row.fingerprint === hash,
      'request_conflict',
      'Request id was already used for a different workflow command',
      409,
    );
    return JSON.parse(row.response_json) as T;
  }

  /**
   * The event says whether the move ended the work and whether it ended well, as the version
   * pins them, so a consumer that acts only on ended work reads nothing for any other move.
   */
  private async record(
    tx: Transaction,
    caller: Caller,
    registration: Registration,
    snapshot: WorkflowSnapshot,
    requestId: string,
    hash: string,
    action: string,
    from: string | null,
    data: Data,
    eventData: Data = {},
  ): Promise<void> {
    await tx.run(
      'INSERT INTO wf_requests (project_id, request_id, fingerprint, response_json) VALUES (?, ?, ?, ?)',
      caller.projectId,
      requestId,
      hash,
      canonical(snapshot),
    );
    await tx.run(
      'INSERT INTO wf_history (instance_id, project_id, revision, action, actor_id, request_id, from_state, to_state, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      snapshot.id,
      caller.projectId,
      snapshot.revision,
      action,
      caller.actorId,
      requestId,
      from,
      snapshot.state,
      canonical(data),
      snapshot.updatedAt,
    );
    await recorded(this.state, tx, caller, 'workflow.transition', snapshot.id, {
      ...eventData,
      workflow: snapshot.workflow,
      version: snapshot.version,
      revision: snapshot.revision,
      action,
      from,
      to: snapshot.state,
      terminal: registration.definition.terminal.includes(snapshot.state),
      settled: registration.policy?.successStates?.includes(snapshot.state) ?? false,
    });
  }

  private async readRow(sql: Sql, projectId: string, instanceId: string): Promise<InstanceRow> {
    const row = await sql.get<InstanceRow>(
      'SELECT * FROM wf_instances WHERE id = ? AND project_id = ?',
      instanceId,
      projectId,
    );
    check(row, 'not_found', 'Workflow instance not found', 404);
    return row;
  }

  private async readSnapshot(
    sql: Sql,
    projectId: string,
    instanceId: string,
  ): Promise<WorkflowSnapshot> {
    return this.snapshot(await this.readRow(sql, projectId, instanceId));
  }

  private snapshot(row: InstanceRow): WorkflowSnapshot {
    return {
      id: row.id,
      projectId: row.project_id,
      workflow: row.workflow,
      version: row.version,
      state: row.state,
      revision: row.revision,
      data: JSON.parse(row.data_json) as Data,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private requestId(value: string): void {
    check(
      typeof value === 'string' && visible(value) && value.length <= 256,
      'invalid_request',
      'A nonblank request id of 1–256 characters is required',
    );
  }

  /** The one validator for start data, transition data and input, and preflight input. */
  private data(value?: Data): Data {
    const data = workflowJson(value ?? {}, 'invalid_data', 400, DATA_LIMITS);
    check(
      typeof data === 'object' && data !== null && !Array.isArray(data),
      'invalid_data',
      'Workflow data must be a JSON object',
    );
    return data;
  }

  close(): void {
    this.closed = true;
    this.registrations.clear();
  }

  private assertOpen(): void {
    check(!this.closed, 'workflow_unavailable', 'The workflow service has been disposed', 503);
  }
}

export const workflowsPlugin = {
  name: 'merv-workflows',
  inject: ['state', 'scope'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const workflows = await createService(new WorkflowsService(ctx.state, ctx.scope));
      yield () => workflows.close();
      yield ctx.provide('workflows', workflows);
    });
  },
};

export default workflowsPlugin;
