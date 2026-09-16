import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { useTool, type ApiError, type Project } from '../api';
import { useSession } from '../session';
import type { Row, ShellData } from '../shell';
import { ObjId, PageHeader, StatusPill, relativeTime, words } from '../components';

/**
 * The project Overview. Pure presentation composition: every panel mounts only
 * while its owning ui.shell row is registered, and each panel is a separate
 * child component so Hooks rules hold as providers come and go. Counts follow
 * each producer's own semantics; an absent value is never rendered as zero,
 * and an error is never rendered as empty.
 */

interface TaskLite {
  id: string;
  title: string;
  workflow: { state: string; updatedAt: string };
}
interface ExperimentLite {
  id: string;
  name: string;
  attempt: { index: number };
  workflow: { state: string; updatedAt: string };
}
interface ReviewLite {
  id: string;
  subjectId: string;
  status: string;
  verdict: string | null;
  reviewerId: string | null;
  createdAt: string;
}
interface ResearchLite {
  id: string;
  name: string;
  workflow: { state: string; revision: number };
}
interface ClaimLite {
  id: string;
  statement: string;
  status: string;
  confidence: string;
  updatedAt: string;
}
interface AgentLite {
  id: string;
  name: string;
  status: string;
  currentExecutionId: string | null;
  currentAssignment: { label: string; role: string } | null;
  createdAt: string;
}
interface SessionsLite {
  agents?: AgentLite[];
  liveSessionCount: number;
  sessionTotal: number;
  runners: { id: string; live: boolean }[];
  queueTotal: number;
}

function PanelState({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error?: ApiError;
  children?: ReactNode;
}) {
  if (error)
    return (
      <p className="error-message" role="alert">
        Could not load: {error.message} <span className="mono faint">({error.code})</span>
      </p>
    );
  if (loading)
    return (
      <p className="faint" role="status">
        Loading…
      </p>
    );
  return <>{children}</>;
}

function PanelHead({
  title,
  meta,
  link,
}: {
  title: string;
  meta?: ReactNode;
  link?: { to: string; label: string };
}) {
  return (
    <div className="cluster cluster--between ov-head">
      <h2 className="section-title">
        {title}
        {meta !== undefined && <span className="ov-meta"> · {meta}</span>}
      </h2>
      {link && (
        <Link className="ov-more" to={link.to}>
          {link.label} →
        </Link>
      )}
    </div>
  );
}

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={iso}>
      {relativeTime(iso)}
    </time>
  );
}

