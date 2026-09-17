import { useEffect, useState } from 'react';
import { accountRequest, scopeVersion, useScopeVersion } from '../api';
import type { GitHubBranch, GitHubStatus } from '@merv/contracts/types';

export function GitHubAutomation({
  status,
  onChanged,
}: {
  status: GitHubStatus;
  onChanged(): void;
}) {
  const epoch = useScopeVersion();
  const [mode, setMode] = useState(status.automation);
  const [base, setBase] = useState(status.baseBranch ?? status.repository?.defaultBranch ?? '');
  const [branches, setBranches] = useState<GitHubBranch[]>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setMode(status.automation);
    setBase(status.baseBranch ?? status.repository?.defaultBranch ?? '');
    setBranches(undefined);
    setBusy(false);
    setError('');
  }, [status.revision, epoch]);
  if (!status.repository) return null;
  const request = <T,>(path: string, body?: unknown) =>
    accountRequest<T>(`/code/github/${path}`, {
      scoped: true,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { method: 'POST', body }),
    });
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (epoch === scopeVersion())
        setError(e instanceof Error ? e.message : 'GitHub could not confirm this change');
    } finally {
      if (epoch === scopeVersion()) setBusy(false);
    }
  };
  return (
    <section className="stack" aria-label="Repository automation">
      <div>
        <h3>Repository automation</h3>
        <p className="muted">
          {status.automation === 'off'
            ? 'Off'
            : status.automation === 'read'
              ? 'Read only'
              : 'Read and publish'}
          {status.baseBranch ? ` · Base: ${status.baseBranch}` : ''}
        </p>
      </div>
      {!status.automationConfigured && (
        <p className="muted">
          The server needs its GitHub App key before runners can fetch or publish code.
        </p>
      )}
      {status.canManage && (
        <>
          <label className="stack">
            Agent access
            <select
              className="input"
              value={mode}
              disabled={busy || (!status.canBrowse && status.automation === 'off')}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="off">Off</option>
              <option value="read" disabled={!status.automationConfigured || !status.canBrowse}>
                Read only
              </option>
              <option value="write" disabled={!status.automationConfigured || !status.canBrowse}>
                Read and publish reviewable changes
              </option>
            </select>
          </label>
          {mode !== 'off' && (
            <label className="stack">
              Base branch
              {branches ? (
                <select
                  className="input"
                  value={base}
                  disabled={busy}
                  onChange={(e) => setBase(e.target.value)}
                >
                  <option value="">Choose a branch</option>
                  {branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="cluster">
                  <span>{base || 'No branch chosen'}</span>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const value = await request<{ branches: GitHubBranch[] }>('branches');
                        if (epoch === scopeVersion()) setBranches(value.branches);
                      })
                    }
                  >
                    Choose branch
                  </button>
                </div>
              )}
            </label>
          )}
          <p className="muted">
            Read and publish lets trusted runners push checkpoints and open consolidation PRs in
            this repository. An operator must explicitly merge an independently approved proposal.
            Changing this setting invalidates outstanding publication authority.
          </p>
          <div>
            <button
              className="btn"
              disabled={
                busy ||
                (mode !== 'off' && (!base || !status.canBrowse || !status.automationConfigured)) ||
                (mode === status.automation &&
                  base === (status.baseBranch ?? status.repository.defaultBranch ?? ''))
              }
              onClick={() =>
                void act(async () => {
                  await request('automation', {
                    expectedRevision: status.revision,
                    mode,
                    baseBranch: mode === 'off' ? null : base,
                  });
                  if (epoch === scopeVersion()) onChanged();
                })
              }
            >
              {busy ? 'Saving…' : 'Save automation'}
            </button>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
