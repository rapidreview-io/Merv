import { canonical, check, digest, newId, MervError } from '@merv/contracts';
import type {
  CodeBaseRecord,
  CodeBaseState,
  Caller,
  Scope,
  State,
  Sql,
  Transaction,
} from '@merv/contracts';
import type { ServiceWork, ServiceWorkInput } from '@merv/sessions/types';
import { z } from 'zod';
import { parseCodeInput } from './input.js';
import { verifyResolution } from './pending-merge.js';
import { baseKey, members, planBase, type PlannedBase } from './base-plan.js';
import { MERGE_ENGINE, mergeBases } from './base-merge.js';
import type { CodeRepositories } from './store/repository.js';

/**
 * One record per distinct set of accepted commits in a project. However many units wait on
 * the same dependencies, the set is merged once: the first asker writes the record and its
 * frozen plan, everyone else reads it, and they all start from the identical commit. A
 * record is never invalidated, because the commits it names never change.
 */

interface BaseRow {
  project_id: string;
  base_key: string;
  members_json: string;
  left_key: string;
  right_key: string;
  state: CodeBaseState;
  health: 'healthy' | 'quarantined';
  result_json: string | null;
  conflict_json: string | null;
  resolution_task_id: string | null;
  resolution_error: string | null;
  resolution_commit: string | null;
  attempts: number | string;
  next_at: string | null;
  execution_epoch: number | string;
  deadline: string | null;
  sponsors_json: string | null;
  blocker: string | null;
  operator_reason: string | null;
  resume_state: CodeBaseState | null;
  updated_at: string;
}
const columns =
  'project_id,base_key,members_json,left_key,right_key,state,health,result_json,conflict_json,resolution_task_id,resolution_error,resolution_commit,attempts,next_at,execution_epoch,deadline,sponsors_json,blocker,operator_reason,resume_state,updated_at';
const RETRIES = 5;
const now = () => new Date().toISOString();

