import { Link, Route, Routes, useParams } from 'react-router-dom';
import { useState } from 'react';
import { useTool, type Loaded } from '../api';
import { useCommand } from '../mutations';
import { ListFilters } from '../list-filters';
import {
  LoadState,
  ObjId,
  PageHeader,
  StatusPill,
  Table,
  cx,
  relativeTime,
  shortId,
  words,
} from '../components';
import { useActorNames } from './people';
import { ArtifactBody, bytes, type Artifact } from './artifacts';
import type { ViewProps } from './index';
import type { WorkflowActionStatus, WorkflowDecision } from '@merv/contracts/workflow-guidance';

/** review.submit enumerates exactly these finding words and these verdicts. */
const FINDINGS = ['met', 'not_met', 'not_verified', 'waived'] as const;
const VERDICTS = ['pass', 'needs_changes', 'fail'] as const;
type Finding = (typeof FINDINGS)[number];
type Verdict = (typeof VERDICTS)[number];

export interface Review {
  id: string;
  subjectId: string;
  subjectRevision: number;
  producerId: string;
  artifactIds: string[];
  criteria: string[];
  formatVersion: 1 | 2;
  status: 'requested' | 'started' | 'submitted' | 'superseded';
  reviewerId: string | null;
  claimId: string | null;
  verdict: Verdict | null;
  returnTo?: string;
  notes: string | null;
  synopsis: string | null;
  findings: {
    criterionNumber: number;
    status: Finding;
    evidenceIds: string[];
    notes: string;
  }[];
  createdAt: string;
}
/** The producer's own confirmation of the acceptance check with the same number. */
interface Confirmation {
  checkNumber: number;
  status: 'met' | 'not_met';
  notes: string;
}
interface Draft {
  status?: Finding;
  notes: string;
  evidenceIds: string[];
}
const BLANK: Draft = { notes: '', evidenceIds: [] };

/** One list serves every pinned title, so a record does not fetch each file to name it. */
const useArtifacts = () => {
  const list = useTool<Artifact[]>('artifact.list');
  return new Map((list.data ?? []).map((item) => [item.id, item]));
};

/** A pinned file read where it is cited: the title opens the body without leaving the record. */
function Evidence({
  artifactId,
  artifact,
  meta,
}: {
  artifactId: string;
  artifact?: Artifact;
  meta?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="crit-file" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {artifact?.title ?? <ObjId id={artifactId} />}
        {meta && artifact && (
          <span className="faint">
            {' '}
            · {artifact.mediaType} · {bytes(artifact.size)}
          </span>
        )}
      </summary>
      {open && <ArtifactBody artifactId={artifactId} metadata={artifact} />}
    </details>
  );
}

/**
 * A criterion reads as one sentence: the check, the producer's confirmation of the
 * same number, the reviewer's finding, and the evidence it cites, readable in place.
 * The same rows carry the reviewer's draft while a verdict is still being written.
 */
