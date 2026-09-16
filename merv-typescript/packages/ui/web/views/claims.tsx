import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Experiment } from '@merv/experiments/models';
import { useScopeVersion, useTool } from '../api';
import { useCommand } from '../mutations';
import { LoadState, ObjId, StatusPill, relativeTime, words } from '../components';
import { useSession } from '../session';
import type { Row } from '../shell-types';
import type { ViewProps } from './index';

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

function ConfidenceSelect({
  value,
  onChange,
}: {
  value: Claim['confidence'];
  onChange: (value: Claim['confidence']) => void;
}) {
  return (
    <label>
      Confidence
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as Claim['confidence'])}
      >
        {confidences.map((confidence) => (
          <option key={confidence} value={confidence}>
            {confidence}
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
      <h2 id={heading}>Create claim</h2>
      <fieldset disabled={mutation.locked}>
        <label>
          Statement
          <textarea
            className="textarea"
            required
            maxLength={16000}
            rows={3}
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
          />
        </label>
        <label>
          Scope (optional)
          <textarea
            className="textarea"
            maxLength={16000}
            rows={2}
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          />
        </label>
        <ConfidenceSelect value={confidence} onChange={setConfidence} />
      </fieldset>
      <p className="faint">
        New claims are active. The statement and scope stay fixed after creation.
      </p>
      {mutation.error && (
        <p className="error-message" role="alert">
          {mutation.error}
        </p>
      )}
      <div className="cluster">
        <button className="btn btn--primary" disabled={mutation.busy || !statement.trim()}>
          {mutation.busy ? 'Saving…' : mutation.retry ? 'Retry same request' : 'Create claim'}
        </button>
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
        <label>
          Status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as Claim['status'])}
          >
            {statuses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <ConfidenceSelect value={confidence} onChange={setConfidence} />
      </fieldset>
      <p className="faint">Editing revision {original.revision}.</p>
      {mutation.error && (
        <p className="error-message" role="alert">
          {mutation.error}
        </p>
      )}
      <div className="cluster">
        <button className="btn btn--primary" disabled={mutation.busy || !changed}>
          {mutation.busy ? 'Saving…' : mutation.retry ? 'Retry same request' : 'Save changes'}
        </button>
        <button type="button" className="btn" disabled={mutation.locked} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * One entry in the book: the statement, the standing a person set, and beneath it
 * the machine evidence. The two are printed side by side and never reconciled here.
 */
function ClaimEntry({
  claim,
  tests,
  changes,
  writable,
  reload,
}: {
  claim: Claim;
  tests: Testing[];
  changes: StandingChange[];
  writable: boolean;
  reload: () => void;
}) {
  const heading = useId();
  const [editing, setEditing] = useState(false);
  const [conflictRevision, setConflictRevision] = useState<number>();
  const needsRefresh = conflictRevision !== undefined && claim.revision <= conflictRevision;
  return (
    <article className="claim" aria-labelledby={heading}>
      <h2 className="claim-statement" id={heading}>
        {claim.statement}
      </h2>
      <p className="claim-standing">
        <StatusPill value={claim.status} /> · {claim.confidence} confidence
        {claim.scope && ` · ${claim.scope}`} <ObjId id={claim.id} />
      </p>
      {tests.map((test) => (
        <p className="claim-line" key={test.id}>
          <Link to={test.href}>{test.name}</Link> · {words(test.state)}
          {test.verdict && ` · verdict ${words(test.verdict)}`}
        </p>
      ))}
      {changes.map((change) => (
        <p className="claim-line claim-line--quiet" key={change.id}>
          {standing(change.data.before?.status, change.data.before?.confidence)} →{' '}
          {standing(change.data.status ?? claim.status, change.data.confidence ?? claim.confidence)}{' '}
          · <span title={change.createdAt}>{relativeTime(change.createdAt)}</span>
        </p>
      ))}
      {conflictRevision !== undefined && (
        <p className="error-message" role="alert">
          This claim changed while you were editing. Your changes were not applied. Read the
          standing again before starting a new edit.
        </p>
      )}
      {editing ? (
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
      ) : (
        writable && (
          <p className="claim-edit">
            <button
              type="button"
              className="btn-text"
              disabled={needsRefresh}
              onClick={() => {
                setEditing(true);
                setConflictRevision(undefined);
              }}
            >
              Edit standing
            </button>
            {needsRefresh && (
              <button type="button" className="btn-text" onClick={reload}>
                Load latest claim
              </button>
            )}
          </p>
        )
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
  const [creating, setCreating] = useState(false);
  const writable = actor.role === 'operator' || actor.role === 'producer';
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
  const changesOf = (claimId: string) =>
    (activity.data ?? [])
      .filter(
        (event) =>
          event.type === 'claim.updated' && event.subjectId === claimId && event.data?.before,
      )
      .reverse();
  return (
    <div className="page-stage stack stack--lg">
      {writable && (
        <div className="action-row">
          <button
            type="button"
            className="btn"
            aria-expanded={creating}
            onClick={() => setCreating((open) => !open)}
          >
            New claim
          </button>
        </div>
      )}
      {creating && (
        <CreateClaim
          onSaved={() => {
            setCreating(false);
            claims.reload();
          }}
        />
      )}
      <LoadState
        loading={claims.loading}
        error={claims.error}
        empty={claims.data?.length === 0}
        emptyTitle="No claims yet"
        emptyHint="A claim records a statement, where it applies and how confident you are; a producer writes one here. A completed experiment does not change its standing automatically: that stays a person's call."
      />
      {claims.data && claims.data.length > 0 && (
        <div className="claim-book">
          {claims.data.map((claim) => (
            <ClaimEntry
              key={claim.id}
              claim={claim}
              tests={testsOf(claim.id)}
              changes={changesOf(claim.id)}
              writable={writable}
              reload={claims.reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ClaimsView({ shell }: ViewProps) {
  const epoch = useScopeVersion();
  const { actor, project } = useSession();
  return <ClaimsPage key={`${epoch}:${project.id}:${actor.id}:${actor.role}`} rows={shell.rows} />;
}
