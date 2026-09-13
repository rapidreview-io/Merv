import type { Context } from 'cordis';
import { check, inTransaction, newId, now } from '@merv/contracts';
import type {
  Caller,
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
} from '@merv/contracts';
import { canonical, fingerprint, validateDefinition } from './definition.js';

const migrations = [
  {
    version: 1,
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
];

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
  token: symbol;
}
export interface WorkflowHistoryEntry {
  instanceId: string;
  revision: number;
  action: string;
  actorId: string;
  requestId: string;
  fromState: string | null;
  toState: string;
  data: Data;
  createdAt: string;
}

/** Durable graph engine. Domain programs enforce their own guards through managed handles. */
export class WorkflowsService implements Workflows {
  private readonly registrations = new Map<string, Registration>();
  private closed = false;

  constructor(
    private readonly state: State,
    private readonly scope: Scope,
  ) {
    state.migrate('workflows', migrations);
  }

  register(input: WorkflowDefinition): ReturnType<Workflows['register']> {
    this.assertOpen();
    const definition = validateDefinition(input);
    const key = `${definition.name}@${definition.version}`;
    check(
      !this.registrations.has(key),
      'workflow_already_registered',
      `${key} is already registered`,
      409,
    );
    const hash = fingerprint(definition);
    this.state.transaction((tx) => {
      const existing = tx.get<{ fingerprint: string }>(
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
        tx.run(
          'INSERT INTO wf_definitions (name, version, fingerprint, definition_json, created_at) VALUES (?, ?, ?, ?, ?)',
          definition.name,
          definition.version,
          hash,
          canonical(definition),
          now(),
        );
    });
    const registration = { definition, token: Symbol(key) };
    this.registrations.set(key, registration);
    return {
      dispose: () => {
        if (this.registrations.get(key) === registration) this.registrations.delete(key);
      },
      start: (caller, input, tx) => {
        this.requireActive(registration);
        check(
          input.workflow === definition.name &&
            (input.version === undefined || input.version === definition.version),
          'workflow_handle_mismatch',
          'The program handle only owns its registered workflow version',
        );
        return this.startInternal(
          caller,
          { ...input, version: definition.version },
          tx,
          registration,
        );
      },
      transition: (caller, input, tx) => {
        this.requireActive(registration);
        return this.transitionInternal(caller, input, tx, registration);
      },
    };
  }

  catalog(): WorkflowDefinition[] {
    this.assertOpen();
    return [...this.registrations.values()]
      .map(({ definition }) => JSON.parse(canonical(definition)) as WorkflowDefinition)
      .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
  }

  start(caller: Caller, input: WorkflowStart, tx?: Transaction): WorkflowSnapshot {
    return this.startInternal(caller, input, tx);
  }

  transition(caller: Caller, input: WorkflowTransition, tx?: Transaction): WorkflowSnapshot {
    return this.transitionInternal(caller, input, tx);
  }

  get(caller: Caller, instanceId: string, tx?: Transaction): WorkflowSnapshot {
    this.assertOpen();
    return inTransaction(this.state, tx, (transaction) => {
      this.scope.require(caller, 'read', transaction);
      return this.readSnapshot(transaction, caller.projectId, instanceId);
    });
  }

  list(caller: Caller): WorkflowSnapshot[] {
    this.assertOpen();
    return this.state.transaction((tx) => {
      this.scope.require(caller, 'read', tx);
      return tx
        .all<InstanceRow>(
          'SELECT * FROM wf_instances WHERE project_id = ? ORDER BY created_at, id',
          caller.projectId,
        )
        .map(this.snapshot);
    });
  }

  history(caller: Caller, instanceId: string): WorkflowHistoryEntry[] {
    this.assertOpen();
    return this.state.transaction((tx) => {
      this.scope.require(caller, 'read', tx);
      this.readSnapshot(tx, caller.projectId, instanceId);
      return tx
        .all<{
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
        .map((row) => ({
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

  private startInternal(
    caller: Caller,
    input: WorkflowStart,
    tx?: Transaction,
    owner?: Registration,
  ): WorkflowSnapshot {
    this.assertOpen();
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
    const hash = fingerprint({
      operation: 'start',
      actorId: caller.actorId,
      workflow: input.workflow,
      version: input.version ?? null,
      data,
    });
    return inTransaction(this.state, tx, (transaction) => {
      this.scope.require(caller, 'write', transaction);
      const replay = this.replay(transaction, caller.projectId, input.requestId, hash);
      if (replay) {
        this.checkOwnerForSnapshot(replay, owner, transaction);
        return replay;
      }
      const registered = this.definition(input.workflow, input.version);
      this.checkOwner(registered, owner);
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
      transaction.run(
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
      this.record(transaction, caller, snapshot, input.requestId, hash, 'start', null, data);
      return snapshot;
    });
  }

  private transitionInternal(
    caller: Caller,
    input: WorkflowTransition,
    tx?: Transaction,
    owner?: Registration,
  ): WorkflowSnapshot {
    this.assertOpen();
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
    const hash = fingerprint({
      operation: 'transition',
      actorId: caller.actorId,
      instanceId: input.instanceId,
      action: input.action,
      expectedRevision: input.expectedRevision,
      data,
    });
    return inTransaction(this.state, tx, (transaction) => {
      // Managed programs own action-specific write/review policies; the engine still validates tenancy.
      this.scope.require(caller, owner?.definition.managed ? 'read' : 'write', transaction);
      const before = this.readSnapshot(transaction, caller.projectId, input.instanceId);
      this.checkOwnerForSnapshot(before, owner, transaction);
      const replay = this.replay(transaction, caller.projectId, input.requestId, hash);
      if (replay) return replay;
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
      const after: WorkflowSnapshot = {
        ...before,
        state: edge.to,
        revision: before.revision + 1,
        data: { ...before.data, ...data },
        updatedAt: now(),
      };
      const update = transaction.run(
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
      this.record(
        transaction,
        caller,
        after,
        input.requestId,
        hash,
        input.action,
        before.state,
        data,
      );
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

  private checkOwnerForSnapshot(
    snapshot: WorkflowSnapshot,
    owner: Registration | undefined,
    tx: Transaction,
  ): void {
    const row = tx.get<{ definition_json: string }>(
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

  private replay(
    tx: Transaction,
    projectId: string,
    requestId: string,
    hash: string,
  ): WorkflowSnapshot | undefined {
    const row = tx.get<{ fingerprint: string; response_json: string }>(
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

  private record(
    tx: Transaction,
    caller: Caller,
    snapshot: WorkflowSnapshot,
    requestId: string,
    hash: string,
    action: string,
    from: string | null,
    data: Data,
  ): void {
    tx.run(
      'INSERT INTO wf_requests (project_id, request_id, fingerprint, response_json) VALUES (?, ?, ?, ?)',
      caller.projectId,
      requestId,
      hash,
      canonical(snapshot),
    );
    tx.run(
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
    this.state.appendEvent(tx, {
      projectId: caller.projectId,
      actorId: caller.actorId,
      type: 'workflow.transition',
      subjectId: snapshot.id,
      data: {
        workflow: snapshot.workflow,
        version: snapshot.version,
        revision: snapshot.revision,
        action,
        from,
        to: snapshot.state,
      },
    });
  }

  private readSnapshot(sql: Sql, projectId: string, instanceId: string): WorkflowSnapshot {
    const row = sql.get<InstanceRow>(
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
      typeof value === 'string' && value.trim().length > 0 && value.length <= 256,
      'invalid_request',
      'A request id of 1–256 characters is required',
    );
  }

  private data(value?: Data): Data {
    const data = value ?? {};
    check(
      typeof data === 'object' &&
        data !== null &&
        !Array.isArray(data) &&
        Object.getPrototypeOf(data) === Object.prototype,
      'invalid_data',
      'Workflow data must be a JSON object',
    );
    // Detach external references so returned data cannot alter committed snapshots.
    return JSON.parse(canonical(data)) as Data;
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
  apply(ctx: Context) {
    ctx.effect(function* () {
      const workflows = new WorkflowsService(ctx.state, ctx.scope);
      yield () => workflows.close();
      yield ctx.provide('workflows', workflows);
    });
  },
};

export default workflowsPlugin;
