import { useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider } from './session';
import { Sidebar, ShellFrame, useShell } from './shell';
import { LoadState } from './components';
import { viewFor } from './views';
import { OverviewView } from './views/overview';

function UnavailableRoute() {
  const location = useLocation();
  return (
    <div className="page-stage">
      <div className="empty-state">
        <h2>Nothing is registered at {location.pathname}</h2>
        <p>
          The plugin that owned this view is not active. Its rows return when it is enabled again.
        </p>
      </div>
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
    <ShellFrame
      open={open}
      onShow={() => setOpen(true)}
      sidebar={<Sidebar shell={shell.data} onHide={() => setOpen(false)} />}
    >
      {shell.data && shell.error && (
        <div className="page-stage" role="alert">
          Navigation could not refresh: {shell.error.message}. Showing the last available views.
        </div>
      )}
      {shell.data ? (
        <Routes>
          <Route path="/" element={<OverviewView shell={shell.data} />} />
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
          <Route path="*" element={<UnavailableRoute />} />
        </Routes>
      ) : (
        <div className="page-stage">
          <LoadState loading={shell.loading} error={shell.error} />
          {shell.error && shell.error.code === 'unknown_tool' && (
            <p className="page-summary">
              The UI plugin's shell tool is not registered; the bundle is being served by something
              else.
            </p>
          )}
        </div>
      )}
    </ShellFrame>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Workspace />
    </SessionProvider>
  );
}
