import { useEffect, useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { useProjectStore, useProjectHref, selectStats, selectSandboxes } from '../store/useProjectStore';
import { useAutorunStatus } from '../store/useAutorunStatus';
import { NEXT_THEME_MODE, useTheme } from '../store/useTheme';
import ProjectSwitcher from '../components/ProjectSwitcher';
import SyncChip from '../components/SyncChip';
import { setSurfaceOverride } from '../store/useViewport';
import BottomSheet from './BottomSheet';
import ToastHost from './Toast';
import { usePullToRefresh } from './usePullToRefresh';
import { IconFeed, IconHome, IconExperiments, IconActivity, IconMore } from './icons';

/**
 * Mobile app shell: top bar (project · freshness · theme), pull-to-refresh,
 * routed content, 5-tab bottom nav, and a More sheet hosting everything that
 * lives in the desktop sidebar. While mounted it tags <html
 * data-surface="mobile"> so mobile.css applies — desktop styling is untouched
 * by construction.
 */
export default function MobileShell({ children, onRefresh }) {
  const location = useLocation();
  const home = useProjectStore(s => s.home);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { distance, refreshing } = usePullToRefresh(onRefresh);
  const px = useProjectHref();
  useEffect(() => {
    document.documentElement.dataset.surface = 'mobile';
    return () => { delete document.documentElement.dataset.surface; };
  }, []);

  // Any navigation closes the sheet.
  useEffect(() => { setSheetOpen(false); }, [location.pathname]);

  const projectName = home?.project?.name || 'Merv';

  return (
    <div className="mshell">
      <header className="mbar">
        <div className="mbar-title">{projectName}</div>
        <SyncChip className="mbar-sync" />
        <ThemeButton />
      </header>

      {(distance > 0 || refreshing) && (
        <div className="mptr" style={{ height: refreshing ? 44 : distance }} aria-hidden="true">
          <span className={`mptr-icon${refreshing ? ' is-spinning' : ''}`}>↻</span>
        </div>
      )}

      <main className="mshell-main">{children}</main>

      <nav className="mnav" aria-label="Primary">
        <NavLink to={px('')} end className={({ isActive }) => 'mnav-tab' + (isActive ? ' active' : '')}>
          <IconHome className="mnav-glyph" />
          Home
        </NavLink>
        <NavLink to={px('/feed')} className={({ isActive }) => 'mnav-tab' + (isActive ? ' active' : '')}>
          <IconFeed className="mnav-glyph" />
          Feed
        </NavLink>
        <NavLink to={px('/experiments')} className={({ isActive }) => 'mnav-tab' + (isActive ? ' active' : '')}>
          <IconExperiments className="mnav-glyph" />
          Exps
        </NavLink>
        <NavLink to={px('/sandboxes')} className={({ isActive }) => 'mnav-tab' + (isActive ? ' active' : '')}>
          <IconActivity className="mnav-glyph" />
          Sandboxes
        </NavLink>
        <button
          type="button"
          className={'mnav-tab' + (sheetOpen ? ' active' : '')}
          onClick={() => setSheetOpen(v => !v)}
          aria-expanded={sheetOpen}
        >
          <IconMore className="mnav-glyph" />
          More
        </button>
      </nav>

      <MoreSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
      <ToastHost />
    </div>
  );
}

function ThemeButton() {
  const { mode, theme, setMode } = useTheme();
  return (
    <button
      type="button"
      className="mbar-btn"
      onClick={() => setMode(NEXT_THEME_MODE[mode])}
      aria-label={`Theme: ${mode}. Tap to switch.`}
    >
      <span aria-hidden="true">{theme === 'dark' ? '◑' : '◐'}</span>
    </button>
  );
}

function MoreSheet({ open, onClose }) {
  const stats = useProjectStore(selectStats);
  const home = useProjectStore(s => s.home);
  const lastSyncError = useProjectStore(s => s.lastSyncError);
  const sandboxes = useProjectStore(selectSandboxes);
  const runningSandboxes = sandboxes.filter(s => s.status === 'running').length;
  const px = useProjectHref();
  const projectId = useProjectStore(s => s.projectId);
  const autorun = useAutorunStatus(projectId);

  const footer = (
    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSurfaceOverride('desktop')}>
      Use desktop layout
    </button>
  );

  return (
    <BottomSheet open={open} onClose={onClose} label="More" footer={footer}>
      <ProjectSwitcher />

      <div className="msheet-section">Browse</div>
      <SheetLink to={px('/claims')} label="Claims" count={stats.claims ?? home?.claims?.length ?? 0} />
      <SheetLink to={px('/reviews')} label="Reviews" count={stats.open_reviews ?? stats.reviews ?? 0} />
      <SheetLink to={px('/litreview')} label="Lit Review" />
      <SheetLink to={px('/reflection')} label="Reflection" />
      <SheetLink to={px('/artifacts')} label="Artifacts" count={stats.artifacts ?? 0} />
      <SheetLink to={px('/storage')} label="Storage" />
      <SheetLink to={px('/sandboxes')} label="Sandboxes" count={runningSandboxes ? `${runningSandboxes} running` : null} />
      <SheetLink to={px('/auto-run')} label="Auto-run" count={autorun.running ? `${autorun.running} running` : null} />
      <SheetLink to={px('/settings')} label="Settings" />
      <SheetLink to="/projects" label="Projects" />

      <div className="msheet-section">Forensics</div>
      <SheetLink to={px('/events')} label="Events" />
      <SheetLink to={px('/activity')} label="Traffic & Tool I/O" />

      {lastSyncError && (
        <div className="error-message" style={{ marginTop: 10, fontSize: 11 }}>{lastSyncError}</div>
      )}
    </BottomSheet>
  );
}

function SheetLink({ to, label, count = null, note = null }) {
  return (
    <Link to={to} className="msheet-link">
      <span>{label}</span>
      <span className="msheet-count">
        {note && <span className="msheet-link-note">{note} </span>}
        {count != null && count !== 0 ? count : ''}
      </span>
    </Link>
  );
}
