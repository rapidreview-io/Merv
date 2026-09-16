import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigationType } from 'react-router-dom';
import { useTool } from './api';
import { useSession } from './session';
import { cx, kindOf, kindStyle } from './components';
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

function IconSwitch() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9h15l-4-4M20 15H5l4 4" />
    </svg>
  );
}

const unwell = (row: Row) =>
  row.status.state === 'degraded' || row.status.state === 'unavailable' ? row : undefined;

/**
 * One place in the rail: the colour of the first kind behind it as a dot and,
 * when it is the place you are in, as the bar at its left edge. A second dot
 * appears only when something behind it is unwell.
 */
function RailRow({
  to,
  label,
  kind,
  active,
  sick,
}: {
  to: string;
  label: string;
  kind: string;
  active: boolean;
  sick?: Row;
}) {
  return (
    <Link
      to={to}
      className={cx('rail-row', active && 'active')}
      style={kindStyle(kind)}
      title={sick?.status.detail}
    >
      <span className="rail-kind" aria-hidden="true" />
      <span className="rail-row-label">{label}</span>
      {sick && (
        <span
          className={cx('rail-dot', sick.status.state)}
          role="img"
          aria-label={sick.status.detail ?? sick.status.state}
        />
      )}
    </Link>
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

export function Sidebar({ shell, onHide }: { shell: ShellData | undefined; onHide(): void }) {
  const { project, account, chooseProject } = useSession();
  const { pathname } = useLocation();
  const rows = shell?.rows ?? [];
  const holds = (row: Row) => pathname === row.path || pathname.startsWith(`${row.path}/`);
  return (
    <aside className="sidebar" aria-label="Primary">
      <div className="rail-util">
        <span className="rail-wordmark">merv</span>
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
      <div className="rail-project">
        <NavLink
          to="/"
          end
          className={({ isActive }) => cx('rail-row', 'rail-project-name', isActive && 'active')}
          title={project.id}
        >
          {project.name}
        </NavLink>
        {(account.kind === 'user' ||
          (account.kind === 'key' && account.key.grantScope === 'account')) && (
          <button
            type="button"
            className="rail-switch"
            onClick={chooseProject}
            title="Switch project"
            aria-label="Switch project"
          >
            <IconSwitch />
          </button>
        )}
      </div>
      <nav className="rail-nav">
        {buildNavigation(rows).map((section) => (
          <RailRow
            key={section.id}
            to={section.rows[0]!.path}
            label={section.label}
            kind={section.rows[0]!.view.kind}
            active={section.rows.some(holds)}
            sick={section.rows.find(unwell)}
          />
        ))}
      </nav>
      <div className="sidebar-foot">
        {rows
          .filter((row) => row.group === 'settings')
          .map((row) => (
            <RailRow
              key={row.id}
              to={row.path}
              label={row.label}
              kind={row.view.kind}
              active={holds(row)}
              sick={unwell(row)}
            />
          ))}
        <AccountFoot />
      </div>
    </aside>
  );
}

/**
 * The page header the shell owns. On a row's index route it names the section,
 * then the section's rows with the current one in ink; views render no title there.
 */
export function TitleLine({ rows }: { rows: Row[] }) {
  const { pathname } = useLocation();
  const current = pathname === '/' ? undefined : rows.find((row) => row.path === pathname);
  if (!current) return null;
  const section = buildNavigation(rows).find((entry) => entry.rows.includes(current));
  const line = section?.rows ?? [current];
  return (
    <header className="page-lede">
      {section && line.length > 1 && <div className="lede-eyebrow">{section.label}</div>}
      <h1 className="lede-line">
        {line.map((row, index) => (
          <Fragment key={row.id}>
            {/* Real spaces around the dot: they are the line's only wrap points. */}
            {index > 0 && <span className="lede-sep">{' · '}</span>}
            {row === current ? (
              <span className="lede-here">
                {kindOf(row.view.kind).icon && (
                  <span className="lede-icon" aria-hidden="true">
                    {kindOf(row.view.kind).icon}
                  </span>
                )}
                {row.label}
              </span>
            ) : (
              <Link className="lede-other" to={row.path}>
                {row.label}
              </Link>
            )}
            {row.status.count ? <span className="lede-count">{row.status.count}</span> : null}
          </Fragment>
        ))}
      </h1>
    </header>
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
