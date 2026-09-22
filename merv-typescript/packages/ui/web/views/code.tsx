import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { accountRequest, useScopeVersion, useTool } from '../api';
import { EmptyState, LoadState, StatusPill } from '../components';
import type { CodeCommandRecord, CodeProjectStatus } from '@merv/contracts/code';
import type { GitHubStatus } from '@merv/contracts/types';
import { recordNames, type NamedHome } from '../markdown';
import { useSession } from '../session';
import type { ViewProps } from './index';
import { BranchCanvas } from './code-canvas';
import { MAIN, gitModel } from './code-model';
import { GitHubPublications, usePublications } from './github-publications';
import { useActorNames } from './people';

/**
 * Code: the branches Merv made drawn as one picture, and the pull requests they
 * became listed under it. Nothing else — the connection and its automation are
 * settings, and the diff, the conversation and the commit list belong to GitHub.
 * Lanes are named by the records that own them, from the lists the app already
 * reads, so a task, a resolution task and a consolidation are as visible as an
 * experiment and no generated ref reaches the page.
 */

/**
 * The one connection this project has, read for the base branch and for whether
 * there is one. `settled` is true once the question has an answer, or has failed
 * to get one, so the page never draws a guess in between.
 */
function useGitHubStatus() {
  const epoch = useScopeVersion();
  const [read, setRead] = useState<{ connection?: GitHubStatus; settled: boolean }>({
    settled: false,
  });
  useEffect(() => {
    let live = true;
    setRead({ settled: false });
    void accountRequest<GitHubStatus>('/code/github', { scoped: true, credentials: 'same-origin' })
      .then((connection) => live && setRead({ connection, settled: true }))
      .catch(() => live && setRead({ settled: true }));
    return () => {
      live = false;
    };
  }, [epoch]);
  return read;
}

/** Where the connection is made: the link is the page's one control while there is none. */
const connect = (label: string, primary = false) => (
  <Link className={primary ? 'btn btn--primary' : 'btn-text'} to="/settings/integrations">
    {label}
  </Link>
);

/** Who is reading, as the two facts the page needs of them, so the page itself holds no session. */
type Reader = Pick<Parameters<typeof GitHubPublications>[0], 'operator' | 'named'>;

export function CodePage({ row, shell, ...reader }: ViewProps & Reader) {
  const read = useTool<{ commands: CodeCommandRecord[]; status?: CodeProjectStatus }>(
    'ui.read',
    { rowId: row.id },
    { every: 10_000 },
  );
  // Names change rarely, so the lists that hold them are read once and never polled.
  const home = useTool<NamedHome>('ui.home');
  const consolidations = useTool<{ id: string; name: string }[]>(
    shell.rows.some((entry) => entry.view.kind === 'consolidation') ? 'consolidation.list' : null,
  );
  const { connection: github, settled } = useGitHubStatus();
  const published = usePublications();
  const branch = github?.baseBranch ?? github?.repository?.defaultBranch ?? null;
  // The model is rebuilt only when something it is made of answers again, so the ten-second
  // poll costs a render and not a re-derivation of the whole project.
  const model = useMemo(() => {
    const names = new Map(recordNames(null, home.data));
    // A consolidation is the one kind `ui.home` does not list, and it owns lanes here.
    for (const record of consolidations.data ?? [])
      names.set(record.id, { name: record.name, to: `/consolidation/${record.id}` });
    if (branch) names.set(MAIN, { name: branch });
    return gitModel(read.data?.status, read.data?.commands ?? [], published.rows, names);
  }, [read.data, home.data, consolidations.data, published.rows, branch]);
  const merges = model.nodes.filter((node) => node.kind === 'base').length;
  const unlinked = !!github && (github.status === 'disconnected' || !github.repository);
  const label = github?.status === 'disconnected' ? 'Connect GitHub' : 'Select repository';
  // The way to Integrations is offered to whoever can do something there, as on Home:
  // a server with no GitHub app, or a reader who may not manage it, is shown no door
  // to a room that holds nothing for them.
  const mends = !!github?.configured && !!github.canManage;
  if (!settled || (unlinked && read.loading))
    return (
      <div className="page-stage">
        <LoadState loading />
      </div>
    );
  // With no repository and nothing Merv made, the page has one thing to say and
  // one thing to offer; two empty sections under it would say it twice more.
  if (unlinked && !read.error && !model.lanes.length && !published.rows.length)
    return (
      <div className="page-stage">
        <EmptyState
          kind="code"
          title={github.status === 'disconnected' ? 'GitHub not connected' : 'No repository linked'}
          action={mends && connect(label, true)}
        />
      </div>
    );
  return (
    <div className="page-stage stack stack--lg">
      {/* The shell titles this row, so the page says only what the drawing counts: a count
          of zero is a fact about the project and is drawn, and a count not yet read is the
          em dash the console uses. The pull requests are counted by their own section. */}
      <p className="code-counts">
        <span>
          Branches <b>{read.data ? model.lanes.length : '—'}</b>
        </span>
        <span>
          Merges <b>{read.data ? merges : '—'}</b>
        </span>
      </p>
      {/* What Merv made outlives the connection it was made over, so it stays on the
          page; the connection's own state is a pill and the way to mend it. */}
      {unlinked && (
        <p className="cluster">
          <StatusPill value={github.status === 'disconnected' ? 'disconnected' : 'no repository'} />
          {mends && connect(label)}
        </p>
      )}
      <LoadState loading={read.loading} error={read.error} data={read.data} />
      {model.lanes.length > 0 && <BranchCanvas model={model} />}
      <GitHubPublications
        rows={published.rows}
        error={published.error}
        reload={published.reload}
        {...reader}
      />
    </div>
  );
}

export const CodeView = (props: ViewProps) => {
  const { actor, account } = useSession();
  return (
    <CodePage
      {...props}
      operator={actor.role === 'operator' && account.kind === 'user'}
      named={useActorNames()}
    />
  );
};
