import {
  mapAsync,
  type Caller,
  type Transaction,
  type WorkflowProvidedBlocker,
  type WorkflowDispatchCandidate,
} from '@merv/contracts';
import type {
  DispatchState,
  RunnerPresence,
  Session,
  SessionSummary,
  SessionsProjectStatus,
  StuckItem,
  StuckKind,
  StuckReport,
} from './types.js';
import { publicBudget } from './usage.js';
import { lastActivity } from './observations.js';
import { HOLD_PROVIDER, isoNow, targetKey, workNameOf } from './common.js';
import { leaseLiveness } from './liveness.js';
import type { DispatchContext, HoldRow, SessionDispatch, SessionRow } from './dispatch.js';
import { freshForMs, rented, type RunnerRow } from './runners.js';

// Why admitted work does not move: one reading of dispatch, worded as session.stuck, the
// project status and the Running board. SessionDispatch (dispatch.ts) runs these with itself
// as their context.
/** How long a target whose offer failed or was put off waits before it is offered again. */
export const backoffMs = 30_000;
export type Failure = Pick<Session, 'instanceId' | 'expectedRevision' | 'outcome' | 'closedAt'>;
type Close = Failure & Pick<Session, 'id' | 'deferral'>;
/**
 * The closes that count against nobody: the machine was ready and willing, and the place this
 * work's history lives was away, busy or full. No hold can form from them; they only space the
 * attempts out, exactly as a failure's backoff does.
 */
export const deferredReasons = new Set(['preparation_deferred', 'machine_retired']);
/** How long three deferred closes in a row must run before an operator is told about them. */
const deferredRun = 3;
const deferredSinceMs = 7 * 24 * 3600_000;

/** The latest closes, not the latest deferred closes: one other outcome breaks the run.
 * Callers supply the targets their own read admits; this does not load or authorize work. */
