import { randomBytes } from 'node:crypto';
import {
  check,
  sha256Hex,
  type Json,
  type Sql,
  type State,
  type StoredEvent,
  type Transaction,
} from '@merv/contracts';
import { computeEpoch, computeProfile } from './compute-capability.js';
import type { NativeMcpConnection, Session } from '@merv/sessions/types';
import type { NativeConnections } from './native-connections.js';
import type { NativeAssignmentRow, NativeConnectionRow, NativeWorkRow } from './native-schema.js';
import type { NativeComputeProfile, NativeSandboxWork, NativeWorkKind } from './native-types.js';

export interface NativeWorkflow {
  id: string;
  namespace: string;
  state: string;
  origin_grant_id: string | null;
  attempt_ref: string | null;
  admission_profile: string | null;
  nodes?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface NativeJob {
  id: string;
  namespace: string;
  state: string;
  origin_grant_id: string | null;
  attempt_ref: string | null;
  workflow_id: string | null;
}
export interface NativeMachine {
  id: string;
  namespace: string;
  state: string;
}
export interface NativeResources {
  namespace: string;
  workflows: NativeWorkflow[];
  jobs: NativeJob[];
  sandboxes: NativeMachine[];
  next: { workflows: string | null; jobs: string | null; sandboxes: string | null };
}
type WorkReceipt = {
  work_grant_id: string;
  namespace: string;
  member_id: string;
  work_ref: string;
  work_kind: NativeWorkKind;
  revoked_at: string | null;
};
type AssignmentReceipt = {
  token_id: string;
  namespace: string;
  account_id: string;
  member_id: string;
  project_ref: string;
  work_ref: string;
  lease_ref: string;
  attempt_ref: string;
  profile: NativeComputeProfile;
  expires_at: string;
  revoked_at: string | null;
};
type Publisher = (
  work: NativeWorkRow,
  connection: NativeConnectionRow,
  workflow: NativeWorkflow,
) => Promise<void>;
const now = () => new Date().toISOString();
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const reference = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
/** A workflow name, as the workflow engine accepts one. */
export const workflowName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(value);
/**
 * The work kind the native service is sent. It knows only `task` and `experiment`; every
 * workflow other than `experiment` is sent as `task` until the service confirms other kinds.
 */
export const nativeWorkKind = (workflow: string): NativeWorkKind =>
  workflow === 'experiment' ? 'experiment' : 'task';
/** A launch or close never waits on a session that ended longer ago than any lease can run. */
const LEASE_HORIZON_MS = 8 * 24 * 3_600_000;
type InstanceRow = { workflow: string; revision: number; data_json: string };
const workflowTerminal = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);
const jobTerminal = (state: string) =>
  ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(state);
function valid(condition: unknown): asserts condition {
  check(
    condition,
    'sandbox_scope_conflict',
    'Native Sandboxes scope no longer matches this work',
    409,
  );
}
const route = (work: NativeWorkRow) => {
  valid(identifier(work.native_grant_id));
  return `/v1/delegations/works/${work.native_grant_id}`;
};

