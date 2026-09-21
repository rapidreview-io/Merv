import { postgresMigrations } from './dispatch.postgres.js';
import { z } from 'zod';
import {
  recorded,
  replayed,
  clip,
  visible,
  canonical,
  mapAsync,
  MervError,
  check,
  digest,
  effectiveWorkspace,
  newId,
  type Caller,
  type Scope,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import type {
  AgentSummary,
  AutomaticLease,
  DispatchDecision,
  DispatchHold,
  DispatchState,
  RunnerHeartbeat,
  RunnerPlatform,
  RunnerPresence,
  RunnerSettings,
  Session,
  SessionOffer,
  SessionSummary,
  SessionBudgetInput,
  SessionsProjectStatus,
  BudgetStatus,
} from './types.js';
import { budgetStatuses, publicBudget } from './usage.js';

const label = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && !/[\0\r\n]/.test(value));
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/);
const harness = z.enum([
  'codex',
  'claude',
  'gemini',
  'cursor',
  'opencode',
  'copilot',
  'qwen',
  'hermes',
  'command',
]);
const tuning = {
  name,
  enabled: z.boolean(),
  model: label.optional(),
  effort: label.optional(),
  parallelism: z.number().int().min(1).max(32),
};
const platformSchema = z.object({ ...tuning, harness }).strict();
const platformsSchema = z
  .array(platformSchema)
  .max(32)
  .refine(
    (items) => new Set(items.map((item) => item.name)).size === items.length,
    'Platform names must be distinct',
  );
const settingsSchema = z
  .object({
    platforms: z
      .array(z.object(tuning).strict())
      .max(32)
      .refine((items) => new Set(items.map((item) => item.name)).size === items.length),
  })
  .strict();
