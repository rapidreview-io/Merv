import { check, within } from '@merv/contracts';
import type {
  Data,
  Scope,
  Sql,
  State,
  Transaction,
  WorkflowDefinition,
  WorkflowSnapshot,
  WorkflowPolicy,
  WorkflowHistoryEntry,
} from '@merv/contracts';
import { DATA_LIMITS, workflowJson } from './json.js';
import { PinnedContracts } from './pinned.js';

/** The most instances one statement reads facts for, or rechecks, keeping its binds bounded. */
const batchSize = 1000;
export const batches = <T>(items: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(items.length / batchSize) }, (_, index) =>
    items.slice(index * batchSize, (index + 1) * batchSize),
  );

export interface InstanceRow {
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
export interface Registration {
  definition: WorkflowDefinition;
  policy?: WorkflowPolicy;
  registrationId: string;
}

/** The instance and revision a command names, checked the same way wherever one is named. */
export const checkInstance = (id: unknown) =>
  check(
    typeof id === 'string' && id.length > 0,
    'invalid_instance',
    'Workflow instance id is required',
  );
export const checkRevision = (revision: unknown) =>
  check(
    Number.isSafeInteger(revision) && (revision as number) >= 0,
    'invalid_revision',
    'Expected revision must be a nonnegative integer',
  );

/** What the engine's parts share: the registry, where a call runs, and the instance reads. */
export class WorkflowEngine {
  protected readonly registrations = new Map<string, Registration>();
  protected readonly contracts = new PinnedContracts();
  protected closed = false;
  /**
   * Where a read runs: in the `tx` given, asserted, or else the ambient transaction; outside
   * any, in a read-only snapshot transaction of its own, which never waits for the writer lock.
   */
  protected readonly read = async <T>(
    tx: Transaction | undefined,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    // With a place, `within` always hands over a transaction.
    await within(this.state, tx, (sql) => fn(sql as Transaction), 'read');
  /** Where a command runs: as a read does, but outside any transaction in a write one. */
  protected readonly write = async <T>(
    tx: Transaction | undefined,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> => await within(this.state, tx, (sql) => fn(sql as Transaction), 'write');

  constructor(
    protected readonly state: State,
    protected readonly scope: Scope,
  ) {}

  /**
   * The instance's history in revision order. A traversal reads it without `data`: a row's
   * data can be as large as the data it merged, and a traversal shows none of it.
   */
  protected async historyIn(
    tx: Transaction,
    projectId: string,
    instanceId: string,
    data: true,
  ): Promise<WorkflowHistoryEntry[]>;
  protected async historyIn(
    tx: Transaction,
    projectId: string,
    instanceId: string,
    data: false,
  ): Promise<Omit<WorkflowHistoryEntry, 'data'>[]>;
  protected async historyIn(
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

  protected definition(name: string, version: number): Registration {
    const registration = this.registrations.get(`${name}@${version}`);
    check(
      registration,
      'workflow_unavailable',
      `Workflow ${name}@${version} is not installed`,
      503,
    );
    return registration;
  }

  /**
   * After a group of callbacks: none of them wrote to the instances given. Their stored
   * columns are compared as read, so a rewrite to equal data in other bytes is refused too.
   * Every transaction under a snapshot root is read-only, so there nothing can have written.
   */
  protected async recheck(
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

  protected requireActive(registration: Registration): void {
    check(
      this.registrations.get(
        `${registration.definition.name}@${registration.definition.version}`,
      ) === registration,
      'workflow_unavailable',
      'The workflow registration has been disposed',
      503,
    );
  }

  protected async readRow(sql: Sql, projectId: string, instanceId: string): Promise<InstanceRow> {
    const row = await sql.get<InstanceRow>(
      'SELECT * FROM wf_instances WHERE id = ? AND project_id = ?',
      instanceId,
      projectId,
    );
    check(row, 'not_found', 'Workflow instance not found', 404);
    return row;
  }

  protected async readSnapshot(
    sql: Sql,
    projectId: string,
    instanceId: string,
  ): Promise<WorkflowSnapshot> {
    return this.snapshot(await this.readRow(sql, projectId, instanceId));
  }

  protected snapshot(row: InstanceRow): WorkflowSnapshot {
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

  /** The one validator for start data, transition data and input, and preflight input. */
  protected data(value?: Data): Data {
    const data = workflowJson(value ?? {}, 'invalid_data', 400, DATA_LIMITS);
    check(
      typeof data === 'object' && data !== null && !Array.isArray(data),
      'invalid_data',
      'Workflow data must be a JSON object',
    );
    return data;
  }

  protected assertOpen(): void {
    check(!this.closed, 'workflow_unavailable', 'The workflow service has been disposed', 503);
  }
}
