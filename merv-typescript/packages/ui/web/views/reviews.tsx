import { Link, useParams } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import { useTool, type Loaded } from '../api';
import { useCommand } from '../mutations';
import { splitRoutes } from '../list-filters';
import { WORK } from '../navigation';
import {
  Ago,
  Evidence,
  LoadState,
  RecordPage,
  StatusPill,
  cx,
  useArtifacts,
  words,
} from '../components';
import { useActorNames } from './people';
import { WorkList } from './work';
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

/**
 * A criterion reads as one sentence: the check, the producer's confirmation of the
 * same number, the reviewer's finding, and the evidence it cites, readable in place.
 * The same rows carry the reviewer's draft while a verdict is still being written.
 * In compact mode only the criteria that objected are drawn, so a record read
 * elsewhere shows the objections rather than the roll call.
 */
export function CriterionRows({
  review,
  confirmations,
  head,
  compact,
  draft,
}: {
  review: Review;
  confirmations?: Confirmation[];
  head?: boolean;
  compact?: boolean;
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
          if (compact && finding?.status !== 'not_met' && finding?.status !== 'not_verified')
            return null;
          return (
            // The desk's unmet rule navigates here, so every criterion is a
            // destination that can hold focus.
            <li className="crit" key={number} id={`crit-${number}`} tabIndex={-1}>
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
                          placeholder="Notes"
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
                              {artifacts.get(id)?.title}
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

interface SubjectExperiment {
  id: string;
  name: string;
  workflow: { state: string; revision: number };
  conclusion: string | null;
}
interface SubjectTask {
  id: string;
  title: string;
  workflow: { state: string; revision: number };
  failure: { reason: string } | null;
  deliveryConfirmations: Confirmation[];
}

/** The record read straight down: what was asked, what was found, what was decided. */
function ReviewDetail() {
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
  const stages = useTool<{
    attempt: { index: number; approvedSubmissionId: string | null };
    submissions: { id: string; stage: string; attemptIndex: number; reviewId: string | null }[];
  }>(experiment ? 'experiment.get_state' : null, { experimentId: subjectId ?? '' });
  const guidance = useTool<WorkflowDecision>(
    review.data && !review.data.verdict ? 'workflow.status_and_next' : null,
    { instanceId: subjectId ?? '' },
    { every: 8000 },
  );
  if (!review.data)
    return (
      <div className="page-stage">
        <LoadState {...review} back={{ to: WORK.path, label: 'Work' }} />
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
  // The findings are the record's once a verdict exists, and this desk's draft
  // until then, so the exceptions are stated while their cost is being paid.
  const approved = stages.data?.submissions.find(
    (item) => item.id === stages.data?.attempt.approvedSubmissionId,
  );
  const exceptions = exceptionsOf({
    review: r,
    findings: r.verdict
      ? r.findings.map((finding) => ({
          number: finding.criterionNumber,
          status: finding.status as string,
        }))
      : Object.entries(values).map(([number, draft]) => ({
          number: Number(number),
          status: draft.status ?? '',
        })),
    revision: experiment?.workflow.revision ?? task?.workflow.revision,
    attempt:
      approved && stages.data && approved.attemptIndex < stages.data.attempt.index
        ? { approvedIn: approved.attemptIndex, index: stages.data.attempt.index }
        : undefined,
  });
  // Exceptions are stated where their cost is being paid: beside the control while
  // a verdict is still being written, beside the verdict once it is recorded.
  const stated = exceptions.length > 0 && (
    <ul className="exceptions">
      {exceptions.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
  return (
    <RecordPage
      back={<Link to={WORK.path}>← Work</Link>}
      kind="reviews"
      name={[kind, experiment?.name ?? task?.title].filter(Boolean).join(' · ')}
      state={<StatusPill value={r.status} />}
      standing={
        <>
          Requested <Ago at={r.createdAt} /> ·{' '}
          {!r.reviewerId
            ? 'unclaimed'
            : nameOf(r.reviewerId)
              ? `claimed by ${nameOf(r.reviewerId)}`
              : 'claimed'}{' '}
          · revision {r.subjectRevision}
        </>
      }
      act={
        r.verdict ? undefined : (
          <>
            {stated}
            <Controls review={r} guidance={guidance} values={values} onDone={review.reload} />
          </>
        )
      }
      title="Criteria"
      content={
        <>
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
            <>
              <h3 className="ev-role">Pinned evidence</h3>
              {rest.map((artifactId) => (
                <Evidence
                  key={artifactId}
                  artifactId={artifactId}
                  artifact={artifacts.get(artifactId)}
                  meta
                />
              ))}
            </>
          )}
          {r.verdict && (
            <>
              <h3 className="ev-role">Verdict</h3>
              <p className="verdict-said">{r.synopsis ?? r.notes}</p>
              <p className="muted">
                {[
                  r.returnTo
                    ? `Returned to ${words(r.returnTo)}`
                    : `Recorded as ${words(r.verdict)}`,
                  nameOf(r.reviewerId) && `by ${nameOf(r.reviewerId)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {stated}
            </>
          )}
        </>
      }
    />
  );
}

/**
 * An exception is stated, never absorbed. Every sentence is derived from data
 * already on the page and none of them is coloured: a reviewer waiving a check
 * that does not apply is doing the right thing, not raising an alarm.
 */
function exceptionsOf({
  review,
  findings,
  revision,
  attempt,
}: {
  review: Review;
  findings: { number: number; status: string }[];
  revision?: number;
  attempt?: { approvedIn: number; index: number };
}): string[] {
  const lines: string[] = [];
  for (const [status, word] of [
    ['waived', 'waived'],
    ['not_verified', 'not verified'],
  ]) {
    const at = findings
      .filter((item) => item.status === status)
      .map((item) => item.number)
      .sort((left, right) => left - right);
    if (at.length === 1) lines.push(`Criterion ${at[0]} was ${word}.`);
    else if (at.length > 1)
      lines.push(`Criteria ${at.slice(0, -1).join(', ')} and ${at.at(-1)} were ${word}.`);
  }
  if (revision !== undefined && revision !== review.subjectRevision)
    lines.push(
      `This review pins revision ${review.subjectRevision}; the work is now at revision ${revision}.`,
    );
  if (review.status === 'superseded') lines.push('This review was superseded.');
  if (attempt)
    lines.push(
      `The plan under review was approved in attempt ${attempt.approvedIn}; the work is now on attempt ${attempt.index}.`,
    );
  return lines;
}

/** The one primary control, with its consequence, its blocker or its error beneath. */
function Primary({
  label,
  help,
  error,
  code,
  disabled,
  onClick,
}: {
  label: string;
  help?: ReactNode;
  error?: string;
  code?: string;
  disabled?: boolean;
  onClick?(): void;
}) {
  return (
    <div className="stack">
      <div>
        <button className="btn btn--primary" disabled={disabled} onClick={onClick}>
          {label}
        </button>
      </div>
      {help && <p className="verdict-help">{help}</p>}
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
      <Primary
        label={claim.retry ? 'Retry same request' : claim.busy ? 'Claiming…' : 'Claim review'}
        error={claim.error}
        code={claim.code}
        disabled={claim.busy}
        onClick={() => void claim.submit({ reviewId: review.id })}
      />
    );
  return (
    <Primary
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
  const objection = drafts.findIndex(
    (draft) => draft.status !== 'met' && draft.status !== 'waived',
  );
  // The rule still unmet, and the criterion it is about: the sentence under the
  // control is the way there, so nobody counts list items to find number 3.
  const unmet: { text: string; at?: number } | undefined =
    bare >= 0
      ? { text: `Criterion ${bare + 1} still needs a finding and notes.`, at: bare + 1 }
      : uncited >= 0
        ? {
            text: `Criterion ${uncited + 1} is met, so it must cite at least one pinned file.`,
            at: uncited + 1,
          }
        : said.length < 40
          ? { text: `The synopsis needs ${40 - said.length} more characters.` }
          : said.length > 420
            ? { text: `The synopsis is ${said.length - 420} characters too long.` }
            : !verdict
              ? { text: 'Choose a verdict.' }
              : verdict === 'pass' && objection >= 0
                ? {
                    text: 'A passing verdict needs every criterion met or waived.',
                    at: objection + 1,
                  }
                : verdict !== 'pass' && routes.length > 0 && !returnTo
                  ? { text: 'Choose where the work returns.' }
                  : undefined;
  return (
    <div className="stack">
      <textarea
        className="textarea"
        rows={3}
        aria-label="Synopsis"
        placeholder="Synopsis"
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
      <Primary
        label={
          command.retry ? 'Retry same request' : command.busy ? 'Submitting…' : 'Submit verdict'
        }
        help={unmet && <Unmet {...unmet} />}
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

/**
 * The blocker is the navigation: the sentence goes to the criterion it is about
 * and leaves the cursor there. Movement relocates focus and writes nothing.
 */
function Unmet({ text, at }: { text: string; at?: number }) {
  if (!at) return <>{text}</>;
  return (
    <a
      className="verdict-jump"
      href={`#crit-${at}`}
      onClick={(event) => {
        event.preventDefault();
        const criterion = document.getElementById(`crit-${at}`);
        criterion?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        criterion?.focus({ preventScroll: true });
      }}
    >
      {text}
    </a>
  );
}

export const ReviewsView = splitRoutes(WorkList, ReviewDetail, WORK.path);
