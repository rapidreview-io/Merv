import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useProjectStore, useProjectHref, selectStats, selectSandboxes } from '../store/useProjectStore';
import { useAutorunStatus } from '../store/useAutorunStatus';
import { useTheme } from '../store/useTheme';
import { useBackdrop, setBackdrop } from '../store/useBackdrop';
import { setSurfaceOverride } from '../store/useViewport';
import ProductSwitch from './ProductSwitch';
import ProjectSwitcher from './ProjectSwitcher';
import SandboxRetentionIndicator from './SandboxRetentionIndicator';
import { getAuthEmail, isAuthEnabled, onAuthChange, signOut } from '../auth';

// Account chip: the sidebar's bottommost row, always present. Opens an upward
// menu carrying personal display controls plus sign-out when a hosted session
// exists; on localhost the account slot says so instead of hiding.
function AccountFoot() {
  const { mode: themeMode, theme, setMode: setThemeMode } = useTheme();
  const backdropOn = useBackdrop();
  const [email, setEmail] = useState(getAuthEmail());
  const [open, setOpen] = useState(false);
  const footRef = useRef(null);
  useEffect(() => onAuthChange(() => setEmail(getAuthEmail())), []);
  // Close on any press outside the chip/menu (same pattern as the project chip).
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (footRef.current && !footRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const hosted = isAuthEnabled();
  const label = email || (hosted ? 'Sign in' : 'Local session');
  return (
    <div className="account-foot" ref={footRef}>
      {open && (
        <div className="account-menu" role="menu">
          <div className="account-menu-head">{email || (hosted ? 'Not signed in' : 'Local session')}</div>
          <button type="button" className="account-menu-item" onClick={() => setSurfaceOverride('mobile')}>
            Switch to mobile
          </button>
          <button
            type="button"
            className="account-menu-item"
            onClick={() => setThemeMode(NEXT_THEME_MODE[themeMode])}
            title={`Theme follows ${themeMode === 'system' ? 'the OS' : 'your choice'} — click to switch to ${NEXT_THEME_MODE[themeMode]}`}
          >
            Theme · {themeMode === 'system' ? `auto (${theme})` : themeMode}
          </button>
          <button type="button" className="account-menu-item" onClick={() => setBackdrop(!backdropOn)}>
            Backdrop · {backdropOn ? 'on' : 'off'}
          </button>
          <div className="account-menu-sep" />
          {email ? (
            <button type="button" className="account-menu-item" onClick={() => { setOpen(false); signOut(); }}>
              Sign out
            </button>
          ) : (
            <div className="account-menu-note">
              {hosted ? 'Reload to sign in.' : 'Accounts live on the hosted app.'}
            </div>
          )}
        </div>
      )}
      <button type="button" className="account-row" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <span className="account-avatar" aria-hidden="true">{(email[0] || '·').toUpperCase()}</span>
        <span className="account-name" title={label}>{label}</span>
        <span className="account-caret" aria-hidden="true">▾</span>
      </button>
    </div>
  );
}

// Cycle order for the theme button: explicit choices first, then back to
// following the OS.
const NEXT_THEME_MODE = { light: 'dark', dark: 'system', system: 'light' };

// Platform-correct label for the sidebar toggle shortcut (also shown on the
// shell's reveal button, so exported).
export const SIDEBAR_KB = /Mac|iP/.test(navigator.platform || '') ? '⌘B' : 'Ctrl+B';

// The conventional toggle-sidebar glyph: a frame with the panel marked off.
// Same 24-grid stroke language as the mobile nav icons; used by both the
// brand-row hide button and the shell's edge-reveal.
export function IconSidebar(props) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M9.5 4.5v15" />
    </svg>
  );
}

