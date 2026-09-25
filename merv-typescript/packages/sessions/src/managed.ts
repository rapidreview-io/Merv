import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  canonical,
  check,
  digest,
  RUNNER_HARNESSES,
  codexHandoffGraceMs,
  sessionSecretPattern,
  type Actor,
  type Caller,
  type DelegationSource,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import { sourceCaller, tokenDigest } from './agents.js';
import type { RunnerHeartbeat, RunnerPlatform, Session, SessionPlatform } from './types.js';
import type {
  ManagedRunnerBindingIdentity,
  ManagedRunnerValidator,
  ManagedEnrollmentInput,
  ManagedModelGrant,
  ManagedRunnerInspection,
  ManagedBindingRow,
} from './managed-types.js';

const profile = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
    harness: z.enum(RUNNER_HARNESSES),
    enabled: z.boolean(),
    model: z.string().min(1).max(200).optional(),
    effort: z.string().min(1).max(200).optional(),
    parallelism: z.number().int().min(1).max(32),
  })
  .strict();
const capabilities = z
  .array(z.string().regex(/^[a-z][a-z0-9.]{0,39}$/))
  .max(16)
  .refine((items) => new Set(items).size === items.length);
const enrollment = z
  .object({
    allocationId: z.string().min(1).max(200),
    epoch: z.number().int().safe().nonnegative(),
    source: z
      .object({
        actorId: z.string().min(1),
        projectId: z.string().min(1),
        kind: z.enum(['actor', 'human', 'key']),
      })
      .passthrough(),
    runtimeProfileId: z.string().min(1).max(200),
    platform: profile,
    capabilities: capabilities.optional(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export class ManagedRunnerBindings {
  private validator?: ManagedRunnerValidator;
  private secret?: string;
  constructor(
    private state: State,
    private scope: Scope,
    private clock: () => number,
    private secretEnv?: string,
  ) {}

  registerValidator(validator: ManagedRunnerValidator): () => void {
    check(
      !this.validator,
      'managed_validator_registered',
      'Managed validator already registered',
      409,
    );
    this.validator = validator;
    return () => {
      if (this.validator === validator) this.validator = undefined;
    };
  }
  private signingSecret(): string {
    check(this.secretEnv, 'managed_unavailable', 'Managed runner secret is not configured', 503);
    const secret = process.env[this.secretEnv];
    check(
      secret && Buffer.byteLength(secret) >= 32,
      'managed_unavailable',
      'Managed runner secret is unavailable',
      503,
    );
    if (this.secret)
      check(this.secret === secret, 'managed_unavailable', 'Managed runner secret changed', 503);
    this.secret = secret;
    return secret;
  }
  private token(allocationId: string, epoch: number): string {
    return `me_${createHmac('sha256', this.signingSecret())
      .update(canonical({ domain: 'merv-managed-me-v1', allocationId, epoch }))
      .digest('hex')}`;
  }
  private controlToken(allocationId: string, epoch: number, workerNonce: string): string {
    return `mr_${createHmac('sha256', this.signingSecret())
      .update(canonical({ domain: 'merv-managed-mr-v2', allocationId, epoch, workerNonce }))
      .digest('hex')}`;
  }
  private identity(row: ManagedBindingRow): ManagedRunnerBindingIdentity {
    return {
      allocationId: row.allocation_id,
      epoch: Number(row.epoch),
      source: JSON.parse(row.source_json),
      runtimeProfileId: row.runtime_profile_id,
      platform: JSON.parse(row.platform_json),
      capabilities: JSON.parse(row.capabilities_json),
      expiresAt: row.control_expires_at,
    };
  }
  private async current(row: ManagedBindingRow, tx: Transaction): Promise<Actor> {
    check(this.validator, 'managed_unavailable', 'Managed validator is unavailable', 503);
    check(
      await this.validator.current(this.identity(row), tx),
      'managed_revoked',
      'Managed allocation is no longer current',
      401,
    );
    return await this.scope.requireDelegation(JSON.parse(row.source_json), 'read', tx);
  }
  async admits(row: ManagedBindingRow, tx: Transaction): Promise<void> {
    await this.current(row, tx);
    check(
      await this.validator!.admits(row.allocation_id, Number(row.epoch), tx),
      'managed_not_admitted',
      'Managed allocation is not accepting new work',
      409,
    );
  }
  async ensure(input: ManagedEnrollmentInput): Promise<{ enrollmentToken: string }> {
    const parsed = enrollment.safeParse(input);
    check(parsed.success, 'invalid_managed_enrollment', 'Managed enrollment identity is invalid');
    const value = parsed.data as ManagedEnrollmentInput;
    check(
      Date.parse(value.expiresAt) > this.clock(),
      'invalid_managed_enrollment',
      'Managed allocation deadline has passed',
    );
    const enrollmentToken = this.token(value.allocationId, value.epoch);
    const identity = { ...value, capabilities: value.capabilities ?? [] };
    return await this.state.transaction(async (tx) => {
      check(this.validator, 'managed_unavailable', 'Managed validator is unavailable', 503);
      check(
        await this.validator.current(identity, tx),
        'managed_revoked',
        'Managed allocation is no longer current',
        401,
      );
      await this.scope.requireDelegation(value.source, 'read', tx);
      const row = await tx.get<ManagedBindingRow>(
        'SELECT * FROM session_managed_runners WHERE allocation_id=?',
        value.allocationId,
      );
      if (row) {
        check(
          Number(row.epoch) === value.epoch &&
            row.source_json === canonical(value.source) &&
            row.runtime_profile_id === value.runtimeProfileId &&
            row.platform_json === canonical(value.platform) &&
            row.capabilities_json === canonical(identity.capabilities) &&
            row.control_expires_at === value.expiresAt,
          'managed_binding_conflict',
          'Managed allocation identity cannot change',
          409,
        );
      } else {
        const now = new Date(this.clock()).toISOString();
        await tx.run(
          'INSERT INTO session_managed_runners(allocation_id,epoch,project_id,source_json,source_hash,runtime_profile_id,platform_json,capabilities_json,enrollment_hash,enrollment_expires_at,control_hash,control_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          value.allocationId,
          value.epoch,
          value.source.projectId,
          canonical(value.source),
          digest(value.source),
          value.runtimeProfileId,
          canonical(value.platform),
          canonical(identity.capabilities),
          tokenDigest(enrollmentToken),
          new Date(Math.min(this.clock() + 900_000, Date.parse(value.expiresAt))).toISOString(),
          tokenDigest(`unbound:${enrollmentToken}`),
          value.expiresAt,
          now,
        );
      }
      return { enrollmentToken };
    });
  }
  async enroll(token: string, input: unknown): Promise<{ controlToken: string; caller: Caller }> {
    check(
      typeof token === 'string' && /^me_[0-9a-f]{64}$/.test(token),
      'unauthorized',
      'Invalid managed enrollment',
      401,
    );
    const parsed = z
      .object({ workerNonce: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict()
      .safeParse(input);
    check(
      parsed.success,
      'invalid_managed_enrollment',
      'Managed enrollment requires a 32-byte hex worker nonce',
    );
    const workerNonce = parsed.data.workerNonce;
    return await this.state.transaction(async (tx) => {
      const row = await tx.get<ManagedBindingRow>(
        'SELECT * FROM session_managed_runners WHERE enrollment_hash=?',
        tokenDigest(token),
      );
      check(
        row && Date.parse(row.enrollment_expires_at) > this.clock(),
        'unauthorized',
        'Managed enrollment expired or invalid',
        401,
      );
      await this.admits(row, tx);
      const nonceHash = tokenDigest(workerNonce);
      check(
        row.worker_nonce_hash === null || row.worker_nonce_hash === nonceHash,
        'managed_binding_conflict',
        'Managed worker nonce cannot change',
        409,
      );
      const controlToken = this.controlToken(row.allocation_id, Number(row.epoch), workerNonce);
      const controlHash = tokenDigest(controlToken);
      if (row.worker_nonce_hash === null) {
        await tx.run(
          'UPDATE session_managed_runners SET worker_nonce_hash=?, control_hash=? WHERE allocation_id=? AND worker_nonce_hash IS NULL',
          nonceHash,
          controlHash,
          row.allocation_id,
        );
      }
      return {
        controlToken,
        caller: this.caller({ ...row, worker_nonce_hash: nonceHash, control_hash: controlHash }),
      };
    });
  }
  private caller(row: ManagedBindingRow): Caller {
    const source: DelegationSource = JSON.parse(row.source_json);
    return {
      actorId: source.actorId,
      projectId: source.projectId,
      managed: {
        allocationId: row.allocation_id,
        epoch: Number(row.epoch),
        credentialHash: row.control_hash,
        ...(row.bound_session_id ? { boundSessionId: row.bound_session_id } : {}),
      },
    } as Caller;
  }
  async authenticate(token: string): Promise<Caller> {
    check(
      typeof token === 'string' && /^mr_[0-9a-f]{64}$/.test(token),
      'unauthorized',
      'Invalid managed runner credential',
      401,
    );
    return await this.state.snapshot(() =>
      this.state.transaction(async (tx) => {
        const row = await tx.get<ManagedBindingRow>(
          'SELECT * FROM session_managed_runners WHERE control_hash=?',
          tokenDigest(token),
        );
        check(
          row &&
            row.worker_nonce_hash !== null &&
            Date.parse(row.control_expires_at) > this.clock(),
          'unauthorized',
          'Managed runner credential expired or invalid',
          401,
        );
        await this.current(row, tx);
        return this.caller(row);
      }),
    );
  }
  /** The model authority of a bound session, by its bearer or, when the relay checks again, its
   *  id: live, or closed by its own handoff within the runner's grace so Codex finishes its
   *  closing turn. Reading it never activates an offered session. */
  async modelGrant(tokenOrSessionId: string): Promise<ManagedModelGrant> {
    return await this.state.snapshot(() =>
      this.state.transaction(async (tx) => {
        const bearer = sessionSecretPattern.test(tokenOrSessionId);
        const found = await tx.get<{ session_json: string }>(
          `SELECT session_json FROM worker_sessions WHERE ${bearer ? 'token_hash' : 'id'}=?`,
          bearer ? tokenDigest(tokenOrSessionId) : tokenOrSessionId,
        );
        const session: Session | undefined = found && JSON.parse(found.session_json);
        const row =
          session &&
          (await tx.get<ManagedBindingRow>(
            'SELECT * FROM session_managed_runners WHERE bound_session_id=?',
            session.id,
          ));
        const platform: RunnerPlatform | undefined = row && JSON.parse(row.platform_json);
        const now = this.clock();
        check(
          session &&
            row &&
            platform?.model &&
            (session.status === 'offered' || session.status === 'active'
              ? Date.parse(session.expiresAt) > now
              : session.closeReason === 'handoff' &&
                now - Date.parse(session.closedAt!) < codexHandoffGraceMs),
          'unauthorized',
          'No live managed session holds this credential',
          401,
        );
        const { user, projectId, id } = await this.current(row, tx);
        return {
          id: session.id,
          projectId: row.project_id,
          person: digest(
            user ? { issuer: user.issuer, subject: user.subject } : { projectId, actorId: id },
          ),
          model: platform.model,
          ...(platform.effort ? { effort: platform.effort } : {}),
          expiresAt: new Date(
            Math.min(Date.parse(session.hardDeadline), Date.parse(row.control_expires_at)),
          ).toISOString(),
        };
      }),
    );
  }
  async require(
    caller: Caller,
    tx: Transaction,
  ): Promise<{ row: ManagedBindingRow; sourceCaller: Caller }> {
    const managed = caller.managed;
    check(managed, 'forbidden', 'Managed runner authority required', 403);
    const row = await tx.get<ManagedBindingRow>(
      'SELECT * FROM session_managed_runners WHERE allocation_id=?',
      managed.allocationId,
    );
    check(
      row &&
        Number(row.epoch) === managed.epoch &&
        row.worker_nonce_hash !== null &&
        row.control_hash === managed.credentialHash &&
        row.project_id === caller.projectId &&
        Date.parse(row.control_expires_at) > this.clock() &&
        (!managed.boundSessionId || managed.boundSessionId === row.bound_session_id),
      'unauthorized',
      'Managed runner authority is unavailable',
      401,
    );
    await this.current(row, tx);
    return { row, sourceCaller: sourceCaller(JSON.parse(row.source_json)) };
  }
  async heartbeat(caller: Caller, input: RunnerHeartbeat, tx: Transaction): Promise<Caller> {
    const { row, sourceCaller: source } = await this.require(caller, tx);
    // A runner whose lease reply was lost still offers its slot; its retry replays the binding.
    check(
      input.capacity === 1 || (row.bound_session_id && input.capacity === 0),
      'managed_capacity',
      'Managed runner capacity must be one, or zero once bound',
      409,
    );
    check(
      input.platforms.length === 1 &&
        canonical(input.platforms[0]) === row.platform_json &&
        canonical(input.capabilities ?? []) === row.capabilities_json,
      'managed_profile',
      'Managed runner profile differs from allocation',
      409,
    );
    if (row.runner_id)
      check(
        row.runner_id === input.runnerId,
        'managed_runner_conflict',
        'Managed runner identity is pinned',
        409,
      );
    else {
      await this.admits(row, tx);
      await tx.run(
        'UPDATE session_managed_runners SET runner_id=? WHERE allocation_id=? AND runner_id IS NULL',
        input.runnerId,
        row.allocation_id,
      );
    }
    return source;
  }
  async lease(
    caller: Caller,
    input: { runnerId: string; platform: SessionPlatform },
    tx: Transaction,
  ): Promise<{ row: ManagedBindingRow; sourceCaller: Caller }> {
    const result = await this.require(caller, tx);
    const { row } = result;
    check(
      row.runner_id === input.runnerId,
      'managed_runner_conflict',
      'Managed runner identity is pinned',
      409,
    );
    const platform: RunnerPlatform = JSON.parse(row.platform_json);
    check(
      canonical(input.platform) ===
        canonical({
          name: platform.name,
          harness: platform.harness,
          ...(platform.model ? { model: platform.model } : {}),
          ...(platform.effort ? { effort: platform.effort } : {}),
        }),
      'managed_profile',
      'Managed lease platform differs from allocation',
      409,
    );
    return result;
  }
  async bind(row: ManagedBindingRow, sessionId: string, tx: Transaction): Promise<void> {
    await this.admits(row, tx);
    check(
      !row.bound_session_id || row.bound_session_id === sessionId,
      'managed_bound',
      'Managed runner already owns another session',
      409,
    );
    await tx.run(
      'UPDATE session_managed_runners SET bound_session_id=? WHERE allocation_id=? AND bound_session_id IS NULL',
      sessionId,
      row.allocation_id,
    );
  }
  async controlled(
    caller: Caller,
    sessionId: string,
    runnerId: string | undefined,
    tx: Transaction,
  ): Promise<void> {
    const { row } = await this.require(caller, tx);
    check(
      row.bound_session_id === sessionId && (!runnerId || row.runner_id === runnerId),
      'session_forbidden',
      'Session is not bound to this managed runner',
      403,
    );
  }
  async acknowledgeRelease(
    caller: Caller,
    sessionId: string,
    runnerId: string,
    tx: Transaction,
  ): Promise<void> {
    await this.controlled(caller, sessionId, runnerId, tx);
    await tx.run(
      'UPDATE session_managed_runners SET runner_released_at=COALESCE(runner_released_at,?) WHERE allocation_id=?',
      new Date(this.clock()).toISOString(),
      caller.managed!.allocationId,
    );
  }
  /** Live sessions whose allocation is no longer current: Fleet stopped or is stopping the
   *  machine, so no runner is left to release them. An unanswerable check keeps the session. */
  async stranded(tx: Transaction): Promise<Set<string>> {
    const ids = new Set<string>();
    if (!this.validator) return ids;
    for (const row of await tx.all<ManagedBindingRow>(
      "SELECT m.* FROM session_managed_runners m JOIN worker_sessions s ON s.id=m.bound_session_id WHERE s.status IN ('offered','active')",
    ))
      if (!(await this.validator.current(this.identity(row), tx).catch(() => true)))
        ids.add(row.bound_session_id!);
    return ids;
  }
  async inspect(allocationId: string, epoch: number): Promise<ManagedRunnerInspection | null> {
    check(
      typeof allocationId === 'string' &&
        allocationId.length > 0 &&
        Number.isSafeInteger(epoch) &&
        epoch >= 0,
      'invalid_managed_allocation',
      'Managed allocation identity is invalid',
    );
    return await this.state.snapshot(() =>
      this.state.transaction(async (tx) => {
        const row = await tx.get<ManagedBindingRow>(
          'SELECT * FROM session_managed_runners WHERE allocation_id=?',
          allocationId,
        );
        if (!row || Number(row.epoch) !== epoch) return null;
        const runner = { runnerId: row.runner_id, enrollmentExpiresAt: row.enrollment_expires_at };
        if (!row.bound_session_id) return { ...runner, session: null };
        const bound = await tx.get<{ session_json: string }>(
          'SELECT session_json FROM worker_sessions WHERE id=?',
          row.bound_session_id,
        );
        check(bound, 'managed_session_missing', 'Managed bound session is missing', 500);
        const session = JSON.parse(bound.session_json) as Session;
        const workspace = await tx.get<{ result_json: string | null }>(
          'SELECT result_json FROM session_workspaces WHERE session_id=?',
          row.bound_session_id,
        );
        return {
          ...runner,
          session: {
            id: session.id,
            instanceId: session.instanceId,
            expectedRevision: session.expectedRevision,
            status: session.status,
            closedAt: session.closedAt,
            outcome: session.outcome ?? null,
            releaseAcknowledged: row.runner_released_at !== null,
            capturePending: !!workspace && workspace.result_json === null,
          },
        };
      }),
    );
  }
}
