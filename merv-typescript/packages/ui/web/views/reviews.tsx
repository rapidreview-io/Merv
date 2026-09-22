import { Link, useParams } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import { refreshTools, useTool, type Loaded } from '../api';
import { useCommand } from '../mutations';
import { splitRoutes } from '../list-filters';
import { WORK } from '../navigation';
import {
  Ago,
  Area,
  Evidence,
  LoadState,
  RecordPage,
  StatusPill,
  cx,
  useArtifacts,
  words,
} from '../components';
import { ArrowRightIcon } from '../icons';
import { RecordLink, RecordText, useRecordNames } from '../markdown';
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
  claimable?: boolean;
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
export interface Confirmation {
  checkNumber: number;
  status: 'met' | 'not_met';
  notes: string;
  evidenceIds?: string[];
}
/** What a desk has said about one check so far: its word, the sentence, the files it cites. */
export interface Draft {
  status?: string;
  notes: string;
  evidenceIds: string[];
}
export const BLANK: Draft = { notes: '', evidenceIds: [] };
/**
 * Whether a desk holds anything it has not sent. A desk that does marks itself with
 * `data-draft`, and the split pane's Escape then stays on the record: a verdict or a
 * delivery half written lives only in this page's state, one keypress from the list.
 */
export const drafted = (values: Record<number, Draft>) =>
  Object.values(values).some(
    (draft) => !!draft.status || !!draft.notes.trim() || draft.evidenceIds.length > 0,
  );
/**
 * A desk writing on the rows: the words it may choose between, the files it may
 * cite, and what it has written. The reviewer's desk and the producer's are the
 * same rows with different words.
 */
export interface Drafting {
  words: readonly string[];
  files: string[];
  values: Record<number, Draft>;
  set(number: number, value: Draft): void;
  /** True while the desk's command is in flight or kept for a retry: what was sent stays what is shown. */
  locked?: boolean;
}

/** A finding word as the pill every state on these pages is: a dot and the word, in its colour. */
export const FindingPill = ({ value }: { value: string }) => (
  <span className={cx('crit-word', 'crit-pill', `crit-word--${value}`)}>{words(value)}</span>
);

/**
 * The review's one line on the record it judged: the word it came back with — or
 * where it stands until it has one — its sentence, and the way to the verdict page.
 */
export function ReviewSummary({
  review,
}: {
  review: {
    id: string;
    status: string;
    verdict: string | null;
    synopsis: string | null;
    notes?: string | null;
  };
}) {
  const said = review.synopsis ?? review.notes;
  return (
    <div className="stack">
      <div className="cluster">
        <StatusPill value={review.verdict ?? review.status} />
        <Link className="cluster hit" to={`/reviews/${review.id}`}>
          Open the review <ArrowRightIcon size={14} />
        </Link>
      </div>
      {said && <p className="verdict-said">{said}</p>}
    </div>
  );
}

/**
 * A criterion is one box, read down: the check, what the producer claimed for the
 * check of the same number, what the reviewer found, and every file either of them
 * cited, readable in place. A row holds only what has happened yet: before a
 * delivery it is the check alone, after one the claim and its evidence fill in, and
 * after the review the finding does. The same rows carry a desk's draft while a
 * delivery or a verdict is still being written.
 */