export default function Sidebar({ onHide }) {
  const home = useProjectStore(s => s.home);
  const stats = useProjectStore(selectStats);
  const lastSyncError = useProjectStore(s => s.lastSyncError);
  const sandboxes = useProjectStore(selectSandboxes);
  const runningSandboxes = sandboxes.filter(s => s.status === 'running').length;
  const px = useProjectHref();
  const projectId = useProjectStore(s => s.projectId);
  const autorun = useAutorunStatus(projectId);

  const artifactsCount = stats.artifacts ?? home?.artifacts?.length ?? 0;

  return (
    <aside className="sidebar">
      {/* Utility row: org wordmark left, collapse control top-right
          (reference grammar). */}
      <div className="sidebar-util">
        <a className="sidebar-wordmark" href="https://rapidreview.io">rapidreview</a>
        {onHide && (
          <button
            type="button"
            className="sidebar-hide"
            onClick={onHide}
            title={`Hide sidebar (${SIDEBAR_KB})`}
            aria-label="Hide sidebar"
          ><IconSidebar /></button>
        )}
      </div>
      {/* Product switch: its own full-width row — the app's only self-branding. */}
      <ProductSwitch />
      {/* Primary-action slot under the switch: the project chip (context
          selector); the backend/UI version lives on in the sync tooltip. */}
      <div className="sidebar-top">
        <ProjectSwitcher />
      </div>

      <nav className="sidebar-nav">
        <NavLink to={px('')} end className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
          Home
        </NavLink>
        <NavLink to={px('/feed')} className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
          Feed
        </NavLink>

        {/* The epistemic core: what we know and the evidence behind it. */}
        <div className="sidebar-section">Research</div>
        <NavLink to={px('/claims')} className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
          <span>Claims</span>
          <span className="sidebar-link-count">{stats.claims ?? home?.claims?.length ?? 0}</span>
        </NavLink>
        <NavLink to={px('/experiments')} className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
          <span>Experiments</span>
          <span className="sidebar-link-count">{stats.experiments ?? home?.experiments?.length ?? 0}</span>
        </NavLink>
        <NavLink to={px('/reflection')} className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
          Reflection
        </NavLink>
        <NavLink to={px('/litreview')} className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
          Lit Review
        </NavLink>
        {/* The substrate research runs on: files, objects, machines. */}
        <div className="sidebar-section">Operations</div>

        <NavLink to={px('/artifacts')} className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
          <span>Artifacts</span>
          <span className="sidebar-link-count">{artifactsCount}</span>
        </NavLink>
        <NavLink to={px('/storage')} className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
          Storage
        </NavLink>
        <NavLink to={px('/sandboxes')} className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
          <span>Sandboxes</span>
          {runningSandboxes > 0 && (
            <span className="sidebar-link-count sidebar-link-count--live" title={`${runningSandboxes} running`}>
              <span className="sidebar-live-dot" />{runningSandboxes}
            </span>
          )}
        </NavLink>
        {/* Auto-run: same grammar as Sandboxes — the pulsing light plus how
            many runners are live right now. No live runner, no light. */}
        <NavLink
          to={px('/auto-run')}
          className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}
          title={autorun.liveRunnerCount > 0
            ? `${autorun.liveRunnerCount} live runner${autorun.liveRunnerCount === 1 ? '' : 's'} · ${autorun.running} running`
            : 'Auto-run'}
        >
          <span>Auto-run</span>
          {autorun.liveRunnerCount > 0 && (
            <span
              className="sidebar-link-count sidebar-link-count--live"
              title={`${autorun.liveRunnerCount} live runner${autorun.liveRunnerCount === 1 ? '' : 's'}`}
            >
              <span className="sidebar-live-dot" />{autorun.liveRunnerCount}
            </span>
          )}
        </NavLink>

        {/* Projects intentionally has no link here — scope switching lives in
            the project chip's popover ("Manage projects →"). */}
        <div className="sidebar-section">Activity</div>
        <NavLink to={px('/events')} className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
          Events
        </NavLink>
        <NavLink to={px('/activity')} className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
          Traffic &amp; Tool I/O
        </NavLink>
      </nav>

      <div className="sidebar-foot">
        <SandboxRetentionIndicator />
        {lastSyncError && <div className="error-message" style={{ fontSize: 11 }}>{lastSyncError}</div>}
        <NavLink to={px('/settings')} className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}>
          Settings
        </NavLink>
        <AccountFoot />
      </div>
    </aside>
  );
}
