import { personName } from '@merv/contracts/text';
import { permits } from '@merv/scope/rules';
import type { UiRowDescription } from '@merv/ui/rows';
import { useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useTool } from '../api';
import { useCommand } from '../mutations';
import { EmptyState, KV, LoadState, Ruled, StatusPill, Summary, col, cx } from '../components';
import { ThreeStates } from '../states';
import type { PluginState } from '../shell-types';
import { useSession } from '../session';
import { GitHubConnection } from './github';
import { KeysPanel } from './keys';
import { HuggingFaceSettings } from './huggingface';
import { NeedsAccount, PeopleView } from './people';
import { ProjectIntroduction } from './project-context';
import type { ViewProps } from './index';

/**
 * Everything a project is configured with, in one place and in one order: what
 * the project is about, who may open it, the keys their agents carry, what it is
 * connected to, what is running it, and this session. The sub-navigation is the
 * page's own left column — hairline, no boxes — and every section keeps the
 * reads and mutations it already had.
 */

/** What a mount reports about itself, as the mounts row's own read returns it. */
interface Mount {
  id: string;
  origin: string;
  state: string;
  toolCount: number;
  errorCode?: string;
}

const SECTIONS = [
  ['', 'Introduction'],
  ['members', 'Members'],
  ['integrations', 'Integrations'],
  ['keys', 'Keys'],
  ['connections', 'Connections'],
  ['machines', 'Machines'],
  ['plugins', 'Plugins'],
  ['session', 'Session'],
] as const;

