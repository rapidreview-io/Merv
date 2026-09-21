import { visible, recorded, createService } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import {
  check,
  effectiveWorkspace,
  inTransaction,
  mapAsync,
  MervError,
  newId,
  now,
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
  WorkflowUpgrade,
  WorkflowPolicy,
  WorkflowEvaluationInput,
  WorkflowDecision,
  WorkflowOverview,
  WorkflowAddDependencies,
  WorkflowAssignment,
  WorkflowBegin,
  WorkflowWorkStart,
  WorkflowExecution,
  WorkflowExecutionTarget,
  WorkflowExecutionDispatch,
  WorkflowDispatchAdmission,
  WorkflowDispatchCandidate,
  WorkflowLease,
  WorkflowLeaseOffer,
  WorkflowReadReferences,
  WorkflowExecutionReferences,
  WorkflowCheckContext,
  WorkflowHistoryEntry,
  WorkflowExtendLimit,
  WorkflowLimitStatus,
  WorkflowProvidedBlocker,
  WorkflowProvidedBlockerInput,
  WorkflowProviderRelations,
  ProcessGraph,
} from '@merv/contracts';
import { processGraph } from './process.js';
import { clearBlockers, providerRelations, readBlockers, replaceBlockers } from './blockers.js';
import { workflowJson } from './json.js';
import { canonical, fingerprint, validateDefinition } from './definition.js';
import {
  checkAssignment,
  decision,
  enforceAction,
  readContext,
  validatePolicy,
} from './evaluation.js';
import { buildAssignment, readWorkStarts } from './assignments.js';
import { limitFor, limitMessage, limitStatus, limitStatuses } from './limits.js';
import {
  admitDispatch,
  dispatchInput,
  executionDisplay,
  executionFingerprint,
  executionReferences,
  persistExecution,
  executionMetadata,
} from './execution.js';
import {
  attachDependencies,
  detachDependencies,
  normalizeDependencies,
  persistSuccess,
  relations,
  requireDependencies,
} from './dependencies.js';

const migrations = [
  {
    version: 1,
    postgres: postgresMigrations[1],
    sql: `
  CREATE TABLE wf_definitions (
    name TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0),
    fingerprint TEXT NOT NULL, definition_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (name, version)
  );
  CREATE TABLE wf_instances (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workflow TEXT NOT NULL,
    version INTEGER NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0),
    data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY (workflow, version) REFERENCES wf_definitions(name, version)
  );
  CREATE INDEX wf_instances_project ON wf_instances(project_id, created_at, id);
  CREATE TABLE wf_requests (
    project_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    response_json TEXT NOT NULL, PRIMARY KEY (project_id, request_id)
  );
  CREATE TABLE wf_history (
    instance_id TEXT NOT NULL REFERENCES wf_instances(id), project_id TEXT NOT NULL,
    revision INTEGER NOT NULL, action TEXT NOT NULL, actor_id TEXT NOT NULL,
    request_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
    data_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (instance_id, revision)
  );
`,
  },
  {
    version: 2,
    postgres: postgresMigrations[2],
    sql: `
  CREATE TABLE wf_success_states (
    workflow TEXT NOT NULL, version INTEGER NOT NULL, success_json TEXT NOT NULL,
    PRIMARY KEY (workflow,version),
    FOREIGN KEY (workflow,version) REFERENCES wf_definitions(name,version)
  );
  CREATE TABLE wf_dependencies (
    project_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
    target_workflow TEXT NOT NULL, target_version INTEGER NOT NULL,
    target_success_json TEXT NOT NULL, target_terminal_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_id,target_id), CHECK (source_id <> target_id)
  );
  CREATE INDEX wf_dependencies_source ON wf_dependencies(project_id,source_id);
  CREATE INDEX wf_dependencies_target ON wf_dependencies(project_id,target_id);
`,
  },
  {
    version: 3,
    postgres: postgresMigrations[3],
    sql: `
  CREATE TABLE wf_work_starts (
    instance_id TEXT NOT NULL REFERENCES wf_instances(id), project_id TEXT NOT NULL,
    workflow TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0), actor_id TEXT NOT NULL,
    started_at TEXT NOT NULL, event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),
    PRIMARY KEY (instance_id,revision)
  );
  CREATE INDEX wf_work_starts_project ON wf_work_starts(project_id,instance_id,revision);
  CREATE TRIGGER wf_work_starts_no_update BEFORE UPDATE ON wf_work_starts
    BEGIN SELECT RAISE(ABORT,'Workflow work starts are immutable'); END;
  CREATE TRIGGER wf_work_starts_no_delete BEFORE DELETE ON wf_work_starts
    BEGIN SELECT RAISE(ABORT,'Workflow work starts are retained'); END;
`,
  },
  {
    version: 4,
    postgres: postgresMigrations[4],
    sql: `
  CREATE TABLE wf_execution_policies (
    workflow TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
    fingerprint TEXT NOT NULL, manifest_json TEXT NOT NULL,
    PRIMARY KEY(workflow,version,state),
    FOREIGN KEY(workflow,version) REFERENCES wf_definitions(name,version)
  );
  CREATE TRIGGER wf_execution_policies_no_update BEFORE UPDATE ON wf_execution_policies
    BEGIN SELECT RAISE(ABORT,'Workflow execution declarations are immutable'); END;
  CREATE TRIGGER wf_execution_policies_no_delete BEFORE DELETE ON wf_execution_policies
    BEGIN SELECT RAISE(ABORT,'Workflow execution declarations are retained'); END;
`,
  },
  {
    version: 5,
    postgres: postgresMigrations[5],
    sql: `
  CREATE TABLE wf_limit_grants (
    project_id TEXT NOT NULL, request_id TEXT NOT NULL,
    instance_id TEXT NOT NULL REFERENCES wf_instances(id), limit_name TEXT NOT NULL,
    additional INTEGER NOT NULL CHECK (additional > 0), reason TEXT NOT NULL,
    actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, request_id)
  );
  CREATE INDEX wf_limit_grants_instance ON wf_limit_grants(instance_id, limit_name);
  CREATE TRIGGER wf_limit_grants_no_update BEFORE UPDATE ON wf_limit_grants
    BEGIN SELECT RAISE(ABORT,'Workflow limit grants are immutable'); END;
  CREATE TRIGGER wf_limit_grants_no_delete BEFORE DELETE ON wf_limit_grants
    BEGIN SELECT RAISE(ABORT,'Workflow limit grants are retained'); END;
`,
  },
  {
    // The one workflow table that is rewritten and cleared: it mirrors what another plugin
    // thinks now, and must stay readable and clearable while that plugin is unloaded.
    version: 6,
    rebuild: true,
    postgres: postgresMigrations[6],
    sql: `
  CREATE TABLE wf_blockers (
    project_id TEXT NOT NULL, instance_id TEXT NOT NULL, provider TEXT NOT NULL,
    blocker_key TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL,
    status INTEGER NOT NULL CHECK (status BETWEEN 400 AND 599), next TEXT NOT NULL,
    related_json TEXT NOT NULL, since TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (instance_id,provider,blocker_key)
  );
  CREATE INDEX wf_blockers_project ON wf_blockers(project_id,provider);
  CREATE TRIGGER wf_blockers_identity BEFORE UPDATE OF project_id,instance_id,provider,blocker_key ON wf_blockers
    BEGIN SELECT RAISE(ABORT,'Workflow blocker identity is immutable'); END;

CREATE TEMP TABLE wf_dependencies_backup AS SELECT * FROM wf_dependencies;
DROP TABLE wf_dependencies;
CREATE TABLE wf_dependencies (
  project_id TEXT NOT NULL,source_id TEXT NOT NULL,target_id TEXT NOT NULL,
  target_workflow TEXT NOT NULL,target_version INTEGER NOT NULL,
  target_success_json TEXT NOT NULL,target_terminal_json TEXT NOT NULL,created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'declared' CHECK(kind IN ('declared','system')),
  owner TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(source_id,target_id,kind,owner),CHECK(source_id<>target_id),
  CHECK((kind='declared' AND owner='') OR (kind='system' AND owner<>''))
);
INSERT INTO wf_dependencies(project_id,source_id,target_id,target_workflow,target_version,target_success_json,target_terminal_json,created_at)
SELECT * FROM wf_dependencies_backup;
DROP TABLE wf_dependencies_backup;
CREATE INDEX wf_dependencies_source ON wf_dependencies(project_id,source_id);
CREATE INDEX wf_dependencies_target ON wf_dependencies(project_id,target_id);
CREATE TRIGGER wf_dependencies_identity BEFORE UPDATE ON wf_dependencies WHEN NEW.kind IS NOT OLD.kind OR NEW.owner IS NOT OLD.owner BEGIN SELECT RAISE(ABORT,'Dependency contracts are immutable'); END;
CREATE TABLE wf_system_requests(project_id TEXT NOT NULL,provider TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(project_id,provider,request_id));
CREATE TRIGGER wf_system_requests_no_update BEFORE UPDATE ON wf_system_requests BEGIN SELECT RAISE(ABORT,'System requests are immutable'); END;
CREATE TRIGGER wf_system_requests_no_delete BEFORE DELETE ON wf_system_requests BEGIN SELECT RAISE(ABORT,'System requests are retained'); END;`,
  },
];

