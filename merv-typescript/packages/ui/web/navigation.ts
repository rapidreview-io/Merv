import { useTool } from './api';
import type { PluginState, Row, ShellData } from './shell-types';

/**
 * Sidebar navigation model. Sections express what a person is doing
 * (Research, Work, Agents, Feed), not which plugin provided a row.
 * Only rows registered through ui.shell are consumed; nothing is invented.
 * Settings rows are omitted here because the shell renders them in its
 * footer, and Home's row is likewise the shell's own.
 */
interface NavSection {
  id: string;
  label: string;
  rows: Row[];
}

/**
 * Rows of the `lead` group stand under Home at the head of the rail, and a page the rail does
 * not show is reached from them.
 */
export const leadRows = (rows: Row[]) => rows.filter((row) => row.group === 'lead');

/**
 * Where a page the rail does not show goes back to, and where what is running opens: the lead
 * row (Work), or Home in a composition without one.
 */
export const homeOf = (rows: Row[]) => {
  const lead = leadRows(rows)[0];
  return lead ? { to: lead.path, label: lead.label } : { to: '/', label: 'Home' };
};
/** Where the records of a view kind open in this composition, if any row lists them. */
export const pathOf = (rows: readonly Pick<Row, 'path' | 'view'>[], kind: string) =>
  rows.find((row) => row.view.kind === kind)?.path;

/**
 * Places this app retired, and where their work is now. The shell answers each address itself,
 * so it goes there whether or not a plugin still registers the row.
 */
export const MOVED: Record<string, (rows: Row[]) => string> = {
  // What a project is connected to is a setting.
  connections: () => '/settings/connections',
  // What is running is drawn on the Work page, and without one Home is where the reader goes.
  running: (rows) => homeOf(rows).to,
  // What needs the reader is Home's first part.
  now: () => '/',
};

const NO_ROWS: Row[] = [];
/**
 * The rows the shell polls, for whatever on the page links to a row's records: the shell's
 * own read, shared, so asking for them costs no request of its own.
 */
export const useRows = (): Row[] =>
  useTool<ShellData>('ui.shell', {}, { every: 30000 }).data?.rows ?? NO_ROWS;

/** Rows of the `top` group stand with Home and the lead rows rather than inside a section. */
export const topRows = (rows: Row[]) => rows.filter((row) => row.group === 'top');

/**
 * Whether the rail draws a row at all, as its owner placed it. A row of the `hidden` group is
 * still registered and still serves its record routes and its ui.read: the page that absorbed
 * it reaches it.
 */
const shows = (row: Row) => row.group !== 'hidden' && (!row.whenCounted || !!row.status.count);

/**
 * The rail row an address lights: the row it stands under, and — for a page the rail does
 * not show, a record of the work or the agents and machines behind it — the lead row, where
 * it is reached from, so no page is ever nowhere.
 */
export function holds(row: Row, pathname: string, rows: Row[]): boolean {
  const under = (other: Row) => pathname === other.path || pathname.startsWith(`${other.path}/`);
  return under(row) || (row.group === 'lead' && rows.some((o) => under(o) && !shows(o)));
}

const SECTION_LABELS: Record<string, string> = {
  research: 'Research',
  work: 'Work',
  operations: 'Agents',
  activity: 'Feed',
};

const SECTION_ORDER = ['research', 'work', 'operations', 'activity'];

/** Human readable label for a group name the mapping does not know. */
export const humanizeGroup = (group: string) =>
  group
    .replaceAll(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || group;

/**
 * Build sections from registered rows. Deterministic: rows sort by the
 * server-declared order (id as tiebreaker), known sections keep a fixed
 * order, and unknown sections follow in the order their first row appears.
 * Every non-settings row the rail shows under a heading lands in exactly one section.
 */
export function buildNavigation(rows: Row[]): NavSection[] {
  const sorted = rows
    .filter((row) => !['settings', 'lead', 'top'].includes(row.group) && shows(row))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const sections = new Map<string, NavSection>();
  for (const row of sorted) {
    const id = row.group;
    let section = sections.get(id);
    if (!section) {
      section = { id, label: SECTION_LABELS[id] ?? humanizeGroup(id), rows: [] };
      sections.set(id, section);
    }
    section.rows.push(row);
  }
  const known = SECTION_ORDER.filter((id) => sections.has(id)).map(
    (id) => sections.get(id) as NavSection,
  );
  const unknown = [...sections.values()].filter((section) => !SECTION_ORDER.includes(section.id));
  return [...known, ...unknown];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A heading names the places under it. Over one place that already says the same
 * word — Feed over Feed — it names nothing, so the rail draws the row alone and
 * keeps the gap a heading would have stood in.
 */
export const headed = (section: NavSection) =>
  section.rows.length !== 1 || !same(section.rows[0]!.label, section.label);

/**
 * Who is signed in, as the lines the account row prints: the name, then the role
 * only where it says something the name did not. `Operator` over `operator` is
 * one line, and an account nobody named is known by its role alone. The role is
 * an enum, so it is written here the way a person would write it.
 */
export function accountLines(name: string | undefined, role: string): string[] {
  const held = role.replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase());
  return !name ? [held] : same(name, held) ? [name] : [name, held];
}

/**
 * What the browser's tab, its history and a screen reader's page announcement say:
 * the page's own heading, then the project, then the app — each once, so a
 * page whose heading is the project's name does not say it twice.
 */
export const documentTitle = (heading: string | undefined, project: string): string =>
  [heading?.trim(), project.trim(), 'Merv']
    .filter((part, at, all) => !!part && all.findIndex((other) => same(other ?? '', part)) === at)
    .join(' · ');

/**
 * The plugin a missing page belonged to, where the shell can show it: the address
 * opens with a view kind this build can draw, no registered row is of that kind,
 * and the lifecycle table holds that kind's UI plugin in a state other than
 * active. Any other missing address is a mistyped one, and says nothing of plugins.
 */
export function dormantOwner(
  pathname: string,
  kinds: readonly string[],
  rows: Row[],
  plugins: PluginState[],
): PluginState | undefined {
  const place = pathname.split('/')[1] ?? '';
  if (!kinds.includes(place) || rows.some((row) => row.view.kind === place)) return undefined;
  // An entry is named by whoever configured it; the module it loads is not.
  return plugins.find(
    (plugin) =>
      plugin.state !== 'active' &&
      (plugin.id === `${place}-ui` || plugin.name.endsWith(`/${place}/ui`)),
  );
}
