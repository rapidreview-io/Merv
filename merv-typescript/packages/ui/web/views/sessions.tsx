import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { accountRequest, useTool } from '../api';
import {
  ActorSplit,
  Ago,
  ConfirmAction,
  Countdown,
  KV,
  KindLabel,
  Live,
  StatusPill,
  Table,
  col,
  stamp,
  term,
  useNow,
  type KVRow,
} from '../components';
import { ListPage, useListFilter } from '../list-filters';
import { ThreeStates } from '../states';
import { clock, decisionLiveness, leaseLiveness, runnerLiveness, type Clock } from '../liveness';
import { useCommand } from '../mutations';
import { useScopeKey, useSession } from '../session';
import type { ViewProps } from './index';
import { AgentDetail, activity, type AgentSummary } from './agent-sessions-panel';

interface Platform {
  name: string;
  harness: string;
  model?: string;
  effort?: string;
  enabled?: boolean;
  parallelism?: number;
}
interface Runner {
  id: string;
  lastSeenAt: string;
  live: boolean;
  capacity: number;
  machine: { hostname: string; system: string; architecture: string };
  platforms: Platform[];
  desiredVersion: number;
  appliedVersion?: number;
  lastDecision: string | null;
  lastDecisionAt: string | null;
}
interface Session {
  agentId?: string;
  agentSessionId?: string;
  id: string;
  instanceId: string;
  expectedRevision: number;
  label: string;
  role: string;
  status: string;
  runnerRef: string | null;
  hostRef: string | null;
  platform: Platform | null;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string;
  closedAt: string | null;
  closeReason: string | null;
  outcome?: string | null;
  workspaceMode: 'none' | 'ephemeral' | 'persistent';
  workspace?: {
    attachment: { baseOid: string; headOid: string; mode: string };
    result: { headOid: string; stats: { filesChanged: number; commitCount: number } } | null;
  };
}
interface Candidate {
  instanceId: string;
  expectedRevision: number;
  workflow: string;
  state: string;
  label: string;
  role: string;
  readOnly: boolean;
  workspace: { mode: string };
}
interface Dispatch {
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}
interface Status {
  agents?: AgentSummary[];
  observedAt: string;
  canManage: boolean;
  liveSessionCount: number;
  sessionTotal: number;
  runnerTotal: number;
  dispatch: Dispatch;
  runners: Runner[];
  sessions: Session[];
  queue: Candidate[];
  queueTotal: number;
}
/**
 * Whether the lease is still held, asked of the one module that composes the
 * verdict rather than of the lifecycle word beside it — so the countdown, the KV
 * label and the Halt control cannot disagree with the line that says `lapsed`.
 */
const holds = (session: Session, now: Clock) => {
  const verdict = leaseLiveness(session, now)?.verdict;
  return verdict === 'offered' || verdict === 'active';
};
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const platformPhrase = (platform: Platform) =>
  [platform.name, platform.model, platform.effort].filter(Boolean).join(' · ');
const workspacePhrase = ({ workspace, workspaceMode }: Session) => {
  if (!workspace)
    return workspaceMode === 'none' ? 'none · scratch' : `${term(workspaceMode)} · not attached`;
  const result = workspace.result;
  return [
    `${term(workspace.attachment.mode)} · ${result ? 'captured' : 'attached'}`,
    (result ?? workspace.attachment).headOid,
    result && `${result.stats.filesChanged} changed files · ${result.stats.commitCount} commits`,
  ]
    .filter(Boolean)
    .join(' · ');
};

/**
 * A halt, reported as it happened. `mutations.ts` keeps the command through an
 * answer that never arrived and says the result is unknown, instead of reading
 * as a refusal; and the count the server returns is stated either way, so a halt
 * that closed nothing can never look like one that closed something. Halt is
 * idempotent server-side — a closed lease is skipped — so the retry is the same
 * request and carries no request id.
 */