export function CriterionRows({
  criteria,
  confirmations,
  review,
  draft,
}: {
  criteria: string[];
  confirmations?: Confirmation[];
  /** The review whose findings the rows state, once there is one. */
  review?: Review;
  draft?: Drafting;
}) {
  const artifacts = useArtifacts();
  const findings = review?.findings ?? [];
  // A note may point at a record; it says its name, and reads for names only if it does.
  const names = useRecordNames(
    [...(confirmations ?? []), ...findings].map((item) => item.notes).join('\n'),
  );
  return (
    <ol className="crits">
      {criteria.map((text, index) => {
        const number = index + 1;
        const finding = findings.find((item) => item.criterionNumber === number);
        const said = confirmations?.find((item) => item.checkNumber === number);
        const value = draft?.values[number] ?? BLANK;
        const cited = [...new Set([...(said?.evidenceIds ?? []), ...(finding?.evidenceIds ?? [])])];
        return (
          // The desk's unmet rule navigates here, so every criterion is a
          // destination that can hold focus.
          <li className="crit" key={number} id={`crit-${number}`} tabIndex={-1}>
            <span className="crit-n tabular">{number}</span>
            <div className="stack">
              <p className="crit-text">{text}</p>
              {(said || finding) && (
                <dl className="crit-says">
                  {said && (
                    <div>
                      <dt>Producer</dt>
                      <dd>
                        <FindingPill value={said.status} />
                        <span>
                          <RecordText text={said.notes} names={names} />
                        </span>
                      </dd>
                    </div>
                  )}
                  {finding && (
                    <div>
                      <dt>Reviewer</dt>
                      <dd>
                        <FindingPill value={finding.status} />
                        <span>
                          <RecordText text={finding.notes} names={names} />
                        </span>
                      </dd>
                    </div>
                  )}
                </dl>
              )}
              {cited.map((id) => (
                <Evidence key={id} artifactId={id} artifact={artifacts.get(id)} />
              ))}
              {draft && (
                <fieldset className="stack crit-draft" disabled={draft.locked}>
                  <div className="cluster">
                    {draft.words.map((status) => (
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
                        aria-label={`Notes on check ${number}`}
                        placeholder="Notes"
                        value={value.notes}
                        onChange={(event) =>
                          draft.set(number, { ...value, notes: event.target.value })
                        }
                      />
                      <div className="crit-cites">
                        {draft.files.map((id) => (
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
                            {/* The list is capped at the newest files; an older pinned one is
                                still citable, by the short form every unnamed record takes. */}
                            {artifacts.get(id)?.title ?? <RecordLink id={id} plain />}
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </fieldset>
              )}
            </div>
          </li>
        );
      })}
    </ol>
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
  reviewId: string | null;
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
        <LoadState {...review} back={{ to: WORK.path, label: 'Work' }} />
      </div>
    );
  const r = review.data;
  // The submission this review pins names its own stage, so a record keeps its name
  // after the subject has moved on; the current gate answers until that list arrives.
  const stage =
    stages.data?.submissions.find((item) => item.reviewId === r.id)?.stage ??
    { design_review: 'design', experiment_review: 'results' }[experiment?.workflow.state ?? ''];
  // The kind label over the title already says Review; only the gate it reads adds to that.
  const gate = stage === 'design' ? 'Design' : stage === 'results' ? 'Results' : undefined;
  const submit = guidance.data?.actions.find((action) => action.tool === 'review.submit');
  // A task carries the claims of its newest delivery only, so they stand beside the
  // review of that delivery and beside no earlier one.
  const claims = task?.reviewId === r.id ? task.deliveryConfirmations : undefined;
  // A file a criterion already opens in place is not listed a second time under them.
  const cited = new Set(
    [...(r.findings ?? []), ...(claims ?? [])].flatMap((item) => item.evidenceIds ?? []),
  );
  const rest = r.artifactIds.filter((artifactId) => !cited.has(artifactId));
  // The findings are the record's once a verdict exists, and this desk's draft
  // until then, so the exceptions are stated while their cost is being paid.
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
  const subject = experiment
    ? { name: experiment.name, to: `/experiments/${experiment.id}` }
    : task && { name: task.title, to: `/tasks/${task.id}` };
  const reviewer = nameOf(r.reviewerId);
  return (
    <RecordPage
      back={<Link to={WORK.path}>← Work</Link>}
      kind="reviews"
      // A review is named by what it judged, and the name is the way back to it.
      name={subject ? <Link to={subject.to}>{subject.name}</Link> : 'Review'}
      // Once it is in, the verdict is how the review stands; until then its own state is.
      state={<StatusPill value={r.status === 'submitted' && r.verdict ? r.verdict : r.status} />}
      standing={
        <>
          {gate && `${gate} · `}
          Requested <Ago at={r.createdAt} /> ·{' '}
          {!r.reviewerId
            ? 'unclaimed'
            : reviewer
              ? `${r.verdict ? 'reviewed' : 'claimed'} by ${reviewer}`
              : r.verdict
                ? 'reviewed'
                : 'claimed'}
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
      title="Checks"
      content={
        <div className="stack stack--lg">
          <CriterionRows
            criteria={r.criteria}
            review={r}
            confirmations={claims}
            draft={
              submit && submit.status !== 'blocked'
                ? {
                    words: FINDINGS,
                    files: r.artifactIds,
                    values,
                    set: (number, value) => setValues((old) => ({ ...old, [number]: value })),
                  }
                : undefined
            }
          />
          {rest.length > 0 && (
            <div className="stack">
              <h3 className="ev-role">Pinned evidence</h3>
              {rest.map((artifactId) => (
                <Evidence
                  key={artifactId}
                  artifactId={artifactId}
                  artifact={artifacts.get(artifactId)}
                  meta
                />
              ))}
            </div>
          )}
          {/* The word and who gave it stand in the header; here is what they said. */}
          {r.verdict && (
            <div className="stack">
              <h3 className="ev-role">Verdict</h3>
              <p className="verdict-said">{r.synopsis ?? r.notes}</p>
              {r.returnTo && <p className="muted">Returned to {words(r.returnTo)}</p>}
              {stated}
            </div>
          )}
        </div>
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
}: {
  review: Review;
  findings: { number: number; status: string }[];
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
    if (at.length === 1) lines.push(`Check ${at[0]} was ${word}.`);
    else if (at.length > 1)
      lines.push(`Checks ${at.slice(0, -1).join(', ')} and ${at.at(-1)} were ${word}.`);
  }
  if (review.status === 'superseded') lines.push('This review was superseded.');
  return lines;
}

/** The one primary control, with its consequence, its blocker or its error beneath. */
export function Primary({
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
      refreshTools('review.list', 'task.list', 'experiment.list');
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

/** The longest synopsis review.submit takes. */
const SYNOPSIS_MAX = 420;

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
    onSuccess: () => {
      onDone();
      refreshTools('review.list', 'task.list', 'experiment.list');
    },
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
      ? { text: `Check ${bare + 1} still needs a finding and notes.`, at: bare + 1 }
      : uncited >= 0
        ? {
            text: `Check ${uncited + 1} is met, so it must cite at least one pinned file.`,
            at: uncited + 1,
          }
        : said.length < 40
          ? { text: `The synopsis needs ${40 - said.length} more characters.` }
          : said.length > SYNOPSIS_MAX
            ? { text: `The synopsis is ${said.length - SYNOPSIS_MAX} characters too long.` }
            : /[\r\n\u2028\u2029`]/u.test(synopsis) || said.startsWith('#')
              ? {
                  text: 'The synopsis is one plain paragraph: no line breaks, backticks or headings.',
                }
              : /\b(?:wf|art|review|actor|project|context|exp|task|claim|res|rver|syn|rev|lit|paper)_[A-Za-z0-9]/u.test(
                    synopsis,
                  )
                ? { text: 'The synopsis names things in words, not by their identifiers.' }
                : !verdict
                  ? { text: 'Choose a verdict.' }
                  : verdict === 'pass' && objection >= 0
                    ? {
                        text: 'A passing verdict needs every check met or waived.',
                        at: objection + 1,
                      }
                    : verdict !== 'pass' && routes.length > 0 && !returnTo
                      ? { text: 'Choose where the work returns.' }
                      : undefined;
  return (
    // One form's width and one field anatomy with the producer's desk, which stands in
    // this same slot on the task's page: the field keeps its name once something is typed.
    <div
      className="stack creation entry-form"
      data-draft={
        !!synopsis.trim() || !!verdict || drafted(values) || command.locked ? '' : undefined
      }
    >
      <Area label="Synopsis" rows={3} value={synopsis} onChange={setSynopsis} />
      {/* A limit is said as it nears, not before: the rule under the control says the rest. */}
      {said.length > SYNOPSIS_MAX - 60 && (
        <p className="verdict-count tabular">
          {said.length} / {SYNOPSIS_MAX}
        </p>
      )}
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
export function Unmet({ text, at }: { text: string; at?: number }) {
  if (!at) return <>{text}</>;
  return (
    <a
      className="verdict-jump hit"
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
