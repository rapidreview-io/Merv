import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useTool } from '../api';
import { useCommand } from '../mutations';
import { EmptyState, KV, LoadState, Ruled, StatusPill, Summary, col, cx } from '../components';
import { ThreeStates } from '../states';
import type { PluginState, Row } from '../shell-types';
import { useSession } from '../session';
import { GitHubConnection } from './github';
import { KeysPanel } from './keys';
import { NeedsAccount, PeopleView, personName } from './people';
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
  const ready = (row: Row) => (row.status.state ?? 'ready') === 'ready';
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
          <Ruled
            label="Plugins"
            template="minmax(0, 1fr) minmax(0, 1.6fr) 120px"
            rows={unwellFirst(shell.plugins, active)}
            keyOf={(plugin) => plugin.id}
            columns={[
              col<PluginState>('id', 'Entry', (p) => <strong className="mono">{p.id}</strong>),
              col<PluginState>('name', 'Module', (p) => (
                <span className="mono faint">{p.name}</span>
              )),
              col<PluginState>('state', 'State', (p) => <StatusPill value={p.state} />),
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
        <Ruled
          label="Sidebar rows"
          template="minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr) 120px"
          rows={unwellFirst(shell.rows, ready)}
          keyOf={(row) => row.id}
          columns={[
            col<Row>('label', 'Row', (row) => <strong>{row.label}</strong>),
            col<Row>('group', 'Group', (row) => row.group),
            col<Row>('kind', 'View kind', (row) => (
              <span className="mono faint">{row.view.kind}</span>
            )),
            col<Row>('status', 'Status', (row) => (
              <StatusPill value={row.status.state ?? 'ready'} />
            )),
          ]}
        />
      </Fold>
    </div>
  );
}

/** A person's own daily limit of Fleet workers' model tokens, and what they used today. */
function DailyTokens() {
  const limit = useTool<{ tokens: number; usedToday: number }>('fleet.daily_tokens');
  const [draft, setDraft] = useState<string>();
  const save = useCommand<{ tokens: number }>({
    tool: 'fleet.daily_tokens',
    idempotent: true,
    validate: (value) => Number.isSafeInteger(value?.tokens),
    onSuccess: () => {
      setDraft(undefined);
      limit.reload();
    },
  });
  if (!limit.data) return null;
  const value = draft ?? String(limit.data.tokens);
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
        max={1_000_000_000}
        step={1}
        value={value}
        onChange={(event) => setDraft(event.target.value)}
      />
      <span className="muted">{limit.data.usedToday.toLocaleString()} used today</span>
      <button
        className="btn"
        disabled={
          save.busy ||
          !Number.isSafeInteger(tokens) ||
          tokens < 1 ||
          value === String(limit.data.tokens)
        }
      >
        Save
      </button>
      {save.error && <span role="alert">{save.error}</span>}
    </form>
  );
}

/** The signed-in session, and the one control that ends it. */
function SessionSection() {
  const { account, actor, project, signOut } = useSession();
  return (
    <div className="page-stage stack">
      <KV
        rows={[
          ['Project', project.name],
          // A directory name that is an identifier names nobody, so the row is left out.
          !!personName(actor.name) && ['Name', actor.name],
          ['Role', <StatusPill value={actor.role} />],
          account.kind === 'user' && ['Fleet tokens a day', <DailyTokens />],
        ]}
      />
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
  const compute = useTool<{
    entitled: boolean;
    allowance: {
      month_to_date: { currency: string; amount: string }[];
      cap: { currency: string; amount: string } | null;
    } | null;
  }>('compute.offers', {}, { every: 60_000 });
  const allowance =
    compute.data?.entitled && compute.data.allowance?.cap?.amount ? compute.data.allowance : null;
  if (!code && !allowance && compute.loading)
    return (
      <div className="page-stage">
        <LoadState {...compute} />
      </div>
    );
  if (!code && !allowance) return <Nothing icon="link" said="No integrations" />;
  const used = allowance?.month_to_date.find((money) => money.currency === 'USD')?.amount ?? '0';
  const month = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return (
    <div className="page-stage stack stack--lg">
      {code && <GitHubConnection />}
      {allowance && (
        <KV
          rows={[
            [
              'ML compute',
              `$${Number(used).toFixed(2)} of $${Number(allowance.cap!.amount).toFixed(0)}  ${month}`,
            ],
          ]}
        />
      )}
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
  const [cadence, setCadence] = useState(4000);
  const mounts = useTool<Mount[]>(
    row ? 'ui.read' : null,
    { rowId: row?.id ?? '' },
    { every: cadence },
  );
  const connecting = (mounts.data ?? []).some((mount) => mount.state === 'connecting');
  useEffect(() => setCadence(connecting ? 4000 : 15000), [connecting]);
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
          <Route path="plugins" element={<Plugins {...props} />} />
          <Route path="session" element={<SessionSection />} />
          <Route path="*" element={<Navigate to="." replace />} />
        </Routes>
      </div>
    </div>
  );
}
