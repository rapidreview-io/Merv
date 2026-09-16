import { useState } from 'react';
import { Link, Route, Routes, useParams } from 'react-router-dom';
import { useTool } from '../api';
import { ListFilters } from '../list-filters';
import { KV, LoadState, ObjId, PageHeader, StatusPill, Table, relativeTime } from '../components';
import { useActorNames } from './people';
import { ArtifactBody } from './artifacts';
import { CriterionRows, type Review } from './reviews';
import type { ViewProps } from './index';
import type {
  WorkflowDecision,
  WorkflowDependency,
  WorkflowWorkStart,
} from '@merv/contracts/workflow-guidance';

interface Task {
  id: string;
  title: string;
  goal: string;
  checks: string[];
  evidenceVersion: 1 | 2;
  acceptanceChecks: { number: number; text: string }[];
  deliveryConfirmations: {
    checkNumber: number;
    status: 'met' | 'not_met';
    evidenceIds: string[];
    notes: string;
  }[];
  deliveryAssessmentId: string | null;
  producerId: string;
  briefId: string;
  deliveryIds: string[];
  reviewId: string | null;
  workflow: { state: string; revision: number; updatedAt: string };
  guidance: WorkflowDecision;
  failure: { reason: string; actorId: string; createdAt: string } | null;
  dependencies: WorkflowDependency[];
  dependents: WorkflowDependency[];
  workStarts: WorkflowWorkStart[];
  createdAt: string;
}