/** The most instances one dependency closure is walked over. */
const closureLimit = 5000;

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
  token: symbol;
  registrationId: string;
}
export type { WorkflowHistoryEntry } from '@merv/contracts';

/** Durable graph engine. Domain programs enforce their own guards through managed handles. */
export class WorkflowsService implements Workflows {
  private readonly registrations = new Map<string, Registration>();
  private readonly readProviders = new Map<string, WorkflowReadReferences>();
  private closed = false;

  constructor(
    private readonly state: State,
    private readonly scope: Scope,
  ) {}

  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('workflows', migrations);
  }

  registerReadReferences(provider: WorkflowReadReferences): () => void {
    this.assertOpen();
    check(
      provider.id && typeof provider.resolve === 'function',
      'invalid_read_provider',
      'A read provider needs an ID and resolver',
    );
    check(
      !this.readProviders.has(provider.id),
      'read_provider_exists',
      'This read provider is already registered',
      409,
    );
    const registration = { ...provider };
    this.readProviders.set(provider.id, registration);
    return () => {
      if (this.readProviders.get(registration.id) === registration)
        this.readProviders.delete(registration.id);
    };
  }

  private async admitRead(
    caller: Caller,
    execution: WorkflowExecution,
    tool: string,
    input: Data,
    tx: Transaction,
    read?: boolean,
  ): Promise<WorkflowDispatchAdmission> {
    const registration = this.definition(execution.workflow, execution.version);
    check(
      registration.registrationId === execution.registrationId,
      'execution_changed',
      'The captured workflow registration has been withdrawn',
      409,
    );
    // The project overview is asked for by leaving the instance out. A fixed binding would
    // fill it in and answer for this worker's own record instead — a narrower question than
    // the one asked, and the only read a session cannot otherwise express.
    if (read && tool === 'workflow.status_and_next' && !Object.hasOwn(input, 'instanceId')) {
      await this.scope.require(caller, 'read', tx);
      return { tool, input: structuredClone(input) };
    }
    try {
      return admitDispatch(execution, tool, input);
    } catch (error) {
      if (!(error instanceof MervError)) throw error;
      // A session reads whatever its project holds (founder, 2026-09-17: no read
      // constraints). The policy still fills in what it names, so a read called as declared
      // is admitted as declared; one it does not name, or names differently, is admitted as
      // given, bounded by the project alone. Every write holds as published.
      if (
        read &&
        [
          'execution_tool_forbidden',
          'execution_arguments_forbidden',
          'execution_reference_unavailable',
        ].includes(error.code)
      ) {
        await this.scope.require(caller, 'read', tx);
        return { tool, input: structuredClone(input) };
      }
      // The fixed policy remains authoritative. A coordinator may supplement only
      // a denied resource read, never a tool grant, scalar binding or write.
      if (
        error.code !== 'execution_arguments_forbidden' ||
        !['artifact.get', 'artifact.read', 'review.get'].includes(tool)
      )
        throw error;
      const fields = new Set(
        execution.policy.tools
          .find((entry) => entry.name === tool)!
          .alternatives.flatMap((entry) =>
            Object.values(entry).flatMap((binding) =>
              binding.kind === 'oneOf' ? [binding.name] : [],
            ),
          ),
      );
      const references = executionMetadata(execution.references);
      const snapshot = await this.readSnapshot(tx, caller.projectId, execution.instanceId);
      const context = readContext({
        caller,
        snapshot,
        tx,
        dependencies: (await relations(tx, caller.projectId, snapshot.id)).dependencies,
      });
      const additions: {
        provider: WorkflowReadReferences;
        references: WorkflowExecutionReferences;
      }[] = [];
      // Snapshot registrations before yielding. New/replaced providers belong to the next request.
      for (const provider of [...this.readProviders.values()]) {
        if (this.readProviders.get(provider.id) !== provider) continue;
        const extra = executionMetadata(await provider.resolve(context, tool));
        if (extra && this.readProviders.get(provider.id) === provider)
          additions.push({ provider, references: extra });
      }
      await this.scope.require(caller, 'read', tx);
      const after = await this.readSnapshot(tx, caller.projectId, snapshot.id);
      this.requireActive(registration);
      check(
        canonical(after) === canonical(snapshot),
        'invalid_read_provider',
        'Read providers must not change the workflow instance',
        500,
      );
      for (const { provider, references: extra } of additions) {
        if (this.readProviders.get(provider.id) !== provider) continue;
        for (const [name, ids] of Object.entries(extra)) {
          if (!fields.has(name)) continue;
          check(
            Array.isArray(references[name]) &&
              Array.isArray(ids) &&
              ids.every((id) => typeof id === 'string' && id.length > 0),
            'invalid_read_provider',
            'Read providers may extend only declared resource arrays',
            500,
          );
          references[name] = [...new Set([...(references[name] as string[]), ...ids])];
        }
      }
      return admitDispatch({ ...execution, references }, tool, input);
    }
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
    const hash = fingerprint(definition);
    await this.state.transaction(async (tx) => {
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
    });
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
      token: Symbol(key),
      registrationId: newId('execution'),
    };
    this.registrations.set(key, registration);
    return {
      dispose: () => {
        if (this.registrations.get(key) === registration) this.registrations.delete(key);
      },
      start: async (caller, input, tx) => {
        this.requireActive(registration);
        check(
          input.workflow === definition.name &&
            (input.version === undefined || input.version === definition.version),
          'workflow_handle_mismatch',
          'The program handle only owns its registered workflow version',
        );
        return await this.startInternal(
          caller,
          { ...input, version: definition.version },
          tx,
          registration,
        );
      },
      transition: async (caller, input, tx) => {
        this.requireActive(registration);
        return await this.transitionInternal(caller, input, tx, registration);
      },
      upgrade: async (caller, input, tx) => {
        this.requireActive(registration);
        return await this.upgradeInternal(caller, input, registration, tx);
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

  /** Computed from records on every read; a stored copy could only drift from them. */
  async process(caller: Caller, instanceId: string): Promise<ProcessGraph> {
    this.assertOpen();
    caller = structuredClone(caller);
    const decision = await this.evaluate(caller, instanceId);
    const definition = this.catalog().find(
      (item) => item.name === decision.workflow && item.version === decision.version,
    );
    check(definition, 'workflow_unavailable', 'The pinned definition is unavailable', 503);
    const registration = this.registrations.get(`${decision.workflow}@${decision.version}`);
    const { dependencies, dependents } = await this.dependencies(caller, instanceId);
    return processGraph({
      definition,
      rules: registration?.policy?.actions ?? [],
      history: await this.history(caller, instanceId),
      decision,
      dependencies,
      dependents,
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
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const snapshot = await this.readSnapshot(tx, caller.projectId, instanceId);
      if (input && Object.hasOwn(input, 'expectedRevision'))
        check(
          input.expectedRevision === snapshot.revision,
          'revision_conflict',
          'Workflow changed; refresh guidance before acting',
          409,
        );
      const installed = this.registrations.get(`${snapshot.workflow}@${snapshot.version}`);
      const stored = await tx.get<{ definition_json: string }>(
        'SELECT definition_json FROM wf_definitions WHERE name=? AND version=?',
        snapshot.workflow,
        snapshot.version,
      );
      check(stored, 'workflow_unavailable', 'The pinned definition is unavailable', 503);
      const result = await decision(
        installed?.definition ?? JSON.parse(stored.definition_json),
        installed?.policy,
        readContext({
          caller,
          snapshot,
          tx,
          dependencies: (await relations(tx, caller.projectId, snapshot.id)).dependencies,
        }),
        { ...query, input },
        (await readWorkStarts(tx, caller.projectId, snapshot.id, snapshot.revision))[0] ?? null,
        await limitStatuses(tx, installed?.policy, snapshot),
        await readBlockers(tx, caller.projectId, snapshot.id),
      );
      if (installed) {
        await this.checkContext(
          { caller, snapshot, tx },
          'Guidance callbacks must not change the workflow instance',
        );
        this.requireActive(installed);
      } else {
        await this.scope.require(caller, 'read', tx);
        this.assertOpen();
      }
      return result;
    });
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
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(source, 'read', tx);
      check(!source.session, 'forbidden', 'A leased worker cannot schedule assignments', 403);
      // Only a state with a lease rule can be a candidate; finished work never is, and it is
      // most of a project's history.
      const leasable = [
        ...new Set(
          [...this.registrations.values()].flatMap((registration) =>
            (registration.policy?.assignments ?? [])
              .filter((rule) => rule.lease && rule.execution)
              .map((rule) => rule.state),
          ),
        ),
      ];
      if (!leasable.length) return [];
      const rows = await tx.all<InstanceRow>(
        `SELECT * FROM wf_instances WHERE project_id=? AND state IN (${leasable.map(() => '?').join(',')}) ORDER BY created_at,id`,
        source.projectId,
        ...leasable,
      );
      const candidates: WorkflowDispatchCandidate[] = [];
      for (const row of rows) {
        const snapshot = this.snapshot(row);
        const registration = this.registrations.get(`${snapshot.workflow}@${snapshot.version}`);
        const rule = registration?.policy?.assignments?.find(
          (rule) => rule.state === snapshot.state,
        );
        if (!registration || !rule?.lease || !rule.execution) continue;
        // A reviewer leased at an exhausted limit could only have a needs_changes verdict
        // refused and rolled back, and the next poll would lease another. The work waits for
        // a human instead, who may still begin it by hand.
        if ((await limitStatuses(tx, registration.policy, snapshot)).some((item) => item.exhausted))
          continue;
        try {
          const role = await this.leaseRole(
            source,
            { instanceId: snapshot.id, expectedRevision: snapshot.revision },
            tx,
          );
          const label = rule.lease.label
            ? await rule.lease.label(
                readContext({
                  caller: source,
                  snapshot,
                  tx,
                  dependencies: (await relations(tx, source.projectId, snapshot.id)).dependencies,
                }),
              )
            : `${snapshot.workflow}: ${snapshot.state}`;
          check(
            typeof label === 'string' && visible(label),
            'invalid_workflow_policy',
            'Dispatch labels must be nonempty',
            500,
          );
          await this.checkContext(
            { caller: source, snapshot, tx },
            'Dispatch callbacks must not change the workflow instance',
          );
          this.requireActive(registration);
          if (
            worker &&
            rule.lease.excludes &&
            (await rule.lease.excludes(readContext({ caller: source, snapshot, tx }), worker))
          )
            continue;
          candidates.push({
            instanceId: snapshot.id,
            projectId: source.projectId,
            expectedRevision: snapshot.revision,
            workflow: snapshot.workflow,
            version: snapshot.version,
            state: snapshot.state,
            role,
            readOnly: rule.execution.readOnly,
            label,
            policyHash: executionFingerprint(rule.execution),
            registrationId: registration.registrationId,
            workspace: effectiveWorkspace(rule.execution),
            updatedAt: snapshot.updatedAt,
          });
        } catch (error) {
          // Domain admission refusals make a node ineligible. Malformed programs fail visibly.
          if (!(error instanceof MervError) || ![403, 404, 409, 503].includes(error.status))
            throw error;
        }
        await this.scope.require(source, 'read', tx);
      }
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
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(source, 'read', tx);
      const snapshot = await this.readSnapshot(tx, source.projectId, target.instanceId);
      check(
        snapshot.revision === target.expectedRevision,
        'revision_conflict',
        'Workflow changed before lease admission',
        409,
      );
      const registration = this.definition(snapshot.workflow, snapshot.version);
      check(
        !registration.definition.terminal.includes(snapshot.state),
        'workflow_ended',
        `This work has ended as ${snapshot.state}; it takes no lease`,
        409,
      );
      const rule = registration.policy?.assignments?.find((rule) => rule.state === snapshot.state);
      check(
        rule?.lease && rule.execution,
        'lease_unavailable',
        'This assignment does not support leases',
        409,
      );
      const dependencies = (await relations(tx, source.projectId, snapshot.id)).dependencies;
      if (rule.requiresDependencies) requireDependencies(dependencies);
      const role = await rule.lease.role(
        readContext({ caller: source, snapshot, tx, dependencies }),
      );
      check(
        ['reader', 'producer', 'reviewer', 'operator'].includes(role),
        'invalid_workflow_policy',
        'Lease role must be declared',
        500,
      );
      await this.checkContext(
        { caller: source, snapshot, tx },
        'Lease role callbacks must not change the workflow instance',
      );
      this.requireActive(registration);
      return role;
    });
  }

  async offerLease(
    source: Caller,
    worker: Caller,
    { ...target }: WorkflowExecutionTarget & { leaseId: string },
    transaction?: Transaction,
  ): Promise<WorkflowLeaseOffer> {
    ({ source, worker } = structuredClone({ source, worker }));
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(source, 'read', tx);
      await this.scope.require(worker, 'read', tx);
      const role = await this.leaseRole(source, target, tx);
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
      const snapshot = await this.readSnapshot(tx, worker.projectId, target.instanceId);
      check(
        snapshot.revision === target.expectedRevision,
        'revision_conflict',
        'Workflow changed before lease offer',
        409,
      );
      const registration = this.definition(snapshot.workflow, snapshot.version);
      const rule = registration.policy?.assignments?.find((rule) => rule.state === snapshot.state);
      check(
        rule?.lease && rule.execution,
        'lease_unavailable',
        'This assignment does not support leases',
        409,
      );
      const context = readContext({
        caller: worker,
        snapshot,
        tx,
        dependencies: (await relations(tx, worker.projectId, snapshot.id)).dependencies,
      });
      const receipt = executionMetadata(
        await rule.lease.acquire(
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
      const execution = await this.execution(worker, target, tx);
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
      await rule.lease.check(context, structuredClone(receipt));
      const assignment = await this.assignment(worker, snapshot.id, tx);
      await this.scope.require(source, 'read', tx);
      await this.checkContext(context, 'Lease acquisition must not transition the workflow');
      this.requireActive(registration);
      return { lease, assignment, execution };
    });
  }

  async checkLease(
    worker: Caller,
    lease: WorkflowLease,
    transaction?: Transaction,
  ): Promise<WorkflowExecution> {
    worker = structuredClone(worker);
    lease = workflowJson(lease, 'invalid_lease', 400);
    return await inTransaction(this.state, transaction, async (tx) => {
      check(
        worker.actorId === lease.actorId &&
          worker.projectId === lease.projectId &&
          worker.session?.id === lease.leaseId,
        'invalid_lease',
        'Lease belongs to a different worker',
        403,
      );
      const target = {
        instanceId: lease.instanceId,
        expectedRevision: lease.expectedRevision,
        policyHash: lease.policyHash,
      };
      const execution = await this.executionInternal(worker, target, tx);
      check(
        execution.workflow === lease.workflow &&
          execution.version === lease.version &&
          execution.state === lease.state,
        'lease_changed',
        'Lease no longer names this workflow state',
        409,
      );
      const registration = this.definition(lease.workflow, lease.version);
      const rule = registration.policy?.assignments?.find((rule) => rule.state === lease.state);
      check(rule?.lease, 'lease_unavailable', 'This assignment no longer supports leases', 409);
      await rule.lease.check(
        readContext({
          caller: worker,
          snapshot: await this.readSnapshot(tx, worker.projectId, lease.instanceId),
          tx,
          dependencies: (await relations(tx, worker.projectId, lease.instanceId)).dependencies,
        }),
        executionMetadata(lease.receipt),
      );
      const checked = await this.executionInternal(worker, target, tx);
      this.requireActive(registration);
      return checked;
    });
  }

  async activateLease(
    worker: Caller,
    lease: WorkflowLease,
    transaction?: Transaction,
  ): Promise<WorkflowWorkStart> {
    worker = structuredClone(worker);
    lease = workflowJson(lease, 'invalid_lease', 400);
    return await inTransaction(this.state, transaction, async (tx) => {
      const execution = await this.checkLease(worker, lease, tx);
      const registration = this.definition(lease.workflow, lease.version);
      check(
        registration.registrationId === execution.registrationId,
        'execution_changed',
        'The workflow registration changed before activation',
        409,
      );
      const started = await this.markStarted(
        worker,
        await this.readSnapshot(tx, worker.projectId, lease.instanceId),
        tx,
      );
      this.requireActive(registration);
      return started;
    });
  }

  async authorizeLeaseDispatch(
    worker: Caller,
    lease: WorkflowLease,
    frozen: WorkflowExecution,
    { ...input }: { tool: string; input: Data; read?: boolean },
    transaction?: Transaction,
  ): Promise<WorkflowDispatchAdmission> {
    worker = structuredClone(worker);
    lease = workflowJson(lease, 'invalid_lease', 400);
    frozen = workflowJson(frozen, 'invalid_execution_target', 400);
    input.input = dispatchInput(input.input);
    return await inTransaction(this.state, transaction, async (tx) => {
      const current = await this.checkLease(worker, lease, tx);
      check(
        frozen.instanceId === lease.instanceId &&
          frozen.projectId === lease.projectId &&
          frozen.actorId === lease.actorId &&
          frozen.workflow === lease.workflow &&
          frozen.version === lease.version &&
          frozen.state === lease.state &&
          frozen.revision === lease.expectedRevision &&
          frozen.policyHash === lease.policyHash &&
          executionFingerprint(frozen.policy) === lease.policyHash &&
          frozen.registrationId === current.registrationId,
        'execution_changed',
        'Frozen dispatch authority does not match this active lease invocation',
        409,
      );
      const registration = this.definition(lease.workflow, lease.version);
      const rule = registration.policy!.assignments!.find((rule) => rule.state === lease.state)!;
      const snapshot = await this.readSnapshot(tx, worker.projectId, lease.instanceId);
      const references = executionMetadata(frozen.references);
      if (rule.lease!.outputs) {
        const extra = executionMetadata(
          await rule.lease!.outputs(
            readContext({
              caller: worker,
              snapshot: await this.readSnapshot(tx, worker.projectId, lease.instanceId),
              tx,
              dependencies: (await relations(tx, worker.projectId, lease.instanceId)).dependencies,
            }),
            executionMetadata(lease.receipt),
          ),
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
      await this.checkContext(
        { caller: worker, snapshot, tx },
        'Lease output callbacks must not change the workflow instance',
      );
      this.requireActive(registration);
      return await this.admitRead(
        worker,
        { ...frozen, references },
        input.tool,
        input.input,
        tx,
        input.read,
      );
    });
  }

  async releaseLease(
    lease: WorkflowLease,
    { ...input }: { reason: string },
    transaction?: Transaction,
  ): Promise<void> {
    lease = executionMetadata(lease);
    await inTransaction(this.state, transaction, async (tx) => {
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

  async execution(
    caller: Caller,
    target: WorkflowExecutionTarget,
    transaction?: Transaction,
  ): Promise<WorkflowExecution> {
    return await this.executionInternal(caller, target, transaction);
  }

  async authorizeDispatch(
    caller: Caller,
    { ...dispatch }: WorkflowExecutionDispatch,
    transaction?: Transaction,
  ): Promise<WorkflowDispatchAdmission> {
    caller = structuredClone(caller);
    check(
      typeof dispatch.policyHash === 'string' &&
        /^[0-9a-f]{64}$/.test(dispatch.policyHash) &&
        typeof dispatch.registrationId === 'string' &&
        dispatch.registrationId.length > 0 &&
        typeof dispatch.tool === 'string' &&
        dispatch.tool.length > 0,
      'invalid_execution_target',
      'A captured policy hash, registration generation and tool are required',
    );
    dispatch.input = dispatchInput(dispatch.input);
    return await inTransaction(this.state, transaction, async (tx) => {
      const execution = await this.executionInternal(caller, dispatch, tx);
      return await this.admitRead(
        caller,
        execution,
        dispatch.tool,
        dispatch.input,
        tx,
        dispatch.read,
      );
    });
  }

  private async executionInternal(
    caller: Caller,
    {
      ...target
    }: WorkflowExecutionTarget &
      Partial<Pick<WorkflowExecutionDispatch, 'registrationId' | 'policyHash'>>,
    transaction?: Transaction,
  ): Promise<WorkflowExecution> {
    caller = structuredClone(caller);
    this.assertOpen();
    check(
      typeof target.instanceId === 'string' && target.instanceId.length > 0,
      'invalid_instance',
      'Workflow instance id is required',
    );
    check(
      Number.isSafeInteger(target.expectedRevision) && target.expectedRevision >= 0,
      'invalid_revision',
      'Expected revision must be a nonnegative integer',
    );
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const snapshot = await this.readSnapshot(tx, caller.projectId, target.instanceId);
      if (snapshot.revision !== target.expectedRevision) {
        // The record moved by this caller's own hand: its handoff landed, and a second copy of
        // the same call has nothing left to do.
        const moved = caller.session
          ? await tx.get<{ actor_id: string }>(
              'SELECT actor_id FROM wf_history WHERE instance_id=? AND revision=?',
              target.instanceId,
              target.expectedRevision + 1,
            )
          : undefined;
        check(
          moved?.actor_id !== caller.actorId,
          'session_completed',
          'Your handoff already moved this record; this session has ended',
          409,
        );
        check(
          false,
          'revision_conflict',
          'Workflow changed; refresh execution metadata before dispatch',
          409,
        );
      }
      const registration = this.definition(snapshot.workflow, snapshot.version);
      check(
        !registration.definition.terminal.includes(snapshot.state),
        'workflow_ended',
        'This workflow has ended; it has no execution authority',
        409,
      );
      const rule = registration.policy?.assignments?.find((rule) => rule.state === snapshot.state);
      check(
        rule?.execution,
        'execution_unavailable',
        'No fixed execution policy is registered for this workflow state',
        409,
      );
      const policyHash = executionFingerprint(rule.execution);
      check(
        target.registrationId === undefined ||
          target.registrationId === registration.registrationId,
        'execution_changed',
        'The captured workflow registration has been withdrawn',
        409,
      );
      check(
        target.policyHash === undefined || target.policyHash === policyHash,
        'execution_changed',
        'The captured execution policy does not match this workflow state',
        409,
      );
      const context = readContext({
        caller,
        snapshot,
        tx,
        dependencies: (await relations(tx, caller.projectId, snapshot.id)).dependencies,
      });
      await checkAssignment(rule, context);
      const references = await executionReferences(rule, context);
      await this.checkContext(context, 'Execution callbacks must not change the workflow instance');
      this.requireActive(registration);
      return {
        instanceId: snapshot.id,
        projectId: caller.projectId,
        actorId: caller.actorId,
        workflow: snapshot.workflow,
        version: snapshot.version,
        state: snapshot.state,
        revision: snapshot.revision,
        policyHash,
        registrationId: registration.registrationId,
        policy: structuredClone(rule.execution),
        references,
      };
    });
  }

  async begin(caller: Caller, input: WorkflowBegin, tx?: Transaction): Promise<WorkflowAssignment> {
    check(
      Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
      'invalid_revision',
      'Expected revision must be a nonnegative integer',
    );
    return await this.assignmentInternal(caller, input.instanceId, input.expectedRevision, tx);
  }

  async workStarts(
    caller: Caller,
    instanceId: string,
    transaction?: Transaction,
  ): Promise<WorkflowWorkStart[]> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
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
    const previous = (
      await readWorkStarts(tx, caller.projectId, snapshot.id, snapshot.revision)
    )[0];
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
    check(
      typeof instanceId === 'string' && instanceId.length > 0,
      'invalid_instance',
      'Workflow instance id is required',
    );
    return await inTransaction(this.state, transaction, async (tx) => {
      // Domain policy owns write/review admission; the engine always fences tenancy.
      await this.scope.require(caller, 'read', tx);
      const snapshot = await this.readSnapshot(tx, caller.projectId, instanceId);
      if (expectedRevision !== undefined)
        check(
          snapshot.revision === expectedRevision,
          'revision_conflict',
          `Expected revision ${expectedRevision}, found ${snapshot.revision}`,
          409,
        );
      const registration = this.definition(snapshot.workflow, snapshot.version);
      check(
        !registration.definition.terminal.includes(snapshot.state),
        'workflow_ended',
        'This workflow has ended; it has no active assignment',
        409,
      );
      const rule = registration.policy?.assignments?.find((item) => item.state === snapshot.state);
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
        dependencies: (await relations(tx, caller.projectId, instanceId)).dependencies,
      });
      await checkAssignment(rule, context);
      const workStart =
        expectedRevision !== undefined
          ? await this.markStarted(caller, snapshot, tx)
          : ((await readWorkStarts(tx, caller.projectId, instanceId, snapshot.revision))[0] ??
            null);
      // A context provider may read guidance. It must see the marker this call is committing.
      const content = await buildAssignment(rule, context);
      if (rule.execution)
        content.execution = executionDisplay(
          await this.execution(
            caller,
            {
              instanceId,
              expectedRevision: snapshot.revision,
            },
            tx,
          ),
        );
      await this.checkContext(
        context,
        'Assignment callbacks must not change the workflow instance',
      );
      this.requireActive(registration);
      return {
        ...content,
        instanceId,
        projectId: caller.projectId,
        actorId: caller.actorId,
        workflow: snapshot.workflow,
        version: snapshot.version,
        state: snapshot.state,
        revision: snapshot.revision,
        workStart,
      };
    });
  }

  async overview(caller: Caller): Promise<WorkflowOverview> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const rows = await tx.all<{ id: string }>(
        'SELECT id FROM wf_instances WHERE project_id=? ORDER BY created_at,id',
        caller.projectId,
      );
      const workflows = await mapAsync(
        rows,
        async (row) => await this.evaluate(caller, row.id, {}, tx),
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
    check(
      typeof input.instanceId === 'string' && input.instanceId.length > 0,
      'invalid_instance',
      'Workflow instance id is required',
    );
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
    const hash = fingerprint({
      operation: 'extend_limit',
      actorId: caller.actorId,
      instanceId: input.instanceId,
      limit: input.limit,
      additional: input.additional,
      reason,
    });
    return await inTransaction(this.state, transaction, async (tx) => {
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
      if (await this.replay(tx, caller.projectId, input.requestId, hash)) {
        this.requireActive(registered);
        return await limitStatus(tx, limit, snapshot.id);
      }
      check(
        !registered.definition.terminal.includes(snapshot.state),
        'invalid_transition',
        'Terminal workflow instances cannot be allowed more rounds',
        409,
      );
      // The grant has its own record. An owner's optional resume writes its own transition
      // receipt, so retrying this request cannot advance suspended work twice.
      await tx.run(
        'INSERT INTO wf_requests (project_id,request_id,fingerprint,response_json) VALUES (?,?,?,?)',
        caller.projectId,
        input.requestId,
        hash,
        canonical(snapshot),
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
    tx: Transaction,
  ): Promise<WorkflowLimitStatus> {
    await this.scope.require(caller, 'read', tx);
    const snapshot = await this.readSnapshot(tx, caller.projectId, instanceId);
    const limit = this.definition(snapshot.workflow, snapshot.version).policy?.limits?.find(
      (item) => item.name === name,
    );
    check(limit, 'unknown_limit', 'This workflow has no such limit', 404);
    return await limitStatus(tx, limit, instanceId);
  }

  async dependencies(
    caller: Caller,
    instanceId: string,
    transaction?: Transaction,
  ): ReturnType<Workflows['dependencies']> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.readSnapshot(tx, caller.projectId, instanceId);
      return await relations(tx, caller.projectId, instanceId);
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
    const snapshot = await this.readSnapshot(tx, input.projectId, input.instanceId);
    const stored = await tx.get<{ definition_json: string }>(
      'SELECT definition_json FROM wf_definitions WHERE name=? AND version=?',
      snapshot.workflow,
      snapshot.version,
    );
    check(stored, 'workflow_unavailable', 'The pinned definition is unavailable', 503);
    await replaceBlockers(
      tx,
      input,
      (JSON.parse(stored.definition_json) as WorkflowDefinition).terminal.includes(snapshot.state),
    );
  }

  async blockers(
    caller: Caller,
    instanceId?: string,
    transaction?: Transaction,
  ): Promise<WorkflowProvidedBlocker[]> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      if (instanceId !== undefined) await this.readSnapshot(tx, caller.projectId, instanceId);
      return await readBlockers(tx, caller.projectId, instanceId);
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
        check(
          typeof input.requestId === 'string' && input.requestId.trim().length > 0,
          'invalid_request',
          'A requestId is required',
        );
        const fingerprint = canonical({
          instanceId: input.instanceId,
          dependencies: [...new Set(input.dependencies)].sort(),
        });
        const previous = await tx.get<{ fingerprint: string }>(
          'SELECT fingerprint FROM wf_system_requests WHERE project_id=? AND provider=? AND request_id=?',
          input.projectId,
          provider,
          input.requestId,
        );
        check(
          !previous || previous.fingerprint === fingerprint,
          'idempotency_conflict',
          'System prerequisite request changed',
          409,
        );
        if (previous) return;
        const source = await this.readSnapshot(tx, input.projectId, input.instanceId);
        const old = await tx.all<{ target_id: string }>(
          "SELECT target_id FROM wf_dependencies WHERE project_id=? AND source_id=? AND kind='system' AND owner=?",
          input.projectId,
          input.instanceId,
          provider,
        );
        await attachDependencies(tx, source, input.dependencies, provider);
        for (const edge of old)
          if (!input.dependencies.includes(edge.target_id))
            await tx.run(
              "DELETE FROM wf_dependencies WHERE project_id=? AND source_id=? AND target_id=? AND kind='system' AND owner=?",
              input.projectId,
              input.instanceId,
              edge.target_id,
              provider,
            );
        await tx.run(
          'INSERT INTO wf_system_requests(project_id,provider,request_id,fingerprint) VALUES (?,?,?,?)',
          input.projectId,
          provider,
          input.requestId,
          fingerprint,
        );
      },
    };
  }

  async dependencyRelations(
    projectId: string,
    instanceId: string,
    tx: Transaction,
  ): Promise<WorkflowProviderRelations | null> {
    this.assertOpen();
    return await providerRelations(tx, projectId, instanceId);
  }

  async checkDependencies(caller: Caller, instanceId: string, tx?: Transaction): Promise<void> {
    requireDependencies((await this.dependencies(caller, instanceId, tx)).dependencies);
  }

  /** The provider freezes these roots before later dependencies can move a shared charge. */
  async sponsoringRoots(
    projectId: string,
    instanceIds: string[],
    tx: Transaction,
  ): Promise<string[]> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    const caller = await this.scope.serviceActor('workflows', projectId, tx);
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
    for (const row of await tx.all<{ id: string; workflow: string; version: number }>(
      'SELECT id,workflow,version FROM wf_instances WHERE project_id=?',
      projectId,
    ))
      for (const child of (await this.registrations
        .get(`${row.workflow}@${row.version}`)
        ?.policy?.children?.({ caller, instanceId: row.id, tx })) ?? [])
        link(child, row.id);
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
   * A walk rather than a recursive query, like the cycle check beside the dependency insert:
   * it reads the same on both backends, and it can ask each loaded policy for the children
   * that no dependency edge names. The bound keeps a pathological graph from holding a
   * read open; the caller reports how many instances it was given.
   */
  async dependencyClosure(
    caller: Caller,
    instanceId: string,
    transaction?: Transaction,
  ): Promise<string[]> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.readSnapshot(tx, caller.projectId, instanceId);
      const frontier = [instanceId],
        seen = new Set<string>();
      while (frontier.length && seen.size < closureLimit) {
        const current = frontier.pop()!;
        if (seen.has(current)) continue;
        const row = await tx.get<{ workflow: string; version: number }>(
          'SELECT workflow,version FROM wf_instances WHERE id=? AND project_id=?',
          current,
          caller.projectId,
        );
        if (!row) continue;
        seen.add(current);
        frontier.push(
          ...(
            await tx.all<{ target_id: string }>(
              'SELECT target_id FROM wf_dependencies WHERE project_id=? AND source_id=?',
              caller.projectId,
              current,
            )
          ).map((item) => item.target_id),
          ...((await this.registrations
            .get(`${row.workflow}@${row.version}`)
            ?.policy?.children?.({ caller, instanceId: current, tx })) ?? []),
        );
      }
      return [...seen];
    });
  }

  async start(caller: Caller, input: WorkflowStart, tx?: Transaction): Promise<WorkflowSnapshot> {
    return await this.startInternal(caller, input, tx);
  }

  async transition(
    caller: Caller,
    input: WorkflowTransition,
    tx?: Transaction,
  ): Promise<WorkflowSnapshot> {
    return await this.transitionInternal(caller, input, tx);
  }

  async get(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowSnapshot> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await inTransaction(this.state, tx, async (transaction) => {
      await this.scope.require(caller, 'read', transaction);
      return await this.readSnapshot(transaction, caller.projectId, instanceId);
    });
  }

  async list(caller: Caller): Promise<WorkflowSnapshot[]> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return (
        await tx.all<InstanceRow>(
          'SELECT * FROM wf_instances WHERE project_id = ? ORDER BY created_at, id',
          caller.projectId,
        )
      ).map(this.snapshot);
    });
  }

  async history(caller: Caller, instanceId: string): Promise<WorkflowHistoryEntry[]> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.readSnapshot(tx, caller.projectId, instanceId);
      return (
        await tx.all<{
          instance_id: string;
          revision: number;
          action: string;
          actor_id: string;
          request_id: string;
          from_state: string | null;
          to_state: string;
          data_json: string;
          created_at: string;
        }>(
          'SELECT * FROM wf_history WHERE project_id = ? AND instance_id = ? ORDER BY revision',
          caller.projectId,
          instanceId,
        )
      ).map((row) => ({
        instanceId: row.instance_id,
        revision: row.revision,
        action: row.action,
        actorId: row.actor_id,
        requestId: row.request_id,
        fromState: row.from_state,
        toState: row.to_state,
        data: JSON.parse(row.data_json) as Data,
        createdAt: row.created_at,
      }));
    });
  }

  private async startInternal(
    caller: Caller,
    { ...input }: WorkflowStart,
    tx?: Transaction,
    owner?: Registration,
  ): Promise<WorkflowSnapshot> {
    this.assertOpen();
    caller = structuredClone(caller);
    this.requestId(input.requestId);
    check(
      typeof input.workflow === 'string' && input.workflow.length > 0,
      'invalid_workflow',
      'Workflow name is required',
    );
    check(
      input.version === undefined || (Number.isSafeInteger(input.version) && input.version > 0),
      'invalid_version',
      'Workflow version must be a positive integer',
    );
    const data = this.data(input.data);
    const dependsOn = normalizeDependencies(input.dependsOn);
    const hash = fingerprint({
      operation: 'start',
      actorId: caller.actorId,
      workflow: input.workflow,
      version: input.version ?? null,
      data,
      ...(input.dependsOn === undefined ? {} : { dependsOn }),
    });
    return await inTransaction(this.state, tx, async (transaction) => {
      // Managed programs authorize their own commands, including reviewer-triggered repair.
      await this.scope.require(caller, owner?.definition.managed ? 'read' : 'write', transaction);
      const replay = await this.replay(transaction, caller.projectId, input.requestId, hash);
      if (replay) {
        await this.checkOwnerForSnapshot(replay, owner, transaction);
        if (owner) this.requireActive(owner);
        return replay;
      }
      const registered = this.definition(input.workflow, input.version);
      this.checkOwner(registered, owner);
      const blocker = await transaction.get<{ id: string; workflow: string }>(
        transaction.dialect === 'postgres'
          ? `SELECT w.id,w.workflow FROM wf_instances w
         JOIN wf_definitions d ON d.name=w.workflow AND d.version=w.version
         WHERE w.project_id=?
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(d.definition_json::jsonb #> '{blocksStarts}') AS selected(value) WHERE value=?)
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(d.definition_json::jsonb #> '{terminal}') AS selected(value) WHERE value=w.state)
         LIMIT 1`
          : `SELECT w.id,w.workflow FROM wf_instances w
         JOIN wf_definitions d ON d.name=w.workflow AND d.version=w.version
         WHERE w.project_id=?
           AND EXISTS (SELECT 1 FROM json_each(d.definition_json,'$.blocksStarts') WHERE value=?)
           AND NOT EXISTS (SELECT 1 FROM json_each(d.definition_json,'$.terminal') WHERE value=w.state)
         LIMIT 1`,
        caller.projectId,
        registered.definition.name,
      );
      check(
        !blocker,
        'workflow_creation_paused',
        `New ${registered.definition.name} work is paused while ${blocker?.workflow} ${blocker?.id} is active. Existing work may continue.`,
        409,
      );
      const time = now();
      const snapshot: WorkflowSnapshot = {
        id: newId('wf'),
        projectId: caller.projectId,
        workflow: registered.definition.name,
        version: registered.definition.version,
        state: registered.definition.initial,
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
      await attachDependencies(transaction, snapshot, dependsOn);
      await this.record(
        transaction,
        caller,
        snapshot,
        input.requestId,
        hash,
        'start',
        null,
        data,
        dependsOn.length ? { dependsOn } : {},
      );
      this.requireActive(registered);
      return snapshot;
    });
  }

  private async transitionInternal(
    caller: Caller,
    { ...input }: WorkflowTransition,
    tx?: Transaction,
    owner?: Registration,
  ): Promise<WorkflowSnapshot> {
    this.assertOpen();
    caller = structuredClone(caller);
    this.requestId(input.requestId);
    check(
      typeof input.instanceId === 'string' && input.instanceId.length > 0,
      'invalid_instance',
      'Workflow instance id is required',
    );
    check(
      typeof input.action === 'string' && input.action.length > 0,
      'invalid_action',
      'Workflow action is required',
    );
    check(
      Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
      'invalid_revision',
      'Expected revision must be a nonnegative integer',
    );
    const data = this.data(input.data);
    const proposed = input.input === undefined ? undefined : this.data(input.input);
    const hash = fingerprint({
      operation: 'transition',
      actorId: caller.actorId,
      instanceId: input.instanceId,
      action: input.action,
      expectedRevision: input.expectedRevision,
      data,
      ...(proposed === undefined ? {} : { input: proposed }),
    });
    return await inTransaction(this.state, tx, async (transaction) => {
      // Managed programs own action-specific write/review policies; the engine still validates tenancy.
      await this.scope.require(caller, owner?.definition.managed ? 'read' : 'write', transaction);
      const before = await this.readSnapshot(transaction, caller.projectId, input.instanceId);
      await this.checkOwnerForSnapshot(before, owner, transaction);
      const replay = await this.replay(transaction, caller.projectId, input.requestId, hash);
      if (replay) {
        if (owner) this.requireActive(owner);
        return replay;
      }
      check(
        before.revision === input.expectedRevision,
        'revision_conflict',
        `Expected revision ${input.expectedRevision}, found ${before.revision}`,
        409,
      );
      const registered = this.definition(before.workflow, before.version);
      this.checkOwner(registered, owner);
      const edge = registered.definition.edges.find(
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
      const limit = limitFor(registered.policy, before.state, edge.action);
      if (limit) {
        const status = await limitStatus(transaction, limit, before.id);
        check(!status.exhausted, 'loop_limit_reached', limitMessage(status, before.workflow), 409);
      }
      if (registered.policy) {
        const rule = registered.policy.actions.find(
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
            dependencies: (await relations(transaction, caller.projectId, before.id)).dependencies,
          }),
        );
      }
      await this.checkContext(
        { caller, snapshot: before, tx: transaction },
        'Transition checks must not change the workflow instance',
      );
      this.requireActive(registered);
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
        after,
        input.requestId,
        hash,
        input.action,
        before.state,
        data,
      );
      // Ended work waits on nothing, and the provider that spoke may not be loaded to say so.
      if (registered.definition.terminal.includes(after.state))
        await clearBlockers(transaction, after.id);
      // Recorded on arrival, never from a read. A step that stays in the capped state (a
      // reissued review) is not a new arrival and says nothing new.
      if (after.state !== before.state)
        for (const arrived of await limitStatuses(transaction, registered.policy, after))
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
      this.requireActive(registered);
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
    check(
      typeof input.instanceId === 'string' && input.instanceId.length > 0,
      'invalid_instance',
      'Workflow instance id is required',
    );
    check(
      Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
      'invalid_revision',
      'Expected revision must be a nonnegative integer',
    );
    const dependsOn = normalizeDependencies(input.dependsOn);
    const drop = normalizeDependencies(input.drop ?? null).filter((id) => !dependsOn.includes(id));
    const hash = fingerprint({
      operation: 'add_dependencies',
      actorId: caller.actorId,
      instanceId: input.instanceId,
      expectedRevision: input.expectedRevision,
      dependsOn,
      ...(drop.length ? { drop } : {}),
    });
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const before = await this.readSnapshot(tx, caller.projectId, input.instanceId);
      await this.checkOwnerForSnapshot(before, owner, tx);
      const replay = await this.replay(tx, caller.projectId, input.requestId, hash);
      if (replay) {
        if (owner) this.requireActive(owner);
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
      const added = await attachDependencies(tx, before, dependsOn);
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

  private async upgradeInternal(
    caller: Caller,
    { ...input }: WorkflowUpgrade,
    target: Registration,
    tx?: Transaction,
  ): Promise<WorkflowSnapshot> {
    this.assertOpen();
    caller = structuredClone(caller);
    this.requestId(input.requestId);
    check(
      typeof input.instanceId === 'string' && input.instanceId.length > 0,
      'invalid_instance',
      'Workflow instance id is required',
    );
    check(
      Number.isSafeInteger(input.fromVersion) && input.fromVersion > 0,
      'invalid_version',
      'Source workflow version must be a positive integer',
    );
    check(
      Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
      'invalid_revision',
      'Expected revision must be a nonnegative integer',
    );
    const destination = target.definition;
    const hash = fingerprint({
      operation: 'upgrade',
      actorId: caller.actorId,
      workflow: destination.name,
      instanceId: input.instanceId,
      fromVersion: input.fromVersion,
      toVersion: destination.version,
      expectedRevision: input.expectedRevision,
    });
    return await inTransaction(this.state, tx, async (transaction) => {
      await this.scope.require(caller, 'write', transaction);
      const sourceRegistration = this.definition(destination.name, input.fromVersion);
      const source = sourceRegistration.definition;
      check(
        source.managed && destination.managed,
        'workflow_upgrade_forbidden',
        'Only a managed program can upgrade its workflow instances',
        403,
      );
      const before = await this.readSnapshot(transaction, caller.projectId, input.instanceId);
      check(
        before.workflow === destination.name,
        'workflow_handle_mismatch',
        'The program handle does not own this workflow',
        403,
      );
      // A completed command replays its historical response even after a later transition.
      const replay = await this.replay(transaction, caller.projectId, input.requestId, hash);
      if (replay) {
        this.requireActive(target);
        this.requireActive(sourceRegistration);
        return replay;
      }
      check(
        destination.version > source.version &&
          destination.initial === source.initial &&
          canonical(destination.states) === canonical(source.states) &&
          canonical(destination.terminal) === canonical(source.terminal) &&
          source.edges.every((edge) =>
            destination.edges.some(
              (next) =>
                next.from === edge.from && next.action === edge.action && next.to === edge.to,
            ),
          ),
        'workflow_upgrade_incompatible',
        'An upgrade must select a newer version with unchanged states and all existing transitions',
        409,
      );
      check(
        before.version === input.fromVersion,
        'workflow_version_conflict',
        'The workflow no longer uses the expected source version',
        409,
      );
      check(
        before.revision === input.expectedRevision,
        'revision_conflict',
        `Expected revision ${input.expectedRevision}, found ${before.revision}`,
        409,
      );
      check(
        !source.terminal.includes(before.state),
        'invalid_transition',
        'Terminal workflow instances cannot be upgraded',
        409,
      );
      const after: WorkflowSnapshot = {
        ...before,
        version: destination.version,
        revision: before.revision + 1,
        updatedAt: now(),
      };
      const changed = await transaction.run(
        'UPDATE wf_instances SET version=?, revision=?, updated_at=? WHERE id=? AND project_id=? AND version=? AND revision=?',
        after.version,
        after.revision,
        after.updatedAt,
        before.id,
        caller.projectId,
        before.version,
        before.revision,
      );
      check(
        changed.changes === 1,
        'revision_conflict',
        'Workflow changed while upgrading its definition',
        409,
      );
      const metadata = { fromVersion: before.version, toVersion: after.version };
      await this.record(
        transaction,
        caller,
        after,
        input.requestId,
        hash,
        'upgrade',
        before.state,
        metadata,
        metadata,
      );
      this.requireActive(target);
      this.requireActive(sourceRegistration);
      return after;
    });
  }

  private definition(name: string, version?: number): Registration {
    const registration =
      version === undefined
        ? [...this.registrations.values()]
            .filter((value) => value.definition.name === name)
            .sort((a, b) => b.definition.version - a.definition.version)[0]
        : this.registrations.get(`${name}@${version}`);
    check(
      registration,
      'workflow_unavailable',
      `Workflow ${name}${version === undefined ? '' : `@${version}`} is not installed`,
      503,
    );
    return registration;
  }

  private async checkOwnerForSnapshot(
    snapshot: WorkflowSnapshot,
    owner: Registration | undefined,
    tx: Transaction,
  ): Promise<void> {
    const row = await tx.get<{ definition_json: string }>(
      'SELECT definition_json FROM wf_definitions WHERE name = ? AND version = ?',
      snapshot.workflow,
      snapshot.version,
    );
    check(row, 'workflow_unavailable', 'The pinned workflow definition is unavailable', 503);
    const definition = JSON.parse(row.definition_json) as WorkflowDefinition;
    if (owner)
      check(
        owner.definition.name === snapshot.workflow &&
          owner.definition.version === snapshot.version,
        'workflow_handle_mismatch',
        'The program handle does not own this workflow instance',
        403,
      );
    check(
      !definition.managed || owner,
      'workflow_managed',
      'This workflow is managed by its program; use the program commands',
      403,
    );
  }

  private checkOwner(registration: Registration, owner?: Registration): void {
    if (owner)
      check(
        registration === owner,
        'workflow_handle_mismatch',
        'The program handle does not own this workflow version',
        403,
      );
    check(
      !registration.definition.managed || owner,
      'workflow_managed',
      'This workflow is managed by its program; use the program commands',
      403,
    );
  }

  /** Recheck authority and registration after an awaited callback, before returning its result. */
  private async checkContext(context: WorkflowCheckContext, message: string): Promise<void> {
    await this.scope.require(context.caller, 'read', context.tx);
    const after = await this.readSnapshot(
      context.tx,
      context.caller.projectId,
      context.snapshot.id,
    );
    check(
      canonical(after) === canonical(context.snapshot),
      'invalid_workflow_policy',
      message,
      500,
    );
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

  private async replay(
    tx: Transaction,
    projectId: string,
    requestId: string,
    hash: string,
  ): Promise<WorkflowSnapshot | undefined> {
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
    return JSON.parse(row.response_json) as WorkflowSnapshot;
  }

  private async record(
    tx: Transaction,
    caller: Caller,
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
    });
  }

  private async readSnapshot(
    sql: Sql,
    projectId: string,
    instanceId: string,
  ): Promise<WorkflowSnapshot> {
    const row = await sql.get<InstanceRow>(
      'SELECT * FROM wf_instances WHERE id = ? AND project_id = ?',
      instanceId,
      projectId,
    );
    check(row, 'not_found', 'Workflow instance not found', 404);
    return this.snapshot(row);
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

  private data(value?: Data): Data {
    const data = workflowJson(value ?? {}, 'invalid_data', 400);
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
    this.readProviders.clear();
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
