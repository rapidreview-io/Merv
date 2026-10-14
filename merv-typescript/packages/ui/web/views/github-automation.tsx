import { useEffect, useRef, useState } from 'react';
import { githubRequest, useScopeVersion } from '../api';
import { useCurrent } from '../mutations';
import type { GitHubBranch, GitHubStatus } from '@merv/contracts/types';

const ACCESS: Record<GitHubStatus['automation'], string> = {
  off: 'Off',
  read: 'Read only',
  write: 'Read & publish',
};

export function GitHubAutomation({
  status,
  onChanged,
}: {
  status: GitHubStatus;
  onChanged(): void;
}) {
  const epoch = useScopeVersion();
  const scoped = useCurrent();
  const revision = useRef(status.revision);
  revision.current = status.revision;
  const current = () => scoped() && revision.current === status.revision;
  const saved = status.baseBranch ?? status.repository?.defaultBranch ?? '';
  const [mode, setMode] = useState(status.automation);
  const [base, setBase] = useState(saved);
  const [branches, setBranches] = useState<GitHubBranch[]>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setMode(status.automation);
    setBase(saved);
    setBranches(undefined);
    setBusy(false);
    setError('');
  }, [status.revision, epoch]);
  if (!status.repository) return null;
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (current())
        setError(e instanceof Error ? e.message : 'GitHub could not confirm this change');
    } finally {
      if (current()) setBusy(false);
    }
  };
  const changed = mode !== status.automation || (mode !== 'off' && base !== saved);
  return (
    <section className="github-automation stack" aria-label="Repository automation">
      {!status.canManage && (
        <div className="github-setting">
          <span>Agent access</span>
          <span className="muted">{ACCESS[status.automation]}</span>
        </div>
      )}
      {status.canManage && (
        <>
          <label className="github-setting">
            <span>Agent access</span>
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
                Read & publish
              </option>
            </select>
          </label>
          {mode !== 'off' && (
            <div className="github-setting">
              <span>Base branch</span>
              {branches ? (
                <select
                  className="input"
                  aria-label="Base branch"
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
                    aria-label="Choose branch"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const value = await githubRequest<{ branches: GitHubBranch[] }>(
                          '/branches',
                        );
                        if (current()) setBranches(value.branches);
                      })
                    }
                  >
                    Change
                  </button>
                </div>
              )}
            </div>
          )}
          {changed && (
            <div className="github-save">
              <button
                className="btn github-primary"
                disabled={
                  busy ||
                  (mode !== 'off' && (!base || !status.canBrowse || !status.automationConfigured))
                }
                onClick={() =>
                  void act(async () => {
                    await githubRequest('/automation', {
                      expectedRevision: status.revision,
                      mode,
                      baseBranch: mode === 'off' ? null : base,
                    });
                    if (current()) onChanged();
                  })
                }
              >
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
