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
import type {
  SandboxCompute,
  SandboxComputeRun,
  SandboxComputeOutput,
  ComputeOutputs,
} from './types.js';
import { computeOutputsSchema } from './compute-outputs.js';
export { computeOutputsSchema } from './compute-outputs.js';

export type ComputeOwner = 'experiment' | 'task';
export interface ManagedComputeInput {
  ownerId: string;
  generation: number;
  key: string;
  provider: string;
  offerId: string;
  command: string;
  minutes: number;
  maxUsd: number;
  commandId?: string;
  outputs?: ComputeOutputs;
}
export interface ManagedComputeRow {
  project_id: string;
  owner_kind: ComputeOwner;
  owner_id: string;
  generation: number;
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
export interface ManagedComputeRunning {
  digest: string;
  ownerId: string;
  generation: number;
  key: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  minutes: number | null;
  maxUsd: number | null;
  cost: SandboxComputeRun['cost'];
  exit: number | null;
  reason: string | null;
  overdue: boolean;
}
export interface ComputeOwnerPolicy {
  /** Called inside the admission transaction; rejects stale or non-work callers. */
  authorize(
    caller: Caller,
    ownerId: string,
    generation: number,
    tx: Transaction,
    commandId?: string,
  ): Promise<void>;
  /** Work state, independent of the worker lease; replacement workers preserve live jobs. */
  active(row: ManagedComputeRow, tx: Transaction): Promise<boolean>;
  source?(
    row: ManagedComputeRow,
    commandId: string,
  ): Promise<{ bytes: Uint8Array; sha256: string } | undefined>;
}

const live = "'submitting','running','cancelling'";
const terminal = new Set(['completed', 'failed', 'cancelled']);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const stored = (text: string | null) => {
  try {
    return object(text ? JSON.parse(text) : null);
  } catch {
    return {};
  }
};
const readCost = (text: string | null): SandboxComputeRun['cost'] => {
  const cost = stored(text);
  if (typeof cost.amount !== 'string' || typeof cost.currency !== 'string') return null;
  return {
    amount: cost.amount,
    currency: cost.currency,
    basis:
      cost.basis === 'full_lease_quote' || cost.basis === 'job_runtime_estimate'
        ? cost.basis
        : 'unclassified_estimate',
  };
};
export const publicComputeRow = (row: ManagedComputeRow) => ({
  key: row.key,
  runId: row.run_id ?? row.key,
  generation: row.generation,
  state: row.state,
  cost: readCost(row.cost),
  ...(row.result ? JSON.parse(row.result) : {}),
  ...(stored(row.input_json).commandId ? { commit: stored(row.input_json).commandId } : {}),
});
const runningRow = (row: ManagedComputeRow): ManagedComputeRunning => {
  const input = stored(row.input_json),
    outcome = stored(row.result),
    result = object(outcome.result);
  return {
    digest: digest([row.project_id, row.owner_id, row.generation, row.key]),
    ownerId: row.owner_id,
    generation: row.generation,
    key: row.key,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    minutes: typeof input.minutes === 'number' ? input.minutes : null,
    maxUsd: typeof input.maxUsd === 'number' ? input.maxUsd : null,
    cost: readCost(row.cost),
    exit: Number.isInteger(result.exit) ? (result.exit as number) : null,
    reason: typeof outcome.reason === 'string' ? outcome.reason : null,
    overdue:
      (row.state === 'running' || row.state === 'cancelling') &&
      typeof input.minutes === 'number' &&
      Date.now() - Date.parse(row.created_at) > input.minutes * 60_000 + 780_000 &&
      Date.now() - Date.parse(row.updated_at) > 180_000,
  };
};

/** Run before publishing either owner service; merge legacy experiment rows after its migration. */
export async function initializeManagedCompute(
  state: State,
  importExperiments = false,
): Promise<void> {
  await state.migrate('sandboxes-compute', [
    {
      version: 1,
      sql: `
CREATE TABLE managed_compute_runs (
 project_id TEXT NOT NULL,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,generation BIGINT NOT NULL,
 key TEXT NOT NULL,input_hash TEXT NOT NULL,input_json TEXT NOT NULL,run_id TEXT,
 state TEXT NOT NULL,cost TEXT,result TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_kind,owner_id,generation,key));
CREATE INDEX managed_compute_project_state ON managed_compute_runs(project_id,state);
`,
    },
  ]);
  if (importExperiments)
    await state.transaction((tx) =>
      tx.run(`
    INSERT INTO managed_compute_runs(project_id,owner_kind,owner_id,generation,key,input_hash,input_json,run_id,state,cost,result,created_by,created_at,updated_at)
    SELECT project_id,'experiment',experiment_id,attempt_index,key,input_hash,input_json,run_id,state,cost,result,created_by,created_at,updated_at
    FROM experiment_compute_runs ON CONFLICT DO NOTHING`),
    );
}

/** Shared, project-scoped compute admission and recovery. The adapter owns the external workflow. */
export class ManagedCompute {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closed = false;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly adapter: SandboxCompute,
    private readonly owner: ComputeOwner,
    private readonly policy: ComputeOwnerPolicy,
  ) {
    // Both owner services initialize the shared schema before publishing themselves.
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
        `SELECT p.created_at FROM projects p JOIN user_project_requests r ON r.project_id=p.id WHERE p.id=? LIMIT 1`,
        projectId,
      );
      return !!row && Date.parse(row.created_at) >= Date.parse(this.adapter.since);
    };
    return tx ? read(tx) : this.state.transaction(read);
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
  async rows(projectId: string, ownerId: string, generation: number, tx: Transaction) {
    return (
      await tx.all<ManagedComputeRow>(
        'SELECT * FROM managed_compute_runs WHERE project_id=? AND owner_kind=? AND owner_id=? AND generation=? ORDER BY created_at,key',
        projectId,
        this.owner,
        ownerId,
        generation,
      )
    ).map(publicComputeRow);
  }
  async history(projectId: string, ownerId: string, tx: Transaction) {
    return (
      await tx.all<ManagedComputeRow>(
        'SELECT * FROM managed_compute_runs WHERE project_id=? AND owner_kind=? AND owner_id=? ORDER BY created_at DESC,key LIMIT 100',
        projectId,
        this.owner,
        ownerId,
      )
    ).map(publicComputeRow);
  }
  async historySummary(projectId: string, ownerId: string, tx: Transaction) {
    const rows = await this.history(projectId, ownerId, tx);
    return rows.map((row) => {
      const result = object(row.result);
      return {
        key: row.key,
        runId: row.runId,
        generation: row.generation,
        state: row.state,
        cost: row.cost,
        ...(Number.isInteger(result.exit) ? { exit: result.exit } : {}),
        ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
      };
    });
  }
  async status(
    projectId: string,
    ownerId: string,
    runId: string,
    tx: Transaction,
    generation?: number,
  ) {
    return publicComputeRow(await this.lookup(projectId, ownerId, runId, tx, generation));
  }
  private async lookup(
    projectId: string,
    ownerId: string,
    runId: string,
    tx: Transaction,
    generation?: number,
  ): Promise<ManagedComputeRow> {
    const row = await tx.get<ManagedComputeRow>(
      'SELECT * FROM managed_compute_runs WHERE project_id=? AND owner_kind=? AND owner_id=? AND (?::bigint IS NULL OR generation=?) AND (run_id=? OR key=?) ORDER BY generation DESC LIMIT 1',
      projectId,
      this.owner,
      ownerId,
      generation ?? null,
      generation ?? null,
      runId,
      runId,
    );
    check(row, 'compute_not_found', 'Compute run not found in this work item', 404);
    return row;
  }
  async output(caller: Caller, ownerId: string, runId: string, name: string, generation?: number) {
    const output = await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const row = await this.status(caller.projectId, ownerId, runId, tx, generation);
      const found = (row.outputs as SandboxComputeOutput[] | undefined)?.find(
        (item) => item.name === name,
      );
      check(
        found,
        'compute_output_not_found',
        'No captured file with this name exists in this run',
        404,
      );
      return found;
    });
    check(
      this.adapter.download,
      'compute_unavailable',
      'Compute output downloads are unavailable',
      503,
    );
    return { ...output, ...(await this.adapter.download(caller.projectId, output.objectId)) };
  }
  async logs(caller: Caller, ownerId: string, runId: string, generation?: number) {
    const row = await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return this.lookup(caller.projectId, ownerId, runId, tx, generation);
    });
    check(this.adapter.logs, 'compute_unavailable', 'Compute logs are unavailable', 503);
    // An unsubmitted key is not a provider workflow id. Never dispatch it as one.
    if (!row.run_id) return { state: row.state, mode: 'pending' };
    return this.adapter.logs(caller.projectId, row.run_id);
  }
  async inFlight(projectId: string, tx: Transaction): Promise<ManagedComputeRunning[]> {
    return (
      await tx.all<ManagedComputeRow>(
        `SELECT * FROM managed_compute_runs WHERE project_id=? AND owner_kind=? AND state IN (${live}) ORDER BY created_at,key`,
        projectId,
        this.owner,
      )
    ).map(runningRow);
  }
  async recent(
    projectId: string,
    ownerId: string,
    generation: number,
    tx: Transaction,
  ): Promise<ManagedComputeRunning[]> {
    return (
      await tx.all<ManagedComputeRow>(
        `SELECT * FROM managed_compute_runs WHERE project_id=? AND owner_kind=? AND owner_id=? AND (generation=? OR state IN (${live})) ORDER BY created_at,key`,
        projectId,
        this.owner,
        ownerId,
        generation,
      )
    ).map(runningRow);
  }
  async find(
    projectId: string,
    wanted: string,
    tx: Transaction,
  ): Promise<ManagedComputeRunning | null> {
    const flying = (await this.inFlight(projectId, tx)).find((run) => run.digest === wanted);
    if (flying) return flying;
    const ended = await tx.all<ManagedComputeRow>(
      `SELECT * FROM managed_compute_runs WHERE project_id=? AND owner_kind=? AND state NOT IN (${live}) ORDER BY updated_at DESC,key LIMIT ?`,
      projectId,
      this.owner,
      100,
    );
    return ended.map(runningRow).find((run) => run.digest === wanted) ?? null;
  }
  async run(caller: Caller, input: ManagedComputeInput) {
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
    check(
      input.outputs === undefined || computeOutputsSchema.safeParse(input.outputs).success,
      'invalid_compute_input',
      'Compute outputs must name bounded absolute file paths',
      400,
    );
    return this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      await this.policy.authorize(caller, input.ownerId, input.generation, tx, input.commandId);
      check(
        await this.entitled(caller.projectId, tx),
        'compute_not_entitled',
        'This project has no ML allowance',
        403,
      );
      const fingerprint = digest(
        this.owner === 'experiment'
          ? {
              experimentId: input.ownerId,
              attemptIndex: input.generation,
              key: input.key,
              provider: input.provider,
              offerId: input.offerId,
              command: input.command,
              minutes: input.minutes,
              maxUsd: input.maxUsd,
              ...(input.commandId ? { commandId: input.commandId } : {}),
              ...(input.outputs ? { outputs: input.outputs } : {}),
            }
          : input,
      );
      const old = await tx.get<ManagedComputeRow>(
        'SELECT * FROM managed_compute_runs WHERE project_id=? AND owner_kind=? AND owner_id=? AND generation=? AND key=?',
        caller.projectId,
        this.owner,
        input.ownerId,
        input.generation,
        input.key,
      );
      if (old) {
        check(
          old.input_hash === fingerprint,
          'compute_key_conflict',
          'This compute key has different input',
          409,
        );
        return publicComputeRow(old);
      }
      const at = now();
      await tx.run(
        `INSERT INTO managed_compute_runs(project_id,owner_kind,owner_id,generation,key,input_hash,input_json,run_id,state,cost,result,created_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,NULL,'submitting',NULL,NULL,?,?,?)`,
        caller.projectId,
        this.owner,
        input.ownerId,
        input.generation,
        input.key,
        fingerprint,
        JSON.stringify(input),
        caller.actorId,
        at,
        at,
      );
      return {
        key: input.key,
        runId: input.key,
        generation: input.generation,
        state: 'submitting',
        cost: null,
      };
    });
  }
  async cancel(caller: Caller, ownerId: string, runId: string) {
    return this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const row = await tx.get<ManagedComputeRow>(
        `SELECT * FROM managed_compute_runs WHERE project_id=? AND owner_kind=? AND owner_id=? AND (run_id=? OR key=?) ORDER BY generation DESC LIMIT 1`,
        caller.projectId,
        this.owner,
        ownerId,
        runId,
        runId,
      );
      check(row, 'compute_not_found', 'Compute run not found in this work item', 404);
      await this.policy.authorize(caller, ownerId, row.generation, tx);
      if (!terminal.has(row.state)) {
        await tx.run(
          `UPDATE managed_compute_runs SET state='cancelling',updated_at=? WHERE owner_kind=? AND owner_id=? AND generation=? AND key=?`,
          now(),
          this.owner,
          ownerId,
          row.generation,
          row.key,
        );
        row.state = 'cancelling';
      }
      return publicComputeRow(row);
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
      sql.all<ManagedComputeRow>(
        `SELECT * FROM managed_compute_runs WHERE owner_kind=? AND state IN (${live}) ORDER BY updated_at LIMIT 20`,
        this.owner,
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
    row: ManagedComputeRow,
    state: string,
    runId: string | null,
    cost: SandboxComputeRun['cost'],
    result: object | null,
  ): Promise<void> {
    await this.state.transaction((tx) =>
      tx.run(
        `UPDATE managed_compute_runs SET state=CASE WHEN state='cancelling' AND ?='running' THEN 'cancelling' ELSE ? END,
       run_id=COALESCE(?,run_id),cost=COALESCE(?,cost),result=COALESCE(?,result),updated_at=?
       WHERE owner_kind=? AND owner_id=? AND generation=? AND key=?`,
        state,
        state,
        runId,
        cost ? JSON.stringify(cost) : null,
        result ? JSON.stringify(result) : null,
        now(),
        this.owner,
        row.owner_id,
        row.generation,
        row.key,
      ),
    );
  }
  private async advance(row: ManagedComputeRow): Promise<void> {
    const active = await this.state.transaction((tx) => this.policy.active(row, tx));
    if (!active || row.state === 'cancelling') {
      if (row.run_id) await this.adapter.cancel(row.project_id, row.run_id);
      if (!row.run_id || !(JSON.parse(row.input_json) as ManagedComputeInput).outputs) {
        await this.update(row, 'cancelled', row.run_id, null, null);
        return;
      }
      // Capture and release finish asynchronously, even after owner handoff or cancellation.
      // Keep polling these runs so the saved files remain reachable after the lease closes.
      await this.update(row, 'cancelling', row.run_id, null, null);
    } else if (row.state === 'submitting') {
      const input = JSON.parse(row.input_json) as ManagedComputeInput;
      const source = input.commandId ? await this.policy.source?.(row, input.commandId) : undefined;
      if (input.commandId && !source)
        throw new MervError('code_source_unavailable', 'Code source is unavailable', 409);
      const runId = await this.adapter.submit(row.project_id, {
        experimentId: row.owner_id,
        ...input,
        idempotencyKey: digest([row.project_id, row.owner_id, row.generation, row.key]),
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
        ...(status.outputs ? { outputs: status.outputs, outputState: status.outputState } : {}),
        ...(status.failureStage ? { failureStage: status.failureStage } : {}),
      });
    else if (status.cost) await this.update(row, 'running', row.run_id, status.cost, null);
  }
}