const sqlite = `
CREATE TABLE code_bases (
  project_id TEXT NOT NULL,
  base_key TEXT NOT NULL,
  members_json TEXT NOT NULL,
  left_key TEXT NOT NULL,
  right_key TEXT NOT NULL,
  engine TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting_inputs','queued','running','retry_wait','blocked_infra','awaiting_resolution','resolved','suspended','cancelled')),
  health TEXT NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy','quarantined')),
  result_json TEXT,
  conflict_json TEXT,
  resolution_task_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolution_error TEXT,
  resolution_commit TEXT,
  execution_epoch INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  sponsors_json TEXT,
  blocker TEXT,
  operator_reason TEXT,
  resume_state TEXT,
  PRIMARY KEY (project_id,base_key),
  CHECK ((state='resolved')=(result_json IS NOT NULL))
);
CREATE UNIQUE INDEX code_bases_resolution ON code_bases(resolution_task_id) WHERE resolution_task_id IS NOT NULL;
CREATE INDEX code_bases_due ON code_bases(state,next_at);
CREATE TRIGGER code_bases_plan BEFORE UPDATE ON code_bases
  WHEN NEW.project_id IS NOT OLD.project_id OR NEW.base_key IS NOT OLD.base_key OR NEW.members_json IS NOT OLD.members_json OR NEW.left_key IS NOT OLD.left_key OR NEW.right_key IS NOT OLD.right_key OR NEW.engine IS NOT OLD.engine
  BEGIN SELECT RAISE(ABORT,'The plan of a base is frozen'); END;
CREATE TRIGGER code_bases_result BEFORE UPDATE ON code_bases
  WHEN OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json
  BEGIN SELECT RAISE(ABORT,'The result of a base is recorded once'); END;
CREATE TRIGGER code_bases_task BEFORE UPDATE ON code_bases
  WHEN OLD.resolution_task_id IS NOT NULL AND NEW.resolution_task_id IS NOT OLD.resolution_task_id
  BEGIN SELECT RAISE(ABORT,'A base has one resolution task'); END;
CREATE TRIGGER code_bases_no_delete BEFORE DELETE ON code_bases
  BEGIN SELECT RAISE(ABORT,'Base records are retained'); END;
CREATE TRIGGER code_bases_acceptance BEFORE UPDATE ON code_bases
WHEN (OLD.resolution_commit IS NOT NULL AND NEW.resolution_commit IS NOT OLD.resolution_commit) OR (NEW.resolution_commit IS NOT NULL AND NEW.resolution_task_id IS NULL)
BEGIN SELECT RAISE(ABORT,'A resolution acceptance is recorded once for its task'); END;
CREATE TRIGGER code_bases_sponsors BEFORE UPDATE ON code_bases
WHEN OLD.sponsors_json IS NOT NULL AND NEW.sponsors_json IS NOT OLD.sponsors_json
BEGIN SELECT RAISE(ABORT,'Base sponsorship is frozen'); END;
`;
const postgres = `
CREATE TABLE code_bases (
  project_id TEXT NOT NULL,
  base_key TEXT NOT NULL,
  members_json TEXT NOT NULL,
  left_key TEXT NOT NULL,
  right_key TEXT NOT NULL,
  engine TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting_inputs','queued','running','retry_wait','blocked_infra','awaiting_resolution','resolved','suspended','cancelled')),
  health TEXT NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy','quarantined')),
  result_json TEXT,
  conflict_json TEXT,
  resolution_task_id TEXT,
  attempts BIGINT NOT NULL DEFAULT 0,
  next_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id,base_key),
  CHECK ((state='resolved')=(result_json IS NOT NULL))
);
CREATE UNIQUE INDEX code_bases_resolution ON code_bases(resolution_task_id) WHERE resolution_task_id IS NOT NULL;
CREATE INDEX code_bases_due ON code_bases(state,next_at);
CREATE FUNCTION code_bases_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Base records are retained'; END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.base_key IS DISTINCT FROM OLD.base_key OR NEW.members_json IS DISTINCT FROM OLD.members_json OR NEW.left_key IS DISTINCT FROM OLD.left_key OR NEW.right_key IS DISTINCT FROM OLD.right_key OR NEW.engine IS DISTINCT FROM OLD.engine THEN
    RAISE EXCEPTION 'The plan of a base is frozen';
  END IF;
  IF OLD.result_json IS NOT NULL AND NEW.result_json IS DISTINCT FROM OLD.result_json THEN
    RAISE EXCEPTION 'The result of a base is recorded once';
  END IF;
  IF OLD.resolution_task_id IS NOT NULL AND NEW.resolution_task_id IS DISTINCT FROM OLD.resolution_task_id THEN
    RAISE EXCEPTION 'A base has one resolution task';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_bases_guard BEFORE UPDATE OR DELETE ON code_bases
  FOR EACH ROW EXECUTE FUNCTION code_bases_guard();

ALTER TABLE code_bases ADD COLUMN resolution_error TEXT;
ALTER TABLE code_bases ADD COLUMN resolution_commit TEXT;
CREATE FUNCTION code_bases_acceptance_guard() RETURNS trigger AS $$ BEGIN
IF (OLD.resolution_commit IS NOT NULL AND NEW.resolution_commit IS DISTINCT FROM OLD.resolution_commit) OR (NEW.resolution_commit IS NOT NULL AND NEW.resolution_task_id IS NULL) THEN RAISE EXCEPTION 'A resolution acceptance is recorded once for its task'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_bases_acceptance BEFORE UPDATE ON code_bases FOR EACH ROW EXECUTE FUNCTION code_bases_acceptance_guard();
ALTER TABLE code_bases ADD COLUMN execution_epoch BIGINT NOT NULL DEFAULT 0;
ALTER TABLE code_bases ADD COLUMN deadline TEXT;
ALTER TABLE code_bases ADD COLUMN sponsors_json TEXT;
ALTER TABLE code_bases ADD COLUMN blocker TEXT;
ALTER TABLE code_bases ADD COLUMN operator_reason TEXT;
ALTER TABLE code_bases ADD COLUMN resume_state TEXT;
CREATE FUNCTION code_bases_sponsors_guard() RETURNS trigger AS $$ BEGIN
IF OLD.sponsors_json IS NOT NULL AND NEW.sponsors_json IS DISTINCT FROM OLD.sponsors_json THEN RAISE EXCEPTION 'Base sponsorship is frozen'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_bases_sponsors BEFORE UPDATE ON code_bases FOR EACH ROW EXECUTE FUNCTION code_bases_sponsors_guard();`;

