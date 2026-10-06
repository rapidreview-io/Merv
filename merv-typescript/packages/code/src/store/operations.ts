import { initializeManagedProjects } from './managed.js';
import { canonical, check, now, type Caller, type Sql, type Transaction } from '@merv/contracts';
import {
  codeAdmissionLimitsSchema,
  type CodeAdmissionLimits,
  type CodeStoreOperation,
  type CodeStoreStatus,
} from './protocol.js';
import { parseCodeInput } from '../input.js';
import { type ObjectFormat } from './repository.js';
import { CodeRebinder } from './rebind.js';
import { columns, journalled, kinds, serial, type OperationRow } from './receive.js';

export { defaultStoreConfig } from './receive.js';
export type { CodeImportRemote, CodeStoreConfig, CodeStoreHooks, FaultPoint } from './receive.js';
export type { CodeExport } from './export.js';

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
export class CodeStore extends CodeRebinder {
  protected closing?: Promise<void>;
  protected timer?: NodeJS.Timeout;
  protected waker?: NodeJS.Timeout;
  protected woken = false;
  protected maintaining?: Promise<void>;

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
      if (!this.woken) return;
      this.woken = false;
      void (async () => {
        await this.maintaining?.catch(() => {});
        // A wake can arrive inside a transaction that outlasts this timer interval.
        // Cross the writer barrier before reading the journal, so that declaration
        // has either committed or rolled back. No Git runs inside the barrier.
        await this.state.transaction(async () => {});
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
    this.assertOpen();
    this.state.assertTransaction(tx);
    await this.administrator(caller, tx);
    check(
      await this.project(tx, caller.projectId),
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
    this.assertOpen();
    const read = await this.state.read(async (sql) => ({
      project: await this.project(sql, projectId),
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
        limits: this.limits(read.project),
      },
      operations: [...read.open, ...read.failed].map((row) => this.view(row)),
    };
  }

  /**
   * Take up every operation an earlier process left between two steps, give up transfers
   * nobody continues, and sweep. One that still cannot finish says why on its row; it never
   * keeps Code from starting.
   */
  async maintain(sweep = true): Promise<void> {
    if (this.closed) return;
    this.maintaining ??= this.owned(async () => {
      try {
        await initializeManagedProjects(this.state, this.repositories, this.hooks.imported);
        await this.hooks.maintained?.();
        const rows = await this.state.read(
          async (sql) =>
            await sql.all<OperationRow>(
              `SELECT ${columns} FROM code_operations WHERE status='prepared' AND phase IS NOT NULL ORDER BY created_at,id`,
            ),
        );
        const stale = new Date(Date.now() - this.config.abandonSeconds * 1000).toISOString();
        // Each project in its own order; a slow admission in one holds up no other.
        const projects = new Map<string, OperationRow[]>();
        for (const row of rows.filter((row) => kinds.includes(row.kind)))
          projects.set(row.project_id, [...(projects.get(row.project_id) ?? []), row]);
        await Promise.all(
          [...projects.values()].map(async (rows) => {
            for (const row of rows)
              if (journalled.includes(row.phase!)) await this.start(row).catch(() => {});
              else if (row.kind === 'upload' && !this.jobs.has(row.id) && (await this.stale(row)))
                await this.repositories
                  .run(row.project_id, () => this.fail(row, 'code_generation_stale', null))
                  .catch(() => {});
              else if ((row.updated_at ?? row.created_at) < stale && !this.jobs.has(row.id))
                await this.repositories
                  .run(row.project_id, () => this.fail(row, 'code_upload_abandoned', null))
                  .catch(() => {});
          }),
        );
        if (!sweep) return;
        await this.repositories.sweep(
          async (operationId) => {
            const row = await this.state.read((sql) => this.row(sql, operationId));
            if (!row) return undefined;
            if (row.status === 'prepared') return false;
            await this.hold(row);
            return true;
          },
          undefined,
          (exportId, take) =>
            serial(this.exporting, exportId, async () => {
              if (await take()) this.exports.delete(exportId);
            }),
        );
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
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.waker);
    const timer = setTimeout(() => this.cancellation.abort(), this.config.drainSeconds * 1000);
    try {
      await this.maintaining?.catch(() => {});
      await Promise.allSettled([...this.parts.values()]);
      while (this.active.size || this.jobs.size)
        await Promise.allSettled([...this.active, ...this.jobs.values()]);
    } finally {
      clearTimeout(timer);
      this.cancellation.abort();
    }
  }

  /** The repository Code holds for a project once it was first stored, or null before. */
  async stored(
    sql: Sql,
    projectId: string,
  ): Promise<{ repositoryId: string; objectFormat: ObjectFormat } | null> {
    const row = await this.project(sql, projectId);
    if (!row?.store_json) return null;
    const { objectFormat } = JSON.parse(row.store_json) as { objectFormat: ObjectFormat };
    return { repositoryId: row.repository_id, objectFormat };
  }
}
