import { visible, createService, mapAsync } from '@merv/contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { postgresMigrations } from './index.postgres.js';
import { managedNoncePostgresMigration } from './managed-nonce.postgres.js';
import { createHash } from 'node:crypto';
import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import {
  canonical,
  check,
  digest,
  effectiveWorkspace,
  MervError,
  newId,
  parsed,
  plain,
  sessionSecretPattern,
  sessionUsageReportSchema,
  sessionWorkspaceSchema,
  type Caller,
  type Data,
  type DelegationSource,
  type DomainEvents,
  type Permission,
  type Scope,
  type State,
  type Transaction,
  type WorkflowExecution,
  type Workflows,
} from '@merv/contracts';
import { SessionDispatch, failureReasons } from './dispatch.js';
import { AgentDirectory, sourceCaller, tokenDigest } from './agents.js';
import { AgentObservations, lastActivity } from './observations.js';
import { isoNow, liveTargets, ownerOf, targetKey } from './common.js';
import { SessionServiceWork } from './service-work.js';
import { ManagedRunnerBindings } from './managed.js';
import type {
  ManagedEnrollmentInput,
  ManagedRunnerInspection,
  ManagedRunnerValidator,
} from './managed-types.js';
import { accountingMethod, recordUsage, reportUsage, usageTotals } from './usage.js';
import type { Agent, AgentStatus, AgentRegistration, AgentAssignment } from './types.js';
import type {
  Session,
  SessionControl,
  SessionInvocation,
  SessionOffer,
  Sessions,
  AutomaticLease,
  DispatchDemand,
  DispatchDemandInput,
  DispatchHold,
  DispatchState,
  RunnerHeartbeat,
  RunnerPresence,
  RunnerSettings,
  SessionsProjectStatus,
  StuckReport,
  SessionDeferral,
  SessionOutcome,
  SessionReleaseOutcome,
  SessionWorkspace,
  SessionWorkspaceObservation,
  SessionBudgetInput,
  SessionUsageReport,
  BudgetStatus,
  UsageQuery,
  UsageRollup,
} from './types.js';
export type * from './types.js';

/** An integer bound; null, like absence, means the default. */
const between = (least: number, most: number, fallback: number) =>
  z
    .number()
    .int()
    .min(least)
    .max(most)
    .nullish()
    .transform((value) => value ?? fallback);
/**
 * Closing for idleness is off unless a deployment asks for it: a tool call is the only
 * progress the server sees, and honest work can be hours of local computing with none.
 * Any other key is refused.
 */
const configSchema = z
  .object({
    /** Maximum simultaneous server executions in one project, across every provider. */
    serviceConcurrency: between(1, 256, 1),
    sweepIntervalMs: between(100, 60_000, 1000),
    /** Failed launches of one instance revision after which automatic dispatch stops offering it. */
    maxLaunchFailures: between(1, 100, 5),
    /** Seconds without a tool call before an active session is reported as quiet; nothing is closed for it. */
    idleNoticeSeconds: between(60, 604_800, 1800),
    /** Seconds a dispatchable target may wait on one revision before it is reported as quiet. */
    quietReadySeconds: between(60, 2_592_000, 21_600),
    /** Seconds a live runner may repeat one refusal before it is reported as refusing. */
    refusalSeconds: between(30, 86_400, 300),
    /** Separate operator secret for deterministic managed credentials. */
    managedSecretEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
  })
  .strict();
export type SessionsConfig = z.input<typeof configSchema>;
const live = (session: Session) => session.status === 'offered' || session.status === 'active';
/** Trimmed text with something to read, as it is stored and compared. */
const trimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => visible(value) && !value.includes('\0'));
const secret = z.string().regex(sessionSecretPattern);
const offerSchema = z
  .object({
    requestId: trimmed(256),
    agentId: trimmed(200).optional(),
    instanceId: trimmed(200),
    expectedRevision: z.number().int().nonnegative().safe(),
    runnerId: trimmed(200),
    secret,
    hardDeadlineSeconds: z.number().int().min(300).max(604_800).optional(),
  })
  .strict();
const offerRefusals = {
  fallback: [
    'invalid_session_offer',
    'Offer requires a target revision, runner, request and caller-generated ms_ secret',
  ],
  fields: {
    requestId: ['invalid_request_id', 'A stable requestId of 1–256 characters is required'],
    hardDeadlineSeconds: ['invalid_deadline', 'Session hard deadline must be 300–604800 seconds'],
  },
} as const;
const assignmentSchema = offerSchema.omit({ agentId: true, runnerId: true, secret: true });
const registrationSchema = z
  .object({ name: trimmed(200), runnerId: trimmed(200), requestId: trimmed(256), secret })
  .strict();
/** Every control names its session and the runner that holds it; the runner is checked. */
const controlSchema = z.object({ sessionId: z.string(), runnerId: trimmed(200) }).strict();
const hostSchema = controlSchema.extend({
  hostRef: trimmed(512),
  workspace: sessionWorkspaceSchema.optional(),
});
const resultSchema = hostSchema.extend({ workspace: sessionWorkspaceSchema });
const controlRefusals = {
  fallback: [
    'invalid_session_control',
    'A session control names the session and its runner, and no other field',
  ],
  fields: {
    hostRef: ['invalid_host', 'A nonempty host reference is required'],
    workspace: ['invalid_workspace', 'Workspace metadata must match the closed schema'],
  },
} as const;
const releaseSchema = controlSchema
  .extend({
    usage: sessionUsageReportSchema.optional(),
    outcome: z
      .enum([
        'completed',
        'host_failed',
        'launch_failed',
        'workspace_failed',
        'preparation_deferred',
        'crash_loop',
      ])
      .optional(),
    /** Opaque to Sessions: whatever prepares checkouts names the cause, and Sessions records it. */
    deferral: z
      .object({
        cause: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
      })
      .strict()
      .optional(),
    reason: trimmed(200).optional(),
  })
  // A deferral is what keeps a put-off preparation out of the counters, so it is named or
  // the close is an ordinary failure. Nothing else carries one.
  .refine(
    (input) => (input.outcome === 'preparation_deferred') === (input.deferral !== undefined),
    { path: ['deferral'] },
  );
const releaseRefusals = {
  fallback: controlRefusals.fallback,
  fields: {
    usage: [
      'invalid_usage',
      'Usage reports non-negative token counts and an optional cost and model',
    ],
    outcome: ['invalid_outcome', 'Unknown session process outcome'],
    deferral: [
      'invalid_deferral',
      'A deferred preparation names its cause and code, and no other outcome carries one',
    ],
    reason: ['invalid_reason', 'Release reason must be 1–200 characters'],
  },
} as const;
/**
 * Parses one closed input. A refusal carries the code of the first field it names, or the
 * fallback for an unknown key or a malformed whole.
 */
function closed<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
  refusals: {
    fallback: readonly [string, string];
    fields?: Readonly<Record<string, readonly [string, string]>>;
  },
): z.output<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path[0];
  const [code, message] =
    (typeof field === 'string' && refusals.fields?.[field]) || refusals.fallback;
  throw new MervError(code, message);
}
/**
 * Why a session that has already ended is refusing. The reason survives the first refusal
 * because a worker whose response was lost has nothing else to go on: retrying its handoff
 * must keep telling it the handoff landed, rather than degrading to "closed" and leaving it
 * unable to tell a committed delivery from a halt.
 */
const ended = (session: Session): MervError =>
  session.closeReason === 'handoff'
    ? new MervError(
        'session_completed',
        'This session’s handoff completed and the session has ended; its record moved on',
        401,
      )
    : new MervError(
        'session_closed',
        session.closeReason ? `Session is closed: ${session.closeReason}` : 'Session is closed',
        401,
      );
/** What session.workspace_attached and session.workspace_result say. */
const workspaceEvent = (session: Session, workspace: SessionWorkspace) => ({
  sessionId: session.id,
  instanceId: session.instanceId,
  expectedRevision: session.expectedRevision,
  policyHash: session.execution.policyHash,
  workflow: session.execution.workflow,
  version: session.execution.version,
  state: session.execution.state,
  workerActorId: session.actorId,
  source: session.source,
  workspace: { ...workspace },
});
const permission = (role: Session['role']): Permission =>
  role === 'producer' ? 'write' : role === 'reviewer' ? 'review' : 'read';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const snapshotInput = (input: Data): Data =>
  plain(input, 'invalid_input', {
    keys: 'any',
    strings: 'json',
    undefined: 'reject',
    nullPrototype: false,
  });
