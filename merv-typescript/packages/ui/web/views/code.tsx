import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { accountRequest, useScopeVersion, useTool } from '../api';
import { EmptyState, LoadState, StatusPill } from '../components';
import type { CodeCommandRecord } from '@merv/contracts/code';
import type { GitHubStatus } from '@merv/contracts/types';
import { useSession } from '../session';
import type { ViewProps } from './index';
import { BranchGraph, lanes, type GraphInput, type GraphProposal } from './code-graph';
import { GitHubPublications, status, usePublications } from './github-publications';
import type { MapExperiment } from './map-data';
import { useActorNames } from './people';

/**
 * Code: the branches Merv made, and the pull requests they became. Nothing
 * else — the connection and its automation are settings, and the diff, the
 * conversation and the commit list belong to GitHub. Lanes are named by the
 * records that own them, which is why this page reads the experiments too.
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
  const read = useTool<{ operations: CodeCommandRecord[]; proposals: GraphProposal[] }>(
    'ui.read',
    { rowId: row.id },
    { every: 10_000 },
  );
  const experiments = useTool<MapExperiment[]>(
    shell.rows.some((entry) => entry.view.kind === 'experiments') ? 'experiment.list' : null,
    {},
    { every: 30_000 },
  );
  const { connection: github, settled } = useGitHubStatus();
  const published = usePublications();
  const names = new Map(
    (experiments.data ?? []).map((item) => [
      item.id,
      { name: item.name, state: item.workflow.state },
    ]),
  );
  const graph: GraphInput = {
    commands: read.data?.operations ?? [],
    proposals: read.data?.proposals ?? [],
    publications: published.rows,
    nameOf: (id) => names.get(id),
    stateOf: (id) => {
      const found = published.rows.find((entry) => entry.proposalId === id);
      return found ? status(found) : 'sealed';
    },
    baseBranch: github?.baseBranch ?? github?.repository?.defaultBranch ?? null,
  };
  // The heading counts what the graph draws, and a branch no record names is not drawn.
  const branches = lanes(graph, 1000)?.lanes.length ?? 0;
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
  if (unlinked && !read.error && !branches && !published.rows.length)
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
      {/* What Merv made outlives the connection it was made over, so it stays on the
          page; the connection's own state is a pill and the way to mend it. */}
      {unlinked && (
        <p className="cluster">
          <StatusPill value={github.status === 'disconnected' ? 'disconnected' : 'no repository'} />
          {mends && connect(label)}
        </p>
      )}
      <section className="stack">
        <h2 className="section-title">
          Branches <span className="section-n">{read.data ? branches : '—'}</span>
        </h2>
        <LoadState loading={read.loading} error={read.error} data={read.data} />
        {branches > 0 && <BranchGraph {...graph} />}
      </section>
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
