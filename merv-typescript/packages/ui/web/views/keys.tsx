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
import { PageHeader } from '../components';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The request could not be completed.';
const expiration = (value: string): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())
    throw new Error('Choose an expiration in the future, or leave it empty for no expiration.');
  return date.toISOString();
};

/** This account screen can open without a selected project, including after membership loss. */
export function KeysPanel({
  account,
  initialProjectId,
  onClose,
}: {
  account: Extract<Account, { kind: 'user' }>;
  initialProjectId?: string;
  onClose(): void;
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
    <main className="page-stage stack stack--lg">
      <PageHeader
        title="Machine keys"
        summary="Keys let your agents use your project access. They follow your current role and lose project access when your membership is removed."
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
      <p className="faint">
        Account: <code>{subject}</code>. You can list and revoke your keys after leaving their
        issuance project. Creation and project-key rotation need membership there. Account-key
        rotation needs at least one current project membership.
      </p>
      {secret && (
        <section className="card stack" aria-label="New machine key">
          <h2 className="section-title">Copy this key now</h2>
          <p>It is shown once and forgotten when you hide it or close this screen.</p>
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
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      <section className="card stack">
        <h2 className="section-title">Create a key</h2>
        {!keys ? (
          <p>Loading your projects and keys…</p>
        ) : projects.length === 0 ? (
          <p>Join or create a project before issuing a new key. Your existing keys are below.</p>
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
            {grantScope === 'account' && (
              <p>
                This key can access every project you belong to now and every project you join
                later. Its issuance project is only where the key was created.
              </p>
            )}
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
              Create key
            </button>
          </form>
        )}
      </section>
      <section className="stack">
        <h2 className="section-title">Your keys</h2>
        <p className="faint">
          Revoke also stops every replacement descended from the selected key. Rotation replaces
          only the selected key and stops its old bearer immediately.
        </p>
        {keys?.length === 0 && <p>No keys have been issued by this account.</p>}
        {keys?.map((key) => {
          const expired = !!key.expiresAt && Date.parse(key.expiresAt) <= Date.now();
          const project = projects.find((project) => project.id === key.projectId);
          const canRotate = key.grantScope === 'account' ? projects.length > 0 : !!project;
          return (
            <section className="record stack" key={key.id}>
              <h3>{key.label || 'Unnamed key'}</h3>
              <code>{key.id}</code>
              <p>
                {key.grantScope === 'account'
                  ? 'All current and future memberships'
                  : 'One project'}{' '}
                · Issued in {project?.name ?? key.projectId}
              </p>
              <p>
                {key.revokedAt ? `Revoked ${key.revokedAt}` : expired ? 'Expired' : 'Active'} ·
                Created {key.createdAt} ·{' '}
                {key.expiresAt ? `Expires ${key.expiresAt}` : 'No expiration'}
              </p>
              {key.previousId && (
                <p>
                  Replaces <code>{key.previousId}</code>
                </p>
              )}
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
                  <p>
                    Replacing this key stops the old bearer immediately. Update your agent with the
                    replacement shown next.
                  </p>
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
                  ) : (
                    <p>The existing expiration is preserved.</p>
                  )}
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
    </main>
  );
}