function useHalt(path: string, reload: () => void, nothing: string) {
  const [halted, setHalted] = useState<number>();
  const answer = useRef<number>();
  const command = useCommand<{ halted: number }>({
    tool: path,
    send: (body) => accountRequest(path, { method: 'POST', body, scoped: true }),
    validate: (result) => typeof result.halted === 'number',
    idempotent: true,
    onSuccess: (result) => {
      answer.current = result.halted;
      setHalted(result.halted);
      reload();
    },
  });
  return {
    halted,
    busy: command.busy ? 'Halting…' : undefined,
    label: command.retry ? 'Retry halt' : undefined,
    note:
      command.error || halted === 0 ? (
        <p className="error-message" role="alert">
          {command.error ?? nothing}
        </p>
      ) : null,
    async confirm() {
      answer.current = undefined;
      await command.submit({ reason: 'halted_by_operator' });
      return (answer.current ?? 0) > 0;
    },
  };
}

/**
 * One lease, two lines on one grid: identity above, liveness below, and no fact
 * on both. The body is a toggle and nothing else, so what a person scans stays
 * on the row and the rest — the revision, the absolute lease stamps, the
 * platform — waits in the panel, whose first line is the link back to the work.
 * The guard, its answer and its busy label all belong to this row, so no lease's
 * failure is reported over another's.
 */
