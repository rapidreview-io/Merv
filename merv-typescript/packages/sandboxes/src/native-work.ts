import { randomBytes } from 'node:crypto';
import {
  check,
  forRead,
  sha256Hex,
  type Json,
  type Sql,
  type State,
  type StoredEvent,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import { computeEpoch, computeProfile, type ComputeProfile } from './compute-capability.js';
import type { NativeMcpConnection, Session } from '@merv/sessions/types';
import type { NativeConnections } from './native-connections.js';
import type { NativeAssignmentRow, NativeConnectionRow, NativeWorkRow } from './native-schema.js';

/** The profiles a native assignment is issued with; `none` issues no assignment. */
type NativeComputeProfile = Exclude<ComputeProfile, 'none'>;

export interface NativeWorkflow {
  id: string;
  namespace: string;
  state: string;
  origin_grant_id: string | null;
  attempt_ref: string | null;
  admission_profile: string | null;
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
  work_kind: string;
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
/** A launch or close never waits on a session that ended longer ago than any lease can run. */
const LEASE_HORIZON_MS = 8 * 24 * 3_600_000;
/**
 * Open work at rest under a live assignment is looked at this often, not on every pass, and so
 * is work whose only unfinished business is evidence that failed to register.
 */
const RESTING_MS = 30_000;
type Instance = { workflow: string; revision: number; data: Record<string, unknown> };
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
export class NativeWorkService {
  private reconciling?: Promise<void>;
  constructor(
    private readonly state: State,
    private readonly connections: NativeConnections,
    private readonly workflows: Pick<Workflows, 'relations'>,
    /** Registers an ended workflow's captures as evidence (NativeEvidence.publish). */
    private readonly publisher: Publisher,
  ) {}
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
  private async instance(tx: Transaction, project: string, id: string) {
    return (await this.workflows.relations(project, id, tx))?.instance;
  }
  /**
   * Binds the work to the project's current funded connection, its payer from then on, under
   * the native work kind its owner declared.
   */
  async pin(
    project: string,
    workflow: string,
    work: string,
    kind: string,
    tx: Transaction,
  ): Promise<void> {
    this.state.assertTransaction(tx);
    valid(identifier(work) && workflowName(workflow) && identifier(kind));
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
      'INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,native_kind) VALUES(?,?,?,?,?)',
      project,
      workflow,
      work,
      connection.id,
      kind,
    );
  }
  /**
   * Derives the epoch from the instance as it now stands. It only moves forward: a row already
   * derived at this revision or a later one is left, so a replayed event changes nothing. A
   * changed epoch queues reconciliation, which cancels the older attempt's jobs and access.
   */
  private async advance(tx: Transaction, row: NativeWorkRow, instance: Instance) {
    if (row.closed_at || (row.epoch_revision !== null && row.epoch_revision >= instance.revision))
      return;
    const epoch = computeEpoch(instance.data, instance.revision);
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
  /**
   * Only collections verified and registered by this instance's evidence bridge (never a Capture
   * refused as one that can never register), and with
   * `attempts` only those captured under one of these epochs. A capture registered before
   * captures recorded their epoch answers for any.
   */
  async captures(
    project: string,
    instanceId: string,
    tx: Transaction,
    attempts?: string[],
  ): Promise<string[]> {
    this.state.assertTransaction(tx);
    return (
      await tx.all<{ artifact_id: string }>(
        `SELECT DISTINCT c.artifact_id FROM sandbox_native_captures c
      JOIN sandbox_native_work w ON w.connection_id=c.connection_id AND w.namespace=c.namespace
      WHERE c.artifact_id IS NOT NULL AND w.project_id=? AND w.work_id=? AND (CAST(? AS TEXT) IS NULL OR c.attempt_ref IS NULL
      OR c.attempt_ref IN (SELECT jsonb_array_elements_text(CAST(? AS jsonb)))) ORDER BY c.artifact_id`,
        project,
        instanceId,
        attempts ? 'some' : null,
        JSON.stringify(attempts ?? []),
      )
    ).map((r) => r.artifact_id);
  }
  private async ensure(
    work: NativeWorkRow,
    connection: NativeConnectionRow,
  ): Promise<NativeWorkRow> {
    if (work.native_grant_id && work.namespace) return work;
    const kind = work.native_kind;
    valid(identifier(kind));
    const reply = await this.connections.call<WorkReceipt>(connection, '/v1/delegations/works', {
      method: 'POST',
      body: { work_ref: work.work_id, work_kind: kind },
    });
    valid(
      identifier(reply.work_grant_id) &&
        identifier(reply.namespace) &&
        reply.member_id === connection.member_id &&
        reply.work_ref === work.work_id &&
        reply.work_kind === kind &&
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
   * from the session: the native work kind its owner declares in the `computeKind` reference,
   * the profile from its fixed policy and `computeProfile` reference, the epoch from its
   * instance. The work is pinned on its first launch in a funded project. An assignment that
   * declares no kind binds no compute.
   */
  async launchConnections(session: Readonly<Session>): Promise<NativeMcpConnection[]> {
    check(
      !this.state.ambient,
      'sandbox_transaction_forbidden',
      'Native issuance requires an independent connection',
      500,
    );
    const workflow = session.execution.workflow;
    const refs = session.execution.references;
    const profile = computeProfile(session.execution.policy, refs.computeProfile);
    if (profile === 'none') return [];
    const { projectId, instanceId } = session;
    // A project without a funded connection runs its work without compute, read without
    // taking the writer lock.
    const current = await forRead(this.state, async (tx) => {
      if (!(await this.connected(projectId, tx))) return null;
      return {
        row: await this.row(tx, projectId, workflow, instanceId),
        instance: await this.instance(tx, projectId, instanceId),
      };
    });
    // A session offered before units declared a kind keeps the kind its work was pinned with.
    const kind = refs.computeKind ?? current?.row?.native_kind ?? undefined;
    if (!current || kind === undefined) return [];
    valid(
      typeof kind === 'string' &&
        identifier(kind) &&
        workflowName(workflow) &&
        identifier(session.instanceId) &&
        identifier(session.lease.leaseId) &&
        session.lease.instanceId === session.instanceId &&
        session.lease.projectId === session.projectId &&
        session.lease.workflow === workflow,
    );
    // The lease names the instance at its current revision, or it is not live.
    const atLease = (instance: Instance | undefined): instance is Instance =>
      !!instance &&
      instance.workflow === workflow &&
      instance.revision === session.expectedRevision;
    valid(atLease(current.instance));
    let work = current.row;
    if (!work || work.epoch_revision === null || work.epoch_revision < current.instance.revision)
      work = await this.state.transaction(async (tx) => {
        const instance = await this.instance(tx, projectId, instanceId);
        valid(atLease(instance));
        await this.pin(projectId, workflow, instanceId, kind, tx);
        await this.advance(tx, (await this.row(tx, projectId, workflow, instanceId))!, instance);
        return (await this.row(tx, projectId, workflow, instanceId))!;
      });
    valid(work.desired_attempt !== null);
    return await this.issue(session, work.connection_id, workflow, work.desired_attempt, profile);
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
    const reply = await this.connections.call<AssignmentReceipt>(
      connection,
      `${route(work)}/assignments`,
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
      // Only a real mismatch fences the lease; a transient failure leaves it for a retry.
      if ((error as { code?: string }).code !== 'sandbox_scope_conflict') throw error;
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
    await this.connections.call(connection, `${route(work)}/assignments/${lease}`, {
      method: 'DELETE',
    });
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
    const streams = (['workflows', 'jobs', 'sandboxes'] as const).map((key) => ({
      key,
      param: `${key}_after`,
      found: new Map<string, NativeResources[typeof key][number]>(),
      seen: new Set<string>(),
      after: undefined as string | undefined,
      done: false,
    }));
    for (let page = 0; page < 10_000; page++) {
      const reply = await this.connections.call<NativeResources>(
        connection,
        `${route(work)}/resources`,
        {
          query: {
            limit: '100',
            ...Object.fromEntries(
              streams.flatMap((stream) => (stream.after ? [[stream.param, stream.after]] : [])),
            ),
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
      for (const stream of streams)
        for (const item of reply[stream.key])
          valid(
            identifier(item.id) &&
              item.namespace === work.namespace &&
              typeof item.state === 'string',
          );
      for (const stream of streams.filter((stream) => !stream.done))
        reply[stream.key].forEach((item) => stream.found.set(item.id, item));
      for (const stream of streams.filter((stream) => !stream.done)) {
        const next = reply.next[stream.key];
        valid(next === null || (reference(next) && !stream.seen.has(next)));
        if (next === null) stream.done = true;
        else {
          stream.seen.add(next);
          stream.after = next;
        }
      }
      if (streams.every((stream) => stream.done)) {
        const [workflows, jobs, sandboxes] = streams.map((stream) => [...stream.found.values()]);
        return {
          namespace: work.namespace!,
          workflows: workflows as NativeWorkflow[],
          jobs: jobs as NativeJob[],
          sandboxes: sandboxes as NativeMachine[],
        };
      }
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
      sql.all<NativeWorkRow>(
        `SELECT w.* FROM sandbox_native_work w JOIN sandbox_native_connections c ON c.id=w.connection_id AND c.project_id=w.project_id
      WHERE c.revoked_at IS NULL AND c.revoke_pending=FALSE
      AND (w.transition_pending=TRUE OR w.evidence_checked_at IS NULL OR (w.evidence_checked_at<? AND (w.last_error IS NOT NULL OR EXISTS (SELECT 1 FROM sandbox_native_assignments a WHERE a.project_id=w.project_id AND a.work_kind=w.work_kind AND a.work_id=w.work_id AND a.revoked_at IS NULL))))
      ORDER BY (w.transition_pending AND w.last_error IS NULL) DESC,w.evidence_checked_at ASC NULLS FIRST,w.project_id,w.work_kind,w.work_id LIMIT 20`,
        new Date(Date.now() - RESTING_MS).toISOString(),
      ),
    );
    // A pending move goes first, then whatever has waited longest: work whose last pass failed
    // takes its turn by age, so twenty that fail on every pass never starve the rest.
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
    const current = await this.state.read(async (sql) => {
      await this.connections.assertReady(work.project_id, sql);
      return this.row(sql, work.project_id, work.work_kind, work.work_id);
    });
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
      this.connections.call<T>(connection, `${route(work)}${suffix}`, {
        method,
        ...(body ? { body } : {}),
      });
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
    // What names no attempt is the attempt of the assignment whose token launched it.
    const old = (resource: NativeWorkflow | NativeJob) => {
      const attempt =
        resource.attempt_ref ??
        local.find((a) => a.native_token_id === resource.origin_grant_id)?.attempt_ref;
      return !!resource.origin_grant_id && !!attempt && attempt !== work.desired_attempt;
    };
    for (const workflow of resources.workflows) {
      try {
        await this.publisher(work, connection, workflow);
      } catch {
        evidencePending = true;
      }
      if ((work.closed_at || old(workflow)) && !workflowTerminal(workflow.state)) {
        await this.fresh(work);
        await request('/actions', 'POST', { kind: 'workflow_cancel', id: workflow.id });
        pending = true;
      }
    }
    for (const job of resources.jobs) {
      if (!job.workflow_id && (work.closed_at || old(job)) && !jobTerminal(job.state)) {
        await this.fresh(work);
        await request('/actions', 'POST', { kind: 'job_cancel', id: job.id });
        pending = true;
      }
    }
    // Running workflows/jobs keep work pending so their evidence registers as they end; open work
    // without them or a live assignment rests. Closure needs terminal workflows/jobs (captures and
    // finalizers end before any rental, even a borrowed one, is released), then stopped machines:
    // provisioning/deleting/failed is not stopped. Revocation fenced admission; earlier creates show.
    pending ||=
      resources.workflows.some((w) => !workflowTerminal(w.state)) ||
      resources.jobs.some((j) => !jobTerminal(j.state));
    if (work.closed_at && !pending)
      for (const machine of resources.sandboxes)
        if (machine.state !== 'stopped') {
          await this.fresh(work);
          await request('/actions', 'POST', { kind: 'sandbox_delete', id: machine.id });
          pending = true;
        }
    await this.state.transaction((tx) =>
      tx.run(
        `UPDATE sandbox_native_work SET transition_pending=?,evidence_checked_at=?,last_error=?
      WHERE project_id=? AND work_kind=? AND work_id=? AND desired_attempt IS NOT DISTINCT FROM ? AND closed_at IS NOT DISTINCT FROM ?`,
        // Evidence that failed to register, with nothing else in flight, is retried as resting
        // work is: one that never registers, such as a capture too large, is not polled every pass.
        pending ? 'true' : 'false',
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
