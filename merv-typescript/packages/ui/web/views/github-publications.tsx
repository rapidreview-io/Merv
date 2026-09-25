import type { CodeProjectStatus } from '@merv/contracts/code';
import type { CodePublication, GitHubPullDetails } from '@merv/contracts/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { accountRequest, scopeVersion, useScopeVersion } from '../api';
import {
  Ago,
  Area,
  Failure,
  KV,
  Short,
  StatusPill,
  Summary,
  kindStyle,
  words,
} from '../components';
import { ExternalIcon } from '../icons';
import { useCommand } from '../mutations';

/**
 * A sealed proposal, published: one row per pull request, in the grammar GitHub
 * made standard — the state word, what merged into what, the diffstat, the
 * independent verdict that gated it, and the checks. The diff, the conversation
 * and the commit list are GitHub's and stay there, one link away; Details holds
 * the machine text and is the only place an identifier is printed.
 */

const request = <T,>(path = '', body?: unknown) =>
  accountRequest<T>(`/code/publications${path}`, {
    scoped: true,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', body }),
  });

/** Merv's own word for where a publication stands; it also says where its verdict stands. */
export const status = (p: CodePublication) =>
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

/** One read of the publications for the whole page, so the graph and the rows agree. */
export function usePublications() {
  const epoch = useScopeVersion();
  const [rows, setRows] = useState<CodePublication[]>([]);
  const [error, setError] = useState('');
  const alive = useRef(false);
  const load = useCallback(async () => {
    const value = await request<{ publications: CodePublication[] }>();
    if (alive.current && epoch === scopeVersion()) setRows(value.publications);
  }, [epoch]);
  useEffect(() => {
    alive.current = true;
    setRows([]);
    setError('');
    const poll = () =>
      void load().catch((e: unknown) => {
        if (alive.current && epoch === scopeVersion())
          setError(e instanceof Error ? e.message : 'Publications could not be read');
      });
    poll();
    const timer = setInterval(poll, 10_000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [epoch, load]);
  return { rows, error, reload: load };
}

type Controls = NonNullable<CodeProjectStatus['publication']>['controls'];

/**
 * The release canary as the signed-in operator who ran it attests it: whether GitHub let
 * a deliberately stale merge through. Publication waits on a passing one; a failed one
 * stops it until a later pass and an explicit clear, which is offered only then.
 */
function Canary({ controls, onDone }: { controls: Controls; onDone(): void }) {
  const [reason, setReason] = useState<string>();
  const command = useCommand<unknown>({
    tool: 'code.publication.control',
    validate: (value) => !!value && typeof value === 'object',
    onSuccess: () => {
      setReason(undefined);
      onDone();
    },
  });
  const { canary } = controls;
  const act = (label: string, input: Record<string, unknown>) => (
    <button
      className="btn"
      disabled={command.busy || !reason?.trim()}
      onClick={() => void command.submit({ ...input, reason })}
    >
      {label}
    </button>
  );
  return (
    <>
      <p className="cluster">
        Canary <StatusPill value={!canary ? 'missing' : canary.staleMerged ? 'failed' : 'passed'} />
        {controls.disabled && <StatusPill value="disabled" />}
        {reason === undefined && (
          <button className="btn" onClick={() => setReason('')}>
            Record canary
          </button>
        )}
      </p>
      {reason !== undefined && (
        <div className="stack" role="group" aria-label="Record canary">
          <Area label="Evidence" value={reason} onChange={setReason} rows={3} />
          <Failure message={command.error} />
          <div className="cluster">
            {act('Stale merge refused', { action: 'record_canary', staleMerged: false })}
            {act('Stale merge went through', { action: 'record_canary', staleMerged: true })}
            {controls.disabled &&
              canary &&
              !canary.staleMerged &&
              act('Clear disablement', { action: 'clear' })}
            <button className="btn" disabled={command.busy} onClick={() => setReason(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function GitHubPublications({
  rows,
  error,
  reload,
  operator,
  named,
  controls,
  onControlled,
}: {
  rows: CodePublication[];
  error: string;
  reload(): Promise<void>;
  /** True where the reader may sync and merge: an operator signed in as a person. */
  operator: boolean;
  /** Who reviewed and who merged, by name; nobody is named by an identifier. */
  named(id: string | null | undefined): string | undefined;
  /** Where the project publishes at all: what its merges wait on besides a review. */
  controls?: Controls;
  onControlled(): void;
}) {
  const epoch = useScopeVersion();
  const [details, setDetails] = useState<Record<string, GitHubPullDetails | null>>({});
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState('');
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    seen.current = new Map();
    setDetails({});
    setFailed('');
    setConfirm('');
  }, [epoch]);
  // A pull request is read once, and again only when GitHub says it changed.
  useEffect(() => {
    const current = () => epoch === scopeVersion();
    for (const p of rows) {
      const key = p.pull?.updatedAt;
      if (!key || seen.current.get(p.proposalId) === key) continue;
      seen.current.set(p.proposalId, key);
      void request<{ details: GitHubPullDetails | null }>(`/${encodeURIComponent(p.proposalId)}`)
        .then((value) => {
          if (current()) setDetails((all) => ({ ...all, [p.proposalId]: value.details }));
        })
        .catch((e: unknown) => {
          if (current())
            setFailed(e instanceof Error ? e.message : 'A pull request could not be read');
        });
    }
  }, [rows, epoch]);
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFailed('');
    try {
      await fn();
    } catch (e) {
      if (epoch === scopeVersion())
        setFailed(e instanceof Error ? e.message : 'GitHub did not confirm the operation');
    } finally {
      if (epoch === scopeVersion()) setBusy(false);
    }
  };
  const row = (p: CodePublication) => {
    const d = details[p.proposalId] ?? null;
    const merged = !!p.pull?.merged;
    const commits = d ? d.commits.length : null;
    const add = d?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
    const del = d?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
    const reviewer = p.review && named(p.review.actorId);
    const merger = p.merge && named(p.merge.actorId);
    const gate =
      operator &&
      p.review?.verdict === 'pass' &&
      d &&
      d.pull.state === 'open' &&
      !d.pull.draft &&
      !d.pull.merged;
    return (
      <article className="row pr-row" key={p.proposalId}>
        <div className="row-name">
          <span className="kind" style={kindStyle('code')}>
            Proposal
          </span>
          <strong>{p.title}</strong>
          <StatusPill value={status(p)} />
        </div>
        <div className="pr-line">
          <span>
            {merged ? 'Merged' : 'Merges'}
            {commits === null ? '' : ` ${commits} commit${commits === 1 ? '' : 's'}`} into
          </span>
          <span className="branch branch--ref">{p.baseBranch}</span>
          <span>from</span>
          <span className="branch" title={p.branch}>
            {p.title}
          </span>
          {d && (
            <>
              <span className="sep">·</span>
              <span className="diff">
                <span className="add">+{add}</span> <span className="del">−{del}</span>
              </span>
              <span>
                across {d.files.length} file{d.files.length === 1 ? '' : 's'}
              </span>
            </>
          )}
          <span className="sep">·</span>
          <Ago at={p.createdAt} />
        </div>
        {(p.review || merger) && (
          <div className="pr-line">
            {p.review && (
              <>
                <span>Independent review</span>
                <StatusPill value={p.review.verdict} />
                {reviewer && <span>{reviewer}</span>}
                <Ago at={p.review.recordedAt} />
              </>
            )}
            {merger && (
              <>
                <span className="sep">·</span>
                <span>merged by {merger}</span>
              </>
            )}
          </div>
        )}
        {d && !!(d.checks.length || d.statusCount) && (
          <div className="pr-checks" aria-label="Checks">
            <div className="pr-check">
              <span className="label">Check</span>
              <span className="label">Result</span>
            </div>
            {d.checks.map((check, index) => (
              <div className="pr-check" key={index}>
                {check.url ? (
                  <a href={check.url} target="_blank" rel="noreferrer">
                    {check.name}
                  </a>
                ) : (
                  <span>{check.name}</span>
                )}
                <StatusPill value={check.conclusion ?? check.status} />
              </div>
            ))}
            {!!d.statusCount && (
              <div className="pr-check">
                <span className="muted">
                  {d.statusCount} commit status{d.statusCount === 1 ? '' : 'es'}
                </span>
                <StatusPill value={d.commitStatus} />
              </div>
            )}
          </div>
        )}
        {d && !merged && (d.pull.base.sha !== p.baseOid || d.pull.mergeState !== 'clean') && (
          <div className="pr-line">
            {d.pull.mergeState !== 'clean' && (
              <>
                <span>Merge state</span>
                <StatusPill value={d.pull.mergeState} />
              </>
            )}
            {d.pull.base.sha !== p.baseOid && (
              <span className="status status--warn">
                <span className="status-dot" aria-hidden="true" />
                Base advanced
              </span>
            )}
          </div>
        )}
        {p.lastError && <p role="alert">{words(p.lastError)}</p>}
        {gate &&
          (confirm === p.proposalId ? (
            <div role="alertdialog" aria-label="Confirm reviewed merge" className="pr-guard stack">
              <p>
                Merge <Short value={p.headOid} /> into <strong>{p.baseBranch}</strong> using a merge
                commit? GitHub checks and branch protection apply. The base may advance
                concurrently; GitHub does not offer an atomic base lock.
              </p>
              <div className="cluster">
                <button className="btn" disabled={busy} onClick={() => setConfirm('')}>
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
                      setConfirm('');
                      seen.current.delete(p.proposalId);
                      await reload();
                    })
                  }
                >
                  Confirm merge
                </button>
              </div>
            </div>
          ) : (
            <div>
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={() => setConfirm(p.proposalId)}
              >
                Merge reviewed proposal…
              </button>
            </div>
          ))}
        {p.pull && (
          <div className="pr-line">
            <a className="pr-out cluster" href={p.pull.url} target="_blank" rel="noreferrer">
              Open on GitHub
              <ExternalIcon size={14} />
            </a>
          </div>
        )}
        <details className="pr-details">
          <Summary>Details</Summary>
          <KV
            rows={[
              ['Repository', p.repository],
              ['Reviewed head', <Short value={p.headOid} />],
              [p.merge ? 'Base at merge' : 'Base', <Short value={d?.pull.base.sha ?? p.baseOid} />],
              !!p.pull?.mergeCommitSha && ['Merge commit', <Short value={p.pull.mergeCommitSha} />],
              ['Manifest SHA-256', <Short value={p.manifestHash} />],
              ['Published branch', <span className="mono">{p.branch}</span>],
            ]}
          />
        </details>
      </article>
    );
  };
  return (
    <section className="stack" aria-label="Pull requests">
      <div className="cluster cluster--between">
        <h2 className="section-title">
          Pull requests <span className="section-n">{rows.length}</span>
        </h2>
        {!!rows.length && operator && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await request('/sync', {});
                await reload();
              })
            }
          >
            Sync with GitHub
          </button>
        )}
      </div>
      {operator && controls && <Canary controls={controls} onDone={onControlled} />}
      {(error || failed) && <p role="alert">{error || failed}</p>}
      {rows.length > 0 && <div className="rows">{rows.map(row)}</div>}
    </section>
  );
}
