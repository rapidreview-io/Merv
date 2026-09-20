import { useCallback, useEffect, useRef, useState } from 'react';
import { accountRequest, scopeVersion, useScopeVersion } from '../api';
import type { GitHubRepository, GitHubStatus } from '@merv/contracts/types';
import { LoadState, StatusPill } from '../components';
import { GitHubAutomation } from './github-automation';

const request = <T,>(action = '', body?: unknown) =>
  accountRequest<T>(`/code/github${action}`, {
    scoped: true,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', body }),
  });

export function GitHubConnection() {
  const epoch = useScopeVersion();
  const [status, setStatus] = useState<GitHubStatus>();
  const [repositories, setRepositories] = useState<GitHubRepository[]>();
  const [selection, setSelection] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  const finishing = useRef<{ epoch: number; result: Promise<GitHubStatus> }>();
  const callback = new URLSearchParams(window.location.search).get('github') === 'complete';
  const current = useCallback(() => mounted.current && epoch === scopeVersion(), [epoch]);
  const finish = useCallback(() => {
    if (finishing.current?.epoch !== epoch)
      finishing.current = { epoch, result: request<GitHubStatus>('/finish', {}) };
    return finishing.current.result;
  }, [epoch]);
  useEffect(() => {
    mounted.current = true;
    setStatus(undefined);
    setRepositories(undefined);
    setSelection('');
    setError(
      new URLSearchParams(window.location.search).get('github') === 'denied'
        ? 'GitHub authorization was cancelled. You can connect again when ready.'
        : undefined,
    );
    setBusy(true);
    const pending = callback ? finish() : request<GitHubStatus>();
    void pending
      .then((value) => {
        if (!current()) return;
        setStatus(value);
        if (callback) {
          const url = new URL(window.location.href);
          url.searchParams.delete('github');
          window.history.replaceState(window.history.state, '', url);
        }
      })
      .catch(async (failure: unknown) => {
        if (!current()) return;
        setError(
          failure instanceof Error ? failure.message : 'GitHub connection could not be loaded',
        );
        // An exchanged code cannot be retried after an uncertain failure. Keep Connect available.
        if (callback) {
          try {
            const value = await request<GitHubStatus>();
            if (current()) setStatus(value);
          } catch {
            /* preserve the authorization error */
          }
        }
      })
      .finally(() => {
        if (current()) setBusy(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [epoch, current, finish]);

  async function act(action: () => Promise<void>) {
    if (busy || !current()) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      if (current()) {
        setError(failure instanceof Error ? failure.message : 'GitHub did not confirm this change');
        // Refresh revisions after an uncertain write so retry never silently overwrites newer work.
        try {
          const value = await request<GitHubStatus>();
          if (current()) setStatus(value);
        } catch {
          /* keep the original error */
        }
      }
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function update(action: string, body: object) {
    const value = await request<GitHubStatus>(action, body);
    if (current()) {
      setStatus(value);
      setRepositories(undefined);
      setSelection('');
    }
  }
  const selected = repositories?.find((repo) => `${repo.installationId}:${repo.id}` === selection);
  return (
    <section className="stack" aria-label="GitHub repository">
      {/* How the connection stands is the pill beside its name, never a clause of a sentence. */}
      <div className="cluster">
        <h2 className="section-title">GitHub repository</h2>
        {status && (
          <StatusPill value={status.status === 'disconnected' ? 'not connected' : status.status} />
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!status && !error && <LoadState loading />}
      {!status && error && (
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              finishing.current = undefined;
              const value = callback ? await finish() : await request<GitHubStatus>();
              if (current()) setStatus(value);
            })
          }
        >
          Try again
        </button>
      )}
      {status && (
        <>
          {status.repository ? (
            <div>
              <a href={status.repository.url} target="_blank" rel="noreferrer">
                <strong>{status.repository.fullName}</strong>
              </a>
              <p className="faint">
                {status.repository.private ? 'Private' : 'Public'} ·{' '}
                {status.repository.defaultBranch ?? 'No default branch'}
              </p>
            </div>
          ) : (
            status.status !== 'disconnected' && <p className="muted">No repository linked</p>
          )}
          {!status.configured ? (
            <p className="faint">Not configured on this server</p>
          ) : (
            <>
              {status.user && <p className="faint">Connected by {status.user.login}</p>}
              {status.canManage && (
                <div className="cluster">
                  <button
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const result = await request<{ url: string }>('/begin', {
                          expectedRevision: status.revision,
                        });
                        if (current()) window.location.assign(result.url);
                      })
                    }
                  >
                    {status.status === 'disconnected' ? 'Connect GitHub' : 'Reconnect GitHub'}
                  </button>
                  {status.installUrl && (
                    <a className="btn" href={status.installUrl} target="_blank" rel="noreferrer">
                      Choose repositories on GitHub
                    </a>
                  )}
                  {status.canBrowse && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const result = await request<{ repositories: GitHubRepository[] }>(
                            '/repositories',
                          );
                          if (current()) {
                            setRepositories(result.repositories);
                            setSelection('');
                          }
                        })
                      }
                    >
                      Select repository
                    </button>
                  )}
                  {status.status !== 'disconnected' && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void act(() => update('/disconnect', { expectedRevision: status.revision }))
                      }
                    >
                      Disconnect
                    </button>
                  )}
                  {status.repository && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          update('/repository', {
                            expectedRevision: status.revision,
                            installationId: null,
                            repositoryId: null,
                          }),
                        )
                      }
                    >
                      Unlink repository
                    </button>
                  )}
                </div>
              )}
              {repositories && (
                <div className="stack">
                  {repositories.length ? (
                    <>
                      <label className="stack">
                        Repository
                        <select
                          className="input"
                          value={selection}
                          disabled={busy}
                          onChange={(event) => setSelection(event.target.value)}
                        >
                          <option value="">Select a repository</option>
                          {repositories.map((repo) => (
                            <option
                              key={`${repo.installationId}:${repo.id}`}
                              value={`${repo.installationId}:${repo.id}`}
                            >
                              {repo.fullName}
                              {repo.private ? ' (private)' : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="btn btn--primary"
                        disabled={busy || !selected}
                        onClick={() =>
                          selected &&
                          void act(() =>
                            update('/repository', {
                              expectedRevision: status.revision,
                              installationId: selected.installationId,
                              repositoryId: selected.id,
                            }),
                          )
                        }
                      >
                        Link repository
                      </button>
                    </>
                  ) : (
                    <p className="muted">No accessible repositories</p>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
      {status && (
        <GitHubAutomation
          status={status}
          onChanged={() =>
            void act(async () => {
              const value = await request<GitHubStatus>();
              if (current()) setStatus(value);
            })
          }
        />
      )}
    </section>
  );
}
