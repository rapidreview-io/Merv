import { useEffect, useState } from 'react';
import type { ProjectInvitation } from '@merv/contracts/scope-models';
import { accountRequest, safely, scopeVersion } from './api';
import { term } from './components';

/** An invitation is an offer, not project access. Opening this view never accepts it. */
export function Invitations({
  projectId,
  refresh = 0,
  accepted,
}: {
  projectId?: string;
  refresh?: number;
  accepted?(projectId: string): void;
}) {
  const [items, setItems] = useState<ProjectInvitation[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const path = projectId
    ? `/projects/${encodeURIComponent(projectId)}/invitations`
    : '/account/invitations';
  const highlighted =
    new URLSearchParams(window.location.search).get('invitation') ??
    safely(() => sessionStorage.getItem('merv:invitation'));
  useEffect(() => {
    let active = true;
    setLoaded(false);
    const epoch = scopeVersion();
    const current = () => active && epoch === scopeVersion();
    const load = () =>
      accountRequest<{ invitations: ProjectInvitation[] }>(path, { scoped: !!projectId }).then(
        (result) => {
          if (current()) {
            setItems(result.invitations);
            setLoaded(true);
            setError('');
          }
        },
        (failure) => {
          if (current())
            setError(failure instanceof Error ? failure.message : 'Could not load invitations.');
        },
      );
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path, projectId, refresh, revision]);
  const act = async (item: ProjectInvitation, action: 'accept' | 'decline' | 'revoke' | 'send') => {
    if (busy) return;
    const epoch = scopeVersion();
    setBusy(true);
    setError('');
    try {
      await accountRequest(
        `${path}/${encodeURIComponent(item.id)}${action === 'revoke' ? '' : `/${action}`}`,
        {
          method: action === 'revoke' ? 'DELETE' : 'POST',
          ...(action === 'revoke' ? {} : { body: {} }),
          scoped: !!projectId,
        },
      );
      if (epoch !== scopeVersion()) return;
      setRevision((value) => value + 1);
      if (action === 'decline' && highlighted === item.id) {
        const url = new URL(window.location.href);
        url.searchParams.delete('invitation');
        window.history.replaceState(null, '', url);
        safely(() => sessionStorage.removeItem('merv:invitation'));
      }
      if (action === 'accept') accepted?.(item.projectId);
    } catch (failure) {
      if (epoch === scopeVersion())
        setError(failure instanceof Error ? failure.message : 'Could not update invitation.');
    } finally {
      if (epoch === scopeVersion()) setBusy(false);
    }
  };
  const pending = items.filter((item) => item.status === 'pending');
  if (!pending.length && !error && !highlighted) return null;
  return (
    <section
      className="card"
      aria-label={projectId ? 'Pending invitations' : 'Project invitations'}
    >
      <h2>{projectId ? 'Pending invitations' : 'Project invitations'}</h2>
      {loaded && !projectId && highlighted && !pending.some((item) => item.id === highlighted) && (
        <p>
          This invitation is not pending for your account. It may have expired, been revoked, or
          already been answered. Sign in with the email address that received it.
        </p>
      )}
      {pending.map((item) => (
        <div key={item.id} className="identity-form">
          <strong>{projectId ? item.email : item.projectName}</strong>
          <p>
            {term(item.role)} · Expires {new Date(item.expiresAt).toLocaleDateString()}
            {projectId ? (item.sentAt ? ' · Email sent' : ' · Email not confirmed') : ''}
          </p>
          <div className="states">
            {projectId ? (
              <>
                {!item.sentAt && (
                  <button className="btn" disabled={busy} onClick={() => void act(item, 'send')}>
                    Retry email
                  </button>
                )}
                <button className="btn" disabled={busy} onClick={() => void act(item, 'revoke')}>
                  Revoke invitation
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => void act(item, 'accept')}
                >
                  Accept invitation
                </button>
                <button className="btn" disabled={busy} onClick={() => void act(item, 'decline')}>
                  Decline
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </section>
  );
}
