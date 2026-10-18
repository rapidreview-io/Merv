/**
 * The platform admin (/ui/admin): the operator's own app beside the projects, with no project
 * selected. Three places — the work running anywhere, the credit each person holds, and which
 * credential serves what — and a record of any project opened read-only in the drill-in
 * (/ui/admin/p/<project>/…, the member Workspace in platform mode; see app.tsx).
 */
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { signedInEmail } from '../auth';
import { ErrorBoundary } from '../components';
import { useAccount } from '../session';
import { AccountMenu, RailHead, RailRow, ShellFrame, useRailOpen } from '../shell';
import { CredentialsView } from './credentials';
import { CreditsView } from './credits';
import { StandaloneView } from './standalone';
import { WorkView } from './work';

const PLACES = [
  { to: '/admin', label: 'Work', icon: 'work' },
  { to: '/admin/credits', label: 'Credits', icon: 'spend' },
  { to: '/admin/credentials', label: 'Credentials', icon: 'key' },
];

function Rail({ onHide }: { onHide(): void }) {
  const { pathname } = useLocation();
  const session = useAccount();
  // A standalone experiment is opened from Work, so Work holds it.
  const here = (to: string) =>
    to === '/admin'
      ? !PLACES.some((p) => p.to !== to && pathname.startsWith(p.to))
      : pathname.startsWith(to);
  return (
    <aside className="sidebar admin-rail" aria-label="Primary">
      <RailHead onHide={onHide} />
      <nav className="rail-nav">
        {PLACES.map((place) => (
          <RailRow key={place.to} {...place} active={here(place.to)} />
        ))}
      </nav>
      <div className="sidebar-foot">
        {session && <AccountMenu who={signedInEmail()} role="admin" signOut={session.signOut} />}
      </div>
    </aside>
  );
}

export function AdminApp() {
  const [open, setOpen] = useRailOpen();
  const { pathname } = useLocation();
  return (
    <ShellFrame
      name="Admin"
      open={open}
      onShow={() => setOpen(true)}
      sidebar={<Rail onHide={() => setOpen(false)} />}
    >
      <ErrorBoundary reset={pathname}>
        <Routes>
          <Route path="/admin" element={<WorkView />} />
          <Route path="/admin/credits" element={<CreditsView />} />
          <Route path="/admin/credentials" element={<CredentialsView />} />
          <Route path="/admin/standalone/:id" element={<StandaloneView />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </ErrorBoundary>
    </ShellFrame>
  );
}
