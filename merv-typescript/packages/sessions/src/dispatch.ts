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
  RUNNER_HARNESSES,
  sessionSecretPattern,
  type Caller,
  type DelegationSource,
  type Scope,
  type State,
  type Transaction,
  type WorkflowProvidedBlocker,
  type Workflows,
  type WorkflowDispatchCandidate,
} from '@merv/contracts';
import type {
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
  DispatchDemand,
  DispatchDemandInput,
  SessionsProjectStatus,
  BudgetStatus,
  StuckItem,
  StuckKind,
  StuckReport,
} from './types.js';
import { budgetStatuses, publicBudget } from './usage.js';
import { lastActivity, type AgentObservations } from './observations.js';
import { isoNow, liveTargets, ownerOf, targetKey } from './common.js';
import type { ManagedRunnerBindings } from './managed.js';

const label = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && !/[\0\r\n]/.test(value));
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/);
const harness = z.enum(RUNNER_HARNESSES);
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
    capabilities: z
      .array(z.string().regex(/^[a-z][a-z0-9.]{0,39}$/))
      .max(16)
      .refine((items) => new Set(items).size === items.length)
      .optional(),
  })
  .strict();
const demandSchema = z
  .object({ platform: platformSchema, capabilities: heartbeatSchema.shape.capabilities })
  .strict();
const leaseSchema = z
  .object({
    runnerId: label,
    requestId: z.string().trim().min(1).max(256),
    secret: z.string().regex(sessionSecretPattern),
    platform: z
      .object({ name, harness, model: label.optional(), effort: label.optional() })
      .strict(),
    hardDeadlineSeconds: z.number().int().min(300).max(604800).optional(),
  })
  .strict();
export const budgetSchema = z
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
/**
 * A budget stops new automatic offers when a bound is reached, and also when a cost or token
 * bound cannot be judged: spending nobody reported must not pass as spending that stayed low.
 */
const withholds = (budget: { exceeded: unknown[]; unavailable: unknown[] }) =>
  budget.exceeded.length > 0 || budget.unavailable.length > 0;
/** The closes that count against a target: its process failed to launch or to stay up. */
export const failureReasons = new Set([
  'host_failed',
  'crash_loop',
  'workspace_failed',
  'launch_failed',
]);
/**
 * The closes that count against nobody: the machine was ready and willing, and the place this
 * work's history lives was away, busy or full. No hold can form from them; they only space the
 * attempts out, exactly as a failure's backoff does.
 */
const deferredReasons = new Set(['preparation_deferred', 'machine_retired']);
/** How long three deferred closes in a row must run before an operator is told about them. */
const deferredRun = 3;
const deferredSinceMs = 7 * 24 * 3600_000;
/**
 * Refusals that say who asked, what they sent or what raced, never that the offer cannot be
 * built. Counting them would let a revoked key, a replayed secret or a lost race hold every
 * healthy target in the queue until an admin came.
 */
const uncountedOfferCodes = new Set([
  'dispatch_disabled',
  'runner_control_changed',
  'request_conflict',
  'revision_conflict',
  'session_conflict',
  'session_secret_used',
  'invalid_session_offer',
  'invalid_deadline',
  'nested_session_offer',
  'agent_busy',
  // A base that turned pending or contested between candidacy and the offer. The work is
  // published as blocked by whoever derives bases, and nothing about the target is broken.
  'code_base_pending',
  'code_merge_required',
  // A base made from several accepted commits that is still being merged, waits for the one
  // task that resolves its conflict, or needs an operator: a wait, never the target's fault.
  'code_base_wait',
  'code_base_admission',
  'code_merge_conflict',
  'code_base_blocked',
  'code_quarantined',
  'code_dependencies_changed',
  // The unit's last writer ended between candidacy and the offer and its machine has not
  // handed over what it left, or that handover needs an operator. Both are published where
  // blocked work is shown; neither says anything against the target.
  'code_writer_busy',
  'code_recovery_required',
  'code_capture_quarantined',
]);
/** session.dispatch: whether automatic work runs, and whether only on the project's own machines. */
export const dispatchSchema = z
  .object({ enabled: z.boolean().optional(), ownMachines: z.boolean().optional() })
  .strict()
  .refine((input) => input.enabled !== undefined || input.ownMachines !== undefined);
type DispatchChange = z.infer<typeof dispatchSchema>;
/** session.halt: one session, or every one in the project with automatic dispatch off. */
export const haltSchema = z
  .object({ sessionId: label.optional(), reason: label.optional() })
  .strict();