interface CodeBaseHooks {
  /** A record reached an end, so the units that wait on it may have a base, or a new reason. */
  changed(tx: Transaction, projectId: string): Promise<void>;
  sponsors(tx: Transaction, projectId: string, members: string[]): Promise<string[]>;
  serviceWork?: ServiceWork;
  /** Journal publication in the transaction that seals the result. */
  resolved?(tx: Transaction, projectId: string, key: string, commit: string): Promise<void>;
}

export const baseControlSchema = z
  .object({
    key: z.string().regex(/^[0-9a-f]{64}$/),
    action: z.enum(['retry', 'suspend', 'resume', 'cancel', 'quarantine']),
    reason: z.string().trim().min(1).max(2000),
    requestId: z.string().min(1).max(200),
  })
  .strict();

interface Execution {
  base: CodeBaseRecord;
  input: ServiceWorkInput;
}

export class CodeBaseService {
  private readonly busy = new Map<string, Promise<void>>();
  private closed = false;
  private readonly executions = new Map<string, AbortController>();
  constructor(
    private readonly state: State,
    private readonly repositories: CodeRepositories,
    private readonly hooks: CodeBaseHooks,
    /** A deployment may pause automatic merges while keeping their records readable. */
    readonly enabled: boolean = true,
    private readonly clock: () => number = Date.now,
    private readonly deadlineMs = 120_000,
  ) {}

  private timer?: NodeJS.Timeout;

  async initialize(): Promise<void> {
    await this.state.migrate('code_bases', [{ version: 1, sql: sqlite, postgres }]);
    if (this.hooks.resolved)
      await this.state.transaction(async (tx) => {
        for (const row of await tx.all<BaseRow>(
          `SELECT ${columns} FROM code_bases WHERE state='resolved' AND health='healthy'`,
        )) {
          const base = this.record(row);
          await this.hooks.resolved!(tx, row.project_id, base.key, base.result!.commit);
        }
      });
  }

  /**
   * What a crash left queued or running, and any retry whose time has come, is picked up
   * here; a transaction that queues work also asks once it has committed.
   */
  start(everyMs = 5000): void {
    if (!this.enabled || this.timer) return;
    const tick = () =>
      void this.due()
        .then(async (projects) => {
          for (const projectId of projects) await this.work(projectId);
        })
        .catch(() => undefined);
    this.timer = setInterval(tick, everyMs);
    this.timer.unref();
    tick();
  }

  /** Asked from inside a transaction that queued work: it runs once that has committed. */
  soon(projectId: string): void {
    if (!this.enabled || this.closed) return;
    setTimeout(() => void this.work(projectId).catch(() => undefined), 50).unref();
  }

  private record(row: BaseRow): CodeBaseRecord {
    return {
      key: row.base_key,
      members: JSON.parse(row.members_json) as string[],
      left: row.left_key,
      right: row.right_key,
      state: row.state,
      quarantined: row.health === 'quarantined',
      result: row.result_json ? (JSON.parse(row.result_json) as CodeBaseRecord['result']) : null,
      conflict: row.conflict_json
        ? (JSON.parse(row.conflict_json) as CodeBaseRecord['conflict'])
        : null,
      resolutionTaskId: row.resolution_task_id,
      resolutionError: row.resolution_error,
      attempts: Number(row.attempts),
      executionEpoch: Number(row.execution_epoch),
      deadline: row.deadline,
      sponsors: JSON.parse(row.sponsors_json ?? '[]') as string[],
      blocker: row.blocker,
      operatorReason: row.operator_reason,
      updatedAt: row.updated_at,
    };
  }

  /** A pure read: the record for a set, if anybody has asked for it yet. */
  async find(
    sql: Sql,
    projectId: string,
    commits: Iterable<string>,
  ): Promise<CodeBaseRecord | null> {
    const wanted = members(commits);
    const row = await sql.get<BaseRow>(
      `SELECT ${columns} FROM code_bases WHERE project_id=? AND base_key=?`,
      projectId,
      baseKey(wanted),
    );
    if (!row) return null;
    // A key is a hash; the set it stands for is compared, never assumed.
    if (row.members_json !== JSON.stringify(wanted))
      throw new MervError('code_base_key_collision', 'A base key names a different set', 500);
    return this.record(row);
  }

