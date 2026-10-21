import type { CodePublication } from '@merv/code-work/models';
import { useState } from 'react';
import { call, projectSelection, useScopeVersion } from '../api';
import { Ago, CopyButton, Short, StatusPill, words } from '../components';

/** Local integrations and retained historical external evidence. No external calls or controls. */
export function CodeIntegrations({
  rows,
  onDone,
  operator,
  named,
}: {
  rows: CodePublication[];
  onDone(): void;
  operator: boolean;
  named(id: string | null | undefined): string | undefined;
}) {
  useScopeVersion();
  const projectId = projectSelection();
  const remote = projectId
    ? new URL(`/git/${encodeURIComponent(projectId)}.git`, window.location.origin).href
    : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sync = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await call('code.write:publication_sync');
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Integration could not be refreshed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="stack" aria-label="Integrations">
      {remote && (
        <div className="stack">
          <div className="cluster cluster--between">
            <h2 className="section-title">Project Git remote</h2>
            <CopyButton text={remote} label="Copy remote URL" />
          </div>
          <code>{remote}</code>
          <pre>{`git clone ${remote}`}</pre>
          <p>
            Use <code>merv</code> as the username and your existing Merv user key as the password
            when Git asks. Keep the key in your Git credential manager.
          </p>
          <p>
            Project administrators can push source onto user branches. Select a pushed branch for
            independent integration into <code>merv-main</code>; existing work keeps its pinned
            baseline. Merv manages <code>merv-main</code> and <code>merv/</code> branches.
          </p>
        </div>
      )}
      <div className="cluster cluster--between">
        <h2 className="section-title">
          Integrations <span className="section-n">{rows.length}</span>
        </h2>
        {!!rows.length && operator && (
          <button className="btn" disabled={busy} onClick={() => void sync()}>
            Refresh integrations
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="rows">
        {rows.map((p) => (
          <article className="row pr-row" key={p.proposalId}>
            <div className="row-name">
              <strong>{p.title}</strong>
              <StatusPill value={p.state} />
            </div>
            <p className="cluster">
              <Short value={p.headOid} />
              <span>
                {p.destination === 'local' ? 'into merv-main' : 'Historical external publication'}
              </span>
              <Ago at={p.createdAt} />
            </p>
            {p.review && (
              <p className="cluster">
                <span>Independent review</span>
                <StatusPill value={p.review.verdict} />
                <span>{named(p.review.actorId)}</span>
              </p>
            )}
            {p.lastError && <p>{words(p.lastError)}</p>}
            {p.pull && (
              <a href={p.pull.url} target="_blank" rel="noreferrer">
                Historical pull request
              </a>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
