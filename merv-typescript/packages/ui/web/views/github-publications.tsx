import { useEffect, useRef, useState } from 'react';
import { accountRequest, scopeVersion, useScopeVersion } from '../api';
import { KV, StatusPill, Table } from '../components';
import { useSession } from '../session';
import type { CodePublication, GitHubPullDetails } from '@merv/contracts/types';

const request = <T,>(path = '', body?: unknown) =>
  accountRequest<T>(`/code/publications${path}`, {
    scoped: true,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', body }),
  });
type Detail = { publication: CodePublication; details: GitHubPullDetails | null };
const status = (p: CodePublication) =>
  p.lastError
    ? 'blocked'
    : p.pull?.merged
      ? 'merged'
      : p.review && p.review.verdict !== 'pass'
        ? 'returned'
        : p.pull?.state === 'closed'
          ? 'closed'
          : p.review?.verdict === 'pass' && p.pull && !p.pull.draft
            ? 'ready'
            : p.pull
              ? 'draft'
              : 'pending';
export function GitHubPublications() {
  const epoch = useScopeVersion(),
    { actor, account } = useSession();
  const [rows, setRows] = useState<CodePublication[]>([]),
    [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<Detail>(),
    [error, setError] = useState(''),
    [detailError, setDetailError] = useState('');
  const [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const sequence = useRef(0),
    alive = useRef(false);
  const current = () => alive.current && epoch === scopeVersion();
  const load = async () => {
    const value = await request<{ publications: CodePublication[] }>();
    if (current()) setRows(value.publications);
  };
  useEffect(() => {
    alive.current = true;
    setRows([]);
    setSelected(undefined);
    setDetail(undefined);
    setError('');
    setDetailError('');
    setBusy(false);
    setConfirm(false);
    const poll = () =>
      void load().catch((e) => {
        if (current()) setError(e.message);
      });
    poll();
    const timer = setInterval(poll, 10000);
    return () => {
      alive.current = false;
      clearInterval(timer);
      sequence.current++;
    };
  }, [epoch]);
  const inspect = async (id: string) => {
    if (!current()) return;
    const seq = ++sequence.current;
    setSelected(id);
    setDetail(undefined);
    setDetailError('');
    setConfirm(false);
    try {
      const value = await request<Detail>(`/${encodeURIComponent(id)}`);
      if (current() && seq === sequence.current) setDetail(value);
    } catch (e) {
      if (current() && seq === sequence.current)
        setDetailError(e instanceof Error ? e.message : 'Could not inspect this pull request');
    }
  };
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (current())
        setError(e instanceof Error ? e.message : 'GitHub did not confirm the operation');
    } finally {
      if (current()) setBusy(false);
    }
  };
  const p = detail?.publication,
    d = detail?.details;
  const operator = actor.role === 'operator' && account.kind === 'user';
  return (
    <section className="stack" aria-label="Consolidation pull requests">
      <div className="cluster cluster--between">
        <div>
          <h2 className="section-title">Consolidation pull requests</h2>
          <p className="muted">
            An immutable proposal, its independent review, and the code published to GitHub.
          </p>
        </div>
        {!!rows.length && operator && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const value = await request<{ publications: CodePublication[] }>('/sync', {});
                if (current()) setRows(value.publications);
                if (selected) await inspect(selected);
              })
            }
          >
            Sync with GitHub
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!rows.length ? (
        <p className="muted">
          PRs appear when a consolidation seals a proposal from a GitHub workspace.
        </p>
      ) : (
        <Table
          rows={rows}
          keyOf={(p) => p.proposalId}
          columns={[
            {
              key: 'title',
              label: 'Proposal',
              render: (p) => (
                <button
                  className="btn-text"
                  aria-expanded={selected === p.proposalId}
                  onClick={() => void inspect(p.proposalId)}
                >
                  {p.title}
                </button>
              ),
            },
            {
              key: 'head',
              label: 'Commit',
              render: (p) => <code title={p.headOid}>{p.headOid.slice(0, 12)}</code>,
            },
            {
              key: 'review',
              label: 'Merv review',
              render: (p) =>
                p.review?.verdict.replaceAll('_', ' ') ?? 'Awaiting independent review',
            },
            {
              key: 'pull',
              label: 'GitHub',
              render: (p) =>
                p.pull ? (
                  <a href={p.pull.url} target="_blank" rel="noreferrer">
                    #{p.pull.number}
                  </a>
                ) : (
                  'Pending publication'
                ),
            },
            { key: 'status', label: 'State', render: (p) => <StatusPill value={status(p)} /> },
          ]}
        />
      )}
      {selected && (
        <aside
          className="card stack"
          aria-label="Pull request details"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              sequence.current++;
              setSelected(undefined);
            }
          }}
        >
          <div className="cluster cluster--between">
            <h3>{p?.title ?? 'Pull request details'}</h3>
            <div className="cluster">
              <button className="btn" disabled={busy} onClick={() => void inspect(selected)}>
                Refresh details
              </button>
              <button
                className="btn"
                onClick={() => {
                  sequence.current++;
                  setSelected(undefined);
                }}
              >
                Close
              </button>
            </div>
          </div>
          {detailError && <p role="alert">{detailError}</p>}
          {!detail && !detailError && <p>Loading…</p>}
          {p && (
            <>
              <KV
                rows={[
                  ['Repository', p.repository],
                  ['Proposal', p.proposalId],
                  ['Branch', p.branch],
                  ['Base', p.baseBranch],
                  ['Reviewed head', p.headOid],
                  ['Manifest SHA-256', p.manifestHash],
                  [
                    'Independent review',
                    p.review ? `${p.review.verdict} · ${p.review.id}` : 'Pending',
                  ],
                  ['Publication status', status(p)],
                ]}
              />
              {p.lastError && (
                <p role="alert">
                  {p.lastError.replaceAll('_', ' ')}. Correct the connection or conflict, then sync
                  again.
                </p>
              )}
              {!d && <p className="muted">The draft PR has not been confirmed on GitHub yet.</p>}
              {d && (
                <>
                  <div className="cluster">
                    <a href={d.pull.url} target="_blank" rel="noreferrer">
                      Open PR #{d.pull.number} on GitHub
                    </a>
                    <StatusPill
                      value={d.pull.merged ? 'merged' : d.pull.draft ? 'draft' : d.pull.state}
                    />
                  </div>
                  <p className="muted">
                    GitHub merge state: {d.pull.mergeState}. Current base:{' '}
                    <code>{d.pull.base.sha.slice(0, 12)}</code>
                    {d.pull.base.sha !== p.baseOid
                      ? ' · The base has advanced since this proposal started.'
                      : ''}
                  </p>
                  <h4>Checks</h4>
                  {!d.checks.length && !d.statusCount ? (
                    <p className="muted">No checks or commit statuses were reported.</p>
                  ) : (
                    <>
                      <p>Commit statuses: {d.statusCount ? d.commitStatus : 'None'}</p>
                      <ul>
                        {d.checks.map((c, i) => (
                          <li key={i}>
                            {c.url ? (
                              <a href={c.url} target="_blank" rel="noreferrer">
                                {c.name}
                              </a>
                            ) : (
                              c.name
                            )}
                            : {c.conclusion ?? c.status}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <h4>GitHub reviews</h4>
                  {d.reviews.length ? (
                    <ul>
                      {d.reviews.map((r) => (
                        <li key={r.id}>
                          {r.user}: {r.state.toLowerCase().replaceAll('_', ' ')} ·{' '}
                          <code>{r.commitSha.slice(0, 12)}</code>
                          {r.body && <p>{r.body}</p>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">
                      No GitHub reviews. Merv's independent review is recorded above.
                    </p>
                  )}
                  <details>
                    <summary>{d.commits.length} commits</summary>
                    <ul>
                      {d.commits.map((c) => (
                        <li key={c.sha}>
                          <a href={c.url} target="_blank" rel="noreferrer">
                            {c.sha.slice(0, 12)}
                          </a>{' '}
                          {c.message}
                        </li>
                      ))}
                    </ul>
                  </details>
                  <div className="stack">
                    <h4>{d.files.length} changed files</h4>
                    {d.files.map((f) => (
                      <details key={f.path}>
                        <summary>
                          {f.path} · {f.status} · +{f.additions} −{f.deletions}
                        </summary>
                        {f.previousPath && <p>Previously {f.previousPath}</p>}
                        {f.patch === null ? (
                          <p className="muted">
                            GitHub omitted this patch (for example, a binary or large file). Inspect
                            it on GitHub or in the exact checkout.
                          </p>
                        ) : (
                          <pre style={{ overflowX: 'auto', maxHeight: '32rem', fontSize: 12 }}>
                            {f.patch}
                          </pre>
                        )}
                      </details>
                    ))}
                  </div>
                  {d.pull.merged ? (
                    <p>
                      Merged as <code>{d.pull.mergeCommitSha}</code>.
                    </p>
                  ) : (
                    operator &&
                    p.review?.verdict === 'pass' &&
                    d.pull.state === 'open' &&
                    !d.pull.draft && (
                      <div className="stack">
                        {!confirm ? (
                          <div>
                            <button
                              className="btn btn--primary"
                              disabled={busy}
                              onClick={() => setConfirm(true)}
                            >
                              Merge reviewed proposal…
                            </button>
                          </div>
                        ) : (
                          <div
                            role="alertdialog"
                            aria-label="Confirm reviewed merge"
                            className="stack"
                          >
                            <p>
                              Merge <code>{p.headOid.slice(0, 12)}</code> into{' '}
                              <strong>{p.baseBranch}</strong> using a merge commit? GitHub checks
                              and branch protection apply. The base may advance concurrently; GitHub
                              does not offer an atomic base lock.
                            </p>
                            <div className="cluster">
                              <button
                                className="btn"
                                disabled={busy}
                                onClick={() => setConfirm(false)}
                              >
                                Cancel
                              </button>
                              <button
                                className="btn btn--primary"
                                disabled={busy}
                                onClick={() =>
                                  void act(async () => {
                                    await request('/merge', {
                                      proposalId: p.proposalId,
                                      expectedHead: p.headOid,
                                      expectedBase: d.pull.base.sha,
                                      requestId: crypto.randomUUID(),
                                    });
                                    if (current()) {
                                      setConfirm(false);
                                      await load();
                                      await inspect(p.proposalId);
                                    }
                                  })
                                }
                              >
                                Confirm merge
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  )}
                </>
              )}
            </>
          )}
        </aside>
      )}
    </section>
  );
}