/** Stable work binding and unfinished cleanup intents, never a second native job ledger. */
export class NativeWorkService implements NativeSandboxWork {
  private publisher?: Publisher;
  private reconciling?: Promise<void>;
  constructor(
    private readonly state: State,
    private readonly connections: NativeConnections,
  ) {}
  setEvidencePublisher(publisher: Publisher): void {
    this.publisher = publisher;
  }
  async connected(projectId: string, tx?: Sql): Promise<boolean> {
    const row = await this.connections.current(projectId, tx);
    if (this.connections.config.managed && !row?.billing_subject) return false;
    return !!row && !row.revoke_pending;
  }
  private row(sql: Sql, project: string, workflow: string, work: string) {
    return sql.get<NativeWorkRow>(
      'SELECT * FROM sandbox_native_work WHERE project_id=? AND work_kind=? AND work_id=?',
      project,
      workflow,
      work,
    );
  }
  private instance(sql: Sql, project: string, id: string) {
    return sql.get<InstanceRow>(
      'SELECT workflow,revision,data_json FROM wf_instances WHERE id=? AND project_id=?',
      id,
      project,
    );
  }
  /** Binds the work to the project's current funded connection, its payer from then on. */
  async pin(project: string, workflow: string, work: string, tx: Transaction): Promise<void> {
    this.state.assertTransaction(tx);
    valid(identifier(work) && workflowName(workflow));
    const existing = await this.row(tx, project, workflow, work);
    if (existing) return;
    const connection = await this.connections.current(project, tx);
    valid(connection && !connection.revoke_pending);
    check(
      !this.connections.config.managed || connection.billing_subject,
      'sandbox_managed_required',
      'Enable Merv-managed ML in project integrations first',
      409,
    );
    await tx.run(
      'INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id) VALUES(?,?,?,?)',
      project,
      workflow,
      work,
      connection.id,
    );
  }
  /**
   * Derives the epoch from the instance as it now stands. It only moves forward: a row already
   * derived at this revision or a later one is left, so a replayed event changes nothing. A
   * changed epoch queues reconciliation, which cancels the older attempt's jobs and access.
   */
  private async advance(tx: Transaction, row: NativeWorkRow, instance: InstanceRow) {
    if (row.closed_at || (row.epoch_revision !== null && row.epoch_revision >= instance.revision))
      return;
    const epoch = computeEpoch(
      JSON.parse(instance.data_json) as Record<string, unknown>,
      instance.revision,
    );
    await tx.run(
      `UPDATE sandbox_native_work SET desired_attempt=?::text,epoch_revision=?,
      transition_pending=CASE WHEN desired_attempt IS DISTINCT FROM ?::text THEN TRUE ELSE transition_pending END
      WHERE project_id=? AND work_kind=? AND work_id=? AND (epoch_revision IS NULL OR epoch_revision<?)`,
      epoch,
      instance.revision,
      epoch,
      row.project_id,
      row.work_kind,
      row.work_id,
      instance.revision,
    );
  }
  private async close(tx: Transaction, row: NativeWorkRow) {
    await tx.run(
      `UPDATE sandbox_native_work SET closed_at=?,transition_pending=TRUE
      WHERE project_id=? AND work_kind=? AND work_id=? AND closed_at IS NULL`,
      now(),
      row.project_id,
      row.work_kind,
      row.work_id,
    );
  }
  /**
   * The `workflow.transition` consumer. Only work already pinned is touched: its epoch follows
   * the instance, and a terminal move closes it. The instance is read as it stands now, so the
   * consumer may replay any event any number of times.
   */
  async transitioned(event: StoredEvent, tx: Transaction): Promise<void> {
    this.state.assertTransaction(tx);
    const workflow = event.data.workflow;
    if (!workflowName(workflow)) return;
    const row = await this.row(tx, event.projectId, workflow, event.subjectId);
    if (!row || row.closed_at) return;
    const instance = await this.instance(tx, event.projectId, event.subjectId);
    // A retired instance's compute ends with it.
    if (!instance || instance.workflow !== workflow) return await this.close(tx, row);
    await this.advance(tx, row, instance);
    if (event.data.terminal === true && event.data.revision === instance.revision)
      await this.close(tx, row);
  }
  /** The `session.closed` consumer: the ended lease's native access is revoked. */
  async sessionClosed(event: StoredEvent, tx: Transaction): Promise<void> {
    this.state.assertTransaction(tx);
    // A session's id is its lease's id.
    const lease = event.subjectId;
    if (!identifier(lease)) return;
    // A tombstone also fences an issuance still in flight. A session that ended before any
    // lease could still be running cannot be issued anything, so replayed history adds none.
    if (
      Date.parse(event.createdAt) < Date.now() - LEASE_HORIZON_MS &&
      !(await tx.get('SELECT 1 FROM sandbox_native_assignments WHERE lease_id=?', lease))
    )
      return;
    await this.revokeAssignment(lease, tx);
  }
  /** Queue assignment access revocation, including credentials still being issued. */
  async revokeAssignment(leaseId: string, tx: Transaction): Promise<void> {
    this.state.assertTransaction(tx);
    valid(identifier(leaseId));
    await tx.run(
      'INSERT INTO sandbox_native_revoked_leases(lease_id,revoked_at) VALUES(?,?) ON CONFLICT(lease_id) DO NOTHING',
      leaseId,
      now(),
    );
    await tx.run(
      'UPDATE sandbox_native_assignments SET revoke_pending=TRUE WHERE lease_id=? AND revoked_at IS NULL',
      leaseId,
    );
    await tx.run(
      `UPDATE sandbox_native_work w SET transition_pending=TRUE WHERE EXISTS (
        SELECT 1 FROM sandbox_native_assignments a WHERE a.lease_id=?
        AND a.project_id=w.project_id AND a.work_kind=w.work_kind AND a.work_id=w.work_id)`,
      leaseId,
    );
  }
  /** Only collections verified and registered by this instance's evidence bridge. */
  async captures(project: string, instanceId: string, tx: Transaction): Promise<string[]> {
    this.state.assertTransaction(tx);
    return (
      await tx.all<{ artifact_id: string }>(
        `SELECT DISTINCT c.artifact_id FROM sandbox_native_captures c
      JOIN sandbox_native_work w ON w.connection_id=c.connection_id AND w.namespace=c.namespace
      WHERE w.project_id=? AND w.work_id=? ORDER BY c.artifact_id`,
        project,
        instanceId,
      )
    ).map((r) => r.artifact_id);
  }
  private async ensure(
    work: NativeWorkRow,
    connection: NativeConnectionRow,
  ): Promise<NativeWorkRow> {
    if (work.native_grant_id && work.namespace) return work;
    const reply = await this.connections.client.request<WorkReceipt>(
      '/v1/delegations/works',
      this.connections.bearer(connection),
      {
        method: 'POST',
        body: { work_ref: work.work_id, work_kind: nativeWorkKind(work.work_kind) },
      },
    );
    valid(
      identifier(reply.work_grant_id) &&
        identifier(reply.namespace) &&
        reply.member_id === connection.member_id &&
        reply.work_ref === work.work_id &&
        reply.work_kind === nativeWorkKind(work.work_kind) &&
        (reply.revoked_at === null || typeof reply.revoked_at === 'string'),
    );
    return this.state.transaction(async (tx) => {
      await this.connections.assertReady(work.project_id, tx);
      const current = await this.row(tx, work.project_id, work.work_kind, work.work_id);
      valid(current && current.connection_id === connection.id);
      valid(
        !current.native_grant_id ||
          (current.native_grant_id === reply.work_grant_id &&
            current.namespace === reply.namespace),
      );
      await tx.run(
        `UPDATE sandbox_native_work SET native_grant_id=?,namespace=?,closed_at=COALESCE(closed_at,?),
        transition_pending=CASE WHEN ?::text IS NULL THEN transition_pending ELSE TRUE END
        WHERE project_id=? AND work_kind=? AND work_id=?`,
        reply.work_grant_id,
        reply.namespace,
        reply.revoked_at,
        reply.revoked_at,
        work.project_id,
        work.work_kind,
        work.work_id,
      );
      return (await this.row(tx, work.project_id, work.work_kind, work.work_id))!;
    });
  }
  private async live(
    sql: Sql,
    session: Readonly<Session>,
    connectionId: string,
    workflow: string,
    attempt: string,
  ) {
    await this.connections.assertReady(session.projectId, sql);
    const work = await this.row(sql, session.projectId, workflow, session.instanceId);
    const revoked = await sql.get(
      'SELECT lease_id FROM sandbox_native_revoked_leases WHERE lease_id=?',
      session.lease.leaseId,
    );
    const connection = await sql.get<NativeConnectionRow>(
      'SELECT * FROM sandbox_native_connections WHERE id=?',
      connectionId,
    );
    valid(
      work &&
        work.connection_id === connectionId &&
        !work.closed_at &&
        work.desired_attempt === attempt &&
        !revoked &&
        connection &&
        !connection.revoked_at &&
        !connection.revoke_pending &&
        connection.project_id === session.projectId &&
        Date.parse(session.hardDeadline) > Date.now(),
    );
    return work;
  }
  /**
   * The launch-connections provider, for a leased session of any workflow. Everything comes
   * from the session: the profile from its fixed policy and `computeProfile` reference, the
   * epoch from its instance. The work is pinned on its first launch in a funded project.
   */
  async launchConnections(session: Readonly<Session>): Promise<NativeMcpConnection[]> {
    check(
      !this.state.ambient,
      'sandbox_transaction_forbidden',
      'Native issuance requires an independent connection',
      500,
    );
    const refs = session.execution.references;
    // Leases issued before compute became a capability name their scope; honour them as issued.
    if (refs.sandboxConnectionId !== undefined) return await this.launchIssued(session);
    const workflow = session.execution.workflow;
    const profile = computeProfile(session.execution.policy, refs.computeProfile);
    if (profile === 'none') return [];
    valid(
      workflowName(workflow) &&
        identifier(session.instanceId) &&
        identifier(session.lease.leaseId) &&
        session.lease.instanceId === session.instanceId &&
        session.lease.projectId === session.projectId &&
        session.lease.workflow === workflow,
    );
    const { projectId, instanceId } = session;
    // A project without a funded connection runs its work without compute, read without
    // taking the writer lock.
    const current = await this.state.read(async (sql) => {
      if (!(await this.connected(projectId, sql))) return null;
      return {
        row: await this.row(sql, projectId, workflow, instanceId),
        instance: await this.instance(sql, projectId, instanceId),
      };
    });
    if (!current) return [];
    // The lease names the instance at its current revision, or it is not live.
    const atLease = (instance: InstanceRow | undefined): instance is InstanceRow =>
      !!instance &&
      instance.workflow === workflow &&
      instance.revision === session.expectedRevision;
    valid(atLease(current.instance));
    let work = current.row;
    if (!work || work.epoch_revision === null || work.epoch_revision < current.instance.revision)
      work = await this.state.transaction(async (tx) => {
        const instance = await this.instance(tx, projectId, instanceId);
        valid(atLease(instance));
        await this.pin(projectId, workflow, instanceId, tx);
        await this.advance(tx, (await this.row(tx, projectId, workflow, instanceId))!, instance);
        return (await this.row(tx, projectId, workflow, instanceId))!;
      });
    valid(work.desired_attempt !== null);
    return await this.issue(session, work.connection_id, workflow, work.desired_attempt, profile);
  }
  private async launchIssued(session: Readonly<Session>): Promise<NativeMcpConnection[]> {
    const {
      sandboxConnectionId: connectionId,
      sandboxWorkKind: kind,
      sandboxWorkId: workId,
      sandboxAttempt: attempt,
      sandboxProfile: profile,
    } = session.execution.references;
    valid(
      identifier(connectionId) &&
        (kind === 'task' || kind === 'experiment') &&
        workId === session.instanceId &&
        reference(attempt) &&
        (profile === 'execute' || profile === 'check') &&
        identifier(session.lease.leaseId) &&
        session.lease.instanceId === session.instanceId &&
        session.lease.projectId === session.projectId &&
        session.execution.workflow === kind &&
        session.lease.workflow === kind,
    );
    const policy = session.execution.policy;
    if (policy.readOnly && policy.workspace?.mode !== 'none' && policy.workspace?.retain) return [];
    return await this.issue(session, connectionId, kind, attempt, profile);
  }
  private async issue(
    session: Readonly<Session>,
    connectionId: string,
    workflow: string,
    attempt: string,
    profile: NativeComputeProfile,
  ): Promise<NativeMcpConnection[]> {
    const kind = workflow;
    const workId = session.instanceId;
    const connection = await this.connections.get(connectionId);
    check(
      !this.connections.config.managed || connection.billing_subject,
      'sandbox_managed_required',
      'This work needs Merv-managed ML funding before execution',
      409,
    );
    let work = await this.state.read((sql) => this.live(sql, session, connectionId, kind, attempt));
    work = await this.ensure(work, connection);
    const assignment = await this.state.transaction(async (tx) => {
      await this.live(tx, session, connectionId, kind, attempt);
      const bearer = `sbxt_${randomBytes(32).toString('base64url')}`;
      await tx.run(
        `INSERT INTO sandbox_native_assignments(lease_id,session_id,project_id,work_kind,work_id,attempt_ref,profile,expires_at,credentials)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(lease_id) DO NOTHING`,
        session.lease.leaseId,
        session.id,
        session.projectId,
        kind,
        session.instanceId,
        attempt,
        profile,
        session.hardDeadline,
        this.connections.credentials.seal({ bearer }, `assignment:${session.lease.leaseId}`),
      );
      const row = (await tx.get<NativeAssignmentRow>(
        'SELECT * FROM sandbox_native_assignments WHERE lease_id=?',
        session.lease.leaseId,
      ))!;
      valid(
        row.session_id === session.id &&
          row.project_id === session.projectId &&
          row.work_id === workId &&
          row.work_kind === kind &&
          row.attempt_ref === attempt &&
          row.profile === profile &&
          row.expires_at === session.hardDeadline &&
          !row.revoked_at &&
          !row.revoke_pending,
      );
      return row;
    });
    const { bearer } = this.connections.credentials.open<{ bearer: string }>(
      assignment.credentials,
      `assignment:${assignment.lease_id}`,
    );
    const reply = await this.connections.client.request<AssignmentReceipt>(
      `${route(work)}/assignments`,
      this.connections.bearer(connection),
      {
        method: 'POST',
        body: {
          lease_ref: assignment.lease_id,
          attempt_ref: attempt,
          profile,
          token_hash: sha256Hex(bearer),
          expires_at: assignment.expires_at,
        },
      },
    );
    try {
      valid(
        identifier(reply.token_id) &&
          reply.namespace === work.namespace &&
          reply.account_id === connection.account_id &&
          reply.member_id === connection.member_id &&
          reply.project_ref === session.projectId &&
          reply.work_ref === work.work_id &&
          reply.lease_ref === assignment.lease_id &&
          reply.attempt_ref === attempt &&
          reply.profile === profile &&
          reply.revoked_at === null &&
          Date.parse(reply.expires_at) === Date.parse(assignment.expires_at),
      );
      await this.state.transaction(async (tx) => {
        await this.live(tx, session, connectionId, kind, attempt);
        const current = await tx.get<NativeAssignmentRow>(
          'SELECT * FROM sandbox_native_assignments WHERE lease_id=?',
          assignment.lease_id,
        );
        valid(
          current &&
            !current.revoked_at &&
            !current.revoke_pending &&
            (!current.native_token_id || current.native_token_id === reply.token_id),
        );
        await tx.run(
          'UPDATE sandbox_native_assignments SET native_token_id=? WHERE lease_id=?',
          reply.token_id,
          assignment.lease_id,
        );
      });
    } catch (error) {
      await this.state.transaction((tx) => this.revokeAssignment(assignment.lease_id, tx));
      await this.revoke(work, connection, assignment.lease_id).catch(() => {});
      throw error;
    }
    return [{ name: 'sandboxes', url: `${this.connections.client.origin}/mcp`, bearer }];
  }
  private async revoke(
    work: NativeWorkRow,
    connection: NativeConnectionRow,
    lease: string,
  ): Promise<void> {
    valid(identifier(lease));
    await this.connections.client.request(
      `${route(work)}/assignments/${lease}`,
      this.connections.bearer(connection),
      { method: 'DELETE' },
    );
    await this.state.transaction((tx) =>
      tx.run(
        'UPDATE sandbox_native_assignments SET revoked_at=COALESCE(revoked_at,?),revoke_pending=FALSE WHERE lease_id=?',
        now(),
        lease,
      ),
    );
  }
  /** Each stream advances independently; repeated data from an exhausted stream is ignored. */
  async resources(
    work: NativeWorkRow,
    connection: NativeConnectionRow,
  ): Promise<Omit<NativeResources, 'next'>> {
    const workflows = new Map<string, NativeWorkflow>(),
      jobs = new Map<string, NativeJob>(),
      sandboxes = new Map<string, NativeMachine>();
    let wf: string | undefined,
      job: string | undefined,
      machine: string | undefined,
      wfDone = false,
      jobDone = false,
      machineDone = false;
    const seenWf = new Set<string>(),
      seenJob = new Set<string>(),
      seenMachine = new Set<string>();
    for (let page = 0; page < 10_000; page++) {
      const reply = await this.connections.client.request<NativeResources>(
        `${route(work)}/resources`,
        this.connections.bearer(connection),
        {
          query: {
            limit: '100',
            ...(wf ? { workflows_after: wf } : {}),
            ...(job ? { jobs_after: job } : {}),
            ...(machine ? { sandboxes_after: machine } : {}),
          },
        },
      );
      valid(
        reply.namespace === work.namespace &&
          Array.isArray(reply.workflows) &&
          Array.isArray(reply.jobs) &&
          Array.isArray(reply.sandboxes) &&
          reply.next,
      );
      for (const rows of [reply.workflows, reply.jobs, reply.sandboxes])
        for (const item of rows)
          valid(
            identifier(item.id) &&
              item.namespace === work.namespace &&
              typeof item.state === 'string',
          );
      if (!wfDone) reply.workflows.forEach((item) => workflows.set(item.id, item));
      if (!jobDone) reply.jobs.forEach((item) => jobs.set(item.id, item));
      if (!machineDone) reply.sandboxes.forEach((item) => sandboxes.set(item.id, item));
      if (!wfDone) {
        const next = reply.next.workflows;
        valid(next === null || (reference(next) && !seenWf.has(next)));
        if (next === null) wfDone = true;
        else {
          seenWf.add(next);
          wf = next;
        }
      }
      if (!jobDone) {
        const next = reply.next.jobs;
        valid(next === null || (reference(next) && !seenJob.has(next)));
        if (next === null) jobDone = true;
        else {
          seenJob.add(next);
          job = next;
        }
      }
      if (!machineDone) {
        const next = reply.next.sandboxes;
        valid(next === null || (reference(next) && !seenMachine.has(next)));
        if (next === null) machineDone = true;
        else {
          seenMachine.add(next);
          machine = next;
        }
      }
      if (wfDone && jobDone && machineDone)
        return {
          namespace: work.namespace!,
          workflows: [...workflows.values()],
          jobs: [...jobs.values()],
          sandboxes: [...sandboxes.values()],
        };
    }
    valid(false);
    throw new Error('Unreachable');
  }
  reconcile(): Promise<void> {
    if (!this.reconciling)
      this.reconciling = this.reconcileAll().finally(() => {
        this.reconciling = undefined;
      });
    return this.reconciling;
  }
  private async reconcileAll(): Promise<void> {
    const rows = await this.state.read((sql) =>
      sql.all<NativeWorkRow>(`SELECT w.* FROM sandbox_native_work w JOIN sandbox_native_connections c ON c.id=w.connection_id AND c.project_id=w.project_id
      WHERE c.revoked_at IS NULL AND c.revoke_pending=FALSE
      AND (w.closed_at IS NULL OR w.transition_pending=TRUE OR w.evidence_checked_at IS NULL)
      ORDER BY w.transition_pending DESC,w.evidence_checked_at ASC NULLS FIRST,w.project_id,w.work_kind,w.work_id LIMIT 20`),
    );
    for (const row of rows) {
      try {
        await this.reconcileWork(row);
      } catch {
        await this.state.transaction((tx) =>
          tx.run(
            `UPDATE sandbox_native_work SET last_error='Native reconciliation is pending',evidence_checked_at=?
        WHERE project_id=? AND work_kind=? AND work_id=?`,
            now(),
            row.project_id,
            row.work_kind,
            row.work_id,
          ),
        );
      }
    }
  }
  private async fresh(work: NativeWorkRow): Promise<void> {
    await this.state.read((sql) => this.connections.assertReady(work.project_id, sql));
    const current = await this.state.read((sql) =>
      this.row(sql, work.project_id, work.work_kind, work.work_id),
    );
    valid(
      current &&
        current.connection_id === work.connection_id &&
        current.desired_attempt === work.desired_attempt &&
        current.closed_at === work.closed_at,
    );
  }
  private async reconcileWork(initial: NativeWorkRow): Promise<void> {
    const connection = await this.connections.get(initial.connection_id);
    const work = await this.ensure(initial, connection);
    const request = <T>(suffix: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: Json) =>
      this.connections.client.request<T>(
        `${route(work)}${suffix}`,
        this.connections.bearer(connection),
        { method, ...(body ? { body } : {}) },
      );
    await this.fresh(work);
    if (work.closed_at) await request('', 'DELETE');
    // Fence assignment admission before touching jobs. Revoked/unknown leases cannot be
    // reissued, including a POST whose response was lost and whose token id was never saved.
    const remote = await request<{ assignments: AssignmentReceipt[] }>('/assignments');
    valid(Array.isArray(remote.assignments));
    const local = await this.state.read((sql) =>
      sql.all<NativeAssignmentRow & { tombstone: string | null }>(
        `SELECT a.*,r.revoked_at AS tombstone
      FROM sandbox_native_assignments a LEFT JOIN sandbox_native_revoked_leases r ON r.lease_id=a.lease_id
      WHERE a.project_id=? AND a.work_kind=? AND a.work_id=?`,
        work.project_id,
        work.work_kind,
        work.work_id,
      ),
    );
    const byLease = new Map(local.map((a) => [a.lease_id, a]));
    const revoke = new Set(
      local
        .filter(
          (a) =>
            !a.revoked_at &&
            (work.closed_at ||
              a.revoke_pending ||
              a.tombstone ||
              a.attempt_ref !== work.desired_attempt ||
              Date.parse(a.expires_at) <= Date.now()),
        )
        .map((a) => a.lease_id),
    );
    for (const assignment of remote.assignments) {
      valid(
        identifier(assignment.lease_ref) &&
          assignment.namespace === work.namespace &&
          assignment.work_ref === work.work_id &&
          assignment.project_ref === work.project_id &&
          assignment.account_id === connection.account_id &&
          assignment.member_id === connection.member_id,
      );
      const own = byLease.get(assignment.lease_ref);
      if (
        !assignment.revoked_at &&
        (!own ||
          own.revoked_at ||
          (own.native_token_id !== null && own.native_token_id !== assignment.token_id) ||
          own.profile !== assignment.profile ||
          own.attempt_ref !== assignment.attempt_ref ||
          Date.parse(own.expires_at) !== Date.parse(assignment.expires_at) ||
          work.closed_at ||
          assignment.attempt_ref !== work.desired_attempt)
      )
        revoke.add(assignment.lease_ref);
    }
    for (const lease of revoke) {
      await this.fresh(work);
      await this.revoke(work, connection, lease);
    }
    const resources = await this.resources(work, connection);
    await this.fresh(work);
    let pending = false;
    let evidencePending = false;
    for (const workflow of resources.workflows) {
      if (this.publisher) {
        try {
          await this.publisher(work, connection, workflow);
        } catch {
          evidencePending = true;
        }
      } else if (workflow.nodes && Object.keys(workflow.nodes).length) evidencePending = true;
      const obsolete =
        work.closed_at ||
        (workflow.origin_grant_id &&
          workflow.attempt_ref &&
          workflow.attempt_ref !== work.desired_attempt);
      if (obsolete && !workflowTerminal(workflow.state)) {
        await this.fresh(work);
        await request('/actions', 'POST', { kind: 'workflow_cancel', id: workflow.id });
        pending = true;
      }
    }
    for (const job of resources.jobs) {
      const obsolete =
        work.closed_at ||
        (job.origin_grant_id && job.attempt_ref && job.attempt_ref !== work.desired_attempt);
      if (!job.workflow_id && obsolete && !jobTerminal(job.state)) {
        await this.fresh(work);
        await request('/actions', 'POST', { kind: 'job_cancel', id: job.id });
        pending = true;
      }
    }
    if (work.closed_at) {
      // All admitted workflows must finish their capture/finalizer nodes before any rental,
      // including a borrowed rental, is released. Provisioning/deleting/failed is not stopped.
      pending ||=
        resources.workflows.some((w) => !workflowTerminal(w.state)) ||
        resources.jobs.some((j) => !jobTerminal(j.state));
      if (!pending)
        for (const machine of resources.sandboxes)
          if (machine.state !== 'stopped') {
            await this.fresh(work);
            await request('/actions', 'POST', { kind: 'sandbox_delete', id: machine.id });
            pending = true;
          }
      // Native work revocation fences admission; pre-existing creates are already visible
      // as provisioning rows. Only terminal workflows/jobs plus stopped machines confirm closure.
    }
    await this.state.transaction((tx) =>
      tx.run(
        `UPDATE sandbox_native_work SET transition_pending=?,evidence_checked_at=?,last_error=?
      WHERE project_id=? AND work_kind=? AND work_id=? AND desired_attempt IS NOT DISTINCT FROM ? AND closed_at IS NOT DISTINCT FROM ?`,
        pending || evidencePending ? 'true' : 'false',
        now(),
        evidencePending ? 'Native evidence registration is pending' : null,
        work.project_id,
        work.work_kind,
        work.work_id,
        work.desired_attempt,
        work.closed_at,
      ),
    );
  }
}
