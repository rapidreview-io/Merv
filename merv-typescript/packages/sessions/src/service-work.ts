import {
  check,
  digest,
  type Scope,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import { budgetStatuses } from './usage.js';
import type { ServiceWork, ServiceWorkInput } from './types.js';

const table = `CREATE TABLE session_service_work (
  provider TEXT NOT NULL, operation_id TEXT NOT NULL, execution_epoch INTEGER NOT NULL,
  project_id TEXT NOT NULL, sponsors_json TEXT NOT NULL, input_hash TEXT NOT NULL,
  started_at TEXT NOT NULL, deadline TEXT NOT NULL, settled_at TEXT,
  outcome TEXT CHECK(outcome IN ('completed','failed','expired','cancelled')), wall_ms INTEGER,
  PRIMARY KEY(provider,operation_id,execution_epoch),
  CHECK(execution_epoch > 0), CHECK(deadline > started_at),
  CHECK((settled_at IS NULL AND outcome IS NULL AND wall_ms IS NULL) OR
        (settled_at IS NOT NULL AND outcome IS NOT NULL AND wall_ms >= 0))
);
CREATE INDEX session_service_work_project ON session_service_work(project_id,settled_at,deadline);`;
const frozen = [
  'provider',
  'operation_id',
  'execution_epoch',
  'project_id',
  'sponsors_json',
  'input_hash',
  'started_at',
  'deadline',
];
interface Row {
  input_hash: string;
  started_at: string;
  deadline: string;
  settled_at: string | null;
  outcome: string | null;
}

/**
 * Reservation and settlement share the provider's transaction. A lost process leaves a
 * reservation until its deadline, when its full reserved wall time is charged once. It
 * cannot release capacity early and then return with an unaccounted result.
 */
export class SessionServiceWork implements ServiceWork {
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly workflows: Workflows,
    private readonly clock: () => number,
    private readonly concurrency: number,
  ) {}

  async initialize(): Promise<void> {
    check(
      Number.isSafeInteger(this.concurrency) && this.concurrency > 0 && this.concurrency <= 256,
      'invalid_sessions_config',
      'Session serviceConcurrency must be 1–256',
    );
    await this.state.migrate('session_service_work', [
      {
        version: 1,
        sql: `${table}
CREATE TRIGGER session_service_work_guard BEFORE UPDATE ON session_service_work
WHEN OLD.settled_at IS NOT NULL OR ${frozen.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ')}
BEGIN SELECT RAISE(ABORT,'Service work reservations and settlements are retained'); END;
CREATE TRIGGER session_service_work_no_delete BEFORE DELETE ON session_service_work
BEGIN SELECT RAISE(ABORT,'Service work is retained'); END;`,
        postgres: `${table.replaceAll(' INTEGER', ' BIGINT')}
CREATE FUNCTION session_service_work_guard() RETURNS trigger AS $$ BEGIN
IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Service work is retained'; END IF;
IF OLD.settled_at IS NOT NULL OR ${frozen.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join(' OR ')} THEN
RAISE EXCEPTION 'Service work reservations and settlements are retained'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER session_service_work_guard BEFORE UPDATE OR DELETE ON session_service_work
FOR EACH ROW EXECUTE FUNCTION session_service_work_guard();`,
      },
    ]);
  }

  private input(input: ServiceWorkInput): ServiceWorkInput {
    check(
      input.provider.length > 0 &&
        input.operationId.length > 0 &&
        Number.isSafeInteger(input.executionEpoch) &&
        input.executionEpoch > 0 &&
        Number.isFinite(Date.parse(input.deadline)) &&
        input.projectId.length > 0 &&
        input.sponsors.every((id) => id.trim().length > 0),
      'invalid_service_work',
      'Service work needs an identity, sponsors, epoch and deadline',
    );
    return {
      ...input,
      deadline: new Date(input.deadline).toISOString(),
      sponsors: [...new Set(input.sponsors)].sort(),
    };
  }

  private async row(tx: Transaction, input: ServiceWorkInput): Promise<Row | undefined> {
    const row = await tx.get<Row>(
      'SELECT input_hash,started_at,deadline,settled_at,outcome FROM session_service_work WHERE provider=? AND operation_id=? AND execution_epoch=?',
      input.provider,
      input.operationId,
      input.executionEpoch,
    );
    check(
      !row || row.input_hash === digest(input),
      'request_conflict',
      'This execution identity was used with different input',
      409,
    );
    return row;
  }

  /** Sweep abandoned reservations even while their provider is unloaded. */
  async expire(tx: Transaction, projectId?: string): Promise<void> {
    this.state.assertTransaction(tx);
    const at = new Date(this.clock()).toISOString();
    for (const row of await tx.all<{
      provider: string;
      operation_id: string;
      execution_epoch: number;
      started_at: string;
      deadline: string;
    }>(
      `SELECT provider,operation_id,execution_epoch,started_at,deadline FROM session_service_work WHERE settled_at IS NULL AND deadline<=?${projectId ? ' AND project_id=?' : ''}`,
      at,
      ...(projectId ? [projectId] : []),
    ))
      await tx.run(
        "UPDATE session_service_work SET settled_at=?,outcome='expired',wall_ms=? WHERE provider=? AND operation_id=? AND execution_epoch=? AND settled_at IS NULL",
        at,
        Date.parse(row.deadline) - Date.parse(row.started_at),
        row.provider,
        row.operation_id,
        row.execution_epoch,
      );
  }

  async admit(tx: Transaction, value: ServiceWorkInput): ReturnType<ServiceWork['admit']> {
    this.state.assertTransaction(tx);
    const input = this.input(value);
    const at = new Date(this.clock()).toISOString();
    await this.expire(tx, input.projectId);
    const held = await this.row(tx, input);
    if (held)
      return {
        admitted: true,
        startedAt: held.started_at,
        deadline: held.deadline,
        settled: held.settled_at !== null,
      };
    check(
      input.deadline > at,
      'invalid_deadline',
      'A service execution deadline must be in the future',
    );
    const dispatch = await tx.get<{ enabled: number }>(
      'SELECT enabled FROM project_session_dispatch WHERE project_id=?',
      input.projectId,
    );
    if (!dispatch?.enabled) return { admitted: false, reason: 'dispatch_disabled' };
    const active = await tx.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM session_service_work WHERE project_id=? AND settled_at IS NULL',
      input.projectId,
    );
    if (Number(active?.count) >= this.concurrency)
      return { admitted: false, reason: 'capacity_full' };
    const caller = await this.scope.serviceActor('sessions', input.projectId, tx);
    const budgets = await budgetStatuses(
      tx,
      input.projectId,
      (id) => this.workflows.dependencyClosure(caller, id, tx),
      [input.projectId, ...input.sponsors],
    );
    if (budgets.some((b) => b.exceeded.length))
      return { admitted: false, reason: 'budget_exceeded' };
    if (budgets.some((b) => b.unavailable.length))
      return { admitted: false, reason: 'usage_unavailable' };
    await tx.run(
      'INSERT INTO session_service_work(provider,operation_id,execution_epoch,project_id,sponsors_json,input_hash,started_at,deadline) VALUES(?,?,?,?,?,?,?,?)',
      input.provider,
      input.operationId,
      input.executionEpoch,
      input.projectId,
      JSON.stringify(input.sponsors),
      digest(input),
      at,
      input.deadline,
    );
    return { admitted: true, startedAt: at, deadline: input.deadline, settled: false };
  }

  async settle(
    tx: Transaction,
    value: ServiceWorkInput,
    outcome: 'completed' | 'failed' | 'expired' | 'cancelled',
  ): Promise<void> {
    this.state.assertTransaction(tx);
    const input = this.input(value);
    const row = await this.row(tx, input);
    check(row, 'service_work_missing', 'This execution has no reservation', 409);
    if (row.settled_at) {
      check(
        row.outcome === outcome || row.outcome === 'expired',
        'request_conflict',
        'This execution already has a different settlement',
        409,
      );
      return;
    }
    const time = this.clock();
    const expired = time >= Date.parse(row.deadline);
    await tx.run(
      'UPDATE session_service_work SET settled_at=?,outcome=?,wall_ms=? WHERE provider=? AND operation_id=? AND execution_epoch=? AND settled_at IS NULL',
      new Date(time).toISOString(),
      expired ? 'expired' : outcome,
      Math.max(0, Math.min(time, Date.parse(row.deadline)) - Date.parse(row.started_at)),
      input.provider,
      input.operationId,
      input.executionEpoch,
    );
  }
}
