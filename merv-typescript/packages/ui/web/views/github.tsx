import { useCallback, useEffect, useRef, useState } from 'react';
import { accountRequest, scopeVersion, useScopeVersion } from '../api';
import type { GitHubRepository, GitHubStatus } from '@merv/contracts/types';
import { LoadState } from '../components';
import { Icon } from '../icons';
import { GitHubAutomation } from './github-automation';
import { GitHubPreparation } from './github-prepare';

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
  const connect = () =>
    void act(async () => {
      const result = await request<{ url: string }>('/begin', {
        expectedRevision: status!.revision,
      });
      if (current()) window.location.assign(result.url);
    });
  const browse = () =>
    void act(async () => {
      const result = await request<{ repositories: GitHubRepository[] }>('/repositories');
      if (current()) {
        setRepositories(result.repositories);
        setSelection('');
      }
    });
  const needsConnection = status?.status === 'disconnected' || status?.status === 'needs_reconnect';
  return (
    <section className="github-connection" aria-label="GitHub repository" aria-busy={busy}>
      <header className="github-header">
        <span className="github-mark">
          <Icon name="code" size={24} />
        </span>
        <div className="github-heading">
          <h2>GitHub</h2>
        </div>
        {status && (
          <span className="github-state" data-connected={status.status === 'connected'}>
            {status.status === 'connected'
              ? 'Connected'
              : status.status === 'needs_reconnect'
                ? 'Reconnect needed'
                : status.status === 'refreshing'
                  ? 'Refreshing'
                  : 'Not connected'}
          </span>
        )}
      </header>
      <div className="github-body stack">
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
            {status.repository && (
              <div className="github-repository">
                <div className="github-identity">
                  <a href={status.repository.url} target="_blank" rel="noreferrer">
                    {status.repository.fullName}
                    <Icon name="external" size={14} />
                  </a>
                  <p className="faint">
                    {status.repository.private ? 'Private repository' : 'Public repository'}
                  </p>
                </div>
                {status.configured && status.canManage && status.canBrowse && !repositories && (
                  <button
                    className="btn"
                    aria-label="Change repository"
                    disabled={busy}
                    onClick={browse}
                  >
                    Change
                  </button>
                )}
              </div>
            )}
            {!status.configured ? (
              <p className="muted">GitHub is not configured on this server.</p>
            ) : (
              <>
                {needsConnection ? (
                  <div className="github-connect stack">
                    <p className="muted">
                      {status.status === 'needs_reconnect'
                        ? 'Reconnect to restore access.'
                        : 'Bring your code into Merv.'}
                    </p>
                    {status.canManage && (
                      <button className="btn github-primary" disabled={busy} onClick={connect}>
                        {status.status === 'disconnected' ? 'Connect GitHub' : 'Reconnect GitHub'}
                      </button>
                    )}
                  </div>
                ) : (
                  !status.repository &&
                  !repositories && (
                    <div className="github-connect stack">
                      <p className="muted">Choose a repository for this project.</p>
                      {status.canManage && status.canBrowse && (
                        <button className="btn github-primary" disabled={busy} onClick={browse}>
                          Select repository
                        </button>
                      )}
                    </div>
                  )
                )}
                {repositories && (
                  <div className="github-picker stack">
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
                        <div className="cluster">
                          <button
                            className="btn github-primary"
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
                          <button
                            className="btn"
                            disabled={busy}
                            onClick={() => {
                              setRepositories(undefined);
                              setSelection('');
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="muted">
                          No repositories available. Check repository access on GitHub, then try
                          again.
                        </p>
                        {status.installUrl && (
                          <a
                            className="btn"
                            href={status.installUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Manage access on GitHub <Icon name="external" />
                          </a>
                        )}
                        <div className="cluster">
                          <button className="btn" disabled={busy} onClick={browse}>
                            Refresh repositories
                          </button>
                          <button
                            className="btn"
                            disabled={busy}
                            onClick={() => setRepositories(undefined)}
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
            <GitHubAutomation
              status={status}
              onChanged={() =>
                void act(async () => {
                  const value = await request<GitHubStatus>();
                  if (current()) setStatus(value);
                })
              }
            />
            {status.repository &&
              status.canManage &&
              status.automation !== 'off' &&
              status.baseBranch && (
                <div className="github-preparation">
                  <GitHubPreparation key={`${epoch}:${status.revision}`} status={status} />
                </div>
              )}
          </>
        )}
      </div>
      {status?.configured &&
        (status.user || (status.canManage && status.status !== 'disconnected')) && (
          <footer className="github-footer">
            {status.user && (
              <p className="faint">
                <span>@{status.user.login}</span>
              </p>
            )}
            {status.canManage && status.status !== 'disconnected' && (
              <details className="github-manage" key={`${epoch}:${status.revision}`}>
                <summary>
                  Manage connection <Icon name="chevron-right" size={14} />
                </summary>
                <div className="github-management">
                  {status.installUrl && (
                    <a className="btn" href={status.installUrl} target="_blank" rel="noreferrer">
                      Manage access on GitHub <Icon name="external" size={14} />
                    </a>
                  )}
                  {!needsConnection && (
                    <button className="btn" disabled={busy} onClick={connect}>
                      Reconnect GitHub
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
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void act(() => update('/disconnect', { expectedRevision: status.revision }))
                    }
                  >
                    Disconnect GitHub
                  </button>
                </div>
              </details>
            )}
          </footer>
        )}
    </section>
  );
}
