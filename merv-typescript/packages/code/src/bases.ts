import { MervError } from '@merv/contracts';
import type { State, Sql, Transaction } from '@merv/contracts';
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

export type CodeBaseState =
  | 'waiting_inputs'
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'blocked_infra'
  | 'awaiting_resolution'
  | 'resolved'
  | 'suspended'
  | 'cancelled';
export interface CodeBaseRecord {
  key: string;
  members: string[];
  left: string;
  right: string;
  state: CodeBaseState;
  quarantined: boolean;
  /** How the result was made: by this server's merge, or by the one task that resolved it. */
  result: { method: 'auto' | 'task'; commit: string; tree: string | null; engine: string } | null;
  conflict: { paths: string[]; messages: string } | null;
  resolutionTaskId: string | null;
  resolutionError: string | null;
  attempts: number;
  updatedAt: string;
}
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
  updated_at: string;
}
const columns =
  'project_id,base_key,members_json,left_key,right_key,state,health,result_json,conflict_json,resolution_task_id,resolution_error,resolution_commit,attempts,next_at,updated_at';
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
`;

export interface CodeBaseHooks {
  /** A record reached an end, so the units that wait on it may have a base, or a new reason. */
  changed(tx: Transaction, projectId: string): Promise<void>;
}

export class CodeBaseService {
  private readonly busy = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private readonly state: State,
    private readonly repositories: CodeRepositories,
    private readonly hooks: CodeBaseHooks,
    /** Automatic merging stays off until everything that recovers from a conflict is in. */
    readonly enabled: boolean,
    private readonly clock: () => number = Date.now,
  ) {}

  private timer?: NodeJS.Timeout;

  async initialize(): Promise<void> {
    await this.state.migrate('code_bases', [
      { version: 1, sql: sqlite, postgres },
      {
        version: 2,
        sql: 'ALTER TABLE code_bases ADD COLUMN resolution_error TEXT;',
        postgres: 'ALTER TABLE code_bases ADD COLUMN resolution_error TEXT;',
      },
      {
        version: 3,
        sql: `ALTER TABLE code_bases ADD COLUMN resolution_commit TEXT;
CREATE TRIGGER code_bases_acceptance BEFORE UPDATE ON code_bases
WHEN (OLD.resolution_commit IS NOT NULL AND NEW.resolution_commit IS NOT OLD.resolution_commit) OR (NEW.resolution_commit IS NOT NULL AND NEW.resolution_task_id IS NULL)
BEGIN SELECT RAISE(ABORT,'A resolution acceptance is recorded once for its task'); END;`,
        postgres: `ALTER TABLE code_bases ADD COLUMN resolution_commit TEXT;
