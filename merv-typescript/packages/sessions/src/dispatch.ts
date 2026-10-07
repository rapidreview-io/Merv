import { postgresMigrations } from './dispatch.postgres.js';
import { z } from 'zod';
import {
  recorded,
  replayed,
  clip,
  visible,
  MervError,
  check,
  digest,
  sessionSecretPattern,
  type Caller,
  type DelegationSource,
  type Scope,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import type { WorkflowDispatchCandidate } from '@merv/workflows/models';
import type {
  AutomaticLease,
  DispatchDecision,
  DispatchHold,
  DispatchState,
  RunnerHeartbeat,
  RunnerPlatform,
  RunnerPresence,
  Session,
  SessionOffer,
  DispatchDemand,
  DispatchDemandInput,
  StuckReport,
} from './types.js';
import type { AgentObservations } from './observations.js';
import {
  HOLD_PROVIDER,
  MODEL_BUDGET_PROVIDER,
  isoNow,
  liveTargets,
  ordinary as unmanaged,
  ownerOf,
  readFirst,
  targetKey,
} from './common.js';
import type { ManagedRunnerBindings } from './managed.js';
import type { ManagedBindingRow } from './managed-types.js';
import { INQUIRY_CAPABILITY, label, runnerPlatformSchema } from './rules.js';
import { INQUIRY_VISIT_SECONDS, type Inquiries } from './inquiries.js';
import { withholds } from './budgets.js';
import { heartbeatSchema, type RunnerRow } from './runners.js';
import { backoffMs, deferredReasons, type Failure } from './stuck.js';
import * as budgets from './budgets.js';
import * as runners from './runners.js';
import * as stuck from './stuck.js';

const demandSchema = z
  .object({ platform: runnerPlatformSchema, capabilities: heartbeatSchema.shape.capabilities })
  .strict();
const leaseSchema = z
  .object({
    runnerId: label,
    requestId: z.string().trim().min(1).max(256),
    secret: z.string().regex(sessionSecretPattern),
    platform: runnerPlatformSchema.pick({ name: true, harness: true, model: true, effort: true }),
    hardDeadlineSeconds: z.number().int().min(300).max(604800).optional(),
  })
  .strict();
/**
 * How long an answered question still withholds its work for the asking visit's conversation:
 * its runner declares it when its process ends, within a minute's grace of the question.
 */
export const declaredWithinMs = 10 * 60_000;
/** How many questions one lease tries when its machine is refused one. */
const INQUIRY_TRIES = 3;
/** The closes that count against a target: its process failed to launch or to stay up. */
export const failureReasons = new Set([
  'host_failed',
  'crash_loop',
  'workspace_failed',
  'launch_failed',
]);
/**
 * Refusals that say who asked, what they sent or what raced, never that the offer cannot be
 * built. Counting them would let a revoked key, a replayed secret or a lost race hold every
 * healthy target in the queue until an admin came. A refusal its component marked a wait
 * (MervError.wait) is not counted either.
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
]);
export const releaseHoldSchema = z
  .object({
    instanceId: z.string().min(1).max(200),
    expectedRevision: z.number().int().safe().nonnegative(),
    reason: z.string().min(1).max(500).refine(visible),
    requestId: z.string().min(1),
  })
  .strict();
export interface HoldRow {
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
export interface SessionRow {
  id: string;
  thread_id: string;
  session_json: string;
}
interface Hooks {
  managed: ManagedRunnerBindings;
  /** Refuses once Sessions has closed. */
  available(): void;
  /** Whether a project nobody has switched runs its automatic work. */
  byDefault: boolean;
  prepare(caller: Caller): Promise<void>;
  offer(caller: Caller, input: SessionOffer, tx: Transaction): Promise<Session>;
  /** A person's questions to agents: what a machine may take, and its visit's offer. */
  inquiries: Pick<Inquiries, 'candidate' | 'demand' | 'offer'>;
  /** Close a live session; false when its record had already moved and the reconcile closed it. */
  close(session: Session, reason: string, tx: Transaction): Promise<boolean>;
}
/** What budgets.ts, runners.ts and stuck.ts read of the dispatch that runs them. */
export type DispatchContext = Pick<
  SessionDispatch,
  | 'state'
  | 'scope'
  | 'workflows'
  | 'observations'
  | 'hooks'
  | 'clock'
  | 'thresholds'
  | 'enter'
  | 'ordinary'
  | 'candidates'
  | 'dispatch'
  | 'presence'
  | 'reportHold'
