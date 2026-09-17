import { Link, useParams } from 'react-router-dom';
import { useTool } from '../api';
import { splitRoutes } from '../list-filters';
import { WORK } from '../navigation';
import {
  KV,
  LoadState,
  RecordPage,
  StatusPill,
  Table,
  col,
  stamp,
  useArtifacts,
} from '../components';
import { Gate } from '../process';
import { useActorNames } from './people';
import { ArtifactBody } from './artifacts';
import { CriterionRows, type Review } from './reviews';
import { WorkList } from './work';
import type { ViewProps } from './index';
import type { ProcessGraph, WorkflowDependency } from '@merv/contracts/workflow-guidance';

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
  failure: { reason: string; actorId: string; createdAt: string } | null;
  dependencies: WorkflowDependency[];
  dependents: WorkflowDependency[];
  createdAt: string;
}

/** The record and the gate it stands at arrive together, from the row that owns them. */
function TaskDetail({ row }: ViewProps) {
  const { id = '' } = useParams();
  const record = useTool<{ task: Task; process: ProcessGraph }>(
    'ui.read',
    { rowId: row.id, params: { id } },
    { every: 8000 },
  );
  const nameOf = useActorNames();
  const artifacts = useArtifacts();
  const t = record.data?.task;
  const review = useTool<Review>(t?.reviewId ? 'review.get' : null, {
    reviewId: t?.reviewId ?? '',
  });
  const process = record.data?.process;
  if (!t)
    return (
      <div className="page-stage">
        <LoadState {...record} back={{ to: WORK.path, label: 'Work' }} />
      </div>
    );
  return (
    <RecordPage
      back={<Link to={WORK.path}>← Work</Link>}
      kind={row.view.kind}
      name={t.title}
      standing={t.goal}
      state={<StatusPill value={t.workflow.state} />}
      act={process && <Gate graph={process} kind={row.view.kind} />}
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
          {(t.deliveryConfirmations?.length > 0 || t.deliveryIds.length > 0) && (
            <h3 className="ev-role">Deliveries</h3>
          )}
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
                  item.evidenceIds.map((id) => (
                    <div key={id}>
                      <Link to={`/artifacts/${id}`}>{artifacts.get(id)?.title}</Link>
                    </div>
                  )),
                ),
              ]}
            />
          )}
          {t.deliveryIds.map((artifactId) => (
            <ArtifactBody key={artifactId} artifactId={artifactId} />
          ))}
        </>
      }
      history={
        t.failure ? (
          <>
            <h3 className="ev-role">Why this task ended</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{t.failure.reason}</p>
            <p className="muted">
              {[nameOf(t.failure.actorId), stamp(t.failure.createdAt)].filter(Boolean).join(' · ')}
            </p>
          </>
        ) : undefined
      }
      related={
        t.dependencies?.length || t.dependents?.length || t.reviewId ? (
          <>
            <WorkRelations title="Waits on" items={t.dependencies ?? []} taskPath={row.path} />
            <WorkRelations title="Unblocks" items={t.dependents ?? []} taskPath={row.path} />
            {t.reviewId && !review.data && (
              <LoadState loading={review.loading} error={review.error} />
            )}
            {review.data && (
              <>
                <h3 className="ev-role">Review</h3>
                <CriterionRows review={review.data} head />
              </>
            )}
          </>
        ) : undefined
      }
      details={
        <KV
          rows={[
            ['Producer', nameOf(t.producerId)],
            ['Created', stamp(t.createdAt)],
            ['Updated', stamp(t.workflow.updatedAt)],
          ]}
        />
      }
    />
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
