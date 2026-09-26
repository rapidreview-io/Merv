import {
  check,
  digest,
  MervError,
  now,
  type Caller,
  type Artifacts,
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
/** How many of the runs written last a finished run's sidebar is looked for among. */
const ENDED_FOUND = 100;
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

/**
 * A run as a monitor reads it, beside the record's own shape. It never carries the command,
 * which an agent wrote and may hold a secret. `digest` is the service's idempotency key, so
 * it names the run from submit to its end, while `runId` is still null.
 */
export interface ComputeRunning {
  digest: string;
  experimentId: string;
  attemptIndex: number;
  key: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  minutes: number | null;
  maxUsd: number | null;
  cost: { amount: string; currency: string } | null;
  exit: number | null;
  reason: string | null;
  /**
   * Past the time by which the service must have ended it, and the tick has not heard from
   * it since: its row is out of date, which says nothing about the run being alive.
   */
  overdue: boolean;
}
/**
 * The service ends a run's whole workflow 600 s after its job's minutes and takes 60 s more
 * to capture it (sandboxes/src/compute.ts), and the tick submits it and hears it end within
 * a pass either side.
 */
const OVERRUN_MS = (600 + 60 + 2 * 60) * 1000;
/** Three passes of the tick with nothing written; a run it hears from keeps its row current. */
const UNHEARD_MS = 3 * 60_000;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** A stored JSON object, or nothing: one odd row must not blank a page that lists many. */
const stored = (text: string | null): Record<string, unknown> => {
  try {
    return object(text ? JSON.parse(text) : null);
  } catch {
    return {};
  }
};
const runningRow = (row: ComputeRow): ComputeRunning => {
  const input = stored(row.input_json),
    cost = stored(row.cost),
    outcome = stored(row.result),
    result = object(outcome.result);
  return {
    digest: digest([row.project_id, row.experiment_id, row.attempt_index, row.key]),
    experimentId: row.experiment_id,
    attemptIndex: row.attempt_index,
    key: row.key,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    minutes: typeof input.minutes === 'number' ? input.minutes : null,
    maxUsd: typeof input.maxUsd === 'number' ? input.maxUsd : null,
    cost:
      typeof cost.amount === 'string' && typeof cost.currency === 'string'
        ? { amount: cost.amount, currency: cost.currency }
        : null,
    exit: Number.isInteger(result.exit) ? (result.exit as number) : null,
    reason: typeof outcome.reason === 'string' ? outcome.reason : null,
    // A submitting run has not reached the service, so nothing there ends it.
    overdue:
      (row.state === 'running' || row.state === 'cancelling') &&
      typeof input.minutes === 'number' &&
      Date.now() - Date.parse(row.created_at) > input.minutes * 60_000 + OVERRUN_MS &&
      Date.now() - Date.parse(row.updated_at) > UNHEARD_MS,
  };
};

export class ExperimentCompute {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closed = false;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly adapter: SandboxCompute,
    private readonly code: () => Pick<Code, 'source'> | undefined,
    private readonly artifacts?: Artifacts,
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
  /** The project's runs that hold or seek a machine, oldest first. */
  async inFlight(projectId: string, tx: Transaction): Promise<ComputeRunning[]> {
    return (
      await tx.all<ComputeRow>(
        `SELECT * FROM experiment_compute_runs WHERE project_id=? AND state IN (${live}) ORDER BY created_at,key`,
        projectId,
      )
    ).map(runningRow);
  }
  /** One experiment's runs a monitor still cares about: live ones, and the current attempt's. */
  async recent(
    projectId: string,
    experimentId: string,
    attemptIndex: number,
    tx: Transaction,
  ): Promise<ComputeRunning[]> {
    return (
      await tx.all<ComputeRow>(
        `SELECT * FROM experiment_compute_runs WHERE project_id=? AND experiment_id=?
         AND (attempt_index=? OR state IN (${live})) ORDER BY created_at,key`,
        projectId,
        experimentId,
        attemptIndex,
      )
    ).map(runningRow);
  }
  /**
   * The run a digest names, at any state, so an open sidebar outlives the run's node. A live
   * run is one of at most two on the state index. A digest is only ever handed out for a live
   * run, so a finished one is asked for by a sidebar left open as it ended, and is among the
   * runs written last: only those are looked through, however many the project has had, and
   * however often a key nobody was given is asked for.
   */
  async find(projectId: string, wanted: string, tx: Transaction): Promise<ComputeRunning | null> {
    const flying = (await this.inFlight(projectId, tx)).find((run) => run.digest === wanted);
    if (flying) return flying;
    const ended = await tx.all<ComputeRow>(
      `SELECT * FROM experiment_compute_runs WHERE project_id=? AND state NOT IN (${live})
       ORDER BY updated_at DESC,key LIMIT ?`,
      projectId,
      ENDED_FOUND,
    );
    const row = ended.find(
      (run) => digest([projectId, run.experiment_id, run.attempt_index, run.key]) === wanted,
    );
    return row ? runningRow(row) : null;
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
          experiment.version === 12 || experiment.version === 16,
          'code_source_unavailable',
          'This experiment version cannot ship code',
          409,
        );
      const objectInputs: { objectId: string; path: string }[] = [];
      const seen = new Set<string>();
      check(
        (input.inputs?.length ?? 0) <= 16,
        'invalid_compute_input',
        'At most 16 artifact inputs are supported',
      );
      for (const item of input.inputs ?? []) {
        check(
          !!this.artifacts &&
            /^[A-Za-z0-9._/-]{1,240}$/.test(item.path) &&
            !item.path.startsWith('/') &&
            !item.path.split('/').some((part) => !part || part === '.' || part === '..') &&
            !seen.has(item.path),
          'invalid_compute_input',
          'Artifact input paths must be distinct safe relative paths',
        );
        seen.add(item.path);
        const artifact = await this.artifacts.get(caller, item.artifactId, tx);
        check(
          artifact.objectId,
          'compute_input_unavailable',
          'Compute inputs must be stored large artifacts',
          409,
        );
        objectInputs.push({ objectId: artifact.objectId, path: item.path });
      }
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
        JSON.stringify({ ...input, objectInputs }),
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
        input_json: JSON.stringify({ ...input, objectInputs }),
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
        objectInputs: (
          input as ComputeInput & { objectInputs?: { objectId: string; path: string }[] }
        ).objectInputs,
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
