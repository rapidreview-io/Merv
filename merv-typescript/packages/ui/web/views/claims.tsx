import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Experiment } from '@merv/experiments/models';
import { useTool } from '../api';
import { useCommand } from '../mutations';
import { Ago, Area, Failure, LoadState, StatusPill, Submit, Summary, words } from '../components';
import { EditIcon } from '../icons';
import { ListPage, useListFilter } from '../list-filters';
import { RecordText, useRecordNames, type RecordNames } from '../markdown';
import { useScopeKey, useSession } from '../session';
import type { Row } from '../shell-types';
import type { ViewProps } from './index';

/**
 * What `project.references` answers about one reference: what it names, and
 * whether this project holds it.
 */
interface Reference {
  ref: string;
  status: 'resolved' | 'missing' | 'unsupported' | 'unpublished';
  label?: string;
  state?: string;
}

/**
 * The one thing the retired Knowledge page did that nothing else does: read the
 * metadata behind references an agent quoted. It is a lookup, not a collection,
 * so it is a quiet control beside the claims rather than a place of its own. What
 * it reads is what an agent wrote, pasted as it was written — nobody picks these by
 * name, because whether the name exists is the question — so the field says that
 * in the one place a field may: its own placeholder.
 */
function ReferenceLookup() {
  const heading = useId();
  const [text, setText] = useState('');
  const [refs, setRefs] = useState<string[] | null>(null);
  const [error, setError] = useState<string>();
  const lookup = useTool<Reference[]>(refs ? 'project.references' : null, { refs: refs ?? [] });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = text.split(/\s+/).filter(Boolean);
    if (!next.length || next.length > 200) {
      setError('Paste between 1 and 200 references.');
      return;
    }
    setError(undefined);
    setRefs(next);
    lookup.reload();
  };
  return (
    <section className="stack">
      <form className="card stack claims-form" aria-labelledby={heading} onSubmit={submit}>
        <h2 id={heading}>Check references</h2>
        <Area
          label="References"
          className="mono"
          rows={3}
          maxLength={40200}
          placeholder="Paste what an agent cited, one reference to a line"
          value={text}
          onChange={setText}
        />
        <Failure message={error} />
        <div>
          <button className="btn" disabled={lookup.loading || !text.trim()}>
            Check
          </button>
        </div>
      </form>
      <LoadState {...lookup} />
      {lookup.data && !lookup.error && (
        <ul className="rows">
          {lookup.data.map((item, index) => (
            <li className="row" key={`${index}:${item.ref}`}>
              <span className="row-name">
                {/* A reference nobody could name is shortened, never printed as its id. */}
                <strong>{item.label ?? <RecordText text={item.ref} />}</strong>
                <StatusPill value={item.status} />
              </span>
              <span className="states-detail">{item.state ? words(item.state) : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const statuses = ['draft', 'active', 'supported', 'weakened', 'contradicted', 'abandoned'] as const;
const confidences = ['low', 'medium', 'high'] as const;
interface Claim {
  id: string;
  projectId: string;
  statement: string;
  scope: string;
  status: (typeof statuses)[number];
  confidence: (typeof confidences)[number];
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}
/** A review is joined to its subject alone: review.claimId is a reviewer's lease, not a claim. */
interface SubjectReview {
  subjectId: string;
  subjectRevision: number;
  verdict: 'pass' | 'needs_changes' | 'fail' | null;
  createdAt: string;
}
/** The only standing history the server keeps is the before block on a claim.updated event. */
interface StandingChange {
  id: number;
  type: string;
  subjectId: string;
  data: {
    before?: { status?: string; confidence?: string } | null;
    status?: string;
    confidence?: string;
  };
  createdAt: string;
}
/** One experiment that names this claim, reduced to the sentence the book prints. */
interface Testing {
  id: string;
  name: string;
  state: string;
  verdict: string | null;
  href: string;
}

const stopped = new Set(['complete', 'abandoned', 'failed']);
const standing = (status?: string, confidence?: string) =>
  [status && words(status), confidence].filter(Boolean).join(', ');

function useClaimMutation(
  tool: 'claim.create' | 'claim.update',
  onSuccess: () => void,
  onConflict?: () => void,
) {
  return useCommand<Claim>({
    tool,
    validate: (value) =>
      !!value && typeof value.id === 'string' && Number.isInteger(value.revision),
    onSuccess,
    conflictCode: 'claim_revision_conflict',
    onConflict,
  });
}

/** A closed vocabulary is chosen the same way wherever the book offers it. */
function Choose<T extends string>({
  label,
  values,
  value,
  onChange,
}: {
  label: string;
  values: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {values.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function CreateClaim({ onSaved }: { onSaved: () => void }) {
  const heading = useId();
  const [statement, setStatement] = useState('');
  const [scope, setScope] = useState('');
  const [confidence, setConfidence] = useState<Claim['confidence']>('medium');
  const mutation = useClaimMutation('claim.create', () => {
    setStatement('');
    setScope('');
    setConfidence('medium');
    onSaved();
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void mutation.submit({ statement: statement.trim(), scope: scope.trim(), confidence });
  };
  return (
    <form className="card stack claims-form" aria-labelledby={heading} onSubmit={submit}>
      <h2 id={heading}>New claim</h2>
      <fieldset disabled={mutation.locked}>
        <Area
          label="Statement"
          required
          maxLength={16000}
          rows={3}
          value={statement}
          onChange={setStatement}
        />
        <Area
          label="Scope (optional)"
          maxLength={16000}
          rows={2}
          value={scope}
          onChange={setScope}
        />
        <Choose
          label="Confidence"
          values={confidences}
          value={confidence}
          onChange={setConfidence}
        />
      </fieldset>
      <Failure message={mutation.error} />
      <div className="cluster">
        <Submit busy={mutation.busy} retry={mutation.retry} disabled={!statement.trim()} />
      </div>
    </form>
  );
}

function EditClaim({
  claim,
  onSaved,
  onCancel,
  onConflict,
}: {
  claim: Claim;
  onSaved: () => void;
  onCancel: () => void;
  onConflict: (revision: number) => void;
}) {
  // Capture the revision when editing starts; a list refresh never rebases a pending command.
  const [original] = useState(claim);
  const [status, setStatus] = useState(claim.status);
  const [confidence, setConfidence] = useState(claim.confidence);
  const mutation = useClaimMutation('claim.update', onSaved, () => onConflict(original.revision));
  const changed = status !== original.status || confidence !== original.confidence;
  return (
    <form
      className="stack claims-form"
      aria-label="Edit claim status and confidence"
      onSubmit={(event) => {
        event.preventDefault();
        void mutation.submit({
          claimId: original.id,
          expectedRevision: original.revision,
          status,
          confidence,
        });
      }}
    >
      <fieldset disabled={mutation.locked}>
        <Choose label="Status" values={statuses} value={status} onChange={setStatus} />
        <Choose
          label="Confidence"
          values={confidences}
          value={confidence}
          onChange={setConfidence}
        />
      </fieldset>
      <Failure message={mutation.error} />
      <div className="cluster">
        <Submit label="Save" busy={mutation.busy} retry={mutation.retry} disabled={!changed} />
        <button type="button" className="btn" disabled={mutation.locked} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * One entry in the book: the statement, the standing a person set, and how many
 * experiments test it. Its scope, its evidence and its history open with the claim,
 * so the book reads as claims rather than as a wall of everything about them.
 */
function ClaimEntry({
  claim,
  tests,
  changes,
  names,
  writable,
  reload,
}: {
  claim: Claim;
  tests: Testing[];
  changes: StandingChange[];
  /** The records a statement or a scope may mention by id, named once for the book. */
  names: RecordNames;
  writable: boolean;
  reload: () => void;
}) {
  const heading = useId();
  const [editing, setEditing] = useState(false);
  const [conflictRevision, setConflictRevision] = useState<number>();
  const needsRefresh = conflictRevision !== undefined && claim.revision <= conflictRevision;
  return (
    <article className="record claim" aria-labelledby={heading}>
      <details>
        {/* The book holds claims and nothing else, so no entry says again that it is one. */}
        <Summary className="claim-line">
          <h2 className="claim-statement" id={heading}>
            <RecordText text={claim.statement} names={names} />
          </h2>
          {/* The standing closes the line, so the pills read down the book as one column. */}
          {tests.length > 0 && (
            <span className="faint claim-tests">
              {tests.length} {tests.length === 1 ? 'experiment' : 'experiments'}
            </span>
          )}
          <StatusPill value={claim.status} />
        </Summary>
        <p className="claim-standing">
          {claim.confidence} confidence
          {claim.scope && (
            <>
              {' · '}
              <RecordText text={claim.scope} names={names} />
            </>
          )}
          {/* The one quiet action a card carries, at the end of its standing and nowhere else. */}
          {writable && !editing && (
            <button
              type="button"
              className="btn-icon btn-icon--inline claim-edit"
              aria-label="Edit standing"
              title="Edit standing"
              disabled={needsRefresh}
              onClick={() => {
                setEditing(true);
                setConflictRevision(undefined);
              }}
            >
              <EditIcon />
            </button>
          )}
          {writable && needsRefresh && (
            <button type="button" className="btn-text claim-edit" onClick={reload}>
              Load latest claim
            </button>
          )}
        </p>
        {tests.map((test) => (
          <p className="claim-line" key={test.id}>
            <Link to={test.href}>{test.name}</Link> · {words(test.state)}
            {test.verdict && ` · ${words(test.verdict)}`}
          </p>
        ))}
        {changes.map((change) => (
          <p className="claim-line claim-line--quiet" key={change.id}>
            {standing(change.data.before?.status, change.data.before?.confidence)} →{' '}
            {standing(
              change.data.status ?? claim.status,
              change.data.confidence ?? claim.confidence,
            )}{' '}
            · <Ago at={change.createdAt} />
          </p>
        ))}
        {conflictRevision !== undefined && (
          <p className="error-message" role="alert">
            This claim changed while you were editing. Your changes were not applied.
          </p>
        )}
      </details>
      {editing && (
        <EditClaim
          claim={claim}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setConflictRevision(undefined);
            reload();
          }}
          onConflict={(revision) => {
            setEditing(false);
            setConflictRevision(revision);
            reload();
          }}
        />
      )}
    </article>
  );
}

function ClaimsPage({ rows }: { rows: Row[] }) {
  const { actor } = useSession();
  // Evidence is read once for the page and only while the row that owns it is registered;
  // where a row is missing the sentence it would carry is absent, never a zero.
  const experiments = rows.find((row) => row.view.kind === 'experiments');
  const claims = useTool<Claim[]>('claim.list', {}, { every: 10000 });
  const tested = useTool<Experiment[]>(experiments ? 'experiment.list' : null);
  const reviews = useTool<SubjectReview[]>(
    rows.some((row) => row.view.kind === 'reviews') ? 'review.list' : null,
  );
  const activity = useTool<StandingChange[]>(
    rows.some((row) => row.view.kind === 'feed') ? 'feed.activity' : null,
  );
  const writable = actor.role === 'operator' || actor.role === 'producer';
  const filter = useListFilter(claims.data, {
    stateOf: (claim) => claim.status,
    mine: (claim) => claim.createdBy === actor.id,
    labels: (claim) => [claim.statement, claim.scope],
    ids: (claim) => [claim.id],
  });
  const verdictOf = (experimentId: string) =>
    (reviews.data ?? [])
      .filter((review) => review.subjectId === experimentId && review.verdict)
      .sort(
        (a, b) => b.subjectRevision - a.subjectRevision || b.createdAt.localeCompare(a.createdAt),
      )[0]?.verdict ?? null;
  const testsOf = (claimId: string): Testing[] => {
    const path = experiments?.path;
    if (!path) return [];
    return (
      (tested.data ?? [])
        .filter((experiment) => experiment.testedClaimIds.includes(claimId))
        .map((experiment) => ({
          id: experiment.id,
          name: experiment.name,
          state: experiment.workflow.state,
          verdict: verdictOf(experiment.id),
          href: `${path}/${experiment.id}`,
        }))
        // Work still in motion is read before work that has stopped.
        .sort((a, b) => Number(stopped.has(a.state)) - Number(stopped.has(b.state)))
    );
  };
  // An id an author wrote into a statement reads as the record's name, as it does in a note.
  const names = useRecordNames(
    (claims.data ?? []).map((claim) => `${claim.statement}\n${claim.scope}`).join('\n'),
  );
  const changesOf = (claimId: string) =>
    (activity.data ?? [])
      .filter(
        (event) =>
          event.type === 'claim.updated' && event.subjectId === claimId && event.data?.before,
      )
      .reverse();
  return (
    <ListPage
      load={claims}
      noun="claims"
      kind="claims"
      placeholder="Statement or scope"
      filter={filter}
      emptyTitle="No claims yet"
      create={{
        label: 'New claim',
        shown: writable,
        form: (close) => (
          <CreateClaim
            onSaved={() => {
              close();
              claims.reload();
            }}
          />
        ),
      }}
      // Not an action: it reads metadata for references someone already wrote.
      aside={{ label: 'Check references', plain: true, form: () => <ReferenceLookup /> }}
      // The book is a designed surface: its rows stay the cards it was drawn as.
      cards={{
        className: 'claim-book',
        render: (claim) => (
          <ClaimEntry
            key={claim.id}
            claim={claim}
            tests={testsOf(claim.id)}
            changes={changesOf(claim.id)}
            names={names}
            writable={writable}
            reload={() => {
              claims.reload();
              // The card's history is drawn from activity; an edit adds to it.
              activity.reload();
            }}
          />
        ),
      }}
    />
  );
}

export const ClaimsView = ({ shell }: ViewProps) => (
  <ClaimsPage key={useScopeKey()} rows={shell.rows} />
);
