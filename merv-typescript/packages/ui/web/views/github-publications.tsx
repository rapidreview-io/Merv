import type { GitHubPullDetails } from '@merv/contracts/types';
import type { CodePublication, CodeProjectStatus } from '@merv/code-work/models';
import { useEffect, useRef, useState } from 'react';
import { call, useScopeVersion } from '../api';
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
import { useCommand, useCurrent } from '../mutations';

/**
 * A sealed proposal, published: one row per pull request, in the grammar GitHub
 * made standard — the state word, what merged into what, the diffstat, the
 * independent verdict that gated it, and the checks. The diff, the conversation
 * and the commit list are GitHub's and stay there, one link away; Details holds
 * the machine text and is the only place an identifier is printed.
 */

type Controls = NonNullable<CodeProjectStatus['publication']>['controls'];

/**
 * The release canary as the signed-in operator who ran it attests it: whether GitHub let
 * a deliberately stale merge through. Publication waits on a passing one; a failed one
 * stops it until a later pass and an explicit clear, which is offered only then. A press
 * whose answer never came is the only one left, and only as its retry: another would
 * resend it unchanged under a different label.
 */
function Canary({ controls, onDone }: { controls: Controls; onDone(): void }) {
  const [reason, setReason] = useState<string>();
  const [sent, setSent] = useState('');
  const command = useCommand<unknown>({
    tool: 'code.publication.control',
    validate: (value) => !!value && typeof value === 'object',
    onSuccess: () => {
      setReason(undefined);
      onDone();
    },
  });
  const { canary } = controls;
  const act = (label: string, input: Record<string, unknown>) =>
    (!command.retry || sent === label) && (
      <button
        className="btn"
        disabled={command.busy || !reason?.trim()}
        onClick={() => {
          setSent(label);
          void command.submit({ ...input, reason });
        }}
      >
        {command.retry ? 'Retry same request' : label}
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
          <Area
            label="Evidence"
            value={reason}
            onChange={setReason}
            rows={3}
            disabled={command.locked}
          />
          <Failure message={command.error} />
          <div className="cluster">
            {act('Stale merge refused', { action: 'record_canary', staleMerged: false })}
            {act('Stale merge went through', { action: 'record_canary', staleMerged: true })}
            {(command.retry || (controls.disabled && canary && !canary.staleMerged)) &&
              act('Clear disablement', { action: 'clear' })}
            <button className="btn" disabled={command.locked} onClick={() => setReason(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** One reviewed head and observed base are one merge intent. A changed pin remounts this
 * control, while an uncertain response keeps the original request id and all its arguments. */
function MergeGuard({
  publication,
  base,
  busy,
  onMerged,
}: {
  publication: CodePublication;
  base: string;
  busy: boolean;
  onMerged(): void;
}) {
  const [confirm, setConfirm] = useState(false);
  const command = useCommand<CodePublication>({
    tool: 'code.publication.merge',
    validate: (value) =>
      value?.proposalId === publication.proposalId && !!(value.pull?.merged || value.stale),
    onSuccess: () => {
      setConfirm(false);
      onMerged();
    },
  });
  if (!confirm)
    return (
      <button className="btn btn--primary" disabled={busy} onClick={() => setConfirm(true)}>
        Merge reviewed proposal…
      </button>
    );
  return (
    <div role="alertdialog" aria-label="Confirm reviewed merge" className="pr-guard stack">
      <p>
        Merge <Short value={publication.headOid} /> into <strong>{publication.baseBranch}</strong>{' '}
        using a merge commit? GitHub checks and branch protection apply. The base may advance
        concurrently; GitHub does not offer an atomic base lock.
      </p>
      <Failure message={command.error} />
      <div className="cluster">
        {!command.retry && (
          <button className="btn" disabled={busy || command.busy} onClick={() => setConfirm(false)}>
            Cancel
          </button>
        )}
        <button
          className="btn btn--primary"
          disabled={busy || command.busy}
          onClick={() =>
            void command.submit({
              proposalId: publication.proposalId,
              expectedHead: publication.headOid,
              expectedBase: base,
            })
          }
        >
          {command.retry ? 'Retry same request' : 'Confirm merge'}
        </button>
      </div>
    </div>
  );
}

export function GitHubPublications({
  rows,
  onDone,
  operator,
  named,
  controls,
}: {
  rows: CodePublication[];
  onDone(): void;
  /** True where the reader may sync and merge: an operator signed in as a person. */
  operator: boolean;
  /** Who reviewed and who merged, by name; nobody is named by an identifier. */
  named(id: string | null | undefined): string | undefined;
  /** Where the project publishes at all: what its merges wait on besides a review. */
  controls?: Controls;
}) {
  const epoch = useScopeVersion();
  const current = useCurrent();
  const [details, setDetails] = useState<Record<string, GitHubPullDetails | null>>({});
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState(false);
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    seen.current = new Map();
    setDetails({});
    setFailed('');
  }, [epoch]);
  // A pull request is read once, and again only when GitHub says it changed.
  useEffect(() => {
    for (const p of rows) {
      const key = p.pull?.updatedAt;
      if (!key || seen.current.get(p.proposalId) === key) continue;
      seen.current.set(p.proposalId, key);
      void call<{ details: GitHubPullDetails | null }>('code.publication.read', {
        proposalId: p.proposalId,
      })
        .then((value) => {
          if (current()) setDetails((all) => ({ ...all, [p.proposalId]: value.details }));
        })
        .catch((e: unknown) => {
          if (current())
            setFailed(e instanceof Error ? e.message : 'A pull request could not be read');
        });
    }
  }, [rows, current]);
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFailed('');
    try {
      await fn();
    } catch (e) {
      if (current())
        setFailed(e instanceof Error ? e.message : 'GitHub did not confirm the operation');
    } finally {
      if (current()) setBusy(false);
    }
  };
  const row = (p: CodePublication) => {
    const d = details[p.proposalId] ?? null;
    const local = p.destination === 'local';
    const merged = !!p.pull?.merged || (local && !!p.verified);
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
          <StatusPill value={p.state} />
        </div>
        <div className="pr-line">
          <span>
            {local ? (merged ? 'Integrated' : 'Integrates') : merged ? 'Merged' : 'Merges'}
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
                <span>
                  {local ? 'integrated' : 'merged'} by {merger}
                </span>
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
        {d && !merged && d.pull.mergeState !== 'clean' && (
          <div className="pr-line">
            <span>Merge state</span>
            <StatusPill value={d.pull.mergeState} />
          </div>
        )}
        {p.lastError && <p role="alert">{words(p.lastError)}</p>}
        {gate && (
          <MergeGuard
            key={JSON.stringify([p.proposalId, p.headOid, d.pull.base.sha])}
            publication={p}
            base={d.pull.base.sha}
            busy={busy}
            onMerged={() => {
              seen.current.delete(p.proposalId);
              onDone();
            }}
          />
        )}
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
              ['Repository', p.destination === 'local' ? 'Merv managed Git' : p.repository],
              ['Reviewed head', <Short value={p.headOid} />],
              [p.merge ? 'Base at merge' : 'Base', <Short value={d?.pull.base.sha ?? p.baseOid} />],
              !!p.pull?.mergeCommitSha && ['Merge commit', <Short value={p.pull.mergeCommitSha} />],
              ['Manifest SHA-256', <Short value={p.manifestHash} />],
              [
                local ? 'Retained ref' : 'Published branch',
                <span className="mono">
                  {local ? `refs/merv/proposals/${p.proposalId}` : p.branch}
                </span>,
              ],
            ]}
          />
        </details>
      </article>
    );
  };
  return (
    <section className="stack" aria-label="Integrations">
      <div className="cluster cluster--between">
        <h2 className="section-title">
          Integrations <span className="section-n">{rows.length}</span>
        </h2>
        {!!rows.length && operator && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await call('code.publication.sync');
                onDone();
              })
            }
          >
            Refresh integrations
          </button>
        )}
      </div>
      {operator && controls && <Canary controls={controls} onDone={onDone} />}
      {failed && <p role="alert">{failed}</p>}
      {rows.length > 0 && <div className="rows">{rows.map(row)}</div>}
    </section>
  );
}