function LeaseRow({
  session,
  name,
  route,
  now,
  open,
  onToggle,
  canManage,
  reload,
}: {
  session: Session;
  name?: string;
  route?: { to: string; kind: string };
  now: Clock;
  open: boolean;
  onToggle(): void;
  canManage: boolean;
  reload(): void;
}) {
  const panelId = `lease-${session.id}`;
  const holding = holds(session, now);
  const halt = useHalt(
    `/sessions/${encodeURIComponent(session.id)}/halt`,
    reload,
    'Nothing was halted. This lease had already closed.',
  );
  const rows: KVRow[] = [
    ['Revision', session.expectedRevision],
    ['Offered', stamp(session.createdAt)],
    !!session.activatedAt && ['Taken up', stamp(session.activatedAt)],
    [holding ? 'Lease expires' : 'Lease ran to', stamp(session.expiresAt)],
    !!session.closedAt && ['Closed', stamp(session.closedAt)],
    !!session.platform && ['Platform', platformPhrase(session.platform)],
    ['Workspace', <span className="wrap">{workspacePhrase(session)}</span>],
  ];
  return (
    <div className={`lease${open ? ' lease--open' : ''}`}>
      <button
        type="button"
        className="lease-row"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={onToggle}
      >
        <span className="wrap">{name ?? term(null)}</span>
        <strong>{session.label}</strong>
        <span className="muted">{term(session.role)}</span>
        <Countdown to={holding ? session.expiresAt : null} now={now} />
      </button>
      <div className="lease-live">
        <Live of={leaseLiveness(session, now)} />
      </div>
      {open && (
        <div className="lease-panel stack" id={panelId}>
          {route && (
            <Link className="cluster agent-help" to={route.to}>
              <KindLabel kind={route.kind} />
              <span>Open the record →</span>
            </Link>
          )}
          <KV rows={rows} />
          {canManage && holding && (
            <ConfirmAction
              label="Halt lease"
              title="Halt this lease?"
              confirm={halt.label ?? 'Halt lease'}
              busy={halt.busy}
              note={halt.note}
              onConfirm={halt.confirm}
            >
              <p>
                {name ?? 'An unnamed agent'} holds this lease on {session.label} as{' '}
                {term(session.role)}. Halting closes it now; its runner must stop the worker itself.
              </p>
              <p className="muted">
                The assignment is released back to the queue at revision {session.expectedRevision}.
                No verdict, claim standing or review state changes.
              </p>
            </ConfirmAction>
          )}
          {halt.halted !== undefined && halt.halted > 0 && (
            <p className="muted" role="status">
              Halted {count(halt.halted, 'lease', 'leases')}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentsPage({ row, shell, me }: ViewProps & { me: string }) {
  const [cadence, setCadence] = useState(4000);
  const state = useTool<Status>('ui.read', { rowId: row.id }, { every: cadence });
  const [selected, setSelected] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [already, setAlready] = useState<string>();
  const opener = useRef<HTMLButtonElement | null>(null);
  const status = state.data;
  const liveCount = status?.liveSessionCount ?? 0;
  // An agent is named where it worked; a lease with no name says so with a dash.
  const agentName = new Map((status?.agents ?? []).map((agent) => [agent.id, agent.name]));
  // The page's one clock ticks only while a lease or a runner is actually live,
  // and the read slows to match, so an idle Agents page costs nothing.
  const anyLive = liveCount > 0 || (status?.runners ?? []).some((runner) => runner.live);
  const tick = useNow(anyLive ? 1000 : 0);
  // Every duration is measured from the payload's own server clock, so browser
  // skew never reaches one, and past two cadences the page states the age of what
  // it is showing instead of counting on against a fact nobody has refreshed.
  const now = clock(status?.observedAt, state.loadedAt, tick, cadence * 2);
  useEffect(() => setCadence(anyLive ? 4000 : 15000), [anyLive]);
  const haltAll = useHalt(
    '/sessions/halt',
    state.reload,
    'Nothing was halted. No lease was live; automatic dispatch is off.',
  );
  // The button sends the state it means, never a flip of what it last read, and the
  // answer names the case where someone else had already set it.
  const dispatch = useCommand<{ dispatch: Dispatch }>({
    tool: '/sessions/dispatch',
    send: (body) => accountRequest('/sessions/dispatch', { method: 'PUT', body, scoped: true }),
    validate: (result) => typeof result.dispatch?.enabled === 'boolean',
    idempotent: true,
    onSuccess: (result) => {
      setAlready(
        result.dispatch.updatedBy === me
          ? undefined
          : `Dispatch was already ${result.dispatch.enabled ? 'on' : 'off'}.`,
      );
      state.reload();
    },
  });
  // The lease's work item is named by the lists the page's siblings already own.
  const taskRow = shell.rows.find((entry) => entry.view.kind === 'tasks');
  const experimentRow = shell.rows.find((entry) => entry.view.kind === 'experiments');
  const tasks = useTool<{ id: string }[]>(taskRow ? 'task.list' : null);
  const experiments = useTool<{ id: string }[]>(experimentRow ? 'experiment.list' : null);
  const routeOf = (instanceId: string) =>
    tasks.data?.some((task) => task.id === instanceId)
      ? { to: `${taskRow!.path}/${instanceId}`, kind: 'tasks' }
      : experiments.data?.some((experiment) => experiment.id === instanceId)
        ? { to: `${experimentRow!.path}/${instanceId}`, kind: 'experiments' }
        : undefined;
  const agents = status?.agents ?? [];
  const filter = useListFilter(agents, {
    stateOf: activity,
    labels: (agent) => [agent.name, agent.currentAssignment?.label],
    ids: (agent) => [agent.id],
  });
  const offered = (status?.sessions ?? []).filter((session) => session.status === 'offered');
  const live = (status?.sessions ?? []).filter((session) => holds(session, now));
  const waiting = [
    status?.queueTotal &&
      `${count(status.queueTotal, 'assignment', 'assignments')} eligible for this identity`,
    offered.length && `${count(offered.length, 'lease', 'leases')} offered and not taken up`,
  ]
    .filter(Boolean)
    .join(' · ');
  const assignmentLabels = new Map(
    (status?.sessions ?? []).map((session) => [session.id, session]),
  );
  const selectedAgent = agents.find((agent) => agent.id === selected);
  const close = () => {
    setSelected(undefined);
    opener.current?.focus();
  };
  return (
    <>
      {/* The page's subject is the page: dispatch, the machines, the leases and the
          queue are what a person came for, so none of them waits behind a control. */}
      {status && (
        <div className="page-stage stack stack--lg sessions-ops">
          <section className="stack">
            <div className="cluster">
              <strong>Automatic dispatch</strong>
              <StatusPill value={status.dispatch.enabled ? 'enabled' : 'paused'} />
              {status.dispatch.updatedAt && (
                <span className="faint">
                  {status.dispatch.updatedBy === me ? 'set by you ' : 'set '}
                  <Ago at={status.dispatch.updatedAt} />
                </span>
              )}
            </div>
            <ActorSplit
              agent={waiting ? <p>{waiting}.</p> : null}
              you={
                status.canManage ? (
                  <div className="cluster">
                    <button
                      className="btn"
                      disabled={dispatch.busy}
                      onClick={() => {
                        setAlready(undefined);
                        void dispatch.submit({ enabled: !status.dispatch.enabled });
                      }}
                    >
                      {status.dispatch.enabled ? 'Halt dispatch' : 'Start dispatch'}
                    </button>
                    {live.length > 0 && (
                      <ConfirmAction
                        label="Halt all leases"
                        title={`Halt ${count(liveCount, 'live lease', 'live leases')} and dispatch?`}
                        confirm={haltAll.label ?? 'Halt all leases'}
                        busy={haltAll.busy}
                        note={haltAll.note}
                        onConfirm={haltAll.confirm}
                      >
                        <ul className="guard-list">
                          {live.map((session) => (
                            <li key={session.id}>
                              {session.label} · {term(session.role)} ·{' '}
                              {agentName.get(session.agentId ?? '') ?? 'no agent yet'}
                            </li>
                          ))}
                          {/* The guard names every lease under the click, including the
                              ones past this read's 200-row window. */}
                          {liveCount > live.length && <li>{liveCount - live.length} more</li>}
                        </ul>
                        <p className="muted">
                          Each lease closes now and automatic dispatch stops, so nothing new is
                          offered until you start it again; connected runners must stop their own
                          workers. Each assignment is released back to the queue at its current
                          revision. No verdict, claim standing or review state changes.
                        </p>
                      </ConfirmAction>
                    )}
                  </div>
                ) : null
              }
            />
            {dispatch.error && (
              <p className="error-message" role="alert">
                {dispatch.error}
              </p>
            )}
            {already && (
              <p className="muted" role="status">
                {already}
              </p>
            )}
            {!!haltAll.halted && (
              <p className="muted" role="status">
                Halted {count(haltAll.halted, 'lease', 'leases')}.
              </p>
            )}
          </section>
          <section className="stack">
            <h2 className="section-title">Runners</h2>
            {status.runners.length === 0 ? (
              <p className="faint">No runner has reported its presence.</p>
            ) : (
              <>
                {status.runnerTotal > status.runners.length && (
                  <p className="list-totals muted">
                    {status.runners.length} of {status.runnerTotal} runners, most recently seen
                    first
                  </p>
                )}
                <Table
                  rows={status.runners}
                  keyOf={(runner) => runner.id}
                  columns={[
                    col<Runner>('machine', 'Machine', (runner) => (
                      <>
                        <strong>{runner.machine.hostname}</strong>
                        <div className="faint">
                          {runner.machine.system} · {runner.machine.architecture}
                        </div>
                      </>
                    )),
                    col<Runner>('live', 'Presence', (runner) => (
                      <Live of={runnerLiveness(runner, now)} />
                    )),
                    col<Runner>('decision', 'Last dispatch', (runner) => (
                      <Live of={decisionLiveness(runner, now)} />
                    )),
                    col<Runner>(
                      'platforms',
                      'Platforms',
                      (runner) =>
                        runner.platforms
                          .map(
                            (platform) =>
                              `${platform.name}${platform.model ? ` · ${platform.model}` : ''}${platform.enabled ? '' : ' (paused)'}`,
                          )
                          .join(', ') || 'None',
                    ),
                    col<Runner>('capacity', 'Capacity', (runner) => runner.capacity),
                    col<Runner>('settings', 'Settings', (runner) =>
                      runner.desiredVersion > (runner.appliedVersion ?? 0)
                        ? 'Pending acknowledgement'
                        : 'Applied',
                    ),
                  ]}
                />
              </>
            )}
          </section>
          <section className="stack">
            <h2 className="section-title">Leases</h2>
            <p className="list-totals muted">
              {status.sessionTotal > status.sessions.length
                ? `${status.sessions.length} of ${status.sessionTotal} leases this project has offered, live first`
                : `${count(status.sessionTotal, 'lease', 'leases')} this project has offered`}{' '}
              · {liveCount} live now
            </p>
            {status.sessions.length === 0 ? (
              <p className="faint">No lease has been offered in this project.</p>
            ) : (
              <div className="lease-list">
                <div className="lease-head">
                  {['Agent', 'Work', 'Role', 'Expires'].map((head) => (
                    <span className="label" key={head}>
                      {head}
                    </span>
                  ))}
                </div>
                {status.sessions.map((session) => (
                  <LeaseRow
                    key={session.id}
                    session={session}
                    now={now}
                    route={routeOf(session.instanceId)}
                    name={agentName.get(session.agentId ?? '')}
                    canManage={status.canManage}
                    reload={state.reload}
                    open={open === session.id}
                    onToggle={() =>
                      setOpen((current) => (current === session.id ? undefined : session.id))
                    }
                  />
                ))}
              </div>
            )}
          </section>
          <section className="stack">
            {/* The queue is what this identity may lease, not the fleet's backlog:
                the runner's own key sees its own. The heading says so. */}
            <h2 className="section-title">Eligible for this identity · {status.queueTotal}</h2>
            {status.queueTotal > status.queue.length && (
              <p className="faint">Showing the first {status.queue.length}.</p>
            )}
            {status.queue.length === 0 ? (
              <p className="faint">No work is eligible for this identity.</p>
            ) : (
              <Table
                rows={status.queue}
                keyOf={(candidate) => `${candidate.instanceId}:${candidate.expectedRevision}`}
                columns={[
                  col<Candidate>('label', 'Work', (candidate) => (
                    <strong>{candidate.label}</strong>
                  )),
                  col<Candidate>('gate', 'Gate', (candidate) => term(candidate.state)),
                  col<Candidate>('role', 'Role', (candidate) => term(candidate.role)),
                  col<Candidate>('revision', 'Revision', (candidate) => candidate.expectedRevision),
                ]}
              />
            )}
          </section>
          <h2 className="section-title">Agents</h2>
        </div>
      )}
      <ListPage
        load={state}
        noun="agents"
        placeholder="Agent or assignment"
        filter={filter}
        rows={[...filter.rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))}
        emptyTitle="No agents yet"
        line={(agent) => ({
          name: (
            <button
              className="row-link agent-select"
              aria-expanded={selected === agent.id}
              aria-controls={selected === agent.id ? 'agent-detail' : undefined}
              onClick={(event) => {
                opener.current = event.currentTarget;
                setSelected(agent.id);
              }}
            >
              <strong>{agent.name}</strong>
            </button>
          ),
          standing: (
            <ThreeStates
              execution={activity(agent)}
              meta={
                <>
                  {agent.currentExecutionId
                    ? `${
                        agent.currentAssignment?.label ??
                        assignmentLabels.get(agent.currentExecutionId)?.label ??
                        'Assignment execution'
                      } · ${
                        agent.currentAssignment?.role ??
                        assignmentLabels.get(agent.currentExecutionId)?.role ??
                        ''
                      } · `
                    : ''}
                  joined <Ago at={agent.createdAt} />
                </>
              }
            />
          ),
        })}
        after={selectedAgent && <AgentDetail agent={selectedAgent} close={close} />}
      />
    </>
  );
}

export const SessionsView = (props: ViewProps) => {
  const { actor } = useSession();
  return <AgentsPage key={useScopeKey()} me={actor.id} {...props} />;
};
