import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  accountRequest,
  call,
  keyClient,
  projectSelection,
  scopeVersion,
  useScopeVersion,
  useTool,
  type Account,
  type Actor,
  type IssuedUserKey,
  type Project,
  type UserKey,
} from '../api';
import { signedInEmail } from '../auth';
import {
  EmptyState,
  Failure,
  LoadState,
  OpenedForm,
  PageHeader,
  Stamp,
  Submit,
  cx,
} from '../components';
import { ThreeStates } from '../states';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The request could not be completed.';
const expiration = (value: string): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())
    throw new Error('Choose an expiration in the future, or leave it empty for no expiration.');
  return date.toISOString();
};

/** Fleet needs an independent actor credential; account keys cannot serve as its source. */
function FleetSourceCredential({ projectId }: { projectId: string }) {
  const epoch = useScopeVersion();
  const shell = useTool<{ actor?: Actor; project?: Project; rows: { id: string }[] }>('ui.shell');
  const [creating, setCreating] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');
  const [secret, setSecret] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    setSecret(undefined);
    setCopied(false);
    setCreating(false);
    setError(undefined);
    setBusy(false);
    return () => {
      mounted.current = false;
    };
  }, [epoch, projectId]);
  const available =
    projectSelection() === projectId &&
    shell.data?.project?.id === projectId &&
    shell.data.actor?.role === 'operator' &&
    shell.data.rows.some((row) => row.id === 'fleet');
  if (!available) return null;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(undefined);
    let expiry: string;
    try {
      const when = new Date(expiresAt).getTime();
      if (!Number.isFinite(when) || when <= Date.now() || when > Date.now() + 7 * 24 * 60 * 60_000)
        throw new Error('Choose an expiration within the next seven days.');
      expiry = new Date(when).toISOString();
    } catch (failure) {
      setError(message(failure));
      return;
    }
    setBusy(true);
    try {
      const issued = await call<{ token: string }>('actor.create', {
        name: 'Fleet source',
        role: 'operator',
        expiresAt: expiry,
      });
      if (mounted.current && scopeVersion() === epoch && projectSelection() === projectId) {
        setSecret(issued.token);
        setCopied(false);
        setCreating(false);
        setExpiresAt('');
      }
    } catch (failure) {
      if (mounted.current && scopeVersion() === epoch) setError(message(failure));
    } finally {
      if (mounted.current && scopeVersion() === epoch) setBusy(false);
    }
  };
  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      if (mounted.current && scopeVersion() === epoch) setCopied(true);
    } catch {
      if (mounted.current && scopeVersion() === epoch)
        setError('Clipboard access failed. Select the credential and copy it manually.');
    }
  };
  return (
    <section className="stack" aria-label="Fleet source credential">
      <h2>Fleet source credential</h2>
      <p className="muted">
        Create a temporary operator identity for this project’s Fleet workflow.
      </p>
      {secret && (
        <section className="card stack creation" aria-label="New Fleet source credential">
          <h3>Copy this credential now</h3>
          <textarea
            className="textarea mono"
            aria-label="Fleet source credential secret"
            value={secret}
            rows={3}
            readOnly
            autoComplete="off"
            spellCheck={false}
          />
          <div className="cluster">
            <button className="btn" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy credential'}
            </button>
            <button
              className="btn"
              onClick={() => {
                setSecret(undefined);
                setCopied(false);
              }}
            >
              Hide and forget credential
            </button>
          </div>
        </section>
      )}
      {!secret && !creating && (
        <button className="btn" onClick={() => setCreating(true)}>
          New Fleet source credential
        </button>
      )}
      {!secret && creating && (
        <form className="identity-form card" onSubmit={(event) => void create(event)}>
          <label>
            Expires (within seven days)
            <input
              className="input"
              type="datetime-local"
              required
              value={expiresAt}
              disabled={busy}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
          <div className="cluster">
            <Submit busy={busy} />
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <Failure message={error} />
    </section>
  );
}

/**
 * Keys are a setting, and open as one under Settings › Keys. The same panel still
 * stands alone for an account with no project selected — after membership loss,
 * or from the project chooser — which is when it carries its own title, whose
 * account it is, and a way back. It reads as every list does: the rows, one
 * control that opens the form for a new one, and that control in the empty state
 * while there are none.
 */
export function KeysPanel({
  account,
  initialProjectId,
  onClose,
}: {
  account: Extract<Account, { kind: 'user' }>;
  initialProjectId?: string;
  onClose?(): void;
}) {
  const [keys, setKeys] = useState<UserKey[]>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [grantScope, setGrantScope] = useState<'project' | 'account'>('project');
  const [label, setLabel] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [secret, setSecret] = useState<IssuedUserKey>();
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState<string>();
  const [changeExpiry, setChangeExpiry] = useState(false);
  const [rotationExpiry, setRotationExpiry] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const heading = useId();
  const generation = useRef(0);
  const issuer = account.user.issuer;
  const subject = account.user.subject;

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const epoch = scopeVersion();
    const current = () => generation.current === currentGeneration && scopeVersion() === epoch;
    setKeys(undefined);
    setError(undefined);
    Promise.all([keyClient.list(), accountRequest<Account>('/account')]).then(
      ([result, fresh]) => {
        if (!current()) return;
        if (
          fresh.kind !== 'user' ||
          fresh.user.issuer !== issuer ||
          fresh.user.subject !== subject
        ) {
          setError('The signed-in account changed. Close this screen and sign in again.');
          return;
        }
        setKeys(result.keys);
        setProjects(fresh.projects);
        setProjectId((selected) =>
          fresh.projects.some((project) => project.id === selected) ? selected : '',
        );
      },
      (error) => {
        if (current()) setError(message(error));
      },
    );
    return () => {
      generation.current++;
    };
  }, [issuer, subject]);

  const mutate = async (
    run: () => Promise<IssuedUserKey | { revoked: true }>,
    done?: () => void,
  ) => {
    if (busy) return;
    const currentGeneration = generation.current;
    const epoch = scopeVersion();
    const current = () => generation.current === currentGeneration && scopeVersion() === epoch;
    setBusy(true);
    setSecret(undefined);
    setCopied(false);
    setError(undefined);
    try {
      const result = await run();
      if (!current()) return;
      if ('token' in result) setSecret(result);
      setRotating(undefined);
      done?.();
      const fresh = await keyClient.list();
      if (current()) setKeys(fresh.keys);
    } catch (error) {
      if (current()) setError(message(error));
    } finally {
      if (current()) setBusy(false);
    }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    void mutate(
      () =>
        keyClient.create({
          projectId,
          grantScope,
          ...(label.trim() ? { label: label.trim() } : {}),
          expiresAt: expiration(expiresAt),
        }),
      () => {
        setCreating(false);
        setLabel('');
        setExpiresAt('');
      },
    );
  };
  const rotate = (event: FormEvent, id: string) => {
    event.preventDefault();
    void mutate(() =>
      keyClient.rotate(id, changeExpiry ? { expiresAt: expiration(rotationExpiry) } : {}),
    );
  };
  const forgetSecret = () => {
    setSecret(undefined);
    setCopied(false);
  };
  const copySecret = async () => {
    if (!secret) return;
    const epoch = scopeVersion();
    const currentGeneration = generation.current;
    try {
      await navigator.clipboard.writeText(secret.token);
      if (scopeVersion() === epoch && generation.current === currentGeneration) setCopied(true);
    } catch {
      if (scopeVersion() === epoch && generation.current === currentGeneration)
        setError('Clipboard access failed. Select the key and copy it manually.');
    }
  };

  // A key is issued in a project, so an account with none has no control to offer.
  const opener = projects.length > 0 && (
    <button
      type="button"
      className={cx('btn', !creating && 'btn--primary', 'action-end')}
      aria-expanded={creating}
      onClick={() => setCreating((open) => !open)}
    >
      {creating ? 'Cancel' : 'New key'}
    </button>
  );
  return (
    <section className="page-stage stack stack--lg">
      {onClose && (
        <PageHeader
          title="Machine keys"
          summary={signedInEmail()}
          actions={
            <button
              className="btn"
              onClick={() => {
                forgetSecret();
                onClose();
              }}
            >
              Close
            </button>
          }
        />
      )}
      {initialProjectId && <FleetSourceCredential projectId={initialProjectId} />}
      {secret && (
        <section className="card stack creation" aria-label="New machine key">
          <h2 className="section-title">Copy this key now</h2>
          <textarea
            className="textarea mono"
            aria-label="New machine key secret"
            value={secret.token}
            rows={3}
            readOnly
            autoComplete="off"
            spellCheck={false}
          />
          <div className="cluster">
            <button className="btn" onClick={() => void copySecret()}>
              {copied ? 'Copied' : 'Copy key'}
            </button>
            <button className="btn" onClick={forgetSecret}>
              Hide and forget key
            </button>
          </div>
        </section>
      )}
      <Failure message={error} />
      {!keys ? (
        !error && <LoadState loading columns={2} />
      ) : (
        <div className="stack">
          {(keys.length > 0 || creating) && <div className="action-row">{opener}</div>}
          {creating && (
            <OpenedForm
              className="identity-form card"
              aria-labelledby={heading}
              onSubmit={create}
              onClose={() => setCreating(false)}
              locked={busy}
            >
              <h2 id={heading}>New key</h2>
              <label>
                Project
                <select
                  className="input"
                  required
                  disabled={busy}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">Choose a project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Access
                <select
                  className="input"
                  disabled={busy}
                  value={grantScope}
                  onChange={(e) => setGrantScope(e.target.value as 'project' | 'account')}
                >
                  <option value="project">Only this project</option>
                  <option value="account">All current and future project memberships</option>
                </select>
              </label>
              <label>
                Label (optional)
                <input
                  className="input"
                  maxLength={120}
                  value={label}
                  disabled={busy}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              <label>
                Expires (optional)
                <input
                  className="input"
                  type="datetime-local"
                  value={expiresAt}
                  disabled={busy}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </label>
              <div>
                <Submit busy={busy} disabled={!projectId} />
              </div>
            </OpenedForm>
          )}
          {keys.length === 0 && !creating && (
            <EmptyState kind="settings" icon="key" title="No keys yet" action={opener} />
          )}
          <ul className="rows">
            {keys.map((key) => {
              const expired = !!key.expiresAt && Date.parse(key.expiresAt) <= Date.now();
              const project = projects.find((project) => project.id === key.projectId);
              const canRotate = key.grantScope === 'account' ? projects.length > 0 : !!project;
              return (
                <li className="row" key={key.id}>
                  <span className="row-name">
                    <strong>{key.label || 'Unnamed key'}</strong>
                  </span>
                  <ThreeStates
                    execution={key.revokedAt ? 'revoked' : expired ? 'expired' : 'active'}
                    meta={
                      <>
                        {key.grantScope === 'account' ? 'Every membership' : project?.name}
                        {' · '}created <Stamp at={key.createdAt} />
                        {key.expiresAt && (
                          <>
                            {' · '}expires <Stamp at={key.expiresAt} />
                          </>
                        )}
                        {key.previousId && ' · replaces an earlier key'}
                      </>
                    }
                  />
                  <div className="cluster key-tools">
                    {!key.revokedAt && canRotate && (
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          forgetSecret();
                          setRotating(key.id);
                          setChangeExpiry(expired);
                          setRotationExpiry('');
                        }}
                      >
                        Replace key…
                      </button>
                    )}
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => void mutate(() => keyClient.revoke(key.id))}
                    >
                      {key.revokedAt ? 'Revoke descendants' : 'Revoke key and descendants'}
                    </button>
                  </div>
                  {rotating === key.id && (
                    <form
                      className="identity-form creation"
                      onSubmit={(event) => rotate(event, key.id)}
                    >
                      <label>
                        <span>
                          <input
                            type="checkbox"
                            style={{ width: 'auto' }}
                            checked={changeExpiry}
                            disabled={busy}
                            onChange={(e) => setChangeExpiry(e.target.checked)}
                          />{' '}
                          Change expiration
                        </span>
                      </label>
                      {changeExpiry ? (
                        <label>
                          Expires (optional)
                          <input
                            className="input"
                            type="datetime-local"
                            value={rotationExpiry}
                            disabled={busy}
                            onChange={(e) => setRotationExpiry(e.target.value)}
                          />
                        </label>
                      ) : null}
                      <div className="cluster">
                        <button
                          className="btn btn--primary"
                          disabled={busy || (expired && !changeExpiry)}
                        >
                          Replace and stop old key
                        </button>
                        <button
                          className="btn"
                          type="button"
                          disabled={busy}
                          onClick={() => setRotating(undefined)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
