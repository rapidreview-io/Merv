import { freezeLaunchSnapshot } from './launch-connections.js';
import { nativeMcpConnectionsSchema } from '@merv/contracts';
import { visible, createService } from '@merv/contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { postgresMigrations } from './index.postgres.js';
import { managedNoncePostgresMigration } from './managed-nonce.postgres.js';
import { createHash } from 'node:crypto';
import type { Context } from 'cordis';
import { CredentialStore } from '@merv/identity/credentials';
import type {} from '@merv/api/types';
import type { Secrets, HuggingFaceGrant, AccountIdentity } from '@merv/secrets/types';
import type { ManagedBindingRow } from './managed-types.js';
import {
  canonical,
  check,
  delegationEnd,
  digest,
  effectiveWorkspace,
  MAX_TRANSCRIPT_BYTES,
  MervError,
  newId,
  parsed,
  sessionSecretPattern,
  sessionUsageReportSchema,
  sessionWorkspaceSchema,
  type Caller,
  type DelegationSource,
  type DomainEvents,
  type Permission,
  type Scope,
  type State,
  type Transaction,
  type WorkflowExecutionReferences,
  type Workflows,
} from '@merv/contracts';
import { SessionDispatch, failureReasons } from './dispatch.js';
import { SessionRunning } from './running.js';
import { AgentDirectory, sourceCaller, tokenDigest } from './agents.js';
import { AgentObservations } from './observations.js';
import {
  clone,
  isoNow,
  live,
  liveTargets,
  ordinary,
  ownerOf,
  readFirst,
  refused,
  safeError,
  targetKey,
  text,
  type Row,
} from './common.js';
import { SessionServiceWork } from './service-work.js';
import { ManagedRunnerBindings, managedRunnerRules } from './managed.js';
import { SessionTranscripts } from './transcripts.js';
import { SessionStreams } from './stream.js';
import { SessionConversations } from './conversations.js';
import { SessionMessages } from './messages.js';
import { SessionInvocations } from './invocations.js';
import { accountingMethod, recordUsage, reportUsage, usageTotals } from './usage.js';
import type { Agent, AgentStatus, AgentRegistration, AgentAssignment } from './types.js';
import type {
  Session,
  SessionContinuity,
  SessionConversationDeclaration,
  LaunchConnectionsProvider,
  NativeMcpConnection,
  SessionControl,
  SessionTranscript,
  SessionTranscriptDeclaration,
  SessionOffer,
  Sessions,
  StuckReport,
  SessionDeferral,
  SessionOutcome,
  SessionReleaseOutcome,
  SessionWorkspace,
  SessionWorkspaceObservation,
  SessionLookup,
  SessionUsageReport,
  StatusSection,
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
    /** Whether a project nobody has switched is on: the founder's ruling (2026-09-25) is that
     * every project runs its work unless someone turns it off. */
    dispatchByDefault: z.boolean().default(false),
    /** Separate operator secret for deterministic managed credentials. */
    managedSecretEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
  })
  .strict();
