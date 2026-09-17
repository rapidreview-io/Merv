import { Link, useParams } from 'react-router-dom';
import { useTool } from '../api';
import { ListPage, matches, splitRoutes, useListFilter } from '../list-filters';
import { useSession } from '../session';
import {
  Ago,
  GateBox,
  KV,
  LoadState,
  RecordPage,
  StatusPill,
  Table,
  col,
  stamp,
  useArtifacts,
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
  const { actor } = useSession();
  const { id: openId } = useParams();
  const filter = useListFilter(list.data, (item) => item.workflow.state, isOpenTask);
  const { state, scope, search } = filter;
  // The record open beside the list is always one of its rows, whatever the
  // filters say, so the pane never marks a row that is not there.
  const visible = (list.data ?? []).filter(
    (item) =>
      item.id === openId ||
      ((state === OPEN
        ? isOpenTask(item.workflow.state)
        : !state || item.workflow.state === state) &&
        (scope === 'everyone' || item.producerId === actor.id) &&
        matches(
          search,
          [item.title, item.goal, nameOf(item.producerId)],
          [item.id, item.producerId],
        )),
  );
  return (
    <ListPage
      list={list}
      noun="tasks"
      placeholder="Name, goal or person"
      filter={filter}
      rows={[...visible].reverse()}
      emptyTitle="No tasks yet"
      emptyHint="Tasks appear here once a producer opens one with a goal and its acceptance checks."
      columns={[
        col<Task>('title', 'Task', (t) => (
          <strong className={t.id === openId ? 'row-open' : undefined}>{t.title}</strong>
        )),
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
        col<Task>('producer', 'Producer', (t) => nameOf(t.producerId)),
        col<Task>('dependencies', 'Prerequisites', (t) =>
          t.dependencies?.length
            ? `${t.dependencies.filter((item) => item.settled).length}/${t.dependencies.length} succeeded`
            : 'None',
        ),
        col<Task>('when', 'Updated', (t) => <Ago at={t.workflow.updatedAt} />, '90px'),
      ]}
    />
  );
}

function TaskDetail({ row }: ViewProps) {
  const { id = '' } = useParams();
  const task = useTool<Task>('task.get', { taskId: id }, { every: 8000 });
  const nameOf = useActorNames();
  const artifacts = useArtifacts();
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
    <RecordPage
      back={<Link to={row.path}>← {row.label}</Link>}
      kind={row.view.kind}
      name={t.title}
      standing={t.goal}
      state={<StatusPill value={t.workflow.state} />}
      act={<GateBox decision={t.guidance} />}
      title="Brief"
      content={
        <>
          <ArtifactBody artifactId={t.briefId} />
          <h3 className="ev-role">Acceptance checks</h3>
          <ol className="checks">
            {t.checks.map((check, i) => (
              <li key={i}>{check}</li>
            ))}
          </ol>
          <h3 className="ev-role">Deliveries</h3>
          {t.deliveryConfirmations?.length > 0 && (
            <>
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
                  // A file is named by its title; one this page cannot name is left out.
                  col<Confirmation>('evidence', 'Evidence', (item) =>
                    item.evidenceIds.length
                      ? item.evidenceIds.map((id) => (
                          <div key={id}>
                            <Link to={`/artifacts/${id}`}>{artifacts.get(id)?.title}</Link>
                          </div>
                        ))
                      : 'None supplied',
                  ),
                ]}
              />
            </>
          )}
          {t.deliveryIds.length === 0 && <div className="empty">Nothing delivered yet.</div>}
          {t.deliveryIds.map((artifactId) => (
            <ArtifactBody key={artifactId} artifactId={artifactId} />
          ))}
        </>
      }
      history={
        <>
          {t.failure && (
            <>
              <h3 className="ev-role">Why this task ended</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{t.failure.reason}</p>
              <p className="muted">
                Closed by {nameOf(t.failure.actorId)} on {stamp(t.failure.createdAt)}
              </p>
            </>
          )}
          <WorkStarts
            starts={t.workStarts ?? []}
            current={t.guidance.workStart}
            terminal={t.guidance.terminal}
            nameOf={nameOf}
          />
        </>
      }
      related={
        <>
          <WorkRelations title="Waits on" items={t.dependencies ?? []} taskPath={row.path} />
          <WorkRelations title="Unblocks" items={t.dependents ?? []} taskPath={row.path} />
          <h3 className="ev-role">Review</h3>
          {!t.reviewId && <div className="empty">No review has been requested.</div>}
          {t.reviewId && !review.data && (
            <LoadState loading={review.loading} error={review.error} />
          )}
          {review.data && <CriterionRows review={review.data} head />}
        </>
      }
      details={
        <KV
          rows={[
            ['Producer', nameOf(t.producerId)],
            ['Revision', String(t.workflow.revision)],
            ['Created', stamp(t.createdAt)],
            ['Updated', stamp(t.workflow.updatedAt)],
          ]}
        />
      }
    />
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
  const describe = (start: WorkflowWorkStart) =>
    [stamp(start.startedAt), nameOf(start.actorId)].filter(Boolean).join(' by ');
  return (
    <>
      <h3 className="ev-role">Work starts</h3>
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
    </>
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
    <>
      <h3 className="ev-role">{title}</h3>
      <Table
        rows={items}
        keyOf={(item) => item.id}
        columns={[
          col<WorkflowDependency>('name', 'Work item', (item) =>
            item.workflow === 'task' ? (
              <Link to={`${taskPath}/${item.id}`}>{item.name}</Link>
            ) : (
              item.name
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
    </>
  );
}

export const TasksView = splitRoutes(TaskList, TaskDetail);