/** How a whole table stands, as one state word: every entry well, or how many are not. */
function Health({
  well,
  ill,
  unwell,
  failed = 0,
}: {
  well: string;
  ill: string;
  unwell: number;
  failed?: number;
}) {
  const tone = failed ? 'bad' : unwell ? 'warn' : 'ok';
  return (
    <span className={`status status--${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {failed ? `${failed} failed` : unwell ? `${unwell} ${ill}` : well}
    </span>
  );
}

/**
 * A table that is diagnostics, folded: the summary says what it holds, how many,
 * and how they stand, which is all a person needs until something is wrong. It
 * opens itself when something is.
 */
function Fold({
  title,
  count,
  health,
  open,
  children,
}: {
  title: string;
  count: number;
  health: ReactNode;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <details className="fold" open={open}>
      {/* Real spaces between the three, so they are heard as a name, a number and a state. */}
      <Summary>
        <h2 className="section-title">{title}</h2> <span className="section-n">{count}</span>{' '}
        {health}
      </Summary>
      {children}
    </details>
  );
}

/** What is not well is read first, in whichever table it stands. */
const unwellFirst = <T,>(items: T[], well: (item: T) => boolean): T[] =>
  [...items].sort((a, b) => Number(well(a)) - Number(well(b)));

function Plugins({ shell }: ViewProps) {
  const active = (plugin: PluginState) => plugin.state === 'active';
  const ready = (row: UiRowDescription) => (row.status.state ?? 'ready') === 'ready';
  const off = shell.plugins.filter((plugin) => !active(plugin));
  const failed = off.filter((plugin) => plugin.state === 'failed').length;
  const degraded = shell.rows.filter((row) => !ready(row)).length;
  return (
    <div className="page-stage">
      {shell.plugins.length > 0 && (
        <Fold
          title="Plugins"
          count={shell.plugins.length}
          open={off.length > 0}
          health={
            <Health
              well="all active"
              ill="not active"
              unwell={off.length - failed}
              failed={failed}
            />
          }
        >
          {/* How an entry stands is what the table is for, so it is never the column a
              narrow page loses: under a phone's width each fact stands under the last. */}
          <Ruled<PluginState>
            label="Plugins"
            template="minmax(0, 1fr) minmax(0, 1.6fr) 120px"
            rows={unwellFirst(shell.plugins, active)}
            keyOf={(plugin) => plugin.id}
            columns={[
              col('id', 'Entry', (p) => <strong className="mono">{p.id}</strong>),
              col('name', 'Module', (p) => <span className="mono faint">{p.name}</span>),
              col('state', 'State', (p) => <StatusPill value={p.state} />),
            ]}
          />
        </Fold>
      )}
      <Fold
        title="Sidebar rows"
        count={shell.rows.length}
        open={degraded > 0}
        health={<Health well="all ready" ill="degraded" unwell={degraded} />}
      >
        <Ruled<UiRowDescription>
          label="Sidebar rows"
          template="minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr) 120px"
          rows={unwellFirst(shell.rows, ready)}
          keyOf={(row) => row.id}
          columns={[
            col('label', 'Row', (row) => <strong>{row.label}</strong>),
            col('group', 'Group', (row) => row.group),
            col('kind', 'View kind', (row) => <span className="mono faint">{row.view.kind}</span>),
            col('status', 'Status', (row) => <StatusPill value={row.status.state ?? 'ready'} />),
          ]}
        />
      </Fold>
    </div>
  );
}

interface TokenLimit {
  tokens: number;
  /** The most they may set: the platform's cap for them. */
  cap: number;
  usedToday: number;
  /** Fleet's own judgement of the day: it holds new work while this stands. */
  blocked?: boolean;
  resetsAt?: string;
}

/** A person's own daily limit of Fleet workers' model tokens, and what they used today. */
function DailyTokens({ limit, reload }: { limit: TokenLimit; reload(): void }) {
  const [draft, setDraft] = useState<string>();
  const save = useCommand<{ tokens: number }>({
    tool: 'fleet.daily_tokens',
    idempotent: true,
    validate: (value) => Number.isSafeInteger(value?.tokens),
    onSuccess: () => {
      setDraft(undefined);
      reload();
    },
  });
  const value = draft ?? String(limit.tokens);
  const tokens = Number(value);
  return (
    <form
      className="cluster"
      onSubmit={(event) => {
        event.preventDefault();
        void save.submit({ tokens });
      }}
    >
      <input
        className="input"
        type="number"
        aria-label="Fleet tokens per day"
        min={1}
        max={limit.cap}
        step={1}
        value={value}
        // While a save's result is unknown its retry sends that number again, so it stays put.
        disabled={save.locked}
        onChange={(event) => setDraft(event.target.value)}
      />
      <span className="muted">{limit.usedToday.toLocaleString()} used today</span>
      {limit.blocked && (
        <span role="status">
          Your daily tokens are used up, so Fleet holds new work: it resumes at the reset, or once
          you change your limit.
          {limit.resetsAt && ` Usage resets at ${limit.resetsAt} (UTC).`}
        </span>
      )}
      <button
        className="btn"
        disabled={
          save.busy ||
          (!save.retry &&
            (!Number.isSafeInteger(tokens) || tokens < 1 || value === String(limit.tokens)))
        }
      >
        {save.retry ? 'Retry' : 'Save'}
      </button>
      {save.error && <span role="alert">{save.error}</span>}
    </form>
  );
}

interface MachineLimit {
  machines: number;
  default: number;
  max: number;
}

/** How many Fleet machines the project runs at once; its administrators change it. */
function Machines() {
  const { actor } = useSession();
  const limit = useTool<MachineLimit>('fleet.project_limit');
  const [draft, setDraft] = useState<string>();
  const save = useCommand<{ machines: number }>({
    tool: 'fleet.project_limit',
    idempotent: true,
    validate: (value) => Number.isSafeInteger(value?.machines),
    onSuccess: () => {
      setDraft(undefined);
      limit.reload();
    },
  });
  if (limit.error && !limit.data) return <Nothing icon="settings" said="No machines" />;
  if (!limit.data) return <LoadState {...limit} />;
  const editable = permits(actor.role, 'admin');
  const value = draft ?? String(limit.data.machines);
  const machines = Number(value);
  const valid = Number.isSafeInteger(machines) && machines >= 1 && machines <= limit.data.max;
  return (
    <div className="page-stage stack">
      <KV
        rows={[
          [
            'At once',
            editable ? (
              <form
                className="cluster"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save.submit({ machines });
                }}
              >
                <input
                  className="input"
                  type="number"
                  aria-label="Machines at once"
                  min={1}
                  max={limit.data.max}
                  step={1}
                  value={value}
                  disabled={save.locked}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button
                  className="btn"
                  disabled={
                    save.busy || (!save.retry && (!valid || value === String(limit.data.machines)))
                  }
                >
                  {save.retry ? 'Retry' : 'Save'}
                </button>
                {save.error && <span role="alert">{save.error}</span>}
              </form>
            ) : (
              <span className="tabular">{limit.data.machines}</span>
            ),
          ],
        ]}
      />
    </div>
  );
}

/** The signed-in session, and the one control that ends it. */
function SessionSection() {
  const { account, actor, project, signOut } = useSession();
  // Without Fleet there is no limit to read, so the row is left out.
  const limit = useTool<TokenLimit>(account.kind === 'user' ? 'fleet.daily_tokens' : null);
  return (
    <div className="page-stage stack">
      <KV
        rows={[
          ['Project', project.name],
          // A directory name that is an identifier names nobody, so the row is left out.
          !!personName(actor.name) && ['Name', actor.name],
          ['Role', <StatusPill value={actor.role} />],
          !!limit.data && [
            'Fleet tokens a day',
            <DailyTokens limit={limit.data} reload={limit.reload} />,
          ],
        ]}
      />
      {account.kind === 'user' && <HuggingFaceSettings />}
      <div>
        <button type="button" className="btn" onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}

/** A room with nothing in it: the glyph of what would be here, and a few words. */
const Nothing = ({ icon, said }: { icon: string; said: string }) => (
  <div className="page-stage">
    <EmptyState kind="settings" icon={icon} title={said} />
  </div>
);

/** The rooms that belong to a person's account, and so to no bearer credential. */
const PERSONAL = ['members', 'keys'];

/** Machine keys, read where every other setting is; the account menu only signs out. */
function Keys() {
  const { account, project } = useSession();
  if (account.kind !== 'user')
    return <NeedsAccount icon="key" said="Sign in with an account to make keys" />;
  return <KeysPanel account={account} initialProjectId={project.id} />;
}

/**
 * What this project works with outside Merv: today the one GitHub repository,
 * its connection and the access its agents have in it. The Code page draws what
 * that connection produced; everything that configures it is here.
 */
export function Integrations({ shell }: ViewProps) {
  const code = shell.rows.some((row) => row.view.kind === 'code');
  const { account } = useSession();
  return (
    <div className="page-stage stack stack--lg">
      {code && <GitHubConnection connects={account.kind === 'user'} />}
      {!code && <EmptyState kind="settings" icon="link" title="No integrations" />}
    </div>
  );
}

/**
 * What this server is connected to: the mounts an operator configured, each with
 * the health its own row reports. A mount that is still connecting is the only
 * thing here that moves, so the read slows down once they have all settled.
 */
function Connections({ shell }: ViewProps) {
  const row = shell.rows.find((entry) => entry.view.kind === 'connections');
  const mounts = useTool<Mount[]>(
    row ? 'ui.read' : null,
    { rowId: row?.id ?? '' },
    {
      every: (data) => (!data || data.some((mount) => mount.state === 'connecting') ? 4000 : 15000),
    },
  );
  if (!row || (mounts.data && !mounts.data.length))
    return <Nothing icon="connections" said="No connections" />;
  return (
    <div className="page-stage stack">
      <LoadState {...mounts} />
      <ul className="rows">
        {(mounts.data ?? []).map((mount) => (
          <li className="row" key={mount.id}>
            <span className="row-name">
              <strong className="mono">{mount.origin}</strong>
            </span>
            <ThreeStates
              execution={mount.state}
              meta={
                <>
                  <span className="tabular">{mount.toolCount}</span> tools
                  {mount.errorCode ? <span className="mono"> · {mount.errorCode}</span> : ''}
                </>
              }
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SettingsView(props: ViewProps) {
  const { pathname } = useLocation();
  const { account } = useSession();
  const base = props.row.path;
  // A room this sign-in can never use is not a place to send it.
  const rooms = SECTIONS.filter(([slug]) => account.kind === 'user' || !PERSONAL.includes(slug));
  return (
    <div className="split settings">
      <nav className="split-list" aria-label="Settings">
        {rooms.map(([slug, label]) => {
          const to = slug ? `${base}/${slug}` : base;
          return (
            <Link
              key={label}
              to={to}
              className={cx('rail-row', pathname === to && 'active')}
              aria-current={pathname === to ? 'page' : undefined}
            >
              <span className="rail-row-label">{label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="split-record">
        <Routes>
          <Route
            index
            element={
              <div className="page-stage">
                <ProjectIntroduction />
              </div>
            }
          />
          <Route path="members" element={<PeopleView />} />
          <Route path="integrations" element={<Integrations {...props} />} />
          <Route path="keys" element={<Keys />} />
          <Route path="connections" element={<Connections {...props} />} />
          <Route path="machines" element={<Machines />} />
          <Route path="plugins" element={<Plugins {...props} />} />
          <Route path="session" element={<SessionSection />} />
          <Route path="*" element={<Navigate to="." replace />} />
        </Routes>
      </div>
    </div>
  );
}
