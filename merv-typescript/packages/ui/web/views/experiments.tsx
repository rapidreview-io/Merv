import { useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Experiment, ExperimentEvidence, ExperimentExhibit } from '@merv/experiments/models';
import { EXPERIMENT_ROLES, roleRank } from '@merv/experiments/rules';
import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import { useTool } from '../api';
import { CodeBlock } from '../code-block';
import { recordRoutes } from '../list-filters';
import { homeOf, useStateWords } from '../navigation';
import {
  Evidence,
  KV,
  LoadState,
  RecordPage,
  relativeTime,
  timeRows,
  useArtifacts,
} from '../components';
import { Markdown, RecordText, useRecordNames } from '../markdown';
import { Gate, StageMark } from '../process';
import { useSession } from '../session';
import { signedInAdmin } from './code';
import { UnitCode } from './code-section';
import { ThreeStates, newestReview, reviewClause } from '../states';
import { Thread, threadOf } from '../thread';
import { type Review } from './reviews';
import { useActorNames } from './people';
import type { ViewProps } from './index';
import type { CodeUnit } from '@merv/code-work/models';

const STAGE = { design: 'Design review', results: 'Results review' };

/** Retained files grouped by the part they play, each opening where it is listed. */
export function EvidenceFiles({
  evidence,
  figures,
}: {
  evidence: ExperimentEvidence[];
  figures: string[];
}) {
  const artifacts = useArtifacts();
  // In the domain's own order; a role with nothing retained under it is left out.
  const bands: [string, ExperimentEvidence[]][] = EXPERIMENT_ROLES.map((role) => [
    role,
    evidence.filter((item) => item.role === role),
  ]);
  // A role the domain no longer writes is still on the record, so it keeps a band of its own, last.
  const retained = evidence.filter((item) => roleRank(item.role) === EXPERIMENT_ROLES.length);
  if (retained.length) bands.push(['other retained files', retained]);
  return (
    <div className="stack">
      {bands
        .filter(([, rows]) => rows.length)
        .map(([role, rows]) => (
          <div key={role}>
            <span className="ev-role">{role}</span>
            {rows.map((item) => (
              <Evidence
                key={item.id}
                artifactId={item.artifactId}
                artifact={artifacts.get(item.artifactId)}
                label={`${item.path} · retained ${relativeTime(item.createdAt)}${
                  item.systemGenerated ? ' · written by the system' : ''
                }`}
              />
            ))}
          </div>
        ))}
      {figures.length > 0 && (
        <div>
          <span className="ev-role">figures</span>
          {figures.map((id) => (
            <Evidence key={id} artifactId={id} artifact={artifacts.get(id)} meta />
          ))}
        </div>
      )}
    </div>
  );
}

function ExperimentRecord({
  experiment: e,
  process,
  reviews,
  exhibit,
  unit,
  nameOf,
  back,
}: {
  back: { to: string; label: string };
  experiment: Experiment;
  process?: ProcessGraph;
  reviews?: Review[];
  exhibit?: ExperimentExhibit;
  unit?: CodeUnit | null;
  nameOf(id: string | null | undefined): string | undefined;
}) {
  // The publication verbs answer a signed-in operator and nobody else, so the Code
  // section is told who is reading before it offers the move.
  const { actor, account } = useSession();
  const newest = newestReview(reviews, e.id);
  const stage = e.submissions.find((item) => item.reviewId === newest?.id)?.stage;
  // What the newest review decided, or where it stands until it has; a passing verdict
  // is not an outcome, so the conclusion is said apart from it, whole.
  const said = reviewClause(newest, newest?.reviewerId ? nameOf(newest.reviewerId) : null);
  const currentEvidence = e.evidence.filter(
    (item) => item.current && item.attemptIndex === e.attempt.index,
  );
  const figures = e.submissions.at(-1)?.figureIds ?? [];
  const shown = exhibit?.attemptIndex === e.attempt.index ? exhibit : undefined;
  const ended = ['failed', 'abandoned'].includes(e.workflow.state);
  const states = useStateWords();
  const thread = reviews
    ? threadOf({ graph: process, reviews, subject: e.id, nameOf, states })
    : [];
  const names = useRecordNames(e.intent);
  return (
    <RecordPage
      back={<Link to={back.to}>← {back.label}</Link>}
      kind="experiments"
      name={e.name}
      state={<StageMark graph={process} workflow={e.workflow} />}
      // The question it was opened to answer, as a task's goal stands under its title, and
      // what it came to directly under that, with the verdict that accepted it.
      standing={
        <>
          <span>
            <RecordText text={e.intent} names={names} />
          </span>
          {said && <ThreeStates review={said} meta={stage ? STAGE[stage] : 'Review'} />}
          {ended && e.conclusion && <span className="ev-role">Why this experiment ended</span>}
          {e.conclusion && <Markdown source={e.conclusion} />}
        </>
      }
      act={process && <Gate graph={process} />}
      title="Evidence"
      content={
        currentEvidence.length || figures.length || shown ? (
          <>
            <EvidenceFiles evidence={currentEvidence} figures={figures} />
            {shown && (
              <figure className="stack">
                {/\.(md|markdown)$/i.test(shown.path) ? (
                  <Markdown source={shown.content} />
                ) : (
                  <CodeBlock code={shown.content} lang={shown.path} label="Text" numbered />
                )}
                <figcaption className="muted">{shown.path}</figcaption>
              </figure>
            )}
          </>
        ) : undefined
      }
      history={thread.length ? <Thread entries={thread} /> : undefined}
      description={e.details ? <Markdown source={e.details} /> : undefined}
      code={
        unit && <UnitCode unit={unit} named={nameOf} signedIn={signedInAdmin(actor, account)} />
      }
      details={
        <KV rows={[['Owner', nameOf(e.ownerId)], ...timeRows(e.createdAt, e.workflow.updatedAt)]} />
      }
    />
  );
}

/** The record and the gate it stands at arrive together, from the row that owns them. */
function ExperimentDetail({ row, shell }: ViewProps) {
  const { id = '' } = useParams();
  // Whether the record can still change arrives with the record itself, so the
  // first read polls and every read stops once a settled state has come back.
  const settled = useRef(false);
  const record = useTool<{
    experiment: Experiment;
    process: ProcessGraph;
    codeUnit: CodeUnit | null;
  }>('ui.read', { rowId: row.id, params: { id } }, { every: settled.current ? undefined : 8000 });
  const state = record.data?.experiment.workflow.state;
  settled.current = !!record.data?.process.terminal;
  const live = settled.current ? undefined : 8000;
  const reviews = useTool<Review[]>('review.list', { subjectId: id }, { every: live });
  const exhibit = useTool<ExperimentExhibit>(
    state === 'running' ? 'experiment.exhibit' : null,
    { experimentId: id },
    { every: live },
  );
  const nameOf = useActorNames();
  if (!record.data)
    return (
      <div className="page-stage">
        <LoadState
          loading={record.loading}
          error={record.error ?? reviews.error ?? exhibit.error}
          back={homeOf(shell.rows)}
        />
      </div>
    );
  return (
    <ExperimentRecord
      back={homeOf(shell.rows)}
      experiment={record.data.experiment}
      process={record.data.process}
      // A list that could not be read leaves the thread to the graph alone.
      reviews={reviews.data ?? (reviews.error ? [] : undefined)}
      exhibit={exhibit.data}
      unit={record.data.codeUnit}
      nameOf={nameOf}
    />
  );
}

export const ExperimentsView = recordRoutes(ExperimentDetail);