CREATE FUNCTION code_bases_acceptance_guard() RETURNS trigger AS $$ BEGIN
IF (OLD.resolution_commit IS NOT NULL AND NEW.resolution_commit IS DISTINCT FROM OLD.resolution_commit) OR (NEW.resolution_commit IS NOT NULL AND NEW.resolution_task_id IS NULL) THEN RAISE EXCEPTION 'A resolution acceptance is recorded once for its task'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_bases_acceptance BEFORE UPDATE ON code_bases FOR EACH ROW EXECUTE FUNCTION code_bases_acceptance_guard();`,
      },
    ]);
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

  async records(sql: Sql, projectId: string): Promise<CodeBaseRecord[]> {
    return (
      await sql.all<BaseRow>(
        `SELECT ${columns} FROM code_bases WHERE project_id=? ORDER BY base_key`,
        projectId,
      )
    ).map((row) => this.record(row));
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
        `INSERT INTO code_bases (project_id,base_key,members_json,left_key,right_key,engine,state,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (project_id,base_key) DO NOTHING`,
        projectId,
        step.key,
        JSON.stringify(step.members),
        step.left,
        step.right,
        MERGE_ENGINE,
        ready ? 'queued' : 'waiting_inputs',
        at,
        at,
      );
    }
    return (await this.find(tx, projectId, wanted))!;
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
    const row = await sql.get<{ result_json: string | null; health: string }>(
      'SELECT result_json,health FROM code_bases WHERE project_id=? AND base_key=?',
      projectId,
      key,
    );
    if (!row?.result_json || row.health !== 'healthy') return null;
    return (JSON.parse(row.result_json) as { commit: string }).commit;
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
      const due = await this.state.transaction(async (tx) => {
        const row = await tx.get<BaseRow>(
          `SELECT ${columns} FROM code_bases WHERE project_id=? AND health='healthy' AND (state='queued' OR state='running' OR (state='retry_wait' AND next_at<=?)) ORDER BY base_key LIMIT 1`,
          projectId,
          new Date(this.clock()).toISOString(),
        );
        if (!row) return null;
        await tx.run(
          "UPDATE code_bases SET state='running',attempts=attempts+1,updated_at=? WHERE project_id=? AND base_key=?",
          now(),
          projectId,
          row.base_key,
        );
        return this.record({ ...row, attempts: Number(row.attempts) + 1 });
      });
      if (!due || this.closed) return;
      await this.merge(projectId, due);
    }
  }

  private async merge(projectId: string, base: CodeBaseRecord): Promise<void> {
    try {
      const [left, right] = await this.state.read(async (sql) => [
        await this.input(sql, projectId, base.left, base.members),
        await this.input(sql, projectId, base.right, base.members),
      ]);
      if (!left || !right) throw new MervError('code_base_inputs', 'An input has no result', 409);
      const env = this.repositories.environment(projectId);
      const outcome = await mergeBases(this.repositories.git, env, left, right, base.key);
      if (outcome.outcome !== 'conflict') {
        // The ref holds the objects before the record says there is a result; made again
        // after a crash, the merge is the same commit and the ref already names it.
        const ref = `refs/merv/bases/${base.key}`;
        const held = await this.repositories.git.run(['rev-parse', '--verify', '-q', ref], { env });
        if (held.code !== 0)
          await this.repositories.git.ok(['update-ref', ref, outcome.commit, ''], { env });
        else if (held.stdout.toString('utf8').trim() !== outcome.commit)
          throw new MervError('code_base_diverged', 'A base ref names another commit', 500);
      }
      await this.state.transaction(async (tx) => {
        const at = now();
        if (outcome.outcome === 'conflict')
          await tx.run(
            "UPDATE code_bases SET state='awaiting_resolution',conflict_json=?,updated_at=? WHERE project_id=? AND base_key=? AND state='running'",
            JSON.stringify({ paths: outcome.paths, messages: outcome.messages }),
            at,
            projectId,
            base.key,
          );
        else
          await tx.run(
            "UPDATE code_bases SET state='resolved',result_json=?,updated_at=? WHERE project_id=? AND base_key=? AND state='running'",
            JSON.stringify({
              method: 'auto',
              commit: outcome.commit,
              tree: outcome.outcome === 'merged' ? outcome.tree : null,
              engine: MERGE_ENGINE,
            }),
            at,
            projectId,
            base.key,
          );
        await this.promote(tx, projectId);
        await this.hooks.changed(tx, projectId);
      });
    } catch (error) {
      // Git or the disk failed, not the repository's content: it is tried again a bounded
      // number of times and then waits, visibly, for an operator.
      const exhausted = base.attempts >= RETRIES;
      await this.state.transaction(async (tx) => {
        await tx.run(
          "UPDATE code_bases SET state=?,next_at=?,conflict_json=NULL,updated_at=? WHERE project_id=? AND base_key=? AND state='running'",
          exhausted ? 'blocked_infra' : 'retry_wait',
          exhausted ? null : new Date(this.clock() + 1000 * 2 ** base.attempts).toISOString(),
          now(),
          projectId,
          base.key,
        );
        if (exhausted) await this.hooks.changed(tx, projectId);
      });
      if (!(error instanceof MervError)) throw error;
    }
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
