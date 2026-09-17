import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigationType } from 'react-router-dom';
import { useTool } from './api';
import { useSession } from './session';
import { cx, kindOf } from './components';
import { RowIcon } from './icons';
import { signedInEmail } from './auth';
import { personName } from './views/people';
import { buildNavigation, topRows } from './navigation';
import { standingOf } from './views/overview';
import { useHome } from './views/map-data';

import type { Row, ShellData } from './shell-types';
export type { RowStatus, Row, PluginState, ShellData } from './shell-types';

export const SIDEBAR_KB = /Mac|iP/.test(navigator.platform || '') ? '⌘B' : 'Ctrl+B';

/** One frame for every glyph the shell draws: the same stroked 24-unit grid. */
const Icon = ({ size = 18, children }: { size?: number; children: ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);
export const IconSidebar = () => (
  <Icon>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
    <path d="M9.5 4.5v15" />
  </Icon>
);
const IconSwitch = () => (
  <Icon size={16}>
    <path d="M4 9h15l-4-4M20 15H5l4 4" />
  </Icon>
);

/** A row published by a remote service names its own glyph; every other row is its view kind. */
const iconOf = (row: Row) => (typeof row.view.icon === 'string' ? row.view.icon : row.view.kind);

const unwell = (row: Row) =>
  row.status.state === 'degraded' || row.status.state === 'unavailable' ? row : undefined;

/**
 * One destination in the rail: a thin line glyph, its label, and, on the ground
 * pill, the place you are in. Only Now carries a count; a second dot appears
 * only when the row behind it is unwell.
 */
function RailRow({
  to,
  label,
  icon,
  active,
  count,
  sick,
}: {
  to: string;
  label: string;
  icon: string;
  active: boolean;
  count?: number;
  sick?: Row;
}) {
  return (
    <Link to={to} className={cx('rail-row', active && 'active')} title={sick?.status.detail}>
      <RowIcon name={icon} />
      <span className="rail-row-label">{label}</span>
      {count !== undefined && count > 0 && <span className="rail-count">{count}</span>}
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

/**
 * The rail's one number: how many open records are the signed-in actor's move,
 * read exactly as the pages read it, from the one home the whole page shares.
 * Reviewer names are not needed for a count, so none are looked up.
 */
function useNeedsYou(rows: Row[]): number {
  const { actor } = useSession();
  const home = useHome();
  return standingOf(rows, home.data, actor.id, () => undefined).yours.length;
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

/** Up to two initials for the avatar; a name that yields none keeps the dot. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('') || '·';

function AccountFoot() {
  const { actor, signOut } = useSession();
  // A person is named, never identified: a directory name that is an id names nobody.
  const who = personName(actor.name) ?? signedInEmail();
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
          <div className="account-menu-head">{[who, actor.role].filter(Boolean).join(' · ')}</div>
          <button type="button" className="account-menu-item" onClick={toggle}>
            Theme · {theme}
          </button>
          <div className="account-menu-sep" />
          {/* Keys are a setting, and live under Settings › Keys with the rest. */}
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
          {initials(who ?? '')}
        </span>
        <span className="account-who" title={[who, actor.role].filter(Boolean).join(' · ')}>
          {who && <span className="account-name">{who}</span>}
          <span className="account-role">{actor.role}</span>
        </span>
        <span className="account-caret" aria-hidden="true">
          ▾
        </span>
      </button>
    </div>
  );
}

/**
 * The one navigation. Home, Now and the paper first, then every other registered
 * collection as its own row under the heading of the section it belongs to, then
 * Settings and the account at the foot. Nothing is hidden behind a row or a title.
 */
export function Sidebar({ shell, onHide }: { shell: ShellData | undefined; onHide(): void }) {
  const { project, account, chooseProject } = useSession();
  const { pathname } = useLocation();
  const rows = shell?.rows ?? [];
  const needsYou = useNeedsYou(rows);
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
        <h2 className="rail-project-name">{project.name}</h2>
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
        <RailRow to="/" icon="home" label="Home" active={pathname === '/'} />
        <RailRow to="/now" icon="now" label="Now" active={pathname === '/now'} count={needsYou} />
        {topRows(rows).map((row) => (
          <RailRow
            key={row.id}
            to={row.path}
            label={row.label}
            icon={iconOf(row)}
            active={holds(row)}
            sick={unwell(row)}
          />
        ))}
        {buildNavigation(rows).map((section) => (
          <div className="rail-group" key={section.id}>
            <h3 className="rail-group-head">{section.label}</h3>
            {section.rows.map((row) => (
              <RailRow
                key={row.id}
                to={row.path}
                label={row.label}
                icon={iconOf(row)}
                active={holds(row)}
                sick={unwell(row)}
              />
            ))}
          </div>
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
              icon={iconOf(row)}
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
 * The page header the shell owns: the collection you are in, and nothing to
 * click. Navigation is the rail's job alone now, so no eyebrow and no siblings.
 */
export function TitleLine({ rows }: { rows: Row[] }) {
  const { pathname } = useLocation();
  const current = pathname === '/' ? undefined : rows.find((row) => row.path === pathname);
  if (!current) return null;
  return (
    <header className="page-lede">
      <h1 className="lede-line">
        <span className="lede-here">{current.label}</span>
        {/* A counted row says its total, a measured zero included; a row that
            reports none says nothing rather than drawing a slot it cannot fill. */}
        {current.status.count === undefined ? null : (
          <span className="lede-count">{current.status.count}</span>
        )}
      </h1>
    </header>
  );
}

/** The shell polls its rows so a plugin appearing or disappearing shows within a few seconds. */
export function useShell() {
  return useTool<ShellData>('ui.shell', {}, { every: 30000 });
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
          // A link leaves.
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
