import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTool } from '../api';
import { ListPage } from '../list-filters';
import {
  Ago,
  KV,
  LoadState,
  ObjId,
  PageHeader,
  StatusPill,
  Table,
  col,
  recordRoutes,
} from '../components';
import {
  OPEN,
  ThreeStates,
  firstSentence,
  isOpenTask,
  newestReview,
  reviewClause,
} from '../states';
import { useActorNames } from './people';
import { ArtifactBody } from './artifacts';
import { CriterionRows, type Review } from './reviews';
import type { ViewProps } from './index';
import type {
  WorkflowDecision,
  WorkflowDependency,
  WorkflowWorkStart,
} from '@merv/contracts/workflow-guidance';

interface Confirmation {
  checkNumber: number;
  status: 'met' | 'not_met';
  evidenceIds: string[];
  notes: string;
}
interface Task {
  id: string;
  title: string;
  goal: string;
  checks: string[];
  deliveryConfirmations: Confirmation[];
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
  // The judgement of a task is a record of its own, so the list joins the
  // project's reviews once rather than fetching one per row.
  const reviews = useTool<Review[]>('review.list');
  const nameOf = useActorNames();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string>();
  const search = query.trim().toLowerCase();
  // The count in the title line is the filter: the page opens on the open tasks
  // it counted, and every state is one click away.
  const open = (list.data ?? []).filter((item) => isOpenTask(item.workflow.state)).length;
  const state = chosen ?? (open ? OPEN : '');
  const states = [
    OPEN,
    ...[...new Set((list.data ?? []).map((item) => item.workflow.state))].sort(),
  ];
  const visible = (list.data ?? []).filter(
    (item) =>
      (state === OPEN
        ? isOpenTask(item.workflow.state)
        : !state || item.workflow.state === state) &&
      (!search ||
        [item.title, item.goal, item.id, item.producerId, nameOf(item.producerId)].some((value) =>
          value?.toLowerCase().includes(search),
        )),
  );
  return (
    <ListPage
      list={list}
      noun="tasks"
      placeholder="Name, goal or person"
      query={query}
      onQueryChange={setQuery}
      state={state}
      onStateChange={setChosen}
      states={states}
      visible={visible.length}
      emptyTitle="No tasks yet"
      emptyHint="Tasks appear here once a producer opens one with a goal and its acceptance checks."
    >
      <Table
        rows={[...visible].reverse()}
        keyOf={(t) => t.id}
        onRow={(t) => t.id}
        columns={[
          col<Task>('title', 'Task', (t) => <strong>{t.title}</strong>),
          col<Task>('standing', 'Standing', (t) => {
            const review = newestReview(reviews.data, t.id);
            return (
              <ThreeStates
                execution={t.workflow.state}
                review={
                  reviewClause(review, nameOf(review?.reviewerId)) ?? {
                    word: 'not reviewed',
                    absent: true,
                  }
                }
                outcome={
                  t.failure
                    ? { detail: firstSentence(t.failure.reason) }
                    : { word: 'no outcome recorded', absent: true }
                }
              />
            );
          }),
          col<Task>(
            'producer',
            'Producer',
            (t) => nameOf(t.producerId) ?? <ObjId id={t.producerId} />,
          ),
          col<Task>('dependencies', 'Prerequisites', (t) =>
            t.dependencies?.length
              ? `${t.dependencies.filter((item) => item.settled).length}/${t.dependencies.length} succeeded`
              : 'None',
          ),
          col<Task>('when', 'Updated', (t) => <Ago at={t.workflow.updatedAt} />, '90px'),
        ]}
      />
    </ListPage>
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
        <LoadState {...task} back={{ to: row.path, label: row.label }} />
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
                col<Confirmation>(
                  'check',
                  'Check',
                  (item) => `${item.checkNumber}. ${t.checks[item.checkNumber - 1]}`,
                ),
                col<Confirmation>('claim', 'Producer claim', (item) =>
                  item.status === 'met' ? 'Met' : 'Not met',
                ),
                col<Confirmation>('notes', 'Verification / remaining work', (item) => (
                  <span style={{ whiteSpace: 'pre-wrap' }}>{item.notes}</span>
                )),
                col<Confirmation>('evidence', 'Evidence', (item) =>
                  item.evidenceIds.length
                    ? item.evidenceIds.map((id) => (
                        <div key={id}>
                          <Link to={`/artifacts/${id}`}>
                            <ObjId id={id} />
                          </Link>
                        </div>
                      ))
                    : 'None supplied',
                ),
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
            col<WorkflowWorkStart>('revision', 'Revision', (start) => start.revision),
            col<WorkflowWorkStart>('state', 'Stage', (start) => <StatusPill value={start.state} />),
            col<WorkflowWorkStart>('started', 'First began work', describe),
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
          col<WorkflowDependency>('name', 'Work item', (item) =>
            item.workflow === 'task' ? (
              <Link to={`${taskPath}/${item.id}`}>{item.name || item.id}</Link>
            ) : (
              <span>
                {item.name || item.id} <ObjId id={item.id} />
              </span>
            ),
          ),
          col<WorkflowDependency>('workflow', 'Type', (item) => item.workflow),
          col<WorkflowDependency>('state', 'State', (item) => <StatusPill value={item.state} />),
          col<WorkflowDependency>('settled', 'Outcome', (item) =>
            item.settled
              ? 'Succeeded'
              : item.failed
                ? 'Ended without success'
                : 'Not yet satisfied',
          ),
        ]}
      />
    </section>
  );
}

export const TasksView = recordRoutes(TaskList, TaskDetail);
