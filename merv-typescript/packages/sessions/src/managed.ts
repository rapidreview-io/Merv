import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  canonical,
  check,
  digest,
  MervError,
  effectiveWorkspace,
  sessionSecretPattern,
  type Actor,
  type Caller,
  type DelegationSource,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import { sourceCaller } from '@merv/scope/rules';
import { tokenDigest } from '@merv/identity/credentials';
import type { RunnerHeartbeat, RunnerPlatform, Session, SessionPlatform } from './types.js';
import type { CredentialStore } from '@merv/identity/credentials';
import type { CallerRules } from '@merv/api/types';
import type {
  ManagedRunnerBindingIdentity,
  ManagedRunnerValidator,
  ManagedEnrollmentInput,
  ManagedBoundSession,
  ManagedRunnerInspection,
  ManagedBindingRow,
} from './managed-types.js';
import {
  capabilitiesSchema as capabilities,
  INQUIRY_CAPABILITY,
  ownEnd,
  runnerPlatformSchema as profile,
} from './rules.js';

/** What a Hugging Face grant binds, opaque to Secrets: one session attached on one host. */
const huggingFaceBinding = z
  .object({
    sessionId: z.string().min(1).max(200),
    runnerId: z.string().min(1).max(200),
    allocationId: z.string().min(1).max(200),
    epoch: z.number().int().safe().nonnegative(),
    hostRef: z.string().min(1).max(512),
  })
  .strict();
export type HuggingFaceBinding = z.infer<typeof huggingFaceBinding>;

/** A session's allocation by either binding, its work host's or (before every machine was a work
 *  host) its runner's own: two index lookups, never a scan of every one. */
const boundTo = `SELECT * FROM session_managed_runners WHERE allocation_id IN (SELECT allocation_id FROM session_managed_runners WHERE bound_session_id=?
  UNION ALL SELECT allocation_id FROM session_managed_assignments WHERE session_id=?)`;
