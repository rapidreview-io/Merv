import {
  check,
  type Scope,
  type State,
  type StoredEvent,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import type { MervRunScope, SbxMerv } from '@sandboxes/merv-host/types';
import { computeEpoch, computeProfile } from '@merv/sessions/compute';
import type { NativeMcpConnection, WorkSession } from '@merv/sessions/types';

export const sandboxRunMigrations = {
  1: `CREATE TABLE sandbox_run_intents (
    run_ref TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    account_id TEXT NOT NULL,
    work_ref TEXT NOT NULL,
    attempt_ref TEXT NOT NULL,
    target SMALLINT NOT NULL DEFAULT 0,
    retired SMALLINT NOT NULL DEFAULT 0
  );
  CREATE INDEX sandbox_run_work ON sandbox_run_intents(project_id,work_ref);`,
  2: `CREATE INDEX sandbox_run_pending ON sandbox_run_intents(run_ref) WHERE target > retired;`,
};

interface Run {
  run_ref: string;
  project_id: string;
  namespace: string;
  account_id: string;
  work_ref: string;
  attempt_ref: string;
  target: number;
  retired: number;
}
const scopeOf = (run: Run): MervRunScope => ({
  namespace: run.namespace,
  accountId: run.account_id,
  workRef: run.work_ref,
  attemptRef: run.attempt_ref,
  runRef: run.run_ref,
});

export class SandboxRuns {
  private readonly issuing = new Map<string, Promise<NativeMcpConnection[]>>();
  private reconciling?: Promise<void>;
  /** When a run whose retire failed or was put off (its work's pipelines still finishing) is
   *  tried again: each try takes the Sandboxes account's lock. */
  private readonly waits = new Map<string, number>();
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly workflows: Pick<Workflows, 'relations'>,
    private readonly host: SbxMerv,
    private readonly clock: () => number = Date.now,
  ) {}

  private row(tx: Transaction, runRef: string) {
    return tx.get<Run>('SELECT * FROM sandbox_run_intents WHERE run_ref=?', runRef);
  }

  async event(event: StoredEvent, tx: Transaction): Promise<void> {
    if (event.type === 'session.closed') {
      await tx.run(
        'UPDATE sandbox_run_intents SET target=GREATEST(target,1) WHERE project_id=? AND run_ref=?',
        event.projectId,
        event.subjectId,
      );
      return;
    }
    const work = [event.projectId, event.subjectId];
    const where = 'WHERE project_id=? AND work_ref=?';
    if (!(await tx.get(`SELECT 1 FROM sandbox_run_intents ${where}`, ...work))) return;
    // Its work ended (3) or moved to another attempt (2); else only a closed session's 1 stays.
    const i = (await this.workflows.relations(event.projectId, event.subjectId, tx))?.instance;
    const epoch = i && !i.terminal ? computeEpoch(i.data, i.revision) : null;
    await tx.run(
      `UPDATE sandbox_run_intents SET target=CASE WHEN ?::text IS NULL THEN 3
        WHEN attempt_ref<>? THEN 2 ELSE LEAST(target,1) END ${where}`,
      epoch,
      epoch,
      ...work,
    );
  }

  async launchConnections(session: Readonly<WorkSession>): Promise<NativeMcpConnection[]> {
    const refs = session.execution.references;
    if (
      computeProfile(session.execution.policy, refs.computeProfile) === 'none' ||
      refs.computeKind === undefined
    )
      return [];
    const pending = this.issuing.get(session.id);
    if (pending) return pending;
    const issue = this.issue(session).finally(() => this.issuing.delete(session.id));
    this.issuing.set(session.id, issue);
    return issue;
  }

  private async issue(session: Readonly<WorkSession>): Promise<NativeMcpConnection[]> {
    const linked = await this.host.linked(session.projectId);
    if (!linked) return [];
    const run = await this.state.transaction(async (tx) => {
      const instance = (await this.workflows.relations(session.projectId, session.instanceId, tx))
        ?.instance;
      check(
        instance &&
          instance.workflow === session.execution.workflow &&
          instance.revision === session.expectedRevision,
        'execution_replaced',
        'The assignment changed before sandbox issuance',
        409,
      );
      await tx.run(
        `INSERT INTO sandbox_run_intents(run_ref,project_id,namespace,account_id,work_ref,attempt_ref)
        VALUES(?,?,?,?,?,?) ON CONFLICT(run_ref) DO NOTHING`,
        session.id,
        session.projectId,
        linked.namespace,
        linked.account_id,
        session.instanceId,
        computeEpoch(instance.data, instance.revision),
      );
      const run = (await this.row(tx, session.id))!;
      check(run.target === 0, 'session_closed', 'The sandbox run has ended', 409);
      return run;
    });
    const caller = await this.scope.serviceActor('sessions', run.project_id);
    const connection = await this.host.launchConnection(caller, {
      ...scopeOf(run),
      expiresAt: session.hardDeadline,
    });
    const accepted = await this.state.transaction(
      async (tx) => (await this.row(tx, session.id))!.target === 0,
    );
    if (!accepted) await this.host.retireRun(caller, scopeOf(run));
    check(accepted, 'session_closed', 'The sandbox run ended during issuance', 409);
    return [connection];
  }

  async close(): Promise<void> {
    await this.reconciling?.catch(() => {});
    await Promise.allSettled(this.issuing.values());
  }

  reconcile(): Promise<void> {
    return (this.reconciling ??= this.pass().finally(() => {
      this.reconciling = undefined;
    }));
  }

  private async pass(): Promise<void> {
    const runs = await this.state.read((sql) =>
      sql.all<Run>('SELECT * FROM sandbox_run_intents WHERE target > retired'),
    );
    for (const run of runs) {
      if ((this.waits.get(run.run_ref) ?? 0) > this.clock()) continue;
      this.waits.set(run.run_ref, this.clock() + 15_000);
      try {
        const caller = await this.scope.serviceActor('sessions', run.project_id);
        const retire = (['retireRun', 'retireAttempt', 'releaseWork'] as const)[run.target - 1]!;
        if ((await this.host[retire](caller, scopeOf(run))) === false) continue;
        await this.state.transaction(async (tx) => {
          await tx.run(
            'UPDATE sandbox_run_intents SET retired=? WHERE run_ref=? AND retired<?',
            run.target,
            run.run_ref,
            run.target,
          );
        });
        this.waits.delete(run.run_ref);
      } catch {
        // The recorded scope remains pending across crashes and temporary host failures.
      }
    }
  }
}
