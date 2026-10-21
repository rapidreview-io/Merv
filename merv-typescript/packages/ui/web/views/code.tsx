import type { CodeCommandRecord } from '@merv/contracts/code';
import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { permits } from '@merv/scope/rules';
import { useTool, type Actor } from '../api';
import { EmptyState, LoadState, PageLoad, Short, StatusPill } from '../components';
import { recordNames, type NamedHome } from '../markdown';
import { useSession } from '../session';
import { usePageFacts } from '../shell';
import { BranchCanvas } from './code-canvas';
import { CodeFiles } from './code-files';
import { CodeCard, CodeOperations, type Reader } from './code-card';
import { MAIN, chipsOf, gitModel } from './code-model';
import { UnitCode } from './code-section';
import { CodeIntegrations } from './code-integrations';
import type { ViewProps } from './index';
import { useActorNames } from './people';
import type { CodeProjectStatus } from '@merv/code-work/models';

/** What the address says is selected. A base is named by the one digest nothing prints. */
const addressed = (pathname: string, root: string): string | null => {
  const [kind, value] = pathname.slice(root.length).split('/').filter(Boolean);
  return (kind === 'merge' || kind === 'unit') && value ? decodeURIComponent(value) : null;
};

/**
 * What main holds, under its name: what landed on it and what waits, once Code reports landing
 * (founder, 2026-10-11: accepted work lands on main); until then, that accepted work lands there.
 */
function mainSaid(status: CodeProjectStatus | undefined): string {
  const landing = status?.landing;
  if (!landing) return 'Accepted work lands here';
  const landed = landing.landed.filter((row) => !['skipped', 'superseded'].includes(row.outcome));
  const waiting = landing.waiting.length + (landing.current ? 1 : 0);
  return `${landed.length} landed${waiting ? ` · ${waiting} waiting to land` : ''}`;
}

/** A count not yet read is the em dash the console uses, never a zero. */
const EM = '—';

export function CodePage({ row, shell, manages, administers }: ViewProps & Omit<Reader, 'named'>) {
  const named = useActorNames();
  const read = useTool<{
    commands: CodeCommandRecord[];
    status?: CodeProjectStatus;
  }>('ui.read', { rowId: row.id }, { every: 10_000 });
  // Names change rarely, so the lists that hold them are read once and never polled.
  const home = useTool<NamedHome>('ui.home');
  const published = read.data?.status?.publication?.records ?? [];
  const branch = 'merv-main';
  // The model is rebuilt only when something it is made of answers again, so the ten-second
  // poll costs a render and not a re-derivation of the whole project.
  const { model, names } = useMemo(() => {
    const names = new Map(recordNames(null, home.data, shell.rows));
    if (branch) names.set(MAIN, { name: branch });
    return {
      model: gitModel(read.data?.status, read.data?.commands ?? [], published, names),
      names,
    };
  }, [read.data, home.data, branch, shell.rows]);
  const merges = model.nodes.filter((node) => node.kind === 'base').length;
  const bare = !read.error && !read.loading && !read.data?.status?.project && !model.lanes.length;
  // The counts stand on the line the shell titles the page with, beside its name.
  usePageFacts(
    bare
      ? []
      : [
          ['Work histories', read.data ? model.lanes.length : EM],
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
          : `${row.path}/history`;
    setHeld(to === `${row.path}/history` ? id : null);
    if (to !== pathname) navigate(to, { replace: true });
  };

  const chips = useMemo(
    () => chipsOf(read.data?.status?.blockers ?? [], model),
    [read.data, model],
  );
  const [chip, setChip] = useState<string | null>(null);
  const lit = chips.find((item) => item.label === chip)?.lights ?? null;

  if (read.loading) return <PageLoad loading />;
  if (bare)
    return (
      <div className="page-stage">
        <EmptyState kind="code" title="Repository initializing" />
      </div>
    );
  const card = selected
    ? ({ head }: { head: boolean }) => (
        <CodeCard
          id={selected}
          model={model}
          status={read.data?.status}
          publications={published}
          names={names}
          head={head}
          onDone={read.reload}
          manages={manages}
          administers={administers}
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
      <LoadState {...read} />
      {model.lanes.length === 0 && read.data?.status?.project && (
        <p className="cluster" aria-label="Managed main">
          <span className="branch">merv-main</span>
          <Short value={read.data.status.project.main.oid} />
          <StatusPill value={read.data.status.project.main.stored ? 'ready' : 'initializing'} />
        </p>
      )}
      {model.lanes.length > 0 && (
        <div className="code-plane">
          <BranchCanvas
            model={model}
            selected={selected}
            onSelect={select}
            lit={lit}
            card={card}
            mainSaid={mainSaid(read.data?.status)}
          />
        </div>
      )}
      <CodeIntegrations
        rows={published}
        onDone={read.reload}
        operator={administers}
        named={named}
      />
      <CodeOperations status={read.data?.status} manages={manages} onDone={read.reload} />
    </div>
  );
}

/**
 * Code's own machinery — the base verbs and the blocked ref — answers a project administrator
 * who is not a leased worker. A worker's lease is not an account credential and never reaches
 * this page, so the role is the whole of the test.
 */
export const managesCode = (actor: Actor) => permits(actor.role, 'admin');
/**
 * Fencing a writer and every publication control answer an administrator who is a member (the
 * person, their key, their conversation), never a machine operator: the server's
 * requireAdministrator, drawn by the same rule.
 */
export const administersCode = (actor: Actor) => managesCode(actor) && !!actor.user;

/**
 * A record's Code section. The publication verbs answer a project administrator and nobody
 * else, so it is told who is reading before it offers the move.
 */
export function RecordCode(props: Pick<Parameters<typeof UnitCode>[0], 'unit' | 'named'>) {
  const { actor } = useSession();
  return <UnitCode {...props} manages={administersCode(actor)} />;
}

export const CodeView = (props: ViewProps) => {
  const { actor } = useSession();
  const { pathname } = useLocation();
  const root = props.row.path;
  const rest = pathname.slice(root.length);
  // The repository is what a reader opens first; how the work made it is History, which
  // keeps its own addresses for what is selected in it.
  const files = rest === '' || rest === '/' || /^\/(tree|blob)(\/|$)/.test(rest);
  return (
    <>
      {/* Files and History: whose code it is as a repository, and how the work made it. */}
      <div className="page-stage code-switch-stage">
        <nav className="code-switch" aria-label="Code">
          <Link to={root} aria-current={files ? 'page' : undefined}>
            Files
          </Link>
          <Link to={`${root}/history`} aria-current={files ? undefined : 'page'}>
            History
          </Link>
        </nav>
      </div>
      {files ? (
        <div className="page-stage">
          <CodeFiles {...props} root={root} />
        </div>
      ) : (
        <CodePage {...props} manages={managesCode(actor)} administers={administersCode(actor)} />
      )}
    </>
  );
};
