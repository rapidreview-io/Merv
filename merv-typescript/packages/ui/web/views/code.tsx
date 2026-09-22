import type { CodeCommandRecord, CodeProjectStatus } from '@merv/contracts/code';
import type { GitHubStatus } from '@merv/contracts/types';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { accountRequest, useScopeVersion, useTool, type Account, type Actor } from '../api';
import { EmptyState, LoadState, StatusPill } from '../components';
import { recordNames, type NamedHome } from '../markdown';
import { useSession } from '../session';
import { usePageFacts } from '../shell';
import { BranchCanvas } from './code-canvas';
import { CodeCard, CodeOperations, type Reader } from './code-card';
import { MAIN, chipsOf, gitModel } from './code-model';
import { GitHubPublications, usePublications } from './github-publications';
import type { ViewProps } from './index';
import { useActorNames } from './people';

/**
 * Code: the branches Merv made drawn as one picture, and the pull requests they
 * became listed under it. Nothing else — the connection and its automation are
 * settings, and the diff, the conversation and the commit list belong to GitHub.
 * Lanes are named by the records that own them, from the lists the app already
 * reads, so a task, a resolution task and a consolidation are as visible as an
 * experiment and no generated ref reaches the page.
 *
 * Which node is selected is the address: `/code/merge/<key>` and `/code/unit/<id>`
 * are this page with that node in hand, not a second view. Nothing remounts when
 * the address changes, so a half-open guard survives a selection made beside it.
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

/** What the address says is selected. A base is named by the one digest nothing prints. */
const addressed = (pathname: string, root: string): string | null => {
  const [kind, value] = pathname.slice(root.length).split('/').filter(Boolean);
  return (kind === 'merge' || kind === 'unit') && value ? decodeURIComponent(value) : null;
};

/** A count not yet read is the em dash the console uses, never a zero. */
const EM = '—';

export function CodePage({ row, shell, manages, signedIn, named }: ViewProps & Reader) {
  const read = useTool<{ commands: CodeCommandRecord[]; status?: CodeProjectStatus }>(
    'ui.read',
    { rowId: row.id },
    { every: 10_000 },
  );
  // Names change rarely, so the lists that hold them are read once and never polled.
  const home = useTool<NamedHome>('ui.home');
  const { connection: github, settled } = useGitHubStatus();
  const published = usePublications();
  const branch = github?.baseBranch ?? github?.repository?.defaultBranch ?? null;
  // The model is rebuilt only when something it is made of answers again, so the ten-second
  // poll costs a render and not a re-derivation of the whole project.
  const { model, names } = useMemo(() => {
    const names = new Map(recordNames(null, home.data));
    if (branch) names.set(MAIN, { name: branch });
    return {
      model: gitModel(read.data?.status, read.data?.commands ?? [], published.rows, names),
      names,
    };
  }, [read.data, home.data, published.rows, branch]);
  const merges = model.nodes.filter((node) => node.kind === 'base').length;
  const unlinked = !!github && (github.status === 'disconnected' || !github.repository);
  // With no repository and nothing Merv made, the page has one thing to say and one
  // thing to offer, and counts nothing.
  const bare = unlinked && !read.error && !model.lanes.length && !published.rows.length;
  // The counts stand on the line the shell titles the page with, beside its name.
  usePageFacts(
    bare || !settled
      ? []
      : [
          ['Branches', read.data ? model.lanes.length : EM],
          ['Merges', read.data ? merges : EM],
        ],
  );

  // The address holds what it can name; the trunk and a publication are held here, so
  // that one selection is one thing wherever the reader made it.
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [held, setHeld] = useState<string | null>(null);
  const selected = addressed(pathname, row.path) ?? held;
  const select = (id: string | null) => {
    const kind = id ? model.nodes.find((node) => node.id === id)?.kind : undefined;
    const to =
      id && kind === 'base'
        ? `${row.path}/merge/${encodeURIComponent(id)}`
        : id && kind === 'unit'
          ? `${row.path}/unit/${encodeURIComponent(id)}`
          : row.path;
    setHeld(to === row.path ? id : null);
    if (to !== pathname) navigate(to, { replace: true });
  };

  const chips = useMemo(
    () => chipsOf(read.data?.status?.blockers ?? [], model),
    [read.data, model],
  );
  const [chip, setChip] = useState<string | null>(null);
  const lit = chips.find((item) => item.label === chip)?.lights ?? null;

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
  // Two empty sections under that one state would say it twice more.
  if (bare)
    return (
      <div className="page-stage">
        <EmptyState
          kind="code"
          title={github.status === 'disconnected' ? 'GitHub not connected' : 'No repository linked'}
          action={mends && connect(label, true)}
        />
      </div>
    );
  const card = selected
    ? ({ head }: { head: boolean }) => (
        <CodeCard
          id={selected}
          model={model}
          status={read.data?.status}
          publications={published.rows}
          names={names}
          head={head}
          onSelect={select}
          onDone={read.reload}
          manages={manages}
          signedIn={signedIn}
          named={named}
        />
      )
    : undefined;
  return (
    <div className="page-stage stack stack--lg">
      {/* One press keeps the drawing whole and lights only what that blocker names;
          a chip of zero is a filter with nothing behind it and is not drawn. */}
      {chips.length > 0 && (
        <div className="chips" role="group" aria-label="What is holding work up">
          {chips.map((item) => (
            <button
              type="button"
              key={item.label}
              aria-pressed={chip === item.label}
              onClick={() => setChip(chip === item.label ? null : item.label)}
            >
              {item.label} <span className="state-n">{item.count}</span>
            </button>
          ))}
        </div>
      )}
      {/* What Merv made outlives the connection it was made over, so it stays on the
          page; the connection's own state is a pill and the way to mend it. */}
      {unlinked && (
        <p className="cluster">
          <StatusPill value={github.status === 'disconnected' ? 'disconnected' : 'no repository'} />
          {mends && connect(label)}
        </p>
      )}
      <LoadState loading={read.loading} error={read.error} data={read.data} />
      {model.lanes.length > 0 && (
        <div className="code-plane">
          <BranchCanvas model={model} selected={selected} onSelect={select} lit={lit} card={card} />
        </div>
      )}
      <GitHubPublications
        rows={published.rows}
        error={published.error}
        reload={published.reload}
        operator={signedIn}
        named={named}
      />
      <CodeOperations status={read.data?.status} manages={manages} onDone={read.reload} />
    </div>
  );
}

/**
 * Code's own machinery — the base verbs and the blocked ref — answers a project
 * administrator who is not a leased worker: a signed-in person, the bearer credential
 * that is that person's own actor, or an operator key. A worker's lease is not an
 * account credential and never reaches this page, so the role is the whole of the test.
 */
export const managesCode = (actor: Actor) => actor.role === 'operator';
/**
 * Fencing a writer and every publication control ask for more than authority: their
 * tools refuse a key and a bearer actor outright and answer only a person. The two
 * rules are the server's two rules, and each verb is drawn by the one that governs it.
 */
export const signedInAdmin = (actor: Actor, account: Account) =>
  actor.role === 'operator' && account.kind === 'user';

export const CodeView = (props: ViewProps) => {
  const { actor, account } = useSession();
  return (
    <CodePage
      {...props}
      manages={managesCode(actor)}
      signedIn={signedInAdmin(actor, account)}
      named={useActorNames()}
    />
  );
};
