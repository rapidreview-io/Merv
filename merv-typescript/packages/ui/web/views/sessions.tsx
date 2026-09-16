import { useEffect, useRef, useState } from 'react';
import { accountRequest, scopeVersion, useScopeVersion, useTool } from '../api';
import { LoadState, ObjId, StatusPill, Table, relativeTime } from '../components';
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

export function SessionsView({ row }: ViewProps) {
  const state = useTool<Status>('ui.read', { rowId: row.id }, { every: 4000 });
  const epoch = useScopeVersion();
  const generation = useRef(0);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<'agents' | 'operations'>('agents');
  useEffect(() => {
    generation.current++;
    setBusy(undefined);
    setError(undefined);
    setView('agents');
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
  return (
    <div className="page-stage sessions-page stack stack--lg">
      <LoadState loading={state.loading} error={state.error} />
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
                  {status.canManage && (
                    <>
                      <button
                        className="btn btn--sm"
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
                      <button
                        className="btn btn--sm"
                        disabled={!!busy || (!status.dispatch.enabled && liveCount === 0)}
                        onClick={() =>
                          void mutate('/sessions/halt', { reason: 'halted_by_operator' })
                        }
                      >
                        Halt all sessions
                      </button>
                    </>
                  )}
                </div>
                <p className="faint">
                  Pausing prevents new automatic leases. Halting also closes current sessions;
                  connected runners must stop their workers.
                </p>
                {error && <p role="alert">{error}</p>}
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
                      {
                        key: 'machine',
                        label: 'Machine',
                        render: (runner) => (
                          <>
                            <strong>{runner.machine.hostname}</strong>
                            <div className="faint">
                              {runner.machine.system} · {runner.machine.architecture}
                            </div>
                          </>
                        ),
                      },
                      {
                        key: 'live',
                        label: 'Presence',
                        render: (runner) => <StatusPill value={runner.live ? 'live' : 'offline'} />,
                      },
                      {
                        key: 'platforms',
                        label: 'Platforms',
                        render: (runner) =>
                          runner.platforms
                            .map(
                              (platform) =>
                                `${platform.name}${platform.model ? ` · ${platform.model}` : ''}${platform.enabled ? '' : ' (paused)'}`,
                            )
                            .join(', ') || 'None',
                      },
                      { key: 'capacity', label: 'Capacity', render: (runner) => runner.capacity },
                      {
                        key: 'settings',
                        label: 'Settings',
                        render: (runner) =>
                          runner.desiredVersion > (runner.appliedVersion ?? 0)
                            ? 'Pending acknowledgement'
                            : 'Applied',
                      },
                      {
                        key: 'seen',
                        label: 'Last seen',
                        render: (runner) => (
                          <span title={runner.lastSeenAt}>{relativeTime(runner.lastSeenAt)}</span>
                        ),
                      },
                    ]}
                  />
                )}
              </section>
              <section className="stack">
                <h2 className="section-title">Assignment executions · {liveCount} live</h2>
                {status.sessionTotal > status.sessions.length && (
                  <p className="faint">
                    Showing {status.sessions.length} of {status.sessionTotal} sessions, with live
                    sessions first.
                  </p>
                )}
                {status.sessions.length === 0 ? (
                  <p className="faint">No sessions have been offered in this project.</p>
                ) : (
                  <Table
                    rows={status.sessions}
                    keyOf={(session) => session.id}
                    columns={[
                      {
                        key: 'agent',
                        label: 'Agent',
                        render: (session) => <ObjId id={session.agentId ?? session.id} />,
                      },
                      {
                        key: 'work',
                        label: 'Work',
                        render: (session) => (
                          <>
                            <strong>{session.label}</strong>
                            <div>
                              <ObjId id={session.instanceId} /> · revision{' '}
                              {session.expectedRevision}
                            </div>
                          </>
                        ),
                      },
                      { key: 'role', label: 'Role', render: (session) => session.role },
                      {
                        key: 'status',
                        label: 'Lease',
                        render: (session) => <StatusPill value={session.status} />,
                      },
                      {
                        key: 'platform',
                        label: 'Platform',
                        render: (session) => session.platform?.name ?? 'Manual offer',
                      },
                      {
                        key: 'workspace',
                        label: 'Workspace',
                        render: (session) =>
                          session.workspace ? (
                            <>
                              <div>
                                {session.workspace.attachment.mode} ·{' '}
                                {session.workspace.result ? 'Captured' : 'Attached'}
                              </div>
                              <code
                                title={
                                  (session.workspace.result ?? session.workspace.attachment).headOid
                                }
                              >
                                {(
                                  session.workspace.result ?? session.workspace.attachment
                                ).headOid.slice(0, 12)}
                              </code>
                              {session.workspace.result && (
                                <div className="faint">
                                  {session.workspace.result.stats.filesChanged} changed files ·{' '}
                                  {session.workspace.result.stats.commitCount} commits
                                </div>
                              )}
                            </>
                          ) : session.workspaceMode === 'none' ? (
                            'Scratch'
                          ) : (
                            `${session.workspaceMode} · Not attached`
                          ),
                      },
                      {
                        key: 'outcome',
                        label: 'Close outcome',
                        render: (session) =>
                          session.outcome?.replaceAll('_', ' ') ??
                          session.closeReason?.replaceAll('_', ' ') ??
                          (session.activatedAt ? 'Activated' : 'Awaiting first MCP request'),
                      },
                      {
                        key: 'created',
                        label: 'Offered',
                        render: (session) => (
                          <span title={session.createdAt}>{relativeTime(session.createdAt)}</span>
                        ),
                      },
                      {
                        key: 'control',
                        label: '',
                        render: (session) =>
                          status.canManage && isLive(session) ? (
                            <button
                              className="btn btn--sm"
                              disabled={!!busy}
                              onClick={() =>
                                void mutate(`/sessions/${encodeURIComponent(session.id)}/halt`, {
                                  reason: 'halted_by_operator',
                                })
                              }
                            >
                              Halt
                            </button>
                          ) : null,
                      },
                    ]}
                  />
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
                      {
                        key: 'label',
                        label: 'Work',
                        render: (candidate) => (
                          <>
                            <strong>{candidate.label}</strong>
                            <div>
                              <ObjId id={candidate.instanceId} />
                            </div>
                          </>
                        ),
                      },
                      { key: 'gate', label: 'Gate', render: (candidate) => candidate.state },
                      { key: 'role', label: 'Role', render: (candidate) => candidate.role },
                      {
                        key: 'revision',
                        label: 'Revision',
                        render: (candidate) => candidate.expectedRevision,
                      },
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
