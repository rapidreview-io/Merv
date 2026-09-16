import { useId, useState } from 'react';
import { Link, Route, Routes, useParams } from 'react-router-dom';
import type {
  Experiment,
  ExperimentEvidence,
  ExperimentExhibit,
  ExperimentGraphView,
} from '@merv/experiments/models';
import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { useTool } from '../api';
import { ListFilters } from '../list-filters';
import { KV, LoadState, ObjId, PageHeader, StatusPill, Table, relativeTime } from '../components';
import { CriterionRows, type Review } from './reviews';
import { useActorNames } from './people';
import type { ViewProps } from './index';

function EvidenceTable({ evidence }: { evidence: ExperimentEvidence[] }) {
  return (
    <Table
      rows={evidence}
      keyOf={(item) => item.id}
      columns={[
        { key: 'role', label: 'Role', render: (item) => <StatusPill value={item.role} /> },
        {
          key: 'path',
          label: 'Evidence',
          render: (item) => (
            <Link to={`/artifacts/${item.artifactId}`} title={item.hash}>
              {item.path}
            </Link>
          ),
        },
        { key: 'attempt', label: 'Attempt', render: (item) => String(item.attemptIndex) },
        { key: 'producer', label: 'Attached by', render: (item) => <ObjId id={item.createdBy} /> },
        {
          key: 'when',
          label: 'Retained',
          render: (item) => <span title={item.createdAt}>{relativeTime(item.createdAt)}</span>,
        },
      ]}
    />
  );
}

function FigureLinks({ ids }: { ids: string[] }) {
  return ids.length ? (
    <div className="cluster">
      Figures:{' '}
      {ids.map((id) => (
        <Link key={id} to={`/artifacts/${id}`}>
          <ObjId id={id} />
        </Link>
      ))}
    </div>
  ) : null;
}

function visibleReviewId(experiment?: Experiment): string | null {
  if (!experiment) return null;
  if (experiment.reviewId) return experiment.reviewId;
  return (
    [...experiment.submissions].sort((a, b) => b.subjectRevision - a.subjectRevision)[0]
      ?.reviewId ?? null
  );
}

