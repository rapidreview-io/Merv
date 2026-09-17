import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { accountRequest, scopeVersion, useScopeVersion, useTool } from '../api';
import {
  ActorSplit,
  Ago,
  ConfirmAction,
  Countdown,
  KV,
  KindLabel,
  Live,
  LoadState,
  ObjId,
  StatusPill,
  Table,
  col,
  term,
  useNow,
} from '../components';
import { leaseLiveness, runnerLiveness } from '../liveness';
import type { ViewProps } from './index';
import { AgentSessionsPanel, type AgentSummary } from './agent-sessions-panel';

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
const stamp = (at: string) => new Date(at).toLocaleString();
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
 * on the row and everything they copy — ids, refs, the absolute lease stamp —
 * waits in the panel, whose first line is the link back to the work.
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
  const rows: [string, ReactNode][] = [
    ['Work item', <span className="mono wrap">{session.instanceId}</span>],
    ['Execution', <span className="mono wrap">{session.id}</span>],
    ['Revision', session.expectedRevision],
    ['Offered', stamp(session.createdAt)],
  ];
  if (session.activatedAt) rows.push(['Taken up', stamp(session.activatedAt)]);
  rows.push([isLive(session) ? 'Lease expires' : 'Lease ran to', stamp(session.expiresAt)]);
  if (session.closedAt) rows.push(['Closed', stamp(session.closedAt)]);
  if (session.platform) rows.push(['Platform', platformPhrase(session.platform)]);
  if (session.runnerRef) rows.push(['Runner', <span className="mono">{session.runnerRef}</span>]);
  if (session.hostRef) rows.push(['Host', <span className="mono">{session.hostRef}</span>]);
  rows.push(['Workspace', <span className="wrap">{workspacePhrase(session)}</span>]);
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
        <strong>{session.label || <ObjId id={session.instanceId} />}</strong>
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

export function SessionsView({ row, shell }: ViewProps) {
  const [cadence, setCadence] = useState(4000);
  const state = useTool<Status>('ui.read', { rowId: row.id }, { every: cadence });
  const epoch = useScopeVersion();
  const generation = useRef(0);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<'agents' | 'operations'>('agents');
  const [open, setOpen] = useState<string>();
  useEffect(() => {
    generation.current++;
    setBusy(undefined);
    setError(undefined);
    setView('agents');
    setOpen(undefined);
    return () => {
      generation.current++;
    };
  }, [epoch]);
  const mutate = async (path: string, body: unknown, method = 'POST') => {
    if (!state.data?.canManage || busy) return;
    const version = scopeVersion();
    const currentGeneration = generation.current;
    const current = () => version === scopeVersion() && currentGeneration === generation.current;
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
  // An agent is named where it worked; the id stays as the fallback.
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
  const offered = (status?.sessions ?? []).filter((session) => session.status === 'offered');
  const live = (status?.sessions ?? []).filter(isLive);
  const waiting = [
    status?.queueTotal && `${count(status.queueTotal, 'assignment', 'assignments')} to be leased`,
    offered.length && `${count(offered.length, 'lease', 'leases')} offered and not taken up`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="page-stage sessions-page stack stack--lg">
      <LoadState {...state} />
      {status && (
        <>
          <div className="action-row" role="group" aria-label="Agent page views">
            <button
              className="btn-text"
              aria-pressed={view === 'agents'}
              aria-controls="sessions-agents-panel"
              onClick={() => setView('agents')}
            >
              Agents
            </button>
            <button
              className="btn-text"
              aria-pressed={view === 'operations'}
              aria-controls="sessions-operations-panel"
              onClick={() => setView('operations')}
            >
              Operations
            </button>
          </div>
          <div id="sessions-agents-panel" hidden={view !== 'agents'}>
            <AgentSessionsPanel
              key={epoch}
              agents={status.agents ?? []}
              assignments={status.sessions}
            />
          </div>
          <div id="sessions-operations-panel" hidden={view !== 'operations'}>
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
                          {status.dispatch.enabled ? 'Pause dispatch' : 'Enable dispatch'}
                        </button>
                        {live.length > 0 && (
                          <ConfirmAction
                            label="Halt every live lease"
                            title={`Halt ${count(live.length, 'live lease', 'live leases')} and pause dispatch?`}
                            confirm={`Halt ${live.length} and pause dispatch`}
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
                              offered until you enable it again; connected runners must stop their
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
                    No runner has reported its presence. Enabling dispatch alone does not launch an
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
                        agent={
                          agentName.get(session.agentId ?? '') ??
                          (session.agentId ? <ObjId id={session.agentId} /> : term(null))
                        }
                        open={open === session.id}
                        onToggle={() =>
                          setOpen((current) => (current === session.id ? undefined : session.id))
                        }
                        control={
                          status.canManage && isLive(session) ? (
                            <ConfirmAction
                              label="Halt this lease"
                              title="Halt this lease?"
                              confirm="Halt the lease"
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
                        <strong>{candidate.label || <ObjId id={candidate.instanceId} />}</strong>
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
          </div>
        </>
      )}
    </div>
  );
}