  /**
   * Every base of a project, each one told what its two inputs stand for. The whole project
   * is already in hand, so an input's own record is found in this list rather than read for:
   * a project of hundreds of bases still costs the one query it always cost.
   */
  async records(sql: Sql, projectId: string): Promise<CodeBaseRecord[]> {
    const all = (
      await sql.all<BaseRow>(
        `SELECT ${columns} FROM code_bases WHERE project_id=? ORDER BY base_key`,
        projectId,
      )
    ).map((row) => this.record(row));
    const byKey = new Map(all.map((base) => [base.key, base]));
    for (const base of all) {
      // A cancelled base that never produced a result is where the plan stopped; nobody may
      // build on it again, so what it was to be made of is not worth naming.
      if (!base.result && base.state === 'cancelled') continue;
      const parent = (key: string) =>
        base.members.find((commit) => baseKey([commit]) === key) ??
        this.stands(byKey.get(key) ?? null);
      base.parents = [parent(base.left), parent(base.right)];
    }
    return all;
  }

  async forTask(sql: Sql, projectId: string, taskId: string): Promise<CodeBaseRecord | null> {
    const row = await sql.get<BaseRow>(
      `SELECT ${columns} FROM code_bases WHERE project_id=? AND resolution_task_id=?`,
      projectId,
      taskId,
    );
    return row ? this.record(row) : null;
  }

  /** Walk the frozen plan, including resolved steps; future waiters retain their prerequisite. */
  async path(sql: Sql, projectId: string, root: string): Promise<CodeBaseRecord[]> {
    const seen = new Set<string>(),
      result: CodeBaseRecord[] = [],
      queue = [root];
    for (let key = queue.pop(); key; key = queue.pop()) {
      if (seen.has(key)) continue;
      seen.add(key);
      const row = await sql.get<BaseRow>(
        `SELECT ${columns} FROM code_bases WHERE project_id=? AND base_key=?`,
        projectId,
        key,
      );
      if (!row) continue;
      const record = this.record(row);
      result.push(record);
      queue.push(record.left, record.right);
    }
    return result;
  }

  async inputs(
    sql: Sql,
    projectId: string,
    base: CodeBaseRecord,
  ): Promise<[string | null, string | null]> {
    return [
      await this.input(sql, projectId, base.left, base.members),
      await this.input(sql, projectId, base.right, base.members),
    ];
  }

  async linkTask(tx: Transaction, projectId: string, key: string, taskId: string): Promise<void> {
    this.state.assertTransaction(tx);
    await tx.run(
      'UPDATE code_bases SET resolution_task_id=?,updated_at=? WHERE project_id=? AND base_key=? AND resolution_task_id IS NULL',
      taskId,
      now(),
      projectId,
      key,
    );
  }

  /** Keep the intact acceptance as durable work; Git never runs in the caller's transaction. */
  async recordAcceptance(
    tx: Transaction,
    projectId: string,
    base: CodeBaseRecord,
    commit: string,
  ): Promise<void> {
    this.state.assertTransaction(tx);
    const recorded = await tx.run(
      "UPDATE code_bases SET resolution_commit=?,updated_at=? WHERE project_id=? AND base_key=? AND state='awaiting_resolution' AND health='healthy' AND resolution_task_id=? AND resolution_commit IS NULL",
      commit,
      now(),
      projectId,
      base.key,
      base.resolutionTaskId,
    );
    if (recorded.changes) this.soon(projectId);
  }

  /** Repeating verification after a crash finds the same immutable acceptance and ref. */
  private async acceptTask(projectId: string, base: CodeBaseRecord, commit: string): Promise<void> {
    const inputs = await this.state.read((sql) => this.inputs(sql, projectId, base));
    const env = this.repositories.environment(projectId);
    const verified =
      inputs[0] && inputs[1]
        ? await verifyResolution(this.repositories.git, env, inputs[0], inputs[1], commit)
        : { firstMerge: null, error: 'The resolution has an unresolved planned input.' };
    const error =
      verified.error ??
      (!verified.firstMerge
        ? 'The resolution has no two-parent merge on the planned first-parent lineage.'
        : null);
    let result: CodeBaseRecord['result'] = null;
    if (!error) {
      const ref = `refs/merv/bases/${base.key}`;
      const held = await this.repositories.git.run(['rev-parse', '--verify', '-q', ref], { env });
      if (held.code !== 0) await this.repositories.git.ok(['update-ref', ref, commit, ''], { env });
      else if (held.stdout.toString('utf8').trim() !== commit)
        throw new MervError('code_base_diverged', 'A base ref names another commit', 500);
      const tree = (await this.repositories.git.ok(['rev-parse', `${commit}^{tree}`], { env }))
        .toString('utf8')
        .trim();
      result = { method: 'task', commit, tree, engine: MERGE_ENGINE };
    }
    await this.state.transaction(async (tx) => {
      const updated = await tx.run(
        "UPDATE code_bases SET state=?,result_json=?,resolution_error=?,updated_at=? WHERE project_id=? AND base_key=? AND state='awaiting_resolution' AND health='healthy' AND resolution_task_id=? AND resolution_commit=? AND resolution_error IS NULL",
        result ? 'resolved' : 'awaiting_resolution',
        result ? JSON.stringify(result) : null,
        error,
        now(),
        projectId,
        base.key,
        base.resolutionTaskId,
        commit,
      );
      if (!updated.changes) return;
      if (result) await this.hooks.resolved?.(tx, projectId, base.key, result.commit);
      await this.promote(tx, projectId);
      await this.hooks.changed(tx, projectId);
    });
  }

