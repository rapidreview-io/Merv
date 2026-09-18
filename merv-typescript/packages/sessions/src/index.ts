import { visible, createService, mapAsync } from '@merv/contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { postgresMigrations } from './index.postgres.js';
import { createHash } from 'node:crypto';
import type { Context } from 'cordis';
import {
  canonical,
  check,
  digest,
  effectiveWorkspace,
  MervError,
  newId,
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
import { SessionDispatch } from './dispatch.js';
import { AgentDirectory, sourceCaller } from './agents.js';
import { AgentObservations, summarizeAgent } from './observations.js';
import type { Agent, AgentStatus, AgentRegistration, AgentAssignment } from './types.js';
import type {
  Session,
  SessionControl,
  SessionInvocation,
  SessionOffer,
  Sessions,
  SessionsConfig,
  AutomaticLease,
  DispatchState,
  RunnerHeartbeat,
  RunnerPresence,
  RunnerSettings,
  SessionsProjectStatus,
  SessionOutcome,
  SessionWorkspace,
  SessionWorkspaceObservation,
} from './types.js';
export type * from './types.js';

const tokenPattern = /^ms_[A-Za-z0-9_-]{43}$/;
const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
const live = (session: Session) => session.status === 'offered' || session.status === 'active';
const permission = (role: Session['role']): Permission =>
  role === 'producer' ? 'write' : role === 'reviewer' ? 'review' : 'read';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
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
  private directory!: AgentDirectory;
  private observations!: AgentObservations;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly workflows: Workflows,
    private readonly events: DomainEvents,
    options: SessionsConfig & { clock?: () => number } = {},
  ) {
    this.initialize = async () => {
      this.clock = options.clock ?? Date.now;
      const interval = options.sweepIntervalMs ?? 1000;
      check(
        Number.isInteger(interval) && interval >= 100 && interval <= 60_000,
        'invalid_sessions_config',
        'Session sweep interval must be 100–60000 milliseconds',
      );
      await state.migrate('sessions', [
        {
          version: 1,
          postgres: postgresMigrations[1],
          sql: `
      CREATE TABLE worker_sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id), instance_id TEXT NOT NULL, revision INTEGER NOT NULL,
        owner_hash TEXT NOT NULL, runner_id TEXT NOT NULL, request_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('offered','active','released','expired')), session_json TEXT NOT NULL,
        UNIQUE(owner_hash,runner_id,request_id)
      );
      CREATE UNIQUE INDEX worker_sessions_live_target ON worker_sessions(project_id,instance_id,revision)
        WHERE status IN ('offered','active');
      CREATE TRIGGER worker_sessions_no_delete BEFORE DELETE ON worker_sessions
        BEGIN SELECT RAISE(ABORT,'Session history is retained'); END;
      CREATE TRIGGER worker_sessions_immutable BEFORE UPDATE ON worker_sessions
        WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.actor_id IS NOT OLD.actor_id OR
          NEW.instance_id IS NOT OLD.instance_id OR NEW.revision IS NOT OLD.revision OR NEW.owner_hash IS NOT OLD.owner_hash OR
          NEW.runner_id IS NOT OLD.runner_id OR NEW.request_id IS NOT OLD.request_id OR NEW.token_hash IS NOT OLD.token_hash OR
          NEW.fingerprint IS NOT OLD.fingerprint OR OLD.status IN ('released','expired') OR
          (OLD.status='active' AND NEW.status='offered') OR
          json_extract(NEW.session_json,'$.source') IS NOT json_extract(OLD.session_json,'$.source') OR
          json_extract(NEW.session_json,'$.assignment') IS NOT json_extract(OLD.session_json,'$.assignment') OR
          json_extract(NEW.session_json,'$.execution') IS NOT json_extract(OLD.session_json,'$.execution') OR
          json_extract(NEW.session_json,'$.lease') IS NOT json_extract(OLD.session_json,'$.lease') OR
          json_extract(NEW.session_json,'$.hardDeadline') IS NOT json_extract(OLD.session_json,'$.hardDeadline') OR
          json_extract(NEW.session_json,'$.createdAt') IS NOT json_extract(OLD.session_json,'$.createdAt') OR
          json_extract(NEW.session_json,'$.role') IS NOT json_extract(OLD.session_json,'$.role')
        BEGIN SELECT RAISE(ABORT,'Session assignment and delegation are immutable'); END;
    `,
        },
        {
          version: 2,
          postgres: postgresMigrations[2],
          sql: `
      CREATE TABLE session_workspaces (
        session_id TEXT PRIMARY KEY REFERENCES worker_sessions(id),
        attachment_json TEXT NOT NULL CHECK(json_valid(attachment_json)),
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
      );
      CREATE TRIGGER session_workspaces_no_delete BEFORE DELETE ON session_workspaces
        BEGIN SELECT RAISE(ABORT,'Workspace capture history is retained'); END;
      CREATE TRIGGER session_workspaces_immutable BEFORE UPDATE ON session_workspaces
        WHEN NEW.session_id IS NOT OLD.session_id OR NEW.attachment_json IS NOT OLD.attachment_json OR
          (OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json)
        BEGIN SELECT RAISE(ABORT,'Workspace attachment and final capture are immutable'); END;
    `,
        },
        {
          version: 3,
          rebuild: true,
          postgres: postgresMigrations[3],
          sql: `CREATE TEMP TABLE worker_sessions_backup AS SELECT * FROM worker_sessions;
DROP TRIGGER worker_sessions_no_delete;
DROP TRIGGER worker_sessions_immutable;
DROP TABLE worker_sessions;

      CREATE TABLE worker_sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        actor_id TEXT NOT NULL REFERENCES actors(id), instance_id TEXT NOT NULL, revision INTEGER NOT NULL,
        owner_hash TEXT NOT NULL, runner_id TEXT NOT NULL, request_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('offered','active','released','expired')), session_json TEXT NOT NULL,
        UNIQUE(owner_hash,runner_id,request_id)
      );
      CREATE UNIQUE INDEX worker_sessions_live_target ON worker_sessions(project_id,instance_id,revision)
        WHERE status IN ('offered','active');
      CREATE TRIGGER worker_sessions_no_delete BEFORE DELETE ON worker_sessions
        BEGIN SELECT RAISE(ABORT,'Session history is retained'); END;
      CREATE TRIGGER worker_sessions_immutable BEFORE UPDATE ON worker_sessions
        WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.actor_id IS NOT OLD.actor_id OR
          NEW.instance_id IS NOT OLD.instance_id OR NEW.revision IS NOT OLD.revision OR NEW.owner_hash IS NOT OLD.owner_hash OR
          NEW.runner_id IS NOT OLD.runner_id OR NEW.request_id IS NOT OLD.request_id OR NEW.token_hash IS NOT OLD.token_hash OR
          NEW.fingerprint IS NOT OLD.fingerprint OR OLD.status IN ('released','expired') OR
          (OLD.status='active' AND NEW.status='offered') OR
          json_extract(NEW.session_json,'$.source') IS NOT json_extract(OLD.session_json,'$.source') OR
          json_extract(NEW.session_json,'$.assignment') IS NOT json_extract(OLD.session_json,'$.assignment') OR
          json_extract(NEW.session_json,'$.execution') IS NOT json_extract(OLD.session_json,'$.execution') OR
          json_extract(NEW.session_json,'$.lease') IS NOT json_extract(OLD.session_json,'$.lease') OR
          json_extract(NEW.session_json,'$.hardDeadline') IS NOT json_extract(OLD.session_json,'$.hardDeadline') OR
          json_extract(NEW.session_json,'$.createdAt') IS NOT json_extract(OLD.session_json,'$.createdAt') OR
          json_extract(NEW.session_json,'$.role') IS NOT json_extract(OLD.session_json,'$.role')
        BEGIN SELECT RAISE(ABORT,'Session assignment and delegation are immutable'); END;

INSERT INTO worker_sessions SELECT * FROM worker_sessions_backup;
DROP TABLE worker_sessions_backup;
CREATE UNIQUE INDEX worker_sessions_live_actor ON worker_sessions(actor_id) WHERE status IN ('offered','active');
CREATE TRIGGER worker_sessions_agent_immutable BEFORE UPDATE ON worker_sessions
WHEN json_extract(NEW.session_json,'$.agentId') IS NOT json_extract(OLD.session_json,'$.agentId') OR
json_extract(NEW.session_json,'$.agentSessionId') IS NOT json_extract(OLD.session_json,'$.agentSessionId') OR
json_extract(NEW.session_json,'$.contextEpoch') IS NOT json_extract(OLD.session_json,'$.contextEpoch')
BEGIN SELECT RAISE(ABORT,'Agent attribution is immutable'); END;`,
        },
      ]);
      this.directory = await createService(new AgentDirectory(state, scope, this.clock));
      this.observations = await createService(new AgentObservations(state, scope, this.clock));
      this.dispatcher = await createService(
        new SessionDispatch(
          state,
          scope,
          workflows,
          {
            prepare: async (caller) => await this.prepareControl(caller),
            offer: async (caller, input, tx) => await this.offerTransaction(caller, input, tx),
            close: async (session, reason, tx) =>
              await this.closeSession(session, reason, tx, 'released', 'halted'),
            agents: async (caller, tx) => await this.agentSummaries(caller, tx),
          },
          this.clock,
        ),
      );
      try {
        this.disposers.push(
          scope.registerSessionAuthority({
            require: async (caller, tx) => await this.guard(caller, tx),
          }),
        );
        this.disposers.push(scope.toolPolicy.registerSessions(this));
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
                const row = await this.row(tx, event.subjectId);
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
        }, interval);
        this.timer.unref();
      } catch (error) {
        await this.close();
        throw error;
      }
    };
  }
  private clock!: () => number;
  private time(): string {
    return new Date(this.clock()).toISOString();
  }
  private ensureOpen(): void {
    check(!this.closed, 'session_unavailable', 'Sessions is unavailable', 503);
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
      session.expiresAt > this.time() && session.hardDeadline > this.time(),
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
      session.expiresAt > this.time() && session.hardDeadline > this.time(),
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
      live(session) && session.expiresAt > this.time() && session.hardDeadline > this.time(),
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
  private async owner(
    caller: Caller,
    tx: Transaction,
  ): Promise<{ source: DelegationSource; hash: string }> {
    const source = await this.scope.delegationSource(caller, tx);
    return { source, hash: digest(source) };
  }
  private async controlled(
    caller: Caller,
    id: string,
    runnerId: string | undefined,
    tx: Transaction,
  ): Promise<Session> {
    const owner = await this.owner(caller, tx),
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
    session.closedAt = this.time();
    session.closeReason = reason;
    session.outcome = outcome ?? (status === 'expired' ? 'expired' : 'released');
    await this.save(tx, session);
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
  private async reconcile(session: Session, tx: Transaction): Promise<MervError | undefined> {
    if (!live(session)) return new MervError('session_closed', 'Session is closed', 401);
    try {
      await this.valid(session, tx);
      return;
    } catch (error) {
      const failure = safeError(error);
      if (failure.status >= 500) return failure;
      // The record moved by this worker's own hand: that is its handoff, not a conflict.
      const moved =
        failure.code === 'revision_conflict'
          ? await tx.get<{ actor_id: string }>(
              'SELECT actor_id FROM wf_history WHERE instance_id=? AND revision=?',
              session.instanceId,
              session.expectedRevision + 1,
            )
          : undefined;
      if (moved?.actor_id !== session.actorId) {
        await this.closeSession(session, failure.code, tx);
        return failure;
      }
      await this.closeSession(session, 'handoff', tx, 'released', 'completed');
      return new MervError(
        'session_completed',
        'This session’s handoff completed and the session has ended; its record moved on',
        401,
      );
    }
  }
  async offer(caller: Caller, input: SessionOffer): Promise<Session> {
    check(
      input &&
        (input.agentId === undefined || text(input.agentId)) &&
        text(input.instanceId) &&
        Number.isSafeInteger(input.expectedRevision) &&
        input.expectedRevision >= 0 &&
        text(input.runnerId) &&
        text(input.requestId, 320) &&
        tokenPattern.test(input.secret),
      'invalid_session_offer',
      'Offer requires a target revision, runner, request and caller-generated ms_ secret',
    );
    const duration = input.hardDeadlineSeconds ?? 86_400;
    check(
      Number.isInteger(duration) && duration >= 300 && duration <= 604_800,
      'invalid_deadline',
      'Session hard deadline must be 300–604800 seconds',
    );
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
    const owner = await this.owner(caller, tx);
    const fingerprint = digest({
      instanceId: input.instanceId,
      expectedRevision: input.expectedRevision,
      runnerId: input.runnerId,
      hardDeadlineSeconds: duration,
      tokenHash: hashToken(input.secret),
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
        hashToken(input.secret),
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
      hashToken(input.secret),
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
          tx.dialect === 'postgres'
            ? 'SELECT * FROM worker_sessions WHERE actor_id=? ORDER BY _merv_rowid'
            : 'SELECT * FROM worker_sessions WHERE actor_id=? ORDER BY rowid',
          agent.actorId,
        ),
        (row) => this.decode(row, tx),
      ),
    };
  }
  async agents(caller: Caller): Promise<AgentStatus[]> {
    return await this.transaction(async (tx) =>
      mapAsync(await this.directory.list(caller, tx), (agent) => this.agentStatus(agent, tx)),
    );
  }
  async agent(caller: Caller, agentId: string): Promise<AgentStatus> {
    return await this.transaction(
      async (tx) =>
        await this.agentStatus(await this.directory.controlled(caller, agentId, tx), tx),
    );
  }
  async retireAgent(caller: Caller, agentId: string): Promise<Agent> {
    return await this.transaction(async (tx) => {
      const agent = await this.directory.controlled(caller, agentId, tx);
      const current = await this.currentAgentExecution(agent, tx);
      if (current) await this.closeSession(current, 'agent_retired', tx, 'released', 'halted');
      return await this.directory.retire(agent, 'agent_retired', tx);
    });
  }
  async agentSelf(token: string) {
    await this.sweep();
    return await this.transaction(async (tx) => {
      const agent = await this.directory.authenticate(token, tx);
      const busy = new Set(
        (
          await tx.all<{ instance_id: string; revision: number }>(
            "SELECT instance_id,revision FROM worker_sessions WHERE project_id=? AND status IN ('offered','active')",
            agent.projectId,
          )
        ).map((row) => `${row.instance_id}:${row.revision}`),
      );
      const available = (
        await this.workflows.dispatchCandidates(sourceCaller(agent.source), tx)
      ).filter(
        (item) =>
          item.role !== 'operator' && !busy.has(`${item.instanceId}:${item.expectedRevision}`),
      );
      return { ...(await this.agentStatus(agent, tx)), available };
    });
  }
  async assignAgent(token: string, input: AgentAssignment): Promise<Session> {
    const agent = await this.transaction(
      async (tx) => await this.directory.authenticate(token, tx),
    );
    // The connection credential stays fixed. Each execution has a distinct, undisclosed credential.
    const secret = `ms_${createHash('sha256')
      .update(canonical({ token, requestId: input.requestId }))
      .digest('base64url')}`;
    // An agent's request ids are its own: the replay key is per runner, so they carry the agent.
    return await this.offer(sourceCaller(agent.source), {
      ...input,
      requestId: `${agent.id}:${input.requestId}`,
      agentId: agent.id,
      runnerId: agent.runnerId,
      secret,
    });
  }
  async releaseAgentAssignment(token: string, executionId: string): Promise<Session> {
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
  /** Read inside the status transaction: one payload is one consistent snapshot. */
  private async agentSummaries(caller: Caller, sql: Transaction) {
    await this.scope.require(caller, 'read', sql);
    return (
      await sql.all<{
        agent_json: string;
        execution_id: string | null;
        execution_label: string;
        execution_role: Session['role'];
      }>(
        sql.dialect === 'postgres'
          ? `SELECT a.agent_json, w.id AS execution_id, (w.session_json::jsonb #>> '{assignment,label}') AS execution_label, (w.session_json::jsonb #>> '{role}') AS execution_role FROM agents a LEFT JOIN worker_sessions w ON w.actor_id=a.actor_id AND w.status IN ('offered','active') WHERE a.project_id=? ORDER BY (a.agent_json::jsonb #>> '{createdAt}') DESC,a._merv_rowid DESC`
          : `SELECT a.agent_json, w.id AS execution_id, json_extract(w.session_json,'$.assignment.label') AS execution_label, json_extract(w.session_json,'$.role') AS execution_role FROM agents a LEFT JOIN worker_sessions w ON w.actor_id=a.actor_id AND w.status IN ('offered','active') WHERE a.project_id=? ORDER BY json_extract(a.agent_json,'$.createdAt') DESC,a.rowid DESC`,
        caller.projectId,
      )
    ).map((row) => {
      const agent: Agent = JSON.parse(row.agent_json);
      return summarizeAgent(
        agent,
        row.execution_id,
        row.execution_id ? { label: row.execution_label, role: row.execution_role } : null,
      );
    });
  }
  async projectStatus(caller: Caller): Promise<SessionsProjectStatus> {
    this.ensureOpen();
    return await this.dispatcher.projectStatus(caller);
  }
  /** The rail's number on its own: no runner scan, no candidate enumeration, no blobs. */
  async liveSessionCount(caller: Caller): Promise<number> {
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
  async agentObservation(caller: Caller, agentId: string) {
    this.ensureOpen();
    check(text(agentId), 'invalid_agent', 'An agent identifier is required');
    return await this.observations.read(caller, agentId);
  }
  async setDispatch(caller: Caller, input: { enabled: boolean }): Promise<DispatchState> {
    this.ensureOpen();
    return await this.dispatcher.setDispatch(caller, input);
  }
  async halt(
    caller: Caller,
    input: { sessionId?: string; reason?: string } = {},
  ): Promise<{ halted: number }> {
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

  async workspaceObservation(
    caller: Caller,
    sessionId: string,
    transaction?: Transaction,
  ): Promise<SessionWorkspaceObservation> {
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
      const session: Session = JSON.parse(row.session_json);
      const workspace = await sql.get<{ attachment_json: string; result_json: string | null }>(
        'SELECT attachment_json,result_json FROM session_workspaces WHERE session_id=?',
        sessionId,
      );
      const event =
        workspace?.result_json === null || !workspace
          ? undefined
          : await sql.get<{ id: number; created_at: string }>(
              "SELECT id,created_at FROM events WHERE project_id=? AND subject_id=? AND type='session.workspace_result' ORDER BY id LIMIT 1",
              caller.projectId,
              sessionId,
            );
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
        workspace: workspace
          ? {
              attachment: JSON.parse(workspace.attachment_json),
              result: workspace.result_json === null ? null : JSON.parse(workspace.result_json),
            }
          : null,
        observedAt: event?.created_at ?? null,
        eventId: event?.id ?? null,
      };
    };
    return transaction ? await read(transaction) : await this.transaction(read);
  }
  async list(caller: Caller): Promise<Session[]> {
    return await this.transaction(async (tx) => {
      const owner = await this.owner(caller, tx);
      return await mapAsync(
        await tx.all<Row>(
          tx.dialect === 'postgres'
            ? 'SELECT * FROM worker_sessions WHERE owner_hash=? ORDER BY _merv_rowid'
            : 'SELECT * FROM worker_sessions WHERE owner_hash=? ORDER BY rowid',
          owner.hash,
        ),
        (row) => this.decode(row, tx),
      );
    });
  }
  async get(caller: Caller, sessionId: string): Promise<Session> {
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
    check(text(input.hostRef, 1024), 'invalid_host', 'A nonempty host reference is required');
    const workspace =
      input.workspace === undefined ? undefined : this.workspaceInput(input.workspace);
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
            data: {
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
            },
          });
        }
      }
      if (session.hostRef === null) {
        session.hostRef = input.hostRef;
        await this.save(tx, session);
      }
    });
  }
  private workspaceInput(input: unknown): SessionWorkspace {
    const parsed = sessionWorkspaceSchema.safeParse(input);
    check(parsed.success, 'invalid_workspace', 'Workspace metadata must match the closed schema');
    return parsed.data;
  }
  async workspaceResult(
    caller: Caller,
    input: SessionControl & { hostRef: string; workspace: SessionWorkspace },
  ): Promise<Session> {
    check(text(input.hostRef, 1024), 'invalid_host', 'A nonempty host reference is required');
    const workspace = this.workspaceInput(input.workspace);
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
        data: {
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
        },
      });
      return session;
    });
  }
  async heartbeat(caller: Caller, input: SessionControl): Promise<Session> {
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
      outcome?: 'completed' | 'host_failed' | 'launch_failed' | 'workspace_failed' | 'crash_loop';
    },
  ): Promise<Session> {
    check(
      input.outcome === undefined ||
        ['completed', 'host_failed', 'launch_failed', 'workspace_failed', 'crash_loop'].includes(
          input.outcome,
        ),
      'invalid_outcome',
      'Unknown session process outcome',
    );
    check(
      input.reason === undefined || text(input.reason, 200),
      'invalid_reason',
      'Release reason must be 1–200 characters',
    );
    return await this.transaction(
      async (tx) =>
        await this.closeSession(
          await this.controlled(caller, input.sessionId, input.runnerId, tx),
          input.reason ?? 'released',
          tx,
          'released',
          input.outcome,
        ),
    );
  }
  async authenticate(token: string): Promise<Caller> {
    check(
      typeof token === 'string' && tokenPattern.test(token),
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
        : await tx.get<Row>('SELECT * FROM worker_sessions WHERE token_hash=?', hashToken(token));
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
        session.status = 'active';
        session.activatedAt = this.time();
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
  async describe(caller: Caller): Promise<Session> {
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
    const prepared = await this.reading(
      async (tx) => await this.admit(caller, tool, clone(input), tx, undefined, read),
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
      await this.validate(invocation.caller, invocation.tool, state.input);
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
  private async sweepTransaction(tx: Transaction): Promise<void> {
    for (const row of await tx.all<Row>(
      tx.dialect === 'postgres'
        ? "SELECT * FROM worker_sessions WHERE status IN ('offered','active') ORDER BY _merv_rowid"
        : "SELECT * FROM worker_sessions WHERE status IN ('offered','active') ORDER BY rowid",
    ))
      await this.reconcile(await this.decode(row, tx), tx);
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
    check(
      config &&
        typeof config === 'object' &&
        Object.keys(config).every((key) => key === 'sweepIntervalMs'),
      'invalid_sessions_config',
      'Sessions only supports sweepIntervalMs configuration',
    );
    await ctx.effect(async function* () {
      const sessions = await createService(
        new LeasedSessions(ctx.state, ctx.scope, ctx.workflows, ctx.domainEvents, config),
      );
      yield async () => await sessions.close();
      yield ctx.provide('sessions', sessions);
    });
  },
};
export default sessionsPlugin;
