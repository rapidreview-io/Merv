import { useId, useState, type FormEvent } from 'react';
import { useScopeVersion, useTool } from '../api';
import { useCommand } from '../mutations';
import { LoadState, ObjId, StatusPill, relativeTime } from '../components';
import { useSession } from '../session';

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

function ClaimCard({
  claim,
  writable,
  reload,
}: {
  claim: Claim;
  writable: boolean;
  reload: () => void;
}) {
  const heading = useId();
  const [editing, setEditing] = useState(false);
  const [conflictRevision, setConflictRevision] = useState<number>();
  const needsRefresh = conflictRevision !== undefined && claim.revision <= conflictRevision;
  return (
    <article className="record stack" aria-labelledby={heading}>
      <div className="cluster">
        <h2 id={heading}>
          <ObjId id={claim.id} />
        </h2>
        <StatusPill value={claim.status} />
        <span className="muted">{claim.confidence} confidence</span>
      </div>
      <p className="claims-text">{claim.statement}</p>
      {claim.scope && (
        <div>
          <h3 className="label">Scope</h3>
          <p className="claims-text">{claim.scope}</p>
        </div>
      )}
      <p className="faint">
        Revision {claim.revision} · Updated {relativeTime(claim.updatedAt)}
      </p>
      {conflictRevision !== undefined && (
        <p className="error-message" role="alert">
          This claim changed while you were editing. Your changes were not applied. Review the
          latest values before starting a new edit.
        </p>
      )}
      {needsRefresh && (
        <div className="cluster">
          <button className="btn btn--sm" onClick={reload}>
            Load latest claim
          </button>
        </div>
      )}
      {writable &&
        (editing ? (
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
          <div className="cluster">
            <button
              className="btn btn--sm"
              disabled={needsRefresh}
              onClick={() => {
                setEditing(true);
                setConflictRevision(undefined);
              }}
            >
              Edit status and confidence
            </button>
          </div>
        ))}
    </article>
  );
}

function ClaimsPage() {
  const { actor } = useSession();
  const claims = useTool<Claim[]>('claim.list', {}, { every: 10000 });
  const [creating, setCreating] = useState(false);
  const writable = actor.role === 'operator' || actor.role === 'producer';
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
        emptyHint="A claim records a statement, where it applies and how confident you are; a producer writes one here."
      />
      {claims.data?.map((claim) => (
        <ClaimCard key={claim.id} claim={claim} writable={writable} reload={claims.reload} />
      ))}
    </div>
  );
}

export function ClaimsView() {
  const epoch = useScopeVersion();
  const { actor, project } = useSession();
  return <ClaimsPage key={`${epoch}:${project.id}:${actor.id}:${actor.role}`} />;
}