  /**
   * Writes the record for a set, with every union its plan passes through, and answers it.
   * Whoever asks second finds the same rows: the primary key decides a race, and a plan once
   * written is never recomputed.
   */
  async ensure(
    tx: Transaction,
    projectId: string,
    commits: Iterable<string>,
  ): Promise<CodeBaseRecord> {
    this.state.assertTransaction(tx);
    const wanted = members(commits);
    const found = await this.find(tx, projectId, wanted);
    if (found) return found;
    const inside = new Set(wanted);
    const existing: PlannedBase[] = (
      await tx.all<BaseRow>(`SELECT ${columns} FROM code_bases WHERE project_id=?`, projectId)
    )
      .map((row) => this.record(row))
      .filter((record) => record.members.every((commit) => inside.has(commit)))
      .map((record) => ({
        key: record.key,
        members: record.members,
        quarantined: record.quarantined,
      }));
    const at = now();
    for (const step of planBase(wanted, existing)) {
      const ready = await this.inputsResolved(tx, projectId, [step.left, step.right]);
      await tx.run(
        `INSERT INTO code_bases (project_id,base_key,members_json,left_key,right_key,engine,state,created_at,updated_at,sponsors_json)
         VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (project_id,base_key) DO NOTHING`,
        projectId,
        step.key,
        JSON.stringify(step.members),
        step.left,
        step.right,
        MERGE_ENGINE,
        ready ? 'queued' : 'waiting_inputs',
        at,
        at,
        JSON.stringify(await this.hooks.sponsors(tx, projectId, step.members)),
      );
    }
    return (await this.find(tx, projectId, wanted))!;
  }

  /** The commit a base stands for; one that is unfinished or unhealthy stands for none. */
  private stands(record: CodeBaseRecord | null): string | null {
    return record && !record.quarantined && record.result ? record.result.commit : null;
  }

  /** The commit an input stands for: a lone commit is itself, a record is its result. */
  private async input(
    sql: Sql,
    projectId: string,
    key: string,
    of: string[],
  ): Promise<string | null> {
    const lone = of.find((commit) => baseKey([commit]) === key);
    if (lone) return lone;
    const row = await sql.get<BaseRow>(
      `SELECT ${columns} FROM code_bases WHERE project_id=? AND base_key=?`,
      projectId,
      key,
    );
    return this.stands(row ? this.record(row) : null);
  }

  private async inputsResolved(sql: Sql, projectId: string, keys: string[]): Promise<boolean> {
    for (const key of keys) {
      const row = await sql.get<{ state: string }>(
        'SELECT state FROM code_bases WHERE project_id=? AND base_key=?',
        projectId,
        key,
      );
      // No row is a lone commit, which needs nothing.
      if (row && row.state !== 'resolved') return false;
    }
    return true;
  }

  /**
   * Runs what is due in one project, one merge at a time. It is called after a transaction
   * that may have queued work and at start-up; calling it again while it runs only waits.
   */
  async work(projectId: string): Promise<void> {
    if (this.closed || !this.enabled) return;
    const running = this.busy.get(projectId);
    if (running) return await running;
    const job = this.drain(projectId).finally(() => this.busy.delete(projectId));
    this.busy.set(projectId, job);
    await job;
  }

