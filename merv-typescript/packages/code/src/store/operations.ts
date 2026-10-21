import { bootMaintenance } from '@merv/contracts/maintenance';
import { initializeManagedProjects } from './managed.js';
import {
  canonical,
  check,
  now,
  type Caller,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import {
  codeAdmissionLimitsSchema,
  type CodeAdmissionLimits,
  type CodeStoreOperation,
  type CodeStoreStatus,
} from './protocol.js';
import { parseCodeInput } from '../input.js';
import type { CodeRepositories, ObjectFormat } from './repository.js';
import { CodeReceiver } from './receive.js';
import {
  columns,
  journalled,
  received,
  StoreCore,
  type CodeStoreConfig,
  type CodeStoreHooks,
  type FaultPoint,
  type OperationRow,
} from './core.js';

export type { CodeStoreConfig, CodeStoreHooks, FaultPoint } from './core.js';

/**
 * The journal of everything that moves objects and refs in a project's repository. A database
 * transaction and a Git ref transaction cannot commit together, so each operation is a
 * `code_operations` row that walks
 *
 *   receiving → admitting → objects_durable → refs_applied → completed | failed
 *
 * and the database is the authority at every step: the files of a step can always be rebuilt
 * from the retained bundle, or are swept. The exact ref update is written down before it is
 * made, so a start after a crash either finds the receipt ref or retries that same update.
 */
export class CodeStore {
  readonly config: CodeStoreConfig;
  /** Opened and closed by their owner, which holds the writer lock. */
  readonly repositories: CodeRepositories;
  private readonly core: StoreCore;
  private readonly receiver: CodeReceiver;
  private closing?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private waker?: NodeJS.Timeout;
  private woken = false;
  private maintaining?: Promise<void>;
  private sweeping = false;
  constructor(
    state: State,
    scope: Scope,
    config: Pick<CodeStoreConfig, 'root'> & Partial<CodeStoreConfig>,
    hooks: CodeStoreHooks,
    repositories: CodeRepositories,
    /** Throws at a named boundary, which is how a test ends the process there. */
    fault?: (point: FaultPoint) => void,
  ) {
    this.core = new StoreCore(state, scope, config, hooks, repositories, fault);
    this.config = this.core.config;
    this.repositories = repositories;
    this.receiver = new CodeReceiver(this.core);
  }

  /** A project administrator or their agent, never a leased worker. */
  administrator: StoreCore['administrator'] = (...args) => this.core.administrator(...args);
  contains: CodeReceiver['contains'] = (...args) => this.receiver.contains(...args);
  stats: CodeReceiver['stats'] = (...args) => this.receiver.stats(...args);

  /** Finish what an earlier process left between two steps. */
  async initialize(): Promise<void> {
    try {
      await this.maintain();
    } catch (error) {
      await this.close();
      throw error;
    }
    this.timer = setInterval(
      () => void this.maintain().catch(() => {}),
      this.config.sweepSeconds * 1000,
    );
    this.timer.unref();
    this.waker = setInterval(() => {
      if (bootMaintenance.active || !this.woken) return;
      this.woken = false;
      void (async () => {
        await this.maintaining?.catch(() => {});
        // A wake can arrive inside a transaction that outlasts this timer interval.
        // Cross the writer barrier before reading the journal, so that declaration
        // has either committed or rolled back. No Git runs inside the barrier.
        await this.core.state.transaction(async () => {});
        await this.maintain(false);
      })().catch(() => {});
    }, 200);
    this.waker.unref();
  }

  /** An owner's journal can atomically configure admission without creating a second journal. */
  async setAdmission(
    caller: Caller,
    input: { denyGlobs: string[]; secretExemptGlobs: string[] },
    tx: Transaction,
  ): Promise<CodeAdmissionLimits> {
    this.core.assertOpen();
    this.core.state.assertTransaction(tx);
    await this.core.administrator(caller, tx);
    check(
      await this.core.project(tx, caller.projectId),
      'code_project_unbound',
      'Bind this project before configuring its repository',
      409,
    );
    const limits = parseCodeInput(codeAdmissionLimitsSchema, {
      format: 1,
      denyGlobs: input.denyGlobs,
      secretExemptGlobs: input.secretExemptGlobs,
    });
    await tx.run(
      'UPDATE code_projects SET limits_json=?,updated_at=? WHERE project_id=?',
      canonical(limits),
      now(),
      caller.projectId,
    );
    return limits;
  }

  /** The repository and its operations, for a caller the project's reads already admitted. */
  async describe(
    projectId: string,
  ): Promise<{ store: CodeStoreStatus; operations: CodeStoreOperation[] }> {
    this.core.assertOpen();
    const read = await this.core.state.read(async (sql) => ({
      project: await this.core.project(sql, projectId),
      // A prepared rebind is the window in which the binding is writable at all, so it is read
      // here with the transfers: nothing else would show that it is open, who opened it, or
      // that a later request superseded it.
      open: await sql.all<OperationRow>(
        `SELECT ${columns} FROM code_operations WHERE project_id=? AND status='prepared' AND phase IS NOT NULL AND kind IN ('initialize','import','upload','retain-ref','rebind') ORDER BY created_at,id LIMIT 100`,
        projectId,
      ),
      failed: await sql.all<OperationRow>(
        `SELECT ${columns} FROM code_operations WHERE project_id=? AND status='failed' AND phase IS NOT NULL AND kind IN ('import','upload','retain-ref','rebind') ORDER BY completed_at DESC,id LIMIT 10`,
        projectId,
      ),
      imports: await sql.all<{ result_json: string }>(
        "SELECT result_json FROM code_operations WHERE project_id=? AND kind IN ('initialize','import') AND status='completed' ORDER BY completed_at DESC,id LIMIT 50",
        projectId,
      ),
    }));
    const stored = read.project?.store_json
      ? (JSON.parse(read.project.store_json) as {
          objectFormat: ObjectFormat;
          rootOid: string;
          source: 'bundle' | 'github' | 'managed';
        })
      : null;
    return {
      store: {
        hosted: stored !== null,
        objectFormat: stored?.objectFormat ?? null,
        rootOid: stored?.rootOid ?? null,
        source: stored?.source ?? null,
        tips: read.imports.map((row) => (JSON.parse(row.result_json) as { head: string }).head),
        diskBytes: await this.repositories.usage(projectId),
        quotaBytes: this.config.quotaBytes,
        limits: this.core.limits(read.project),
      },
      operations: [...read.open, ...read.failed].map((row) => this.core.view(row)),
    };
  }

  /**
   * Take up every operation an earlier process left between two steps, give up transfers
   * nobody continues, and sweep. One that still cannot finish says why on its row; it never
   * keeps Code from starting.
   */
  async maintain(sweep = true): Promise<void> {
    if (bootMaintenance.active) return;
    // A pass that does not sweep (a wake's) is no answer to one that must: it runs after it.
    while (sweep && this.maintaining && !this.sweeping) await this.maintaining.catch(() => {});
    if (this.core.closed) return;
    this.maintaining ??= this.core.owned(async () => {
      this.sweeping = sweep;
      try {
        await initializeManagedProjects(
          this.core.state,
          this.repositories,
          this.core.hooks.changed,
        );
        await this.core.hooks.maintained?.();
        const { rows, closing, fenced } = await this.core.state.read(async (sql) => ({
          rows: await sql.all<OperationRow>(
            `SELECT ${columns} FROM code_operations WHERE status='prepared' AND phase IS NOT NULL AND kind IN ('import','upload','retain-ref') ORDER BY created_at,id`,
          ),
          closing: await sql.all<{ project_id: string; unit_id: string }>(
            "SELECT project_id,unit_id FROM code_workspaces WHERE writer_state='closing'",
          ),
          // Receiving uploads whose writer generation is no longer their unit's: the fence's
          // code_generation_stale, which a missing or blocked workspace never answers.
          fenced: await sql.all<{ id: string }>(
            "SELECT o.id FROM code_operations o WHERE o.status='prepared' AND o.kind='upload' AND o.phase='receiving' AND (SELECT w.blocked_by IS NULL AND (w.generation<>(o.payload_json::jsonb->>'generation')::bigint OR w.writer_session_id IS DISTINCT FROM o.payload_json::jsonb->>'sessionId' OR w.writer_lease_id IS DISTINCT FROM o.payload_json::jsonb->>'leaseId') FROM code_workspaces w WHERE w.project_id=o.project_id AND w.unit_id=o.payload_json::jsonb->>'unitId')",
          ),
        }));
        // An upload whose every byte reached Main before its session closed needs nothing more
        // from its machine, which may be gone: Main asks for its admission itself.
        const ended = new Set(closing.map((row) => `${row.project_id}/${row.unit_id}`));
        const whole = (row: OperationRow) =>
          row.kind === 'upload' &&
          row.phase === 'receiving' &&
          ended.has(`${row.project_id}/${row.unit_id}`) &&
          received(row);
        const stale = new Date(Date.now() - this.config.abandonSeconds * 1000).toISOString();
        // Each project in its own order; a slow admission in one holds up no other.
        const projects = new Map<string, OperationRow[]>();
        for (const row of rows)
          projects.set(row.project_id, [...(projects.get(row.project_id) ?? []), row]);
        await Promise.all(
          [...projects.values()].map(async (rows) => {
            for (const row of rows)
              if (journalled.includes(row.phase!) || whole(row))
                await this.receiver.start(row).catch(() => {});
              else if (fenced.some(({ id }) => id === row.id) && !this.receiver.jobs.has(row.id))
                await this.repositories
                  .run(row.project_id, () => this.receiver.fail(row, 'code_generation_stale', null))
                  .catch(() => {});
              else if (
                (row.updated_at ?? row.created_at) < stale &&
                !this.receiver.jobs.has(row.id)
              )
                await this.repositories
                  .run(row.project_id, () => this.receiver.fail(row, 'code_upload_abandoned', null))
                  .catch(() => {});
          }),
        );
        if (!sweep) return;
        await this.repositories.sweep(async (operationId) => {
          const row = await this.core.state.read((sql) => this.core.row(sql, operationId));
          if (!row) return undefined;
          if (row.status === 'prepared') return false;
          await this.receiver.hold(row);
          return true;
        });
      } finally {
        this.maintaining = undefined;
      }
    });
    await this.maintaining;
  }

  /**
   * Something was journalled inside another plugin's transaction. It is taken up by a timer
   * that was started outside every transaction, because work scheduled from inside one would
   * inherit it; by the time the timer looks, that transaction has committed or is gone.
   */
  wake(): void {
    this.woken = true;
  }

  /** Stop the timer, let running operations finish or end them at the deadline, release the lock. */
  close(): Promise<void> {
    return (this.closing ??= this.drain());
  }
  private async drain(): Promise<void> {
    this.core.closed = true;
    clearInterval(this.timer);
    clearInterval(this.waker);
    const timer = setTimeout(() => this.core.cancellation.abort(), this.config.drainSeconds * 1000);
    try {
      await this.maintaining?.catch(() => {});
      while (this.core.active.size || this.receiver.jobs.size)
        await Promise.allSettled([...this.core.active, ...this.receiver.jobs.values()]);
    } finally {
      clearTimeout(timer);
      this.core.cancellation.abort();
    }
  }

  /** The repository Code holds for a project once it was first stored, or null before. */
  async stored(
    sql: Sql,
    projectId: string,
  ): Promise<{ repositoryId: string; objectFormat: ObjectFormat } | null> {
    const row = await this.core.project(sql, projectId);
    if (!row?.store_json) return null;
    const { objectFormat } = JSON.parse(row.store_json) as { objectFormat: ObjectFormat };
    return { repositoryId: row.repository_id, objectFormat };
  }
}
