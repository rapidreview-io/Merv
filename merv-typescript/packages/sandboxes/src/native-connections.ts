import { randomBytes } from 'node:crypto';
import { managedAccountSubject } from './account-billing.js';
import {
  check,
  digest,
  sha256Hex,
  newId,
  type Caller,
  type Json,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import { NativeCredentials, NativeSandboxClient, nativeOrigin } from './native-client.js';
import type { NativeConnectionRow, NativeWorkRow } from './native-schema.js';
import type { NativeConnectionStatus, NativeSandboxesConfig } from './native-types.js';

interface Flow {
  id: string;
  project_id: string;
  operator_ref: string;
  previous_connection_id: string | null;
  browser_hash: string;
  expires_at: string;
  payload: string;
  code: string | null;
  completed_at: string | null;
  reconcile_after: string | null;
  billing_subject?: string | null;
}
interface FlowSecrets {
  bearer: string;
  verifier: string;
  state: string;
  recoverAfter: string;
  exchangeStartedAt?: string;
}
interface ConnectionReceipt {
  connection_id: string;
  account_id: string;
  member_id: string;
  project_ref: string;
}
const secret = () => randomBytes(32).toString('base64url');
const operator = (caller: Caller) => JSON.stringify([caller.human!.issuer, caller.human!.subject]);

/** Native consent controls credentials; Merv stores only project ownership and unfinished work. */
export class NativeConnections {
  readonly credentials: NativeCredentials;
  readonly client: NativeSandboxClient;
  readonly callback: string;
  readonly origin: string;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    readonly config: NativeSandboxesConfig,
    sandboxOrigin: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    this.credentials = new NativeCredentials(environment[config.encryptionKeyEnv]);
    this.client = new NativeSandboxClient(sandboxOrigin, fetcher);
    this.origin = nativeOrigin(config.publicOrigin);
    this.callback = `${this.origin}/sandboxes/connection/callback`;
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private async authorize(caller: Caller, tx: Transaction, admin = true) {
    await this.scope.require(caller, admin ? 'admin' : 'read', tx);
    if (admin)
      check(
        caller.human && !caller.key && !caller.session && !caller.managed && !caller.conversation,
        'sandbox_human_required',
        'Sign in with your Merv account to manage compute',
        403,
      );
  }
  private applicationSecret() {
    const value = this.environment[this.config.applicationSecretEnv];
    check(value, 'sandbox_setup_required', 'Sandboxes sign-in is not configured', 503);
    return value;
  }
  async assertReady(projectId: string, tx: Sql): Promise<void> {
    check(
      !(await tx.get(
        `SELECT 1 FROM sandbox_native_flows WHERE project_id=?
      AND billing_subject IS NOT NULL AND completed_at IS NULL LIMIT 1`,
        projectId,
      )),
      'sandbox_connection_pending',
      'Managed compute funding is being reconciled',
      409,
    );
  }
  async current(projectId: string, tx?: Sql): Promise<NativeConnectionRow | undefined> {
    const read = (sql: Sql) =>
      sql.get<NativeConnectionRow>(
        `SELECT c.* FROM sandbox_native_projects p JOIN sandbox_native_connections c ON c.id=p.connection_id
       WHERE p.project_id=? AND c.revoked_at IS NULL AND c.revoke_pending=FALSE`,
        projectId,
      );
    return tx ? read(tx) : this.state.read(read);
  }
  async get(id: string): Promise<NativeConnectionRow> {
    const row = await this.state.read((sql) =>
      sql.get<NativeConnectionRow>('SELECT * FROM sandbox_native_connections WHERE id=?', id),
    );
    check(
      row && !row.revoked_at && !row.revoke_pending,
      'sandbox_access_revoked',
      'Sandboxes connection was disconnected',
      403,
    );
    return row;
  }
  bearer(row: NativeConnectionRow): string {
    return this.credentials.open<{ bearer: string }>(row.credentials, `connection:${row.id}`)
      .bearer;
  }
  /** One request to Sandboxes made with a connection's own bearer token. */
  call<T>(
    row: NativeConnectionRow,
    path: string,
    options?: Parameters<NativeSandboxClient['request']>[2],
  ): Promise<T> {
    return this.client.request<T>(path, this.bearer(row), options);
  }
  /**
   * The assignments of a project's work on a connection other than `kept` end with that
   * connection's tokens: it was revoked, or held only expired assignments when the work moved.
   * Its replacement never holds those leases, so nothing is revoked through it.
   */
  private async revokeAssignments(tx: Transaction, projectId: string, kept: string | null) {
    await tx.run(
      `UPDATE sandbox_native_assignments a SET revoked_at=? FROM sandbox_native_work w
      WHERE a.project_id=? AND a.revoked_at IS NULL AND w.project_id=a.project_id
      AND w.work_kind=a.work_kind AND w.work_id=a.work_id AND w.connection_id IS DISTINCT FROM ?`,
      this.now(),
      projectId,
      kept,
    );
  }
  /** The project's open work moves to `connectionId`; each gets a new grant there when it runs. */
  private async rebind(tx: Transaction, projectId: string, connectionId: string) {
    await this.revokeAssignments(tx, projectId, connectionId);
    await tx.run(
      'UPDATE sandbox_native_work SET connection_id=?,native_grant_id=NULL,namespace=NULL,evidence_checked_at=NULL,last_error=NULL WHERE project_id=? AND closed_at IS NULL',
      connectionId,
      projectId,
    );
  }
  async status(caller: Caller): Promise<NativeConnectionStatus> {
    const status = await this.state.snapshot(() =>
      this.state.transaction(async (tx) => {
        await this.authorize(caller, tx, false);
        const connection = await this.current(caller.projectId, tx);
        return {
          available: true,
          connected: !!connection,
          connectionId: connection?.id ?? null,
          accountId: connection?.account_id ?? null,
          memberId: connection?.member_id ?? null,
          connectedAt: connection?.connected_at ?? null,
          funding: connection?.billing_subject ? ('managed' as const) : ('personal' as const),
          managedAvailable: !!this.config.managed,
          url: `${this.client.origin}/ui`,
        };
      }),
    );
    if (status.connected && status.funding === 'managed') {
      const connection = await this.get(status.connectionId!);
      return {
        ...status,
        allowance: await this.call<Json>(connection, '/v1/delegations/allowance'),
      };
    }
    return status;
  }
  async enableManaged(caller: Caller): Promise<NativeConnectionStatus> {
    const managed = this.config.managed;
    const token = managed && this.environment[managed.tokenEnv];
    check(managed && token, 'sandbox_setup_required', 'Managed ML is not configured', 503);
    const row = await this.state.transaction(async (tx) => {
      await this.authorize(caller, tx);
      const previous = await this.current(caller.projectId, tx);
      const subject = await managedAccountSubject(this.scope, caller.projectId, tx);
      if (previous?.billing_subject === subject) return null;
      check(
        !(await tx.get(
          `SELECT 1 FROM sandbox_native_assignments WHERE project_id=?
        AND revoked_at IS NULL AND expires_at>? LIMIT 1`,
          caller.projectId,
          this.now(),
        )),
        'sandbox_migration_required',
        'Wait for active compute assignments to end before changing funding',
        409,
      );
      const pending = await tx.get<Flow>(
        'SELECT * FROM sandbox_native_flows WHERE project_id=? AND billing_subject IS NOT NULL AND completed_at IS NULL',
        caller.projectId,
      );
      if (pending) {
        check(
          pending.operator_ref === operator(caller) &&
            pending.expires_at > this.now() &&
            pending.previous_connection_id === (previous?.id ?? null) &&
            pending.billing_subject === subject,
          'sandbox_connection_pending',
          'A compute connection is still being reconciled',
          409,
        );
        return pending;
      }
      const id = newId('sbxc');
      const payload: FlowSecrets = {
        bearer: `sbxt_${secret()}`,
        verifier: secret(),
        state: secret(),
        exchangeStartedAt: this.now(),
        recoverAfter: new Date(this.clock() + 630_000).toISOString(),
      };
      await tx.run(
        `INSERT INTO sandbox_native_flows(id,project_id,operator_ref,previous_connection_id,browser_hash,expires_at,payload,billing_subject)
         VALUES(?,?,?,?,?,?,?,?)`,
        id,
        caller.projectId,
        operator(caller),
        previous?.id ?? null,
        digest(secret()),
        new Date(this.clock() + 600_000).toISOString(),
        this.credentials.seal(payload, `flow:${id}`),
        subject,
      );
      return (await tx.get<Flow>('SELECT * FROM sandbox_native_flows WHERE id=?', id))!;
    });
    if (!row) return this.status(caller);
    const payload = this.credentials.open<FlowSecrets>(row.payload, `flow:${row.id}`);
    const receipt = await this.client.request<ConnectionReceipt>(
      '/v1/delegations/connections',
      token,
      {
        method: 'POST',
        scope: { namespace: managed.namespace, subject: row.billing_subject! },
        body: {
          project_ref: row.project_id,
          request_key: row.id,
          token_hash: sha256Hex(payload.bearer),
        },
      },
    );
    await this.saveReceipt(row, payload, receipt);
    const moving = await this.state.read((sql) =>
      sql.all<NativeWorkRow & { disconnected: boolean }>(
        `SELECT w.*,c.revoked_at IS NOT NULL AS disconnected FROM sandbox_native_work w
        JOIN sandbox_native_connections c ON c.id=w.connection_id
        WHERE w.project_id=? AND w.closed_at IS NULL`,
        caller.projectId,
      ),
    );
    const grants: { old: NativeConnectionRow; path: string }[] = [];
    for (const work of moving)
      // A disconnected connection's grants went with it: there is nothing to check or retire.
      if (work.native_grant_id && !work.disconnected)
        grants.push({
          old: await this.get(work.connection_id),
          path: `/v1/delegations/works/${work.native_grant_id}`,
        });
    const empty = async ({ old, path }: (typeof grants)[number]) => {
      const resources = await this.call<{
        workflows: unknown[];
        jobs: unknown[];
        sandboxes: unknown[];
        next: Record<string, unknown>;
      }>(old, `${path}/resources`);
      check(
        ['workflows', 'jobs', 'sandboxes'].every(
          (key) => Array.isArray(resources[key as 'jobs']) && resources[key as 'jobs'].length === 0,
        ) &&
          resources.next &&
          Object.values(resources.next).every((value) => value === null),
        'sandbox_migration_required',
        'Existing compute resources must retain their original funding history',
        409,
      );
    };
    // Every work must be empty before any grant is retired, so one busy work leaves all intact.
    for (const grant of grants) await empty(grant);
    for (const grant of grants) {
      // Retire the old grant, then check again: a request admitted just before
      // revocation must not be orphaned or attributed to the replacement root.
      await this.call(grant.old, grant.path, { method: 'DELETE' });
      await empty(grant);
    }
    await this.state.transaction(async (tx) => {
      await this.authorize(caller, tx);
      const fresh = await tx.get<Flow>('SELECT * FROM sandbox_native_flows WHERE id=?', row.id);
      if (fresh?.completed_at) return;
      const current = await this.current(caller.projectId, tx);
      check(
        fresh &&
          fresh.expires_at > this.now() &&
          (current?.id ?? null) === row.previous_connection_id,
        'sandbox_connection_conflict',
        'Compute authority changed while enabling managed ML',
        409,
      );
      check(
        !(await tx.get(
          `SELECT 1 FROM sandbox_native_assignments WHERE project_id=?
        AND revoked_at IS NULL AND expires_at>? LIMIT 1`,
          caller.projectId,
          this.now(),
        )),
        'sandbox_migration_required',
        'Compute assignments changed while switching funding',
        409,
      );
      const currentWork = await tx.all<NativeWorkRow>(
        'SELECT * FROM sandbox_native_work WHERE project_id=? AND closed_at IS NULL',
        caller.projectId,
      );
      check(
        digest(
          currentWork
            .map((w) => [w.work_kind, w.work_id, w.connection_id, w.native_grant_id])
            .sort(),
        ) ===
          digest(
            moving.map((w) => [w.work_kind, w.work_id, w.connection_id, w.native_grant_id]).sort(),
          ),
        'sandbox_connection_conflict',
        'Compute work changed while switching funding',
        409,
      );
      await tx.run(
        `INSERT INTO sandbox_native_projects(project_id,connection_id) VALUES(?,?)
        ON CONFLICT(project_id) DO UPDATE SET connection_id=EXCLUDED.connection_id`,
        caller.projectId,
        row.id,
      );
      await this.rebind(tx, caller.projectId, row.id);
      await tx.run('UPDATE sandbox_native_connections SET revoke_pending=FALSE WHERE id=?', row.id);
      await tx.run('UPDATE sandbox_native_flows SET completed_at=? WHERE id=?', this.now(), row.id);
      if (
        row.previous_connection_id &&
        !(await tx.get(
          'SELECT 1 FROM sandbox_native_work WHERE connection_id=? LIMIT 1',
          row.previous_connection_id,
        ))
      )
        await tx.run(
          'UPDATE sandbox_native_connections SET revoked_at=?,revoke_pending=TRUE WHERE id=?',
          this.now(),
          row.previous_connection_id,
        );
    });
    return this.status(caller);
  }
  async begin(caller: Caller): Promise<{ url: string; cookie: string }> {
    // Missing credentials fail before persisting a flow or redirecting the browser.
    check(
      !this.config.managed,
      'sandbox_managed_required',
      'Use Merv-managed ML for this project',
      409,
    );
    const applicationSecret = this.applicationSecret();
    const id = newId('sbxc'),
      browser = secret();
    const payload: FlowSecrets = {
      bearer: `sbxt_${secret()}`,
      verifier: secret(),
      state: `${id}.${secret()}`,
      recoverAfter: new Date(this.clock() + 630_000).toISOString(),
    };
    const expiry = new Date(this.clock() + 600_000).toISOString();
    await this.state.transaction(async (tx) => {
      await this.authorize(caller, tx);
      const previous = await this.current(caller.projectId, tx);
      check(
        !previous,
        'sandbox_already_connected',
        'Disconnect the current compute account before starting sign-in',
        409,
      );
      await tx.run(
        `INSERT INTO sandbox_native_flows(id,project_id,operator_ref,previous_connection_id,browser_hash,expires_at,payload)
         VALUES(?,?,?,?,?,?,?)`,
        id,
        caller.projectId,
        operator(caller),
        null,
        digest(browser),
        expiry,
        this.credentials.seal(payload, `flow:${id}`),
      );
    });
    const receipt = await this.client.request<{ consent_url: string; expires_at: string }>(
      '/v1/auth/connections/start',
      applicationSecret,
      {
        method: 'POST',
        application: true,
        body: {
          application_id: this.config.applicationId,
          project_ref: caller.projectId,
          operator_ref: caller.human!.subject,
          redirect_uri: this.callback,
          state: payload.state,
          operator_issuer: caller.human!.issuer,
          operator_subject: caller.human!.subject,
          code_challenge: Buffer.from(sha256Hex(payload.verifier), 'hex').toString('base64url'),
          token_hash: sha256Hex(payload.bearer),
        },
      },
    );
    let target: URL | undefined;
    try {
      target = new URL(receipt.consent_url);
    } catch {
      /* report without remote data */
    }
    check(
      target &&
        target.origin === this.client.origin &&
        !target.username &&
        !target.password &&
        target.pathname === '/ui/consent' &&
        !target.hash &&
        target.searchParams.get('request'),
      'sandbox_origin_refused',
      'Sandboxes returned an invalid sign-in destination',
      502,
    );
    return {
      url: target.href,
      cookie: `merv_sandboxes_flow=${id}.${browser}; HttpOnly; SameSite=Lax; Path=/sandboxes/connection; Max-Age=600${this.origin.startsWith('https:') ? '; Secure' : ''}`,
    };
  }
  private async flow(tx: Sql, cookie: string | undefined): Promise<Flow> {
    const values = (cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('merv_sandboxes_flow='));
    check(values.length === 1, 'sandbox_connection_expired', 'Start Sandboxes sign-in again', 409);
    const match = /^merv_sandboxes_flow=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(values[0]!);
    check(match, 'sandbox_connection_expired', 'Start Sandboxes sign-in again', 409);
    const row = await tx.get<Flow>('SELECT * FROM sandbox_native_flows WHERE id=?', match[1]!);
    check(
      row && row.browser_hash === digest(match[2]!) && row.expires_at > this.now(),
      'sandbox_connection_expired',
      'Start Sandboxes sign-in again',
      409,
    );
    return row;
  }
  async callbackReady(cookie: string | undefined, code: string, state: string): Promise<string> {
    check(
      code.length > 0 && code.length <= 4096 && /^[!-~]+$/.test(code),
      'invalid_input',
      'Invalid sign-in reply',
    );
    await this.state.transaction(async (tx) => {
      const row = await this.flow(tx, cookie);
      const expected = this.credentials.open<FlowSecrets>(row.payload, `flow:${row.id}`);
      check(
        state === expected.state && !row.completed_at,
        'sandbox_connection_conflict',
        'Sign-in reply does not match this browser',
        409,
      );
      if (row.code)
        check(
          this.credentials.open<{ code: string }>(row.code, `code:${row.id}`).code === code,
          'sandbox_connection_conflict',
          'A different sign-in reply was already received',
          409,
        );
      else
        await tx.run(
          'UPDATE sandbox_native_flows SET code=? WHERE id=?',
          this.credentials.seal({ code }, `code:${row.id}`),
          row.id,
        );
    });
    return `${this.origin}/ui/settings/integrations?sandboxes=complete`;
  }
  private validateReceipt(receipt: ConnectionReceipt, projectId: string): void {
    check(
      receipt &&
        receipt.project_ref === projectId &&
        [receipt.connection_id, receipt.account_id, receipt.member_id].every(
          (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id),
        ),
      'sandbox_connection_conflict',
      'Sandboxes returned a different account connection',
      502,
    );
  }
  private async saveReceipt(
    row: Flow,
    payload: FlowSecrets,
    receipt: ConnectionReceipt,
  ): Promise<void> {
    this.validateReceipt(receipt, row.project_id);
    await this.state.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO sandbox_native_connections(id,project_id,root_id,account_id,member_id,credentials,connected_at,revoke_pending,billing_subject)
         VALUES(?,?,?,?,?,?,?,TRUE,?) ON CONFLICT(id) DO NOTHING`,
        row.id,
        row.project_id,
        receipt.connection_id,
        receipt.account_id,
        receipt.member_id,
        this.credentials.seal({ bearer: payload.bearer }, `connection:${row.id}`),
        this.now(),
        row.billing_subject ?? null,
      );
      const stored = await tx.get<NativeConnectionRow>(
        'SELECT * FROM sandbox_native_connections WHERE id=?',
        row.id,
      );
      check(
        stored?.root_id === receipt.connection_id &&
          stored.account_id === receipt.account_id &&
          stored.member_id === receipt.member_id &&
          stored.project_id === row.project_id,
        'sandbox_connection_conflict',
        'The returned connection changed',
        409,
      );
    });
  }
  async finish(caller: Caller, cookie: string | undefined): Promise<NativeConnectionStatus> {
    // A real writer transaction marks an exchange attempt durably before network I/O.
    const row = await this.state.transaction(async (tx) => {
      await this.authorize(caller, tx);
      const flow = await this.flow(tx, cookie);
      check(
        flow.project_id === caller.projectId && flow.operator_ref === operator(caller),
        'sandbox_connection_owner',
        'Return to the project and account that started sign-in',
        403,
      );
      check(
        flow.code || flow.completed_at,
        'sandbox_connection_pending',
        'Finish Sandboxes sign-in first',
        409,
      );
      if (!flow.completed_at) {
        const payload = this.credentials.open<FlowSecrets>(flow.payload, `flow:${flow.id}`);
        payload.exchangeStartedAt ??= this.now();
        flow.payload = this.credentials.seal(payload, `flow:${flow.id}`);
        await tx.run('UPDATE sandbox_native_flows SET payload=? WHERE id=?', flow.payload, flow.id);
      }
      return flow;
    });
    if (row.completed_at) return this.status(caller);
    const payload = this.credentials.open<FlowSecrets>(row.payload, `flow:${row.id}`);
    const { code } = this.credentials.open<{ code: string }>(row.code!, `code:${row.id}`);
    const [issuer, subject] = JSON.parse(row.operator_ref) as [string, string];
    const receipt = await this.client.request<ConnectionReceipt>(
      '/v1/auth/connections/exchange',
      this.applicationSecret(),
      {
        method: 'POST',
        application: true,
        body: {
          application_id: this.config.applicationId,
          code,
          code_verifier: payload.verifier,
          redirect_uri: this.callback,
          state: payload.state,
          project_ref: row.project_id,
          operator_ref: subject,
          operator_issuer: issuer,
          operator_subject: subject,
        },
      },
    );
    // The root is recoverable before the final permission/project check. Never hold a writer
    // transaction while calling Sandboxes: the disconnect/authority-loss fence must run.
    await this.saveReceipt(row, payload, receipt);
    try {
      await this.state.transaction(async (tx) => {
        await this.authorize(caller, tx);
        check(
          !this.config.managed,
          'sandbox_managed_required',
          'Use Merv-managed ML for this project',
          409,
        );
        const currentFlow = await this.flow(tx, cookie);
        if (currentFlow.completed_at) return;
        const current = await this.current(caller.projectId, tx);
        check(
          !current && row.previous_connection_id === null,
          'sandbox_connection_conflict',
          'The project compute account changed during sign-in; start again',
          409,
        );
        const saved = await tx.get<NativeConnectionRow>(
          'SELECT * FROM sandbox_native_connections WHERE id=?',
          row.id,
        );
        check(
          saved && !saved.revoked_at,
          'sandbox_access_revoked',
          'This connection was cancelled',
          409,
        );
        await tx.run(
          `INSERT INTO sandbox_native_projects(project_id,connection_id) VALUES(?,?)
          ON CONFLICT(project_id) DO UPDATE SET connection_id=EXCLUDED.connection_id`,
          caller.projectId,
          row.id,
        );
        // Open work left on the disconnected account is paid by this one from now on.
        await this.rebind(tx, caller.projectId, row.id);
        await tx.run(
          'UPDATE sandbox_native_connections SET revoke_pending=FALSE WHERE id=?',
          row.id,
        );
        await tx.run(
          'UPDATE sandbox_native_flows SET completed_at=? WHERE id=?',
          this.now(),
          row.id,
        );
      });
    } catch (error) {
      await this.state.transaction(async (tx) => {
        const fresh = await tx.get<Flow>('SELECT * FROM sandbox_native_flows WHERE id=?', row.id);
        // A concurrent successful finish cannot be undone by a failed stale caller.
        if (!fresh || fresh.completed_at) return;
        await tx.run('UPDATE sandbox_native_flows SET expires_at=? WHERE id=?', this.now(), row.id);
        await tx.run(
          'UPDATE sandbox_native_connections SET revoked_at=COALESCE(revoked_at,?),revoke_pending=TRUE WHERE id=?',
          this.now(),
          row.id,
        );
      });
      throw error;
    }
    return this.status(caller);
  }
  async disconnect(caller: Caller): Promise<NativeConnectionStatus> {
    await this.state.transaction(async (tx) => {
      await this.authorize(caller, tx);
      // Fence even an initially disconnected project: an exchange may be in flight.
      await tx.run(
        'UPDATE sandbox_native_flows SET expires_at=? WHERE project_id=? AND completed_at IS NULL',
        this.now(),
        caller.projectId,
      );
      const row = await this.current(caller.projectId, tx);
      if (row) {
        await tx.run(
          'UPDATE sandbox_native_connections SET revoked_at=?,revoke_pending=TRUE WHERE id=?',
          this.now(),
          row.id,
        );
        await tx.run(
          'UPDATE sandbox_native_projects SET connection_id=NULL WHERE project_id=?',
          caller.projectId,
        );
        await this.revokeAssignments(tx, caller.projectId, null);
      }
    });
    await this.reconcileRevocations();
    return this.status(caller);
  }
  async reconcileRevocations(): Promise<void> {
    const rows = await this.state.read((sql) =>
      sql.all<NativeConnectionRow>(
        `SELECT c.* FROM sandbox_native_connections c WHERE revoke_pending=TRUE
       AND NOT EXISTS (SELECT 1 FROM sandbox_native_flows f WHERE f.id=c.id AND f.expires_at>? AND f.completed_at IS NULL)
       LIMIT 20`,
        this.now(),
      ),
    );
    for (const row of rows) {
      try {
        // Only a successful native self-revoke confirms revocation. A 403 may be suspension.
        await this.call(row, '/v1/delegations/connection', {
          method: 'DELETE',
        });
      } catch {
        continue;
      }
      await this.state.transaction((tx) =>
        tx.run(
          'UPDATE sandbox_native_connections SET revoke_pending=FALSE,revoked_at=COALESCE(revoked_at,?) WHERE id=?',
          this.now(),
          row.id,
        ),
      );
    }
    const flows = await this.state.read((sql) =>
      sql.all<Flow>(
        `SELECT * FROM sandbox_native_flows WHERE completed_at IS NULL AND expires_at<=?
       AND (reconcile_after IS NULL OR reconcile_after<=?) ORDER BY expires_at,id LIMIT 20`,
        this.now(),
        this.now(),
      ),
    );
    const later = (id: string) =>
      this.state.transaction((tx) =>
        tx.run(
          'UPDATE sandbox_native_flows SET reconcile_after=? WHERE id=?',
          new Date(this.clock() + 60_000).toISOString(),
          id,
        ),
      );
    for (const row of flows) {
      let payload: FlowSecrets;
      try {
        payload = this.credentials.open<FlowSecrets>(row.payload, `flow:${row.id}`);
      } catch {
        // An unreadable row backs off instead of stalling every flow behind it.
        await later(row.id);
        continue;
      }
      if (!payload.exchangeStartedAt) {
        await this.state.transaction((tx) =>
          tx.run(
            'DELETE FROM sandbox_native_flows WHERE id=? AND completed_at IS NULL AND expires_at<=?',
            row.id,
            this.now(),
          ),
        );
        continue;
      }
      // Give the declared remote request lifetime time to settle before orphan recovery.
      if (payload.recoverAfter > this.now()) {
        await this.state.transaction((tx) =>
          tx.run(
            'UPDATE sandbox_native_flows SET reconcile_after=? WHERE id=?',
            payload.recoverAfter,
            row.id,
          ),
        );
        continue;
      }
      try {
        const receipt = await this.client.request<ConnectionReceipt>(
          '/v1/delegations/connection',
          payload.bearer,
        );
        await this.saveReceipt(row, payload, receipt);
      } catch {
        /* A suspended root still permits self-revoke; absence remains uncertain. */
      }
      try {
        await this.client.request('/v1/delegations/connection', payload.bearer, {
          method: 'DELETE',
        });
        await this.state.transaction(async (tx) => {
          await tx.run(
            'UPDATE sandbox_native_connections SET revoke_pending=FALSE,revoked_at=COALESCE(revoked_at,?) WHERE id=?',
            this.now(),
            row.id,
          );
          await tx.run(
            'DELETE FROM sandbox_native_flows WHERE id=? AND completed_at IS NULL',
            row.id,
          );
        });
      } catch {
        // Keep the encrypted bearer until native revocation is confirmed, including restarts.
        await later(row.id);
      }
    }
  }
}
