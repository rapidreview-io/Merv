import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider } from './session';
import { Sidebar, ShellFrame, PageLede, useShell, type ShellData } from './shell';
import { EmptyState, LoadState, StatusPill } from './components';
import { Icon } from './icons';
import { MOVED, dormantOwner, humanizeGroup } from './navigation';
import { Moved, VIEW_KINDS, viewFor } from './views';
import { HomeView } from './views/home';
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

function Workspace() {
  const shell = useShell();
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('merv:sidebar') !== 'closed';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('merv:sidebar', open ? 'open' : 'closed');
    } catch {
      /* ignore */
    }
  }, [open]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const rows = shell.data?.rows ?? [];
  return (
    // The Agent's conversation outlives its page, and stands beside every other page in the dock.
    <PiProvider>
      <ShellFrame
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
          ) : (
            <div className="page-stage">
              <LoadState loading={shell.loading} error={shell.error} />
            </div>
          )}
        </PageLede>
      </ShellFrame>
      <PiDock rows={rows} />
    </PiProvider>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Workspace />
    </SessionProvider>
  );
}
