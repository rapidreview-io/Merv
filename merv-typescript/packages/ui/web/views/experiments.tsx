import { useRef, useState, type ReactNode } from 'react';
import { Link, Route, Routes, useParams } from 'react-router-dom';
import type { Experiment, ExperimentEvidence, ExperimentExhibit } from '@merv/experiments/models';
import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { useTool } from '../api';
import { ListFilters } from '../list-filters';
import {
  Evidence,
  GateBox,
  KV,
  LoadState,
  ObjId,
  PageHeader,
  StatusPill,
  Table,
  cx,
  relativeTime,
  shortId,
  useArtifacts,
  words,
} from '../components';
import { firstSentence, newestReview, reviewClause } from '../states';
import { CriterionRows, type Review } from './reviews';
import { useActorNames } from './people';
import type { ViewProps } from './index';

/** The domain's own order. A role with nothing in it is a fact, so it keeps its line. */
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
      {bands.map(([role, rows]) => (
        <div key={role}>
          <span className="ev-role">{role}</span>
          {rows.length ? (
            rows.map((item) => (
              <Evidence
                key={item.id}
                artifactId={item.artifactId}
                artifact={artifacts.get(item.artifactId)}
                label={`${item.path} · retained ${relativeTime(item.createdAt)}${
                  item.systemGenerated ? ' · written by the system' : ''
                }`}
              />
            ))
          ) : (
            <p className="empty">no {role} attached</p>
          )}
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
 * Three facts under the title, each its own clause and none derived from another:
 * what the machinery did, what an independent reader decided, and what the science
 * came to. A passing verdict is not an outcome, and where the reviewed revision is
 * behind the record the line states the drift instead of letting the two read as one.
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
  return (
    <span className="standing">
      <span className="clause">
        <span className="clause-k">Execution</span>
        <StatusPill value={e.workflow.state} />
      </span>
      <span className="clause">
        <span className="clause-k">Review</span>
        {said?.word ? (
          <>
            {stage}{' '}
            <span className={cx('crit-word', said.verdict && `crit-word--${said.word}`)}>
              {words(said.word)}
            </span>
            {said.detail}
          </>
        ) : (
          'none requested yet'
        )}
      </span>
      <span className="clause">
        <span className="clause-k">Outcome</span>
        {firstSentence(e.conclusion) ?? 'no conclusion yet'}
      </span>
      {review && review.subjectRevision !== e.workflow.revision && (
        <span className="clause">
          Reviewed at revision {review.subjectRevision}; now revision {e.workflow.revision}
        </span>
      )}
    </span>
  );
}

/**
 * Submission, criticism, correction, re-review as one chain read top to bottom.
 * Nothing here marks an objection answered: an answer is a later round's finding on
 * a criterion of identical wording, and where the wording changed the line says the
 * check was not re-examined rather than inventing a closure the record never made.
 */
function RoundsSpine({
  experiment: e,
  reviews,
  nameOf,
}: {
  experiment: Experiment;
  reviews: Review[];
  nameOf(id: string | null | undefined): string | undefined;
}) {
  const rounds = e.submissions.map((submission, index) => ({
    submission,
    review: reviews.find((item) => item.id === submission.reviewId),
    index,
  }));
  const answerTo = (from: number, text: string) => {
    for (const later of rounds.slice(from + 1)) {
      const at = later.review?.criteria.indexOf(text) ?? -1;
      const found = later.review?.findings?.find((item) => item.criterionNumber === at + 1);
      if (at >= 0 && found)
        return `round ${later.submission.round}: ${words(found.status)} — ${found.notes}`;
    }
    return 'not re-examined under the same wording.';
  };
  // A recovery note is the only feedback with no review behind it; the rest is a
  // verdict already read on the round that produced it.
  const carried = e.attempt.feedback.filter(
    (note) => !rounds.some((round) => round.review?.notes === note),
  );
  return (
    <section className="stack" aria-label="Rounds of submission and review">
      <h2 className="section-title">Rounds</h2>
      {carried.map((note) => (
        <p className="muted" key={note}>
          Carried into attempt {e.attempt.index}: {note}
        </p>
      ))}
      {!rounds.length && <p className="empty">Nothing has been submitted for review yet.</p>}
      {[...rounds].reverse().map(({ submission: s, review, index }) => {
        const objections =
          review?.findings?.filter((item) => ['not_met', 'not_verified'].includes(item.status)) ??
          [];
        const next = rounds[index + 1]?.submission;
        return (
          <div className="round" key={s.id}>
            <p title={`Manifest ${s.manifestHash}`}>
              {STAGE[s.stage]}, attempt {s.attemptIndex}, round {s.round}, revision{' '}
              {s.subjectRevision} ·{' '}
              <span className={cx('crit-word', review?.verdict && `crit-word--${review.verdict}`)}>
                {words(review?.verdict ?? review?.status ?? 'review not readable')}
              </span>
              {review?.returnTo ? `returned to ${words(review.returnTo)}` : ''}
            </p>
            <p className="muted">
              Submitted by {nameOf(s.producerId) ?? shortId(s.producerId)}{' '}
              <span title={s.createdAt}>{relativeTime(s.createdAt)}</span> ·{' '}
              {review?.reviewerId
                ? `read by ${nameOf(review.reviewerId) ?? shortId(review.reviewerId)}`
                : 'no reviewer yet'}
              {e.attempt.feedbackReviewIds.includes(s.reviewId)
                ? ` · kept as context for attempt ${e.attempt.index}`
                : ''}
            </p>
            {review?.synopsis && <p className="record-prose">{review.synopsis}</p>}
            {review && !!objections.length && <CriterionRows review={review} compact />}
            {objections.map((item) => (
              <p className="muted" key={item.criterionNumber}>
                Criterion {item.criterionNumber} ·{' '}
                {answerTo(index, review?.criteria[item.criterionNumber - 1] ?? '')}
              </p>
            ))}
            {next && review?.verdict && review.verdict !== 'pass' && (
              <p className="muted">
                Corrected at revision {next.subjectRevision}, round {next.round}.
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function ExperimentRecord({
  experiment: e,
  guidance,
  reviews,
  exhibit,
  nameOf,
}: {
  experiment: Experiment;
  guidance?: WorkflowDecision;
  reviews?: Review[];
  exhibit?: ExperimentExhibit;
  nameOf(id: string | null | undefined): string | undefined;
}) {
  const mine = (reviews ?? []).filter((review) => review.subjectId === e.id);
  const newest = newestReview(mine, e.id);
  const stage = e.submissions.find((item) => item.reviewId === newest?.id)?.stage;
  const approved = e.submissions.find(
    (submission) => submission.id === e.attempt.approvedSubmissionId,
  );
  const currentEvidence = e.evidence.filter(
    (item) => item.current && item.attemptIndex === e.attempt.index,
  );
  const decision = guidance?.revision === e.workflow.revision ? guidance : undefined;
  const ended = ['failed', 'abandoned'].includes(e.workflow.state);
  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow={<Link to="/experiments">← Experiments</Link>}
        kind="experiments"
        title={e.name}
        summary={
          <StandingLine
            experiment={e}
            review={newest}
            stage={stage ? STAGE[stage] : 'Review'}
            reviewer={newest?.reviewerId ? nameOf(newest.reviewerId) : null}
          />
        }
      />
      <p className="question">{e.intent}</p>
      <section className="stack" aria-label="What the experiment came to">
        <h2 className="section-title">{ended ? 'Why this experiment ended' : 'Conclusion'}</h2>
        {e.conclusion ? (
          <p className="record-prose">{e.conclusion}</p>
        ) : (
          <p className="empty">No conclusion recorded yet.</p>
        )}
        {exhibit && exhibit.attemptIndex === e.attempt.index && (
          <figure className="stack">
            <pre className="doc doc--inline">{exhibit.content}</pre>
            <figcaption className="muted">
              {exhibit.path} ·{' '}
              {exhibit.willPin
                ? 'the result submission will retain this source-backed exhibit with its review round'
                : 'the current evidence is qualitative, so no quantitative exhibit will be pinned'}
              . This preview is not a review verdict.
            </figcaption>
          </figure>
        )}
      </section>
      {!!e.testedClaimIds.length && (
        <section className="stack">
          <h2 className="section-title">Claims tested</h2>
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
      <section className="stack" aria-label="Retained evidence">
        <h2 className="section-title">Evidence</h2>
        {approved ? (
          <p className="muted">
            Execution follows the sealed design from attempt {approved.attemptIndex}, read in{' '}
            <Link to={`/reviews/${approved.reviewId}`}>its own round</Link>.
          </p>
        ) : (
          <p className="muted">No plan has passed design review.</p>
        )}
        <EvidenceFiles evidence={currentEvidence} figures={e.submissions.at(-1)?.figureIds ?? []} />
      </section>
      <RoundsSpine experiment={e} reviews={mine} nameOf={nameOf} />
      {decision && !decision.terminal && (
        <section className="stack" aria-label="Experiment workflow guidance">
          <h2 className="section-title">What happens next</h2>
          <GateBox decision={decision} />
        </section>
      )}
      <section className="stack" aria-label="Experiment record details">
        <h2 className="section-title">Record</h2>
        {e.details && <p className="record-prose">{e.details}</p>}
        <KV
          rows={[
            ['Id', <ObjId id={e.id} strong />],
            ['Owner', nameOf(e.ownerId) ?? <ObjId id={e.ownerId} />],
            ['Revision', String(e.workflow.revision)],
            ['Created', new Date(e.createdAt).toLocaleString()],
            ...e.attempts.map((attempt): [string, ReactNode] => [
              `Attempt ${attempt.index}`,
              `revisions ${attempt.startedRevision}–${attempt.endedRevision ?? 'current'}, ` +
                (attempt.startedAt
                  ? `first execution ${new Date(attempt.startedAt).toLocaleString()}`
                  : 'not started'),
            ]),
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
  // Whether the record can still change arrives with the record itself, so the
  // first read polls and every read stops once a settled state has come back.
  const settled = useRef(false);
  const experiment = useTool<Experiment>(
    'experiment.get_state',
    { experimentId: id },
    { every: settled.current ? undefined : 8000 },
  );
  const state = experiment.data?.workflow.state;
  settled.current = !!state && ['complete', 'abandoned', 'failed'].includes(state);
  const live = settled.current ? undefined : 8000;
  const guidance = useTool<WorkflowDecision>(
    'workflow.status_and_next',
    { instanceId: id },
    { every: live },
  );
  const reviews = useTool<Review[]>('review.list', {}, { every: live });
  const exhibit = useTool<ExperimentExhibit>(
    state === 'running' ? 'experiment.exhibit' : null,
    { experimentId: id },
    { every: live },
  );
  const nameOf = useActorNames();
  return (
    <div className="page-stage stack stack--lg">
      <LoadState
        loading={experiment.loading}
        error={experiment.error ?? guidance.error ?? reviews.error ?? exhibit.error}
        back={experiment.data ? undefined : { to: row.path, label: row.label }}
      />
      {experiment.data && (
        <ExperimentRecord
          experiment={experiment.data}
          guidance={guidance.data}
          reviews={reviews.data}
          exhibit={exhibit.data}
          nameOf={nameOf}
        />
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
