import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigationType } from 'react-router-dom';
import { useTool } from './api';
import { useSession } from './session';
import { cx } from './components';
import { buildNavigation } from './navigation';

import type { Row, ShellData } from './shell-types';
export type { RowStatus, Row, PluginState, ShellData } from './shell-types';

export const SIDEBAR_KB = /Mac|iP/.test(navigator.platform || '') ? '⌘B' : 'Ctrl+B';

export function IconSidebar() {
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
    >
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M9.5 4.5v15" />
    </svg>
  );
}

function SideLink({ row }: { row: Row }) {
  const { status } = row;
  const dot =
    status.state === 'degraded'
      ? 'degraded'
      : status.state === 'unavailable'
        ? 'unavailable'
        : null;
  return (
    <NavLink
      to={row.path}
      end={row.path === '/'}
      className={({ isActive }) => cx('sidebar-link', isActive && 'active')}
      title={status.detail}
    >
      <span className="sidebar-link-label">{row.label}</span>
      {status.count !== undefined && <span className="sidebar-link-count">{status.count}</span>}
      {dot && (
        <span className={cx('sidebar-dot', dot)} role="img" aria-label={status.detail ?? dot} />
      )}
    </NavLink>
  );
}

function useTheme() {
  const [theme, setTheme] = useState(
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );
  const apply = (next: 'light' | 'dark') => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('merv:theme', next);
    } catch {
      /* preference lives for this page only */
    }
    setTheme(next);
  };
  return { theme, toggle: () => apply(theme === 'dark' ? 'light' : 'dark') };
}

function AccountFoot() {
  const { actor, account, signOut, manageKeys } = useSession();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="account-foot" ref={ref}>
      {open && (
        <div className="account-menu" role="menu">
          <div className="account-menu-head">
            {actor.name} · {actor.role}
          </div>
          <button type="button" className="account-menu-item" onClick={toggle}>
            Theme · {theme}
          </button>
          <div className="account-menu-sep" />
          {account.kind === 'user' && (
            <button type="button" className="account-menu-item" onClick={manageKeys}>
              Manage machine keys
            </button>
          )}
          <button type="button" className="account-menu-item" onClick={signOut}>
            Sign out
          </button>
        </div>
      )}
      <button
        type="button"
        className="account-row"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="account-avatar" aria-hidden="true">
          {actor.name[0]?.toUpperCase() ?? '·'}
        </span>
        <span className="account-name" title={`${actor.name} (${actor.role})`}>
          {actor.name}
        </span>
        <span className="account-caret" aria-hidden="true">
          ▾
        </span>
      </button>
    </div>
  );
}

/** Kept for compatibility: rows grouped by their server-declared group. */
export function groupRows(rows: Row[]): { group: string; rows: Row[] }[] {
  const groups: { group: string; rows: Row[] }[] = [];
  for (const row of rows) {
    if (row.group === 'settings') continue;
    const bucket = groups.find((g) => g.group === row.group);
    if (bucket) bucket.rows.push(row);
    else groups.push({ group: row.group, rows: [row] });
  }
  return groups;
}

export function Sidebar({ shell, onHide }: { shell: ShellData | undefined; onHide(): void }) {
  const { project, account, chooseProject } = useSession();
  const { pathname } = useLocation();
  const rows = shell?.rows ?? [];
  const foot = rows.filter((row) => row.group === 'settings');
  const sections = buildNavigation(rows);
  return (
    <aside className="sidebar" aria-label="Primary">
      <div className="sidebar-util">
        <span className="sidebar-wordmark">merv</span>
        <button
          type="button"
          className="sidebar-hide"
          onClick={onHide}
          title={`Hide sidebar (${SIDEBAR_KB})`}
          aria-label="Hide sidebar"
        >
          <IconSidebar />
        </button>
      </div>
      <div className="sidebar-top">
        <div className="proj-chip" title={project.id}>
          <div className="proj-chip-body">
            <span className="proj-chip-name">{project.name}</span>
          </div>
        </div>
        {(account.kind === 'user' ||
          (account.kind === 'key' && account.key.grantScope === 'account')) && (
          <button className="btn identity-project-switch" onClick={chooseProject}>
            Change project
          </button>
        )}
      </div>
      <nav className="sidebar-nav">
        <div className="sidebar-group">
          <NavLink
            to="/"
            end
            className={({ isActive }) => cx('sidebar-link', isActive && 'active')}
          >
            <span className="sidebar-link-label">Overview</span>
          </NavLink>
        </div>
        {sections.map((section) => {
          const links = section.rows.map((row) => <SideLink key={row.id} row={row} />);
          return section.id === 'operations' || section.id === 'activity' ? (
            <details
              key={section.id}
              className="sidebar-disclosure"
              open={
                section.rows.some(
                  (row) => pathname === row.path || pathname.startsWith(`${row.path}/`),
                ) || undefined
              }
            >
              <summary className="sidebar-section">{section.label}</summary>
              {links}
            </details>
          ) : (
            <div key={section.id} className="sidebar-group">
              <div className="sidebar-section">{section.label}</div>
              {links}
            </div>
          );
        })}
        {shell && rows.length === 0 && (
          <div className="sidebar-note">
            No plugin has registered a row yet. The Overview stays available.
          </div>
        )}
      </nav>
      <div className="sidebar-foot">
        {foot.map((row) => (
          <SideLink key={row.id} row={row} />
        ))}
        <AccountFoot />
      </div>
    </aside>
  );
}