  private async drain(projectId: string): Promise<void> {
    const accepted = await this.state.read((sql) =>
      sql.all<BaseRow>(
        `SELECT ${columns} FROM code_bases WHERE project_id=? AND state='awaiting_resolution' AND health='healthy' AND resolution_commit IS NOT NULL AND resolution_error IS NULL ORDER BY base_key`,
        projectId,
      ),
    );
    for (const row of accepted) {
      if (this.closed) return;
      await this.acceptTask(projectId, this.record(row), row.resolution_commit!);
    }
    for (;;) {
      const execution = await this.state.transaction(
        async (tx): Promise<Execution | false | null> => {
          const at = new Date(this.clock()).toISOString();
          const row = await tx.get<BaseRow>(
            `SELECT ${columns} FROM code_bases WHERE project_id=? AND health='healthy' AND
          (state='queued' OR (state='running' AND (deadline IS NULL OR deadline<=?)) OR (state='retry_wait' AND next_at<=?)) ORDER BY base_key LIMIT 1`,
            projectId,
            at,
            at,
          );
          if (!row) return null;
          const base = this.record(row);
          if (row.state === 'running' && base.deadline && this.hooks.serviceWork) {
            await this.hooks.serviceWork.settle(tx, this.execution(projectId, base), 'expired');
            await this.failed(
              tx,
              projectId,
              base,
              'The execution deadline elapsed before its result was retained.',
            );
            return false;
          }
          const input: ServiceWorkInput = {
            provider: 'code',
            projectId,
            operationId: `${projectId}:${base.key}`,
            executionEpoch: base.executionEpoch + 1,
            sponsors: base.sponsors,
            deadline: new Date(this.clock() + this.deadlineMs).toISOString(),
          };
          const admitted = await this.hooks.serviceWork?.admit(tx, input);
          if (!admitted?.admitted) {
            await tx.run(
              "UPDATE code_bases SET state='retry_wait',next_at=?,blocker=?,updated_at=? WHERE project_id=? AND base_key=?",
              new Date(this.clock() + 5000).toISOString(),
              admitted?.reason ?? 'sessions_unavailable',
              at,
              projectId,
              base.key,
            );
            await this.hooks.changed(tx, projectId);
            return false;
          }
          check(
            !admitted.settled,
            'code_base_changed',
            'A fresh execution epoch is already settled',
            409,
          );
          await tx.run(
            "UPDATE code_bases SET state='running',attempts=attempts+1,execution_epoch=?,deadline=?,blocker=NULL,updated_at=? WHERE project_id=? AND base_key=?",
            input.executionEpoch,
            input.deadline,
            at,
            projectId,
            base.key,
          );
          return {
            base: {
              ...base,
              state: 'running',
              attempts: base.attempts + 1,
              executionEpoch: input.executionEpoch,
              deadline: input.deadline,
            },
            input,
          };
        },
      );
      if (execution === null || this.closed) return;
      if (execution === false) continue;
      await this.merge(projectId, execution);
    }
  }

  private execution(projectId: string, base: CodeBaseRecord): ServiceWorkInput {
    return {
      provider: 'code',
      projectId,
      operationId: `${projectId}:${base.key}`,
      executionEpoch: base.executionEpoch,
      sponsors: base.sponsors,
      deadline: base.deadline!,
    };
  }

  private async failed(
    tx: Transaction,
    projectId: string,
    base: CodeBaseRecord,
    reason: string,
  ): Promise<void> {
    const exhausted = base.attempts >= RETRIES;
    const changed = await tx.run(
      "UPDATE code_bases SET state=?,next_at=?,blocker=?,updated_at=? WHERE project_id=? AND base_key=? AND state='running' AND execution_epoch=? AND health='healthy'",
      exhausted ? 'blocked_infra' : 'retry_wait',
      exhausted ? null : new Date(this.clock() + 1000 * 2 ** base.attempts).toISOString(),
      reason,
      now(),
      projectId,
      base.key,
      base.executionEpoch,
    );
    if (changed.changes) await this.hooks.changed(tx, projectId);
  }