export function CriterionRows({
  review,
  confirmations,
  head,
  draft,
}: {
  review: Review;
  confirmations?: Confirmation[];
  head?: boolean;
  draft?: { values: Record<number, Draft>; set(number: number, value: Draft): void };
}) {
  const artifacts = useArtifacts();
  return (
    <div className="stack">
      {head && (
        <div className="cluster">
          <StatusPill value={review.status} />
          {review.verdict && <StatusPill value={review.verdict} />}
          <Link to={`/reviews/${review.id}`}>Open the review</Link>
        </div>
      )}
      {head && review.synopsis && <p className="verdict-said">{review.synopsis}</p>}
      <ol className="crits">
        {review.criteria.map((text, index) => {
          const number = index + 1;
          const finding = review.findings?.find((item) => item.criterionNumber === number);
          const said = confirmations?.find((item) => item.checkNumber === number);
          const value = draft?.values[number] ?? BLANK;
          return (
            <li className="crit" key={number}>
              <span className="crit-n tabular">{number}</span>
              <div className="stack">
                <p className="crit-text">{text}</p>
                {said && (
                  <p className="crit-said">
                    Producer: {said.status === 'met' ? '' : 'not met — '}
                    {said.notes}
                  </p>
                )}
                {finding && (
                  <p className="crit-found">
                    <span className={cx('crit-word', `crit-word--${finding.status}`)}>
                      {words(finding.status)}
                    </span>
                    {finding.notes}
                  </p>
                )}
                {finding?.evidenceIds.map((id) => (
                  <Evidence key={id} artifactId={id} artifact={artifacts.get(id)} />
                ))}
                {draft && (
                  <>
                    <div className="cluster">
                      {FINDINGS.map((status) => (
                        <button
                          key={status}
                          type="button"
                          aria-pressed={value.status === status}
                          className={cx(
                            'crit-word',
                            'crit-pick',
                            value.status === status && `crit-word--${status}`,
                          )}
                          onClick={() => draft.set(number, { ...value, status })}
                        >
                          {words(status)}
                        </button>
                      ))}
                    </div>
                    {/* The rest of the sentence opens once its finding word is chosen. */}
                    {value.status && (
                      <>
                        <textarea
                          className="textarea"
                          rows={2}
                          aria-label={`Notes on criterion ${number}`}
                          placeholder="What you verified, what must change, or why this check is unnecessary"
                          value={value.notes}
                          onChange={(event) =>
                            draft.set(number, { ...value, notes: event.target.value })
                          }
                        />
                        <div className="crit-cites">
                          {review.artifactIds.map((id) => (
                            <label key={id} className="crit-cite">
                              <input
                                type="checkbox"
                                checked={value.evidenceIds.includes(id)}
                                onChange={(event) =>
                                  draft.set(number, {
                                    ...value,
                                    evidenceIds: event.target.checked
                                      ? [...value.evidenceIds, id]
                                      : value.evidenceIds.filter((other) => other !== id),
                                  })
                                }
                              />
                              {artifacts.get(id)?.title ?? shortId(id)}
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ReviewList() {
  const list = useTool<Review[]>('review.list', {}, { every: 10000 });
  const nameOf = useActorNames();
  const [query, setQuery] = useState('');
  const [state, setState] = useState('');
  const search = query.trim().toLowerCase();
  const states = [
    ...new Set([...(list.data ?? []).map((item) => item.status), ...(state ? [state] : [])]),
  ].sort();
  const visible = (list.data ?? []).filter(
    (item) =>
      (!state || item.status === state) &&
      (!search ||
        [
          item.id,
          item.subjectId,
          item.synopsis,
          ...item.criteria,
          item.producerId,
          nameOf(item.producerId),
          item.reviewerId,
          nameOf(item.reviewerId),
        ].some((value) => value?.toLowerCase().includes(search))),
  );
  return (
    <div className="page-stage stack">
      {list.data && list.data.length > 0 && !list.error && (
        <ListFilters
          noun="reviews"
          placeholder="Summary, work item or person"
          query={query}
          onQueryChange={setQuery}
          state={state}
          onStateChange={setState}
          states={states}
          stateLabel="Status"
          shown={visible.length}
          total={list.data.length}
        />
      )}
      <LoadState
        loading={list.loading}
        error={list.error}
        empty={list.data?.length === 0}
        emptyTitle="No reviews"
        emptyHint="A review appears here when work is submitted for assessment; someone other than its producer takes it."
      />
      {list.data &&
        list.data.length > 0 &&
        !list.error &&
        !list.loading &&
        visible.length === 0 && (
          <LoadState
            loading={false}
            empty
            emptyTitle="No reviews match these filters"
            emptyHint="Try another search or clear the filters."
          />
        )}
      {visible.length > 0 && !list.error && (
        <Table
          rows={[...visible].reverse()}
          keyOf={(r) => r.id}
          onRow={(r) => r.id}
          columns={[
            {
              key: 'id',
              label: 'Review',
              render: (r) => {
                const summary = r.synopsis || r.criteria[0] || 'Independent review';
                return (
                  <div>
                    <strong title={summary}>
                      {summary.length > 120 ? `${summary.slice(0, 117)}…` : summary}
                    </strong>
                    <div className="faint">
                      <ObjId id={r.id} />
                    </div>
                  </div>
                );
              },
            },
            { key: 'status', label: 'Status', render: (r) => <StatusPill value={r.status} /> },
            {
              key: 'verdict',
              label: 'Verdict',
              render: (r) =>
                r.verdict ? (
                  <div className="cluster">
                    <StatusPill value={r.verdict} />
                    {r.returnTo && <span className="muted">Return to {r.returnTo}</span>}
                    {r.findings?.some((item) => item.status === 'waived') && (
                      <span className="muted">
                        {r.findings.filter((item) => item.status === 'waived').length} waived
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="faint">—</span>
                ),
            },
            {
              key: 'subject',
              label: 'Work item',
              render: (r) => <ObjId id={r.subjectId} />,
            },
            {
              key: 'reviewer',
              label: 'Reviewer',
              render: (r) =>
                r.reviewerId ? (
                  (nameOf(r.reviewerId) ?? <ObjId id={r.reviewerId} />)
                ) : (
                  <span className="faint">unclaimed</span>
                ),
            },
            {
              key: 'when',
              label: 'When',
              render: (r) => <span title={r.createdAt}>{relativeTime(r.createdAt)}</span>,
              width: '90px',
            },
          ]}
        />
      )}
    </div>
  );
}

interface SubjectExperiment {
  id: string;
  name: string;
  workflow: { state: string };
}
interface SubjectTask {
  id: string;
  title: string;
  deliveryConfirmations: Confirmation[];
}

/** The record read straight down: what was asked, what was found, what was decided. */
function ReviewDetail({ row }: ViewProps) {
  const { id = '' } = useParams();
  const review = useTool<Review>('review.get', { reviewId: id }, { every: 8000 });
  const nameOf = useActorNames();
  const artifacts = useArtifacts();
  const experiments = useTool<SubjectExperiment[]>('experiment.list');
  const tasks = useTool<SubjectTask[]>('task.list');
  const [values, setValues] = useState<Record<number, Draft>>({});
  const subjectId = review.data?.subjectId;
  const experiment = experiments.data?.find((item) => item.id === subjectId);
  const task = tasks.data?.find((item) => item.id === subjectId);
  const confirmations = useTool<SubjectTask>(task ? 'task.get' : null, { taskId: subjectId ?? '' });
  const stages = useTool<{ submissions: { stage: string; reviewId: string | null }[] }>(
    experiment ? 'experiment.get_state' : null,
    { experimentId: subjectId ?? '' },
  );
  const guidance = useTool<WorkflowDecision>(
    review.data && !review.data.verdict ? 'workflow.status_and_next' : null,
    { instanceId: subjectId ?? '' },
    { every: 8000 },
  );
  if (!review.data)
    return (
      <div className="page-stage">
        <LoadState
          loading={review.loading}
          error={review.error}
          back={{ to: row.path, label: row.label }}
        />
      </div>
    );
  const r = review.data;
  // The submission this review pins names its own stage, so a record keeps its name
  // after the subject has moved on; the current gate answers until that list arrives.
  const stage =
    stages.data?.submissions.find((item) => item.reviewId === r.id)?.stage ??
    { design_review: 'design', experiment_review: 'results' }[experiment?.workflow.state ?? ''];
  const kind =
    stage === 'design' ? 'Design review' : stage === 'results' ? 'Results review' : 'Review';
  const submit = guidance.data?.actions.find((action) => action.tool === 'review.submit');
  const cited = new Set(r.findings?.flatMap((finding) => finding.evidenceIds) ?? []);
  const rest = r.artifactIds.filter((artifactId) => !cited.has(artifactId));
  return (
    <div className="page-stage stack stack--lg">
      <PageHeader
        eyebrow={<Link to={row.path}>← {row.label}</Link>}
        title={
          <>
            {kind} · {experiment?.name ?? task?.title ?? <ObjId id={r.subjectId} strong />}
          </>
        }
        actions={<StatusPill value={r.status} />}
        summary={
          <>
            Requested <span title={r.createdAt}>{relativeTime(r.createdAt)}</span> ·{' '}
            {r.reviewerId ? (
              <>claimed by {nameOf(r.reviewerId) ?? <ObjId id={r.reviewerId} />}</>
            ) : (
              'unclaimed'
            )}{' '}
            · revision {r.subjectRevision}
          </>
        }
      />
      <CriterionRows
        review={r}
        confirmations={confirmations.data?.deliveryConfirmations}
        draft={
          submit && submit.status !== 'blocked'
            ? {
                values,
                set: (number, value) => setValues((old) => ({ ...old, [number]: value })),
              }
            : undefined
        }
      />
      {rest.length > 0 && (
        <section className="stack">
          <h2 className="section-title">Pinned evidence</h2>
          {rest.map((artifactId) => (
            <Evidence
              key={artifactId}
              artifactId={artifactId}
              artifact={artifacts.get(artifactId)}
              meta
            />
          ))}
        </section>
      )}
      <section className="stack">
        <h2 className="section-title">Verdict</h2>
        {r.verdict ? (
          <>
            <p className="verdict-said">{r.synopsis ?? r.notes}</p>
            <p className="muted">
              {r.returnTo ? `Returned to ${words(r.returnTo)}` : `Recorded as ${words(r.verdict)}`}{' '}
              · by {nameOf(r.reviewerId) ?? <ObjId id={r.reviewerId ?? r.id} />}
            </p>
          </>
        ) : (
          <Controls review={r} guidance={guidance} values={values} onDone={review.reload} />
        )}
      </section>
    </div>
  );
}

/** The one primary control, with its consequence, its blocker or its error beneath. */
function Act({
  label,
  help,
  error,
  code,
  disabled,
  onClick,
}: {
  label: string;
  help: string;
  error?: string;
  code?: string;
  disabled?: boolean;
  onClick?(): void;
}) {
  return (
    <div className="stack">
      <div>
        <button className="btn btn--accent" disabled={disabled} onClick={onClick}>
          {label}
        </button>
      </div>
      <p className="verdict-help">{help}</p>
      {error && (
        <p className="error-message" role="alert">
          {error} {code && <span className="mono faint">({code})</span>}
        </p>
      )}
    </div>
  );
}

/**
 * What a reader may do is the server's answer, never the browser's: the subject's
 * workflow.status_and_next names review.start and review.submit with the readiness
 * and blockers it evaluated for this caller (packages/workflows/src/evaluation.ts).
 */
function Controls({
  review,
  guidance,
  values,
  onDone,
}: {
  review: Review;
  guidance: Loaded<WorkflowDecision>;
  values: Record<number, Draft>;
  onDone(): void;
}) {
  const claim = useCommand<Review>({
    tool: 'review.start',
    idempotent: true,
    validate: (value) => !!value && value.id === review.id && value.status === 'started',
    onSuccess: () => {
      onDone();
      guidance.reload();
    },
  });
  if (!guidance.data) return <LoadState loading={guidance.loading} error={guidance.error} />;
  const start = guidance.data.actions.find((action) => action.tool === 'review.start');
  const submit = guidance.data.actions.find((action) => action.tool === 'review.submit');
  // A claimed review answers `needs_input`: the verdict this desk exists to supply.
  if (submit && submit.status !== 'blocked')
    return (
      <Desk
        review={review}
        action={submit}
        state={guidance.data.state}
        values={values}
        onDone={onDone}
      />
    );
  if (start?.status === 'ready')
    return (
      <Act
        label={
          claim.retry ? 'Retry the same claim' : claim.busy ? 'Claiming…' : 'Claim this review'
        }
        help="You become its reviewer; only you can submit the verdict."
        error={claim.error}
        code={claim.code}
        disabled={claim.busy}
        onClick={() => void claim.submit({ reviewId: review.id })}
      />
    );
  return (
    <Act
      label="Submit verdict"
      help={(submit ?? start)?.blockers[0]?.message ?? guidance.data.instruction}
      disabled
    />
  );
}

/**
 * Return routes are the one part of a verdict no schema enumerates: review.submit
 * accepts any identifier and the owning domain decides. These are the destinations
 * each gate documents in packages/experiments/src/program.ts; a task review takes
 * none at all, so its choice never appears.
 */
const ROUTES: Record<string, { value: string; label: string }[]> = {
  design_review: [{ value: 'planned', label: 'Planning, for a new design' }],
  experiment_review: [
    { value: 'planned', label: 'Planning, for a new design and attempt' },
    { value: 'running', label: 'Running, to repair under the approved plan' },
  ],
};

/** The verdict desk. Every rule below is review.submit's own, checked before it is sent. */
function Desk({
  review,
  action,
  state,
  values,
  onDone,
}: {
  review: Review;
  action: WorkflowActionStatus;
  state: string;
  values: Record<number, Draft>;
  onDone(): void;
}) {
  const routes = ROUTES[state] ?? [];
  const [synopsis, setSynopsis] = useState('');
  const [verdict, setVerdict] = useState<Verdict>();
  const [returnTo, setReturnTo] = useState(routes.length === 1 ? routes[0].value : '');
  const command = useCommand<{ id: string }>({
    tool: 'review.submit',
    validate: (value) => !!value && typeof value.id === 'string',
    onSuccess: onDone,
  });
  const drafts = review.criteria.map((_, index) => values[index + 1] ?? BLANK);
  const said = synopsis.trim();
  const bare = drafts.findIndex((draft) => !draft.status || !draft.notes.trim());
  const uncited = drafts.findIndex((draft) => draft.status === 'met' && !draft.evidenceIds.length);
  const unmet =
    bare >= 0
      ? `Criterion ${bare + 1} still needs a finding and notes.`
      : uncited >= 0
        ? `Criterion ${uncited + 1} is met, so it must cite at least one pinned file.`
        : said.length < 40
          ? `The synopsis needs ${40 - said.length} more characters.`
          : said.length > 420
            ? `The synopsis is ${said.length - 420} characters too long.`
            : !verdict
              ? 'Choose a verdict.'
              : verdict === 'pass' &&
                  drafts.some((draft) => draft.status !== 'met' && draft.status !== 'waived')
                ? 'A passing verdict needs every criterion met or waived.'
                : verdict !== 'pass' && routes.length > 0 && !returnTo
                  ? 'Choose where the work returns.'
                  : undefined;
  return (
    <div className="stack">
      <textarea
        className="textarea"
        rows={3}
        aria-label="Synopsis"
        placeholder="One plain paragraph saying what you found and why this verdict follows."
        value={synopsis}
        onChange={(event) => setSynopsis(event.target.value)}
      />
      <p className="verdict-count tabular">{said.length} characters · 40 to 420</p>
      <div className="cluster">
        {VERDICTS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={verdict === value}
            className={cx('crit-word', 'crit-pick', verdict === value && `crit-word--${value}`)}
            onClick={() => setVerdict(value)}
          >
            {words(value)}
          </button>
        ))}
      </div>
      {verdict && verdict !== 'pass' && routes.length > 0 && (
        <div className="cluster">
          <span className="verdict-count">Returns to</span>
          {routes.map((route) => (
            <button
              key={route.value}
              type="button"
              aria-pressed={returnTo === route.value}
              className={cx('btn', returnTo === route.value && 'btn--on')}
              onClick={() => setReturnTo(route.value)}
            >
              {route.label}
            </button>
          ))}
        </div>
      )}
      <Act
        label={
          command.retry ? 'Retry the same verdict' : command.busy ? 'Submitting…' : 'Submit verdict'
        }
        help={unmet ?? 'The verdict is recorded once, with your findings, and cannot be changed.'}
        error={command.error}
        code={command.code}
        disabled={!!unmet || command.busy}
        onClick={() =>
          void command.submit({
            reviewId: review.id,
            claimId: action.arguments.claimId ?? review.claimId,
            verdict,
            ...(verdict !== 'pass' && returnTo ? { returnTo } : {}),
            // review.submit also requires overall notes. The synopsis is that
            // statement, so a reviewer is never asked to write it twice.
            notes: said,
            synopsis: said,
            findings: drafts.map((draft, index) => ({
              criterionNumber: index + 1,
              status: draft.status,
              evidenceIds: draft.evidenceIds,
              notes: draft.notes.trim(),
            })),
            expectedRevision: review.subjectRevision,
          })
        }
      />
    </div>
  );
}

export function ReviewsView(props: ViewProps) {
  return (
    <Routes>
      <Route index element={<ReviewList />} />
      <Route path=":id" element={<ReviewDetail {...props} />} />
    </Routes>
  );
}