const text = (value: unknown, max = 200) =>
  typeof value === 'string' && visible(value) && value.length <= max && !value.includes('\0');
const safeError = (error: unknown): MervError =>
  error instanceof MervError
    ? error
    : new MervError('session_unavailable', 'Session validation is unavailable', 503);
interface Row {
  id: string;
  project_id: string;
  owner_hash: string;
  token_hash: string;
  fingerprint: string;
  session_json: string;
}
interface Frame {
  tx: Transaction;
  actorId: string;
  sessionId: string;
  source: DelegationSource;
  role: Session['role'];
}
interface InvocationState {
  public: SessionInvocation;
  sessionId: string;
  registrationId: string;
  running: boolean;
  used: boolean;
  input: Data;
  validated: boolean;
  /** The tool only reads, so the project is its bound rather than the policy. */
  read: boolean;
}

/** Durable step credentials. Domain reservations and all lifecycle mutations share State transactions. */
export class LeasedSessions implements Sessions {
  private readonly frames = new AsyncLocalStorage<Frame[]>();
  private readonly invocations = new WeakMap<SessionInvocation, InvocationState>();
  private readonly invocationIds = new Map<string, InvocationState>();
  private readonly fenced = new WeakMap<Transaction, Set<string>>();
  private readonly disposers: (() => void | Promise<void>)[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private dispatcher!: SessionDispatch;
  serviceWork!: SessionServiceWork;
  private directory!: AgentDirectory;
  private observations!: AgentObservations;
  private managed!: ManagedRunnerBindings;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly workflows: Workflows,
    private readonly events: DomainEvents,
    options: SessionsConfig & { clock?: () => number } = {},
  ) {
    // A clock function is a test hook, not configuration; JSON config can never supply one.
    const config = parsed(
      configSchema,
      typeof options?.clock === 'function' ? { ...options, clock: undefined } : options,
      'invalid_sessions_config',
    );
    this.initialize = async () => {
      this.clock = options.clock ?? Date.now;
      this.thresholds = {
        idleNoticeSeconds: config.idleNoticeSeconds,
        maxLaunchFailures: config.maxLaunchFailures,
        quietReadySeconds: config.quietReadySeconds,
        refusalSeconds: config.refusalSeconds,
      };
      await state.migrate('sessions', [
        {
          version: 1,
          sql: postgresMigrations[1],
        },
        {
          version: 2,
          sql: postgresMigrations[2],
        },
        {
          version: 3,
          sql: postgresMigrations[3],
        },
        {
          // A new table, because a closed session row refuses every update: what a session
          // cost is known only at and after its close.
          version: 4,
          sql: postgresMigrations[4],
        },
        {
          version: 5,
          sql: postgresMigrations[5],
        },
        {
          version: 6,
          sql: postgresMigrations[6],
        },
        { version: 7, sql: postgresMigrations[7] },
        { version: 8, sql: managedNoncePostgresMigration },
      ]);
      this.managed = new ManagedRunnerBindings(state, scope, this.clock, config.managedSecretEnv);
      this.directory = await createService(new AgentDirectory(state, scope, this.clock));
      this.observations = await createService(new AgentObservations(state, scope, this.clock));
      this.dispatcher = await createService(
        new SessionDispatch(
          state,
          scope,
          workflows,
          this.observations,
          {
            managed: this.managed,
            prepare: async (caller) => await this.prepareControl(caller),
            offer: async (caller, input, tx) => await this.offerTransaction(caller, input, tx),
            close: async (session, reason, tx) => {
              // A session whose record already moved is closed by what moved it, not by the halt.
              const closed = await this.reconcile(session, tx);
              if (closed) return false;
              await this.closeSession(session, reason, tx, 'released', 'halted');
              return true;
            },
          },
          this.clock,
          this.thresholds,
        ),
      );
      this.serviceWork = new SessionServiceWork(
        state,
        scope,
        workflows,
        this.clock,
        config.serviceConcurrency,
      );
      await this.serviceWork.initialize();
      try {
        this.disposers.push(
          scope.registerSessionAuthority({
            require: async (caller, tx) => await this.guard(caller, tx),
          }),
        );
        this.disposers.push(
          scope.registerManagedRunnerAuthority({
            require: async (caller, tx) =>
              JSON.parse((await this.managed.require(caller, tx)).row.source_json),
          }),
        );
        await this.observations.interrupt();
        this.disposers.push(
          await events.subscribe({
            id: 'sessions.lifecycle.v1',
            from: 'beginning',
            types: [
              'session.closed',
              'actor.revoked',
              'actor.permissions_changed',
              'actor.credential_revoked',
              'actor.credential_rotated',
              'actor.key_revoked',
              'actor.key_rotated',
            ],
            handle: async (event, tx) => {
              if (event.type === 'session.closed') {
                // Sessions are never deleted, except those of retired workflow instances
                // (sessions@6), whose leases went with them. A close that was logged but not
                // yet consumed has nothing left to release, and must not stall this consumer.
                const row = await tx.get<Row>(
                  'SELECT * FROM worker_sessions WHERE id=?',
                  event.subjectId,
                );
                if (!row) return;
                const session = await this.decode(row, tx);
                await this.workflows.releaseLease(
                  session.lease,
                  { reason: session.closeReason ?? 'closed' },
                  tx,
                );
              } else await this.sweepTransaction(tx);
            },
          }),
        );
        this.timer = setInterval(async () => {
          try {
            await this.sweep();
          } catch {
            /* Durable events and the next sweep retry; no secret-bearing errors are logged. */
          }
        }, config.sweepIntervalMs);
        this.timer.unref();
      } catch (error) {
        await this.close();
        throw error;
      }
    };
  }
  private clock!: () => number;
  private thresholds!: StuckReport['thresholds'];
  private idleCheckedAt = Number.NEGATIVE_INFINITY;
  private ensureOpen(): void {
    check(!this.closed, 'session_unavailable', 'Sessions is unavailable', 503);
  }
  private ordinary(caller: Caller): void {
    check(
      !caller.managed,
      'forbidden',
      'Managed runners may only use their bound session controls',
      403,
    );
  }
  private async transaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T> {
    this.ensureOpen();
    return await this.state.read(async (sql) => {
      this.ensureOpen();
      return 'transactionId' in sql ? fn(sql as Transaction) : await this.state.transaction(fn);
    });
  }
  /**
   * The same handle on a read-only snapshot: admission checks only read, and a worker
   * makes several of them per tool call, so none of them may queue on the writer lock.
   */
  private async reading<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T> {
    this.ensureOpen();
    return await this.state.snapshot(() => this.transaction(fn));
  }
  private async row(tx: Transaction, id: string): Promise<Row> {
    const row = await tx.get<Row>('SELECT * FROM worker_sessions WHERE id=?', id);
    check(row, 'session_not_found', 'Session not found', 404);
    return row;
  }
  private async decode(row: Row, tx: Transaction): Promise<Session> {
    const session: Session = JSON.parse(row.session_json);
    const workspace = await tx.get<{ attachment_json: string; result_json: string | null }>(
      'SELECT attachment_json,result_json FROM session_workspaces WHERE session_id=?',
      row.id,
    );
    if (workspace)
      session.workspace = {
        attachment: JSON.parse(workspace.attachment_json),
        result: workspace.result_json === null ? null : JSON.parse(workspace.result_json),
      };
    return session;
  }
  private async save(tx: Transaction, session: Session): Promise<void> {
    const { workspace: _workspace, ...stored } = session;
    await tx.run(
      'UPDATE worker_sessions SET status=?,session_json=? WHERE id=?',
      session.status,
      JSON.stringify(stored),
      session.id,
    );
  }
  private worker(
    session: Pick<Session, 'id' | 'actorId' | 'projectId' | 'agentSessionId'>,
  ): Caller {
    return {
      actorId: session.actorId,
      projectId: session.projectId,
      session: {
        id: session.id,
        ...(session.agentSessionId ? { agentSessionId: session.agentSessionId } : {}),
      },
    };
  }
  private async framed<T>(frame: Frame, fn: () => T | Promise<T>): Promise<T> {
    this.state.assertTransaction(frame.tx);
    return this.frames.run([...(this.frames.getStore() ?? []), frame], fn);
  }
  private async source(session: Session, tx: Transaction): Promise<void> {
    await this.scope.requireDelegation(session.source, permission(session.role), tx);
    if (session.agentId)
      await this.directory.require(await this.directory.get(session.agentId, tx), tx);
  }
  private async valid(session: Session, tx: Transaction): Promise<WorkflowExecution> {
    this.ensureOpen();
    check(live(session), 'session_closed', 'Session is closed', 401);
    check(
      session.expiresAt > isoNow(this.clock) && session.hardDeadline > isoNow(this.clock),
      'session_expired',
      'Session has expired',
      401,
    );
    await this.source(session, tx);
    const execution = await this.framed(
      {
        tx,
        actorId: session.actorId,
        sessionId: session.id,
        source: session.source,
        role: session.role,
      },
      () => this.workflows.checkLease(this.worker(session), session.lease, tx),
    );
    this.ensureOpen();
    check(
      session.expiresAt > isoNow(this.clock) && session.hardDeadline > isoNow(this.clock),
      'session_expired',
      'Session expired during validation',
      401,
    );
    return execution;
  }
  private async guard(caller: Caller, tx: Transaction): Promise<DelegationSource> {
    this.ensureOpen();
    this.state.assertTransaction(tx);
    const frame = this.frames
      .getStore()
      ?.findLast(
        (frame) =>
          frame.tx === tx &&
          frame.actorId === caller.actorId &&
          frame.sessionId === caller.session?.id,
      );
    if (frame) {
      await this.scope.requireDelegation(frame.source, permission(frame.role), tx);
      this.ensureOpen();
      return frame.source;
    }
    check(caller.session, 'session_required', 'Worker authority requires a session', 401);
    const session = await this.decode(await this.row(tx, caller.session.id), tx);
    check(
      session.actorId === caller.actorId && session.projectId === caller.projectId,
      'forbidden',
      'Session cannot select another worker',
      403,
    );
    check(
      live(session) &&
        session.expiresAt > isoNow(this.clock) &&
        session.hardDeadline > isoNow(this.clock),
      'session_closed',
      'Session is closed or expired',
      401,
    );
    await this.source(session, tx);
    const invocationId = caller.session.invocationId;
    if (invocationId !== undefined) {
      const invocation = this.invocationIds.get(invocationId);
      check(
        invocation && invocation.sessionId === session.id && !invocation.used,
        'session_invocation',
        'Session invocation is unavailable',
        403,
      );
      const fenced = this.fenced.get(tx);
      if (invocation.running && fenced?.has(invocationId)) return session.source;
      const current = await this.valid(session, tx);
      check(
        current.registrationId === invocation.registrationId,
        'execution_replaced',
        'Workflow implementation changed during invocation',
        409,
      );
      if (invocation.running) {
        const memo = fenced ?? new Set<string>();
        memo.add(invocationId);
        this.fenced.set(tx, memo);
      }
    } else await this.valid(session, tx);
    return session.source;
  }
  private async controlled(
    caller: Caller,
    id: string,
    runnerId: string | undefined,
    tx: Transaction,
  ): Promise<Session> {
    if (caller.managed) {
      await this.managed.controlled(caller, id, runnerId, tx);
      const row = await this.row(tx, id);
      check(row.project_id === caller.projectId, 'session_not_found', 'Session not found', 404);
      return await this.decode(row, tx);
    }
    const owner = await ownerOf(this.scope, caller, tx),
      row = await this.row(tx, id);
    // Another project's session is not found here; another owner's is forbidden.
    check(row.project_id === caller.projectId, 'session_not_found', 'Session not found', 404);
    check(
      row.owner_hash === owner.hash,
      'session_forbidden',
      'Session belongs to another source authority',
      403,
    );
    const session = await this.decode(row, tx);
    if (runnerId !== undefined)
      check(
        session.runnerId === runnerId,
        'session_forbidden',
        'Session belongs to another runner',
        403,
      );
    return session;
  }
  private async closeSession(
    session: Session,
    reason: string,
    tx: Transaction,
    status: 'released' | 'expired' = 'expired',
    outcome?: SessionOutcome,
  ): Promise<Session> {
    if (!live(session)) return session;
    session.status = status;
    session.closedAt = isoNow(this.clock);
    session.closeReason = reason;
    session.outcome = outcome ?? (status === 'expired' ? 'expired' : 'released');
    await this.save(tx, session);
    await recordUsage(tx, session);
    // An offer that lapsed before any process activated it is a launch that was lost, and
    // would otherwise be re-offered every five minutes for ever with nothing counting it.
    const failure = failureReasons.has(session.outcome)
      ? session.outcome
      : reason === 'session_expired' && session.activatedAt === null
        ? 'offer_expired'
        : undefined;
    if (failure) await this.dispatcher.failed(session, failure, tx);
    if (session.agentId) {
      const agent = await this.directory.get(session.agentId, tx);
      if (!agent.persistent) await this.directory.retire(agent, reason, tx);
    } else await this.scope.retireSessionActor(session.actorId, reason, tx);
    await this.state.appendEvent(tx, {
      projectId: session.projectId,
      actorId: 'system:sessions',
      type: 'session.closed',
      subjectId: session.id,
      data: {
        sessionId: session.id,
        workerActorId: session.actorId,
        instanceId: session.instanceId,
        revision: session.expectedRevision,
        status,
        outcome: session.outcome,
        ...(session.deferral ? { deferral: { ...session.deferral } } : {}),
        reason,
        source: session.source,
      },
    });
    // The program releases the lease now while it is loaded, so the record is free the moment
    // the halt answers; the durable event replays the same cleanup if the provider was away.
    try {
      await this.workflows.releaseLease(session.lease, { reason }, tx);
    } catch (error) {
      if (!(error instanceof MervError)) throw error;
    }
    return session;
  }
  /** The record moved by this worker's own hand: its handoff landed. */
  private async handedOff(session: Session, tx: Transaction): Promise<boolean> {
    const moved = await tx.get<{ actor_id: string }>(
      'SELECT actor_id FROM wf_history WHERE instance_id=? AND revision=?',
      session.instanceId,
      session.expectedRevision + 1,
    );
    return moved?.actor_id === session.actorId;
  }
  private async reconcile(session: Session, tx: Transaction): Promise<MervError | undefined> {
    if (!live(session)) return ended(session);
    try {
      await this.valid(session, tx);
      return;
    } catch (error) {
      const failure = safeError(error);
      if (failure.status >= 500) return failure;
      // The record moved by this worker's own hand: that is its handoff, not a conflict.
      const handoff =
        failure.code === 'session_completed' ||
        (failure.code === 'revision_conflict' && (await this.handedOff(session, tx)));
      // A poll on a read snapshot reports the closure it found; the sweep records it.
      const close = async (
        ...rest: Parameters<typeof this.closeSession> extends [Session, ...infer R] ? R : never
      ) => {
        try {
          await this.closeSession(session, ...rest);
        } catch (error) {
          if (!(error instanceof MervError) || error.code !== 'read_only_scope') throw error;
        }
      };
      if (!handoff) {
        await close(failure.code, tx);
        // Time says expired; a record moved by another hand says the session ended, so a
        // worker is not sent to refresh and retry into a closed session.
        return failure.code === 'revision_conflict'
          ? new MervError('session_closed', `This session has ended: ${failure.message}`, 401)
          : failure;
      }
      await close('handoff', tx, 'released', 'completed');
      return new MervError(
        'session_completed',
        'This session’s handoff completed and the session has ended; its record moved on',
        401,
      );
    }
  }
  async contributors(
    projectId: string,
    instanceId: string,
    beforeRevision: number | null,
    tx: Transaction,
  ) {
    this.state.assertTransaction(tx);
    const writable = "(session_json::jsonb #>> '{execution,policy,readOnly}')='false'";
    const rows = await tx.all<{ id: string; actor_id: string; session_json: string }>(
      `SELECT id,actor_id,session_json FROM worker_sessions WHERE project_id=? AND instance_id=? AND ${writable}${beforeRevision === null ? '' : ' AND revision<?'} ORDER BY id`,
      projectId,
      instanceId,
      ...(beforeRevision === null ? [] : [beforeRevision]),
    );
    return rows.map((row) => ({
      ref: row.id,
      actorId: row.actor_id,
      authorityId: (JSON.parse(row.session_json) as Session).source.actorId,
    }));
  }