export type SessionsConfig = z.input<typeof configSchema>;
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
const transcriptSchema = controlSchema.extend({
  hostRef: trimmed(512),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().min(1).max(MAX_TRANSCRIPT_BYTES),
  logBytes: z.number().int().nonnegative().safe(),
  truncated: z.boolean(),
  deliver: z.literal(true).optional(),
});
const transcriptRefusals = {
  ...controlRefusals,
  fallback: [
    'invalid_transcript',
    'A transcript names its host, SHA-256, size, log size and truncation',
  ],
} as const;
const conversationSchema = controlSchema.extend({
  hostRef: trimmed(512),
  harness: z.enum(['claude', 'codex']),
  conversationId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().min(1).max(MAX_TRANSCRIPT_BYTES),
  deliver: z.literal(true).optional(),
});
const conversationRefusals = {
  ...controlRefusals,
  fallback: [
    'invalid_conversation',
    'A conversation names its host, harness, conversation id, SHA-256 and size',
  ],
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
    usage: ['invalid_usage', 'Usage reports non-negative token counts and an optional model'],
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
/** A session row with its workspace capture, read in one statement. */
const SESSION =
  'SELECT s.*,w.attachment_json,w.result_json FROM worker_sessions s LEFT JOIN session_workspaces w ON w.session_id=s.id';
/** The same row without its workspace capture, for a check that never reads it. */
const BARE =
  'SELECT id,project_id,owner_hash,session_json,NULL AS attachment_json,NULL AS result_json FROM worker_sessions';
interface Frame {
  tx: Transaction;
  actorId: string;
  sessionId: string;
  source: DelegationSource;
  role: Session['role'];
}
/** Durable step credentials. Domain reservations and all lifecycle mutations share State transactions. */
export class LeasedSessions implements Sessions {
  private readonly frames = new AsyncLocalStorage<Frame[]>();
  private readonly fenced = new WeakMap<Transaction, Set<string>>();
  private readonly disposers: (() => void | Promise<void>)[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<unknown>;
  private closing?: Promise<void>;
  private closed = false;
  dispatch!: SessionDispatch;
  running!: SessionRunning;
  serviceWork!: SessionServiceWork;
  /** Public so the plugin can bind Blobs to it late. */
  transcripts!: SessionTranscripts;
  /** Each worker agent's live stream, read by the events route. */
  streams!: SessionStreams;
  conversations!: SessionConversations;
  /** Operator messages to live sessions. */
  messaging!: SessionMessages;
  /** The tool policy: each leased worker's MCP calls. */
  invocations!: SessionInvocations;
  /** Optional private account credential reader; never exposed through the tool registry. */
  secrets?: Pick<Secrets, 'resolveHuggingFaceToken'> &
    Partial<Pick<Secrets, 'createHuggingFaceAccess'>>;
  private readonly sections = new Map<string, StatusSection>();
  private launchConnectionsProvider?: LaunchConnectionsProvider;
  private directory!: AgentDirectory;
  observations!: AgentObservations;
  managed!: ManagedRunnerBindings;
  private credentials!: CredentialStore;
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
      await state.migrate(
        'sessions',
        Object.entries({ ...postgresMigrations, 8: managedNoncePostgresMigration }).map(
          ([version, sql]) => ({ version: +version, sql }),
        ),
      );
      // What each part Sessions hands a call to checks first: that Sessions is still open.
      const available = () => this.ensureOpen();
      this.credentials = new CredentialStore(state, this.clock);
      await this.credentials.initialize();
      this.managed = new ManagedRunnerBindings(
        state,
        scope,
        this.clock,
        config.managedSecretEnv,
        this.credentials,
        available,
      );
      this.directory = await createService(
        new AgentDirectory(state, scope, this.clock, this.credentials),
      );
      this.observations = await createService(
        new AgentObservations(state, scope, this.clock, available),
      );
      this.dispatch = await createService(
        new SessionDispatch(
          state,
          scope,
          workflows,
          this.observations,
          {
            managed: this.managed,
            available,
            byDefault: config.dispatchByDefault,
            prepare: async (caller) => await this.prepareControl(caller),
            offer: async (caller, input, tx) =>
              await this.offerTransaction(caller, input, tx, true),
            close: async (session, reason, tx) => {
              // A session whose record already moved is closed by what moved it, not by the halt;
              // a re-check that could not run (the program away) halts it all the same.
              const closed = await this.reconcile(session, tx);
              if (closed && closed.status < 500) return false;
              await this.closeSession(session, reason, tx, 'released', 'halted');
              return true;
            },
          },
          this.clock,
          this.thresholds,
        ),
      );
      // After the session and dispatch tables, which a transcript row names and reads.
      this.transcripts = await createService(
        new SessionTranscripts(state, this.clock, (caller, id, runnerId, tx) =>
          this.controlled(caller, id, runnerId, tx),
        ),
      );
      this.streams = await createService(
        new SessionStreams(
          state,
          scope,
          this.clock,
          (caller, id, runnerId, tx) => this.controlled(caller, id, runnerId, tx, BARE),
          available,
        ),
      );
      this.conversations = await createService(
        new SessionConversations(
          state,
          this.clock,
          (caller, id, runnerId, tx) => this.controlled(caller, id, runnerId, tx),
          async (agentId, reason, tx) => {
            const agent = await this.directory.get(agentId, tx);
            if (!agent.persistent && !(await this.currentAgentExecution(agent, tx)))
              await this.directory.retire(agent, reason, tx);
          },
          available,
        ),
      );
      this.messaging = new SessionMessages(state, scope, this.clock, {
        transaction: (fn) => this.transaction(fn),
        reading: (fn) => this.reading(fn),
        row: (tx, id) => this.row(tx, id),
        decode: (row) => this.decode(row),
        valid: (session, tx) => this.valid(session, tx),
      });
      this.invocations = new SessionInvocations(this.observations, this.clock, {
        open: () => this.ensureOpen(),
        closed: () => this.closed,
        reading: (fn) => this.reading(fn),
        session: (caller, tx) => this.session(caller, tx),
        valid: (session, tx, frozen) => this.valid(session, tx, frozen),
        acknowledged: (id, tx) => this.messaging.requireMessagesAcknowledged(id, tx),
      });
      this.running = new SessionRunning(
        state,
        scope,
        this.dispatch,
        this.clock,
        this.thresholds,
        available,
      );
      this.serviceWork = new SessionServiceWork(
        state,
        scope,
        workflows,
        this.clock,
        config.serviceConcurrency,
        async (projectId, tx) => (await this.dispatch.dispatch(projectId, tx)).enabled,
      );
      await this.serviceWork.initialize();
      try {
        this.disposers.push(
          scope.registerSessionAuthority({
            require: async (caller, tx, permission) => await this.guard(caller, tx, permission),
          }),
        );
        this.disposers.push(
          scope.registerManagedRunnerAuthority({
            require: async (caller, tx) =>
              JSON.parse((await this.managed.require(caller, tx)).row.source_json),
          }),
        );
        // Older than any client waits for a call: another live process's may be younger.
        await this.observations.interrupt(isoNow(() => this.clock() - 180_000));
        this.timer = setInterval(() => {
          this.sweeping ??= this.alone('sweep', () =>
            this.pass(this.clock() - this.checkedAt >= 30_000),
          ).finally(() => (this.sweeping = undefined));
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
  private checkedAt = Number.NEGATIVE_INFINITY;
  /** Each failing sweep subject with the code last logged, cleared by every full pass. */
  private readonly failing = new Map<string, string>();
  private ensureOpen(): void {
    check(!this.closed, 'session_unavailable', 'Sessions is unavailable', 503);
  }
  private async transaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T> {
    this.ensureOpen();
    // Join the caller's transaction, or open one without first holding a read connection
    // while this waits for the writer lock.
    const tx = this.state.ambient;
    return tx ? await fn(tx) : await this.state.transaction(fn);
  }
  /**
   * The same handle on a read-only snapshot: admission checks only read, and a worker
   * makes several of them per tool call, so none of them may queue on the writer lock.
   */
  private async reading<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T> {
    this.ensureOpen();
    return await this.state.snapshot(() => this.transaction(fn));
  }
  private async readFirst<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    this.ensureOpen();
    return await readFirst(this.state, fn);
  }
  private async row(tx: Transaction, id: string, select = SESSION): Promise<Row> {
    const row = await tx.get<Row>(`${select} WHERE id=?`, id);
    check(row, 'session_not_found', 'Session not found', 404);
    return row;
  }
  private lookup(session: Session): SessionLookup {
    return {
      id: session.id,
      ...(session.agentId ? { agentId: session.agentId } : {}),
      actorId: session.actorId,
      instanceId: session.instanceId,
      expectedRevision: session.expectedRevision,
      role: session.role,
      status: session.status,
      createdAt: session.createdAt,
      closedAt: session.closedAt,
    };
  }
  private decode(row: Row): Session {
    const session: Session = JSON.parse(row.session_json);
    if (row.attachment_json !== null)
      session.workspace = {
        attachment: JSON.parse(row.attachment_json),
        result: row.result_json === null ? null : JSON.parse(row.result_json),
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
  /**
   * The session's lease still holds; with `frozen`, also the references its execution grants now.
   * A record moved by this worker's own hand is its handoff landing, not a conflict: a second
   * copy of the same call has nothing left to do.
   */
  private async valid(
    session: Session,
    tx: Transaction,
    frozen?: Session['execution'],
  ): Promise<{ registrationId: string; references?: WorkflowExecutionReferences }> {
    this.ensureOpen();
    if (!live(session)) throw await this.endedHere(session, tx);
    check(
      session.expiresAt > isoNow(this.clock) && session.hardDeadline > isoNow(this.clock),
      'session_expired',
      'Session has expired',
      401,
    );
    await this.source(session, tx);
    let execution: { registrationId: string; references?: WorkflowExecutionReferences };
    try {
      execution = await this.framed(
        {
          tx,
          actorId: session.actorId,
          sessionId: session.id,
          source: session.source,
          role: session.role,
        },
        () => this.workflows.checkLease(this.worker(session), session.lease, tx, frozen),
      );
    } catch (error) {
      if (
        error instanceof MervError &&
        error.code === 'revision_conflict' &&
        (await this.handedOff(session, tx))
      )
        throw new MervError(
          'session_completed',
          'Your handoff already moved this record; this session has ended',
          409,
        );
      throw error;
    }
    this.ensureOpen();
    check(
      session.expiresAt > isoNow(this.clock) && session.hardDeadline > isoNow(this.clock),
      'session_expired',
      'Session expired during validation',
      401,
    );
    return execution;
  }
  private async guard(
    caller: Caller,
    tx: Transaction,
    requiredPermission: Permission,
  ): Promise<DelegationSource> {
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
    const row = await this.row(tx, caller.session.id);
    const session = this.decode(row);
    check(
      session.actorId === caller.actorId && session.projectId === caller.projectId,
      'forbidden',
      'Session cannot select another worker',
      403,
    );
    if (!live(session)) throw await this.endedHere(session, tx);
    check(
      session.expiresAt > isoNow(this.clock) && session.hardDeadline > isoNow(this.clock),
      'session_closed',
      'Session is closed or expired',
      401,
    );
    await this.credentials.authenticateHash(row.token_hash, 'session-execution', tx);
    if (caller.session.agentCredentialHash)
      await this.credentials.authenticateHash(
        caller.session.agentCredentialHash,
        'session-agent',
        tx,
      );
    if (
      requiredPermission !== 'read' &&
      caller.session?.invocationId !== undefined &&
      caller.session?.invocationId === this.invocations.toolHandler.getStore()
    ) {
      const tool = this.invocations.invocationIds.get(caller.session.invocationId)?.public.tool;
      if (tool !== 'session.messages' && tool !== 'session.message.ack') {
        await this.messaging.requireMessagesAcknowledged(session.id, tx);
      }
    }
    await this.source(session, tx);
    const invocationId = caller.session.invocationId;
    if (invocationId !== undefined) {
      const invocation = this.invocations.invocationIds.get(invocationId);
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
    select = SESSION,
  ): Promise<Session> {
    if (caller.managed) {
      await this.managed.controlled(caller, id, runnerId, tx);
      const row = await this.row(tx, id, select);
      check(row.project_id === caller.projectId, 'session_not_found', 'Session not found', 404);
      return this.decode(row);
    }
    const owner = await ownerOf(this.scope, caller, tx),
      row = await this.row(tx, id, select);
    // Another project's session is not found here; another owner's is forbidden.
    check(row.project_id === caller.projectId, 'session_not_found', 'Session not found', 404);
    check(
      row.owner_hash === owner.hash,
      'session_forbidden',
      'Session belongs to another source authority',
      403,
    );
    const session = this.decode(row);
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
    const credential = await tx.get<{ token_hash: string }>(
      'SELECT token_hash FROM worker_sessions WHERE id=?',
      session.id,
    );
    // Hosted Codex may finish its already-started model call for one minute after handoff.
    // The model relay alone grants that grace; MCP still sees the closed execution.
    const managedHandoff =
      reason === 'handoff' &&
      (await tx.get(
        'SELECT allocation_id FROM session_managed_runners WHERE bound_session_id=? UNION ALL SELECT allocation_id FROM session_managed_assignments WHERE session_id=?',
        session.id,
        session.id,
      ));
    if (credential && !managedHandoff)
      await this.credentials.revoke(credential.token_hash, 'sessions', tx);
    await recordUsage(tx, session);
    // An offer that lapsed before any process activated it is a launch that was lost, and
    // would otherwise be re-offered every five minutes for ever with nothing counting it.
    const failure = failureReasons.has(session.outcome)
      ? session.outcome
      : reason === 'session_expired' && session.activatedAt === null
        ? 'offer_expired'
        : undefined;
    if (failure) await this.dispatch.failed(session, failure, tx);
    // A session that may be continued leaves its agent dormant, its credential revoked above.
    if (session.continuity) await this.conversations.closed(session, tx);
    else {
      const agent = await this.directory.get(session.agentId!, tx);
      if (!agent.persistent) await this.directory.retire(agent, reason, tx);
    }
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
    // the halt answers; its own consumer of session.closed releases it if the program was away.
    try {
      await this.workflows.releaseLease(session.lease, { reason }, tx);
    } catch (error) {
      if (!(error instanceof MervError)) throw error;
    }
    return session;
  }
  private async renewSessionCredential(session: Session, tx: Transaction): Promise<void> {
    const row = await this.row(tx, session.id);
    await this.credentials.renew(row.token_hash, 'sessions', session.expiresAt, tx);
  }
  /** Why an ended session refuses: a session closed after its own handoff moved the record
   *  says it completed, however it was closed, so a retry can tell its delivery landed. */
  private async endedHere(session: Session, tx: Transaction): Promise<MervError> {
    return session.closeReason !== 'handoff' && (await this.handedOff(session, tx))
      ? ended({ ...session, closeReason: 'handoff' })
      : ended(session);
  }
  private async handedOff(session: Session, tx: Transaction): Promise<boolean> {
    return (
      (await this.workflows.movedBy(session.instanceId, session.expectedRevision + 1, tx)) ===
      session.actorId
    );
  }
  /** The closure a live session's check finds, recorded; on a snapshot the refusal to record it
   *  propagates, so a writer records it, unless the caller only `report`s it. */
  private async reconcile(session: Session, tx: Transaction, report = false) {
    if (!live(session)) return ended(session);
    try {
      await this.valid(session, tx);
      return;
    } catch (error) {
      const failure = safeError(error);
      if (failure.status >= 500) return failure;
      // The record moved by this worker's own hand: that is its handoff, not a conflict.
      const handoff = failure.code === 'session_completed';
      const close = async (
        ...rest: Parameters<typeof this.closeSession> extends [Session, ...infer R] ? R : never
      ) => {
        try {
          await this.closeSession(session, ...rest);
        } catch (error) {
          if (!report || !refused(error)) throw error;
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
    ordinary(caller);
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
      !this.state.ambient,
      'nested_session_offer',
      'Session offers require their own control transaction',
    );
    await this.scope.delegationSource(caller);
    await this.pass(false);
    await this.events.drain();
  }
  private async offerTransaction(
    caller: Caller,
    input: SessionOffer,
    tx: Transaction,
    dispatched = false,
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
      `${SESSION} WHERE owner_hash=? AND runner_id=? AND request_id=?`,
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
      return this.decode(old);
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
    // Historical rows retain their hashes even after their Identity credentials are revoked.
    // Reuse is a malformed runner offer, never a failed launch of the target.
    const tokenHash = tokenDigest(input.secret);
    check(
      !(await tx.get('SELECT id FROM worker_sessions WHERE token_hash=?', tokenHash)) &&
        !(await tx.get('SELECT id FROM agents WHERE token_hash=?', tokenHash)),
      'session_secret_used',
      'Session secret was already used',
      409,
    );
    // Continuity, for work no agent was named for: the key of the work as it stands, and the
    // conversation its latest closed session kept, taken up by the same agent where it can be.
    let continuity: SessionContinuity | undefined, resumed: Agent | undefined;
    if (!input.agentId) {
      const unit = await this.workflows.get(caller, input.instanceId, tx);
      const key = this.conversations.key({
        instanceId: unit.id,
        workflow: unit.workflow,
        state: unit.state,
        data: unit.data,
        role,
      });
      const latest =
        key === null ? null : await this.conversations.latest(caller.projectId, key, tx);
      const agent = latest && (await this.directory.get(latest.agentId, tx));
      if (
        agent &&
        agent.status === 'active' &&
        digest(agent.source) === owner.hash &&
        !(await this.currentAgentExecution(agent, tx))
      )
        resumed = agent;
      if (key !== null) continuity = { key, ...(resumed && { resume: latest!.resume }) };
    }
    const id = newId('session');
    const agent = input.agentId
      ? await this.directory.controlled(caller, input.agentId, tx)
      : (resumed ??
        (await this.directory.create(
          caller,
          {
            name: `Agent ${input.runnerId}`.slice(0, 200),
            runnerId: input.runnerId,
            requestId: `assignment:${digest({ requestId: input.requestId, runnerId: input.runnerId })}`,
            secret: input.secret,
          },
          tx,
          false,
        )));
    await this.directory.require(agent, tx, 409);
    // A resumed agent is Sessions' choice, not the runner's: it may have run anywhere.
    check(
      resumed || agent.runnerId === input.runnerId,
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
    // Dispatch chose this work by the capabilities the runner advertised; a work host's
    // runner is registered under its sponsor, not the phase source (a reviewer) offering here.
    if (!dispatched && workspace.mode !== 'none' && workspace.driver !== undefined)
      check(
        await this.dispatch.capable(caller, input.runnerId, workspace.driver, tx),
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
    const hard = Math.min(time + duration * 1000, delegationEnd(owner.source));
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
      ...(continuity && { continuity }),
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
    try {
      await this.credentials.issue(
        {
          owner: 'sessions',
          subject: id,
          kind: 'session-execution',
          token: input.secret,
          expiresAt: session.expiresAt,
          hardDeadline: session.hardDeadline,
        },
        tx,
      );
    } catch (error) {
      if (error instanceof MervError && error.code === 'credential_conflict')
        throw new MervError('session_secret_used', 'Session secret was already used', 409);
      throw error;
    }
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
    ordinary(caller);
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
      `${SESSION} WHERE actor_id=? AND status IN ('offered','active')`,
      agent.actorId,
    );
    return row ? this.decode(row) : null;
  }
  /** Every agent's assignments, read in one query. */
  private async agentStatuses(agents: Agent[], tx: Transaction): Promise<AgentStatus[]> {
    const sessions = agents.length
      ? (
          await tx.all<Row>(
            `${SESSION} WHERE actor_id IN (${agents.map(() => '?').join()}) ORDER BY _merv_rowid`,
            ...agents.map((agent) => agent.actorId),
          )
        ).map((row) => this.decode(row))
      : [];
    return agents.map((agent) => {
      const assignments = sessions.filter((session) => session.actorId === agent.actorId);
      return { agent, current: assignments.find(live) ?? null, assignments };
    });
  }
  async agents(caller: Caller): Promise<AgentStatus[]> {
    ordinary(caller);
    caller = structuredClone(caller);
    return await this.transaction(
      async (tx) => await this.agentStatuses(await this.directory.list(caller, tx), tx),
    );
  }
  async agent(caller: Caller, agentId: string): Promise<AgentStatus> {
    ordinary(caller);
    caller = structuredClone(caller);
    return await this.transaction(
      async (tx) =>
        (await this.agentStatuses([await this.directory.controlled(caller, agentId, tx)], tx))[0]!,
    );
  }
  async retireAgent(caller: Caller, agentId: string): Promise<Agent> {
    ordinary(caller);
    caller = structuredClone(caller);
    return await this.transaction(async (tx) => {
      const agent = await this.directory.controlled(caller, agentId, tx);
      const current = await this.currentAgentExecution(agent, tx);
      if (current)
        await this.closeReleased(current, { reason: 'agent_retired', outcome: 'halted' }, tx);
      return await this.directory.retire(agent, 'agent_retired', tx);
    });
  }
  async rotateAgent(
    caller: Caller,
    agentId: string,
  ): Promise<{ agent: Agent; token: string; expiresAt: string }> {
    ordinary(caller);
    caller = structuredClone(caller);
    return await this.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const agent = await this.directory.controlled(caller, agentId, tx);
      await this.directory.require(agent, tx, 409);
      check(
        agent.persistent,
        'agent_forbidden',
        'Only continuing agents may rotate credentials',
        403,
      );
      await this.credentials.revokeSubject('sessions', agent.id, 'session-agent', tx);
      const expiresAt = new Date(this.clock() + 30 * 24 * 60 * 60_000).toISOString();
      const issued = await this.credentials.issue(
        {
          owner: 'sessions',
          subject: agent.id,
          kind: 'session-agent',
          prefix: 'ms_',
          expiresAt,
          hardDeadline: expiresAt,
        },
        tx,
      );
      return { agent, token: issued.token, expiresAt };
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
      return { ...(await this.agentStatuses([agent], tx))[0]!, available };
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
      const session = this.decode(await this.row(tx, executionId));
      check(
        session.agentId === agent.id,
        'agent_forbidden',
        'Assignment belongs to another agent',
        403,
      );
      return await this.closeReleased(session, {}, tx);
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
  async findSession(
    caller: Caller,
    instanceId: string,
  ): Promise<{ current: SessionLookup | null; latest: SessionLookup | null }> {
    ordinary(caller);
    check(!caller.session, 'forbidden', 'Workers cannot look up other sessions', 403);
    check(text(instanceId, 200), 'invalid_instance', 'A work item ID is required');
    return await this.reading(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.workflows.get(caller, instanceId, tx);
      const sessions = (
        await tx.all<Row>(
          `${SESSION} WHERE project_id=? AND instance_id=? ORDER BY _merv_rowid DESC LIMIT 20`,
          caller.projectId,
          instanceId,
        )
      ).map((row) => this.decode(row));
      const latest = sessions[0] ?? null;
      let current: Session | null = sessions.find(live) ?? null;
      if (current) {
        try {
          await this.valid(current, tx);
        } catch (error) {
          if (!(error instanceof MervError) || error.status >= 500) throw error;
          current = null;
        }
      }
      return {
        current: current ? this.lookup(current) : null,
        latest: latest ? this.lookup(latest) : null,
      };
    });
  }
  /**
   * Unlike the dispatch reads this admits a leased worker: it discloses totals, never a
   * credential or another worker's input, and a worker may need to say what the work it
   * reviews cost. The scope check still bounds it to the caller's project.
   */
  async usage(caller: Caller, input: UsageQuery = {}): Promise<UsageRollup> {
    ordinary(caller);
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
      const rollup = await usageTotals(tx, caller.projectId, instanceIds, instanceId);
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
        totals: rollup.totals,
        byWorkflow: rollup.byWorkflow,
        byInstance: rollup.byInstance,
        liveSessions: (await tx.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM worker_sessions WHERE project_id=? AND status IN ('offered','active')",
          caller.projectId,
        ))!.n,
        budgets: await this.dispatch.budgetsFor(caller, tx, instanceId),
        accounting: {
          wallClock: 'measured',
          tokens: 'runner_reported',
          since: rollup.since,
          method: accountingMethod,
        },
      };
    });
  }

  async workspaceObservation(
    caller: Caller,
    sessionId: string,
    transaction?: Transaction,
  ): Promise<SessionWorkspaceObservation> {
    ordinary(caller);
    caller = structuredClone(caller);
    this.ensureOpen();
    check(text(sessionId), 'invalid_session', 'A session identifier is required');
    if (transaction) this.state.assertTransaction(transaction);
    const read = async (sql: Transaction): Promise<SessionWorkspaceObservation> => {
      await this.scope.require(caller, 'read', sql);
      const row = await sql.get<Row>(
        `${SESSION} WHERE id=? AND project_id=?`,
        sessionId,
        caller.projectId,
      );
      check(row, 'session_not_found', 'Session not found in this project', 404);
      const session = this.decode(row);
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
    // A pure read: a capture reaches it inside a plain read, which must not wait on the writer lock.
    return transaction ? await read(transaction) : await this.reading(read);
  }
  async list(caller: Caller): Promise<Session[]> {
    ordinary(caller);
    caller = structuredClone(caller);
    return await this.transaction(async (tx) => {
      const owner = await ownerOf(this.scope, caller, tx);
      return (
        await tx.all<Row>(`${SESSION} WHERE owner_hash=? ORDER BY _merv_rowid`, owner.hash)
      ).map((row) => this.decode(row));
    });
  }
  async get(caller: Caller, sessionId: string): Promise<Session> {
    caller = structuredClone(caller);
    const result = await this.reading(async (tx) => {
      const session = await this.controlled(caller, sessionId, undefined, tx);
      // A poll reports a closure to its controller, recorded only in a caller's writer, else by
      // the sweep; provider outages are retryable. A managed poll only reads.
      const error = caller.managed ? undefined : await this.reconcile(session, tx, true);
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
          await this.dispatch.capable(
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
  registerLaunchConnections(provider: LaunchConnectionsProvider): () => void {
    this.ensureOpen();
    check(
      !this.launchConnectionsProvider,
      'launch_connections_registered',
      'A launch connection provider is already registered',
      409,
    );
    this.launchConnectionsProvider = provider;
    return () => {
      if (this.launchConnectionsProvider === provider) this.launchConnectionsProvider = undefined;
    };
  }
  /** Private supervisor response; provider I/O must never hold a database snapshot or lock. */
  async launchConnections(
    caller: Caller,
    input: SessionControl & { hostRef: string },
  ): Promise<{ connections: NativeMcpConnection[] }> {
    caller = structuredClone(caller);
    input = closed(controlSchema.extend({ hostRef: trimmed(512) }), input, controlRefusals);
    check(
      !this.state.ambient,
      'nested_launch_connections',
      'Launch credentials require an independent control request',
      409,
    );
    const authorize = () =>
      this.reading(async (tx) => {
        const session = await this.controlled(caller, input.sessionId, input.runnerId, tx);
        check(
          session.hostRef !== null && session.hostRef === input.hostRef,
          'host_conflict',
          'Credential delivery must name the attached host',
          409,
        );
        if (caller.managed) {
          const host = (await this.managed.require(caller, tx)).row;
          const row = await this.managed.forSession(host, session.id, tx);
          check(
            row.source_json === canonical(session.source) && row.runner_id === session.runnerId,
            'session_forbidden',
            'Session source differs from its managed binding',
            403,
          );
        }
        const row = await this.row(tx, session.id);
        await this.credentials.authenticateHash(row.token_hash, 'session-execution', tx);
        const authority = await this.valid(session, tx, session.execution);
        return { session, registrationId: authority.registrationId };
      });
    const before = await authorize();
    const workspace = effectiveWorkspace(before.session.execution.policy);
    const provider = this.launchConnectionsProvider;
    if (
      !provider ||
      (before.session.execution.policy.readOnly && workspace.mode !== 'none' && workspace.retain)
    )
      return { connections: [] };
    let issued: unknown;
    try {
      issued = await provider(freezeLaunchSnapshot(structuredClone(before.session)));
    } catch (error) {
      // Provider exceptions can carry upstream response bodies or credentials.
      if (error instanceof MervError && [401, 403].includes(error.status))
        throw new MervError(
          'launch_connections_denied',
          'Access to a required launch connection was revoked',
          409,
        );
      throw new MervError(
        'launch_connections_unavailable',
        'Launch connections are unavailable',
        503,
      );
    }
    const after = await authorize();
    check(
      this.launchConnectionsProvider === provider &&
        before.registrationId === after.registrationId &&
        canonical(before.session.execution) === canonical(after.session.execution) &&
        canonical(before.session.lease) === canonical(after.session.lease) &&
        before.session.hardDeadline === after.session.hardDeadline,
      'execution_replaced',
      'Assignment changed during credential issuance',
      409,
    );
    const parsed = nativeMcpConnectionsSchema.safeParse(issued);
    check(
      parsed.success,
      'invalid_launch_connections',
      'Invalid private launch connection response',
      502,
    );
    return { connections: parsed.data! };
  }
  /** Private managed-control delivery after attachment. Source identity is immutable. */
  private async huggingFaceIdentity(
    session: Session,
    row: ManagedBindingRow,
    hostRef: string,
    tx: Transaction,
  ): Promise<AccountIdentity | null> {
    row = await this.managed.forSession(row, session.id, tx);
    check(
      row.source_json === canonical(session.source) && session.runnerId === row.runner_id,
      'session_forbidden',
      'Session source differs from its managed binding',
      403,
    );
    check(
      session.hostRef !== null && session.hostRef === hostRef,
      'host_conflict',
      'Credential delivery must name the attached host',
      409,
    );
    await this.valid(session, tx);
    const workspace = effectiveWorkspace(session.execution.policy);
    if (
      (session.execution.policy.readOnly && workspace.mode !== 'none' && workspace.retain) ||
      JSON.parse(row.platform_json).harness !== 'codex'
    )
      return null;
    const source = session.source.kind === 'service' ? session.source.vouchedBy : session.source;
    if (source.kind !== 'human' && source.kind !== 'key') return null;
    const { user } = await this.scope.requireDelegation(source, 'read', tx);
    return user ? { issuer: user.issuer, subject: user.subject } : null;
  }
  async authorizeHuggingFaceGrant(grant: HuggingFaceGrant): Promise<AccountIdentity | null> {
    return this.reading(async (tx) => {
      const row = await this.managed.huggingFaceBinding(grant, tx);
      const session = this.decode(await this.row(tx, grant.sessionId));
      check(
        grant.exp * 1000 <= Date.parse(session.hardDeadline),
        'unauthorized',
        'Hugging Face access unavailable',
        401,
      );
      return this.huggingFaceIdentity(session, row, grant.hostRef, tx);
    });
  }
  async huggingfaceAccess(caller: Caller, input: SessionControl & { hostRef: string }) {
    caller = structuredClone(caller);
    input = closed(controlSchema.extend({ hostRef: trimmed(512) }), input, controlRefusals);
    check(caller.managed, 'managed_runner_forbidden', 'Managed runner authority required', 403);
    const grant = await this.reading(async (tx) => {
      const session = await this.controlled(caller, input.sessionId, input.runnerId, tx);
      const { row } = await this.managed.require(caller, tx);
      if (!(await this.huggingFaceIdentity(session, row, input.hostRef, tx))) return null;
      return {
        v: 1 as const,
        sessionId: session.id,
        runnerId: input.runnerId,
        allocationId: row.allocation_id,
        epoch: Number(row.epoch),
        hostRef: input.hostRef,
        exp: Math.floor(Date.parse(session.hardDeadline) / 1000),
      };
    });
    return {
      access:
        grant && this.secrets?.createHuggingFaceAccess
          ? await this.secrets.createHuggingFaceAccess(grant)
          : null,
    };
  }
  async huggingface(
    caller: Caller,
    input: SessionControl & { hostRef: string },
  ): Promise<{ hfToken: string | null }> {
    caller = structuredClone(caller);
    input = closed(controlSchema.extend({ hostRef: trimmed(512) }), input, controlRefusals);
    check(caller.managed, 'managed_runner_forbidden', 'Managed runner authority required', 403);
    return await this.reading(async (tx) => {
      const session = await this.controlled(caller, input.sessionId, input.runnerId, tx);
      const { row } = await this.managed.require(caller, tx);
      const identity = await this.huggingFaceIdentity(session, row, input.hostRef, tx);
      return {
        hfToken:
          // Compatibility window ends after the hosted image rollout; old runners then
          // receive null. New runners exclusively use huggingface-access.
          identity && this.secrets && this.clock() < Date.parse('2026-10-08T00:00:00Z')
            ? await this.secrets.resolveHuggingFaceToken(identity)
            : null,
      };
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
  /** Runner-only, live or closed: the runner that held the session declares and delivers what it printed. */
  async transcript(
    caller: Caller,
    input: SessionControl & SessionTranscriptDeclaration,
  ): Promise<SessionTranscript> {
    caller = structuredClone(caller);
    this.ensureOpen();
    return await this.transcripts.record(
      caller,
      closed(transcriptSchema, input, transcriptRefusals),
    );
  }
  /** Runner-only, live or closed: the conversation a session kept, declared then delivered. */
  async conversation(
    caller: Caller,
    input: SessionControl & SessionConversationDeclaration,
  ): Promise<SessionTranscript> {
    caller = structuredClone(caller);
    this.ensureOpen();
    return await this.conversations.record(
      caller,
      closed(conversationSchema, input, conversationRefusals),
    );
  }
  async resume(caller: Caller, input: SessionControl & { hostRef: string }) {
    caller = structuredClone(caller);
    this.ensureOpen();
    return await this.conversations.download(
      caller,
      closed(controlSchema.extend({ hostRef: trimmed(512) }), input, controlRefusals),
    );
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
      // Each renewal rewrites the frozen packet, so one that slides the window by less than 15
      // minutes is skipped; the window stays over 3h45m ahead, or reaches the hard deadline.
      const expiresAt = this.slide(session);
      const step = Date.parse(expiresAt) - Date.parse(session.expiresAt);
      if (step < (expiresAt === session.hardDeadline ? 1 : 900_000)) return;
      session.expiresAt = expiresAt;
      await this.save(tx, session);
      await this.renewSessionCredential(session, tx);
    });
  }
  private slide(session: Session): string {
    return new Date(
      Math.min(this.clock() + 14_400_000, Date.parse(session.hardDeadline)),
    ).toISOString();
  }
  private async controlMutation(
    caller: Caller,
    input: SessionControl,
    mutate: (session: Session, tx: Transaction) => void | Promise<void>,
  ): Promise<Session> {
    const result = await this.readFirst(async (tx) => {
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
      // A closure its checks find (a revocation, a lease its domain refused) is recorded as that.
      // A landed handoff comes first, as closeReleased records it: expiry never hides it.
      if (live(session) && !(await this.handedOff(session, tx))) await this.reconcile(session, tx);
      const released = await this.closeReleased(session, control, tx);
      if (usage) await this.reportUsage(released, usage, tx);
      if (caller.managed) await this.managed.acknowledgeRelease(caller, session.id, tx);
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
    if (!live(session)) return session;
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
    if (!(await reportUsage(tx, session.id, usage, isoNow(this.clock)))) return;
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
        model: usage.model ?? null,
      },
    });
  }
  async authenticate(token: string): Promise<Caller> {
    const result = await this.readFirst(async (tx) => {
      const credential = await this.credentials.authenticate(
        token,
        ['session-agent', 'session-execution'],
        tx,
      );
      const agent =
        credential.kind === 'session-agent'
          ? await this.directory.get(credential.subject, tx)
          : undefined;
      if (agent) await this.directory.require(agent, tx);
      const current = agent ? await this.currentAgentExecution(agent, tx) : undefined;
      if (agent) check(current, 'agent_idle', 'Agent has no current assignment', 409);
      const row = current
        ? await this.row(tx, current.id)
        : await tx.get<Row>(`${SESSION} WHERE id=?`, credential.subject);
      check(row, 'unauthorized', 'Invalid session bearer credential', 401);
      const session = this.decode(row),
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
        session.expiresAt = this.slide(session);
        await this.save(tx, session);
        await this.renewSessionCredential(session, tx);
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
      const caller = this.worker(session);
      if (credential.kind === 'session-agent')
        caller.session!.agentCredentialHash = credential.tokenHash;
      return { caller };
    });
    if (result.error) throw result.error;
    return result.caller!;
  }
  contributeStatus(key: string, section: StatusSection): () => void {
    check(!this.sections.has(key), 'status_section_registered', `${key} is taken`, 409);
    this.sections.set(key, section);
    return () => {
      if (this.sections.get(key) === section) this.sections.delete(key);
    };
  }
  async statusSections(...view: Parameters<StatusSection>): Promise<Record<string, unknown>> {
    const read = await Promise.all(
      [...this.sections].map(async ([key, section]) => [key, await section(...view)] as const),
    );
    return Object.fromEntries(read.filter(([, value]) => value !== undefined));
  }
  async session(caller: Caller, tx?: Transaction): Promise<Session> {
    ordinary(caller);
    if (!tx) {
      const own = structuredClone(caller);
      return await this.transaction(async (tx) => await this.session(own, tx));
    }
    await this.scope.require(caller, 'read', tx);
    check(caller.session, 'session_required', 'Session authority is required', 401);
    return this.decode(await this.row(tx, caller.session.id));
  }
  /**
   * Upkeep, each subject decided on a snapshot of its own and recorded in a writer only when it
   * has something to record, so a healthy pass takes no writer lock and a failing subject holds
   * back no other. Full: every live session, active agent and service reservation; else only the
   * sessions whose deadline passed or whose record moved.
   */
  private async pass(full: boolean): Promise<void> {
    if (full) {
      this.checkedAt = this.clock();
      this.failing.clear();
    }
    const { sessions, agents } = await this.reading(async (tx) => ({
      sessions: await this.live(tx, !full),
      agents: full
        ? // A dormant agent, which holds no credential, waits for its work, not its delegation.
          await tx.all<{ id: string }>(
            "SELECT id FROM agents a WHERE status='active' AND (token_hash IS NOT NULL OR EXISTS (SELECT 1 FROM worker_sessions s WHERE s.actor_id=a.actor_id AND s.status IN ('offered','active')))",
          )
        : [],
    }));
    // A session that failed is retried by the next full pass, not by every tick and lease.
    for (const { id } of sessions.filter(({ id }) => full || !this.failing.has(id)))
      await this.alone(id, () => this.readFirst((tx) => this.upkeep(id, tx)));
    for (const { id } of agents)
      await this.alone(id, () => this.readFirst((tx) => this.lapsed(id, tx)));
    if (full) {
      await this.alone('service-work', () => this.readFirst((tx) => this.serviceWork.expire(tx)));
      await this.alone('session-events', () => this.streams.prune());
      await this.alone('conversations', () =>
        this.readFirst((tx) => this.conversations.expire(tx)),
      );
    }
  }
  /** The live sessions, oldest first; when `lapsing`, only those past their deadline or moved. */
  private async live(tx: Transaction, lapsing: boolean): Promise<{ id: string }[]> {
    const live = await tx.all<{
      id: string;
      project_id: string;
      instance_id: string;
      revision: number;
      expired: boolean | null;
    }>(
      "SELECT id,project_id,instance_id,revision,(session_json::json->>'expiresAt')<=? AS expired FROM worker_sessions WHERE status IN ('offered','active') ORDER BY _merv_rowid",
      isoNow(this.clock),
    );
    if (!lapsing) return live;
    const at = new Map<string, number>();
    for (const projectId of new Set(live.map((row) => row.project_id)))
      for (const [id, instance] of await this.workflows.revisions(
        projectId,
        live.filter((row) => row.project_id === projectId).map((row) => row.instance_id),
        tx,
      ))
        at.set(id, instance.revision);
    return live.filter((row) => row.expired || at.get(row.instance_id) !== row.revision);
  }
  /** One live session's upkeep: a closure found, or its stranding. */
  private async upkeep(id: string, tx: Transaction) {
    const session = this.decode(await this.row(tx, id));
    if (await this.reconcile(session, tx)) return;
    const stranded = await this.managed.stranded(id, tx);
    if (stranded !== undefined)
      await this.closeSession(
        session,
        'managed_revoked',
        tx,
        'expired',
        stranded ? 'machine_retired' : 'host_failed',
      );
  }
  private async lapsed(id: string, tx: Transaction): Promise<void> {
    const agent = await this.directory.get(id, tx);
    try {
      await this.directory.require(agent, tx);
    } catch (error) {
      const failure = safeError(error);
      if (failure.status < 500) await this.directory.retire(agent, failure.code, tx);
    }
  }
  /** One subject on its own: its failure is logged once per code and never stops the rest. */
  private async alone<T>(subject: string, fn: () => Promise<T>): Promise<T | false> {
    try {
      return await fn();
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? 'unexpected');
      if (!this.closed && this.failing.get(subject) !== code)
        process.stderr.write(
          `${JSON.stringify({ event: 'sessions.sweep_failed', subject, code })}\n`,
        );
      this.failing.set(subject, code);
      return false;
    }
  }
  async sweep(): Promise<void> {
    check(!this.state.ambient, 'nested_transaction', 'A sweep runs its own transactions');
    await this.pass(true);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    // A call that ends once closed skips its finish, so the calls in flight now are marked too.
    const running = () =>
      [...this.invocations.invocationIds].filter(([, c]) => c.running).map(([id]) => id);
    const inFlight = running();
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
        () => this.observations.interrupt('', [...inFlight, ...running()]),
      ]) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      this.invocations.invocationIds.clear();
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
      // Without these registrations the tool registry refuses every session and managed caller.
      ctx.inject(['tools'], (ctx) => {
        ctx.effect(() => ctx.tools.registerSessionPolicy(sessions.invocations));
        ctx.effect(() => ctx.tools.registerCallerRules('managed', managedRunnerRules));
      });
      // Transcripts go to the object store; while Blobs is unloaded a runner is told to retry.
      ctx.inject(['blobs'], (ctx) => {
        ctx.effect(() => {
          sessions.transcripts.blobs = sessions.conversations.blobs = ctx.blobs;
          return () => {
            sessions.transcripts.blobs = sessions.conversations.blobs = undefined;
          };
        });
      });
      ctx.inject(['secrets'], (ctx) => {
        ctx.effect(() => {
          sessions.secrets = ctx.secrets;
          const unregister = ctx.secrets.registerHuggingFaceAuthority((grant) =>
            sessions.authorizeHuggingFaceGrant(grant),
          );
          return () => {
            unregister();
            sessions.secrets = undefined;
          };
        });
      });
      yield ctx.provide('sessions', sessions);
    });
  },
};
export default sessionsPlugin;