function deferredRuns<T extends Failure>(
  closes: T[],
  waiting: { has(key: string): boolean },
  failing: ReadonlySet<string>,
  since: string,
): Map<string, T[]> {
  const runs = new Map<string, T[]>();
  for (const close of closes) {
    const key = targetKey(close);
    if (!close.closedAt || close.closedAt <= since || !waiting.has(key) || failing.has(key))
      continue;
    const run = runs.get(key) ?? [];
    run.push(close);
    runs.set(key, run);
  }
  for (const [key, run] of runs) {
    const last = run
      .sort((a, b) => (a.closedAt! < b.closedAt! ? 1 : a.closedAt === b.closedAt ? 0 : -1))
      .slice(0, deferredRun);
    if (
      last.length < deferredRun ||
      !last.every((close) => deferredReasons.has(close.outcome ?? ''))
    )
      runs.delete(key);
    else runs.set(key, last);
  }
  return runs;
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
/** Why queued work does not start: the first of the reading's stalls. */
export type DispatchStall = 'dispatch_disabled' | 'no_live_runner' | 'runner_refusing';
/**
 * What the Running board reads of dispatch, as codes and counts that running.ts words. These
 * come from the same reading as session.stuck, read narrowly for a page that polls: see
 * SessionDispatch.running.
 */
export interface DispatchReading {
  /**
   * An operator may pause, start and halt, and is the one told what the queue holds: how much
   * waits and why, what is still retried or put off, and which ready work nobody took.
   */
  operator: boolean;
  dispatch: DispatchState;
  /** Fleet rents machines for this project's automatic work. */
  fleet: boolean;
  /** Any runner is present, the project's own or Fleet's: the Sessions page's running or waiting. */
  present: boolean;
  /** The project's own live runners and their free slots; the machines Fleet rents are Fleet's. */
  machines: { live: number; free: number };
  /** Queued steps, for an operator; null for anyone else. */
  waiting: number | null;
  /** A machine Fleet rents is named as one; its hostname says nothing. */
  stall: { code: DispatchStall; machine?: string; rented?: true } | null;
  /**
   * Targets whose launches failed at their current revision: held, for every reader; still
   * retried, for an operator, and only while the scan still offers them.
   */
  failures: { instanceId: string; revision: number; attempts: number; held: boolean }[];
  /**
   * Targets the last machines to take them could not prepare, three closes running, for an
   * operator, while the scan still offers them.
   */
  deferred: { instanceId: string; attempts: number }[];
  /** Ready work waiting beyond quietReadySeconds; operator only. */
  quiet: {
    instanceId: string;
    since: string;
    code: 'queued' | 'budget_exceeded' | 'usage_unavailable' | 'awaiting_operator';
  }[];
}
/** A runner as the dispatch reading holds it: whether Fleet rents it, and its live leases. */
type Runner = RunnerPresence & { rented: boolean; busy: number };
type Admissible = Awaited<ReturnType<SessionDispatch['candidates']>>;
/** One reading of why admitted work does not move; see readingOf. */
interface Reading {
  dispatch: DispatchState;
  /** Fleet rents machines for this project's automatic work. */
  fleet: boolean;
  runners: Runner[];
  /** The queue's length, by the scan; none without it. */
  queued: number;
  /** Failing targets at their record's current revision that no live session holds. */
  holds: HoldRow[];
  /** Admitted work no live session holds, by targetKey. */
  waiting: Map<string, WorkflowDispatchCandidate>;
  /** Targets the last machines to take them could not prepare, three closes running. */
  deferred: Map<string, Close[]>;
  /** Ready work waiting beyond quietReadySeconds. */
  quiet: { item: WorkflowDispatchCandidate; code: DispatchReading['quiet'][number]['code'] }[];
  /** Why queued work does not start, in this order; nothing while nothing is queued. */
  stalls: (
    | { code: 'dispatch_disabled' }
    | { code: 'no_live_runner' }
    | { code: 'runner_refusing'; runner: Runner }
  )[];
}
/**
 * Whether a runner takes any work at all: some platform it advertises is on, on the machine
 * and in its server-owned settings, and it has applied the settings last published.
 * admitRunner's rule, asked of the runner rather than of one lease request.
 */
const takesWork = (runner: RunnerPresence) =>
  runner.desiredVersion <= (runner.appliedVersion ?? 0) &&
  runner.platforms.some((platform) => {
    const desired = runner.desiredSettings.platforms.find((item) => item.name === platform.name);
    return (
      platform.enabled && desired?.enabled !== false && (runner.desiredVersion === 0 || !!desired)
    );
  });
/**
 * The most recently seen runners, which is where every live one is, each with whether Fleet
 * rents it and, while it is fresh, the leases it holds.
 */
async function runnersOf(
  ctx: DispatchContext,
  projectId: string,
  tx: Transaction,
): Promise<Runner[]> {
  const rows = await tx.all<RunnerRow & { busy: number; rented: boolean }>(
    `SELECT r.*,CASE WHEN r.last_seen_at>? THEN (SELECT COUNT(*) FROM worker_sessions s WHERE (s.owner_hash=r.owner_hash OR EXISTS (SELECT 1 FROM session_managed_assignments a JOIN session_managed_runners m ON m.allocation_id=a.allocation_id WHERE a.session_id=s.id AND m.project_id=r.project_id AND m.runner_id=r.runner_id)) AND s.runner_id=r.runner_id AND s.status IN ('offered','active')) ELSE 0 END AS busy,
      EXISTS (${rented}) AS rented
      FROM session_runners r WHERE r.project_id=? AND NOT EXISTS (${rented} AND m.runner_released_at IS NOT NULL) ORDER BY r.last_seen_at DESC,r.id LIMIT 100`,
    new Date(ctx.clock() - freshForMs).toISOString(),
    projectId,
  );
  return await mapAsync(rows, async (row) => ({
    ...(await ctx.presence(row, tx)),
    busy: Number(row.busy),
    rented: row.rented,
  }));
}
/**
 * Why admitted work does not move, read once for attention() and running(), on the caller's
 * transaction. `admissible` is the candidate scan, run as the reader; without it (a reader the
 * queue is not told to) nothing is said of the queue, only of the holds. Only reads.
 */
async function readingOf(
  ctx: DispatchContext,
  projectId: string,
  tx: Transaction,
  admissible: Admissible | null,
): Promise<Reading> {
  const now = ctx.clock();
  const dispatch = await ctx.dispatch(projectId, tx);
  const fleet = ctx.hooks.managed.serves(projectId);
  const runners = await runnersOf(ctx, projectId, tx);
  const live = runners.filter((runner) => runner.live);
  // A held target is read at the record's current revision where no session holds it, so
  // every reader sees the same red.
  const unheld = await tx.all<HoldRow>(
    `SELECT h.* FROM session_dispatch_holds h WHERE h.project_id=? AND h.attempts>0
      AND NOT EXISTS (SELECT 1 FROM worker_sessions l WHERE l.project_id=h.project_id AND l.instance_id=h.instance_id AND l.revision=h.revision AND l.status IN ('offered','active'))`,
    projectId,
  );
  const at = await ctx.workflows.revisions(
    projectId,
    unheld.map((row) => row.instance_id),
    tx,
  );
  const holds = unheld.filter((row) => at.get(row.instance_id)?.revision === row.revision);
  const read = { dispatch, fleet, runners, holds };
  if (!admissible)
    return { ...read, queued: 0, waiting: new Map(), deferred: new Map(), quiet: [], stalls: [] };
  const { all, live: leased, queue, spent, unaccounted, asking } = admissible;
  // A target with a live session is being tried right now, so it is not waiting on anyone.
  const waiting = new Map(
    all
      .filter((item) => item.role !== 'operator' && !leased.has(targetKey(item)))
      .map((item) => [targetKey(item), item]),
  );
  const failing = new Set(
    holds.map((row) => `${row.instance_id}:${row.revision}`).filter((key) => waiting.has(key)),
  );
  const recent = new Date(now - deferredSinceMs).toISOString();
  // A target nobody could prepare a checkout for is not failing and is never held, so no
  // counter would ever show it. A run of deferred closes is what says it is not simply
  // quiet: where that work's history lives has been away, busy or full since then. The
  // closes are read from their usage rows; only a deferred one's lease is parsed, for why.
  const deferred = deferredRuns(
    await tx.all<Close>(
      `SELECT u.session_id AS id,u.instance_id AS "instanceId",u.revision AS "expectedRevision",u.outcome,u.closed_at AS "closedAt",
        CASE WHEN u.outcome='preparation_deferred' THEN s.session_json::jsonb #> '{deferral}' END AS deferral
        FROM session_usage u JOIN worker_sessions s ON s.id=u.session_id WHERE u.project_id=? AND u.closed_at>?`,
      projectId,
      recent,
    ),
    waiting,
    failing,
    recent,
  );
  const quiet = all.flatMap((item) => {
    const key = targetKey(item),
      step = item.role === 'operator';
    // With dispatch off, one dispatch_disabled item says why all of them wait.
    // Work whose agent asked its owner says so through its blocker (work_blocked).
    if (
      leased.has(key) ||
      asking.has(item.instanceId) ||
      failing.has(key) ||
      deferred.has(key) ||
      Date.parse(item.updatedAt) + ctx.thresholds.quietReadySeconds * 1000 > now ||
      (!step && !dispatch.enabled)
    )
      return [];
    const code = step
      ? 'awaiting_operator'
      : unaccounted.has(item.instanceId)
        ? 'usage_unavailable'
        : spent.has(item.instanceId)
          ? 'budget_exceeded'
          : 'queued';
    return [{ item, code } as const];
  });
  // Why the queue does not start; where Fleet rents for this project, its machines are the
  // runners that take the work.
  const refusing = (runner: Runner) =>
    (runner.lastDecision === 'settings_pending' || runner.lastDecision === 'platform_disabled') &&
    !!runner.decisionSince &&
    Date.parse(runner.decisionSince) + ctx.thresholds.refusalSeconds * 1000 <= now;
  const stalls: Reading['stalls'] = !queue.length
    ? []
    : !dispatch.enabled
      ? [{ code: 'dispatch_disabled' }]
      : [
          ...(live.length || fleet ? [] : [{ code: 'no_live_runner' as const }]),
          ...live.filter(refusing).map((runner) => ({ code: 'runner_refusing' as const, runner })),
        ];
  return { ...read, queued: queue.length, waiting, deferred, quiet, stalls };
}
/**
 * Everything that stopped moving, derived from the rows at the moment of the read: the
 * dispatch reading, with the idle sessions and the blockers owners published. It only
 * reads: a session idle here is reported whether or not the sweep has marked it, and the
 * mark itself stays the sweep's. The words in `why` and `next` are advice; what they
 * describe is enforced by the transaction that leases, closes or releases.
 */
async function attention(
  ctx: DispatchContext,
  projectId: string,
  tx: Transaction,
  reading: Reading,
  facts: {
    activity: Map<string, string>;
    blockers: WorkflowProvidedBlocker[];
  },
): Promise<StuckReport> {
  const now = ctx.clock(),
    observedAt = isoNow(ctx.clock),
    limits = ctx.thresholds;
  const { runners, dispatch, waiting, deferred, quiet } = reading;
  const { activity } = facts;
  const older = (since: string, seconds: number) => Date.parse(since) + seconds * 1000 <= now;
  const items: StuckItem[] = [];
  const add = (item: Omit<StuckItem, 'forSeconds'>) =>
    items.push({
      ...item,
      forSeconds: Math.max(0, Math.floor((now - Date.parse(item.since)) / 1000)),
    });
  for (const session of await tx.all<
    Pick<Session, 'id' | 'instanceId' | 'expectedRevision' | 'activatedAt'> & { label: string }
  >(
    `SELECT s.id,s.instance_id AS "instanceId",s.revision AS "expectedRevision",x.j #>> '{activatedAt}' AS "activatedAt",x.j #>> '{assignment,label}' AS label
      FROM worker_sessions s CROSS JOIN LATERAL (SELECT s.session_json::jsonb AS j OFFSET 0) x WHERE s.project_id=? AND s.status='active'`,
    projectId,
  )) {
    const since = lastActivity(session, activity.get(session.id));
    if (since === null || !older(since, limits.idleNoticeSeconds)) continue;
    add({
      kind: 'session_idle',
      instanceId: session.instanceId,
      expectedRevision: session.expectedRevision,
      sessionId: session.id,
      label: session.label,
      since,
      code: 'idle',
      why: 'No recent Merv activity: the session is alive and has made no Merv tool call since then. That is not evidence the work is stuck — it may be computing locally, waiting on a remote job or using another service, none of which the server sees.',
      next: `Check the worker before acting. Nothing closes a session for silence; it ends at its lease deadline, or when an admin halts it with POST /sessions/${encodeURIComponent(session.id)}/halt {}. Halting the worker does not stop a remote job it started, and the retry may start that job again.`,
    });
  }
  for (const row of reading.holds) {
    const item = waiting.get(`${row.instance_id}:${row.revision}`);
    if (!item) continue;
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
  for (const [key, last] of deferred) {
    const item = waiting.get(key)!,
      newest = last[0];
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
  for (const { item, code } of quiet) {
    const { instanceId, expectedRevision, label, updatedAt: since } = item;
    add({
      kind: 'ready_quiet',
      instanceId,
      expectedRevision,
      label,
      since,
      code,
      why: 'This step is ready and no session holds it. The clock is the record’s last revision change, so a step released after a long session is quiet at once.',
      next:
        code === 'awaiting_operator'
          ? 'It is an operator’s step: no runner is ever offered it. workflow.status_and_next on the instance names the action.'
          : code === 'usage_unavailable'
            ? 'A budget covers it that cannot be judged: a session in its scope was activated and reported no usage, or the dependency closure it budgets is too large to walk. usage.read names the budget and the unreported count; the usage arriving, or usage.set_budget clearing that bound, resumes it.'
            : code === 'budget_exceeded'
              ? 'A reached budget withholds it; usage.read shows which, and usage.set_budget raises or clears it.'
              : 'Read the other items of this report for the cause; a runner with free capacity takes it on its next poll.',
    });
  }
  for (const stall of reading.stalls)
    if (stall.code === 'dispatch_disabled')
      add({
        kind: 'dispatch_disabled',
        since: dispatch.updatedAt ?? observedAt,
        code: 'dispatch_disabled',
        why: `${reading.queued} queued step${reading.queued === 1 ? ' waits' : 's wait'} while automatic dispatch is off.`,
        next: 'An admin turns it on with PUT /sessions/dispatch {"enabled":true}. Work can still be offered by hand.',
      });
    else if (stall.code === 'no_live_runner')
      add({
        kind: 'no_live_runner',
        since: runners[0]?.lastSeenAt ?? observedAt,
        code: 'no_live_runner',
        why: runners.length
          ? `Dispatch is on and work is queued, but no authorized runner has been seen in the last ${freshForMs / 1000} seconds.`
          : 'Dispatch is on and work is queued, but no runner has ever registered in this project.',
        next:
          dispatch.fleet && !dispatch.ownMachines
            ? 'Fleet serves a project as its owner, its longest-standing signed-in operator, while they may write and Fleet lists them; otherwise start a runner on a machine that holds a write key of this project.'
            : 'Start a runner on a machine that holds a write key of this project.',
      });
    else {
      const { runner } = stall,
        code = runner.lastDecision;
      add({
        kind: 'runner_refusing',
        runnerRef: runner.id,
        label: runner.runnerId,
        since: runner.decisionSince!,
        code: code!,
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
export async function stuck(ctx: DispatchContext, caller: Caller): Promise<StuckReport> {
  ctx.enter(caller);
  caller = structuredClone(caller);
  return await ctx.state.transaction(async (tx) => {
    await ctx.ordinary(caller, 'read', tx);
    const admissible = await ctx.candidates(caller, tx);
    return await attention(
      ctx,
      caller.projectId,
      tx,
      await readingOf(ctx, caller.projectId, tx, admissible),
      {
        activity: await ctx.observations.activity(tx, caller.projectId),
        // A hold is reported as dispatch_held, not again as what it publishes.
        blockers: (await ctx.workflows.blockers(caller, undefined, tx)).filter(
          (blocker) => blocker.provider !== HOLD_PROVIDER,
        ),
      },
    );
  });
}
/** With `report`, `stuck` is the whole report session.stuck reads, from the same moment. */
export async function projectStatus(
  ctx: DispatchContext,
  caller: Caller,
  report = false,
): Promise<SessionsProjectStatus> {
  ctx.enter(caller);
  caller = structuredClone(caller);
  return await ctx.state.transaction(async (tx) => {
    const actor = await ctx.ordinary(caller, 'read', tx);
    const activity = await ctx.observations.activity(tx, caller.projectId);
    const now = ctx.clock();
    const sessions: SessionSummary[] = (
      await tx.all<
        SessionRow & {
          label: string;
          name: string;
          workflow: string | null;
          workspace_mode: SessionSummary['workspaceMode'] | null;
          runner_ref: string | null;
          platform_json: string | null;
          attachment_json: string | null;
          result_json: string | null;
        }
      >(
        // A frozen assignment can be half a megabyte: the 200 rows are chosen first, and each is
        // parsed once, in SQL, and sent without its assignment, execution, lease and source.
        `SELECT s.id,s.thread_id,(x.j - '{assignment,execution,lease,source}'::text[])::text AS session_json,x.j #>> '{assignment,label}' AS label,
          ${workNameOf('x.j')} AS name,x.j #>> '{execution,workflow}' AS workflow,x.j #>> '{execution,policy,workspace,mode}' AS workspace_mode,d.runner_ref,d.platform_json,w.attachment_json,w.result_json
          FROM (SELECT * FROM worker_sessions WHERE project_id=? ORDER BY CASE WHEN status IN ('offered','active') THEN 0 ELSE 1 END,_merv_rowid DESC LIMIT 200) s
          CROSS JOIN LATERAL (SELECT s.session_json::jsonb AS j OFFSET 0) x LEFT JOIN session_dispatch_receipts d ON d.session_id=s.id
          LEFT JOIN session_workspaces w ON w.session_id=s.id ORDER BY CASE WHEN s.status IN ('offered','active') THEN 0 ELSE 1 END,s._merv_rowid DESC`,
        caller.projectId,
      )
    ).map((row) => {
      const session: Omit<Session, 'assignment' | 'execution'> = JSON.parse(row.session_json);
      const lastActivityAt =
        session.status === 'active' ? lastActivity(session, activity.get(session.id)) : null;
      // Quiet from the moment the idle clock passed its notice; nothing is stored for it.
      const quietAt = lastActivityAt
        ? Date.parse(lastActivityAt) + ctx.thresholds.idleNoticeSeconds * 1000
        : Infinity;
      const quietSince = quietAt <= now ? new Date(quietAt).toISOString() : null;
      return {
        id: session.id,
        threadId: row.thread_id,
        actorId: session.actorId,
        instanceId: session.instanceId,
        ...(row.workflow ? { workflow: row.workflow } : {}),
        expectedRevision: session.expectedRevision,
        role: session.role,
        status: session.status,
        label: row.label,
        name: row.name,
        runnerRef: row.runner_ref,
        hostRef: session.hostRef,
        platform: row.platform_json ? JSON.parse(row.platform_json) : null,
        createdAt: session.createdAt,
        activatedAt: session.activatedAt,
        expiresAt: session.expiresAt,
        closedAt: session.closedAt,
        closeReason: session.closeReason,
        outcome: session.outcome ?? null,
        liveness: leaseLiveness(session, now),
        lastActivityAt,
        quietSince,
        workspaceMode: row.workspace_mode ?? 'none',
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
    const admissible = await ctx.candidates(caller, tx);
    const { queue, retriesExhausted, budgets } = admissible;
    const reading = await readingOf(ctx, caller.projectId, tx, admissible);
    const stuck = await attention(ctx, caller.projectId, tx, reading, {
      activity,
      // A hold is reported as dispatch_held, not again as what it publishes.
      blockers: (await ctx.workflows.blockers(caller, undefined, tx)).filter(
        (blocker) => blocker.provider !== HOLD_PROVIDER,
      ),
    });
    return {
      // One transaction, one moment: agents cannot report a lease the leases do not.
      agents: await ctx.observations.summaries(tx, caller.projectId),
      observedAt: stuck.observedAt,
      liveSessionCount: counts.live,
      sessionTotal: counts.total,
      runnerTotal,
      canManage: actor.role === 'operator',
      dispatch: reading.dispatch,
      runners: reading.runners.map(({ busy: _busy, rented: _rented, ...runner }) => runner),
      sessions,
      queue: queue.slice(0, 200),
      queueTotal: queue.length,
      budgets: budgets.map(publicBudget),
      retriesExhausted,
      stuck: report ? stuck : { total: stuck.total, counts: stuck.counts },
    };
  });
}
/**
 * The dispatch reading for the Running board, read narrowly because the page polls. Nothing
 * decodes a whole lease. What the queue holds comes from the candidate scan, which runs each
 * domain's lease rule as the viewer, and a domain refuses most viewers: a reader would count
 * none of the queue and a producer only their own share. So the scan runs for an operator
 * alone, who is told how much waits and why, what is still retried or put off, and which
 * ready work nobody took; nobody else pays for it. Only reads, on the caller's snapshot.
 */
export async function running(
  ctx: DispatchContext,
  caller: Caller,
  tx: Transaction,
): Promise<DispatchReading> {
  const operator = (await ctx.ordinary(caller, 'read', tx)).role === 'operator';
  const admissible = operator ? await ctx.candidates(caller, tx) : null;
  const { dispatch, fleet, runners, queued, holds, deferred, quiet, stalls } = await readingOf(
    ctx,
    caller.projectId,
    tx,
    admissible,
  );
  const live = runners.filter((runner) => runner.live);
  const own = live.filter((runner) => !runner.rented);
  const offered = new Set(admissible?.all.map((item) => targetKey(item)));
  const [stall] = stalls;
  return {
    operator,
    dispatch,
    fleet,
    present: live.length > 0,
    machines: {
      live: own.length,
      free: own
        .filter(takesWork)
        .reduce((free, runner) => free + Math.max(0, runner.capacity - runner.busy), 0),
    },
    waiting: admissible ? queued : null,
    // A machine Fleet rents is named as one; its hostname says nothing.
    stall: !stall
      ? null
      : stall.code !== 'runner_refusing'
        ? { code: stall.code }
        : stall.runner.rented
          ? { code: stall.code, rented: true }
          : { code: stall.code, machine: stall.runner.machine.hostname },
    // Held, for every reader; still retried, for an operator, while the scan still offers it.
    failures: holds
      .filter((row) => row.held_at || offered.has(`${row.instance_id}:${row.revision}`))
      .map((row) => ({
        instanceId: row.instance_id,
        revision: row.revision,
        attempts: row.attempts,
        held: !!row.held_at,
      })),
    deferred: [...deferred.values()].map((last) => ({
      instanceId: last[0].instanceId,
      attempts: last.length,
    })),
    quiet: quiet.map(({ item, code }) => ({
      instanceId: item.instanceId,
      since: item.updatedAt,
      code,
    })),
  };
}
