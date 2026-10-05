import { Link, useParams } from 'react-router-dom';
import type { CodeUnit } from '@merv/contracts/code-work-models';
import { useTool, type Loaded } from '../api';
import { recordRoutes } from '../list-filters';
import { homeOf } from '../navigation';
import { Evidence, KV, LoadState, RecordPage, Stamp, timeRows, useArtifacts } from '../components';
import { Gate, Relations, StageMark } from '../process';
import { useSession } from '../session';
import { Thread, threadOf } from '../thread';
import { signedInAdmin } from './code';
import { UnitCode } from './code-section';
import { useActorNames } from './people';
import { CriterionRows, type Confirmation, type Review } from './reviews';
import type { ViewProps } from './index';
import type { ProcessGraph, WorkflowDependency } from '@merv/contracts/workflow-guidance';

export interface Task {
  id: string;
  title: string;
  goal: string;
  checks: string[];
  deliveryConfirmations: Confirmation[];
  producerId: string;
  briefId: string;
  deliveryIds: string[];
  /** A delivery confirms each check by number; version 1 was retired with its tasks. */
  evidenceVersion?: 2;
  reviewId: string | null;
  workflow: { state: string; revision: number; updatedAt: string };
  failure: { reason: string; actorId: string; createdAt: string } | null;
  dependencies: WorkflowDependency[];
  dependents: WorkflowDependency[];
  createdAt: string;
}

/** How the server titles the brief it composes from a task's title, goal and checks. */
const COMPOSED = 'Task brief: ';
/**
 * The page's one section. A check is stated once, in its row, with everything said
 * about it: the producer's claim, the reviewer's finding, the files either cites. The
 * brief folds away under the rows. What was delivered, round by round, and what each
 * review said of it are the thread's, under History, so no file and no verdict is
 * said a second time. A brief somebody wrote is open until something has been delivered; the one
 * the server composes from the title, the goal and the checks says nothing the page
 * has not, and ends in instructions to the agent holding the tool, so it stays shut.
 */
export function TaskChecks({ task: t, reviews }: { task: Task; reviews: Loaded<Review[]> }) {
  const artifacts = useArtifacts();
  const review = reviews.data?.find((item) => item.id === t.reviewId);
  const brief = artifacts.get(t.briefId);
  const composed = !brief || brief.title.startsWith(COMPOSED);
  return (
    <div className="stack stack--lg">
      <div className="stack">
        {t.reviewId && !review && <LoadState loading={reviews.loading} error={reviews.error} />}
        <CriterionRows
          criteria={t.checks}
          confirmations={t.deliveryConfirmations}
          review={review}
        />
      </div>
      <div className="stack">
        <h3 className="ev-role">Files</h3>
        <Evidence
          // Whether it opens is decided once the list has named it, not before.
          key={brief ? 'named' : 'unnamed'}
          artifactId={t.briefId}
          artifact={brief}
          // The page's title is the composed brief's too, so the fold names its part instead.
          label={composed && brief ? 'Brief' : undefined}
          opened={!composed && !t.deliveryIds.length}
          meta
        />
      </div>
    </div>
  );
}

/** The record and the gate it stands at arrive together, from the row that owns them. */
function TaskDetail({ row, shell }: ViewProps) {
  const { id = '' } = useParams();
  const record = useTool<{ task: Task; process: ProcessGraph; codeUnit: CodeUnit | null }>(
    'ui.read',
    { rowId: row.id, params: { id } },
    { every: 8000 },
  );
  const nameOf = useActorNames();
  const back = homeOf(shell.rows);
  // The publication verbs answer a signed-in operator and nobody else, so the Code
  // section is told who is reading before it offers the move.
  const { actor, account } = useSession();
  const t = record.data?.task;
  // Every round of review this task has been through, the newest verdict and the earlier ones
  // in one answer; once the task has ended, none of them changes again.
  const ended = !!t && ['done', 'failed'].includes(t.workflow.state);
  const reviews = useTool<Review[]>(
    t?.reviewId ? 'review.list' : null,
    { subjectId: id },
    { every: ended ? undefined : 8000 },
  );
  const process = record.data?.process;
  if (!t)
    return (
      <div className="page-stage">
        <LoadState {...record} back={back} />
      </div>
    );
  // Deliveries, the reviews that answered them and the returns, once the reviews are read;
  // a list that could not be read leaves the thread to the graph alone.
  const rounds = t.reviewId ? (reviews.data ?? (reviews.error ? [] : undefined)) : [];
  const thread = rounds
    ? threadOf({ graph: process, reviews: rounds, subject: t.id, briefId: t.briefId, nameOf })
    : [];
  return (
    <RecordPage
      back={<Link to={back.to}>← {back.label}</Link>}
      kind={row.view.kind}
      name={t.title}
      standing={t.goal}
      state={<StageMark graph={process} workflow={t.workflow} />}
      act={process && <Gate graph={process} />}
      title="Checks"
      content={<TaskChecks task={t} reviews={reviews} />}
      history={
        thread.length || t.failure ? (
          <>
            {thread.length > 0 && <Thread entries={thread} />}
            {t.failure && (
              <>
                <h3 className="ev-role">Why this task ended</h3>
                <p className="record-prose">{t.failure.reason}</p>
                <p className="muted">
                  {nameOf(t.failure.actorId) && `${nameOf(t.failure.actorId)} · `}
                  <Stamp at={t.failure.createdAt} />
                </p>
              </>
            )}
          </>
        ) : undefined
      }
      code={
        record.data?.codeUnit && (
          <UnitCode
            unit={record.data.codeUnit}
            named={nameOf}
            signedIn={signedInAdmin(actor, account)}
          />
        )
      }
      related={
        t.dependencies?.length || t.dependents?.length ? (
          <>
            <Relations title="Waits on" items={t.dependencies ?? []} />
            <Relations title="Unblocks" items={t.dependents ?? []} />
          </>
        ) : undefined
      }
      details={
        <KV
          rows={[
            ['Producer', nameOf(t.producerId)],
            ...timeRows(t.createdAt, t.workflow.updatedAt),
          ]}
        />
      }
    />
  );
}

export const TasksView = recordRoutes(TaskDetail);
