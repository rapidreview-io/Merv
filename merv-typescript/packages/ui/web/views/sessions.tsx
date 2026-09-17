import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { accountRequest, scopeVersion, useTool } from '../api';
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
import { leaseLiveness, runnerLiveness } from '../liveness';
import { useScopeKey } from '../session';
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
interface Status {
  agents?: AgentSummary[];
  canManage: boolean;
  liveSessionCount: number;
  sessionTotal: number;
  dispatch: { enabled: boolean; updatedAt: string | null; updatedBy: string | null };
  runners: Runner[];
  sessions: Session[];
  queue: Candidate[];
  queueTotal: number;
}
const isLive = (session: Session) => session.status === 'offered' || session.status === 'active';
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
 * One lease, two lines on one grid: identity above, liveness below, and no fact
 * on both. The body is a toggle and nothing else, so what a person scans stays
 * on the row and the rest — the revision, the absolute lease stamps, the
 * platform — waits in the panel, whose first line is the link back to the work.
 */
function LeaseRow({
  session,
  agent,
  route,
  now,
  open,
  onToggle,
  control,
}: {
  session: Session;
  agent: ReactNode;
  route?: { to: string; kind: string };
  now: number;
  open: boolean;
  onToggle(): void;
  control: ReactNode;
}) {
  const panelId = `lease-${session.id}`;
  const rows: KVRow[] = [
    ['Revision', session.expectedRevision],
    ['Offered', stamp(session.createdAt)],
    !!session.activatedAt && ['Taken up', stamp(session.activatedAt)],
    [isLive(session) ? 'Lease expires' : 'Lease ran to', stamp(session.expiresAt)],
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
        <span className="wrap">{agent}</span>
        <strong>{session.label}</strong>
        <span className="muted">{term(session.role)}</span>
        <Countdown to={isLive(session) ? session.expiresAt : null} now={now} />
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
          {control}
        </div>
      )}
    </div>
  );
}