function TaskList() {
  const list = useTool<Task[]>('task.list', {}, { every: 8000 });
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
        [item.title, item.goal, item.id, item.producerId, nameOf(item.producerId)].some((value) =>
          value?.toLowerCase().includes(search),
        )),
  );
  return (
    <div className="page-stage stack">
      {list.data && list.data.length > 0 && !list.error && (
        <ListFilters
          noun="tasks"
          placeholder="Name, goal or person"
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
        emptyTitle="No tasks yet"
        emptyHint="Tasks appear here once a producer opens one with a goal and its acceptance checks."
      />
      {list.data &&
        list.data.length > 0 &&
        !list.error &&
        !list.loading &&
        visible.length === 0 && (
          <LoadState
            loading={false}
            empty
            emptyTitle="No tasks match these filters"
            emptyHint="Try another search or clear the filters."
          />
        )}
      {visible.length > 0 && !list.error && (
        <Table
          rows={[...visible].reverse()}
          keyOf={(t) => t.id}
          onRow={(t) => t.id}
          columns={[
            { key: 'title', label: 'Task', render: (t) => <strong>{t.title}</strong> },
            {
              key: 'state',
              label: 'State',
              render: (t) => <StatusPill value={t.workflow.state} />,
            },
            {
              key: 'rev',
              label: 'Rev',
              render: (t) => <span className="tabular">{t.workflow.revision}</span>,
              width: '60px',
            },
            {
              key: 'producer',
              label: 'Producer',
              render: (t) => nameOf(t.producerId) ?? <ObjId id={t.producerId} />,
            },
            {
              key: 'dependencies',
              label: 'Prerequisites',
              render: (t) =>
                t.dependencies?.length
                  ? `${t.dependencies.filter((item) => item.settled).length}/${t.dependencies.length} succeeded`
                  : 'None',
            },
            {
              key: 'deliveries',
              label: 'Deliveries',
              render: (t) => <span className="tabular">{t.deliveryIds.length}</span>,
              width: '90px',
            },
            {
              key: 'when',
              label: 'Updated',
              render: (t) => (
                <span title={t.workflow.updatedAt}>{relativeTime(t.workflow.updatedAt)}</span>
              ),
              width: '90px',
            },
          ]}
        />
      )}
    </div>
  );
}

function TaskDetail({ row }: ViewProps) {
  const { id = '' } = useParams();
  const task = useTool<Task>('task.get', { taskId: id }, { every: 8000 });
  const nameOf = useActorNames();
  const review = useTool<Review>(task.data?.reviewId ? 'review.get' : null, {
    reviewId: task.data?.reviewId ?? '',
  });
  if (!task.data)
    return (
      <div className="page-stage">
        <LoadState
          loading={task.loading}
          error={task.error}
          back={{ to: row.path, label: row.label }}
        />
      </div>
    );
  const t = task.data;
  return (
    <div className="page-stage stack stack--lg">
      <PageHeader
        eyebrow={<Link to={row.path}>← {row.label}</Link>}
        kind={row.view.kind}
        title={t.title}
        summary={t.goal}
        actions={<StatusPill value={t.workflow.state} />}
      />
      {t.failure && (
        <section className="stack" aria-label="Task closure">
          <h2 className="section-title">Why this task ended</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{t.failure.reason}</p>
          <p className="muted">
            Closed by {nameOf(t.failure.actorId) ?? <ObjId id={t.failure.actorId} />} on{' '}
            {new Date(t.failure.createdAt).toLocaleString()}
          </p>
        </section>
      )}
      <section className="stack" aria-label="Workflow guidance">
        <h2 className="section-title">What happens next</h2>
        <p>{t.guidance.instruction}</p>
        <KV
          rows={[
            ['Current gate', t.guidance.currentGate.replaceAll('_', ' ')],
            [
              'Next action',
              t.guidance.nextAction?.action.replaceAll('_', ' ') ??
                (t.guidance.terminal ? 'Finished' : 'Waiting'),
            ],
          ]}
        />
        {t.guidance.blockers.length > 0 && (
          <ul className="checks">
            {t.guidance.blockers.map((blocker, index) => (
              <li key={index}>{blocker.message}</li>
            ))}
          </ul>
        )}
      </section>
      <WorkRelations title="Waits on" items={t.dependencies ?? []} taskPath={row.path} />
      <section className="stack">
        <h2 className="section-title">Acceptance checks</h2>
        <ol className="checks">
          {t.checks.map((check, i) => (
            <li key={i}>{check}</li>
          ))}
        </ol>
      </section>
      <section className="stack">
        <h2 className="section-title">Deliveries</h2>
        {t.deliveryConfirmations?.length > 0 && (
          <section className="stack" aria-label="Producer confirmations">
            <p className="muted">
              Producer claims for the latest delivery. The independent review determines whether
              they are supported.
            </p>
            <Table
              rows={t.deliveryConfirmations}
              keyOf={(item) => String(item.checkNumber)}
              columns={[
                {
                  key: 'check',
                  label: 'Check',
                  render: (item) => `${item.checkNumber}. ${t.checks[item.checkNumber - 1]}`,
                },
                {
                  key: 'claim',
                  label: 'Producer claim',
                  render: (item) => (item.status === 'met' ? 'Met' : 'Not met'),
                },
                {
                  key: 'notes',
                  label: 'Verification / remaining work',
                  render: (item) => <span style={{ whiteSpace: 'pre-wrap' }}>{item.notes}</span>,
                },
                {
                  key: 'evidence',
                  label: 'Evidence',
                  render: (item) =>
                    item.evidenceIds.length
                      ? item.evidenceIds.map((id) => (
                          <div key={id}>
                            <Link to={`/artifacts/${id}`}>
                              <ObjId id={id} />
                            </Link>
                          </div>
                        ))
                      : 'None supplied',
                },
              ]}
            />
          </section>
        )}
        {t.deliveryIds.length === 0 && <div className="empty">Nothing delivered yet.</div>}
        {t.deliveryIds.map((artifactId) => (
          <ArtifactBody key={artifactId} artifactId={artifactId} />
        ))}
      </section>
      <section className="stack">
        <h2 className="section-title">Review</h2>
        {!t.reviewId && <div className="empty">No review has been requested.</div>}
        {t.reviewId && !review.data && <LoadState loading={review.loading} error={review.error} />}
        {review.data && <CriterionRows review={review.data} head />}
      </section>
      <section className="stack">
        <h2 className="section-title">Brief</h2>
        <ArtifactBody artifactId={t.briefId} />
      </section>
      <section className="stack" aria-label="Task record details">
        <h2 className="section-title">Record details</h2>
        <KV
          rows={[
            ['Id', <ObjId id={t.id} strong />],
            ['Producer', nameOf(t.producerId) ?? <ObjId id={t.producerId} />],
            ['Revision', String(t.workflow.revision)],
            ['Created', new Date(t.createdAt).toLocaleString()],
            ['Updated', new Date(t.workflow.updatedAt).toLocaleString()],
          ]}
        />
      </section>
      <WorkStarts
        starts={t.workStarts ?? []}
        current={t.guidance.workStart}
        terminal={t.guidance.terminal}
        nameOf={nameOf}
      />
      <WorkRelations title="Unblocks" items={t.dependents ?? []} taskPath={row.path} />
    </div>
  );
}

function WorkStarts({
  starts,
  current,
  terminal,
  nameOf,
}: {
  starts: WorkflowWorkStart[];
  current: WorkflowWorkStart | null;
  terminal: boolean;
  nameOf: ReturnType<typeof useActorNames>;
}) {
  const ordered = [...starts].sort((left, right) => left.revision - right.revision);
  const describe = (start: WorkflowWorkStart) => (
    <>
      {new Date(start.startedAt).toLocaleString()} by{' '}
      {nameOf(start.actorId) ?? <ObjId id={start.actorId} />}
    </>
  );
  return (
    <section className="stack" aria-label="Recorded work starts">
      <h2 className="section-title">Work starts</h2>
      <p className="muted">
        Each entry records who first began work at that revision. The producer and current review
        claim determine who can work now.
      </p>
      <KV
        rows={[
          ['First recorded start', ordered[0] ? describe(ordered[0]) : 'No start recorded'],
          [
            'Current revision',
            current
              ? describe(current)
              : terminal
                ? 'No active assignment'
                : 'No start recorded at this revision',
          ],
        ]}
      />
      {ordered.length > 0 && (
        <Table
          rows={ordered}
          keyOf={(start) => String(start.revision)}
          columns={[
            { key: 'revision', label: 'Revision', render: (start) => start.revision },
            { key: 'state', label: 'Stage', render: (start) => <StatusPill value={start.state} /> },
            { key: 'started', label: 'First began work', render: describe },
          ]}
        />
      )}
    </section>
  );
}

function WorkRelations({
  title,
  items,
  taskPath,
}: {
  title: string;
  items: WorkflowDependency[];
  taskPath: string;
}) {
  if (!items.length) return null;
  return (
    <section className="stack" aria-label={title}>
      <h2 className="section-title">{title}</h2>
      <Table
        rows={items}
        keyOf={(item) => item.id}
        columns={[
          {
            key: 'name',
            label: 'Work item',
            render: (item) =>
              item.workflow === 'task' ? (
                <Link to={`${taskPath}/${item.id}`}>{item.name || item.id}</Link>
              ) : (
                <span>
                  {item.name || item.id} <ObjId id={item.id} />
                </span>
              ),
          },
          { key: 'workflow', label: 'Type', render: (item) => item.workflow },
          { key: 'state', label: 'State', render: (item) => <StatusPill value={item.state} /> },
          {
            key: 'settled',
            label: 'Outcome',
            render: (item) =>
              item.settled
                ? 'Succeeded'
                : item.failed
                  ? 'Ended without success'
                  : 'Not yet satisfied',
          },
        ]}
      />
    </section>
  );
}

export function TasksView(props: ViewProps) {
  return (
    <Routes>
      <Route index element={<TaskList />} />
      <Route path=":id" element={<TaskDetail {...props} />} />
    </Routes>
  );
}