function CycleGuidance({ id }: { id: string }) {
  const guidance = useTool<WorkflowDecision>(
    'workflow.status_and_next',
    { instanceId: id },
    { every: 4000 },
  );
  if (guidance.error)
    return (
      <p className="faint">
        Guidance is unavailable right now <span className="mono">({guidance.error.code})</span>.
      </p>
    );
  if (!guidance.data)
    return (
      <p className="faint" role="status">
        Loading guidance…
      </p>
    );
  const decision = guidance.data;
  const blockers = decision.blockers.filter((blocker) => blocker.message !== decision.instruction);
  return (
    <div className="ov-guidance stack">
      <p>{decision.instruction}</p>
      <p className="faint">
        Gate: {words(decision.currentGate)} · next:{' '}
        {decision.nextAction
          ? words(decision.nextAction.action)
          : decision.terminal
            ? 'finished'
            : 'waiting'}
      </p>
      {blockers.length > 0 && (
        <ul className="checks">
          {blockers.map((blocker, index) => (
            <li key={index}>{blocker.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ResearchPanel({ row, compactEmpty }: { row: Row; compactEmpty?: boolean }) {
  const list = useTool<ResearchLite[]>('research.list');
  const data = list.error ? undefined : list.data;
  const active = (data ?? []).filter((cycle) => cycle.workflow.state !== 'complete');
  const focus = active.at(-1);
  if (compactEmpty && data?.length === 0)
    return (
      <div className="ov-empty-row">
        <Link to={row.path}>{row.label}</Link>
        <span>No new work yet</span>
      </div>
    );
  return (
    <section className="card stack ov-panel">
      <PanelHead
        title={row.label}
        meta={data ? `${active.length} active of ${data.length}` : undefined}
        link={{ to: row.path, label: 'Open' }}
      />
      <PanelState loading={list.loading} error={list.error}>
        {data &&
          (active.length ? (
            active
              .slice(-3)
              .reverse()
              .map((cycle) => (
                <div key={cycle.id} className="ov-cycle stack">
                  <div className="cluster cluster--between">
                    <Link className="ov-item-title" to={row.path}>
                      {cycle.name}
                    </Link>
                    <StatusPill value={cycle.workflow.state} />
                  </div>
                  {focus && cycle.id === focus.id && <CycleGuidance id={cycle.id} />}
                </div>
              ))
          ) : (
            <p className="empty">
              {data.length
                ? 'Every research cycle is complete.'
                : 'No research cycle has been started yet.'}
            </p>
          ))}
      </PanelState>
    </section>
  );
}

function ExperimentsPanel({ row, compactEmpty }: { row: Row; compactEmpty?: boolean }) {
  const list = useTool<ExperimentLite[]>('experiment.list');
  const data = list.error ? undefined : list.data;
  const recent = [...(data ?? [])]
    .sort((a, b) => b.workflow.updatedAt.localeCompare(a.workflow.updatedAt))
    .slice(0, 5);
  if (compactEmpty && data?.length === 0)
    return (
      <div className="ov-empty-row">
        <Link to={row.path}>{row.label}</Link>
        <span>No new work yet</span>
      </div>
    );
  return (
    <section className="card stack ov-panel">
      <PanelHead
        title={row.label}
        meta={data ? `${data.length} total, newest activity first` : undefined}
        link={{ to: row.path, label: 'All experiments' }}
      />
      <PanelState loading={list.loading} error={list.error}>
        {data &&
          (recent.length ? (
            <ul className="ov-list">
              {recent.map((experiment) => (
                <li key={experiment.id} className="ov-item">
                  <Link className="ov-item-title" to={`${row.path}/${experiment.id}`}>
                    {experiment.name}
                  </Link>
                  <span className="ov-item-meta">
                    <StatusPill value={experiment.workflow.state} />
                    <span>attempt {experiment.attempt.index}</span>
                    <When iso={experiment.workflow.updatedAt} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              No experiments yet. A producer creates one from a research question.
            </p>
          ))}
      </PanelState>
    </section>
  );
}

function TasksPanel({ row, compactEmpty }: { row: Row; compactEmpty?: boolean }) {
  const list = useTool<TaskLite[]>('task.list');
  const data = list.error ? undefined : list.data;
  const open = (data ?? [])
    .filter((task) => !['done', 'failed'].includes(task.workflow.state))
    .sort((a, b) => b.workflow.updatedAt.localeCompare(a.workflow.updatedAt));
  if (compactEmpty && data?.length === 0)
    return (
      <div className="ov-empty-row">
        <Link to={row.path}>{row.label}</Link>
        <span>No new work yet</span>
      </div>
    );
  return (
    <section className="card stack ov-panel">
      <PanelHead
        title={row.label}
        meta={data ? `${open.length} open of ${data.length}` : undefined}
        link={{ to: row.path, label: 'All tasks' }}
      />
      <PanelState loading={list.loading} error={list.error}>
        {data &&
          (open.length ? (
            <ul className="ov-list">
              {open.slice(0, 5).map((task) => (
                <li key={task.id} className="ov-item">
                  <Link className="ov-item-title" to={`${row.path}/${task.id}`}>
                    {task.title}
                  </Link>
                  <span className="ov-item-meta">
                    <StatusPill value={task.workflow.state} />
                    <When iso={task.workflow.updatedAt} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              {data.length
                ? `No open tasks. ${data.length} finished or closed tasks remain in the full list.`
                : 'No tasks yet.'}
            </p>
          ))}
      </PanelState>
    </section>
  );
}

function ReviewsPanel({ row, compactEmpty }: { row: Row; compactEmpty?: boolean }) {
  const list = useTool<ReviewLite[]>('review.list');
  const data = list.error ? undefined : list.data;
  const open = [...(data ?? [])]
    .reverse()
    .filter((review) => review.status === 'requested' || review.status === 'started');
  if (compactEmpty && data?.length === 0)
    return (
      <div className="ov-empty-row">
        <Link to={row.path}>{row.label}</Link>
        <span>No new work yet</span>
      </div>
    );
  return (
    <section className="card stack ov-panel">
      <PanelHead
        title={row.label}
        meta={data ? `${open.length} awaiting a verdict` : undefined}
        link={{ to: row.path, label: 'All reviews' }}
      />
      <PanelState loading={list.loading} error={list.error}>
        {data &&
          (open.length ? (
            <ul className="ov-list">
              {open.slice(0, 5).map((review) => (
                <li key={review.id} className="ov-item">
                  <Link className="ov-item-title" to={`${row.path}/${review.id}`}>
                    <ObjId id={review.id} strong /> · work <ObjId id={review.subjectId} />
                  </Link>
                  <span className="ov-item-meta">
                    <StatusPill value={review.status} />
                    <span>{review.reviewerId ? 'claimed' : 'unclaimed'}</span>
                    <When iso={review.createdAt} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              No reviews are waiting. Verdicts appear here when work is submitted for independent
              assessment.
            </p>
          ))}
      </PanelState>
    </section>
  );
}

function AgentsPanel({ row }: { row: Row }) {
  const state = useTool<SessionsLite>(
    row.readable ? 'ui.read' : null,
    { rowId: row.id },
    { every: 10000 },
  );
  const data = state.error ? undefined : state.data;
  const agents = [...(data?.agents ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const liveRunners = data ? data.runners.filter((runner) => runner.live).length : 0;
  return (
    <section className="card stack ov-panel">
      <PanelHead
        title="Agents"
        meta={data ? `${data.liveSessionCount} live` : undefined}
        link={{ to: row.path, label: row.label }}
      />
      {row.readable ? (
        <PanelState loading={state.loading} error={state.error}>
          {data && (
            <>
              <p className="faint">
                {liveRunners} of {data.runners.length} runners connected · {data.queueTotal}{' '}
                eligible work items waiting
              </p>
              {data.agents ? (
                agents.length ? (
                  <ul className="ov-list">
                    {agents.slice(0, 6).map((agent) => (
                      <li key={agent.id} className="ov-item">
                        <Link className="ov-item-title" to={row.path}>
                          {agent.name}
                        </Link>
                        <span className="ov-item-meta">
                          <StatusPill
                            value={
                              agent.status === 'retired'
                                ? 'retired'
                                : agent.currentExecutionId
                                  ? 'assigned'
                                  : 'unassigned'
                            }
                          />
                          {agent.currentAssignment && (
                            <span className="ov-assignment" title={agent.currentAssignment.label}>
                              {agent.currentAssignment.label}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">No agents have joined this project yet.</p>
                )
              ) : (
                <p className="faint">
                  This server does not report agent identities here; open the full page.
                </p>
              )}
              <p className="faint">Newest joined first · refreshes every 10 seconds.</p>
            </>
          )}
        </PanelState>
      ) : (
        <p className="faint">This provider does not expose an overview read; open the full page.</p>
      )}
    </section>
  );
}

function ClaimsPanel({ row }: { row: Row }) {
  const list = useTool<ClaimLite[]>('claim.list');
  const data = list.error ? undefined : list.data;
  const recent = [...(data ?? [])]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 3);
  return (
    <section className="card stack ov-panel">
      <PanelHead
        title={row.label}
        meta={data ? `${data.length} recorded` : undefined}
        link={{ to: row.path, label: 'All claims' }}
      />
      <PanelState loading={list.loading} error={list.error}>
        {data &&
          (recent.length ? (
            <ul className="ov-list">
              {recent.map((claim) => (
                <li key={claim.id} className="ov-claim">
                  <span className="ov-claim-text">{claim.statement}</span>
                  <span className="ov-item-meta">
                    <StatusPill value={claim.status} />
                    <span>{claim.confidence} confidence</span>
                    <When iso={claim.updatedAt} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No claims recorded yet.</p>
          ))}
      </PanelState>
    </section>
  );
}

function FeedPanel({ row }: { row: Row }) {
  return (
    <section className="card stack ov-panel">
      <PanelHead title="Project feed" link={{ to: row.path, label: row.label }} />
      <p className="muted">Follow findings, questions and progress shared by the team.</p>
    </section>
  );
}

function ArchivePanel({ row }: { row: Row }) {
  const summary = useTool<{ counts: Record<string, number> }>('ui.read', {
    rowId: row.id,
    params: { action: 'summary' },
  });
  if (row.status.count === 0 && !summary.error) return null;
  return (
    <section className="archive-feature">
      <div className="stack">
        <span className="page-eyebrow">Your research library</span>
        <h2>Pick up where your research left off</h2>
        <p className="muted">
          Your earlier findings, evidence and discussions are here to read. New work builds on them.
        </p>
        <PanelState loading={summary.loading} error={summary.error}>
          {summary.data && (
            <div className="archive-counts">
              {[
                ['experiments', 'experiments'],
                ['tasks', 'tasks'],
                ['reflections', 'reflections'],
                ['papers', 'papers'],
              ]
                .filter(([key]) => summary.data!.counts[key] > 0)
                .map(([key, label]) => (
                  <span key={key}>
                    <strong>{summary.data!.counts[key].toLocaleString()}</strong> {label}
                  </span>
                ))}
            </div>
          )}
        </PanelState>
      </div>
      <Link className="btn btn--primary" to={row.path}>
        Explore previous research →
      </Link>
    </section>
  );
}

export function OverviewView({ shell }: { shell: ShellData }) {
  const session = useSession();
  const projectRead = useTool<Project>('project.get');
  const project = projectRead.data ?? session.project;
  const [epoch, setEpoch] = useState(0);
  const rows = shell.rows;
  const find = (kind: string) => rows.find((row) => row.view.kind === kind);
  const research = find('research');
  const experiments = find('experiments');
  const tasks = find('tasks');
  const reviews = find('reviews');
  const claims = find('claims');
  const sessions = find('sessions');
  const feed = find('feed');
  const archive = find('legacy-history');
  const settings = rows.find((row) => row.group === 'settings');
  const intro = project.summary?.trim() || undefined;
  const hasWork = !!(research || experiments || tasks || reviews);
  const hasSide = !!(sessions || claims || feed);
  return (
    <div className="page-stage page-stage--wide overview">
      <PageHeader
        eyebrow={
          <span className="cluster">
            Overview <ObjId id={project.id} />
          </span>
        }
        title={project.name}
        summary={
          projectRead.error
            ? 'The project introduction could not refresh.'
            : projectRead.loading
              ? 'Loading project introduction…'
              : (intro ?? (
                  <>
                    No project introduction has been written yet.
                    {settings && (
                      <>
                        {' '}
                        Set one in <Link to={settings.path}>{settings.label}</Link>.
                      </>
                    )}
                  </>
                ))
        }
        actions={
          <button
            className="btn"
            onClick={() => {
              projectRead.reload();
              setEpoch((n) => n + 1);
            }}
          >
            Refresh
          </button>
        }
      />
      {rows.length === 0 ? (
        <div className="empty-state">
          <h2>This workspace is getting ready</h2>
          <p>Available areas will appear here as the workspace starts.</p>
        </div>
      ) : (
        <div key={epoch} className="stack stack--lg">
          {archive && <ArchivePanel key={archive.id} row={archive} />}
          <div className="ov-columns">
            <div className="ov-main stack stack--lg">
              {research && (
                <ResearchPanel
                  key={research.id}
                  row={research}
                  compactEmpty={!!archive?.status.count}
                />
              )}
              {experiments && (
                <ExperimentsPanel
                  key={experiments.id}
                  row={experiments}
                  compactEmpty={!!archive?.status.count}
                />
              )}
              {tasks && (
                <TasksPanel key={tasks.id} row={tasks} compactEmpty={!!archive?.status.count} />
              )}
              {reviews && (
                <ReviewsPanel
                  key={reviews.id}
                  row={reviews}
                  compactEmpty={!!archive?.status.count}
                />
              )}
              {!hasWork && (
                <section className="card stack">
                  <h2 className="section-title">Current work</h2>
                  <p className="muted">
                    No work areas are available right now. Explore the available areas in the
                    sidebar.
                  </p>
                </section>
              )}
            </div>
            {hasSide && (
              <aside className="ov-side stack stack--lg" aria-label="Project pulse">
                {sessions && <AgentsPanel key={sessions.id} row={sessions} />}
                {claims && <ClaimsPanel key={claims.id} row={claims} />}
                {feed && <FeedPanel key={feed.id} row={feed} />}
              </aside>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