function AgentsPage({ row, shell }: ViewProps) {
  const [cadence, setCadence] = useState(4000);
  const state = useTool<Status>('ui.read', { rowId: row.id }, { every: cadence });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [open, setOpen] = useState<string>();
  const opener = useRef<HTMLButtonElement | null>(null);
  const mutate = async (path: string, body: unknown, method = 'POST') => {
    if (!state.data?.canManage || busy) return;
    const version = scopeVersion();
    const current = () => version === scopeVersion();
    setBusy(path);
    setError(undefined);
    try {
      await accountRequest(path, { method, body, scoped: true });
      if (current()) state.reload();
    } catch (failure) {
      if (current())
        setError(failure instanceof Error ? failure.message : 'The control request failed.');
    } finally {
      if (current()) setBusy(undefined);
    }
  };
  const status = state.data;
  const liveCount = status?.liveSessionCount ?? 0;
  // An agent is named where it worked; a lease with no name says so with a dash.
  const agentName = new Map((status?.agents ?? []).map((agent) => [agent.id, agent.name]));
  // The page's one clock ticks only while a lease or a runner is actually live,
  // and the read slows to match, so an idle Agents page costs nothing.
  const anyLive = liveCount > 0 || (status?.runners ?? []).some((runner) => runner.live);
  const now = useNow(anyLive ? 1000 : 0);
  useEffect(() => setCadence(anyLive ? 4000 : 15000), [anyLive]);
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
  const live = (status?.sessions ?? []).filter(isLive);
  const waiting = [
    status?.queueTotal && `${count(status.queueTotal, 'assignment', 'assignments')} to be leased`,
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
    <ListPage
      load={state}
      noun="agents"
      placeholder="Agent or assignment"
      filter={filter}
      rows={[...filter.rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))}
      emptyTitle="No agents yet"
      emptyHint="An agent appears here when a runner takes up a lease in this project."
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
      create={{
        label: 'Operations',
        plain: true,
        form: () =>
          status && (
            <div className="stack stack--lg">
              <section className="stack">
                <div className="cluster">
                  <strong>Automatic dispatch</strong>
                  <StatusPill value={status.dispatch.enabled ? 'enabled' : 'paused'} />
                  {status.dispatch.updatedAt && (
                    <span className="faint">
                      set <Ago at={status.dispatch.updatedAt} />
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
                          disabled={!!busy}
                          onClick={() =>
                            void mutate(
                              '/sessions/dispatch',
                              { enabled: !status.dispatch.enabled },
                              'PUT',
                            )
                          }
                        >
                          {status.dispatch.enabled ? 'Halt dispatch' : 'Start dispatch'}
                        </button>
                        {live.length > 0 && (
                          <ConfirmAction
                            label="Halt all leases"
                            title={`Halt ${count(live.length, 'live lease', 'live leases')} and dispatch?`}
                            confirm="Halt all leases"
                            busy={busy === '/sessions/halt' ? 'Halting…' : undefined}
                            onConfirm={() =>
                              void mutate('/sessions/halt', { reason: 'halted_by_operator' })
                            }
                          >
                            <ul className="guard-list">
                              {live.map((session) => (
                                <li key={session.id}>
                                  {session.label} · {term(session.role)} ·{' '}
                                  {agentName.get(session.agentId ?? '') ?? 'no agent yet'}
                                </li>
                              ))}
                            </ul>
                            <p className="muted">
                              Each lease closes now and automatic dispatch stops, so nothing new is
                              offered until you start it again; connected runners must stop their
                              own workers. Each assignment returns to the queue at its current
                              revision. No verdict, claim standing or review state changes.
                            </p>
                          </ConfirmAction>
                        )}
                      </div>
                    ) : null
                  }
                />
                {error && (
                  <p className="error-message" role="alert">
                    {error}
                  </p>
                )}
              </section>
              <section className="stack">
                <h2 className="section-title">Runners</h2>
                {status.runners.length === 0 ? (
                  <p className="faint">
                    No runner has reported its presence. Starting dispatch alone does not launch an
                    agent process.
                  </p>
                ) : (
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
                  <p className="faint">No sessions have been offered in this project.</p>
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
                        agent={agentName.get(session.agentId ?? '') ?? term(null)}
                        open={open === session.id}
                        onToggle={() =>
                          setOpen((current) => (current === session.id ? undefined : session.id))
                        }
                        control={
                          status.canManage && isLive(session) ? (
                            <ConfirmAction
                              label="Halt lease"
                              title="Halt this lease?"
                              confirm="Halt lease"
                              busy={
                                busy === `/sessions/${session.id}/halt` ? 'Halting…' : undefined
                              }
                              onConfirm={() =>
                                void mutate(`/sessions/${encodeURIComponent(session.id)}/halt`, {
                                  reason: 'halted_by_operator',
                                })
                              }
                            >
                              <p>
                                {agentName.get(session.agentId ?? '') ?? 'An unnamed agent'} holds
                                this lease on {session.label} as {term(session.role)}. Halting
                                closes it now; its runner must stop the worker itself.
                              </p>
                              <p className="muted">
                                The assignment returns to the queue at revision{' '}
                                {session.expectedRevision}. No verdict, claim standing or review
                                state changes.
                              </p>
                            </ConfirmAction>
                          ) : null
                        }
                      />
                    ))}
                  </div>
                )}
              </section>
              <section className="stack">
                <h2 className="section-title">Available work · {status.queueTotal}</h2>
                {status.queueTotal > status.queue.length && (
                  <p className="faint">
                    Showing the first {status.queue.length} eligible assignments.
                  </p>
                )}
                {status.queue.length === 0 ? (
                  <p className="faint">No eligible work is waiting for this identity.</p>
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
                      col<Candidate>(
                        'revision',
                        'Revision',
                        (candidate) => candidate.expectedRevision,
                      ),
                    ]}
                  />
                )}
              </section>
            </div>
          ),
      }}
    />
  );
}

export const SessionsView = (props: ViewProps) => <AgentsPage key={useScopeKey()} {...props} />;
