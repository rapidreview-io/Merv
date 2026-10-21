import { useMemo } from 'react';
import { ConnectConsent } from './connect';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { readOnly } from './api';
import { SessionProvider, useSession } from './session';
import { Sidebar, ShellFrame, PageLede, useRailOpen, useShell } from './shell';
import type { ShellData } from './shell-types';
import { EmptyState, ErrorBoundary, LoadState, PageLoad, StatusPill } from './components';
import { Icon } from './icons';
import { MOVED, dormantOwner, humanizeGroup } from './navigation';
import { Moved, VIEW_KINDS, viewFor } from './views';
import { HomeView } from './views/home';
import { AdminApp } from './admin/app';
import { PiProvider } from './views/pi';
import { PiDock } from './views/pi-dock';

/**
 * An address nothing answers. A mistyped one is only that: a few words and the way
 * home. The page speaks of a plugin in the one case the shell can show — the
 * address opens with a view this build draws, and the plugin that registers it is
 * in the lifecycle table in some state other than active.
 */
function NotFound({ shell }: { shell: ShellData }) {
  const { pathname } = useLocation();
  const place = pathname.split('/')[1] ?? '';
  const owner = dormantOwner(pathname, VIEW_KINDS, shell.rows, shell.plugins);
  return (
    <div className="page-stage">
      <EmptyState
        page
        kind={owner ? place : undefined}
        icon={owner ? place : 'search'}
        title={owner ? `${humanizeGroup(place)} is switched off` : 'Page not found'}
        hint={
          owner && (
            <>
              <span className="mono">{owner.id}</span> <StatusPill value={owner.state} />
            </>
          )
        }
        action={
          <Link className="btn" to="/">
            <Icon name="home" />
            Home
          </Link>
        }
      />
    </div>
  );
}

/** Pages that are only verbs — the Agent's chat, a board, the settings, the sandbox console. */
const VERBS = new Set(['pi', 'boards', 'settings', 'sandboxes']);

function Workspace() {
  const read = useShell();
  // The drill-in is read-only: a page that is only verbs has no route and no row in its rail.
  const data = useMemo(
    () =>
      read.data && readOnly()
        ? { ...read.data, rows: read.data.rows.filter((row) => !VERBS.has(row.view.kind)) }
        : read.data,
    [read.data],
  );
  const shell = { ...read, data };
  const { project } = useSession();
  const { pathname, search } = useLocation();
  const [open, setOpen] = useRailOpen();
  const rows = shell.data?.rows ?? [];
  return (
    // The Agent's conversation outlives its page, and stands beside every other page in the dock.
    <PiProvider>
      {readOnly() && (
        <header className="admin-drill">
          {/* A full load: the admin is its own app, outside this project's router. */}
          <a href="/ui/admin">← Admin</a>
          <span className="admin-drill-name">{project.name}</span>
        </header>
      )}
      <ShellFrame
        name={project.name}
        open={open}
        onShow={() => setOpen(true)}
        sidebar={<Sidebar shell={shell.data} onHide={() => setOpen(false)} />}
      >
        {/* A failed refresh keeps the rows that loaded, and says so in the one line every
            stale read says it in. */}
        {shell.data && shell.error && (
          <div className="shell-stale">
            <LoadState {...shell} />
          </div>
        )}
        <PageLede rows={shell.data ? rows : []}>
          {shell.data ? (
            // A page that fails to draw says so where it stands; the next address, a new
            // `?key=` among them, tries afresh.
            <ErrorBoundary reset={pathname + search}>
              <Routes>
                {/* A project opens on Home: where it stands, what needs the reader, who is at work. */}
                <Route path="/" element={<HomeView shell={shell.data} />} />
                {/* Before the rows: the first of two equal routes is the one that answers. */}
                {Object.entries(MOVED).map(([from, to]) => (
                  <Route key={from} path={`/${from}/*`} element={<Moved to={to(rows)} />} />
                ))}
                {rows.map((row) => {
                  const View = viewFor(row.view.kind);
                  return (
                    <Route
                      key={row.id}
                      path={`${row.path}/*`}
                      element={<View row={row} shell={shell.data!} />}
                    />
                  );
                })}
                <Route path="*" element={<NotFound shell={shell.data} />} />
              </Routes>
            </ErrorBoundary>
          ) : (
            <PageLoad loading={shell.loading} error={shell.error} />
          )}
        </PageLede>
      </ShellFrame>
      {!readOnly() && <PiDock rows={rows} />}
    </PiProvider>
  );
}

export function App() {
  const { pathname } = useLocation();
  // The platform admin is an account-wide app of its own; its drill-in is this Workspace.
  const connect = /^\/connect\/([A-Za-z0-9_-]{43})$/.exec(pathname);
  const admin = !readOnly() && /^\/admin(\/|$)/.test(pathname);
  return (
    <SessionProvider key={admin ? 'admin' : 'member'} accountOnly={admin} preservePath={!!connect}>
      {admin ? <AdminApp /> : connect ? <ConnectConsent requestId={connect[1]!} /> : <Workspace />}
    </SessionProvider>
  );
}
