import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { useTool } from '../api';
import { KV, LoadState, StatusPill, Table, col, cx } from '../components';
import { ThreeStates } from '../states';
import type { PluginState, Row } from '../shell-types';
import { useSession } from '../session';
import { GitHubConnection } from './github';
import { KeysPanel } from './keys';
import { PeopleView } from './people';
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

function Plugins({ shell }: ViewProps) {
  return (
    <div className="page-stage stack stack--lg">
      <section className="stack">
        <h2 className="section-title">
          Plugins · {shell.plugins.filter((plugin) => plugin.state === 'active').length} active
        </h2>
        {shell.plugins.length === 0 ? (
          <div className="empty">No plugin table</div>
        ) : (
          <Table
            rows={shell.plugins}
            keyOf={(plugin) => plugin.id}
            columns={[
              col<PluginState>('id', 'Entry', (p) => <strong className="mono">{p.id}</strong>),
              col<PluginState>('name', 'Module', (p) => (
                <span className="mono faint">{p.name}</span>
              )),
              col<PluginState>('state', 'State', (p) => <StatusPill value={p.state} />, '120px'),
            ]}
          />
        )}
      </section>
      <section className="stack">
        <h2 className="section-title">Sidebar rows</h2>
        <Table
          rows={shell.rows}
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
      </section>
    </div>
  );
}

/** The signed-in session, and the one control that ends it. */
function SessionSection() {
  const { actor, project, signOut } = useSession();
  return (
    <div className="page-stage stack">
      <h2 className="section-title">Session</h2>
      <KV
        rows={[
          ['Project', project.name],
          ['Actor', actor.name],
          ['Role', <StatusPill value={actor.role} />],
          [
            'Token',
            <button type="button" className="btn btn--sm" onClick={signOut}>
              Sign out of this tab
            </button>,
          ],
        ]}
      />
    </div>
  );
}

/** A section with nothing in it says so in one line, in the same place as its content. */
const Nothing = ({ said }: { said: string }) => (
  <div className="page-stage">
    <div className="empty-state">
      <h2>{said}</h2>
    </div>
  </div>
);

/** Machine keys, read where every other setting is; the account menu only signs out. */
function Keys() {
  const { account, project } = useSession();
  if (account.kind !== 'user') return <Nothing said="Keys belong to an account" />;
  return <KeysPanel account={account} initialProjectId={project.id} />;
}

/**
 * What this project works with outside Merv: today the one GitHub repository,
 * its connection and the access its agents have in it. The Code page draws what
 * that connection produced; everything that configures it is here.
 */
function Integrations({ shell }: ViewProps) {
  if (!shell.rows.some((row) => row.view.kind === 'code'))
    return <Nothing said="No integrations" />;
  return (
    <div className="page-stage stack stack--lg">
      <GitHubConnection />
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
  if (!row || (mounts.data && !mounts.data.length)) return <Nothing said="No connections" />;
  return (
    <div className="page-stage stack">
      <h2 className="section-title">Connections</h2>
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
  const base = props.row.path;
  return (
    <div className="split settings">
      <nav className="split-list" aria-label="Settings">
        {SECTIONS.map(([slug, label]) => {
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
        </Routes>
      </div>
    </div>
  );
}