const enrollment = z
  .object({
    allocationId: z.string().min(1).max(200),
    workInstanceId: z.string().min(1).max(200),
    stepSeconds: z.number().int().min(60).max(86400),
    epoch: z.number().int().safe().nonnegative(),
    source: z
      .object({
        actorId: z.string().min(1),
        projectId: z.string().min(1),
        kind: z.enum(['actor', 'human', 'key', 'service']),
      })
      .passthrough(),
    runtimeProfileId: z.string().min(1).max(200),
    platform: profile,
    capabilities: capabilities.optional(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** A hosted machine, a work host's reuse included, waits this long for a transcript its runner
 *  declared before its release, capture and upload included: a runner that gives up on one
 *  cannot say so. */
const transcriptGraceMs = 30 * 60_000;

/** A managed runner supervises its bound execution through its own routes: it uses no tool. */
export const managedRunnerRules: CallerRules = {
  forbidden: new MervError('managed_runner_forbidden', 'Managed runners cannot use tools', 403),
};

export class ManagedRunnerBindings {
  private validator?: ManagedRunnerValidator;
  constructor(
    private state: State,
    private scope: Scope,
    private clock: () => number,
    private secretEnv: string | undefined,
    private credentials: CredentialStore,
    /** Refuses once Sessions has closed. */
    private available: () => void,
  ) {}

  /** Whether Fleet rents machines for this server's automatic work at all. */
  get validating(): boolean {
    return !!this.validator;
  }
  serves(projectId: string): boolean {
    return !!this.validator?.serves(projectId);
  }
  registerValidator(validator: ManagedRunnerValidator): () => void {
    this.available();
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
      // A binding from before every machine was a work host has neither, and is not current.
      workInstanceId: row.work_instance_id ?? '',
      stepSeconds: Number(row.step_seconds),
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
    this.available();
    const parsed = enrollment.safeParse(input);
    check(parsed.success, 'invalid_managed_enrollment', 'Managed enrollment identity is invalid');
    const value = parsed.data as ManagedEnrollmentInput;
    check(
      value.capabilities?.includes('workflow.workhost.1'),
      'invalid_managed_enrollment',
      'Work host requires its capability',
    );
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
            row.control_expires_at === value.expiresAt &&
            row.work_instance_id === value.workInstanceId &&
            Number(row.step_seconds) === value.stepSeconds,
          'managed_binding_conflict',
          'Managed allocation identity cannot change',
          409,
        );
      } else {
        const now = new Date(this.clock()).toISOString();
        const enrollmentExpiresAt = new Date(
          Math.min(this.clock() + 900_000, Date.parse(value.expiresAt)),
        ).toISOString();
        await tx.run(
          'INSERT INTO session_managed_runners(allocation_id,epoch,project_id,source_json,source_hash,runtime_profile_id,platform_json,capabilities_json,enrollment_hash,enrollment_expires_at,control_hash,control_expires_at,created_at,work_instance_id,step_seconds) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          value.allocationId,
          value.epoch,
          value.source.projectId,
          canonical(value.source),
          digest(value.source),
          value.runtimeProfileId,
          canonical(value.platform),
          canonical(identity.capabilities),
          tokenDigest(enrollmentToken),
          enrollmentExpiresAt,
          tokenDigest(`unbound:${enrollmentToken}`),
          value.expiresAt,
          now,
          value.workInstanceId,
          value.stepSeconds,
        );
        await this.credentials.issue(
          {
            owner: 'sessions',
            subject: value.allocationId,
            kind: 'managed-enrollment',
            token: enrollmentToken,
            expiresAt: enrollmentExpiresAt,
            hardDeadline: enrollmentExpiresAt,
          },
          tx,
        );
      }
      return { enrollmentToken };
    });
  }
  async enroll(
    token: string,
    input: unknown,
    projectId?: unknown,
  ): Promise<{ controlToken: string }> {
    this.available();
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
      const credential = await this.credentials.authenticate(token, 'managed-enrollment', tx);
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
      check(
        credential.subject === row.allocation_id,
        'unauthorized',
        'Invalid managed enrollment',
        401,
      );
      // Before anything is written: a refused selection must not leave the runner enrolled.
      check(
        projectId === undefined || projectId === JSON.parse(row.source_json).projectId,
        'invalid_input',
        'Conflicting Merv project selections',
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
        await this.credentials.issue(
          {
            owner: 'sessions',
            subject: row.allocation_id,
            kind: 'managed-control',
            token: controlToken,
            expiresAt: row.control_expires_at,
            hardDeadline: row.control_expires_at,
          },
          tx,
        );
      }
      return { controlToken };
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
    this.available();
    check(
      typeof token === 'string' && /^mr_[0-9a-f]{64}$/.test(token),
      'unauthorized',
      'Invalid managed runner credential',
      401,
    );
    return await this.state.snapshotTransaction(async (tx) => {
      const credential = await this.credentials.authenticate(token, 'managed-control', tx);
      const row = await tx.get<ManagedBindingRow>(
        'SELECT * FROM session_managed_runners WHERE control_hash=?',
        tokenDigest(token),
      );
      check(
        row && row.worker_nonce_hash !== null && Date.parse(row.control_expires_at) > this.clock(),
        'unauthorized',
        'Managed runner credential expired or invalid',
        401,
      );
      check(
        credential.subject === row.allocation_id,
        'unauthorized',
        'Invalid managed runner credential',
        401,
      );
      await this.current(row, tx);
      return this.caller({ ...row, bound_session_id: await this.currentSessionId(row, tx) });
    });
  }
  /** This allocation's machine is gone for good: each session that ran on it is told so
   *  (session.machine_gone), so whatever waits on a handover from that machine stops waiting. */
  async machineGone(allocationId: string, tx: Transaction): Promise<void> {
    this.available();
    this.state.assertTransaction(tx);
    for (const row of await tx.all<{ id: string; project_id: string }>(
      `SELECT id,project_id FROM worker_sessions WHERE id IN (
         SELECT bound_session_id FROM session_managed_runners WHERE allocation_id=? AND bound_session_id IS NOT NULL
         UNION SELECT session_id FROM session_managed_assignments WHERE allocation_id=?)
       ORDER BY id`,
      allocationId,
      allocationId,
    ))
      await this.state.appendEvent(tx, {
        projectId: row.project_id,
        actorId: 'system:sessions',
        type: 'session.machine_gone',
        subjectId: row.id,
        data: { sessionId: row.id, allocationId },
      });
  }
  /** The session a managed runner holds, by its bearer or, when a relay checks again, its id:
   *  live, or closed by its own handoff, which says when so Fleet may honour a closing turn.
   *  Reading it never activates an offered session. */
  async boundSession(tokenOrSessionId: string): Promise<ManagedBoundSession> {
    this.available();
    return await this.state.snapshotTransaction(async (tx) => {
      const bearer = sessionSecretPattern.test(tokenOrSessionId);
      const credential = bearer
        ? await this.credentials.authenticate(tokenOrSessionId, 'session-execution', tx)
        : undefined;
      const found = await tx.get<{ session_json: string; token_hash: string }>(
        `SELECT session_json,token_hash FROM worker_sessions WHERE ${bearer ? 'token_hash' : 'id'}=?`,
        bearer ? tokenDigest(tokenOrSessionId) : tokenOrSessionId,
      );
      const session: Session | undefined = found && JSON.parse(found.session_json);
      const row = session && (await tx.get<ManagedBindingRow>(boundTo, session.id, session.id));
      check(
        !credential || credential.subject === session?.id,
        'unauthorized',
        'No live managed session holds this credential',
        401,
      );
      check(
        session &&
          row &&
          (session.status === 'offered' || session.status === 'active'
            ? Date.parse(session.expiresAt) > this.clock()
            : ownEnd(session.closeReason)),
        'unauthorized',
        'No live managed session holds this credential',
        401,
      );
      if (!bearer)
        await this.credentials.authenticateHash(found!.token_hash, 'session-execution', tx);
      await this.current(row, tx);
      await this.scope.requireDelegation(session.source, 'read', tx);
      const asker = session.inquiry
        ? await tx.get<{ asker_source_json: string }>(
            'SELECT asker_source_json FROM session_inquiries WHERE id=?',
            session.inquiry.id,
          )
        : undefined;
      return {
        ...(asker && {
          inquiry: { id: session.inquiry!.id, asker: JSON.parse(asker.asker_source_json) },
        }),
        sessionId: session.id,
        projectId: row.project_id,
        allocationId: row.allocation_id,
        ...(session.tokenBudget !== undefined && { tokenBudget: session.tokenBudget }),
        expiresAt: new Date(
          Math.min(Date.parse(session.hardDeadline), Date.parse(row.control_expires_at)),
        ).toISOString(),
        ...(ownEnd(session.closeReason) ? { handedOffAt: session.closedAt! } : {}),
      };
    });
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
        (!managed.boundSessionId ||
          managed.boundSessionId === (await this.currentSessionId(row, tx))),
      'unauthorized',
      'Managed runner authority is unavailable',
      401,
    );
    await this.credentials.authenticateHash(row.control_hash, 'managed-control', tx);
    await this.current(row, tx);
    return { row, sourceCaller: sourceCaller(JSON.parse(row.source_json)) };
  }
  /** Whether the machine's validator brokers Hugging Face downloads to its sessions. */
  huggingFace(row: ManagedBindingRow): boolean {
    return !!this.validator?.huggingFace?.(this.identity(row));
  }
  /** A decrypted HF grant authorizes only this exact binding, never runner control calls. */
  async huggingFaceBinding(
    binding: string,
    tx: Transaction,
  ): Promise<{ grant: HuggingFaceBinding; row: ManagedBindingRow }> {
    let grant: HuggingFaceBinding | undefined;
    try {
      grant = huggingFaceBinding.parse(JSON.parse(binding));
    } catch {
      grant = undefined;
    }
    const row =
      grant &&
      (await tx.get<ManagedBindingRow>(
        'SELECT * FROM session_managed_runners WHERE allocation_id=?',
        grant.allocationId,
      ));
    check(
      grant &&
        row &&
        Number(row.epoch) === grant.epoch &&
        (await this.hasSession(row, grant.sessionId, tx)) &&
        row.runner_id === grant.runnerId,
      'unauthorized',
      'Hugging Face access unavailable',
      401,
    );
    await this.require(this.caller(row), tx);
    return { grant, row: await this.forSession(row, grant.sessionId, tx) };
  }
  async heartbeat(caller: Caller, input: RunnerHeartbeat, tx: Transaction): Promise<Caller> {
    const { row, sourceCaller: source } = await this.require(caller, tx);
    // A runner whose lease reply was lost still offers its slot; its retry replays the binding.
    check(
      input.capacity === 1 || input.capacity === 0,
      'managed_capacity',
      'Managed runner capacity must be one or zero',
      409,
    );
    check(
      input.platforms.length === 1 &&
        canonical(input.platforms[0]) === row.platform_json &&
        // Its enrolment's, and whether its image runs inquiry visits, which only it can say.
        canonical((input.capabilities ?? []).filter((item) => item !== INQUIRY_CAPABILITY)) ===
          row.capabilities_json,
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
  /** Code transfers remain bound to the unfinished phase, including its final capture. */
  private async currentSessionId(row: ManagedBindingRow, tx: Transaction): Promise<string | null> {
    return (
      (
        await tx.get<{ session_id: string }>(
          'SELECT session_id FROM session_managed_assignments WHERE allocation_id=? AND settled_at IS NULL',
          row.allocation_id,
        )
      )?.session_id ?? null
    );
  }
  async forSession(
    row: ManagedBindingRow,
    sessionId: string,
    tx: Transaction,
  ): Promise<ManagedBindingRow> {
    const assignment = await tx.get<{
      source_json: string;
      runner_id: string;
      release_ack_at: string | null;
    }>(
      'SELECT source_json,runner_id,release_ack_at FROM session_managed_assignments WHERE allocation_id=? AND session_id=?',
      row.allocation_id,
      sessionId,
    );
    check(assignment, 'session_forbidden', 'Session is not bound to this managed runner', 403);
    return {
      ...row,
      source_json: assignment.source_json,
      runner_id: assignment.runner_id,
      bound_session_id: sessionId,
      runner_released_at: assignment.release_ack_at,
    };
  }
  async hasSession(row: ManagedBindingRow, sessionId: string, tx: Transaction): Promise<boolean> {
    return !!(await tx.get(
      'SELECT session_id FROM session_managed_assignments WHERE allocation_id=? AND session_id=?',
      row.allocation_id,
      sessionId,
    ));
  }
  async sources(row: ManagedBindingRow, tx: Transaction): Promise<Caller[]> {
    check(this.validator, 'managed_unavailable', 'Work host directors unavailable', 503);
    const sources = await this.validator.assignmentSources(this.identity(row), tx);
    check(
      sources.length <= 2 && sources.every((source) => source.projectId === row.project_id),
      'managed_source',
      'Invalid work host directors',
      403,
    );
    return sources.map(sourceCaller);
  }
  /** A missing process acknowledgement can release a machine, but never reuse one. */
  async reusable(row: ManagedBindingRow, tx: Transaction): Promise<boolean> {
    const pending = await tx.get<{ session_id: string }>(
      'SELECT session_id FROM session_managed_assignments WHERE allocation_id=? AND settled_at IS NULL',
      row.allocation_id,
    );
    if (!pending) return true;
    const observed = await this.inspect(row.allocation_id, Number(row.epoch), tx);
    const session = observed?.session;
    if (
      !session ||
      !['released', 'expired'].includes(session.status) ||
      !session.releaseAcknowledged ||
      session.capturePending
    )
      return false;
    if (this.state.readScope)
      throw new MervError('read_only_scope', 'Settling a work host requires a write', 409);
    const credential = await tx.get<{ token_hash: string }>(
      'SELECT token_hash FROM worker_sessions WHERE id=?',
      pending.session_id,
    );
    if (credential) await this.credentials.revoke(credential.token_hash, 'sessions', tx);
    await tx.run(
      'UPDATE session_managed_assignments SET settled_at=? WHERE session_id=? AND settled_at IS NULL',
      new Date(this.clock()).toISOString(),
      pending.session_id,
    );
    return true;
  }
  async bind(row: ManagedBindingRow, sessionId: string, tx: Transaction): Promise<void> {
    const found = await tx.get<{ session_json: string }>(
      'SELECT session_json FROM worker_sessions WHERE id=?',
      sessionId,
    );
    const session: Session = JSON.parse(found!.session_json);
    check(
      session.projectId === row.project_id &&
        session.instanceId === row.work_instance_id &&
        session.runnerId === row.runner_id,
      'managed_work_conflict',
      'Work host cannot lease another workflow',
      409,
    );
    await tx.run(
      'INSERT INTO session_managed_assignments(session_id,allocation_id,runner_id,source_json,bound_at) VALUES(?,?,?,?,?)',
      sessionId,
      row.allocation_id,
      row.runner_id,
      canonical(session.source),
      new Date(this.clock()).toISOString(),
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
      (await this.currentSessionId(row, tx)) === sessionId &&
        (!runnerId || row.runner_id === runnerId),
      'session_forbidden',
      'Session is not bound to this managed runner',
      403,
    );
  }
  /** The release of `caller`'s bound session, which the caller's control already admitted. */
  async acknowledgeRelease(caller: Caller, sessionId: string, tx: Transaction): Promise<void> {
    const { row } = await this.require(caller, tx);
    await tx.run(
      'UPDATE session_managed_assignments SET release_ack_at=COALESCE(release_ack_at,?) WHERE allocation_id=? AND session_id=?',
      new Date(this.clock()).toISOString(),
      row.allocation_id,
      sessionId,
    );
  }
  /** Whether a live session's machine is no longer current, so no runner is left to release it:
   *  undefined while it is (or none is bound), else whether a release retired it. */
  async stranded(sessionId: string, tx: Transaction): Promise<boolean | undefined> {
    const row = await tx.get<ManagedBindingRow>(boundTo, sessionId, sessionId);
    if (!row || !this.validator || (await this.validator.current(this.identity(row), tx))) return;
    return await this.validator.retired(this.identity(row), tx);
  }
  /** When the machine's person has no model tokens left today, the moment that ends; else null. */
  async modelWait(row: ManagedBindingRow, tx: Transaction): Promise<{ resetsAt: string } | null> {
    return (await this.validator?.modelBudget?.(this.identity(row), tx)) ?? null;
  }
  /** The same, of the machine a session ran on; null for a session no machine of Fleet's ran. */
  async sessionModelWait(sessionId: string, tx: Transaction): Promise<{ resetsAt: string } | null> {
    const row = await tx.get<ManagedBindingRow>(boundTo, sessionId, sessionId);
    return row ? await this.modelWait(row, tx) : null;
  }
  async inspect(
    allocationId: string,
    epoch: number,
    transaction?: Transaction,
  ): Promise<ManagedRunnerInspection | null> {
    this.available();
    check(
      typeof allocationId === 'string' &&
        allocationId.length > 0 &&
        Number.isSafeInteger(epoch) &&
        epoch >= 0,
      'invalid_managed_allocation',
      'Managed allocation identity is invalid',
    );
    const read = async (tx: Transaction) => {
      const row = await tx.get<ManagedBindingRow>(
        'SELECT * FROM session_managed_runners WHERE allocation_id=?',
        allocationId,
      );
      if (!row || Number(row.epoch) !== epoch) return null;
      const runner = {
        runnerId: row.runner_id,
        enrollmentExpiresAt: row.enrollment_expires_at,
      };
      const latest = await tx.get<{ session_id: string }>(
        'SELECT session_id FROM session_managed_assignments WHERE allocation_id=? ORDER BY ordinal DESC LIMIT 1',
        row.allocation_id,
      );
      if (!latest) return { ...runner, session: null };
      Object.assign(row, await this.forSession(row, latest.session_id, tx));
      const bound = await tx.get<{ session_json: string }>(
        'SELECT session_json FROM worker_sessions WHERE id=?',
        row.bound_session_id,
      );
      const session = JSON.parse(bound!.session_json) as Session;
      const workspace = await tx.get<{ result_json: string | null }>(
        'SELECT result_json FROM session_workspaces WHERE session_id=?',
        row.bound_session_id,
      );
      const owed = await tx.get<{ declared_at: string }>(
        // A conversation the session kept is owed as its transcript is.
        `SELECT declared_at FROM session_transcripts WHERE session_id=? AND uploaded_at IS NULL
         UNION ALL SELECT updated_at FROM session_threads WHERE latest_session_id=? AND sha256 IS NOT NULL AND uploaded_at IS NULL AND status<>'retired'
         ORDER BY 1 LIMIT 1`,
        row.bound_session_id,
        row.bound_session_id,
      );
      const policy = effectiveWorkspace(session.execution.policy);
      // A disposable read-only checkout has no durable workspace output to wait for.
      // Writable and retained checkouts still require their final capture.
      const disposableReview =
        session.execution.policy.readOnly && policy.mode === 'ephemeral' && !policy.retain;
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
          capturePending:
            (!!workspace && workspace.result_json === null && !disposableReview) ||
            (!!owed && this.clock() - Date.parse(owed.declared_at) < transcriptGraceMs),
        },
      };
    };
    return transaction ? await read(transaction) : await this.state.snapshotTransaction(read);
  }
}