/** The shell polls its rows so a plugin appearing or disappearing shows within a few seconds. */
export function useShell() {
  return useTool<ShellData>('ui.shell', {}, { every: 4000 });
}

export function ShellFrame({
  children,
  sidebar,
  open,
  onShow,
}: {
  children: ReactNode;
  sidebar: ReactNode;
  open: boolean;
  onShow(): void;
}) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const { project } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigation = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  const topbar = useRef<HTMLElement>(null);
  const previousPath = useRef(location.pathname);
  useEffect(() => {
    setMobileOpen(false);
    if (previousPath.current !== location.pathname && navigationType !== 'POP') {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }
    previousPath.current = location.pathname;
  }, [location.pathname, navigationType]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 881px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setMobileOpen(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const panel = navigation.current;
    if (!panel) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    const background = [main.current, topbar.current].filter((node) => node !== null);
    const inert = background.map((node) => node.inert);
    background.forEach((node) => {
      node.inert = true;
    });
    document.body.style.overflow = 'hidden';
    const controls = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => node.getClientRects().length > 0 && !node.closest('[inert]'));
    const focusFirst = () => (controls()[0] ?? panel).focus();
    focusFirst();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMobileOpen(false);
      } else if (event.key === 'Tab') {
        const items = controls();
        const first = items[0];
        const last = items.at(-1);
        if (!first || !panel.contains(document.activeElement)) {
          event.preventDefault();
          focusFirst();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (!panel.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      document.body.style.overflow = overflow;
      background.forEach((node, index) => {
        node.inert = inert[index]!;
      });
      const target = opener?.isConnected && opener.getClientRects().length ? opener : main.current;
      target?.focus({ preventScroll: true });
    };
  }, [mobileOpen]);
  return (
    <div className={cx('shell', !open && 'shell--nosb', mobileOpen && 'shell--mobile-open')}>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="topbar" ref={topbar}>
        <button
          type="button"
          className="topbar-menu"
          aria-expanded={mobileOpen}
          aria-controls="primary-navigation"
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          onClick={() => setMobileOpen((v) => !v)}
        >
          <IconSidebar />
        </button>
        <span className="topbar-title" title={project.id}>
          {project.name}
        </span>
      </header>
      {/* display:contents wrapper: closes the mobile overlay on any link click. */}
      <div
        id="primary-navigation"
        ref={navigation}
        style={{ display: 'contents' }}
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen || undefined}
        aria-label={mobileOpen ? 'Navigation' : undefined}
        tabIndex={-1}
        onClickCapture={(event) => {
          // The mobile close button must not change the saved desktop preference.
          if (mobileOpen && (event.target as HTMLElement).closest('.sidebar-hide')) {
            event.stopPropagation();
            setMobileOpen(false);
          }
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) setMobileOpen(false);
        }}
      >
        {sidebar}
      </div>
      {mobileOpen && (
        <button
          type="button"
          className="nav-scrim"
          aria-label="Close navigation"
          tabIndex={-1}
          onClick={() => setMobileOpen(false)}
        />
      )}
      {!open && (
        <button
          type="button"
          className="sb-edge"
          onClick={onShow}
          title={`Show sidebar (${SIDEBAR_KB})`}
          aria-label="Show sidebar"
        >
          <span className="sb-edge-glyph">
            <IconSidebar />
          </span>
        </button>
      )}
      <main id="main-content" className="main" tabIndex={-1} ref={main}>
        {children}
      </main>
    </div>
  );
}
