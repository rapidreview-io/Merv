import {
  check,
  MervError,
  newId,
  type Caller,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { WorkflowProvidedBlockerInput } from '@merv/workflows/models';
import { nativeRevisionContinuity } from '@merv/workflows/native-continuity';
import { computeProfile } from './compute.js';
import { isoNow, ordinary, ownLive, text, type Row } from './common.js';
import type {
  ComputeStates,
  ComputeTarget,
  ComputeTargetState,
  ComputeWaitInput,
  ComputeWaiter,
  ComputeWaitView,
  ComputeWake,
  Session,
  SessionComputeWaits,
} from './types.js';

const DEFAULT_MINUTES = 1440;
const MAX_MINUTES = 10_080;
const MAX_TARGETS = 20;
/** How long the waiter may take to answer, at a call or in the sweep. */
const WAITER_MS = 10_000;
/** How long whether a project is served may take: an attach and a tool listing wait for it. */
const OFFERS_MS = 2_000;
/** A wait ends this long before a machine its compute runs on is deleted, so the visit it wakes
 *  can renew that machine, and this long after its compute must have ended, so a hung run holds
 *  the work no longer. */
const LEASE_MARGIN_MS = 15 * 60_000;
const DEADLINE_MARGIN_MS = 10 * 60_000;
/** A wait that would end sooner is no reason to end a visit. */
const SHORTEST_MS = 5 * 60_000;

type Outcome = ComputeWake['outcome'] | 'moved';
interface WaitRow {
  id: string;
  project_id: string;
  thread_id: string;
  session_id: string;
  instance_id: string;
  revision: number | string;
  reason: string;
  targets_json: string;
  created_at: string;
  wait_until: string;
  settled_at: string | null;
  outcome: Outcome | null;
}

/** What waits use of Sessions: its transactions and session rows, a visit's close, blockers. */
export interface ComputeWaitHost {
  transaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
  reading<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
  row(tx: Transaction, id: string): Promise<Row>;
  decode(row: Row): Session;
  /** Closes a visit that ended to wait for its compute: released, not counted against the work. */
  awaited(session: Session, tx: Transaction): Promise<void>;
  /** Where these work items of the project stand: each one's revision, and whether it ended. */
  work(
    projectId: string,
    instanceIds: string[],
    tx: Transaction,
  ): Promise<Map<string, { revision: number; ended: boolean }>>;
  /** Sessions' waits on one work item, as Workflows keeps them for its gate. */
  publish(
    input: { projectId: string; instanceId: string; blockers: WorkflowProvidedBlockerInput[] },
    tx: Transaction,
  ): Promise<void>;
}

/**
 * Whether a visit may end to wait for its compute: a work visit that keeps a conversation and
 * executes on Sandboxes, unless its workflow keeps that wait inside its visits (the execution
 * reference `computeWait: 'inside'`).
 */
const waitable = (session: Readonly<Session>) =>
  session.kind === 'work' &&
  !!session.continuity &&
  session.execution.references.computeKind !== undefined &&
  session.execution.references.computeWait !== 'inside' &&
  computeProfile(session.execution.policy, session.execution.references.computeProfile) ===
    'execute';
/** A wait is over once nothing it names runs, or as soon as one ended other than it should. */
const over = (targets: readonly ComputeTargetState[]) =>
  targets.every((target) => target.status !== 'running') ||
  targets.some((target) => target.status === 'failed' || target.status === 'unknown');
/** One target as a refusal and a woken worker read it. */
export const phrase = ({ kind, id, status, state, exitCode }: ComputeTargetState) =>
  `${kind} ${id} ${status === 'unknown' ? 'no longer found' : (state ?? status).replaceAll('_', ' ')}${exitCode === undefined ? '' : ` (exit ${exitCode})`}`;
/** What `promise` gives, or a rejection once `ms` have passed. */
const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The compute waiter timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
/** Sandboxes did not answer in time: the call changed nothing and may be made again. */
const unreachable = () =>
  new MervError(
    'compute_unreachable',
    'Sandboxes did not say where these stand, so nothing changed and your visit goes on: call again in a minute',
    503,
  );
const listed = (ids: unknown): unknown[] =>
  ids === undefined ? [] : Array.isArray(ids) ? ids : [undefined];
const wake = (row: WaitRow): ComputeWake => ({
  awaitedAt: row.created_at,
  reason: row.reason,
  outcome: row.outcome as ComputeWake['outcome'],
  until: row.wait_until,
  settledAt: row.settled_at!,
  // An open wait's targets are written only where a status moves: one still running is said by
  // its status, not by a state that may be old, unless the read that ended the wait wrote them.
  targets: (JSON.parse(row.targets_json) as ComputeTargetState[]).map((target) =>
    row.outcome === 'ended' || target.status !== 'running'
      ? target
      : { kind: target.kind, id: target.id, status: target.status },
  ),
});

/**
 * A worker's wait for its Sandboxes compute (`session.await_compute`): its visit ends, uncounted,
 * and dispatch withholds the revision until the wait settles: once everything it names has ended
 * or one failed (the sweep asks the one registered waiter), at its until, or sooner when a person
 * messages the thread or offers the work by hand. The visit after it is told how it ended.
 */
export class ComputeWaits implements SessionComputeWaits {
  private waiter?: ComputeWaiter;
  private sweeping?: Promise<void>;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly clock: () => number,
    private readonly host: ComputeWaitHost,
  ) {}
  register(waiter: ComputeWaiter): () => void {
    check(!this.waiter, 'compute_waiter_registered', 'A compute waiter is already registered', 409);
    this.waiter = waiter;
    // Unloading settles nothing: a restart would otherwise wake every waiting work.
    return () => {
      if (this.waiter === waiter) this.waiter = undefined;
    };
  }
  async available(session: Readonly<Session>): Promise<boolean> {
    // A Sandboxes that does not answer holds up no attach or listing: the tool is not offered.
    return (await this.offers(session)) ?? false;
  }
  /** Whether the visit is offered the tool, or undefined where Sandboxes did not say in time. */
  private async offers(session: Readonly<Session>): Promise<boolean | undefined> {
    const waiter = this.waiter;
    if (!waiter || !waitable(session)) return false;
    return await within(waiter.offers(session.projectId), OFFERS_MS).catch(() => undefined);
  }
  async await(caller: Caller, input: ComputeWaitInput): Promise<ComputeWaitView> {
    ordinary(caller);
    check(caller.session, 'session_required', 'Only an assigned worker waits for its compute', 403);
    const asked = [
      ...listed(input?.jobIds).map((id) => ({ kind: 'job' as const, id })),
      ...listed(input?.workflowIds).map((id) => ({ kind: 'workflow' as const, id })),
    ];
    const minutes = input?.minutes;
    check(
      asked.length >= 1 &&
        asked.length <= MAX_TARGETS &&
        asked.every((target) => text(target.id, 200)) &&
        new Set(asked.map((target) => target.id)).size === asked.length &&
        text(input.reason, 1000) &&
        // The reason is kept in the next visit's frozen packet, which refuses a lone surrogate.
        !/\p{Surrogate}/u.test(input.reason) &&
        (minutes === undefined ||
          (Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= MAX_MINUTES)),
      'invalid_compute_wait',
      'Name 1–20 distinct job and workflow ids, a reason of 1–1000 visible characters and, if you give it, minutes from 1 to 10080',
    );
    caller = structuredClone(caller);
    const targets = asked as ComputeTarget[];
    const visit = await this.host.reading(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return this.host.decode(await this.host.row(tx, caller.session!.id));
    });
    ownLive(visit, caller);
    check(
      visit.continuity,
      'compute_wait_unkept',
      'This visit keeps no conversation for a later visit to continue, so it cannot wait: wait inside this visit, or keep the ids of what still runs in the project for the next visit',
      409,
    );
    const offered = await this.offers(visit);
    // A Sandboxes slow to say whether it serves the project refuses nothing for good.
    if (offered === undefined) throw unreachable();
    check(
      offered,
      'compute_wait_unavailable',
      'This visit is not offered session.await_compute: wait inside it, or keep the ids of what still runs in the project for the next visit',
      409,
    );
    // Sandboxes is asked holding no transaction; whatever ends before the write, the sweep finds.
    const read = await this.ask(visit, targets);
    const unknown = read.targets.filter((target) => target.status === 'unknown');
    if (unknown.length)
      throw new MervError(
        'compute_target_unknown',
        `Not a job or workflow of this work's current attempt: ${unknown.map((target) => target.id).join(', ')}. job and workflow with action=list show this work's own; call again with those. Your visit goes on.`,
        409,
        { unknown: unknown.map((target) => target.id) },
      );
    if (over(read.targets))
      throw new MervError(
        'compute_ended',
        `Everything named has ended, or one ended without succeeding, so your visit goes on: ${read.targets.map(phrase).join('; ')}. Read their results, then await only what still runs, if anything.`,
        409,
        { targets: read.targets },
      );
    if (read.idle.length)
      throw new MervError(
        'compute_machines_idle',
        `Machines ${read.idle.join(', ')} run none of the jobs or workflows named, and would bill while you wait: release them with sandbox action=delete, or await what runs on them. Your visit goes on.`,
        409,
        { machines: read.idle },
      );
    const { until, why } = this.bound(read, minutes);
    return await this.host.transaction(async (tx) => {
      // A read decision in a write: Sessions' guard checks the call's lease and messages again.
      await this.scope.require(caller, 'read', tx);
      const session = this.host.decode(await this.host.row(tx, caller.session!.id));
      ownLive(session, caller);
      const id = newId('session_compute_wait');
      await tx.run(
        'INSERT INTO session_compute_waits(id,project_id,thread_id,session_id,instance_id,revision,reason,targets_json,created_at,wait_until) VALUES(?,?,?,?,?,?,?,?,?,?)',
        id,
        session.projectId,
        session.threadId,
        session.id,
        session.instanceId,
        session.expectedRevision,
        input.reason,
        JSON.stringify(read.targets),
        isoNow(this.clock),
        until,
      );
      await this.report(session.projectId, session.instanceId, tx);
      await this.state.appendEvent(tx, {
        projectId: session.projectId,
        actorId: caller.actorId,
        type: 'session.compute_awaited',
        subjectId: session.threadId,
        data: {
          waitId: id,
          threadId: session.threadId,
          sessionId: session.id,
          instanceId: session.instanceId,
          revision: session.expectedRevision,
          until,
        },
      });
      await this.host.awaited(session, tx);
      return { id, reason: input.reason, until, why, targets: read.targets };
    });
  }
  /**
   * When a wait on what was read ends at the latest, and the bound that sets that time: the
   * minutes asked for, a machine's lease end, or the latest deadline of what runs.
   */
  private bound(read: ComputeStates, minutes: number | undefined) {
    const now = this.clock();
    const { lease, deadline } = read;
    const bounds = [
      {
        at: now + (minutes ?? DEFAULT_MINUTES) * 60_000,
        why:
          minutes === undefined
            ? `the default ${DEFAULT_MINUTES} minutes`
            : `the ${minutes} minutes asked for`,
        refusal: () =>
          new MervError(
            'compute_wait_short',
            'A wait of under 5 minutes is no reason to end a visit: wait inside this one. Your visit goes on.',
            409,
          ),
      },
      ...(lease
        ? [
            {
              at: Date.parse(lease.endsAt) - LEASE_MARGIN_MS,
              why: `15 minutes before machine ${lease.machine} is deleted at ${lease.endsAt}, as its lease ends`,
              refusal: () =>
                new MervError(
                  'compute_lease_ending',
                  `Machine ${lease.machine} is deleted at ${lease.endsAt}, as its lease ends, in under 20 minutes: renew it with sandbox action=renew first, or wait inside this visit. Your visit goes on.`,
                  409,
                ),
            },
          ]
        : []),
      ...(deadline
        ? [
            {
              at: Date.parse(deadline.at) + DEADLINE_MARGIN_MS,
              why: `10 minutes after ${deadline.target.kind} ${deadline.target.id} must have ended, at ${deadline.at}`,
              refusal: () =>
                new MervError(
                  'compute_overdue',
                  `${deadline.target.kind} ${deadline.target.id} should have ended by ${deadline.at}: look at it, then cancel it or wait inside this visit. Your visit goes on.`,
                  409,
                ),
            },
          ]
        : []),
    ];
    const first = bounds.reduce((earliest, bound) => (bound.at < earliest.at ? bound : earliest));
    if (first.at - now < SHORTEST_MS) throw first.refusal();
    return { until: new Date(first.at).toISOString(), why: first.why };
  }
  /** The waiter's answer, bounded in time, with a state for each target asked about. */
  private async ask(
    visit: Pick<Session, 'projectId' | 'instanceId' | 'id'>,
    targets: readonly ComputeTarget[],
  ): Promise<ComputeStates> {
    const waiter = this.waiter;
    try {
      if (!waiter) throw new Error('No compute waiter');
      const read = await within(
        waiter.states({
          projectId: visit.projectId,
          instanceId: visit.instanceId,
          sessionId: visit.id,
          targets,
        }),
        WAITER_MS,
      );
      return {
        ...read,
        // Only what a wait keeps of each, as it was asked; one left out is not this work's.
        targets: targets.map(({ kind, id }) => {
          const found = read.targets.find((target) => target.kind === kind && target.id === id);
          return found
            ? {
                kind,
                id,
                status: found.status,
                ...(found.state !== undefined && { state: found.state }),
                ...(found.exitCode !== undefined && { exitCode: found.exitCode }),
              }
            : { kind, id, status: 'unknown' as const };
        }),
      };
    } catch {
      throw unreachable();
    }
  }
  /** The sweep, every full pass of Sessions: open waits read on a snapshot, the waiter asked
   *  outside every transaction, and a write only to settle one or where a target's status moved. */
  sweep(): Promise<void> {
    return (this.sweeping ??= this.pass().finally(() => {
      this.sweeping = undefined;
    }));
  }
  private async pass(): Promise<void> {
    const { open, work, revisions } = await this.host.reading(async (tx) => {
      const open = await tx.all<WaitRow>(
        'SELECT * FROM session_compute_waits WHERE settled_at IS NULL ORDER BY _merv_rowid',
      );
      const work = new Map<string, { revision: number; ended: boolean }>();
      const revisions = new Map<string, number>();
      for (const projectId of new Set(open.map((row) => row.project_id))) {
        const items = open.filter((row) => row.project_id === projectId);
        const continuity = await nativeRevisionContinuity(tx, projectId);
        for (const row of items)
          revisions.set(row.id, continuity.current(row.instance_id, Number(row.revision)));
        for (const [id, item] of await this.host.work(
          projectId,
          [...new Set(items.map((row) => row.instance_id))],
          tx,
        ))
          work.set(`${projectId} ${id}`, item);
      }
      return { open, work, revisions };
    });
    // Each wait on its own, all at once: one that cannot be read now holds back no other.
    const failed = (
      await Promise.allSettled(
        open.map((row) =>
          this.check(row, work.get(`${row.project_id} ${row.instance_id}`), revisions.get(row.id)!),
        ),
      )
    ).find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  /** One open wait, settled once nothing will be offered at its revision, its until has passed or
   *  what it names is over; else what it names as it stands now, where a status moved. */
  private async check(
    row: WaitRow,
    item: { revision: number; ended: boolean } | undefined,
    revision: number,
  ) {
    // A protocol migration preserves the wait; an ordinary revision still ends it.
    if (!item || item.ended || item.revision !== revision)
      return await this.host.transaction((tx) => this.settle(tx, row, 'moved'));
    if (row.wait_until <= isoNow(this.clock))
      return await this.host.transaction((tx) => this.settle(tx, row, 'deadline'));
    if (!this.waiter) return;
    const stored = JSON.parse(row.targets_json) as ComputeTargetState[];
    const read = await this.ask(
      { projectId: row.project_id, instanceId: row.instance_id, id: row.session_id },
      stored.flatMap(({ kind, id, status }) => (status === 'running' ? [{ kind, id }] : [])),
    );
    // What ended stays as it ended; what ran is as Sandboxes says now.
    const targets = stored.map(
      (target) =>
        read.targets.find((now) => now.kind === target.kind && now.id === target.id) ?? target,
    );
    if (over(targets)) await this.host.transaction((tx) => this.settle(tx, row, 'ended', targets));
    else if (targets.some((target, i) => target.status !== stored[i]!.status))
      await this.host.transaction((tx) =>
        tx.run(
          'UPDATE session_compute_waits SET targets_json=? WHERE id=? AND settled_at IS NULL',
          JSON.stringify(targets),
          row.id,
        ),
      );
  }
  // So that no other plugin reads session_compute_waits itself (customer experiments' status).
  async waiting(projectId: string, instanceId: string): Promise<boolean> {
    const open = await this.state.read((sql) =>
      sql.get(
        'SELECT 1 FROM session_compute_waits WHERE project_id=? AND instance_id=? AND settled_at IS NULL LIMIT 1',
        projectId,
        instanceId,
      ),
    );
    return !!open;
  }
  /** A person's message to the thread ends the waits its agent started: the work comes back. */
  async woken(tx: Transaction, projectId: string, threadId: string): Promise<void> {
    for (const row of await tx.all<WaitRow>(
      'SELECT * FROM session_compute_waits WHERE project_id=? AND thread_id=? AND settled_at IS NULL',
      projectId,
      threadId,
    ))
      await this.settle(tx, row, this.early(row));
  }
  /**
   * An offer of the work at `revision`: a wait there still open ends with it (only a hand offer
   * meets one whose until is ahead), and the visit after the one that waited is told how it ended,
   * as is one that continues its conversation (`resumed`, the visit whose conversation it takes up).
   */
  async offered(
    tx: Transaction,
    projectId: string,
    instanceId: string,
    revision: number,
    resumed: string | null,
  ): Promise<ComputeWake | undefined> {
    const continuity = await nativeRevisionContinuity(tx, projectId);
    const sourceRevision = continuity.source(instanceId, revision);
    for (const row of await tx.all<WaitRow>(
      'SELECT * FROM session_compute_waits WHERE project_id=? AND instance_id=? AND revision IN (?,?) AND settled_at IS NULL',
      projectId,
      instanceId,
      revision,
      sourceRevision,
    ))
      await this.settle(tx, row, this.early(row));
    // The work's newest visit that ran waited (a lost offer or an inquiry visit leaves it newest),
    // or the conversation taken up ends with the wait: the visit after it lost its own.
    const row = await tx.get<WaitRow>(
      `SELECT w.* FROM session_compute_waits w WHERE w.project_id=? AND w.instance_id=? AND w.revision IN (?,?)
        AND w.outcome<>'moved' AND w.session_id IN (?, (
          SELECT s.id FROM worker_sessions s WHERE s.project_id=? AND s.instance_id=? AND s.kind='work'
            AND s.activated_at IS NOT NULL ORDER BY s._merv_rowid DESC LIMIT 1))
        ORDER BY w._merv_rowid DESC LIMIT 1`,
      projectId,
      instanceId,
      revision,
      sourceRevision,
      resumed,
      projectId,
      instanceId,
    );
    return row ? wake(row) : undefined;
  }
  /** How a wait a person ended sooner went: its until may have come first. */
  private early(row: WaitRow): Outcome {
    return row.wait_until <= isoNow(this.clock) ? 'deadline' : 'woken';
  }
  /** Settles one wait, once: whoever comes second finds it settled and writes nothing. */
  private async settle(
    tx: Transaction,
    row: WaitRow,
    outcome: Outcome,
    targets?: ComputeTargetState[],
  ): Promise<void> {
    const settled = await tx.get<WaitRow>(
      'UPDATE session_compute_waits SET settled_at=?,outcome=?,targets_json=COALESCE(?,targets_json) WHERE id=? AND settled_at IS NULL RETURNING *',
      isoNow(this.clock),
      outcome,
      targets ? JSON.stringify(targets) : null,
      row.id,
    );
    if (!settled) return;
    await this.report(row.project_id, row.instance_id, tx);
    await this.state.appendEvent(tx, {
      projectId: row.project_id,
      actorId: 'system:sessions',
      type: 'session.compute_settled',
      subjectId: row.thread_id,
      data: {
        waitId: row.id,
        threadId: row.thread_id,
        sessionId: row.session_id,
        instanceId: row.instance_id,
        revision: Number(row.revision),
        outcome,
      },
    });
  }
  /** Sessions' waits on one work item, so its gate and session.stuck say what it waits for. */
  private async report(projectId: string, instanceId: string, tx: Transaction): Promise<void> {
    const open = await tx.all<WaitRow>(
      'SELECT * FROM session_compute_waits WHERE project_id=? AND instance_id=? AND settled_at IS NULL ORDER BY _merv_rowid',
      projectId,
      instanceId,
    );
    const newest = new Map(open.map((row) => [row.thread_id, row]));
    await this.host.publish(
      {
        projectId,
        instanceId,
        blockers: [...newest.values()].map((row) => ({
          key: row.thread_id,
          code: 'compute_wait',
          cause: 'compute_wait',
          status: 409,
          message: `Its agent waits for its compute until ${row.wait_until}: ${row.reason}`,
          next: `Nothing to do: dispatch offers the work again once all it waits for has ended or one fails, or at ${row.wait_until}. A message to its thread brings it back sooner.`,
          // Nobody's move: the work comes back by itself, so it never reaches Needs you.
          whose: 'nobody' as const,
          // About the revision it waits at: work moved on by any hand no longer waits on it.
          revision: Number(row.revision),
          related: [{ kind: 'thread', id: row.thread_id, label: 'Its agent’s thread' }],
        })),
      },
      tx,
    );
  }
}