export const releaseHoldSchema = z
  .object({
    instanceId: z.string().min(1).max(200),
    expectedRevision: z.number().int().safe().nonnegative(),
    reason: z.string().min(1).max(500).refine(visible),
    requestId: z.string().min(1),
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
  own_machines: number;
  updated_at: string;
  updated_by: string;
}
interface Hooks {
  managed: ManagedRunnerBindings;
  /** Whether a project nobody has switched runs its automatic work. */
  byDefault: boolean;
  prepare(caller: Caller): Promise<void>;
  offer(caller: Caller, input: SessionOffer, tx: Transaction): Promise<Session>;
  /** Close a live session; false when its record had already moved and the reconcile closed it. */
  close(session: Session, reason: string, tx: Transaction): Promise<boolean>;
}
/** The order a stuck report lists its kinds in, and the keys of its counts. */
const stuckKinds: StuckKind[] = [
  'session_idle',
  'dispatch_held',
  'dispatch_failing',
  'work_blocked',
  'work_deferred',
  'ready_quiet',
  'dispatch_disabled',
  'no_live_runner',
  'runner_refusing',
];
const stuckLimit = 200;

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
    private observations: AgentObservations,
    private hooks: Hooks,
    private clock: () => number,
    private thresholds: StuckReport['thresholds'],
  ) {
    this.initialize = async () => {
      await state.migrate('session_dispatch', [
        {
          version: 1,
          sql: postgresMigrations[1],
        },
        {
          // The last decision, not a log: one row per runner, so storage is constant.
          version: 2,
          sql: postgresMigrations[2],
        },
        {
          // Configuration an admin changes, like the dispatch switch, so nothing guards it;
          // its history is the session.budget_changed events. The project's own id as the
          // scope is the project budget; any other scope is a workflow instance.
          version: 3,
          sql: postgresMigrations[3],
        },
        {
          // What keeps a candidate from running, kept where dispatch decides: one counter row
          // per target, so storage is bounded by failed targets, never by attempts. The row is
          // a mutable counter, not a record; its history is the session.dispatch_held and
          // session.hold_released events.
          version: 4,
          sql: postgresMigrations[4],
        },
        {
          // Where automatic work may run, and whose authority chose it.
          version: 5,
          sql: postgresMigrations[5],
        },
        {
          // The founder's ruling (2026-09-25): every project runs its work, on Fleet's machines,
          // until someone says not.
          version: 6,
          sql: postgresMigrations[6],
        },
      ]);
    };
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
  /** Whether the caller's own runner last said it has a capability. No presence means no. */
  async capable(
    caller: Caller,
    runnerId: string,
    capability: string,
    tx: Transaction,
  ): Promise<boolean> {
    const runner = await tx.get<RunnerRow>(
      'SELECT * FROM session_runners WHERE owner_hash=? AND runner_id=?',
      (await ownerOf(this.scope, caller, tx)).hash,
      runnerId,
    );
    return (
      !!runner &&
      ((JSON.parse(runner.presence_json) as RunnerHeartbeat).capabilities ?? []).includes(
        capability,
      )
    );
  }
  private async dispatch(projectId: string, tx: Transaction): Promise<DispatchState> {
    const row = await tx.get<DispatchRow>(
      'SELECT * FROM project_session_dispatch WHERE project_id=?',
      projectId,
    );
    return {
      enabled: row ? !!row.enabled : this.hooks.byDefault,
      ownMachines: !!row?.own_machines,
      fleet: this.hooks.managed.validating,
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    };
  }
  private async set(caller: Caller, to: DispatchChange, tx: Transaction): Promise<DispatchState> {
    const old = await this.dispatch(caller.projectId, tx);
    const next = {
      enabled: to.enabled ?? old.enabled,
      ownMachines: to.ownMachines ?? old.ownMachines,
    };
    if (next.enabled === old.enabled && next.ownMachines === old.ownMachines) return old;
    const time = isoNow(this.clock);
    // The admin who chose last directs what Fleet runs here: their source, taken as they act.
    await tx.run(
      'INSERT INTO project_session_dispatch(project_id,enabled,own_machines,source_json,updated_at,updated_by) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,own_machines=excluded.own_machines,source_json=excluded.source_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
      caller.projectId,
      next.enabled ? 1 : 0,
      next.ownMachines ? 1 : 0,
      JSON.stringify(await this.scope.delegationSource(caller, tx)),
      time,
      caller.actorId,
    );
    // Switching dispatch off and on is the human go-ahead for the whole project: every
    // count starts afresh, where session.release_hold restarts one target.
    if (next.enabled !== old.enabled)
      await tx.run(
        'UPDATE session_dispatch_holds SET attempts=0,held_at=NULL WHERE project_id=?',
        caller.projectId,
      );
    await recorded(this.state, tx, caller, 'session.dispatch_changed', caller.projectId, next);
    return { ...next, fleet: old.fleet, updatedAt: time, updatedBy: caller.actorId };
  }
  async setDispatch(caller: Caller, input: DispatchChange): Promise<DispatchState> {
    caller = structuredClone(caller);
    const parsed = dispatchSchema.safeParse(input);
    check(parsed.success, 'invalid_dispatch', 'Dispatch accepts enabled, ownMachines or both');
    return await this.state.transaction(async (tx) => {
      await this.ordinary(caller, 'admin', tx);
      return await this.set(caller, parsed.data, tx);
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
          isoNow(this.clock),
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
    const parsed = haltSchema.safeParse(input);
    check(parsed.success, 'invalid_halt', 'Halt accepts an optional session and bounded reason');
    input = parsed.data;
    return await this.state.transaction(async (tx) => {
      await this.ordinary(caller, 'admin', tx);
      if (!input.sessionId) await this.set(caller, { enabled: false }, tx);
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
   * held. A runner that was already repeating its answer before the moment was kept starts
   * counting now, or its refusal would stay silent. One statement: every right-hand side
   * reads the row as it was.
   */
  private async decided(
    ownerHash: string,
    runnerId: string,
    decision: DispatchDecision,
    tx: Transaction,
  ): Promise<void> {
    const time = isoNow(this.clock);
    await tx.run(
      'UPDATE session_runners SET decision_since=CASE WHEN last_decision=? THEN COALESCE(decision_since,?) ELSE ? END,last_decision=?,last_decision_at=? WHERE owner_hash=? AND runner_id=?',
      decision,
      time,
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
    const time = isoNow(this.clock);
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
      (old?.attempts ?? 0) + 1 >= this.thresholds.maxLaunchFailures ? time : null,
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
    if (status === 401 || status === 403 || uncountedOfferCodes.has(failure.code)) return;
    try {
      await this.state.transaction(async (tx) => {
        const owner = await ownerOf(this.scope, caller, tx);
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
      if (caller.managed) caller = await this.hooks.managed.heartbeat(caller, input, tx);
      // A runner is a durable presence that will take work: registering one is a write, or a
      // review for Fleet's review director, which takes only reviews.
      await this.scope.require(caller, caller.service ? 'review' : 'write', tx);
      const owner = await ownerOf(this.scope, caller, tx);
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
        time = isoNow(this.clock);
      if (old)
        await tx.run(
          'UPDATE session_runners SET presence_json=?,last_seen_at=? WHERE id=?',
          JSON.stringify(input),
          time,
          id,
        );
      else {
        // A machine Fleet rents is a new runner each time; Fleet's own caps bound those.
        check(
          caller.managed ||
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
    const live = await liveTargets(tx, caller.projectId);
    const all = await this.workflows.dispatchCandidates(caller, tx);
    const queue = all.filter((item) => item.role !== 'operator' && !live.has(targetKey(item)));
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
      budgets.flatMap((budget) => (withholds(budget) ? (budget.instanceIds ?? []) : [])),
    );
    // Work withheld only because usage went unreported says so, not that it spent too much.
    const unaccounted = new Set(
      budgets.flatMap((budget) =>
        !budget.exceeded.length && budget.unavailable.length ? (budget.instanceIds ?? []) : [],
      ),
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
      // Whether every withheld item waits on unreported usage rather than on a reached bound.
      unaccountedOnly:
        overBudget.length > 0 && overBudget.every((item) => unaccounted.has(item.instanceId)),
      budgets,
      all,
      live,
      spent,
      unaccounted,
    };
  }
  /** The same source-scoped candidate selection used by automatic leasing and prospective demand. */
  private async eligibleCandidates(
    caller: Caller,
    tx: Transaction,
    capabilities: ReadonlySet<string>,
    failures: readonly Session[] = [],
    skipped: ReadonlySet<string> = new Set(),
    localRepository = true,
  ): Promise<{ candidates: WorkflowDispatchCandidate[]; reason: DispatchDecision | null }> {
    if (!(await this.dispatch(caller.projectId, tx)).enabled)
      return { candidates: [], reason: 'dispatch_disabled' };
    const admissible = await this.candidates(caller, tx);
    // Project-wide withholding applies to all candidate targets, including targets outside
    // the budget's dependency closure. It has priority over a runner's local backoff.
    const project = admissible.budgets.find(
      (budget) => budget.kind === 'project' && withholds(budget),
    );
    if (project)
      return {
        candidates: [],
        reason: project.exceeded.length ? 'budget_exceeded' : 'usage_unavailable',
      };
    const open = admissible.queue.filter((item) => !skipped.has(targetKey(item)));
    // A checkout with no driver is cloned from the runner's own repository, which a machine
    // Fleet rents does not have.
    const compatible = open.filter(
      (item) =>
        item.workspace.mode === 'none' ||
        (item.workspace.driver === undefined
          ? localRepository
          : capabilities.has(item.workspace.driver)),
    );
    const candidates = compatible.filter(
      (item) =>
        !admissible.backoff.has(targetKey(item)) &&
        !failures.some(
          (session) =>
            session.instanceId === item.instanceId &&
            session.expectedRevision === item.expectedRevision &&
            (failureReasons.has(session.outcome ?? '') ||
              deferredReasons.has(session.outcome ?? '')) &&
            session.closedAt &&
            Date.parse(session.closedAt) + backoffMs > this.clock(),
        ),
    );
    return {
      candidates,
      reason: candidates.length
        ? null
        : compatible.length
          ? 'retry_backoff'
          : open.length
            ? 'runner_incompatible'
            : admissible.overBudget
              ? admissible.unaccountedOnly
                ? 'usage_unavailable'
                : 'budget_exceeded'
              : admissible.retriesExhausted
                ? 'retries_exhausted'
                : 'no_candidates',
    };
  }
  /**
   * Every project Fleet serves, with who directs its work: the admin who chose last, else, where
   * nobody has chosen, the project's longest-standing signed-in operator.
   */
  async servedSources(): Promise<{ projectId: string; source: DelegationSource }[]> {
    const rows = await this.state.read((sql) =>
      sql.all<{
        project_id: string;
        enabled: number;
        own_machines: number;
        source_json: string | null;
      }>(
        'SELECT project_id,enabled,own_machines,source_json FROM project_session_dispatch ORDER BY updated_at,project_id',
      ),
    );
    const chosen = new Map(rows.map((row) => [row.project_id, row]));
    const on = (projectId: string) => {
      const row = chosen.get(projectId);
      return row ? !!row.enabled && !row.own_machines : this.hooks.byDefault;
    };
    const served = rows
      .filter((row) => row.source_json && on(row.project_id))
      .map((row) => ({ projectId: row.project_id, source: JSON.parse(row.source_json!) }));
    const directed = new Set(served.map((project) => project.projectId));
    for (const owner of await this.scope.projectOwners())
      if (!directed.has(owner.projectId) && on(owner.projectId)) served.push(owner);
    return served;
  }
  /** A read-only hint for a configured source and a prospective runner profile. */
  async dispatchDemand(caller: Caller, input: DispatchDemandInput): Promise<DispatchDemand> {
    caller = structuredClone(caller);
    const parsed = demandSchema.safeParse(input);
    check(parsed.success, 'invalid_dispatch_demand', 'Demand requires a valid runner profile');
    input = parsed.data;
    return await this.state.snapshot(() =>
      this.state.transaction(async (tx) => {
        await this.ordinary(caller, 'read', tx);
        // Only Fleet asks: a project on its own machines has no work for a machine it rents.
        if (!input.platform.enabled || (await this.dispatch(caller.projectId, tx)).ownMachines)
          return { candidates: [] };
        const selected = await this.eligibleCandidates(
          caller,
          tx,
          new Set(input.capabilities ?? []),
          await this.recentFailures(
            tx,
            (await ownerOf(this.scope, caller, tx)).hash,
            input.platform.name,
          ),
          new Set(),
          false,
        );
        return {
          candidates: selected.candidates.map(({ instanceId, expectedRevision }) => ({
            instanceId,
            expectedRevision,
          })),
        };
      }),
    );
  }
  /**
   * Closes inside the backoff window, asked of the database since history is kept for ever. A
   * machine Fleet rents is a new runner each time, so its failures are read across the source's
   * machines on that platform rather than by runner.
   */
  private async recentFailures(
    tx: Transaction,
    ownerHash: string,
    platform: string,
    runnerId?: string,
  ): Promise<Session[]> {
    return (
      await tx.all<SessionRow>(
        "SELECT s.session_json FROM worker_sessions s JOIN session_dispatch_receipts d ON d.session_id=s.id WHERE s.owner_hash=? AND (CAST(? AS TEXT) IS NULL OR s.runner_id=?) AND d.platform_json IS NOT NULL AND (d.platform_json::jsonb #>> '{name}')=? AND s.status IN ('released','expired') AND (s.session_json::jsonb #>> '{closedAt}')>?",
        ownerHash,
        runnerId ?? null,
        runnerId ?? null,
        platform,
        new Date(this.clock() - backoffMs).toISOString(),
      )
    ).map((row) => JSON.parse(row.session_json) as Session);
  }
  /** The most recently seen runners, which is where every live one is. */
  private async runners(projectId: string, tx: Transaction): Promise<RunnerPresence[]> {
    return await mapAsync(
      await tx.all<RunnerRow>(
        'SELECT * FROM session_runners r WHERE project_id=? AND NOT EXISTS (SELECT 1 FROM session_managed_runners m WHERE m.runner_id=r.runner_id AND m.runner_released_at IS NOT NULL) ORDER BY last_seen_at DESC,id LIMIT 100',
        projectId,
      ),
      (row) => this.presence(row, tx),
    );
  }
  /**
   * Everything that stopped moving, derived from the rows at the moment of the read. It only
   * reads: a session idle here is reported whether or not the sweep has marked it, and the
   * mark itself stays the sweep's. The words in `why` and `next` are advice; what they
   * describe is enforced by the transaction that leases, closes or releases.
   */
  private async attention(
    projectId: string,
    tx: Transaction,
    facts: {
      runners: RunnerPresence[];
      dispatch: DispatchState;
      activity: Map<string, string>;
      admissible: Awaited<ReturnType<SessionDispatch['candidates']>>;
      blockers: WorkflowProvidedBlocker[];
    },
  ): Promise<StuckReport> {
    const now = this.clock(),
      observedAt = isoNow(this.clock),
      limits = this.thresholds;
    const { runners, dispatch, activity } = facts;
    const { all, live, spent, unaccounted, queue } = facts.admissible;
    const older = (since: string, seconds: number) => Date.parse(since) + seconds * 1000 <= now;
    const items: StuckItem[] = [];
    const add = (item: Omit<StuckItem, 'forSeconds'>) =>
      items.push({
        ...item,
        forSeconds: Math.max(0, Math.floor((now - Date.parse(item.since)) / 1000)),
      });
    for (const row of await tx.all<SessionRow>(
      "SELECT id,session_json FROM worker_sessions WHERE project_id=? AND status='active'",
      projectId,
    )) {
      const session: Session = JSON.parse(row.session_json);
      const since = lastActivity(session, activity.get(session.id));
      if (since === null || !older(since, limits.idleNoticeSeconds)) continue;
      add({
        kind: 'session_idle',
        instanceId: session.instanceId,
        expectedRevision: session.expectedRevision,
        sessionId: session.id,
        label: session.assignment.label,
        since,
        code: 'idle',
        why: 'No recent Merv activity: the session is alive and has made no Merv tool call since then. That is not evidence the work is stuck — it may be computing locally, waiting on a remote job or using another service, none of which the server sees.',
        next: `Check the worker before acting. Nothing closes a session for silence; it ends at its lease deadline, or when an admin halts it with POST /sessions/halt {"sessionId":"${session.id}"}. Halting the worker does not stop a remote job it started, and the retry may start that job again.`,
      });
    }
    // A target with a live session is being tried right now, so it is not waiting on anyone.
    const waiting = new Map(
      all
        .filter((item) => item.role !== 'operator' && !live.has(targetKey(item)))
        .map((item) => [targetKey(item), item]),
    );
    const failing = new Set<string>();
    for (const row of await tx.all<HoldRow>(
      'SELECT * FROM session_dispatch_holds WHERE project_id=? AND attempts>0',
      projectId,
    )) {
      const key = `${row.instance_id}:${row.revision}`;
      const item = waiting.get(key);
      if (!item) continue;
      failing.add(key);
      add({
        kind: row.held_at ? 'dispatch_held' : 'dispatch_failing',
        instanceId: row.instance_id,
        expectedRevision: row.revision,
        ...(row.last_session_id ? { sessionId: row.last_session_id } : {}),
        label: item.label,
        since: row.held_at ?? row.first_at,
        code: row.last_code,
        attempts: row.attempts,
        why: row.last_message,
        next: row.held_at
          ? 'Fix the cause, then an admin calls session.release_hold; or end or revise the record, because a hold names one revision. The hold stops automatic offers only: an offer made by hand still runs, and its failure counts.'
          : `Nothing yet: automatic dispatch tries again after ${backoffMs / 1000} seconds and holds the target at ${limits.maxLaunchFailures} failed attempts.`,
      });
    }
    // Work its owner refuses to lease never becomes a candidate, so nothing above or below can
    // see it. What the refusing plugin published is the only trace, and it is read from
    // Workflows' own rows, so it is still here when that plugin is not.
    for (const blocker of facts.blockers)
      add({
        kind: 'work_blocked',
        instanceId: blocker.instanceId,
        since: blocker.since,
        code: blocker.code,
        why: blocker.message,
        next: blocker.next,
      });
    // A target nobody could prepare a checkout for is not failing and is never held, so no
    // counter above would ever show it. A run of deferred closes is what says it is not
    // simply quiet: where that work's history lives has been away, busy or full since then.
    const deferred = new Set<string>();
    const runs = new Map<string, Session[]>();
    for (const row of await tx.all<SessionRow>(
      "SELECT id,session_json FROM worker_sessions WHERE project_id=? AND status IN ('released','expired') AND (session_json::jsonb #>> '{closedAt}')>?",
      projectId,
      new Date(now - deferredSinceMs).toISOString(),
    )) {
      const session: Session = JSON.parse(row.session_json);
      const key = `${session.instanceId}:${session.expectedRevision}`;
      if (!waiting.has(key) || failing.has(key)) continue;
      const run = runs.get(key) ?? [];
      run.push(session);
      runs.set(key, run);
    }
    for (const [key, sessions] of runs) {
      const last = sessions
        .sort((a, b) => (a.closedAt! < b.closedAt! ? 1 : a.closedAt === b.closedAt ? 0 : -1))
        .slice(0, deferredRun);
      if (last.length < deferredRun || !last.every((s) => deferredReasons.has(s.outcome ?? '')))
        continue;
      const item = waiting.get(key)!,
        newest = last[0];
      deferred.add(key);
      add({
        kind: 'work_deferred',
        instanceId: item.instanceId,
        expectedRevision: item.expectedRevision,
        sessionId: newest.id,
        label: item.label,
        since: last[last.length - 1].closedAt!,
        code: newest.deferral?.cause ?? 'preparation_deferred',
        attempts: last.length,
        why: `The last ${last.length} machines that took this work could not prepare its checkout and put it off (${newest.deferral?.code ?? 'preparation_deferred'}). Nothing counts that against the work, so it is offered again and again.`,
        next: 'Look at where this work’s history lives: with Code’s own repository that is code.status, whose store, operations and mirror say whether it is unavailable, busy or full. Nothing here is held; the offers resume by themselves once it answers.',
      });
    }
    for (const item of all) {
      const key = targetKey(item),
        operator = item.role === 'operator';
      if (
        live.has(key) ||
        failing.has(key) ||
        deferred.has(key) ||
        !older(item.updatedAt, limits.quietReadySeconds)
      )
        continue;
      // With dispatch off, one dispatch_disabled item says why all of them wait.
      if (!operator && !dispatch.enabled) continue;
      add({
        kind: 'ready_quiet',
        instanceId: item.instanceId,
        expectedRevision: item.expectedRevision,
        label: item.label,
        since: item.updatedAt,
        code: operator
          ? 'awaiting_operator'
          : unaccounted.has(item.instanceId)
            ? 'usage_unavailable'
            : spent.has(item.instanceId)
              ? 'budget_exceeded'
              : 'queued',
        why: 'This step is ready and no session holds it. The clock is the record’s last revision change, so a step released after a long session is quiet at once.',
        next: operator
          ? 'It is an operator’s step: no runner is ever offered it. workflow.status_and_next on the instance names the action.'
          : unaccounted.has(item.instanceId)
            ? 'A cost or token budget covers it, and a closed session in its scope reported no usage, so the bound cannot be judged. usage.read names the budget and the count; the usage arriving, or usage.set_budget clearing that bound, resumes it.'
            : spent.has(item.instanceId)
              ? 'A reached budget withholds it; usage.read shows which, and usage.set_budget raises or clears it.'
              : 'Read the other items of this report for the cause; a runner with free capacity takes it on its next poll.',
      });
    }
    if (queue.length && !dispatch.enabled)
      add({
        kind: 'dispatch_disabled',
        since: dispatch.updatedAt ?? observedAt,
        code: 'dispatch_disabled',
        why: `${queue.length} queued step${queue.length === 1 ? ' waits' : 's wait'} while automatic dispatch is off.`,
        next: 'An admin turns it on with PUT /sessions/dispatch {"enabled":true}. Work can still be offered by hand.',
      });
    // Where Fleet rents for this project, its machines are the runners that take the work.
    if (
      queue.length &&
      dispatch.enabled &&
      !runners.some((runner) => runner.live) &&
      !this.hooks.managed.serves(projectId)
    )
      add({
        kind: 'no_live_runner',
        since: runners[0]?.lastSeenAt ?? observedAt,
        code: 'no_live_runner',
        why: runners.length
          ? `Dispatch is on and work is queued, but no authorized runner has been seen in the last ${freshForMs / 1000} seconds.`
          : 'Dispatch is on and work is queued, but no runner has ever registered in this project.',
        next: 'Start a runner on a machine that holds a write key of this project.',
      });
    if (queue.length && dispatch.enabled)
      for (const runner of runners) {
        const code = runner.lastDecision;
        if (
          !runner.live ||
          (code !== 'settings_pending' && code !== 'platform_disabled') ||
          !runner.decisionSince ||
          !older(runner.decisionSince, limits.refusalSeconds)
        )
          continue;
        add({
          kind: 'runner_refusing',
          runnerRef: runner.id,
          label: runner.runnerId,
          since: runner.decisionSince,
          code,
          why:
            code === 'settings_pending'
              ? `The runner has applied settings version ${runner.appliedVersion ?? 0} but version ${runner.desiredVersion} is published; it is offered nothing until it acknowledges them.`
              : 'Every lease request of this runner names a platform that is disabled on the machine or in its server-owned settings.',
          next:
            code === 'settings_pending'
              ? `Restart the runner so it applies them, or an admin publishes them again with PUT /sessions/runners/${runner.id}/settings.`
              : `Enable the platform on the machine, or an admin enables it with PUT /sessions/runners/${runner.id}/settings.`,
        });
      }
    const counts = Object.fromEntries(stuckKinds.map((kind) => [kind, 0])) as Record<
      StuckKind,
      number
    >;
    for (const item of items) counts[item.kind]++;
    const subject = (item: StuckItem) => item.instanceId ?? item.runnerRef ?? '';
    items.sort(
      (a, b) =>
        stuckKinds.indexOf(a.kind) - stuckKinds.indexOf(b.kind) ||
        (a.since < b.since ? -1 : a.since > b.since ? 1 : 0) ||
        (subject(a) < subject(b) ? -1 : subject(a) > subject(b) ? 1 : 0),
    );
    return {
      observedAt,
      thresholds: { ...limits },
      // A target still being retried needs nobody yet, so it is listed but not counted.
      total: items.length - counts.dispatch_failing,
      counts,
      items: items.slice(0, stuckLimit),
      truncated: items.length > stuckLimit,
    };
  }
  async stuck(caller: Caller): Promise<StuckReport> {
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      await this.ordinary(caller, 'read', tx);
      return await this.attention(caller.projectId, tx, {
        runners: await this.runners(caller.projectId, tx),
        dispatch: await this.dispatch(caller.projectId, tx),
        activity: await this.observations.activity(tx, caller.projectId),
        admissible: await this.candidates(caller, tx),
        blockers: await this.workflows.blockers(caller, undefined, tx),
      });
    });
  }
  async projectStatus(caller: Caller): Promise<SessionsProjectStatus> {
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      const actor = await this.ordinary(caller, 'read', tx);
      const runners = await this.runners(caller.projectId, tx);
      const activity = await this.observations.activity(tx, caller.projectId);
      const sessions: SessionSummary[] = (
        await tx.all<
          SessionRow & {
            runner_ref: string | null;
            platform_json: string | null;
            attachment_json: string | null;
            result_json: string | null;
          }
        >(
          "SELECT s.id,s.session_json,d.runner_ref,d.platform_json,w.attachment_json,w.result_json FROM worker_sessions s LEFT JOIN session_dispatch_receipts d ON d.session_id=s.id LEFT JOIN session_workspaces w ON w.session_id=s.id WHERE s.project_id=? ORDER BY CASE WHEN s.status IN ('offered','active') THEN 0 ELSE 1 END,s._merv_rowid DESC LIMIT 200",
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
          lastActivityAt:
            session.status === 'active' ? lastActivity(session, activity.get(session.id)) : null,
          quietSince: session.quietSince ?? null,
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
      const admissible = await this.candidates(caller, tx);
      const { queue, retriesExhausted, budgets } = admissible;
      const dispatch = await this.dispatch(caller.projectId, tx);
      const {
        observedAt,
        total,
        counts: stuck,
      } = await this.attention(caller.projectId, tx, {
        runners,
        dispatch,
        activity,
        admissible,
        blockers: await this.workflows.blockers(caller, undefined, tx),
      });
      return {
        // One transaction, one moment: agents cannot report a lease the leases do not.
        agents: await this.observations.summaries(tx, caller.projectId),
        observedAt,
        liveSessionCount: counts.live,
        sessionTotal: counts.total,
        runnerTotal,
        canManage: actor.role === 'operator',
        dispatch,
        runners,
        sessions,
        queue: queue.slice(0, 200),
        queueTotal: queue.length,
        budgets: budgets.map(publicBudget),
        retriesExhausted,
        stuck: { total, counts: stuck },
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
    const preparedCaller = caller.managed
      ? await this.state.transaction(
          async (tx) => (await this.hooks.managed.require(caller, tx)).sourceCaller,
        )
      : caller;
    await this.hooks.prepare(preparedCaller);
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
        await this.poisoned(preparedCaller, error.candidate, error.cause);
      }
    }
  }
  private async leaseOnce(
    caller: Caller,
    input: AutomaticLease,
    skipped: Set<string>,
  ): Promise<{ session: Session | null; reason: string }> {
    return await this.state.transaction(async (tx) => {
      const managed = caller.managed ? await this.hooks.managed.lease(caller, input, tx) : null;
      const effectiveCaller = managed?.sourceCaller ?? caller;
      const owner = await ownerOf(this.scope, effectiveCaller, tx);
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
        if (managed)
          check(
            managed.row.bound_session_id === old.session_id,
            'managed_bound',
            'Managed runner receipt is not its bound session',
            403,
          );
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
      if (managed?.row.bound_session_id)
        return { session: null, reason: await decided('capacity_full') };
      // A project on its own machines gives a rented one no new work; one it holds runs out.
      const open = async () => {
        const dispatch = await this.dispatch(caller.projectId, tx);
        return dispatch.enabled && !(managed && dispatch.ownMachines);
      };
      if (!(await open())) return { session: null, reason: await decided('dispatch_disabled') };
      if (managed) await this.hooks.managed.admits(managed.row, tx);
      // A hosted machine stops at its allocation's end, so its step must end five minutes
      // before; a machine with under ten minutes left starts none.
      const left = managed
        ? Math.floor((Date.parse(managed.row.control_expires_at) - this.clock()) / 1000) - 300
        : Infinity;
      check(left >= 300, 'managed_expiring', 'Managed machine has too little time for a step', 409);
      const admission = await this.admitRunner(owner.hash, input, tx);
      if (!admission.ok) return { session: null, reason: await decided(admission.reason) };
      const { runner, platform } = admission;
      const failures = await this.recentFailures(
        tx,
        owner.hash,
        platform.name,
        managed ? undefined : input.runnerId,
      );
      // A checkout some driver must prepare goes only to a machine that says it has that
      // driver; everything else in the queue is still this runner's to take.
      const capabilities = new Set(
        (JSON.parse(runner.presence_json) as RunnerHeartbeat).capabilities ?? [],
      );
      const selected = await this.eligibleCandidates(
        effectiveCaller,
        tx,
        capabilities,
        failures,
        skipped,
        !managed,
      );
      const candidate = selected.candidates[0];
      if (!candidate)
        return {
          session: null,
          reason: await decided(selected.reason ?? 'no_candidates'),
        };
      // Admission callbacks cannot disable dispatch or change source permission and
      // then still create an automatic lease within this transaction.
      await this.scope.requireDelegation(owner.source, 'read', tx);
      check(
        await open(),
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
          effectiveCaller,
          {
            instanceId: candidate.instanceId,
            expectedRevision: candidate.expectedRevision,
            runnerId: input.runnerId,
            requestId: input.requestId,
            secret: input.secret,
            hardDeadlineSeconds: Math.min(input.hardDeadlineSeconds ?? 86400, left),
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
        await open(),
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
      if (managed) await this.hooks.managed.bind(managed.row, session.id, tx);
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
      await recorded(this.state, tx, effectiveCaller, 'session.dispatched', session.id, {
        sessionId: session.id,
        instanceId: session.instanceId,
        runnerRef: runner.id,
        platform: input.platform,
      });
      return { session, reason: await decided('offered') };
    });
  }
}
