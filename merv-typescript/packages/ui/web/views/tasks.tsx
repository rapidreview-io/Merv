import { Link, useParams } from 'react-router-dom';
import { useTool } from '../api';
import { splitRoutes } from '../list-filters';
import { WORK } from '../navigation';
import {
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
import { useActorNames } from './people';
import { ArtifactBody } from './artifacts';
import { CriterionRows, type Review } from './reviews';
import { WorkList } from './work';
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
export interface Task {
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
        <LoadState {...task} back={{ to: WORK.path, label: 'Work' }} />
      </div>
    );
  const t = task.data;
  return (
    <RecordPage
      back={<Link to={WORK.path}>← Work</Link>}
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

export const TasksView = splitRoutes(WorkList, TaskDetail, WORK.path);