>;
/** A module's function run on one dispatch, which it takes as its first argument. */
const bound =
  <A extends unknown[], R>(ctx: DispatchContext, run: (ctx: DispatchContext, ...args: A) => R) =>
  (...args: A) =>
    run(ctx, ...args);
/** An offer for one candidate that cannot be built; the queue moves past it. */
class PoisonedOffer extends Error {
  constructor(
    readonly candidate: Target,
    readonly cause: unknown,
    readonly owner: string,
    /** A server fault or a refusal of who asked: logged and passed over, never held. */
    readonly silent: boolean,
    readonly caller?: Caller,
  ) {
    super('Offer could not be built');
  }
}
export class SessionDispatch {
  /** `${ownerHash} ${targetKey}` of a silent offer failure, until when that owner passes it over. */
  private readonly passed = new Map<string, number>();
  private passing(ownerHash: string): Set<string> {
    const keys = new Set<string>();
    for (const [key, until] of this.passed)
      if (until <= this.clock()) this.passed.delete(key);
      else if (key.startsWith(`${ownerHash} `)) keys.add(key.slice(ownerHash.length + 1));
    return keys;
  }
  constructor(
    readonly state: State,
    readonly scope: Scope,
    readonly workflows: Workflows,
    readonly observations: AgentObservations,
    readonly hooks: Hooks,
    readonly clock: () => number,
    readonly thresholds: StuckReport['thresholds'],
  ) {}
  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('session_dispatch', postgresMigrations);
    // Holds made before they were reported are reported once; an unchanged report writes
    // nothing. A schema held back below the holds table has none.
    await this.state.transaction(async (tx) => {
      const table = await tx.get<{ name: string | null }>(
        "SELECT to_regclass('session_dispatch_holds')::text AS name",
      );
      if (!table?.name) return;
      for (const row of await tx.all<HoldRow & { project_id: string }>(
        'SELECT DISTINCT ON (project_id,instance_id) * FROM session_dispatch_holds WHERE held_at IS NOT NULL ORDER BY project_id,instance_id,revision DESC',
      ))
        await this.reportHold(row.project_id, row.instance_id, row, tx);
      // A go-ahead (a release, or dispatch switched off and on) that left its blocker behind:
      // work whose counts were reset and that nothing holds now has none.
      for (const row of await tx.all<{ project_id: string; instance_id: string }>(
        'SELECT DISTINCT h.project_id,h.instance_id FROM session_dispatch_holds h WHERE h.attempts=0 AND NOT EXISTS (SELECT 1 FROM session_dispatch_holds o WHERE o.project_id=h.project_id AND o.instance_id=h.instance_id AND o.held_at IS NOT NULL)',
      ))
        await this.reportHold(row.project_id, row.instance_id, null, tx);
    });
  }
  /** An entry point's first checks: Sessions is open, and the caller is no managed runner. */
  enter(caller?: Caller): void {
    this.hooks.available();
    if (caller) unmanaged(caller);
  }
  async ordinary(caller: Caller, permission: 'read' | 'admin', tx: Transaction) {
    check(
      !caller.session,
      'forbidden',
      'Leased workers cannot read or control project dispatch',
      403,
    );
    return await this.scope.require(caller, permission, tx);
  }
  // The two the modules read of each other through DispatchContext, typed here so that it is not
  // circular.
  dispatch(projectId: string, tx: Transaction): Promise<DispatchState> {
    return budgets.dispatch(this, projectId, tx);
  }
  presence(row: RunnerRow, tx: Transaction): Promise<RunnerPresence> {
    return runners.presence(this, row, tx);
  }
  // Run on this dispatch as their context: the switch, budgets and halt (budgets.ts), runner
  // presence and settings (runners.ts), and why admitted work does not move (stuck.ts).
  readonly setDispatch = bound(this, budgets.setDispatch);
  private readonly budgets = bound(this, budgets.budgets);
  readonly setBudget = bound(this, budgets.setBudget);
  readonly budgetsFor = bound(this, budgets.budgetsFor);
  readonly halt = bound(this, budgets.halt);
  readonly capable = bound(this, runners.capable);
  readonly authorized = bound(this, runners.authorized);
  private readonly decided = bound(this, runners.decided);
  readonly heartbeatRunner = bound(this, runners.heartbeatRunner);
  readonly setRunnerSettings = bound(this, runners.setRunnerSettings);
  readonly stuck = bound(this, stuck.stuck);
  readonly projectStatus = bound(this, stuck.projectStatus);
  readonly running = bound(this, stuck.running);
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
    if (!row.held_at || old?.held_at) return undefined;
    await this.reportHold(projectId, target.instanceId, row, tx);
    return publicHold(row);
  }
  /**
   * A hold is a project admin's move, reported on the work it holds so it reaches Needs you;
   * it names one revision, so the record moving on withdraws it. Without a row, withdrawn.
   */
  async reportHold(
    projectId: string,
    instanceId: string,
    row: HoldRow | null,
    tx: Transaction,
  ): Promise<void> {
    await this.workflows.replaceBlockers(
      {
        projectId,
        instanceId,
        provider: HOLD_PROVIDER,
        blockers: row
          ? [
              {
                key: 'launch',
                code: 'launch_held',
                status: 409,
                message: `Dispatch holds this work after ${row.attempts} failed launches: ${row.last_message}`,
                next: 'Fix why its launches fail, then release the hold',
                whose: 'admin',
                revision: Number(row.revision),
              },
            ]
          : [],
      },
      tx,
    );
  }
  /**
   * The model budget's wait on a rented machine's work, said on the work so it reaches Needs you
   * (an operator's move: only a person signed in raises their own limit), and withdrawn once the
   * budget lets the machine take it. It names the revision that waits, so moving on withdraws it.
   */
  private async modelWaits(row: ManagedBindingRow, tx: Transaction): Promise<boolean> {
    const wait = await this.hooks.managed.modelWait(row, tx);
    const instanceId = row.work_instance_id;
    if (!instanceId) return !!wait;
    const revision = wait
      ? (await this.workflows.revisions(row.project_id, [instanceId], tx)).get(instanceId)?.revision
      : undefined;
    await this.reportModelWait(row.project_id, instanceId, wait && revision, tx);
    return !!wait;
  }
  /** The model budget's wait on `instanceId` at `revision`, or none: see `modelWaits`. */
  async reportModelWait(
    projectId: string,
    instanceId: string,
    revision: number | null | undefined,
    tx: Transaction,
  ): Promise<void> {
    await this.workflows.replaceBlockers(
      {
        projectId,
        instanceId,
        provider: MODEL_BUDGET_PROVIDER,
        blockers:
          typeof revision === 'number'
            ? [
                {
                  key: 'model_budget',
                  code: 'model_budget_exhausted',
                  cause: 'model_budget',
                  status: 429,
                  message: 'Daily model tokens used up; resumes at 00:00 UTC or raise your limit',
                  next: 'Wait for the daily reset at 00:00 UTC, or raise your daily model token limit',
                  whose: 'operator',
                  revision,
                },
              ]
            : [],
      },
      tx,
    );
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
    const failure =
      cause instanceof MervError
        ? { code: cause.code, message: cause.message }
        : { code: 'offer_failed', message: cause instanceof Error ? cause.message : String(cause) };
    if ((cause instanceof MervError && cause.wait) || uncountedOfferCodes.has(failure.code)) return;
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
    this.enter(caller);
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
          // A hold of a later revision, if one stands, is still reported.
          await this.reportHold(
            caller.projectId,
            input.instanceId,
            (await tx.get<HoldRow>(
              'SELECT * FROM session_dispatch_holds WHERE project_id=? AND instance_id=? AND held_at IS NOT NULL ORDER BY revision DESC LIMIT 1',
              caller.projectId,
              input.instanceId,
            )) ?? null,
            tx,
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
  async candidates(caller: Caller, tx: Transaction) {
    const live = await liveTargets(tx, caller.projectId);
    const all = await this.workflows.dispatchCandidates(caller, tx);
    // The revision an agent asked its owner at waits for the answer (`session.ask_owner`), and
    // then for the asking visit's conversation, which the next visit resumes: until its runner
    // has uploaded it (declared only, the next visit could not fetch it), or a later visit of the
    // thread ran, or `declaredWithinMs` has passed.
    const asking = new Set(
      (
        await tx.all<{ instance_id: string; revision: number | string }>(
          `SELECT DISTINCT q.instance_id,q.revision FROM session_questions q WHERE q.project_id=?
            AND (q.answered_at IS NULL OR (q.asked_at>? AND EXISTS (
              SELECT 1 FROM session_threads t JOIN worker_sessions a ON a.id=q.session_id
               WHERE t.id=q.thread_id AND t.status<>'retired'
                 AND (t.latest_session_id IS DISTINCT FROM q.session_id OR t.uploaded_at IS NULL)
                 AND NOT EXISTS (SELECT 1 FROM worker_sessions s WHERE s.thread_id=t.id AND s.kind='work' AND s._merv_rowid>a._merv_rowid))))`,
          caller.projectId,
          new Date(this.clock() - declaredWithinMs).toISOString(),
        )
      ).map((row) =>
        targetKey({ instanceId: row.instance_id, expectedRevision: Number(row.revision) }),
      ),
    );
    const queue = all.filter(
      (item) =>
        item.role !== 'operator' && !live.has(targetKey(item)) && !asking.has(targetKey(item)),
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
    // The project's own budget is judged before any candidate is. An instance budget whose
    // closure is too large to walk may cover any of them, so it covers them all.
    const covered = (budget: (typeof budgets)[number]) =>
      budget.kind === 'project' ? [] : (budget.instanceIds ?? all.map((item) => item.instanceId));
    const spent = new Set(budgets.flatMap((budget) => (withholds(budget) ? covered(budget) : [])));
    // Work withheld only because its budget cannot be judged says so, not that it spent too much.
    const unaccounted = new Set(
      budgets.flatMap((budget) =>
        !budget.exceeded.length && budget.unavailable.length ? covered(budget) : [],
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
      asking,
    };
  }
  /** Whether the project's own budget holds back every automatic visit, inquiries too. */
  private async projectWithholds(caller: Caller, tx: Transaction): Promise<boolean> {
    return (await this.budgets(caller, tx, [caller.projectId])).some(withholds);
  }
  /** The same source-scoped candidate selection used by automatic leasing and prospective demand. */
  private async eligibleCandidates(
    caller: Caller,
    tx: Transaction,
    capabilities: ReadonlySet<string>,
    failures: readonly Failure[] = [],
    skipped: ReadonlySet<string> = new Set(),
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
    const open = admissible.queue;
    // A checkout goes only to a runner carrying its driver.
    const compatible = open.filter(
      (item) => item.workspace.mode === 'none' || capabilities.has(item.workspace.driver),
    );
    const candidates = compatible.filter(
      (item) =>
        !admissible.backoff.has(targetKey(item)) &&
        !skipped.has(targetKey(item)) &&
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
  /** Every project Fleet serves, as its owner (see `Sessions.servedSources`). */
  async servedSources(): Promise<{ projectId: string; source: DelegationSource }[]> {
    this.enter();
    const rows = await this.state.read((sql) =>
      sql.all<{ project_id: string; enabled: number; own_machines: number }>(
        'SELECT project_id,enabled,own_machines FROM project_session_dispatch',
      ),
    );
    const chosen = new Map(rows.map((row) => [row.project_id, row]));
    return (await this.scope.projectOwners()).filter(({ projectId }) => {
      const row = chosen.get(projectId);
      return row ? !!row.enabled && !row.own_machines : this.hooks.byDefault;
    });
  }
  /** A read-only hint for a configured source and a prospective runner profile. */
  async dispatchDemand(caller: Caller, input: DispatchDemandInput): Promise<DispatchDemand> {
    this.enter(caller);
    caller = structuredClone(caller);
    const parsed = demandSchema.safeParse(input);
    check(parsed.success, 'invalid_dispatch_demand', 'Demand requires a valid runner profile');
    input = parsed.data;
    return await this.state.snapshotTransaction(async (tx) => {
      await this.ordinary(caller, 'read', tx);
      // Only Fleet asks: a project on its own machines has no work for a machine it rents.
      const dispatch = await this.dispatch(caller.projectId, tx);
      if (!input.platform.enabled || dispatch.ownMachines) return { candidates: [] };
      const owner = (await ownerOf(this.scope, caller, tx)).hash;
      const selected = await this.eligibleCandidates(
        caller,
        tx,
        new Set(input.capabilities ?? []),
        await this.recentFailures(tx, owner, input.platform.name),
        this.passing(owner),
      );
      const candidates: DispatchDemand['candidates'] = selected.candidates.map(
        ({ instanceId, expectedRevision, updatedAt }) => ({
          instanceId,
          expectedRevision,
          since: updatedAt,
        }),
      );
      // A question to an agent wants a machine too, on the work item it asks about, at that
      // work's current revision: only where dispatch is on, as `eligibleCandidates` read it.
      if (
        (input.capabilities ?? []).includes(INQUIRY_CAPABILITY) &&
        dispatch.enabled &&
        !(await this.projectWithholds(caller, tx))
      ) {
        const asked = (
          await this.hooks.inquiries.demand(tx, caller.projectId, owner, input.platform.harness)
        ).filter((id) => !candidates.some((item) => item.instanceId === id));
        for (const [instanceId, item] of await this.workflows.revisions(
          caller.projectId,
          asked,
          tx,
        ))
          candidates.push({
            instanceId,
            expectedRevision: item.revision,
            since: item.updatedAt,
            // Its own host while every host of the item is busy with another visit.
            ...((await this.hooks.managed.hostsBusy(caller.projectId, instanceId, tx)) && {
              ownHost: true as const,
            }),
          });
      }
      return { candidates };
    });
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
  ): Promise<Failure[]> {
    return await tx.all<Failure>(
      'SELECT u.instance_id AS "instanceId",CAST(u.revision AS INTEGER) AS "expectedRevision",u.outcome,u.closed_at AS "closedAt" FROM session_dispatch_receipts d JOIN session_usage u ON u.session_id=d.session_id JOIN worker_sessions s ON s.id=d.session_id WHERE u.kind=\'work\' AND s.owner_hash=? AND (CAST(? AS TEXT) IS NULL OR d.runner_id=?) AND d.platform_json IS NOT NULL AND (d.platform_json::jsonb #>> \'{name}\')=? AND u.closed_at>?',
      ownerHash,
      runnerId ?? null,
      runnerId ?? null,
      platform,
      new Date(this.clock() - backoffMs).toISOString(),
    );
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
    this.enter();
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
      ? await this.state.snapshotTransaction(
          async (tx) => (await this.hooks.managed.require(caller, tx)).sourceCaller,
        )
      : caller;
    await this.hooks.prepare(preparedCaller);
    // A candidate whose offer cannot be built (a context past its recipe's budget) must
    // not stop the queue behind it: its failure rolls the attempt back and the next
    // candidate is tried. The runner is answered with the decision, never one target's error.
    const skipped = new Set<string>();
    for (;;) {
      try {
        return await this.leaseOnce(caller, input, skipped);
      } catch (error) {
        if (!(error instanceof PoisonedOffer)) throw error;
        const key = targetKey(error.candidate);
        skipped.add(key);
        if (error.silent) this.passed.set(`${error.owner} ${key}`, this.clock() + backoffMs);
        else await this.poisoned(error.caller ?? preparedCaller, error.candidate, error.cause);
      }
    }
  }
  private async leaseOnce(
    caller: Caller,
    input: AutomaticLease,
    skipped: Set<string>,
  ): Promise<{ session: Session | null; reason: string }> {
    // An idle poll is decided on a snapshot; an offer or a new decision takes the writer.
    return await readFirst(this.state, async (tx) => {
      const managed = caller.managed ? await this.hooks.managed.lease(caller, input, tx) : null;
      let effectiveCaller = managed?.sourceCaller ?? caller;
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
            await this.hooks.managed.hasSession(managed.row, old.session_id, tx),
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
        const replay = (await tx.get<SessionRow>(
          'SELECT thread_id,session_json FROM worker_sessions WHERE id=?',
          old.session_id,
        ))!;
        return {
          session: { ...JSON.parse(replay.session_json), threadId: replay.thread_id },
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
      if (managed && !(await this.hooks.managed.reusable(managed.row, tx)))
        return { session: null, reason: await decided('capacity_full') };
      // A project on its own machines gives a rented one no new work; one it holds runs out.
      const open = async () => {
        const dispatch = await this.dispatch(caller.projectId, tx);
        return dispatch.enabled && !(managed && dispatch.ownMachines);
      };
      if (!(await open())) return { session: null, reason: await decided('dispatch_disabled') };
      if (managed) await this.hooks.managed.admits(managed.row, tx);
      // A rented machine takes no work while its person has no model tokens left today: the
      // relay would refuse the visit's calls. The wait is said on the work, and lifts with it.
      if (managed && (await this.modelWaits(managed.row, tx)))
        return { session: null, reason: await decided('model_budget_exhausted') };
      // A hosted machine stops at its allocation's end, so its step must end five minutes
      // before. A work host starts a step only with all of the step's time left (its owner rents
      // a fresh host for the next); another machine, with ten minutes. An inquiry needs only its
      // own short visit.
      const left = managed
        ? Math.floor((Date.parse(managed.row.control_expires_at) - this.clock()) / 1000) - 300
        : Infinity;
      const expiring = () =>
        check(
          left >= (managed?.row.step_seconds ? Number(managed.row.step_seconds) : 300),
          'managed_expiring',
          'Managed machine has too little time for a step',
          409,
        );
      if (left < INQUIRY_VISIT_SECONDS) expiring();
      const admission = await this.admitRunner(owner.hash, input, tx);
      if (!admission.ok) return { session: null, reason: await decided(admission.reason) };
      const { runner, platform } = admission;
      const capabilities = new Set(
        (JSON.parse(runner.presence_json) as RunnerHeartbeat).capabilities ?? [],
      );
      const sources = managed
        ? await this.hooks.managed.sources(managed.row, tx)
        : [effectiveCaller];
      /** What every offer this lease makes ends with: its admission again, and its receipt. */
      const land = async (session: Session, source: Caller) => {
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
        await recorded(this.state, tx, source, 'session.dispatched', session.id, {
          sessionId: session.id,
          instanceId: session.instanceId,
          runnerRef: runner.id,
          platform: input.platform,
          ...(session.kind === 'inquiry' && { inquiryId: session.inquiry.id }),
        });
        return { session, reason: await decided('offered') };
      };
      // A person waits on a question, and its visit is short: a machine that runs inquiry
      // visits takes one before new work. It holds no lease on the work, so the work's own
      // visit, due meanwhile, is offered as ever, and resumes the conversation as it was. Its
      // token budget is held: a hosted machine's by Fleet's model relay call by call, a machine
      // of the owner's own by its runner, which stops the visit once Claude Code's running
      // report passes it. Codex reports its spend only as its one turn ends, so only a hosted
      // machine takes a Codex inquiry.
      if (capabilities.has(INQUIRY_CAPABILITY) && (managed || platform.harness === 'claude'))
        for (const source of sources) {
          // The project's budget holds back inquiries as it holds back work.
          if (await this.projectWithholds(source, tx)) continue;
          const phaseOwner = await ownerOf(this.scope, source, tx);
          // A refusal is of one question: a few more are tried before the lease goes on to work.
          const refused: string[] = [];
          while (refused.length < INQUIRY_TRIES) {
            const inquiry = await this.hooks.inquiries.candidate(
              tx,
              caller.projectId,
              phaseOwner.hash,
              platform.harness,
              managed?.row.work_instance_id ?? null,
              refused,
            );
            if (!inquiry) break;
            if (this.state.readScope)
              throw new MervError('read_only_scope', 'An offer is a write', 409);
            const session = await this.hooks.inquiries.offer(
              source,
              inquiry,
              {
                runnerId: input.runnerId,
                requestId: input.requestId,
                secret: input.secret,
                hardDeadlineSeconds: Math.min(input.hardDeadlineSeconds ?? 86400, left),
              },
              tx,
            );
            if ('refused' in session) {
              process.stderr.write(
                `${JSON.stringify({ event: 'dispatch.inquiry_refused', inquiryId: inquiry.id, code: session.refused.code })}\n`,
              );
              refused.push(inquiry.id);
              continue;
            }
            return await land(session, source);
          }
        }
      expiring();
      let candidate: Target | undefined;
      let assignmentOwner = owner;
      let reason: DispatchDecision = 'no_candidates';
      for (const source of sources) {
        const phaseOwner = await ownerOf(this.scope, source, tx);
        const failures = await this.recentFailures(
          tx,
          phaseOwner.hash,
          platform.name,
          managed ? undefined : input.runnerId,
        );
        const selected = await this.eligibleCandidates(
          source,
          tx,
          capabilities,
          failures,
          new Set([...skipped, ...this.passing(phaseOwner.hash)]),
        );
        candidate = selected.candidates.find(
          (item) => !managed || item.instanceId === managed.row.work_instance_id,
        );
        reason = selected.reason ?? reason;
        if (candidate) {
          effectiveCaller = source;
          assignmentOwner = phaseOwner;
          break;
        }
      }
      if (!candidate) return { session: null, reason: await decided(reason) };
      // A snapshot found work: the writer decides again, and builds the offer.
      if (this.state.readScope) throw new MervError('read_only_scope', 'An offer is a write', 409);
      const session = await this.hooks
        .offer(
          effectiveCaller,
          {
            instanceId: candidate.instanceId,
            expectedRevision: candidate.expectedRevision,
            runnerId: input.runnerId,
            requestId: input.requestId,
            secret: input.secret,
            hardDeadlineSeconds: Math.min(
              input.hardDeadlineSeconds ?? 86400,
              left,
              managed ? Number(managed.row.step_seconds) : Infinity,
            ),
          },
          tx,
        )
        .catch((error: unknown) => {
          const status = (error as { status?: number })?.status ?? 500;
          // No hold counts a server fault or a refusal of who asked, and the whole lease rolls
          // back, leaving no decision or event: only this says why the work is passed over.
          const silent = status >= 500 || status === 401 || status === 403;
          if (silent)
            process.stderr.write(
              `${JSON.stringify({
                event: 'dispatch.offer_failed',
                instanceId: candidate.instanceId,
                status,
                code: (error as { code?: unknown })?.code ?? null,
                message: String((error as Error)?.message ?? error).slice(0, 300),
              })}\n`,
            );
          throw new PoisonedOffer(
            { instanceId: candidate.instanceId, expectedRevision: candidate.expectedRevision },
            error,
            assignmentOwner.hash,
            silent,
            effectiveCaller,
          );
        });
      return await land(session, effectiveCaller);
    });
  }
}
