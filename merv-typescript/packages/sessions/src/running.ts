import {
  check,
  mapAsync,
  runningKey,
  workRoute,
  type Caller,
  type RunningAction,
  type RunningAttention,
  type RunningFact,
  type RunningLinkRow,
  type RunningMark,
  type RunningNode,
  type RunningNodes,
  type RunningPanelPart,
  type RunningPhrase,
  type RunningSection,
  type RunningStreamItem,
  type RunningSummary,
  type RunningVerb,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import { freshForMs, type DispatchReading, type SessionDispatch } from './dispatch.js';
import { lastActivity } from './observations.js';
import type {
  Agent,
  SessionPlatform,
  SessionRole,
  SessionWorkspace,
  StuckReport,
} from './types.js';

/**
 * The Running page's reading of Sessions: a node for every live lease and where it runs, the
 * lane's line about dispatch, the marks dispatch puts on work it holds back, the sidebar of a
 * lease, and the Sessions rows on the work a lease is on. Every read runs on the page's
 * read-only snapshot and only reads: nothing is reconciled, marked quiet or closed here, which
 * stays the sweep's. A frozen assignment can be half a megabyte, so a lease row is parsed once,
 * in SQL, for the few fields a face needs, and never decoded whole.
 *
 * The words are the Sessions page's (views/liveness.ts): a lease is offered, active, lapsed,
 * released or expired; a runner is live or offline; quiet only ever means no Merv call.
 */

/** A call in flight breathes only once it has outlasted a read of the board. */
const movingAfterMs = 5000;
/** The most of a brief the sidebar carries, cut at a line end. */
const briefCap = 16_000;
const callLimit = 50;
const ROLES: Record<SessionRole, string> = {
  producer: 'Producer',
  reviewer: 'Reviewer',
  reader: 'Reader',
};
const VERBS: Record<SessionRole, RunningVerb> = {
  producer: 'works on',
  reviewer: 'reviews',
  reader: 'reads',
};
const KINDS: Record<string, string> = {
  task: 'Task',
  experiment: 'Experiment',
  reflection: 'Reflection',
  research: 'Research',
};
const machineWho = 'An operator checks the machine or halts the lease';
/**
 * A lease is labelled for the agent that takes it (`Work: …`, `Review: …`) and the role
 * already says which, so the record is named by the rest; a lens's closing enum word reads
 * as words. The Sessions page names work the same way (views/agent-sessions-panel.tsx).
 */
const PURPOSE = /^(?:Work|Review|experiment\.\w+):\s+/;
const LENS = /: ([a-z]+(?:_[a-z]+)+)$/;
export const workName = (label: string) =>
  label.replace(PURPOSE, '').replace(LENS, (_, lens: string) => `: ${lens.replaceAll('_', ' ')}`);
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** The lease fields a face reads, each row's JSON parsed once rather than once per field. */
const LEASE = `s.id,s.instance_id,s.status,s.owner_hash,s.runner_id,x.j #>> '{role}' AS role,
  x.j #>> '{assignment,label}' AS label,x.j #>> '{execution,workflow}' AS workflow,
  x.j #>> '{createdAt}' AS created_at,x.j #>> '{activatedAt}' AS activated_at,
  x.j #>> '{expiresAt}' AS expires_at,x.j #>> '{hardDeadline}' AS hard_deadline,
  d.platform_json,r.id AS runner_ref,r.presence_json,r.source_json,r.last_seen_at,m.allocation_id`;
const FROM = `FROM worker_sessions s CROSS JOIN LATERAL (SELECT s.session_json::jsonb AS j OFFSET 0) x
  LEFT JOIN session_dispatch_receipts d ON d.session_id=s.id
  LEFT JOIN session_runners r ON r.owner_hash=s.owner_hash AND r.runner_id=s.runner_id
  LEFT JOIN session_managed_runners m ON m.bound_session_id=s.id`;
interface LeaseRow {
  id: string;
  instance_id: string;
  status: 'offered' | 'active' | 'released' | 'expired';
  owner_hash: string;
  runner_id: string;
  role: SessionRole;
  label: string;
  workflow: string;
  created_at: string;
  activated_at: string | null;
  expires_at: string;
  hard_deadline: string;
  platform_json: string | null;
  runner_ref: string | null;
  presence_json: string | null;
  source_json: string | null;
  last_seen_at: string | null;
  allocation_id: string | null;
}

/** One lease as a face reads it. */
export interface Lease {
  id: string;
  instanceId: string;
  status: LeaseRow['status'];
  role: SessionRole;
  label: string;
  workflow: string;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string;
  hardDeadline: string;
  /** From the dispatch receipt; a lease offered by hand has none. */
  platform: SessionPlatform | null;
  /** The runner that holds it, where it ever reported; a hand offer nobody runs has none. */
  machine: {
    hostname: string;
    capacity: number;
    lastSeenAt: string;
    /** False once the key it registered with may no longer read the project. */
    authorized: boolean;
  } | null;
  /** The Fleet allocation it is bound to. */
  fleet: string | null;
  calls: {
    /** Its latest Merv activity: a call's end, or the start of one still running. */
    lastAt: string | null;
    /** The longest-running call still in flight. */
    running: { tool: string; since: string } | null;
  };
}

/** What a lease's node and its rows on other panels say, from one rule. */
export interface Face {
  line: RunningPhrase;
  look: RunningNode['look'];
  dot?: RunningNode['dot'];
  attention?: RunningAttention;
}
const lapsed = (lease: Pick<Lease, 'status' | 'expiresAt' | 'hardDeadline'>, now: number) =>
  lease.status === 'active' &&
  (Date.parse(lease.expiresAt) <= now || Date.parse(lease.hardDeadline) <= now);
const presentAt = (machine: NonNullable<Lease['machine']>, now: number) =>
  Date.parse(machine.lastSeenAt) + freshForMs > now;
/**
 * What an active lease needs a person for. A runner that stopped reporting holds its work for
 * hours with nobody on it; a lease quiet past idleNoticeSeconds is the session_idle rule.
 * Where no runner ever reported (a hand offer), nothing is known of a machine, so nothing is
 * said of one.
 */
function needs(lease: Lease, now: number, idleNoticeSeconds: number): RunningAttention | undefined {
  const { machine } = lease;
  if (machine && !machine.authorized) return { says: ['Key revoked'], who: machineWho };
  if (machine && !presentAt(machine, now))
    return {
      says: ['Machine offline · last seen ', { ago: machine.lastSeenAt }],
      who: machineWho,
    };
  const last = lastActivity(lease, lease.calls.lastAt ?? undefined);
  if (!last || Date.parse(last) + idleNoticeSeconds * 1000 > now) return undefined;
  const { running } = lease.calls;
  return {
    says: running
      ? [{ mono: running.tool }, ' · ', { since: running.since }]
      : ['Quiet ', { since: last }],
    who: machineWho,
  };
}
export function face(lease: Lease, now: number, idleNoticeSeconds: number): Face {
  if (lease.status === 'offered')
    return {
      line: ['Offered · not taken up · ', { since: lease.createdAt }],
      look: 'dashed',
      dot: 'starting',
    };
  // The sweep closes it within the second; until then this read saw its window close.
  if (lapsed(lease, now)) return { line: ['Lapsed · lease ran out'], look: 'quiet' };
  const { running, lastAt } = lease.calls;
  const attention = needs(lease, now, idleNoticeSeconds);
  return {
    line: running
      ? [{ mono: running.tool }, ' · ', { since: running.since }]
      : lastAt
        ? ['Last call ', { ago: lastAt }]
        : ['No calls yet · ', { since: lease.activatedAt ?? lease.createdAt }],
    look: 'solid',
    dot: running && now - Date.parse(running.since) >= movingAfterMs ? 'moving' : 'live',
    ...(attention ? { attention } : {}),
  };
}
const machineLine = (lease: Lease): RunningPhrase | null =>
  lease.fleet ? ['on a Fleet VM'] : lease.machine ? [`on ${lease.machine.hostname}`] : null;

/** A lease's node: its role, what it is doing, where it runs, and the work it is on. */
export function leaseNode(
  lease: Lease,
  rank: number,
  harness: boolean,
  now: number,
  idleNoticeSeconds: number,
): RunningNode {
  const { line, look, dot, attention } = face(lease, now, idleNoticeSeconds);
  const on = machineLine(lease);
  return {
    key: runningKey('session', lease.id),
    lane: 'sessions',
    title:
      harness && lease.platform
        ? `${ROLES[lease.role]} · ${lease.platform.harness}`
        : ROLES[lease.role],
    name: clip(workName(lease.label), 200),
    lines: on ? [line, on] : [line],
    look,
    ...(dot ? { dot } : {}),
    ...(attention ? { attention } : {}),
    links: [{ to: runningKey('work', lease.instanceId), verb: VERBS[lease.role] }],
    ...(lease.fleet ? { aliases: [runningKey('fleet', lease.fleet)] } : {}),
    rank,
  };
}

/** A lease as a row of the work it is on, saying what its node says. */
function leaseRow(lease: Lease, now: number, idleNoticeSeconds: number): RunningLinkRow {
  const { line, attention } = face(lease, now, idleNoticeSeconds);
  return {
    to: { key: runningKey('session', lease.id) },
    kind: ROLES[lease.role],
    name: lease.fleet ? 'a Fleet VM' : clip(lease.machine?.hostname ?? 'an agent', 200),
    says: attention?.says ?? line,
    ...(attention ? { attention: true } : {}),
  };
}

type Stall = NonNullable<DispatchReading['stall']>;
const STALLS: Record<Stall['code'], (waiting: number, stall: Stall) => RunningAttention> = {
  dispatch_disabled: (waiting) => ({
    says: ['Dispatch paused · ', { count: waiting }, ' waiting'],
    who: 'An operator starts dispatch',
  }),
  no_live_runner: (waiting) => ({
    says: ['No machine online · ', { count: waiting }, ' waiting'],
    who: 'Someone with a write key of this project starts a runner',
  }),
  // A machine Fleet rents is 'a Fleet VM' wherever the page names it.
  runner_refusing: (_waiting, { machine, rented }) => ({
    says: [rented ? 'A Fleet VM' : clip(machine ?? 'A machine', 200), ' refuses work'],
    who: 'Whoever runs it restarts it, or an operator changes its settings',
  }),
};
/**
 * The Sessions lane's own line: dispatch in the Sessions page's words (paused, running or
 * waiting), the project's machines, and, while work waits, the one reason it does, which only
 * an operator's read counts. The control says the state it sets; only a start while work waits
 * wears the accent.
 */
export function laneSummary(reading: DispatchReading): RunningSummary {
  const { dispatch, fleet, machines, waiting, stall, operator } = reading;
  const says: RunningPhrase = [
    'Dispatch ',
    { state: !dispatch.enabled ? 'paused' : reading.present ? 'running' : 'waiting' },
  ];
  if (machines.live || !fleet) says.push(' · Machines ', { count: machines.live });
  if (machines.live) says.push(' · Free slots ', { count: machines.free });
  if (fleet) says.push(' · Fleet rents machines');
  const action: RunningAction = dispatch.enabled
    ? {
        label: 'Pause dispatch',
        verb: 'pause',
        tool: 'session.dispatch',
        input: { enabled: false },
        allowed: operator,
      }
    : {
        label: 'Start dispatch',
        verb: 'start',
        tool: 'session.dispatch',
        input: { enabled: true },
        allowed: operator,
        ...(waiting ? { primary: true } : {}),
      };
  return {
    lane: 'sessions',
    says,
    ...(stall && waiting ? { attention: STALLS[stall.code](waiting, stall) } : {}),
    actions: [action],
  };
}

const QUIET: Record<DispatchReading['quiet'][number]['code'], (since: string) => RunningAttention> =
  {
    queued: (since) => ({
      says: ['Ready, not taken for ', { since }],
      who: 'An operator checks dispatch and machines',
    }),
    budget_exceeded: () => ({
      says: ['A reached budget withholds it'],
      who: 'An operator raises the budget',
    }),
    usage_unavailable: () => ({
      says: ['Its budget cannot be judged'],
      who: 'An operator clears the bound that went unreported',
    }),
    awaiting_operator: () => ({
      says: ['Waits for an operator'],
      who: 'An operator takes this step',
    }),
  };
/**
 * What dispatch holds back, on the work it holds. A held target and ready work nobody took
 * need a person; a target still being retried, or put off by machines that could not prepare
 * it, resumes by itself, so it only replaces the work's line, without the red. All but the
 * held are an operator's: see SessionDispatch.running.
 */
export function dispatchMarks(reading: DispatchReading): RunningMark[] {
  const key = (instanceId: string) => runningKey('work', instanceId);
  return [
    ...reading.failures
      .filter(({ held }) => held)
      .map(({ instanceId, attempts }) => ({
        key: key(instanceId),
        says: ['Held after ', { count: attempts }, ' failed launches'],
        who: 'An operator releases the hold',
      })),
    ...reading.quiet.map(({ instanceId, since, code }) => ({
      key: key(instanceId),
      ...QUIET[code](since),
    })),
    ...reading.failures
      .filter(({ held }) => !held)
      .map(({ instanceId, attempts }) => ({
        key: key(instanceId),
        says:
          attempts === 1
            ? ['Ready · launch failed once, retrying']
            : ['Ready · launch failed ', { count: attempts }, ' times, retrying'],
        quiet: true as const,
      })),
    ...reading.deferred.map(({ instanceId, attempts }) => ({
      key: key(instanceId),
      says: ['Ready · ', { count: attempts }, ' machines could not prepare it'],
      quiet: true as const,
    })),
  ];
}

/** The brief as the sidebar carries it: whole, or cut at the last line end within the cap. */
export function briefText(brief: string): { text: string; truncated: boolean } {
  if (brief.length <= briefCap) return { text: brief, truncated: false };
  const end = brief.lastIndexOf('\n', briefCap);
  return { text: brief.slice(0, end > 0 ? end : briefCap).trimEnd(), truncated: true };
}
const platformPhrase = (platform: SessionPlatform) =>
  [platform.name, platform.model, platform.effort].filter(Boolean).join(' · ');

interface PanelRow extends LeaseRow {
  closed_at: string | null;
  close_reason: string | null;
  outcome: string | null;
  deferral: string | null;
  agent_id: string | null;
  workspace_mode: string | null;
  brief: string | null;
  attachment_json: string | null;
  result_json: string | null;
}

/** Sessions' reads for the Running page. LeasedSessions guards and delegates each one. */
export class SessionRunning {
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly dispatcher: SessionDispatch,
    private readonly clock: () => number,
    private readonly thresholds: StuckReport['thresholds'],
  ) {}
  /** A person's read of one project, never a leased worker's: the Sessions page's own rule. */
  private async read<T>(
    caller: Caller,
    fn: (tx: Transaction, operator: boolean) => Promise<T>,
  ): Promise<T> {
    caller = structuredClone(caller);
    check(!caller.session, 'forbidden', 'Leased workers cannot read project dispatch', 403);
    return await this.state.snapshot(() =>
      this.state.transaction(async (tx) =>
        fn(tx, (await this.scope.require(caller, 'read', tx)).role === 'operator'),
      ),
    );
  }
  /** The project's live leases, or those on some instances, oldest first, at most 200. */
  private async leases(
    tx: Transaction,
    projectId: string,
    instanceIds?: readonly string[],
  ): Promise<Lease[]> {
    const within = instanceIds
      ? ` AND s.instance_id IN (${instanceIds.map(() => '?').join(',')})`
      : '';
    return await this.facts(
      tx,
      await tx.all<LeaseRow>(
        `SELECT ${LEASE} ${FROM} WHERE s.project_id=? AND s.status IN ('offered','active')${within} ORDER BY s._merv_rowid LIMIT 200`,
        projectId,
        ...(instanceIds ?? []),
      ),
    );
  }
  /** Each lease with its latest Merv activity, its call in flight and whether its runner may still read. */
  private async facts(tx: Transaction, rows: LeaseRow[]): Promise<Lease[]> {
    if (!rows.length) return [];
    const calls = new Map(
      (
        await tx.all<{
          id: string;
          last_at: string;
          running_at: string | null;
          running_tool: string | null;
        }>(
          `SELECT execution_id AS id,MAX(COALESCE(finished_at,started_at)) AS last_at,
            MIN(started_at) FILTER (WHERE status='running') AS running_at,
            (ARRAY_AGG(tool ORDER BY started_at) FILTER (WHERE status='running'))[1] AS running_tool
            FROM session_tool_calls WHERE execution_id IN (${rows.map(() => '?').join(',')}) GROUP BY execution_id`,
          ...rows.map((row) => row.id),
        )
      ).map((row) => [row.id, row]),
    );
    const authorized = new Map<string, boolean>();
    return await mapAsync(rows, async (row): Promise<Lease> => {
      const call = calls.get(row.id);
      let machine: Lease['machine'] = null;
      if (row.runner_ref && row.presence_json && row.source_json && row.last_seen_at) {
        if (!authorized.has(row.runner_ref))
          authorized.set(row.runner_ref, await this.dispatcher.authorized(row.source_json, tx));
        const presence = JSON.parse(row.presence_json) as {
          machine: { hostname: string };
          capacity: number;
        };
        machine = {
          hostname: presence.machine.hostname,
          capacity: presence.capacity,
          lastSeenAt: row.last_seen_at,
          authorized: authorized.get(row.runner_ref)!,
        };
      }
      return {
        id: row.id,
        instanceId: row.instance_id,
        status: row.status,
        role: row.role,
        label: row.label,
        workflow: row.workflow,
        createdAt: row.created_at,
        activatedAt: row.activated_at,
        expiresAt: row.expires_at,
        hardDeadline: row.hard_deadline,
        platform: row.platform_json ? JSON.parse(row.platform_json) : null,
        machine,
        fleet: row.allocation_id,
        calls: {
          lastAt: call?.last_at ?? null,
          running:
            call?.running_at && call.running_tool
              ? { tool: call.running_tool, since: call.running_at }
              : null,
        },
      };
    });
  }

  async nodes(caller: Caller): Promise<RunningNodes> {
    return await this.read(caller, async (tx) => {
      const leases = await this.leases(tx, caller.projectId);
      const now = this.clock();
      // The harness names a lease only where the lane holds more than one.
      const harnesses = new Set(
        leases.flatMap(({ platform }) => (platform ? [platform.harness] : [])),
      );
      return {
        nodes: leases.map((lease, rank) =>
          leaseNode(lease, rank, harnesses.size > 1, now, this.thresholds.idleNoticeSeconds),
        ),
      };
    });
  }

  async marks(caller: Caller): Promise<{ marks: RunningMark[]; summary: RunningSummary }> {
    caller = structuredClone(caller);
    return await this.state.snapshot(() =>
      this.state.transaction(async (tx) => {
        const reading = await this.dispatcher.running(caller, tx);
        return { marks: dispatchMarks(reading), summary: laneSummary(reading) };
      }),
    );
  }

  /** The leases on some work, as one Sessions section of that work's sidebar. */
  async work(caller: Caller, instanceIds: readonly string[]): Promise<RunningSection[]> {
    const ids = [...new Set(instanceIds)].slice(0, 64);
    if (!ids.length) return [];
    return await this.read(caller, async (tx) => {
      const now = this.clock();
      const rows = (await this.leases(tx, caller.projectId, ids)).map((lease) =>
        leaseRow(lease, now, this.thresholds.idleNoticeSeconds),
      );
      return rows.length
        ? [
            {
              title: 'Sessions',
              place: 'activity',
              kind: 'links',
              rows,
              ...(rows.some((row) => row.attention) ? { attention: true } : {}),
            },
          ]
        : [];
    });
  }

  /**
   * A lease's sidebar, whatever its status and whoever offered it, so an open sidebar keeps
   * reading a lease that has closed. Null for a lease this project does not hold. The brief is
   * an operator's alone.
   */
  async panel(caller: Caller, sessionId: string): Promise<RunningPanelPart | null> {
    return await this.read(caller, async (tx, operator) => {
      const row = await tx.get<PanelRow>(
        `SELECT ${LEASE},x.j #>> '{closedAt}' AS closed_at,
          x.j #>> '{closeReason}' AS close_reason,x.j #>> '{outcome}' AS outcome,
          x.j #>> '{deferral,cause}' AS deferral,x.j #>> '{agentId}' AS agent_id,
          x.j #>> '{execution,policy,workspace,mode}' AS workspace_mode,
          CASE WHEN CAST(? AS INTEGER)=1 THEN LEFT(x.j #>> '{assignment,brief}',${briefCap + 1}) END AS brief,
          w.attachment_json,w.result_json
          ${FROM} LEFT JOIN session_workspaces w ON w.session_id=s.id WHERE s.id=? AND s.project_id=?`,
        operator ? 1 : 0,
        sessionId,
        caller.projectId,
      );
      if (!row) return null;
      const [lease] = await this.facts(tx, [row]);
      const now = this.clock();
      const live = row.status === 'offered' || row.status === 'active';
      const holding = live && !lapsed(lease, now);
      const idle = this.thresholds.idleNoticeSeconds;
      const shown = live ? face(lease, now, idle) : undefined;
      const role = ROLES[row.role];
      const work = workName(row.label);
      const ending = row.outcome || row.close_reason;
      const { machine } = lease;
      const silent = !!machine && (!machine.authorized || !presentAt(machine, now));
      const sections: RunningSection[] = [];

      // What it did through Merv, in-flight calls first. Arguments, results and errors are
      // never stored, so a call is its tool, its state and its time.
      const calls = await tx.all<{
        tool: string;
        status: 'running' | 'succeeded' | 'failed' | 'interrupted';
        started_at: string;
        duration_ms: number | null;
      }>(
        `SELECT tool,status,started_at,duration_ms FROM session_tool_calls WHERE execution_id=?
          ORDER BY CASE WHEN status='running' THEN 0 ELSE 1 END,_merv_rowid DESC LIMIT ${callLimit}`,
        row.id,
      );
      const total = (await tx.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM session_tool_calls WHERE execution_id=?',
        row.id,
      ))!.n;
      // The lease's own moments, where the calls shown reach back to them.
      const reach = total > calls.length ? calls.map((call) => call.started_at).sort()[0] : '';
      const moments: [string | null, RunningPhrase][] = [
        [row.created_at, ['Offered']],
        [row.activated_at, ['Taken up']],
        [row.closed_at, ['Ended · ', { state: ending ?? row.status }]],
      ];
      const markers: RunningStreamItem[] = moments.flatMap(([at, mark]) =>
        at && at >= reach ? [{ mark, at }] : [],
      );
      const items: RunningStreamItem[] = [
        ...calls
          .filter((call) => call.status === 'running')
          .map((call) => ({ call: call.tool, state: call.status, at: call.started_at, ms: null })),
        ...[
          ...calls
            .filter((call) => call.status !== 'running')
            .map((call) => ({
              call: call.tool,
              state: call.status,
              at: call.started_at,
              ms: call.duration_ms,
            })),
          ...markers,
        ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)),
      ];
      sections.push({
        title: 'Merv calls',
        place: 'activity',
        kind: 'stream',
        items,
        total,
        ...(total
          ? {
              aside:
                total > calls.length ? [{ count: calls.length, of: total }] : [{ count: total }],
            }
          : {}),
      });

      // When it must end, and, while nothing renews it, when it lapses and returns the work.
      const terms: RunningFact[] = live
        ? [
            { label: 'Ends in', value: [{ until: row.hard_deadline }] },
            ...(row.status === 'offered' || silent
              ? [{ label: 'Lapses in', value: [{ until: row.expires_at }] }]
              : []),
          ]
        : [
            ...(row.closed_at ? [{ label: 'Ended', value: [{ ago: row.closed_at }] }] : []),
            { label: 'Outcome', value: [{ state: ending ?? row.status }] },
            ...(row.outcome === 'preparation_deferred' && row.deferral
              ? [{ label: 'Put off because', value: [{ state: row.deferral }] }]
              : []),
          ];
      sections.push({ title: 'Lease', place: 'activity', kind: 'facts', rows: terms });

      const route = workRoute(row.workflow, row.instance_id);
      sections.push({
        title: 'Work',
        place: 'relations',
        kind: 'links',
        rows: [
          {
            to: { key: runningKey('work', row.instance_id), ...(route ? { route } : {}) },
            ...(KINDS[row.workflow] ? { kind: KINDS[row.workflow] } : {}),
            name: clip(work, 200),
          },
        ],
      });

      const mode = row.workspace_mode ?? 'none';
      if (mode !== 'none') {
        const attachment: SessionWorkspace | null = row.attachment_json
          ? JSON.parse(row.attachment_json)
          : null;
        const result: SessionWorkspace | null = row.result_json
          ? JSON.parse(row.result_json)
          : null;
        const rows: RunningFact[] = [{ label: 'Mode', value: [{ state: mode }] }];
        if (attachment?.branch)
          rows.push({ label: 'Branch', value: [{ mono: attachment.branch }] });
        if (result) {
          const { commitCount, filesChanged, insertions, deletions } = result.stats;
          rows.push({
            label: 'Captured',
            value: [
              { mono: result.headOid.slice(0, 12) },
              ` · ${commitCount} commits · ${filesChanged} files · +${insertions} −${deletions}`,
            ],
          });
        }
        sections.push({ title: 'Workspace', place: 'code', kind: 'facts', rows });
      }

      // What it was told, frozen at the offer. The work's own sidebar already says its goal and
      // checks, and a server-composed brief ends in instructions to an agent, so it stays shut.
      if (operator && row.brief) {
        const { text, truncated } = briefText(row.brief);
        sections.push({
          title: 'Brief',
          place: 'content',
          kind: 'text',
          text,
          markdown: true,
          folded: true,
          ...(truncated ? { truncated: true } : {}),
        });
      }

      if (machine) {
        const presence: RunningPhrase = !machine.authorized
          ? ['key revoked']
          : presentAt(machine, now)
            ? ['live · seen ', { ago: machine.lastSeenAt }]
            : ['offline · last seen ', { ago: machine.lastSeenAt }];
        const flagged = row.status === 'active' && holding && silent;
        const rows: RunningFact[] = [
          { label: 'Presence', value: presence, ...(flagged ? { attention: true } : {}) },
        ];
        // A machine Fleet rents is Fleet's to describe; its section follows through the alias.
        if (!lease.fleet) {
          rows.unshift({ label: 'Machine', value: [clip(machine.hostname, 200)] });
          if (lease.platform)
            rows.push({ label: 'Platform', value: [platformPhrase(lease.platform)] });
          if (live) {
            const on = await tx.all<{ id: string; label: string; role: SessionRole }>(
              `SELECT s.id,x.j #>> '{assignment,label}' AS label,x.j #>> '{role}' AS role
                FROM worker_sessions s CROSS JOIN LATERAL (SELECT s.session_json::jsonb AS j OFFSET 0) x
                WHERE s.project_id=? AND s.owner_hash=? AND s.runner_id=? AND s.status IN ('offered','active') ORDER BY s._merv_rowid`,
              caller.projectId,
              row.owner_hash,
              row.runner_id,
            );
            rows.push({
              label: 'Slots',
              value: [{ count: on.length, of: machine.capacity }, ' busy'],
            });
            const others = on.filter(({ id }) => id !== row.id).slice(0, 5);
            if (others.length)
              rows.push({
                label: 'Also on this machine',
                value: others.flatMap((other, at) => [
                  ...(at ? [', '] : []),
                  {
                    link: { key: runningKey('session', other.id) },
                    text: clip(`${workName(other.label)} · ${ROLES[other.role]}`, 200),
                  },
                ]),
              });
          }
        }
        sections.push({
          title: 'Machine',
          place: 'machine',
          kind: 'facts',
          rows,
          ...(flagged ? { attention: true } : {}),
        });
      }

      // A continuing agent carries context from its earlier assignments.
      const agent = row.agent_id
        ? await tx.get<{ agent_json: string }>(
            'SELECT agent_json FROM agents WHERE id=? AND project_id=?',
            row.agent_id,
            caller.projectId,
          )
        : undefined;
      const continuing: Agent | null = agent ? JSON.parse(agent.agent_json) : null;
      // How many assignments came before is not said: worker_sessions has no index to count an
      // actor's by, and this sidebar is read every few seconds.
      if (continuing?.persistent) {
        sections.push({
          title: 'Agent',
          place: 'details',
          kind: 'facts',
          rows: [
            { label: 'Name', value: [clip(continuing.name, 200)] },
            ...(continuing.contextEpoch > 0
              ? [{ label: 'Context resets', value: [{ count: continuing.contextEpoch }] }]
              : []),
          ],
        });
      }

      // The guard names who holds it and on what, in the Sessions page's own sentences.
      const who = continuing?.persistent
        ? clip(continuing.name, 24)
        : lease.fleet
          ? 'The agent on a Fleet VM'
          : machine
            ? `The agent on ${clip(machine.hostname, 24)}`
            : 'An agent';
      const halt: RunningAction = {
        label: 'Halt lease',
        verb: 'halt',
        tool: 'session.halt',
        input: { sessionId: row.id, reason: 'halted_by_operator' },
        allowed: operator && holding,
        guard: {
          title: 'Halt this lease?',
          consequence: `${who} holds this lease on ${clip(work, 90)} as ${row.role}. Halting closes it now and returns the work to the queue; its runner must stop the worker itself. No verdict, claim standing or review state changes. A remote job it started keeps running.${lease.fleet ? ' Its Fleet machine is then released.' : ''}`,
        },
        expect: { field: 'halted', min: 1, nothing: 'Nothing was halted.' },
      };

      const says: RunningPhrase =
        row.status === 'offered'
          ? ['Offered ', { since: row.created_at }, ` · ${role}`]
          : row.status === 'active'
            ? holding
              ? ['Active ', { since: row.activated_at ?? row.created_at }, ` · ${role}`]
              : [`Lapsed · lease ran out · ${role}`]
            : [
                row.status === 'released' ? 'Released' : 'Expired',
                ...(ending && ending !== row.status ? [' · ', { state: ending }] : []),
                ...(row.closed_at ? [' · ', { ago: row.closed_at }] : []),
                ` · ${role}`,
              ];
      return {
        header: {
          kind: 'Agent',
          title: clip(work, 200),
          says,
          ...(shown?.attention ? { attention: shown.attention } : {}),
        },
        sections,
        actions: live ? [halt] : [],
        live,
        ...(lease.fleet ? { aliases: [runningKey('fleet', lease.fleet)] } : {}),
      };
    });
  }
}
