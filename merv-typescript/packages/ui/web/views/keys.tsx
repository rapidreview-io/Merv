import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  accountRequest,
  keyClient,
  scopeVersion,
  type Account,
  type IssuedUserKey,
  type Project,
  type UserKey,
} from '../api';
import { Failure, PageHeader, stamp } from '../components';
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

/**
 * Keys are a setting, and open as one under Settings › Keys. The same panel still
 * stands alone for an account with no project selected — after membership loss,
 * or from the project chooser — which is when it carries a way back.
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

  const mutate = async (run: () => Promise<IssuedUserKey | { revoked: true }>) => {
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
    void mutate(() =>
      keyClient.create({
        projectId,
        grantScope,
        ...(label.trim() ? { label: label.trim() } : {}),
        expiresAt: expiration(expiresAt),
      }),
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

  return (
    <section className="page-stage stack stack--lg">
      <PageHeader
        title="Machine keys"
        actions={
          onClose && (
            <button
              className="btn"
              onClick={() => {
                forgetSecret();
                onClose();
              }}
            >
              Close
            </button>
          )
        }
      />
      <p className="faint">
        Account: <code>{subject}</code>
      </p>
      {secret && (
        <section className="card stack" aria-label="New machine key">
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
          <div className="signin-actions">
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
      <section className="card stack">
        <h2 className="section-title">New key</h2>
        {!keys ? (
          <p>Loading your projects and keys…</p>
        ) : projects.length === 0 ? (
          <p>No project to issue a key in.</p>
        ) : (
          <form className="identity-form" onSubmit={create}>
            <label>
              Issuance project
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
              Expiration (optional, local time)
              <input
                className="input"
                type="datetime-local"
                value={expiresAt}
                disabled={busy}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </label>
            <button className="btn btn--primary" disabled={busy || !projectId}>
              New key
            </button>
          </form>
        )}
      </section>
      <section className="stack">
        <h2 className="section-title">Your keys</h2>
        {keys?.length === 0 && <p>No keys have been issued by this account.</p>}
        {keys?.map((key) => {
          const expired = !!key.expiresAt && Date.parse(key.expiresAt) <= Date.now();
          const project = projects.find((project) => project.id === key.projectId);
          const canRotate = key.grantScope === 'account' ? projects.length > 0 : !!project;
          return (
            <section className="stack" key={key.id}>
              <span className="row-name">
                <strong>{key.label || 'Unnamed key'}</strong>
              </span>
              <ThreeStates
                execution={key.revokedAt ? 'revoked' : expired ? 'expired' : 'active'}
                meta={[
                  key.grantScope === 'account'
                    ? 'All current and future memberships'
                    : project?.name,
                  `created ${stamp(key.createdAt)}`,
                  key.expiresAt ? `expires ${stamp(key.expiresAt)}` : 'no expiration',
                  key.previousId && 'replaces an earlier key',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
              <div className="signin-actions">
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
                <form className="identity-form" onSubmit={(event) => rotate(event, key.id)}>
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
                      New expiration (leave empty for no expiration)
                      <input
                        className="input"
                        type="datetime-local"
                        value={rotationExpiry}
                        disabled={busy}
                        onChange={(e) => setRotationExpiry(e.target.value)}
                      />
                    </label>
                  ) : null}
                  <div className="signin-actions">
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => setRotating(undefined)}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn btn--primary"
                      disabled={busy || (expired && !changeExpiry)}
                    >
                      Replace and stop old key
                    </button>
                  </div>
                </form>
              )}
            </section>
          );
        })}
      </section>
    </section>
  );
}
