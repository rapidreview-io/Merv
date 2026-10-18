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

export function AdminApp() {
  const [open, setOpen] = useRailOpen();
  const { pathname } = useLocation();
  const session = useAccount();
  // The last place the address is in: a standalone experiment is opened from Work, so Work holds it.
  const here = PLACES.filter((place) => pathname.startsWith(place.to)).at(-1);
  return (
    <ShellFrame
      name="Admin"
      open={open}
      onShow={() => setOpen(true)}
      sidebar={
        <aside className="sidebar admin-rail" aria-label="Primary">
          <RailHead onHide={() => setOpen(false)} />
          <nav className="rail-nav">
            {PLACES.map((place) => (
              <RailRow key={place.to} {...place} active={place === here} />
            ))}
          </nav>
          <div className="sidebar-foot">
            {session && (
              <AccountMenu who={signedInEmail()} role="admin" signOut={session.signOut} />
            )}
          </div>
        </aside>
      }
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
