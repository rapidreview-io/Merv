import {
  check,
  digest,
  MervError,
  now,
  type Caller,
  type Json,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { SandboxCompute, SandboxComputeRun } from '@merv/sandboxes/types';
import type { Code } from '@merv/code-research/types';
import type { ComputeInput } from './types.js';

export interface ComputeRow {
  project_id: string;
  experiment_id: string;
  attempt_index: number;
  key: string;
  input_hash: string;
  input_json: string;
  run_id: string | null;
  state: string;
  cost: string | null;
  result: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
const live = "'submitting','running','cancelling'";
const terminal = new Set(['completed', 'failed', 'cancelled']);
const publicRow = (row: ComputeRow) => ({
  key: row.key,
  runId: row.run_id ?? row.key,
  attemptIndex: row.attempt_index,
  state: row.state,
  cost: row.cost ? JSON.parse(row.cost) : null,
  ...(row.result ? JSON.parse(row.result) : {}),
  ...(JSON.parse(row.input_json).commandId ? { commit: JSON.parse(row.input_json).commandId } : {}),
});

export class ExperimentCompute {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closed = false;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly adapter: SandboxCompute,
    private readonly code: () => Pick<Code, 'source'> | undefined,
  ) {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), 60_000);
    this.timer.unref();
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }
  async entitled(projectId: string, tx?: Transaction): Promise<boolean> {
    const read = async (sql: Transaction) => {
      const row = await sql.get<{ created_at: string }>(
        `SELECT p.created_at FROM projects p JOIN user_project_requests r ON r.project_id=p.id
         WHERE p.id=? LIMIT 1`,
        projectId,
      );
      return !!row && Date.parse(row.created_at) >= Date.parse(this.adapter.since);
    };
    return tx ? read(tx) : await this.state.transaction(read);
  }
  async offers(caller: Caller): Promise<Json> {
    await this.scope.require(caller, 'read');
    if (!(await this.entitled(caller.projectId)))
      return { entitled: false, allowance: null, offers: [] };
    const [allowance, options] = await Promise.all([
      this.adapter.allowance(caller.projectId),
      this.adapter.offers(caller.projectId),
    ]);
    return { entitled: true, allowance, offers: (options as { offers?: Json[] }).offers ?? [] };
  }
  async rows(projectId: string, experimentId: string, attemptIndex: number, tx: Transaction) {
    return (
      await tx.all<ComputeRow>(
        'SELECT * FROM experiment_compute_runs WHERE project_id=? AND experiment_id=? AND attempt_index=? ORDER BY created_at,key',
        projectId,
        experimentId,
        attemptIndex,
      )
    ).map(publicRow);
  }
  private async currentWorker(
    caller: Caller,
    experimentId: string,
    attemptIndex: number,
    tx: Transaction,
  ): Promise<void> {
    if (!caller.session) return;
    const lease = await tx.get<{ id: string }>(
      `SELECT id FROM experiment_leases WHERE experiment_id=? AND project_id=?
       AND attempt_index=? AND state='running' AND actor_id=? AND id=? AND released_at IS NULL`,
      experimentId,
      caller.projectId,
      attemptIndex,
      caller.actorId,
      caller.session.id,
    );
    check(lease, 'stale_lease', 'The worker no longer owns this experiment attempt', 409);
  }
  async run(caller: Caller, input: ComputeInput): Promise<ReturnType<typeof publicRow>> {
    check(
      input.key.length > 0 &&
        input.key.length <= 128 &&
        Buffer.byteLength(input.command) >= 1 &&
        Buffer.byteLength(input.command) <= 65536 &&
        Number.isInteger(input.minutes) &&
        input.minutes >= 5 &&
        input.minutes <= 1380 &&
        Number.isFinite(input.maxUsd) &&
        input.maxUsd >= 0,
      'invalid_compute_input',
      'Compute input is outside the supported bounds',
      400,
    );
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const experiment = await tx.get<{ attempt_index: number; state: string; version: number }>(
        `SELECT e.attempt_index,w.state,w.version FROM experiments e JOIN wf_instances w ON w.id=e.id
         WHERE e.id=? AND e.project_id=?`,
        input.experimentId,
        caller.projectId,
      );
      check(
        experiment &&
          experiment.state === 'running' &&
          experiment.version > 8 &&
          experiment.attempt_index === input.attemptIndex,
        'compute_not_running',
        'Compute requires this experiment’s current running attempt',
        409,
      );
      await this.currentWorker(caller, input.experimentId, input.attemptIndex, tx);
      check(
        await this.entitled(caller.projectId, tx),
        'compute_not_entitled',
        'This project has no ML allowance',
        403,
      );
      if (input.commandId)
        check(
          experiment.version === 12,
          'code_source_unavailable',
          'This experiment version cannot ship code',
          409,
        );
      const fingerprint = digest(input);
      const old = await tx.get<ComputeRow>(
        'SELECT * FROM experiment_compute_runs WHERE experiment_id=? AND attempt_index=? AND key=?',
        input.experimentId,
        input.attemptIndex,
        input.key,
      );
      if (old) {
        check(
          old.input_hash === fingerprint,
          'compute_key_conflict',
          'This compute key has different input',
          409,
        );
        return publicRow(old);
      }
      const count = await tx.get<{ n: number }>(
        `SELECT count(*)::int n FROM experiment_compute_runs WHERE project_id=? AND state IN (${live})`,
        caller.projectId,
      );
      check((count?.n ?? 0) < 2, 'compute_busy', 'This project already has two live runs', 429);
      const at = now();
      await tx.run(
        `INSERT INTO experiment_compute_runs
        (project_id,experiment_id,attempt_index,key,input_hash,input_json,run_id,state,cost,result,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,NULL,'submitting',NULL,NULL,?,?,?)`,
        caller.projectId,
        input.experimentId,
        input.attemptIndex,
        input.key,
        fingerprint,
        JSON.stringify(input),
        caller.actorId,
        at,
        at,
      );
      return publicRow({
        project_id: caller.projectId,
        experiment_id: input.experimentId,
        attempt_index: input.attemptIndex,
        key: input.key,
        input_hash: fingerprint,
        input_json: JSON.stringify(input),
        run_id: null,
        state: 'submitting',
        cost: null,
        result: null,
        created_by: caller.actorId,
        created_at: at,
        updated_at: at,
      });
    });
  }
  async cancel(
    caller: Caller,
    experimentId: string,
    runId: string,
  ): Promise<ReturnType<typeof publicRow>> {
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const experiment = await tx.get<{ attempt_index: number; state: string }>(
        `SELECT e.attempt_index,w.state FROM experiments e JOIN wf_instances w ON w.id=e.id
         WHERE e.id=? AND e.project_id=?`,
        experimentId,
        caller.projectId,
      );
      check(
        experiment?.state === 'running',
        'compute_not_running',
        'Compute requires a running experiment',
        409,
      );
      await this.currentWorker(caller, experimentId, experiment.attempt_index, tx);
      const row = await tx.get<ComputeRow>(
        'SELECT * FROM experiment_compute_runs WHERE experiment_id=? AND project_id=? AND attempt_index=? AND (run_id=? OR key=?)',
        experimentId,
        caller.projectId,
        experiment.attempt_index,
        runId,
        runId,
      );
      check(row, 'compute_not_found', 'Compute run not found in this experiment', 404);
      if (!terminal.has(row.state)) {
        await tx.run(
          "UPDATE experiment_compute_runs SET state='cancelling',updated_at=? WHERE experiment_id=? AND attempt_index=? AND key=?",
          now(),
          row.experiment_id,
          row.attempt_index,
          row.key,
        );
        row.state = 'cancelling';
      }
      return publicRow(row);
    });
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.pending ??= this.pass().finally(() => {
      this.pending = undefined;
    }));
  }
  private async pass(): Promise<void> {
    const rows = await this.state.read((sql) =>
      sql.all<ComputeRow & { workflow_state: string; current_attempt: number }>(
        `SELECT r.*,w.state workflow_state,e.attempt_index current_attempt
       FROM experiment_compute_runs r JOIN experiments e ON e.id=r.experiment_id
       JOIN wf_instances w ON w.id=r.experiment_id
       WHERE r.state IN (${live}) ORDER BY r.updated_at LIMIT 20`,
      ),
    );
    for (const row of rows) {
      try {
        await this.advance(row);
      } catch (error) {
        if (!(error instanceof MervError && error.status < 500)) continue;
        await this.update(row, 'failed', row.run_id, null, { reason: error.code });
      }
    }
  }
  private async update(
    row: ComputeRow,
    state: string,
    runId: string | null,
    cost: SandboxComputeRun['cost'],
    result: object | null,
  ): Promise<void> {
    await this.state.transaction((tx) =>
      tx.run(
        `UPDATE experiment_compute_runs SET state=CASE WHEN state='cancelling' AND ?='running' THEN 'cancelling' ELSE ? END,
       run_id=COALESCE(?,run_id),cost=COALESCE(?,cost),result=COALESCE(?,result),updated_at=?
       WHERE experiment_id=? AND attempt_index=? AND key=?`,
        state,
        state,
        runId,
        cost ? JSON.stringify(cost) : null,
        result ? JSON.stringify(result) : null,
        now(),
        row.experiment_id,
        row.attempt_index,
        row.key,
      ),
    );
  }
  private async advance(
    row: ComputeRow & { workflow_state: string; current_attempt: number },
  ): Promise<void> {
    if (
      row.workflow_state !== 'running' ||
      row.current_attempt !== row.attempt_index ||
      row.state === 'cancelling'
    ) {
      if (row.run_id) await this.adapter.cancel(row.project_id, row.run_id);
      await this.update(row, 'cancelled', row.run_id, null, null);
      return;
    }
    if (row.state === 'submitting') {
      const input = JSON.parse(row.input_json) as ComputeInput;
      const source = input.commandId
        ? await this.code()?.source(row.project_id, row.experiment_id, input.commandId)
        : undefined;
      if (input.commandId && !source)
        throw new MervError('code_source_unavailable', 'Code source is unavailable', 409);
      const runId = await this.adapter.submit(row.project_id, {
        ...input,
        idempotencyKey: digest([row.project_id, row.experiment_id, row.attempt_index, row.key]),
        source,
      });
      await this.update(row, 'running', runId, null, null);
      return;
    }
    const status = await this.adapter.get(row.project_id, row.run_id!);
    if (terminal.has(status.state))
      await this.update(row, status.state, row.run_id, status.cost, {
        result: status.result,
        reason: status.reason,
      });
    else if (status.cost) await this.update(row, 'running', row.run_id, status.cost, null);
  }
}
