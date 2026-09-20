import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider } from './session';
import { Sidebar, ShellFrame, TitleLine, useShell, type ShellData } from './shell';
import { EmptyState, LoadState, StatusPill } from './components';
import { Icon } from './icons';
import { dormantOwner, humanizeGroup } from './navigation';
import { VIEW_KINDS, viewFor } from './views';
import { MapView } from './views/map';
import { OverviewView } from './views/overview';
import { WorkView } from './views/work';

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
    <>
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
        {shell.data && <TitleLine rows={rows} />}
        {shell.data ? (
          <Routes>
            {/* The map is the home; the standing line it summarises stays one click away. */}
            <Route path="/" element={<MapView shell={shell.data} />} />
            <Route path="/now" element={<OverviewView shell={shell.data} />} />
            {/* The wave of work is the shell's own page: no one plugin owns it. */}
            <Route path="/work" element={<WorkView shell={shell.data} />} />
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
      </ShellFrame>
    </>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Workspace />
    </SessionProvider>
  );
}