  private async merge(projectId: string, { base, input }: Execution): Promise<void> {
    const abort = new AbortController();
    const executionKey = `${projectId}:${base.key}`;
    this.executions.set(executionKey, abort);
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        (async () => {
          const [left, right] = await this.state.read((sql) => this.inputs(sql, projectId, base));
          if (!left || !right)
            throw new MervError('code_base_inputs', 'An input has no result', 409);
          const env = this.repositories.environment(projectId);
          const result = await mergeBases(
            this.repositories.git,
            env,
            left,
            right,
            base.key,
            abort.signal,
          );
          if (abort.signal.aborted || this.clock() >= Date.parse(input.deadline))
            throw new MervError(
              'code_base_deadline',
              'The merge exceeded its execution deadline',
              409,
            );
          if (result.outcome !== 'conflict') {
            const ref = `refs/merv/bases/${base.key}`;
            const held = await this.repositories.git.run(['rev-parse', '--verify', '-q', ref], {
              env,
              signal: abort.signal,
            });
            if (held.code !== 0)
              await this.repositories.git.ok(['update-ref', ref, result.commit, ''], {
                env,
                signal: abort.signal,
              });
            else if (held.stdout.toString('utf8').trim() !== result.commit)
              throw new MervError('code_base_diverged', 'A base ref names another commit', 500);
          }
          return result;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              abort.abort();
              reject(
                new MervError(
                  'code_base_deadline',
                  'The merge exceeded its execution deadline',
                  409,
                ),
              );
            },
            Math.max(0, Date.parse(input.deadline) - this.clock()),
          );
        }),
      ]);
      await this.state.transaction(async (tx) => {
        const current = await tx.get<BaseRow>(
          `SELECT ${columns} FROM code_bases WHERE project_id=? AND base_key=?`,
          projectId,
          base.key,
        );
        if (
          !current ||
          current.state !== 'running' ||
          Number(current.execution_epoch) !== base.executionEpoch ||
          current.health !== 'healthy'
        ) {
          await this.hooks.serviceWork!.settle(tx, input, 'cancelled');
          return;
        }
        if (this.clock() >= Date.parse(input.deadline)) {
          await this.hooks.serviceWork!.settle(tx, input, 'expired');
          await this.failed(
            tx,
            projectId,
            base,
            'The execution deadline elapsed before its result was retained.',
          );
          return;
        }
        await this.hooks.serviceWork!.settle(tx, input, 'completed');
        const result =
          outcome.outcome === 'conflict'
            ? null
            : {
                method: 'auto',
                commit: outcome.commit,
                tree: outcome.outcome === 'merged' ? outcome.tree : null,
                engine: MERGE_ENGINE,
              };
        const changed = await tx.run(
          "UPDATE code_bases SET state=?,result_json=?,conflict_json=?,blocker=NULL,updated_at=? WHERE project_id=? AND base_key=? AND state='running' AND execution_epoch=? AND health='healthy'",
          result ? 'resolved' : 'awaiting_resolution',
          result ? JSON.stringify(result) : null,
          outcome.outcome === 'conflict'
            ? JSON.stringify({ paths: outcome.paths, messages: outcome.messages })
            : null,
          now(),
          projectId,
          base.key,
          base.executionEpoch,
        );
        if (!changed.changes) return;
        if (result) await this.hooks.resolved?.(tx, projectId, base.key, result.commit);
        await this.promote(tx, projectId);
        await this.hooks.changed(tx, projectId);
      });
    } catch (error) {
      await this.state.transaction(async (tx) => {
        const current = await tx.get<{ state: string; execution_epoch: number }>(
          'SELECT state,execution_epoch FROM code_bases WHERE project_id=? AND base_key=?',
          projectId,
          base.key,
        );
        if (
          current?.state !== 'running' ||
          Number(current.execution_epoch) !== base.executionEpoch
        ) {
          await this.hooks.serviceWork!.settle(tx, input, 'cancelled');
          return;
        }
        await this.hooks.serviceWork!.settle(
          tx,
          input,
          this.clock() >= Date.parse(input.deadline) ? 'expired' : 'failed',
        );
        await this.failed(
          tx,
          projectId,
          base,
          error instanceof Error ? error.message : 'The merge could not run.',
        );
      });
    } finally {
      clearTimeout(timer);
      abort.abort();
      this.executions.delete(executionKey);
    }
  }

  /** An operator changes disposition, never the plan or a sealed result. Receipts retain every reason. */
  async control(scope: Scope, caller: Caller, value: unknown): Promise<CodeBaseRecord> {
    caller = structuredClone(caller);
    const input = parseCodeInput(baseControlSchema, value);
    let interrupted = false;
    const result = await this.state.transaction(async (tx) => {
      await scope.require(caller, 'admin', tx);
      check(
        !caller.session,
        'session_forbidden',
        'A leased worker cannot control server work',
        403,
      );
      const { requestId, ...body } = input;
      const principal = `actor:${caller.actorId}`;
      const previous = await tx.get<{ input_hash: string; result_json: string }>(
        'SELECT input_hash,result_json FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=?',
        caller.projectId,
        principal,
        requestId,
      );
      if (previous) {
        check(
          previous.input_hash === digest(body),
          'request_conflict',
          'This request id was used with different input',
          409,
        );
        return JSON.parse(previous.result_json) as CodeBaseRecord;
      }
      const row = await tx.get<BaseRow>(
        `SELECT ${columns} FROM code_bases WHERE project_id=? AND base_key=?`,
        caller.projectId,
        input.key,
      );
      check(row, 'code_base_not_found', 'No such base in this project', 404);
      const base = this.record(row);
      const action = input.action;
      interrupted = base.state === 'running';
      check(
        action === 'quarantine' ||
          (!base.quarantined && !['resolved', 'cancelled'].includes(base.state)),
        'code_base_changed',
        'This base cannot make that transition',
        409,
      );
      check(
        action !== 'retry' || ['blocked_infra', 'retry_wait'].includes(base.state),
        'code_base_changed',
        'Only infrastructure work can be retried',
        409,
      );
      check(
        action !== 'resume' || base.state === 'suspended',
        'code_base_changed',
        'This base is not suspended',
        409,
      );
      check(
        action !== 'suspend' || base.state !== 'suspended',
        'code_base_changed',
        'This base is already suspended',
        409,
      );
      const resume = ['running', 'retry_wait'].includes(base.state) ? 'queued' : base.state;
      const state =
        action === 'quarantine'
          ? base.state
          : action === 'retry'
            ? 'queued'
            : action === 'resume'
              ? (row.resume_state ?? resume)
              : action === 'suspend'
                ? 'suspended'
                : 'cancelled';
      await tx.run(
        'UPDATE code_bases SET state=?,health=?,resume_state=?,operator_reason=?,blocker=NULL,attempts=?,next_at=NULL,execution_epoch=execution_epoch+1,updated_at=? WHERE project_id=? AND base_key=?',
        state,
        action === 'quarantine' ? 'quarantined' : row.health,
        action === 'suspend' ? resume : row.resume_state,
        input.reason,
        action === 'retry' ? 0 : base.attempts,
        now(),
        caller.projectId,
        input.key,
      );
      await this.promote(tx, caller.projectId);
      await this.hooks.changed(tx, caller.projectId);
      const result = (await this.records(tx, caller.projectId)).find((b) => b.key === input.key)!;
      const at = now();
      await tx.run(
        'INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        newId('cop'),
        caller.projectId,
        principal,
        requestId,
        'base-control',
        digest(body),
        canonical(body),
        'completed',
        canonical(result),
        at,
        at,
      );
      this.soon(caller.projectId);
      return result;
    });
    // Capacity stays reserved until the child stops. A crash here leaves a reservation
    // for Sessions to expire, while the disposition already fences every late result.
    if (interrupted) this.executions.get(`${caller.projectId}:${input.key}`)?.abort();
    return result;
  }

  /** A record whose two inputs now have results may run. */
  private async promote(tx: Transaction, projectId: string): Promise<void> {
    for (const row of await tx.all<BaseRow>(
      `SELECT ${columns} FROM code_bases WHERE project_id=? AND state='waiting_inputs' ORDER BY base_key`,
      projectId,
    ))
      if (await this.inputsResolved(tx, projectId, [row.left_key, row.right_key]))
        await tx.run(
          "UPDATE code_bases SET state='queued',updated_at=? WHERE project_id=? AND base_key=? AND state='waiting_inputs'",
          now(),
          projectId,
          row.base_key,
        );
  }

  /** Every project with work due: for a start after a crash, and for a retry whose time came. */
  async due(): Promise<string[]> {
    return (
      await this.state.read(
        async (sql) =>
          await sql.all<{ project_id: string }>(
            "SELECT DISTINCT project_id FROM code_bases WHERE health='healthy' AND (state IN ('queued','running') OR (state='retry_wait' AND next_at<=?) OR (state='awaiting_resolution' AND resolution_commit IS NOT NULL AND resolution_error IS NULL)) ORDER BY project_id",
            new Date(this.clock()).toISOString(),
          ),
      )
    ).map((row) => row.project_id);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.busy.values()]);
  }
}