/** The bounded, validated graph stays code-native and uses the UI's existing theme. */
export function ExperimentGraph({
  graph,
  currentAttempt,
}: {
  graph: ExperimentGraphView;
  currentAttempt: number;
}) {
  const marker = useId();
  const doc = graph.document as {
    nodes?: { id: string; label: string }[];
    edges?: { from: string; to: string }[];
  } | null;
  if (!doc || !Array.isArray(doc.nodes) || !doc.nodes.length)
    return <p className="muted">No readable graph document.</p>;
  const nodes = doc.nodes,
    edges = doc.edges ?? [];
  const levels = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const edge of edges) {
      const from = levels.get(edge.from),
        to = levels.get(edge.to);
      if (from !== undefined && to !== undefined && to < from + 1) {
        levels.set(edge.to, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const columns = new Map<number, number>();
  const positions = new Map(
    nodes.map((node) => {
      const level = levels.get(node.id) ?? 0,
        row = columns.get(level) ?? 0;
      columns.set(level, row + 1);
      return [node.id, { x: 24 + level * 216, y: 24 + row * 108 }];
    }),
  );
  const width = Math.max(640, (Math.max(...levels.values()) + 1) * 216 + 16);
  const height = Math.max(132, Math.max(...columns.values()) * 108 + 24);
  return (
    <section className="stack" aria-label="Experiment logic graph">
      <div className="cluster--between">
        <h2 className="section-title">Logic graph</h2>
        <Link to={`/artifacts/${graph.evidence.artifactId}`}>
          Retained graph <ObjId id={graph.evidence.artifactId} />
        </Link>
      </div>
      <p className="muted">
        Attempt {graph.attemptIndex}
        {graph.attemptIndex !== currentAttempt
          ? ' · historical evidence from an earlier attempt'
          : ''}
        . Arrows follow the submitted graph; they do not imply that a claim has been accepted.
      </p>
      <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
        <svg
          role="img"
          aria-label={`Experiment logic graph from attempt ${graph.attemptIndex}`}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
        >
          <defs>
            <marker
              id={marker}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--steel)" />
            </marker>
          </defs>
          {edges.map((edge, index) => {
            const from = positions.get(edge.from),
              to = positions.get(edge.to);
            if (!from || !to) return null;
            return (
              <path
                key={index}
                d={`M ${from.x + 172} ${from.y + 34} C ${from.x + 194} ${from.y + 34}, ${to.x - 22} ${to.y + 34}, ${to.x - 2} ${to.y + 34}`}
                fill="none"
                stroke="var(--steel)"
                strokeWidth="1.5"
                markerEnd={`url(#${marker})`}
              />
            );
          })}
          {nodes.map((node) => {
            const point = positions.get(node.id)!;
            const label = node.label.length > 46 ? `${node.label.slice(0, 43)}…` : node.label;
            const split =
              label.length > 23 ? Math.max(label.lastIndexOf(' ', 23), 16) : label.length;
            return (
              <g key={node.id} transform={`translate(${point.x},${point.y})`}>
                <title>
                  {node.id}: {node.label}
                </title>
                <rect
                  width="172"
                  height="68"
                  rx="6"
                  fill="var(--bg-elev)"
                  stroke="var(--line-strong)"
                />
                <text x="12" y="25" fill="var(--text)" fontSize="12">
                  <tspan x="12">{label.slice(0, split)}</tspan>
                  <tspan x="12" dy="18">
                    {label.slice(split).trim()}
                  </tspan>
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <details>
        <summary>Full graph document</summary>
        <pre className="doc doc--inline">{JSON.stringify(graph.document, null, 2)}</pre>
      </details>
    </section>
  );
}

export function ExperimentRecord({
  experiment: e,
  guidance,
  review,
  graph,
  exhibit,
  nameOf,
}: {
  experiment: Experiment;
  guidance?: WorkflowDecision;
  review?: Review;
  graph?: ExperimentGraphView | null;
  exhibit?: ExperimentExhibit;
  nameOf(id: string | null | undefined): string | undefined;
}) {
  const approved = e.submissions.find(
    (submission) => submission.id === e.attempt.approvedSubmissionId,
  );
  const currentEvidence = e.evidence.filter(
    (item) => item.current && item.attemptIndex === e.attempt.index,
  );
  const decision = guidance?.revision === e.workflow.revision ? guidance : undefined;
  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow={<Link to="/experiments">← Experiments</Link>}
        title={e.name}
        summary={e.intent}
        actions={<StatusPill value={e.workflow.state} />}
      />
      <section className="stack" aria-label="Experiment workflow guidance">
        <h2 className="section-title">What happens next</h2>
        {decision ? (
          <>
            <p>{decision.instruction}</p>
            <KV
              rows={[
                ['Current gate', decision.currentGate.replaceAll('_', ' ')],
                [
                  'Next action',
                  decision.nextAction?.action.replaceAll('_', ' ') ??
                    (decision.terminal ? 'Finished' : 'Waiting'),
                ],
              ]}
            />
            {!!decision.blockers.length && (
              <ul className="checks">
                {decision.blockers.map((blocker, index) => (
                  <li key={index}>{blocker.message}</li>
                ))}
              </ul>
            )}
            {!!decision.dependencies.length && (
              <Table
                rows={decision.dependencies}
                keyOf={(item) => item.id}
                columns={[
                  {
                    key: 'work',
                    label: 'Prerequisite',
                    render: (item) =>
                      ['task', 'experiment'].includes(item.workflow) ? (
                        <Link
                          to={`/${item.workflow === 'task' ? 'tasks' : 'experiments'}/${item.id}`}
                        >
                          {item.name || <ObjId id={item.id} />}
                        </Link>
                      ) : (
                        <ObjId id={item.id} />
                      ),
                  },
                  {
                    key: 'state',
                    label: 'State',
                    render: (item) => <StatusPill value={item.state} />,
                  },
                  {
                    key: 'gate',
                    label: 'Execution gate',
                    render: (item) =>
                      item.settled ? 'Satisfied' : item.failed ? 'Failed prerequisite' : 'Waiting',
                  },
                ]}
              />
            )}
          </>
        ) : (
          <p className="muted">Refreshing guidance for revision {e.workflow.revision}…</p>
        )}
      </section>
      {!!e.attempt.feedback.length && (
        <section className="stack">
          <h2 className="section-title">Recovery and review feedback</h2>
          {e.attempt.feedback.map((message, index) => (
            <p key={index} style={{ whiteSpace: 'pre-wrap' }}>
              {message}
            </p>
          ))}
        </section>
      )}
      {e.conclusion && (
        <section className="stack">
          <h2 className="section-title">
            {['failed', 'abandoned'].includes(e.workflow.state)
              ? 'Why this experiment ended'
              : 'Conclusion'}
          </h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{e.conclusion}</p>
        </section>
      )}
      {approved && (
        <section className="stack" aria-label="Exact approved plan">
          <h2 className="section-title">Approved plan</h2>
          <p className="muted">
            Execution uses this sealed design from attempt {approved.attemptIndex}, reviewed in{' '}
            <Link to={`/reviews/${approved.reviewId}`}>
              <ObjId id={approved.reviewId} />
            </Link>
            .
          </p>
          <EvidenceTable evidence={approved.evidence} />
          <FigureLinks ids={approved.figureIds} />
        </section>
      )}
      <section className="stack">
        <h2 className="section-title">Current attempt evidence</h2>
        {currentEvidence.length ? (
          <EvidenceTable evidence={currentEvidence} />
        ) : (
          <p className="empty">No evidence retained for this attempt yet.</p>
        )}
      </section>
      {exhibit && exhibit.attemptIndex === e.attempt.index && e.workflow.state === 'running' && (
        <section className="stack" aria-label="Metrics preview">
          <h2 className="section-title">Metrics exhibit preview</h2>
          <p className="muted">
            {exhibit.willPin
              ? 'Result submission will retain this source-backed exhibit with its review round.'
              : 'The current evidence is qualitative; no quantitative exhibit will be pinned.'}{' '}
            This preview is not a review verdict.
          </p>
          <details>
            <summary>{exhibit.path}</summary>
            <pre className="doc doc--inline">{exhibit.content}</pre>
          </details>
        </section>
      )}
      {review && review.id === visibleReviewId(e) && (
        <section className="stack">
          <h2 className="section-title">{e.reviewId ? 'Current review' : 'Latest review'}</h2>
          <CriterionRows review={review} head />
        </section>
      )}
      {graph && <ExperimentGraph graph={graph} currentAttempt={e.attempt.index} />}
      {e.details && (
        <details>
          <summary>Experiment details</summary>
          <p style={{ whiteSpace: 'pre-wrap' }}>{e.details}</p>
        </details>
      )}
      {!!e.testedClaimIds.length && (
        <section className="stack">
          <h2 className="section-title">Tested claims</h2>
          <div className="cluster">
            {e.testedClaimIds.map((id) => (
              <Link key={id} to="/claims">
                <ObjId id={id} />
              </Link>
            ))}
          </div>
          <p className="muted">
            A completed experiment does not automatically change a claim's status.
          </p>
        </section>
      )}
      <section className="stack" aria-label="Experiment submission history">
        <h2 className="section-title">Sealed submissions</h2>
        {e.submissions.length ? (
          [...e.submissions].reverse().map((submission) => (
            <details className="card" key={submission.id}>
              <summary>
                Attempt {submission.attemptIndex} ·{' '}
                {submission.stage === 'design' ? 'Design' : 'Results'} · round {submission.round}
              </summary>
              <div className="stack">
                <p className="muted">
                  Revision {submission.subjectRevision}, authored by{' '}
                  {nameOf(submission.producerId) ?? <ObjId id={submission.producerId} />}.{' '}
                  <Link to={`/reviews/${submission.reviewId}`}>Read independent review</Link>
                </p>
                <EvidenceTable evidence={submission.evidence} />
                <FigureLinks ids={submission.figureIds} />
                <span className="mono faint" title={submission.manifestHash}>
                  Manifest {submission.manifestHash.slice(0, 16)}
                </span>
              </div>
            </details>
          ))
        ) : (
          <p className="empty">Nothing submitted for review yet.</p>
        )}
      </section>
      <section className="stack">
        <h2 className="section-title">Attempts</h2>
        <Table
          rows={e.attempts}
          keyOf={(attempt) => String(attempt.index)}
          columns={[
            { key: 'attempt', label: 'Attempt', render: (attempt) => String(attempt.index) },
            {
              key: 'revision',
              label: 'Revisions',
              render: (attempt) =>
                `${attempt.startedRevision}–${attempt.endedRevision ?? 'current'}`,
            },
            {
              key: 'start',
              label: 'First execution',
              render: (attempt) =>
                attempt.startedAt ? (
                  <span title={attempt.startedAt}>
                    {new Date(attempt.startedAt).toLocaleString()}
                  </span>
                ) : (
                  'Not started'
                ),
            },
            {
              key: 'design',
              label: 'Approved design',
              render: (attempt) =>
                attempt.approvedReviewId ? (
                  <Link to={`/reviews/${attempt.approvedReviewId}`}>
                    <ObjId id={attempt.approvedReviewId} />
                  </Link>
                ) : (
                  'None'
                ),
            },
          ]}
        />
      </section>
      <section className="stack" aria-label="Experiment record details">
        <h2 className="section-title">Record details</h2>
        <KV
          rows={[
            ['Id', <ObjId id={e.id} strong />],
            ['Owner', nameOf(e.ownerId) ?? <ObjId id={e.ownerId} />],
            ['Attempt', String(e.attempt.index)],
            ['Revision', String(e.workflow.revision)],
            [
              'Execution began',
              e.attempt.startedAt ? new Date(e.attempt.startedAt).toLocaleString() : 'Not started',
            ],
            ['Created', new Date(e.createdAt).toLocaleString()],
          ]}
        />
      </section>
    </div>
  );
}

function ExperimentList() {
  const list = useTool<Experiment[]>('experiment.list', {}, { every: 8000 });
  const nameOf = useActorNames();
  const [query, setQuery] = useState('');
  const [state, setState] = useState('');
  const search = query.trim().toLowerCase();
  const states = [
    ...new Set([
      ...(list.data ?? []).map((item) => item.workflow.state),
      ...(state ? [state] : []),
    ]),
  ].sort();
  const visible = (list.data ?? []).filter(
    (item) =>
      (!state || item.workflow.state === state) &&
      (!search ||
        [item.name, item.intent, item.id, item.ownerId, nameOf(item.ownerId)].some((value) =>
          value?.toLowerCase().includes(search),
        )),
  );
  return (
    <div className="page-stage stack">
      {list.data && list.data.length > 0 && !list.error && (
        <ListFilters
          noun="experiments"
          placeholder="Name, question or person"
          query={query}
          onQueryChange={setQuery}
          state={state}
          onStateChange={setState}
          states={states}
          shown={visible.length}
          total={list.data.length}
        />
      )}
      <LoadState
        loading={list.loading}
        error={list.error}
        empty={list.data?.length === 0}
        emptyTitle="No experiments yet"
        emptyHint="Experiments appear here once a producer opens one to test a claim."
      />
      {list.data &&
        list.data.length > 0 &&
        !list.error &&
        !list.loading &&
        visible.length === 0 && (
          <LoadState
            loading={false}
            empty
            emptyTitle="No experiments match these filters"
            emptyHint="Try another search or clear the filters."
          />
        )}
      {visible.length > 0 && !list.error && (
        <Table
          rows={[...visible].reverse()}
          keyOf={(e) => e.id}
          onRow={(e) => e.id}
          columns={[
            { key: 'name', label: 'Experiment', render: (e) => <strong>{e.name}</strong> },
            {
              key: 'state',
              label: 'State',
              render: (e) => <StatusPill value={e.workflow.state} />,
            },
            { key: 'attempt', label: 'Attempt', render: (e) => String(e.attempt.index) },
            {
              key: 'owner',
              label: 'Owner',
              render: (e) => nameOf(e.ownerId) ?? <ObjId id={e.ownerId} />,
            },
            {
              key: 'updated',
              label: 'Updated',
              render: (e) => (
                <span title={e.workflow.updatedAt}>{relativeTime(e.workflow.updatedAt)}</span>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

function ExperimentDetail({ row }: ViewProps) {
  const { id = '' } = useParams();
  const experiment = useTool<Experiment>(
    'experiment.get_state',
    { experimentId: id },
    { every: 8000 },
  );
  const guidance = useTool<WorkflowDecision>(
    'workflow.status_and_next',
    { instanceId: id },
    { every: 8000 },
  );
  const review = useTool<Review>(
    visibleReviewId(experiment.data) ? 'review.get' : null,
    { reviewId: visibleReviewId(experiment.data) ?? '' },
    { every: 8000 },
  );
  const graph = useTool<ExperimentGraphView | null>(
    'experiment.graph',
    { experimentId: id },
    { every: 8000 },
  );
  const exhibit = useTool<ExperimentExhibit>(
    experiment.data?.workflow.state === 'running' ? 'experiment.exhibit' : null,
    { experimentId: id },
    { every: 8000 },
  );
  const nameOf = useActorNames();
  return (
    <div className="page-stage stack stack--lg">
      <LoadState
        loading={experiment.loading}
        error={experiment.error}
        back={experiment.data ? undefined : { to: row.path, label: row.label }}
      />
      {experiment.data && (
        <>
          <LoadState
            loading={false}
            error={guidance.error ?? review.error ?? graph.error ?? exhibit.error}
          />
          <ExperimentRecord
            experiment={experiment.data}
            guidance={guidance.data}
            review={review.data}
            graph={graph.data}
            exhibit={exhibit.data}
            nameOf={nameOf}
          />
        </>
      )}
    </div>
  );
}

export function ExperimentsView(props: ViewProps) {
  return (
    <Routes>
      <Route index element={<ExperimentList />} />
      <Route path=":id" element={<ExperimentDetail {...props} />} />
    </Routes>
  );
}