const heartbeatSchema = z
  .object({
    runnerId: label,
    machine: z.object({ hostname: label, system: label, architecture: label }).strict(),
    platforms: platformsSchema,
    capacity: z.number().int().min(0).max(256),
    appliedVersion: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
const leaseSchema = z
  .object({
    runnerId: label,
    requestId: z.string().min(1).max(256),
    secret: z.string().regex(/^ms_[A-Za-z0-9_-]{43}$/),
    platform: z
      .object({ name, harness, model: label.optional(), effort: label.optional() })
      .strict(),
    hardDeadlineSeconds: z.number().int().min(300).max(604800).optional(),
  })
  .strict();
const budgetSchema = z
  .object({
    instanceId: z.string().min(1).max(200).optional(),
    maxWallMinutes: z.number().int().min(1).max(5_256_000).nullable().optional(),
    maxCostUsd: z.number().positive().max(1e6).nullable().optional(),
    maxTokens: z.number().int().min(1).max(1e13).nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.maxWallMinutes !== undefined ||
      input.maxCostUsd !== undefined ||
      input.maxTokens !== undefined,
  );
/** A bound is stored in the unit usage is summed in; a fraction of it still rounds to a positive bound. */
const scaled = (value: number | null, unit: number): number | null =>
  value === null ? null : Math.max(1, Math.round(value * unit));
const freshForMs = 45_000;
const backoffMs = 30_000;
/** The closes that count against a target: the process failed, or lived without progressing. */
export const failureReasons = new Set([
  'host_failed',
  'crash_loop',
  'workspace_failed',
  'launch_failed',
  'stalled',
]);
/**
 * Refusals that say who asked or what raced, never that the offer cannot be built. Counting
 * them would let a revoked key or a lost race hold a healthy target until an admin came.
 */
const transientOfferCodes = new Set([
  'dispatch_disabled',
  'runner_control_changed',
  'request_conflict',
  'revision_conflict',
  'session_conflict',
]);
const releaseHoldSchema = z
  .object({
    instanceId: z.string().min(1).max(200),
    expectedRevision: z.number().int().nonnegative().safe(),
    reason: z.string().min(1).max(500).refine(visible),
    requestId: z.string(),
  })
  .strict();
interface RunnerRow {
  id: string;
  project_id: string;
  owner_hash: string;
  runner_id: string;
  source_json: string;
  presence_json: string;
  desired_version: number;
  settings_json: string;
  last_seen_at: string;
  last_decision: DispatchDecision | null;
  last_decision_at: string | null;
  decision_since: string | null;
}
interface HoldRow {
  instance_id: string;
  revision: number;
  attempts: number;
  last_code: string;
  last_message: string;
  last_session_id: string | null;
  first_at: string;
  last_at: string;
  held_at: string | null;
}
interface Target {
  instanceId: string;
  expectedRevision: number;
}
const targetKey = (item: Target) => `${item.instanceId}:${item.expectedRevision}`;
const publicHold = (row: HoldRow): DispatchHold => ({
  instanceId: row.instance_id,
  revision: row.revision,
  attempts: row.attempts,
  lastCode: row.last_code,
  lastMessage: row.last_message,
  lastSessionId: row.last_session_id,
  firstAt: row.first_at,
  lastAt: row.last_at,
  heldAt: row.held_at,
});
interface ReceiptRow {
  fingerprint: string;
  session_id: string;
  platform_json: string;
  runner_ref: string;
}
interface SessionRow {
  id: string;
  session_json: string;
}
interface DispatchRow {
  enabled: number;
  updated_at: string;
  updated_by: string;
}
interface Hooks {
  prepare(caller: Caller): Promise<void>;
  offer(caller: Caller, input: SessionOffer, tx: Transaction): Promise<Session>;
  /** Close a live session; false when its record had already moved and the reconcile closed it. */
  close(session: Session, reason: string, tx: Transaction): Promise<boolean>;
  /** Read inside the status transaction, so agents and leases are one snapshot. */
  agents(caller: Caller, tx: Transaction): Promise<AgentSummary[]>;
}

/** Scheduling controls are metadata only; Sessions alone reserves and authenticates a selected step. */
/** An offer for one candidate that cannot be built; the queue moves past it. */
class PoisonedOffer extends Error {
  constructor(
    readonly candidate: Target,
    readonly cause: unknown,
  ) {
    super('Offer could not be built');
  }
}
export class SessionDispatch {
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
    private workflows: Workflows,
    private hooks: Hooks,
    private clock: () => number,
    private maxLaunchFailures: number,
  ) {
    this.initialize = async () => {
      await state.migrate('session_dispatch', [
        {
          version: 1,
          postgres: postgresMigrations[1],
          sql: `
      CREATE TABLE project_session_dispatch (
        project_id TEXT PRIMARY KEY REFERENCES projects(id), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
      );
      CREATE TABLE session_runners (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), owner_hash TEXT NOT NULL,
        runner_id TEXT NOT NULL, source_json TEXT NOT NULL, presence_json TEXT NOT NULL,
        desired_version INTEGER NOT NULL DEFAULT 0, settings_json TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        UNIQUE(owner_hash,runner_id)
      );
      CREATE TABLE session_dispatch_receipts (
        owner_hash TEXT NOT NULL, runner_id TEXT NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE REFERENCES worker_sessions(id),
        runner_ref TEXT NOT NULL REFERENCES session_runners(id), platform_json TEXT NOT NULL,
        PRIMARY KEY(owner_hash,runner_id,request_id)
      );
      CREATE TRIGGER session_dispatch_receipts_no_update BEFORE UPDATE ON session_dispatch_receipts
        BEGIN SELECT RAISE(ABORT,'Dispatch receipts are immutable'); END;
      CREATE TRIGGER session_dispatch_receipts_no_delete BEFORE DELETE ON session_dispatch_receipts
        BEGIN SELECT RAISE(ABORT,'Dispatch receipts are retained'); END;
      CREATE TRIGGER session_runners_identity BEFORE UPDATE ON session_runners
        WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.owner_hash IS NOT OLD.owner_hash OR
          NEW.runner_id IS NOT OLD.runner_id OR NEW.source_json IS NOT OLD.source_json
        BEGIN SELECT RAISE(ABORT,'Runner delegation is immutable'); END;
    `,
        },
        {
          // The last decision, not a log: one row per runner, so storage is constant.
          version: 2,
          postgres: postgresMigrations[2],
          sql: `
      ALTER TABLE session_runners ADD COLUMN last_decision TEXT;
      ALTER TABLE session_runners ADD COLUMN last_decision_at TEXT;
    `,
        },
        {
          // Configuration an admin changes, like the dispatch switch, so nothing guards it;
          // its history is the session.budget_changed events. The project's own id as the
          // scope is the project budget; any other scope is a workflow instance.
          version: 3,
          postgres: postgresMigrations[3],
          sql: `
      CREATE TABLE session_budgets (
        project_id TEXT NOT NULL REFERENCES projects(id), scope_id TEXT NOT NULL,
        max_wall_ms INTEGER CHECK(max_wall_ms IS NULL OR max_wall_ms > 0),
        max_cost_micros INTEGER CHECK(max_cost_micros IS NULL OR max_cost_micros > 0),
        max_tokens INTEGER CHECK(max_tokens IS NULL OR max_tokens > 0),
        updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
        PRIMARY KEY(project_id, scope_id)
      );
    `,
        },
        {
          // What keeps a candidate from running, kept where dispatch decides: one counter row
          // per target, so storage is bounded by failed targets, never by attempts. The row is
          // a mutable counter, not a record; its history is the session.dispatch_held and
          // session.hold_released events.
          version: 4,
          postgres: postgresMigrations[4],
          sql: `
      ALTER TABLE session_runners ADD COLUMN decision_since TEXT;
      CREATE TABLE session_dispatch_holds (
        project_id TEXT NOT NULL REFERENCES projects(id), instance_id TEXT NOT NULL, revision INTEGER NOT NULL,
        attempts INTEGER NOT NULL CHECK(attempts>=0), last_code TEXT NOT NULL, last_message TEXT NOT NULL,
        last_session_id TEXT REFERENCES worker_sessions(id), first_at TEXT NOT NULL, last_at TEXT NOT NULL,
        held_at TEXT,
        PRIMARY KEY(project_id,instance_id,revision)
      );
      CREATE INDEX session_dispatch_holds_held ON session_dispatch_holds(project_id) WHERE held_at IS NOT NULL;
      CREATE TABLE session_hold_requests (
        project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
        input_hash TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(project_id,actor_id,request_id)
      );
    `,
        },
      ]);
    };
  }
  private time(): string {
    return new Date(this.clock()).toISOString();
  }
  private async ordinary(caller: Caller, permission: 'read' | 'admin', tx: Transaction) {
    check(
      !caller.session,
      'forbidden',
      'Leased workers cannot read or control project dispatch',
      403,
    );
    return await this.scope.require(caller, permission, tx);
  }
  private async owner(caller: Caller, tx: Transaction) {
    const source = await this.scope.delegationSource(caller, tx);
    return { source, hash: digest(source) };
  }
  private async dispatch(projectId: string, tx: Transaction): Promise<DispatchState> {
    const row = await tx.get<DispatchRow>(
      'SELECT * FROM project_session_dispatch WHERE project_id=?',
      projectId,
    );
    return row
      ? { enabled: !!row.enabled, updatedAt: row.updated_at, updatedBy: row.updated_by }
      : { enabled: false, updatedAt: null, updatedBy: null };
  }
  private async set(caller: Caller, enabled: boolean, tx: Transaction): Promise<DispatchState> {
    const old = await this.dispatch(caller.projectId, tx);
    if (old.enabled === enabled) return old;
    const time = this.time();
    await tx.run(
      'INSERT INTO project_session_dispatch(project_id,enabled,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
      caller.projectId,
      enabled ? 1 : 0,
      time,
      caller.actorId,
    );
    // Switching dispatch off and on is the human go-ahead for the whole project: every
    // count starts afresh, where session.release_hold restarts one target.
    await tx.run(
      'UPDATE session_dispatch_holds SET attempts=0,held_at=NULL WHERE project_id=?',
      caller.projectId,
    );
    await recorded(this.state, tx, caller, 'session.dispatch_changed', caller.projectId, {
      enabled,
    });
    return { enabled, updatedAt: time, updatedBy: caller.actorId };
  }
  async setDispatch(caller: Caller, input: { enabled: boolean }): Promise<DispatchState> {
    caller = structuredClone(caller);
    check(
      input && typeof input.enabled === 'boolean' && Object.keys(input).length === 1,
      'invalid_dispatch',
      'Dispatch accepts only enabled',
    );
    input = { ...input };
    return await this.state.transaction(async (tx) => {
      await this.ordinary(caller, 'admin', tx);
      return await this.set(caller, input.enabled, tx);
    });
  }
  private async budgets(caller: Caller, tx: Transaction, only?: string[]) {
    return await budgetStatuses(
      tx,
      caller.projectId,
      async (instanceId) => await this.workflows.dependencyClosure(caller, instanceId, tx),
      only,
    );
  }
  /**
   * A state-set command like the dispatch switch: it is idempotent by value, not by a
   * request id, so setting what is already set records nothing and answers the same.
   */
  async setBudget(caller: Caller, input: SessionBudgetInput): Promise<BudgetStatus> {
    caller = structuredClone(caller);
    const parsed = budgetSchema.safeParse(input);
    check(
      parsed.success,
      'invalid_budget',
      'A budget names at least one of maxWallMinutes, maxCostUsd and maxTokens, each a positive bound or null',
    );
    const { instanceId, maxWallMinutes, maxCostUsd, maxTokens } = parsed.data;
    return await this.state.transaction(async (tx) => {
      await this.ordinary(caller, 'admin', tx);
      if (instanceId !== undefined) await this.workflows.get(caller, instanceId, tx);
      const scopeId = instanceId ?? caller.projectId;
      const old = await tx.get<{
        max_wall_ms: number | null;
        max_cost_micros: number | null;
        max_tokens: number | null;
      }>(
        'SELECT max_wall_ms,max_cost_micros,max_tokens FROM session_budgets WHERE project_id=? AND scope_id=?',
        caller.projectId,
        scopeId,
      );
      const next = {
        maxWallMs:
          maxWallMinutes === undefined
            ? (old?.max_wall_ms ?? null)
            : scaled(maxWallMinutes, 60_000),
        maxCostMicros:
          maxCostUsd === undefined ? (old?.max_cost_micros ?? null) : scaled(maxCostUsd, 1e6),
        maxTokens: maxTokens === undefined ? (old?.max_tokens ?? null) : maxTokens,
      };
      check(
        old || Object.values(next).some((value) => value !== null),
        'budget_not_found',
        'There is no budget here to clear',
        404,
      );
      if (
        !old ||
        Number(old.max_wall_ms ?? -1) !== (next.maxWallMs ?? -1) ||
        Number(old.max_cost_micros ?? -1) !== (next.maxCostMicros ?? -1) ||
        Number(old.max_tokens ?? -1) !== (next.maxTokens ?? -1)
      ) {
        await tx.run(
          'INSERT INTO session_budgets(project_id,scope_id,max_wall_ms,max_cost_micros,max_tokens,updated_at,updated_by) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,scope_id) DO UPDATE SET max_wall_ms=excluded.max_wall_ms,max_cost_micros=excluded.max_cost_micros,max_tokens=excluded.max_tokens,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
          caller.projectId,
          scopeId,
          next.maxWallMs,
          next.maxCostMicros,
          next.maxTokens,
          this.time(),
          caller.actorId,
        );
        await recorded(this.state, tx, caller, 'session.budget_changed', scopeId, {
          scopeId,
          ...next,
        });
      }
      return publicBudget((await this.budgets(caller, tx, [scopeId]))[0]!);
    });
  }
  /** Budgets a usage read shows: the project's, and the one on the instance it asked about. */
  async budgetsFor(caller: Caller, tx: Transaction, instanceId?: string): Promise<BudgetStatus[]> {
    return (
      await this.budgets(caller, tx, [caller.projectId, ...(instanceId ? [instanceId] : [])])
    ).map(publicBudget);
  }
  async halt(
    caller: Caller,
    input: { sessionId?: string; reason?: string } = {},
  ): Promise<{ halted: number }> {
    caller = structuredClone(caller);
    const parsed = z
      .object({ sessionId: label.optional(), reason: label.optional() })
      .strict()
      .safeParse(input);
    check(parsed.success, 'invalid_halt', 'Halt accepts an optional session and bounded reason');
    input = parsed.data;
    return await this.state.transaction(async (tx) => {
      await this.ordinary(caller, 'admin', tx);
      if (!input.sessionId) await this.set(caller, false, tx);
      const rows = input.sessionId
        ? await tx.all<SessionRow>(
            'SELECT id,session_json FROM worker_sessions WHERE project_id=? AND id=?',
            caller.projectId,
            input.sessionId,
          )
        : await tx.all<SessionRow>(
            "SELECT id,session_json FROM worker_sessions WHERE project_id=? AND status IN ('offered','active')",
            caller.projectId,
          );
      if (input.sessionId)
        check(rows.length, 'session_not_found', 'Session not found in this project', 404);
      let halted = 0;
      for (const row of rows) {
        const session: Session = JSON.parse(row.session_json);
        if (session.status !== 'offered' && session.status !== 'active') continue;
        if (!(await this.hooks.close(session, input.reason ?? 'operator_halt', tx))) continue;
        halted++;
        await recorded(this.state, tx, caller, 'session.halted', session.id, {
          sessionId: session.id,
          reason: input.reason ?? 'operator_halt',
        });
      }
      return { halted };
    });
  }
  private async presence(row: RunnerRow, tx: Transaction): Promise<RunnerPresence> {
    let authorized = true;
    try {
      await this.scope.requireDelegation(JSON.parse(row.source_json), 'read', tx);
    } catch (error) {
      if (error instanceof MervError && (error.status === 401 || error.status === 403))
        authorized = false;
      else throw error;
    }
    return {
      ...JSON.parse(row.presence_json),
      id: row.id,
      lastSeenAt: row.last_seen_at,
      live: authorized && Date.parse(row.last_seen_at) + freshForMs > this.clock(),
      desiredVersion: row.desired_version,
      desiredSettings: JSON.parse(row.settings_json),
      lastDecision: row.last_decision ?? null,
      lastDecisionAt: row.last_decision_at ?? null,
      decisionSince: row.decision_since ?? null,
    };
  }
  /**
   * The answer this runner's last lease request received, kept where the runner is. A
   * repeated answer keeps the moment it was first given, so a refusal says how long it has
   * held. One statement: every right-hand side reads the row as it was.
   */
  private async decided(
    ownerHash: string,
    runnerId: string,
    decision: DispatchDecision,
    tx: Transaction,
  ): Promise<void> {
    const time = this.time();
    await tx.run(
      'UPDATE session_runners SET decision_since=CASE WHEN last_decision=? THEN decision_since ELSE ? END,last_decision=?,last_decision_at=? WHERE owner_hash=? AND runner_id=?',
      decision,
      time,
      decision,
      time,
      ownerHash,
      runnerId,
    );
  }
  /**
   * One more failed attempt on a target. Answers the hold only when this attempt is the one
   * that reached the cap, so its event is recorded once.
   */
  private async attempt(
    projectId: string,
    target: Target,
    failure: { code: string; message: string; sessionId: string | null },
    tx: Transaction,
  ): Promise<DispatchHold | undefined> {
    const where = 'project_id=? AND instance_id=? AND revision=?';
    const old = await tx.get<HoldRow>(
      `SELECT * FROM session_dispatch_holds WHERE ${where}`,
      projectId,
      target.instanceId,
      target.expectedRevision,
    );
    const time = this.time();
    await tx.run(
      'INSERT INTO session_dispatch_holds(project_id,instance_id,revision,attempts,last_code,last_message,last_session_id,first_at,last_at,held_at) VALUES(?,?,?,1,?,?,?,?,?,?) ON CONFLICT(project_id,instance_id,revision) DO UPDATE SET attempts=session_dispatch_holds.attempts+1,last_code=excluded.last_code,last_message=excluded.last_message,last_session_id=excluded.last_session_id,last_at=excluded.last_at,held_at=COALESCE(session_dispatch_holds.held_at,excluded.held_at)',
      projectId,
      target.instanceId,
      target.expectedRevision,
      failure.code,
      clip(failure.message, 500),
      failure.sessionId,
      time,
      time,
      (old?.attempts ?? 0) + 1 >= this.maxLaunchFailures ? time : null,
    );
    const row = (await tx.get<HoldRow>(
      `SELECT * FROM session_dispatch_holds WHERE ${where}`,
      projectId,
      target.instanceId,
      target.expectedRevision,
    ))!;
    return row.held_at && !old?.held_at ? publicHold(row) : undefined;
  }
  private heldData(hold: DispatchHold) {
    return {
      instanceId: hold.instanceId,
      revision: hold.revision,
      attempts: hold.attempts,
      lastCode: hold.lastCode,
      lastMessage: hold.lastMessage,
    };
  }
  /**
   * A session closed as a failure, counted in the transaction that closed it. It runs from
   * the sweep as well as from a caller, so the event is the system's, as session.closed is.
   * A session a human offered by hand counts too, although a hold only gates automatic offers.
   */
  async failed(session: Session, code: string, tx: Transaction): Promise<void> {
    const held = await this.attempt(
      session.projectId,
      session,
      { code, message: session.closeReason ?? code, sessionId: session.id },
      tx,
    );
    if (held)
      await this.state.appendEvent(tx, {
        projectId: session.projectId,
        actorId: 'system:sessions',
        type: 'session.dispatch_held',
        subjectId: session.instanceId,
        data: this.heldData(held),
      });
  }
  /**
   * An offer that could not be built rolled its own transaction back, so it is counted here
   * in a second one; a crash between the two loses one count, which only ever errs towards
   * trying again. A failure to record must not stop the queue, so a refusal is swallowed.
   */
  private async poisoned(caller: Caller, target: Target, cause: unknown): Promise<void> {
    const status = (cause as { status?: number })?.status;
    const failure =
      cause instanceof MervError
        ? { code: cause.code, message: cause.message }
        : { code: 'offer_failed', message: cause instanceof Error ? cause.message : String(cause) };
    if (status === 401 || status === 403 || transientOfferCodes.has(failure.code)) return;
    try {
      await this.state.transaction(async (tx) => {
        const owner = await this.owner(caller, tx);
        await this.scope.requireDelegation(owner.source, 'read', tx);
        const held = await this.attempt(
          caller.projectId,
          target,
          { code: failure.code, message: failure.message, sessionId: null },
          tx,
        );
        if (held)
          await recorded(
            this.state,
            tx,
            caller,
            'session.dispatch_held',
            target.instanceId,
            this.heldData(held),
          );
      });
    } catch (error) {
      if (!(error instanceof MervError) || error.status >= 500) throw error;
    }
  }
  /**
   * The human go-ahead for one held target, after its cause is fixed. The other decision,
   * not to run the work, is the record's own: ending or revising it moves the revision, and
   * a hold names one revision.
   */
  async releaseHold(
    caller: Caller,
    input: { instanceId: string; expectedRevision: number; reason: string; requestId: string },
  ): Promise<DispatchHold> {
    caller = structuredClone(caller);
    const parsed = releaseHoldSchema.safeParse(input);
    check(
      parsed.success,
      'invalid_release_hold',
      'Releasing a hold names instanceId, expectedRevision, a visible reason of at most 500 characters and a requestId',
    );
    input = parsed.data;
    return await this.state.transaction(async (tx) => {
      await this.ordinary(caller, 'admin', tx);
      return await replayed(
        tx,
        'session_hold_requests',
        caller,
        'session.release_hold',
        input,
        async () => {
          const row = await tx.get<HoldRow>(
            'SELECT * FROM session_dispatch_holds WHERE project_id=? AND instance_id=? AND revision=?',
            caller.projectId,
            input.instanceId,
            input.expectedRevision,
          );
          check(row, 'hold_not_found', 'No failed dispatch is counted against this target', 404);
          check(
            row.held_at,
            'hold_not_held',
            'This target is still being retried; it is not held',
            409,
          );
          await tx.run(
            'UPDATE session_dispatch_holds SET attempts=0,held_at=NULL WHERE project_id=? AND instance_id=? AND revision=?',
            caller.projectId,
            input.instanceId,
            input.expectedRevision,
          );
          await recorded(this.state, tx, caller, 'session.hold_released', input.instanceId, {
            instanceId: row.instance_id,
            revision: row.revision,
            attempts: row.attempts,
            lastCode: row.last_code,
            reason: input.reason,
          });
          // Built from the row as it was, so the replayed answer never depends on a later read.
          return { ...publicHold(row), attempts: 0, heldAt: null };
        },
      );
    });
  }
  async heartbeatRunner(caller: Caller, input: RunnerHeartbeat): Promise<RunnerPresence> {
    caller = structuredClone(caller);
    const parsed = heartbeatSchema.safeParse(input);
    check(
      parsed.success,
      'invalid_runner',
      'Runner heartbeat must use the closed machine, platform and capacity schema',
    );
    input = parsed.data;
    return await this.state.transaction(async (tx) => {
      // A runner is a durable presence that will take work: registering one is a write.
      await this.scope.require(caller, 'write', tx);
      const owner = await this.owner(caller, tx);
      const old = await tx.get<RunnerRow>(
        'SELECT * FROM session_runners WHERE owner_hash=? AND runner_id=?',
        owner.hash,
        input.runnerId,
      );
      check(
        (input.appliedVersion ?? 0) <= (old?.desired_version ?? 0),
        'invalid_settings_version',
        'Runner cannot acknowledge unpublished settings',
      );
      const id = old?.id ?? newId('runner'),
        time = this.time();
      if (old)
        await tx.run(
          'UPDATE session_runners SET presence_json=?,last_seen_at=? WHERE id=?',
          JSON.stringify(input),
          time,
          id,
        );
      else {
        check(
          (await tx.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM session_runners WHERE project_id=?',
            caller.projectId,
          ))!.n < 1000,
          'runner_limit',
          'Project runner limit reached',
          409,
        );
        await tx.run(
          'INSERT INTO session_runners(id,project_id,owner_hash,runner_id,source_json,presence_json,settings_json,last_seen_at) VALUES(?,?,?,?,?,?,?,?)',
          id,
          caller.projectId,
          owner.hash,
          input.runnerId,
          JSON.stringify(owner.source),
          JSON.stringify(input),
          JSON.stringify({ platforms: [] }),
          time,
        );
        await recorded(this.state, tx, caller, 'session.runner_registered', id, { runnerRef: id });
      }
      return await this.presence(
        (await tx.get<RunnerRow>('SELECT * FROM session_runners WHERE id=?', id))!,
        tx,
      );
    });
  }
  async setRunnerSettings(
    caller: Caller,
    input: { runnerId: string; settings: RunnerSettings },
  ): Promise<RunnerPresence> {
    caller = structuredClone(caller);
    const parsed = z
      .object({ runnerId: label, settings: settingsSchema })
      .strict()
      .safeParse(input);
    check(
      parsed.success,
      'invalid_runner_settings',
      'Runner settings accept only named platform tuning',
    );
    input = parsed.data;
    return await this.state.transaction(async (tx) => {
      await this.ordinary(caller, 'admin', tx);
      const row = await tx.get<RunnerRow>(
        'SELECT * FROM session_runners WHERE id=? AND project_id=?',
        input.runnerId,
        caller.projectId,
      );
      check(row, 'runner_not_found', 'Runner not found in this project', 404);
      const platforms = (JSON.parse(row.presence_json) as RunnerHeartbeat).platforms;
      check(
        input.settings.platforms.every((item) =>
          platforms.some((platform) => platform.name === item.name),
        ),
        'unknown_platform',
        'Runner settings may tune only an advertised platform',
      );
      if (canonical(JSON.parse(row.settings_json)) !== canonical(input.settings)) {
        await tx.run(
          'UPDATE session_runners SET settings_json=?,desired_version=desired_version+1 WHERE id=?',
          JSON.stringify(input.settings),
          row.id,
        );
        await recorded(this.state, tx, caller, 'session.runner_settings_changed', row.id, {
          runnerRef: row.id,
          desiredVersion: row.desired_version + 1,
        });
      }
      return await this.presence(
        (await tx.get<RunnerRow>('SELECT * FROM session_runners WHERE id=?', row.id))!,
        tx,
      );
    });
  }
  private async candidates(caller: Caller, tx: Transaction) {
    const live = new Set(
      (
        await tx.all<{ instance_id: string; revision: number }>(
          "SELECT instance_id,revision FROM worker_sessions WHERE project_id=? AND status IN ('offered','active')",
          caller.projectId,
        )
      ).map((row) => `${row.instance_id}:${row.revision}`),
    );
    const queue = (await this.workflows.dispatchCandidates(caller, tx)).filter(
      (item) =>
        item.role !== 'operator' && !live.has(`${item.instanceId}:${item.expectedRevision}`),
    );
    // A target that keeps failing on one revision is not retried for ever: the backoff only
    // spaces the attempts, so the hold is what ends them. An expiry after activation never
    // counts, because that is also how long honest work ends. A hold names one revision, so a
    // record that moves simply stops matching it.
    const holds = await tx.all<HoldRow>(
      'SELECT * FROM session_dispatch_holds WHERE project_id=? AND (held_at IS NOT NULL OR last_at>?)',
      caller.projectId,
      new Date(this.clock() - backoffMs).toISOString(),
    );
    const held = (row: HoldRow) => `${row.instance_id}:${row.revision}`;
    const exhausted = new Set(holds.filter((row) => row.held_at).map(held));
    // A failed session backs off per runner and platform, from its own closed row. An offer
    // that could not be built left no session, so its backoff is read from the hold.
    const backoff = new Set(
      holds.filter((row) => !row.held_at && row.last_session_id === null).map(held),
    );
    const budgets = await this.budgets(caller, tx);
    const spent = new Set(
      budgets.flatMap((budget) => (budget.exceeded.length ? (budget.instanceIds ?? []) : [])),
    );
    const retry = queue.filter((item) => exhausted.has(targetKey(item)));
    const overBudget = queue.filter(
      (item) => !exhausted.has(targetKey(item)) && spent.has(item.instanceId),
    );
    return {
      queue: queue.filter((item) => !exhausted.has(targetKey(item)) && !spent.has(item.instanceId)),
      backoff,
      retriesExhausted: retry.length,
      overBudget: overBudget.length,
      budgets,
    };
  }
  async projectStatus(caller: Caller): Promise<SessionsProjectStatus> {
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      const actor = await this.ordinary(caller, 'read', tx);
      const runners = await mapAsync(
        await tx.all<RunnerRow>(
          'SELECT * FROM session_runners WHERE project_id=? ORDER BY last_seen_at DESC,id LIMIT 100',
          caller.projectId,
        ),
        (row) => this.presence(row, tx),
      );
      const sessions: SessionSummary[] = (
        await tx.all<
          SessionRow & {
            runner_ref: string | null;
            platform_json: string | null;
            attachment_json: string | null;
            result_json: string | null;
          }
        >(
          tx.dialect === 'postgres'
            ? "SELECT s.id,s.session_json,d.runner_ref,d.platform_json,w.attachment_json,w.result_json FROM worker_sessions s LEFT JOIN session_dispatch_receipts d ON d.session_id=s.id LEFT JOIN session_workspaces w ON w.session_id=s.id WHERE s.project_id=? ORDER BY CASE WHEN s.status IN ('offered','active') THEN 0 ELSE 1 END,s._merv_rowid DESC LIMIT 200"
            : "SELECT s.id,s.session_json,d.runner_ref,d.platform_json,w.attachment_json,w.result_json FROM worker_sessions s LEFT JOIN session_dispatch_receipts d ON d.session_id=s.id LEFT JOIN session_workspaces w ON w.session_id=s.id WHERE s.project_id=? ORDER BY CASE WHEN s.status IN ('offered','active') THEN 0 ELSE 1 END,s.rowid DESC LIMIT 200",
          caller.projectId,
        )
      ).map((row) => {
        const session: Session = JSON.parse(row.session_json);
        return {
          id: session.id,
          agentId: session.agentId,
          agentSessionId: session.agentSessionId,
          actorId: session.actorId,
          instanceId: session.instanceId,
          expectedRevision: session.expectedRevision,
          role: session.role,
          status: session.status,
          label: session.assignment.label,
          runnerRef: row.runner_ref,
          hostRef: session.hostRef,
          platform: row.platform_json ? JSON.parse(row.platform_json) : null,
          createdAt: session.createdAt,
          activatedAt: session.activatedAt,
          expiresAt: session.expiresAt,
          closedAt: session.closedAt,
          closeReason: session.closeReason,
          outcome: session.outcome ?? null,
          workspaceMode: effectiveWorkspace(session.execution.policy).mode,
          ...(row.attachment_json === null
            ? {}
            : {
                workspace: {
                  attachment: JSON.parse(row.attachment_json),
                  result: row.result_json === null ? null : JSON.parse(row.result_json),
                },
              }),
        };
      });
      const counts = (await tx.get<{ live: number; total: number }>(
        "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status IN ('offered','active') THEN 1 ELSE 0 END),0) AS live FROM worker_sessions WHERE project_id=?",
        caller.projectId,
      ))!;
      const runnerTotal = (await tx.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM session_runners WHERE project_id=?',
        caller.projectId,
      ))!.n;
      const { queue, retriesExhausted, budgets } = await this.candidates(caller, tx);
      return {
        // One transaction, one moment: agents cannot report a lease the leases do not.
        agents: await this.hooks.agents(caller, tx),
        observedAt: this.time(),
        liveSessionCount: counts.live,
        sessionTotal: counts.total,
        runnerTotal,
        canManage: actor.role === 'operator',
        dispatch: await this.dispatch(caller.projectId, tx),
        runners,
        sessions,
        queue: queue.slice(0, 200),
        queueTotal: queue.length,
        budgets: budgets.map(publicBudget),
        retriesExhausted,
      };
    });
  }
  private async admitRunner(
    ownerHash: string,
    input: AutomaticLease,
    tx: Transaction,
    excludeSessionId?: string,
  ): Promise<
    | { ok: true; runner: RunnerRow; platform: RunnerPlatform }
    | { ok: false; reason: DispatchDecision }
  > {
    const runner = await tx.get<RunnerRow>(
      'SELECT * FROM session_runners WHERE owner_hash=? AND runner_id=?',
      ownerHash,
      input.runnerId,
    );
    check(
      runner,
      'runner_required',
      'Register this authenticated runner before automatic leasing',
      409,
    );
    const presence = await this.presence(runner, tx);
    if (!presence.live) return { ok: false, reason: 'runner_offline' };
    const platform = presence.platforms.find((item) => item.name === input.platform.name);
    check(
      platform &&
        platform.harness === input.platform.harness &&
        platform.model === input.platform.model &&
        platform.effort === input.platform.effort,
      'platform_mismatch',
      'Lease platform must match the runner presence',
      409,
    );
    const desired = presence.desiredSettings.platforms.find((item) => item.name === platform.name);
    if (
      !platform.enabled ||
      desired?.enabled === false ||
      (presence.desiredVersion > 0 && !desired)
    )
      return { ok: false, reason: 'platform_disabled' };
    if (presence.desiredVersion > (presence.appliedVersion ?? 0))
      return { ok: false, reason: 'settings_pending' };
    if (desired)
      check(
        input.platform.model === desired.model && input.platform.effort === desired.effort,
        'settings_mismatch',
        'Lease platform must match server-owned desired tuning',
        409,
      );
    const jobs = await tx.all<{ platform_json: string | null }>(
      "SELECT d.platform_json FROM worker_sessions s LEFT JOIN session_dispatch_receipts d ON d.session_id=s.id WHERE s.owner_hash=? AND s.runner_id=? AND s.status IN ('offered','active') AND (CAST(? AS TEXT) IS NULL OR s.id<>?)",
      ownerHash,
      input.runnerId,
      excludeSessionId ?? null,
      excludeSessionId ?? null,
    );
    if (
      jobs.length >= presence.capacity ||
      jobs.filter(
        (item) => item.platform_json && JSON.parse(item.platform_json).name === platform.name,
      ).length >= Math.min(platform.parallelism, desired?.parallelism ?? 32)
    )
      return { ok: false, reason: 'capacity_full' };
    return { ok: true, runner, platform };
  }
  async lease(
    caller: Caller,
    input: AutomaticLease,
  ): Promise<{ session: Session | null; reason: string }> {
    caller = structuredClone(caller);
    const parsed = leaseSchema.safeParse(input);
    check(
      parsed.success,
      'invalid_dispatch_lease',
      parsed.success
        ? ''
        : `Automatic lease input: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
    );
    input = parsed.data;
    await this.hooks.prepare(caller);
    // A candidate whose offer cannot be built (a context past its recipe's budget) must
    // not stop the queue behind it: its failure rolls the attempt back, the next
    // candidate is tried, and the failure is what the runner sees only when nothing
    // else is leasable.
    const skipped = new Set<string>();
    let poison: unknown;
    for (;;) {
      try {
        const result = await this.leaseOnce(caller, input, skipped);
        if (!result.session && poison !== undefined) throw poison;
        return result;
      } catch (error) {
        if (!(error instanceof PoisonedOffer)) throw error;
        skipped.add(targetKey(error.candidate));
        poison = error.cause;
        await this.poisoned(caller, error.candidate, error.cause);
      }
    }
  }
  private async leaseOnce(
    caller: Caller,
    input: AutomaticLease,
    skipped: Set<string>,
  ): Promise<{ session: Session | null; reason: string }> {
    return await this.state.transaction(async (tx) => {
      const owner = await this.owner(caller, tx);
      const fingerprint = digest({
        ...input,
        hardDeadlineSeconds: input.hardDeadlineSeconds ?? 86400,
      });
      const old = await tx.get<ReceiptRow>(
        'SELECT * FROM session_dispatch_receipts WHERE owner_hash=? AND runner_id=? AND request_id=?',
        owner.hash,
        input.runnerId,
        input.requestId,
      );
      // Every ending of this request is recorded against the runner that asked, so a
      // queue that never drains names its cause instead of leaving none anywhere.
      const decided = async (decision: DispatchDecision) => {
        await this.decided(owner.hash, input.runnerId, decision, tx);
        return decision;
      };
      if (old) {
        check(
          old.fingerprint === fingerprint,
          'request_conflict',
          'Automatic dispatch request already used with different input',
          409,
        );
        return {
          session: JSON.parse(
            (await tx.get<SessionRow>(
              'SELECT session_json FROM worker_sessions WHERE id=?',
              old.session_id,
            ))!.session_json,
          ),
          reason: await decided('replayed'),
        };
      }
      check(
        !(await tx.get(
          'SELECT id FROM worker_sessions WHERE owner_hash=? AND runner_id=? AND request_id=?',
          owner.hash,
          input.runnerId,
          input.requestId,
        )),
        'request_conflict',
        'Request id belongs to an explicit session offer',
        409,
      );
      if (!(await this.dispatch(caller.projectId, tx)).enabled)
        return { session: null, reason: await decided('dispatch_disabled') };
      const admission = await this.admitRunner(owner.hash, input, tx);
      if (!admission.ok) return { session: null, reason: await decided(admission.reason) };
      const { runner, platform } = admission;
      const failures = (
        await tx.all<SessionRow>(
          tx.dialect === 'postgres'
            ? "SELECT s.session_json FROM worker_sessions s JOIN session_dispatch_receipts d ON d.session_id=s.id WHERE s.owner_hash=? AND s.runner_id=? AND d.platform_json IS NOT NULL AND (d.platform_json::jsonb #>> '{name}')=? AND s.status IN ('released','expired')"
            : "SELECT s.session_json FROM worker_sessions s JOIN session_dispatch_receipts d ON d.session_id=s.id WHERE s.owner_hash=? AND s.runner_id=? AND d.platform_json IS NOT NULL AND json_extract(d.platform_json,'$.name')=? AND s.status IN ('released','expired')",
          owner.hash,
          input.runnerId,
          platform.name,
        )
      ).map((row) => JSON.parse(row.session_json) as Session);
      const admissible = await this.candidates(caller, tx);
      // A budget only stops new automatic offers. What is running keeps running, and a human
      // may still begin work by hand; raising or clearing the budget resumes this on the next poll.
      if (
        admissible.budgets.some((budget) => budget.kind === 'project' && budget.exceeded.length > 0)
      )
        return { session: null, reason: await decided('budget_exceeded') };
      const candidates = admissible.queue.filter((item) => !skipped.has(targetKey(item)));
      const candidate = candidates.find(
        (item) =>
          !admissible.backoff.has(targetKey(item)) &&
          !failures.some(
            (session) =>
              session.instanceId === item.instanceId &&
              session.expectedRevision === item.expectedRevision &&
              failureReasons.has(session.outcome ?? '') &&
              session.closedAt &&
              Date.parse(session.closedAt) + backoffMs > this.clock(),
          ),
      );
      if (!candidate)
        return {
          session: null,
          // Work that will be tried again outranks work that is withheld: the withheld
          // causes are named only when they are all that is left of the queue.
          reason: await decided(
            candidates.length
              ? 'retry_backoff'
              : admissible.overBudget
                ? 'budget_exceeded'
                : admissible.retriesExhausted
                  ? 'retries_exhausted'
                  : 'no_candidates',
          ),
        };
      // Admission callbacks cannot disable dispatch or change source permission and
      // then still create an automatic lease within this transaction.
      await this.scope.requireDelegation(owner.source, 'read', tx);
      check(
        (await this.dispatch(caller.projectId, tx)).enabled,
        'dispatch_disabled',
        'Automatic dispatch was disabled before the offer',
        409,
      );
      const beforeOffer = await this.admitRunner(owner.hash, input, tx);
      check(
        beforeOffer.ok,
        'runner_control_changed',
        'Runner controls changed before the offer',
        409,
      );
      const session = await this.hooks
        .offer(
          caller,
          {
            instanceId: candidate.instanceId,
            expectedRevision: candidate.expectedRevision,
            runnerId: input.runnerId,
            requestId: input.requestId,
            secret: input.secret,
            hardDeadlineSeconds: input.hardDeadlineSeconds,
          },
          tx,
        )
        .catch((error: unknown) => {
          const status = (error as { status?: number })?.status ?? 500;
          if (status >= 500) throw error;
          throw new PoisonedOffer(
            { instanceId: candidate.instanceId, expectedRevision: candidate.expectedRevision },
            error,
          );
        });
      check(
        (await this.dispatch(caller.projectId, tx)).enabled,
        'dispatch_disabled',
        'Automatic dispatch was disabled while building the offer',
        409,
      );
      const finalAdmission = await this.admitRunner(owner.hash, input, tx, session.id);
      check(
        finalAdmission.ok,
        'runner_control_changed',
        'Runner controls changed while building the offer',
        409,
      );
      await tx.run(
        'INSERT INTO session_dispatch_receipts(owner_hash,runner_id,request_id,fingerprint,session_id,runner_ref,platform_json) VALUES(?,?,?,?,?,?,?)',
        owner.hash,
        input.runnerId,
        input.requestId,
        fingerprint,
        session.id,
        runner.id,
        JSON.stringify(input.platform),
      );
      await recorded(this.state, tx, caller, 'session.dispatched', session.id, {
        sessionId: session.id,
        instanceId: session.instanceId,
        runnerRef: runner.id,
        platform: input.platform,
      });
      return { session, reason: await decided('offered') };
    });
  }
}