  async offer(caller: Caller, input: SessionOffer): Promise<Session> {
    this.ordinary(caller);
    return await this.offerParsed(
      structuredClone(caller),
      closed(offerSchema, input, offerRefusals),
    );
  }
  /** Both callers parse first: an assignment's derived request id runs past a caller's bound. */
  private async offerParsed(caller: Caller, input: SessionOffer): Promise<Session> {
    await this.prepareControl(caller);
    return await this.transaction(async (tx) => await this.offerTransaction(caller, input, tx));
  }
  private async prepareControl(caller: Caller): Promise<void> {
    // Close prior authority in its own commit, then recover reservations through the
    // durable consumer before trying to acquire a successor. A failed offer cannot
    // roll back retirement, and a failed cleanup cannot partially commit its effects.
    check(
      !(await this.state.read((sql) => 'transactionId' in sql)),
      'nested_session_offer',
      'Session offers require their own control transaction',
    );
    await this.scope.delegationSource(caller);
    await this.sweep();
    await this.events.drain();
  }
  private async offerTransaction(
    caller: Caller,
    input: SessionOffer,
    tx: Transaction,
  ): Promise<Session> {
    const duration = input.hardDeadlineSeconds ?? 86400;
    const owner = await ownerOf(this.scope, caller, tx);
    const fingerprint = digest({
      instanceId: input.instanceId,
      expectedRevision: input.expectedRevision,
      runnerId: input.runnerId,
      hardDeadlineSeconds: duration,
      tokenHash: tokenDigest(input.secret),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
    const old = await tx.get<Row>(
      'SELECT * FROM worker_sessions WHERE owner_hash=? AND runner_id=? AND request_id=?',
      owner.hash,
      input.runnerId,
      input.requestId,
    );
    if (old) {
      check(
        old.fingerprint === fingerprint,
        'request_conflict',
        'Session request was already used for different input',
        409,
      );
      return await this.decode(old, tx);
    }
    // Authority first: a caller who may not offer learns nothing about live sessions or secrets.
    const role = await this.workflows.leaseRole(caller, input, tx);
    check(
      role === 'producer' || role === 'reviewer' || role === 'reader',
      'invalid_session_role',
      'Worker sessions cannot receive an operator role',
      403,
    );
    check(
      !(await tx.get(
        "SELECT id FROM worker_sessions WHERE project_id=? AND instance_id=? AND revision=? AND status IN ('offered','active')",
        caller.projectId,
        input.instanceId,
        input.expectedRevision,
      )),
      'session_conflict',
      'This workflow step already has a live session',
      409,
    );
    check(
      !(await tx.get(
        'SELECT id FROM worker_sessions WHERE token_hash=?',
        tokenDigest(input.secret),
      )) && !(await this.directory.findToken(input.secret, tx)),
      'session_secret_used',
      'Session secret was already used',
      409,
    );
    const id = newId('session');
    const agent = input.agentId
      ? await this.directory.controlled(caller, input.agentId, tx)
      : await this.directory.create(
          caller,
          {
            name: `Agent ${input.runnerId}`.slice(0, 200),
            runnerId: input.runnerId,
            requestId: `assignment:${digest({ requestId: input.requestId, runnerId: input.runnerId })}`,
            secret: input.secret,
          },
          tx,
          false,
        );
    await this.directory.require(agent, tx, 409);
    check(
      agent.runnerId === input.runnerId,
      'agent_forbidden',
      'Agent belongs to another runner',
      403,
    );
    check(
      !(await this.currentAgentExecution(agent, tx)),
      'agent_busy',
      'Release the current assignment before requesting another',
      409,
    );
    await this.scope.setAgentRole(owner.source, agent.actorId, role, tx);
    const actor = { id: agent.actorId };
    const worker = this.worker({
      id,
      actorId: actor.id,
      projectId: caller.projectId,
      agentSessionId: agent.sessionId,
    });
    const frozen = await this.framed(
      { tx, actorId: actor.id, sessionId: id, source: owner.source, role },
      () =>
        this.workflows.offerLease(
          caller,
          worker,
          { instanceId: input.instanceId, expectedRevision: input.expectedRevision, leaseId: id },
          tx,
        ),
    );
    const workspace = effectiveWorkspace(frozen.execution.policy);
    if (workspace.mode !== 'none' && workspace.driver !== undefined)
      check(
        await this.dispatcher.capable(caller, input.runnerId, workspace.driver, tx),
        'runner_incompatible',
        'This runner does not advertise the workspace driver the assignment needs',
        409,
      );
    for (const packet of [
      frozen.assignment,
      frozen.execution.policy,
      frozen.execution.references,
      frozen.lease.receipt,
    ])
      // The review standards travel in the assignment text, and a task review carries
      // its delivery, so a packet of a real task runs past 64 KiB.
      check(
        Buffer.byteLength(JSON.stringify(packet)) <= 524_288,
        'session_packet_large',
        'Each frozen assignment, policy, reference set and receipt must fit 512 KiB',
      );
    const time = this.clock();
    const hard = Math.min(
      time + duration * 1000,
      owner.source.kind !== 'human' && owner.source.expiresAt
        ? Date.parse(owner.source.expiresAt)
        : Infinity,
    );
    const session: Session = {
      id,
      agentId: agent.id,
      agentSessionId: agent.sessionId,
      contextEpoch: agent.contextEpoch,
      projectId: caller.projectId,
      actorId: actor.id,
      source: owner.source,
      instanceId: input.instanceId,
      expectedRevision: input.expectedRevision,
      role,
      status: 'offered',
      runnerId: input.runnerId,
      hostRef: null,
      createdAt: new Date(time).toISOString(),
      activatedAt: null,
      expiresAt: new Date(Math.min(time + 300_000, hard)).toISOString(),
      hardDeadline: new Date(hard).toISOString(),
      closedAt: null,
      closeReason: null,
      outcome: null,
      ...frozen,
    };
    await tx.run(
      'INSERT INTO worker_sessions(id,project_id,actor_id,instance_id,revision,owner_hash,runner_id,request_id,token_hash,fingerprint,status,session_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      session.projectId,
      actor.id,
      session.instanceId,
      session.expectedRevision,
      owner.hash,
      input.runnerId,
      input.requestId,
      tokenDigest(input.secret),
      fingerprint,
      session.status,
      JSON.stringify(session),
    );
    await this.state.appendEvent(tx, {
      projectId: session.projectId,
      actorId: caller.actorId,
      type: 'session.offered',
      subjectId: id,
      data: {
        sessionId: id,
        workerActorId: actor.id,
        instanceId: session.instanceId,
        revision: session.expectedRevision,
        role,
        source: session.source,
        runnerId: session.runnerId,
      },
    });
    return clone(session);
  }
  async registerAgent(caller: Caller, input: AgentRegistration): Promise<Agent> {
    this.ordinary(caller);
    caller = structuredClone(caller);
    input = closed(registrationSchema, input, {
      fallback: ['invalid_agent', 'Agent requires a name, runner, request and ms_ secret'],
    });
    await this.prepareControl(caller);
    return await this.transaction(async (tx) => {
      // An agent is a new actor of the project: registering one is a write.
      await this.scope.require(caller, 'write', tx);
      return await this.directory.create(caller, input, tx);
    });
  }
  private async currentAgentExecution(agent: Agent, tx: Transaction): Promise<Session | null> {
    const row = await tx.get<Row>(
      "SELECT * FROM worker_sessions WHERE actor_id=? AND status IN ('offered','active')",
      agent.actorId,
    );
    return row ? await this.decode(row, tx) : null;
  }
  private async agentStatus(agent: Agent, tx: Transaction): Promise<AgentStatus> {
    return {
      agent,
      current: await this.currentAgentExecution(agent, tx),
      assignments: await mapAsync(
        await tx.all<Row>(
          'SELECT * FROM worker_sessions WHERE actor_id=? ORDER BY _merv_rowid',
          agent.actorId,
        ),
        (row) => this.decode(row, tx),
      ),
    };
  }
  async agents(caller: Caller): Promise<AgentStatus[]> {
    this.ordinary(caller);
    caller = structuredClone(caller);
    return await this.transaction(async (tx) =>
      mapAsync(await this.directory.list(caller, tx), (agent) => this.agentStatus(agent, tx)),
    );
  }
  async agent(caller: Caller, agentId: string): Promise<AgentStatus> {
    this.ordinary(caller);
    caller = structuredClone(caller);
    return await this.transaction(
      async (tx) =>
        await this.agentStatus(await this.directory.controlled(caller, agentId, tx), tx),
    );
  }
  async retireAgent(caller: Caller, agentId: string): Promise<Agent> {
    this.ordinary(caller);
    caller = structuredClone(caller);
    return await this.transaction(async (tx) => {
      const agent = await this.directory.controlled(caller, agentId, tx);
      const current = await this.currentAgentExecution(agent, tx);
      if (current) await this.closeSession(current, 'agent_retired', tx, 'released', 'halted');
      return await this.directory.retire(agent, 'agent_retired', tx);
    });
  }
  async agentSelf(token: string) {
    // A status poll only reads; the timer sweep records closures, and a candidate scan over
    // every instance must not hold the writer lock.
    return await this.reading(async (tx) => {
      const agent = await this.directory.authenticate(token, tx);
      const busy = await liveTargets(tx, agent.projectId);
      const available = (
        await this.workflows.dispatchCandidates(sourceCaller(agent.source), tx, agent.actorId)
      ).filter((item) => item.role !== 'operator' && !busy.has(targetKey(item)));
      return { ...(await this.agentStatus(agent, tx)), available };
    });
  }
  async assignAgent(token: string, input: AgentAssignment): Promise<Session> {
    input = closed(assignmentSchema, input, offerRefusals);
    const agent = await this.reading(async (tx) => await this.directory.authenticate(token, tx));
    // The connection credential stays fixed. Each execution has a distinct, undisclosed credential.
    const secret = `ms_${createHash('sha256')
      .update(canonical({ token, requestId: input.requestId }))
      .digest('base64url')}`;
    // An agent's request ids are its own: the replay key is per runner, so they carry the agent.
    return await this.offerParsed(sourceCaller(agent.source), {
      ...input,
      requestId: `${agent.id}:${input.requestId}`,
      agentId: agent.id,
      runnerId: agent.runnerId,
      secret,
    });
  }
  async releaseAgentAssignment(token: string, executionId: string): Promise<Session> {
    check(text(executionId), 'invalid_session', 'An execution identifier is required');
    return await this.transaction(async (tx) => {
      const agent = await this.directory.authenticate(token, tx);
      const session = await this.decode(await this.row(tx, executionId), tx);
      check(
        session.agentId === agent.id,
        'agent_forbidden',
        'Assignment belongs to another agent',
        403,
      );
      return await this.closeSession(session, 'released', tx, 'released');
    });
  }
  async resetAgentContext(token: string, reason: string): Promise<Agent> {
    return await this.transaction(async (tx) => {
      const agent = await this.directory.authenticate(token, tx);
      check(
        !(await this.currentAgentExecution(agent, tx)),
        'agent_busy',
        'Release the assignment before resetting context',
        409,
      );
      return await this.directory.reset(agent, reason, tx);
    });
  }
  async projectStatus(caller: Caller): Promise<SessionsProjectStatus> {
    this.ordinary(caller);
    this.ensureOpen();
    return await this.dispatcher.projectStatus(caller);
  }
  /** The rail's number on its own: no runner scan, no candidate enumeration, no blobs. */
  async liveSessionCount(caller: Caller): Promise<number> {
    this.ordinary(caller);
    caller = structuredClone(caller);
    this.ensureOpen();
    return await this.transaction(async (tx) => {
      check(!caller.session, 'forbidden', 'Leased workers cannot read project dispatch', 403);
      await this.scope.require(caller, 'read', tx);
      return (await tx.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM worker_sessions WHERE project_id=? AND status IN ('offered','active')",
        caller.projectId,
      ))!.n;
    });
  }
  /**
   * Every live session of the project that holds a workspace on `driver`, whoever offered it.
   * The caller's delegation source is deliberately not consulted: a session leased through an
   * actor credential or by another administrator holds the same workspace as one of the
   * administrator asking, and the answer is read on the caller's own transaction so it cannot
   * drift between a refusal and the write that refusal guards.
   */
  async holdingWorkspace(projectId: string, driver: string, tx: Transaction): Promise<string[]> {
    this.ensureOpen();
    return (
      await tx.all<{ id: string; session_json: string }>(
        "SELECT id,session_json FROM worker_sessions WHERE project_id=? AND status IN ('offered','active') ORDER BY id",
        projectId,
      )
    )
      .filter((row) => {
        const workspace = effectiveWorkspace(
          (JSON.parse(row.session_json) as Session).execution.policy,
        );
        return workspace.mode !== 'none' && workspace.driver === driver;
      })
      .map((row) => row.id);
  }
  async agentObservation(caller: Caller, agentId: string) {
    this.ordinary(caller);
    this.ensureOpen();
    check(
      text(agentId, 200),
      'invalid_agent',
      'An agent identifier of 1–200 characters is required',
    );
    return await this.observations.read(caller, agentId);
  }
  async setDispatch(caller: Caller, input: { enabled: boolean }): Promise<DispatchState> {
    this.ordinary(caller);
    this.ensureOpen();
    return await this.dispatcher.setDispatch(caller, input);
  }
  async stuck(caller: Caller): Promise<StuckReport> {
    this.ordinary(caller);
    this.ensureOpen();
    return await this.dispatcher.stuck(caller);
  }
  async releaseHold(
    caller: Caller,
    input: Parameters<Sessions['releaseHold']>[1],
  ): Promise<DispatchHold> {
    this.ordinary(caller);
    this.ensureOpen();
    return await this.dispatcher.releaseHold(caller, input);
  }
  async setBudget(caller: Caller, input: SessionBudgetInput): Promise<BudgetStatus> {
    this.ordinary(caller);
    this.ensureOpen();
    return await this.dispatcher.setBudget(caller, input);
  }
  /**
   * Unlike the dispatch reads this admits a leased worker: it discloses totals, never a
   * credential or another worker's input, and a reflection lens needs it to say what a
   * cycle cost. The scope check still bounds it to the caller's project.
   */
  async usage(caller: Caller, input: UsageQuery = {}): Promise<UsageRollup> {
    this.ordinary(caller);
    caller = structuredClone(caller);
    this.ensureOpen();
    check(
      input &&
        typeof input === 'object' &&
        Object.keys(input).every((key) => key === 'instanceId' || key === 'includeDependencies') &&
        (input.instanceId === undefined || text(input.instanceId)) &&
        (input.includeDependencies === undefined ||
          (typeof input.includeDependencies === 'boolean' && input.instanceId !== undefined)),
      'invalid_usage_query',
      'Usage accepts an optional instanceId and, with it, includeDependencies',
    );
    const { instanceId, includeDependencies = true } = input;
    return await this.reading(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const instanceIds =
        instanceId === undefined
          ? null
          : includeDependencies
            ? await this.workflows.dependencyClosure(caller, instanceId, tx)
            : [(await this.workflows.get(caller, instanceId, tx)).id];
      const { since, ...totals } = await usageTotals(tx, caller.projectId, instanceIds, instanceId);
      return {
        scope:
          instanceId === undefined || instanceIds === null
            ? { kind: 'project', projectId: caller.projectId }
            : {
                kind: 'instance',
                instanceId,
                includeDependencies,
                instanceCount: instanceIds.length,
              },
        ...totals,
        liveSessions: (await tx.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM worker_sessions WHERE project_id=? AND status IN ('offered','active')",
          caller.projectId,
        ))!.n,
        budgets: await this.dispatcher.budgetsFor(caller, tx, instanceId),
        accounting: {
          wallClock: 'measured',
          tokens: 'runner_reported',
          since,
          method: accountingMethod,
        },
      };
    });
  }
  async halt(
    caller: Caller,
    input: { sessionId?: string; reason?: string } = {},
  ): Promise<{ halted: number }> {
    this.ordinary(caller);
    this.ensureOpen();
    return await this.dispatcher.halt(caller, input);
  }
  async heartbeatRunner(caller: Caller, input: RunnerHeartbeat): Promise<RunnerPresence> {
    this.ensureOpen();
    return await this.dispatcher.heartbeatRunner(caller, input);
  }
  async setRunnerSettings(
    caller: Caller,
    input: { runnerId: string; settings: RunnerSettings },
  ): Promise<RunnerPresence> {
    this.ordinary(caller);
    this.ensureOpen();
    return await this.dispatcher.setRunnerSettings(caller, input);
  }
  async lease(
    caller: Caller,
    input: AutomaticLease,
  ): Promise<{ session: Session | null; reason: string }> {
    this.ensureOpen();
    return await this.dispatcher.lease(caller, input);
  }
  async dispatchDemand(caller: Caller, input: DispatchDemandInput): Promise<DispatchDemand> {
    this.ordinary(caller);
    this.ensureOpen();
    return await this.dispatcher.dispatchDemand(caller, input);
  }

  async workspaceObservation(
    caller: Caller,
    sessionId: string,
    transaction?: Transaction,
  ): Promise<SessionWorkspaceObservation> {
    this.ordinary(caller);
    caller = structuredClone(caller);
    this.ensureOpen();
    check(text(sessionId), 'invalid_session', 'A session identifier is required');
    if (transaction) this.state.assertTransaction(transaction);
    const read = async (sql: Transaction): Promise<SessionWorkspaceObservation> => {
      await this.scope.require(caller, 'read', sql);
      const row = await sql.get<Row>(
        'SELECT * FROM worker_sessions WHERE id=? AND project_id=?',
        sessionId,
        caller.projectId,
      );
      check(row, 'session_not_found', 'Session not found in this project', 404);
      const session = await this.decode(row, sql);
      const event = session.workspace?.result
        ? await sql.get<{ id: number; created_at: string }>(
            "SELECT id,created_at FROM events WHERE project_id=? AND subject_id=? AND type='session.workspace_result' ORDER BY id LIMIT 1",
            caller.projectId,
            sessionId,
          )
        : undefined;
      // Provenance names who delegated the work, not the credential they held.
      const { kind, actorId, projectId } = session.source;
      return {
        provenance: {
          projectId: session.projectId,
          sessionId: session.id,
          actorId: session.actorId,
          source: { kind, actorId, projectId },
          instanceId: session.instanceId,
          revision: session.expectedRevision,
          workflow: {
            name: session.execution.workflow,
            version: session.execution.version,
            state: session.execution.state,
            policyHash: session.execution.policyHash,
            registrationId: session.execution.registrationId,
          },
          runnerId: session.runnerId,
          hostRef: session.hostRef,
          readOnly: session.execution.policy.readOnly,
        },
        workspaceMode: effectiveWorkspace(session.execution.policy).mode,
        live: live(session),
        workspace: session.workspace ?? null,
        observedAt: event?.created_at ?? null,
        eventId: event?.id ?? null,
      };
    };
    return transaction ? await read(transaction) : await this.transaction(read);
  }
  async list(caller: Caller): Promise<Session[]> {
    this.ordinary(caller);
    caller = structuredClone(caller);
    return await this.transaction(async (tx) => {
      const owner = await ownerOf(this.scope, caller, tx);
      return await mapAsync(
        await tx.all<Row>(
          'SELECT * FROM worker_sessions WHERE owner_hash=? ORDER BY _merv_rowid',
          owner.hash,
        ),
        (row) => this.decode(row, tx),
      );
    });
  }
  async get(caller: Caller, sessionId: string): Promise<Session> {
    caller = structuredClone(caller);
    if (caller.managed)
      return await this.reading(
        async (tx) => await this.controlled(caller, sessionId, undefined, tx),
      );
    const result = await this.transaction(async (tx) => {
      const session = await this.controlled(caller, sessionId, undefined, tx);
      const error = await this.reconcile(session, tx);
      // A poll reports durable closure to its controller, but provider outages are retryable.
      return error && error.status >= 500 ? { error } : { session };
    });
    if (result.error) throw result.error;
    return result.session!;
  }
  async attach(
    caller: Caller,
    input: SessionControl & { hostRef: string; workspace?: SessionWorkspace },
  ): Promise<Session> {
    caller = structuredClone(caller);
    input = closed(hostSchema, input, controlRefusals);
    const workspace = input.workspace;
    return await this.controlMutation(caller, input, async (session, tx) => {
      check(
        session.hostRef === null || session.hostRef === input.hostRef,
        'host_conflict',
        'Session is attached to another host',
        409,
      );
      const policy = effectiveWorkspace(session.execution.policy);
      check(
        policy.mode === 'none' ? workspace === undefined : workspace?.mode === policy.mode,
        'workspace_policy_mismatch',
        'Attachment must match the frozen workspace mode',
        409,
      );
      // A hand offer names its runner itself, so the driver it needs is asked for here too.
      if (policy.mode !== 'none' && policy.driver !== undefined)
        check(
          await this.dispatcher.capable(
            caller.managed ? (await this.managed.require(caller, tx)).sourceCaller : caller,
            session.runnerId,
            policy.driver,
            tx,
          ),
          'runner_incompatible',
          'This runner does not advertise the workspace driver the assignment needs',
          409,
        );
      if (workspace && policy.mode !== 'none') {
        if (policy.base.startsWith('reference:')) {
          const name = policy.base.slice('reference:'.length);
          const oid = Object.hasOwn(session.execution.references, name)
            ? session.execution.references[name]
            : undefined;
          check(
            typeof oid === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid),
            'workspace_reference_unavailable',
            'Frozen workspace reference must name an exact Git commit',
            409,
          );
          check(
            workspace.baseOid === oid,
            'workspace_base_conflict',
            'Workspace base differs from the frozen commit reference',
            409,
          );
        }
        if (session.workspace) {
          check(
            canonical(session.workspace.attachment) === canonical(workspace),
            'workspace_attachment_conflict',
            'Workspace attachment is already fixed',
            409,
          );
        } else {
          await tx.run(
            'INSERT INTO session_workspaces(session_id,attachment_json) VALUES(?,?)',
            session.id,
            canonical(workspace),
          );
          session.workspace = { attachment: workspace, result: null };
          await this.state.appendEvent(tx, {
            projectId: session.projectId,
            actorId: caller.actorId,
            type: 'session.workspace_attached',
            subjectId: session.id,
            data: workspaceEvent(session, workspace),
          });
        }
      }
      if (session.hostRef === null) {
        session.hostRef = input.hostRef;
        await this.save(tx, session);
      }
    });
  }
  async workspaceResult(
    caller: Caller,
    input: SessionControl & { hostRef: string; workspace: SessionWorkspace },
  ): Promise<Session> {
    caller = structuredClone(caller);
    input = closed(resultSchema, input, controlRefusals);
    const workspace = input.workspace;
    return await this.transaction(async (tx) => {
      // Capturing a finished process is independent of current workflow admission.
      // In particular this operation never reactivates a remotely closed session.
      const session = await this.controlled(caller, input.sessionId, input.runnerId, tx);
      check(
        session.hostRef !== null && session.hostRef === input.hostRef,
        'host_conflict',
        'Workspace result must name the attached host',
        409,
      );
      check(
        session.workspace,
        'workspace_not_attached',
        'Workspace must be attached before its final capture',
        409,
      );
      const identity = ({
        headOid: _headOid,
        treeOid: _treeOid,
        stats: _stats,
        ...identity
      }: SessionWorkspace) => identity;
      check(
        canonical(identity(workspace)) === canonical(identity(session.workspace.attachment)),
        'workspace_identity_conflict',
        'Final capture must retain the attached workspace identity',
        409,
      );
      check(
        !session.execution.policy.readOnly ||
          workspace.headOid === session.workspace.attachment.headOid,
        'workspace_readonly_conflict',
        'Read-only workspace capture cannot change the attached head',
        409,
      );
      if (session.workspace.result) {
        check(
          canonical(session.workspace.result) === canonical(workspace),
          'workspace_result_conflict',
          'Final workspace capture is already fixed',
          409,
        );
        return session;
      }
      // A final capture is of a process that ran; an offer nobody activated has none.
      check(
        session.status !== 'offered',
        'session_not_started',
        'Workspace results follow an activated session',
        409,
      );
      await tx.run(
        'UPDATE session_workspaces SET result_json=? WHERE session_id=? AND result_json IS NULL',
        canonical(workspace),
        session.id,
      );
      session.workspace.result = workspace;
      await this.state.appendEvent(tx, {
        projectId: session.projectId,
        actorId: caller.actorId,
        type: 'session.workspace_result',
        subjectId: session.id,
        data: workspaceEvent(session, workspace),
      });
      return session;
    });
  }
  async heartbeat(caller: Caller, input: SessionControl): Promise<Session> {
    caller = structuredClone(caller);
    input = closed(controlSchema, input, controlRefusals);
    return await this.controlMutation(caller, input, async (session, tx) => {
      check(
        session.status === 'active',
        'session_not_active',
        'Only an activated session may heartbeat',
        409,
      );
      session.expiresAt = new Date(
        Math.min(this.clock() + 14_400_000, Date.parse(session.hardDeadline)),
      ).toISOString();
      await this.save(tx, session);
    });
  }
  private async controlMutation(
    caller: Caller,
    input: SessionControl,
    mutate: (session: Session, tx: Transaction) => void | Promise<void>,
  ): Promise<Session> {
    const result = await this.transaction(async (tx) => {
      const session = await this.controlled(caller, input.sessionId, input.runnerId, tx),
        error = await this.reconcile(session, tx);
      if (error) return { error };
      await mutate(session, tx);
      return { session };
    });
    if (result.error) throw result.error;
    return result.session!;
  }
  async release(
    caller: Caller,
    input: SessionControl & {
      reason?: string;
      outcome?: SessionReleaseOutcome;
      deferral?: SessionDeferral;
      usage?: SessionUsageReport;
    },
  ): Promise<Session> {
    caller = structuredClone(caller);
    const { usage, ...control } = closed(releaseSchema, input, releaseRefusals);
    return await this.transaction(async (tx) => {
      const session = await this.controlled(caller, control.sessionId, control.runnerId, tx);
      const released = await this.closeReleased(session, control, tx);
      if (usage) await this.reportUsage(released, usage, tx);
      if (caller.managed)
        await this.managed.acknowledgeRelease(caller, released.id, control.runnerId, tx);
      return released;
    });
  }
  private async closeReleased(
    session: Session,
    input: { reason?: string; outcome?: SessionOutcome; deferral?: SessionDeferral },
    tx: Transaction,
  ): Promise<Session> {
    // A session whose handoff already landed is recorded as that, whoever releases it; a
    // completed outcome is what the handoff proves, never what a release claims.
    if (live(session) && (await this.handedOff(session, tx)))
      return await this.closeSession(session, 'handoff', tx, 'released', 'completed');
    check(
      input.outcome !== 'completed',
      'invalid_outcome',
      'A completed outcome is recorded by the worker’s own handoff, not by a release',
    );
    if (input.deferral) session.deferral = structuredClone(input.deferral);
    return await this.closeSession(
      session,
      input.reason ?? 'released',
      tx,
      'released',
      input.outcome,
    );
  }
  /**
   * Most real usage arrives here for a session its own handoff already closed, which is why
   * the report rides on release rather than on a live-session call. It is the launching
   * machine's word, stored as that and attributed to the system, never to a reviewer of it.
   */
  private async reportUsage(
    session: Session,
    usage: SessionUsageReport,
    tx: Transaction,
  ): Promise<void> {
    const stored = await reportUsage(tx, session.id, usage, isoNow(this.clock));
    if (!stored) return;
    await this.state.appendEvent(tx, {
      projectId: session.projectId,
      actorId: 'system:sessions',
      type: 'session.usage_reported',
      subjectId: session.id,
      data: {
        sessionId: session.id,
        instanceId: session.instanceId,
        revision: session.expectedRevision,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicros: stored.costMicros,
        model: usage.model ?? null,
      },
    });
  }
  async authenticate(token: string): Promise<Caller> {
    check(
      typeof token === 'string' && sessionSecretPattern.test(token),
      'unauthorized',
      'Invalid session bearer credential',
      401,
    );
    const result = await this.transaction(async (tx) => {
      const agent = (await this.directory.findToken(token, tx))
        ? await this.directory.authenticate(token, tx)
        : undefined;
      const current = agent ? await this.currentAgentExecution(agent, tx) : undefined;
      if (agent) check(current, 'agent_idle', 'Agent has no current assignment', 409);
      const row = current
        ? await this.row(tx, current.id)
        : await tx.get<Row>('SELECT * FROM worker_sessions WHERE token_hash=?', tokenDigest(token));
      check(row, 'unauthorized', 'Invalid session bearer credential', 401);
      const session = await this.decode(row, tx),
        error = await this.reconcile(session, tx);
      if (error) return { error };
      if (session.status === 'offered') {
        await this.framed(
          {
            tx,
            actorId: session.actorId,
            sessionId: session.id,
            source: session.source,
            role: session.role,
          },
          () => this.workflows.activateLease(this.worker(session), session.lease, tx),
        );
        this.ensureOpen();
        check(
          session.expiresAt > isoNow(this.clock) && session.hardDeadline > isoNow(this.clock),
          'session_expired',
          'Session expired during activation',
          401,
        );
        session.status = 'active';
        session.activatedAt = isoNow(this.clock);
        session.expiresAt = new Date(
          Math.min(this.clock() + 14_400_000, Date.parse(session.hardDeadline)),
        ).toISOString();
        await this.save(tx, session);
        await this.state.appendEvent(tx, {
          projectId: session.projectId,
          actorId: session.actorId,
          type: 'session.activated',
          subjectId: session.id,
          data: {
            sessionId: session.id,
            instanceId: session.instanceId,
            revision: session.expectedRevision,
          },
        });
      }
      return { caller: this.worker(session) };
    });
    if (result.error) throw result.error;
    return result.caller!;
  }
  registerManagedValidator(validator: ManagedRunnerValidator): () => void {
    this.ensureOpen();
    return this.managed.registerValidator(validator);
  }
  async ensureManagedEnrollment(
    input: ManagedEnrollmentInput,
  ): Promise<{ enrollmentToken: string }> {
    this.ensureOpen();
    return await this.managed.ensure(input);
  }
  async enrollManaged(
    token: string,
    input: unknown,
  ): Promise<{ controlToken: string; caller: Caller }> {
    this.ensureOpen();
    return await this.managed.enroll(token, input);
  }
  async authenticateManaged(token: string): Promise<Caller> {
    this.ensureOpen();
    return await this.managed.authenticate(token);
  }
  async inspectManaged(
    allocationId: string,
    epoch: number,
  ): Promise<ManagedRunnerInspection | null> {
    this.ensureOpen();
    return await this.managed.inspect(allocationId, epoch);
  }
  async describe(caller: Caller): Promise<Session> {
    this.ordinary(caller);
    caller = structuredClone(caller);
    return await this.transaction(async (tx) => {
      check(caller.session, 'session_required', 'Session authority is required', 401);
      await this.scope.require(caller, 'read', tx);
      return await this.decode(await this.row(tx, caller.session.id), tx);
    });
  }
  /** Tool names per session, read once: a policy is frozen at offer, and the tool listing
   *  asks about every registered tool, which under load meant one locked transaction each. */
  private readonly toolNames = new Map<string, { names: Set<string>; at: number }>();
  async allowsTool(caller: Caller, name: string, read?: boolean): Promise<boolean> {
    this.ordinary(caller);
    caller = structuredClone(caller);
    if (read) return true;
    const id = caller.session?.id;
    const cached = id ? this.toolNames.get(id) : undefined;
    if (cached && this.clock() - cached.at < 60_000) return cached.names.has(name);
    const names = await this.reading(async (tx) => {
      const session = await this.session(caller, tx);
      return new Set(session.execution.policy.tools.map((tool) => tool.name));
    });
    if (id) {
      if (this.toolNames.size >= 1000) this.toolNames.clear();
      this.toolNames.set(id, { names, at: this.clock() });
    }
    return names.has(name);
  }
  private async session(caller: Caller, tx: Transaction): Promise<Session> {
    await this.scope.require(caller, 'read', tx);
    check(caller.session, 'session_required', 'Session authority is required', 401);
    return await this.decode(await this.row(tx, caller.session.id), tx);
  }
  private async admit(
    caller: Caller,
    tool: string,
    input: Data,
    tx: Transaction,
    registrationId?: string,
    read?: boolean,
  ) {
    const session = await this.session(caller, tx);
    const current = await this.valid(session, tx);
    if (registrationId !== undefined)
      check(
        current.registrationId === registrationId,
        'execution_replaced',
        'Workflow implementation changed during invocation',
        409,
      );
    const admission = await this.workflows.authorizeLeaseDispatch(
      caller,
      session.lease,
      { ...session.execution, registrationId: registrationId ?? current.registrationId },
      { tool, input, ...(read ? { read } : {}) },
      tx,
    );
    return { admission, registrationId: current.registrationId, session };
  }
  async prepare(
    caller: Caller,
    tool: string,
    input: Data,
    read?: boolean,
  ): Promise<SessionInvocation> {
    this.ordinary(caller);
    caller = structuredClone(caller);
    input = snapshotInput(input);
    const prepared = await this.reading(
      async (tx) => await this.admit(caller, tool, input, tx, undefined, read),
    );
    this.ensureOpen();
    const invocationId = newId('invocation');
    const invocation: SessionInvocation = Object.freeze({
      caller: Object.freeze({
        actorId: caller.actorId,
        projectId: caller.projectId,
        session: Object.freeze({
          id: prepared.session.id,
          ...(prepared.session.agentSessionId
            ? { agentSessionId: prepared.session.agentSessionId }
            : {}),
          invocationId,
        }),
      }),
      tool,
      input: clone(prepared.admission.input),
    });
    const state: InvocationState = {
      public: invocation,
      sessionId: prepared.session.id,
      registrationId: prepared.registrationId,
      running: false,
      used: false,
      input: clone(prepared.admission.input),
      validated: false,
      read: !!read,
    };
    this.invocations.set(invocation, state);
    this.invocationIds.set(invocationId, state);
    return invocation;
  }
  async validate(caller: Caller, tool: string, input: Data): Promise<void> {
    this.ordinary(caller);
    caller = structuredClone(caller);
    input = snapshotInput(input);
    await this.reading(async (tx) => {
      const state = caller.session?.invocationId
        ? this.invocationIds.get(caller.session.invocationId)
        : undefined;
      check(
        state && !state.used && state.public.tool === tool,
        'session_invocation',
        'Session invocation is unavailable',
        403,
      );
      if (state.validated)
        check(
          canonical(state.input) === canonical(input),
          'session_invocation',
          'Session invocation arguments changed',
          403,
        );
      const admitted = await this.admit(caller, tool, input, tx, state.registrationId, state.read);
      this.ensureOpen();
      check(!state.used, 'session_invocation', 'Session invocation is unavailable', 403);
      check(
        canonical(admitted.admission.input) === canonical(input),
        'session_invocation',
        'Session arguments no longer match their bindings',
        403,
      );
      // The first validation follows schema parsing. Unbound defaults/stripping are permitted;
      // fixed bindings are independently re-authorized before retaining the parsed snapshot.
      if (!state.validated) {
        state.input = clone(input);
        state.validated = true;
      }
    });
  }
  async run<T>(
    invocation: SessionInvocation,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ): Promise<T> {
    const state = this.invocations.get(invocation);
    check(
      state && !state.used && !state.running,
      'session_invocation',
      'Session invocation is unavailable',
      403,
    );
    // Claim once before yielding so concurrent callers cannot execute one preparation twice.
    state.running = true;
    try {
      // Authorize before recording an observation, so an unauthorized call records none. A
      // caller that just validated (the tool registry does, right before run) is not admitted
      // twice; the check after observation storage still runs.
      if (!state.validated) await this.validate(invocation.caller, invocation.tool, state.input);
      await this.observations.start(
        invocation.caller.session!.invocationId!,
        state.sessionId,
        invocation.tool,
        state.input,
      );
      // Observation storage yields too; recheck authorization before invoking the tool.
      await this.validate(invocation.caller, invocation.tool, state.input);
      // A session has one assignment, the frozen one it was offered; another record's
      // assignment is an admission of somebody else, so the question is refused by name.
      const own =
        invocation.tool === 'workflow.assignment'
          ? await this.transaction(async (tx) => await this.session(invocation.caller, tx))
          : undefined;
      const asked = (state.input as { instanceId?: string }).instanceId;
      check(
        !own || asked === undefined || asked === own.instanceId,
        'execution_arguments_forbidden',
        `This session's assignment is ${own?.instanceId}; read another record with workflow.status_and_next`,
        403,
      );
      const result = own
        ? (clone(own.assignment) as T)
        : await handler(invocation.caller, clone(state.input));
      // MCP may return a tool error without throwing. Native values have no such envelope.
      const failed =
        invocation.tool.startsWith('_') &&
        result &&
        typeof result === 'object' &&
        'isError' in result &&
        result.isError === true;
      if (!this.closed)
        await this.observations.finish(
          invocation.caller.session!.invocationId!,
          failed ? 'failed' : 'succeeded',
          result,
        );
      return result;
    } finally {
      await this.cancel(invocation);
    }
  }
  async cancel(invocation: SessionInvocation): Promise<void> {
    const state = this.invocations.get(invocation);
    if (!state || state.used) return;
    const running = state.running;
    state.used = true;
    state.running = false;
    this.invocationIds.delete(invocation.caller.session!.invocationId!);
    if (running && !this.closed)
      await this.observations.finish(invocation.caller.session!.invocationId!, 'failed');
  }
  /**
   * A runner renews a lease for as long as its process lives, so a lease alone never says
   * the work moves — and neither does silence: a worker with no Merv call may be training
   * locally, waiting on a sandbox job or using another service, which the server cannot
   * tell from one that is stuck. So quiet is only observed and said, never acted on; ending
   * a session stays an explicit halt or the lease's hard deadline. The mark and its clearing
   * live only here, on the session the writing sweep just decoded. A poll may run on a read snapshot,
   * where reconcile already has to swallow read_only_scope to report a closure it cannot
   * record; an idle mark has no such need, so no read path computes one.
   */
  private async progress(
    session: Session,
    lastCallAt: string | undefined,
    tx: Transaction,
  ): Promise<void> {
    const lastActivityAt = lastActivity(session, lastCallAt)!;
    const idleSeconds = Math.floor((this.clock() - Date.parse(lastActivityAt)) / 1000);
    const { idleNoticeSeconds } = this.thresholds;
    if (idleSeconds < idleNoticeSeconds) {
      if (!session.quietSince) return;
      session.quietSince = null;
      await this.save(tx, session);
      return;
    }
    // Once per episode: the mark is what keeps a later sweep from saying it again.
    if (session.quietSince) return;
    session.quietSince = isoNow(this.clock);
    await this.save(tx, session);
    await this.state.appendEvent(tx, {
      projectId: session.projectId,
      actorId: 'system:sessions',
      type: 'session.quiet',
      subjectId: session.id,
      data: {
        sessionId: session.id,
        instanceId: session.instanceId,
        revision: session.expectedRevision,
        lastActivityAt,
        idleSeconds,
      },
    });
  }
  /**
   * Idleness moves on a scale of minutes, so the sweep looks at it at most once a minute of
   * clock time, only at sessions active long enough to be idle, and reads every session's
   * latest call in one statement the first time one of them needs it.
   */
  private idlePass(tx: Transaction) {
    const now = this.clock();
    const due = now - this.idleCheckedAt >= 60_000;
    if (due) this.idleCheckedAt = now;
    let calls: Promise<Map<string, string>> | undefined;
    return {
      due: (session: Session) =>
        due &&
        session.status === 'active' &&
        session.activatedAt !== null &&
        Date.parse(session.activatedAt) + this.thresholds.idleNoticeSeconds * 1000 <= now,
      activity: () => (calls ??= this.observations.activity(tx)),
    };
  }
  private async sweepTransaction(tx: Transaction): Promise<void> {
    await this.serviceWork.expire(tx);
    const idle = this.idlePass(tx);
    const stranded = await this.managed.stranded(tx);
    for (const row of await tx.all<Row>(
      "SELECT * FROM worker_sessions WHERE status IN ('offered','active') ORDER BY _merv_rowid",
    )) {
      const session = await this.decode(row, tx);
      if (await this.reconcile(session, tx)) continue;
      if (stranded.has(session.id))
        await this.closeSession(session, 'managed_revoked', tx, 'expired', 'host_failed');
      else if (idle.due(session))
        await this.progress(session, (await idle.activity()).get(session.id), tx);
    }
    for (const row of await tx.all<{ id: string }>("SELECT id FROM agents WHERE status='active'")) {
      const agent = await this.directory.get(row.id, tx);
      try {
        await this.directory.require(agent, tx);
      } catch (error) {
        const failure = safeError(error);
        if (failure.status < 500) await this.directory.retire(agent, failure.code, tx);
      }
    }
  }
  async sweep(): Promise<void> {
    this.ensureOpen();
    if (!this.sweeping)
      this.sweeping = this.transaction((tx) => this.sweepTransaction(tx)).finally(() => {
        this.sweeping = undefined;
      });
    await this.sweeping;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.closing = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      // Preserve dependency order and finish cleanup even if an earlier disposer fails.
      for (const dispose of [
        ...this.disposers.reverse(),
        async () => {
          await this.sweeping?.catch(() => undefined);
        },
        () => this.observations.interrupt(),
      ]) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      this.invocationIds.clear();
      if (errors.length) throw errors[0];
    });
    return this.closing;
  }
}
export const sessionsPlugin = {
  name: 'merv-sessions',
  inject: ['state', 'scope', 'workflows', 'domainEvents'],
  async apply(ctx: Context, config: SessionsConfig = {}) {
    await ctx.effect(async function* () {
      const sessions = await createService(
        new LeasedSessions(ctx.state, ctx.scope, ctx.workflows, ctx.domainEvents, config),
      );
      yield async () => await sessions.close();
      // Without this registration the tool registry refuses every session call.
      ctx.inject(['tools'], (ctx) => {
        ctx.effect(() => ctx.tools.registerSessionPolicy(sessions));
      });
      yield ctx.provide('sessions', sessions);
    });
  },
};
export default sessionsPlugin;
