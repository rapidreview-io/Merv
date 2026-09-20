import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigationType } from 'react-router-dom';
import { useTool } from './api';
import { useSession } from './session';
import { cx } from './components';
import { ChevronsIcon, RowIcon, SidebarIcon, SwitchIcon } from './icons';
import { signedInEmail } from './auth';
import { initials, personName } from './views/people';
import { accountLines, buildNavigation, documentTitle, headed, topRows } from './navigation';
import { stepped } from './record-picker';
import { standingOf } from './views/overview';
import { useHome } from './views/map-data';

import type { Row, ShellData } from './shell-types';
export type { RowStatus, Row, PluginState, ShellData, WorkflowShape } from './shell-types';

export const SIDEBAR_KB = /Mac|iP/.test(navigator.platform || '') ? '⌘B' : 'Ctrl+B';

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
  const counted = count !== undefined && count > 0;
  return (
    <Link
      to={to}
      className={cx('rail-row', active && 'active')}
      aria-current={active ? 'page' : undefined}
      // A bare number beside a word is heard as one token; the count says what it counts.
      aria-label={counted ? `${label}, ${count} ${count === 1 ? 'needs' : 'need'} you` : undefined}
      title={sick?.status.detail}
    >
      <RowIcon name={icon} />
      <span className="rail-row-label">{label}</span>
      {counted && <span className="rail-count">{count}</span>}
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
  return standingOf(rows, home.data, actor, () => undefined).yours.length;
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
  const { actor, signOut } = useSession();
  // A person is named, never identified: a directory name that is an id names nobody.
  const who = personName(actor.name) ?? signedInEmail();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLButtonElement>(null);
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  // It says it is a menu, so it is operated as one: the cursor goes to its first item
  // as it opens, the arrows and Home and End move between the items, Escape gives the
  // cursor back to the row, and Tab or a click elsewhere leaves and shuts it.
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        row.current?.focus();
      } else if (event.key === 'Tab') setOpen(false);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const all = items();
        const at = stepped(
          all.indexOf(document.activeElement as HTMLElement),
          all.length,
          event.key,
        );
        all[at]?.focus();
        event.preventDefault();
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  // The role is a second line only where it says something the name did not.
  const [name, role] = accountLines(who, actor.role);
  const said = [name, role].filter(Boolean).join(' · ');
  return (
    <div className="account-foot" ref={ref}>
      {/* The whole row is the control: the avatar, the name and the caret are its face. */}
      <button
        type="button"
        ref={row}
        className="account-row"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${said}`}
        title={said}
      >
        <span className="account-avatar" aria-hidden="true">
          {initials(who)}
        </span>
        <span className="account-who">
          <span className="account-name">{name}</span>
          {role && <span className="account-role">{role}</span>}
        </span>
        <ChevronsIcon className="account-caret" />
      </button>
      {open && (
        // The row it opens from already says whose menu this is, so the menu does not.
        // It is drawn over the row and written after it, so the keyboard meets them in order.
        <div className="account-menu" role="menu" aria-label="Account">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="account-menu-item"
            onClick={toggle}
          >
            Theme · {theme}
          </button>
          <div className="account-menu-sep" role="separator" />
          {/* Keys are a setting, and live under Settings › Keys with the rest. */}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="account-menu-item"
            onClick={signOut}
          >
            Sign out
          </button>
        </div>
      )}
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
          <SidebarIcon size={18} />
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
            <SwitchIcon />
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
          <div className="rail-group" key={section.id} role="group" aria-label={section.label}>
            {headed(section) && <h3 className="rail-group-head">{section.label}</h3>}
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

/** Settings is one place with rooms, not a list with records: every room is still Settings. */
const roomy = (row: Row) => row.view.kind === 'settings';

/**
 * The page header the shell owns: the collection you are in, and nothing to
 * click. Navigation is the rail's job alone now, so no eyebrow and no siblings.
 * A record's page names itself, so the line stands on a row's index route alone —
 * and over every room of a place that has rooms.
 */
export function TitleLine({ rows }: { rows: Row[] }) {
  const { pathname } = useLocation();
  const current =
    pathname === '/'
      ? undefined
      : rows.find(
          (row) => row.path === pathname || (roomy(row) && pathname.startsWith(`${row.path}/`)),
        );
  if (!current) return null;
  return (
    <header className="page-lede">
      <h1 className="lede-line">
        <span className="lede-here">{current.label}</span>
        {/* A counted row says its total, a measured zero included; a row that
            reports none says nothing rather than drawing a slot it cannot fill. The
            space is a real one, so the name and the number are heard as two words. */}
        {current.status.count === undefined ? null : (
          <>
            {' '}
            <span className="lede-count">{current.status.count}</span>
          </>
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
  // Hiding the rail takes its hide button off the page, and showing it takes the edge
  // button away: the cursor crosses to the control that undoes what was just done,
  // rather than falling back to the top of the document.
  const edge = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    const held = document.activeElement;
    if (held && held !== document.body && !navigation.current?.contains(held)) return;
    if (open) navigation.current?.querySelector<HTMLElement>('.sidebar-hide')?.focus();
    else edge.current?.focus();
  }, [open]);
  // The document is titled by the page's own h1, whoever draws it and whenever its
  // record arrives: a view never has to say its name a second time for the tab.
  useEffect(() => {
    const page = main.current;
    if (!page) return;
    const name = () => {
      const heading = page.querySelector('h1');
      const said = (heading?.querySelector('.lede-here') ?? heading)?.textContent ?? undefined;
      const title = documentTitle(said, project.name);
      if (document.title !== title) document.title = title;
    };
    const watch = new MutationObserver(name);
    watch.observe(page, { subtree: true, childList: true, characterData: true });
    name();
    return () => watch.disconnect();
  }, [project.name]);
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
          <SidebarIcon size={18} />
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
          ref={edge}
          className="sb-edge"
          onClick={onShow}
          title={`Show sidebar (${SIDEBAR_KB})`}
          aria-label="Show sidebar"
        >
          <span className="sb-edge-glyph">
            <SidebarIcon size={18} />
          </span>
        </button>
      )}
      <main id="main-content" className="main" tabIndex={-1} ref={main}>
        {children}
      </main>
    </div>
  );
}
