import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { accountRequest, useScopeVersion, useTool } from '../api';
import { LoadState } from '../components';
import type { CodeCommandRecord } from '@merv/contracts/code';
import type { GitHubStatus } from '@merv/contracts/types';
import type { ViewProps } from './index';
import { BranchGraph, type GraphProposal } from './code-graph';
import { GitHubPublications, status, usePublications } from './github-publications';
import type { MapExperiment } from './map-data';

/**
 * Code: the branches Merv made, and the pull requests they became. Nothing
 * else — the connection and its automation are settings, and the diff, the
 * conversation and the commit list belong to GitHub. Lanes are named by the
 * records that own them, which is why this page reads the experiments too.
 */

/** The one connection this project has, read for the base branch and for whether there is one. */
function useGitHubStatus() {
  const epoch = useScopeVersion();
  const [connection, setConnection] = useState<GitHubStatus>();
  useEffect(() => {
    let live = true;
    void accountRequest<GitHubStatus>('/code/github', { scoped: true, credentials: 'same-origin' })
      .then((value) => live && setConnection(value))
      .catch(() => live && setConnection(undefined));
    return () => {
      live = false;
    };
  }, [epoch]);
  return connection;
}

export function CodeView({ row, shell }: ViewProps) {
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
  const github = useGitHubStatus();
  const published = usePublications();
  const names = new Map(
    (experiments.data ?? []).map((item) => [
      item.id,
      { name: item.name, state: item.workflow.state },
    ]),
  );
  const commands = read.data?.operations ?? [];
  const proposals = read.data?.proposals ?? [];
  return (
    <div className="page-stage stack stack--lg">
      {github && (github.status === 'disconnected' || !github.repository) && (
        <p className="muted">
          GitHub not connected · <Link to="/settings/integrations">Connect</Link>
        </p>
      )}
      <section className="stack">
        <h2 className="section-title">Branches</h2>
        <LoadState loading={read.loading} error={read.error} data={read.data} />
        {!read.loading && !commands.length && !proposals.length ? (
          <p className="muted">No branches yet</p>
        ) : (
          <BranchGraph
            commands={commands}
            proposals={proposals}
            publications={published.rows}
            nameOf={(id) => names.get(id)}
            stateOf={(id) => {
              const found = published.rows.find((entry) => entry.proposalId === id);
              return found ? status(found) : 'sealed';
            }}
            baseBranch={github?.baseBranch ?? github?.repository?.defaultBranch ?? null}
          />
        )}
      </section>
      <GitHubPublications rows={published.rows} error={published.error} reload={published.reload} />
    </div>
  );
}
