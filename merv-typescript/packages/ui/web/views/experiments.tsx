import { useRef, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Experiment, ExperimentEvidence, ExperimentExhibit } from '@merv/experiments/models';
import type { CodeUnit } from '@merv/contracts/code-units';
import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import { useTool } from '../api';
import { splitRoutes } from '../list-filters';
import { WORK } from '../navigation';
import {
  Ago,
  Evidence,
  KV,
  LoadState,
  RecordPage,
  StatusPill,
  cx,
  relativeTime,
  timeRows,
  useArtifacts,
  words,
} from '../components';
import { Markdown, RecordText, useRecordNames } from '../markdown';
import { Gate } from '../process';
import { UnitCode } from './code-section';
import { ThreeStates, firstSentence, newestReview, reviewClause } from '../states';
import { type Review } from './reviews';
import { useActorNames } from './people';
import { WorkList } from './work';
import type { ViewProps } from './index';

/** The domain's own order; a role with nothing retained under it is left out. */
const ROLES = ['plan', 'result', 'report', 'exhibit'] as const;
const STAGE = { design: 'Design review', results: 'Results review' };

/** Retained files grouped by the part they play, each opening where it is listed. */
function EvidenceFiles({
  evidence,
  figures,
}: {
  evidence: ExperimentEvidence[];
  figures: string[];
}) {
  const artifacts = useArtifacts();
  const bands: [string, ExperimentEvidence[]][] = ROLES.map((role) => [
    role,
    evidence.filter((item) => item.role === role),
  ]);
  // A role the domain no longer writes is still on the record, so it keeps a band of its own.
  const retained = evidence.filter((item) => !ROLES.some((role) => role === item.role));
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

/**
 * What a row of the wave states beside its state, in the same grammar: what an
 * independent reader decided and what the science came to. Neither is derived from
 * the other — a passing verdict is not an outcome — and a fact the record does not
 * carry yet is left out rather than named as missing. The state itself stands
 * beside the title, where every record's does, so it is not said again here.
 */
function StandingLine({
  experiment: e,
  review,
  stage,
  reviewer,
}: {
  experiment: Experiment;
  review?: Review;
  stage: string;
  reviewer: ReactNode;
}) {
  const said = reviewClause(review, reviewer);
  const outcome = firstSentence(e.conclusion);
  if (!said && !outcome) return null;
  return (
    <ThreeStates
      review={said ?? undefined}
      outcome={outcome ? { detail: outcome } : undefined}
      meta={said ? stage : undefined}
    />
  );
}

/**
 * Every round the record sealed, newest first: the gate it was read at, the word
 * it came back with, and when. The round is the way to its own verdict, where the
 * criteria and the reviewer's findings are already written down.
 */
function Rounds({ experiment: e, reviews }: { experiment: Experiment; reviews: Review[] }) {
  if (!e.submissions.length) return null;
  return (
    <>
      <h3 className="ev-role">Rounds</h3>
      {[...e.submissions].reverse().map((s) => {
        const review = reviews.find((item) => item.id === s.reviewId);
        const word = review?.verdict ?? review?.status;
        return (
          <p key={s.id}>
            <Link to={`/reviews/${s.reviewId}`}>{STAGE[s.stage]}</Link>{' '}
            {word && (
              <span className={cx('crit-word', review?.verdict && `crit-word--${word}`)}>
                {words(word)}
              </span>
            )}
            <Ago at={s.createdAt} className="muted" />
          </p>
        );
      })}
    </>
  );
}

function ExperimentRecord({
  experiment: e,
  process,
  reviews,
  exhibit,
  unit,
  nameOf,
}: {
  experiment: Experiment;
  process?: ProcessGraph;
  reviews?: Review[];
  exhibit?: ExperimentExhibit;
  unit?: CodeUnit | null;
  nameOf(id: string | null | undefined): string | undefined;
}) {
  // One list names every claim this experiment says it tests.
  const mine = (reviews ?? []).filter((review) => review.subjectId === e.id);
  const newest = newestReview(mine, e.id);
  const stage = e.submissions.find((item) => item.reviewId === newest?.id)?.stage;
  const currentEvidence = e.evidence.filter(
    (item) => item.current && item.attemptIndex === e.attempt.index,
  );
  const figures = e.submissions.at(-1)?.figureIds ?? [];
  const shown = exhibit?.attemptIndex === e.attempt.index ? exhibit : undefined;
  const ended = ['failed', 'abandoned'].includes(e.workflow.state);
  // The header already says a conclusion of one sentence; History holds one that says more.
  const concluded = !!e.conclusion && e.conclusion.trim() !== firstSentence(e.conclusion);
  const names = useRecordNames(e.intent);
  return (
    <RecordPage
      back={<Link to={WORK.path}>← Work</Link>}
      kind="experiments"
      name={e.name}
      state={<StatusPill value={e.workflow.state} />}
      // The question it was opened to answer, as a task's goal stands under its title.
      standing={
        <>
          <span>
            <RecordText text={e.intent} names={names} />
          </span>
          <StandingLine
            experiment={e}
            review={newest}
            stage={stage ? STAGE[stage] : 'Review'}
            reviewer={newest?.reviewerId ? nameOf(newest.reviewerId) : null}
          />
        </>
      }
      act={process && <Gate graph={process} kind="experiments" />}
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
                  <pre className="doc doc--inline">{shown.content}</pre>
                )}
                <figcaption className="muted">{shown.path}</figcaption>
              </figure>
            )}
          </>
        ) : undefined
      }
      history={
        concluded || e.submissions.length ? (
          <>
            {concluded && (
              <>
                <h3 className="ev-role">{ended ? 'Why this experiment ended' : 'Conclusion'}</h3>
                <Markdown source={e.conclusion!} />
              </>
            )}
            <Rounds experiment={e} reviews={mine} />
          </>
        ) : undefined
      }
      description={e.details ? <Markdown source={e.details} /> : undefined}
      code={unit && <UnitCode unit={unit} named={nameOf} />}
      details={
        <KV rows={[['Owner', nameOf(e.ownerId)], ...timeRows(e.createdAt, e.workflow.updatedAt)]} />
      }
    />
  );
}

/** The record and the gate it stands at arrive together, from the row that owns them. */
function ExperimentDetail({ row }: ViewProps) {
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
  settled.current = !!state && ['complete', 'abandoned', 'failed'].includes(state);
  const live = settled.current ? undefined : 8000;
  const reviews = useTool<Review[]>('review.list', {}, { every: live });
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
          back={{ to: WORK.path, label: 'Work' }}
        />
      </div>
    );
  return (
    <ExperimentRecord
      experiment={record.data.experiment}
      process={record.data.process}
      reviews={reviews.data}
      exhibit={exhibit.data}
      unit={record.data.codeUnit}
      nameOf={nameOf}
    />
  );
}

export const ExperimentsView = splitRoutes(WorkList, ExperimentDetail, WORK.path);
