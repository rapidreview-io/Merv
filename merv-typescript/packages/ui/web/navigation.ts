import { createContext, useContext } from 'react';
import type { UiRowDescription, UiStateWords } from '@merv/ui/rows';
import { useTool } from './api';
import type { PluginState, ShellData } from './shell-types';

/**
 * The rail, as the owner laid it out: Home (the shell's own row) with Work, Pi and Board, then
 * Fleet and Ops. Every other row stays registered and serves its pages and records; the rail
 * does not list it.
 */
const RAIL = [
  { label: '', ids: ['work', 'pi', 'boards'] },
  { label: 'Fleet', ids: ['sessions', 'sandboxes'] },
  { label: 'Ops', ids: ['code', 'artifacts', 'settings'] },
];

/**
 * Where a page the rail does not show goes back to, and where what is running opens: the lead
 * row (Work), under Home at the head of the rail, or Home in a composition without one.
 */
export const homeOf = (rows: UiRowDescription[]) => {
  const lead = rows.find((row) => row.group === 'lead');
  return lead ? { to: lead.path, label: lead.label } : { to: '/', label: 'Home' };
};
/** Where the records of a view kind open in this composition, if any row lists them. */
export const pathOf = (rows: readonly Pick<UiRowDescription, 'path' | 'view'>[], kind: string) =>
  rows.find((row) => row.view.kind === kind)?.path;

/** The row whose page opens a record of this workflow: the row listing it, or one holding it. */
export const rowOf = <R extends Pick<UiRowDescription, 'workflow' | 'holds'>>(
  rows: readonly R[],
  workflow: string,
) => rows.find((row) => row.workflow === workflow || row.holds?.includes(workflow));

/**
 * Places this app retired, and where their work is now. The shell answers each address itself,
 * so it goes there whether or not a plugin still registers the row.
 */
export const MOVED: Record<string, (rows: UiRowDescription[]) => string> = {
  // What a project is connected to is a setting.
  connections: () => '/settings/connections',
  // What is running is drawn on the Work page, and without one Home is where the reader goes.
  running: (rows) => homeOf(rows).to,
  // What needs the reader is Home's first part.
  now: () => '/',
};

const NO_ROWS: UiRowDescription[] = [];
/** The shell's own read, shared, so asking for it costs no request of its own; none where no
 *  project's records are known. */
const useShell = () =>
  useTool<ShellData>(useContext(Records) ? 'ui.shell' : null, {}, { every: 30000 }).data;
/** The rows the shell polls, for whatever on the page links to a row's records. */
export const useRows = (): UiRowDescription[] => useShell()?.rows ?? NO_ROWS;

/**
 * Whether this page knows a project's records: false on a page with no project behind it (the
 * customer page, the platform admin), where text is drawn as written, no id is named or linked
 * and no row is read.
 */
export const Records = createContext(true);

/**
 * What a state says beyond its word, read from the deployed programs and the rows that list
 * them, never from a list of names: a state a program works in is work under way, a review gate
 * is a state left through review.submit, and the rest is in the words of the row that owns it.
 */
export interface StateWords {
  working: ReadonlySet<string>;
  gates: ReadonlySet<string>;
  said: ReadonlyMap<string, UiStateWords>;
}
const WORDS = new WeakMap<object, StateWords>();
export function stateWords(shell: Partial<Pick<ShellData, 'rows' | 'workflows'>> = {}) {
  const shapes = shell.workflows ?? [];
  const words = WORDS.get(shell) ?? {
    working: new Set(shapes.flatMap((s) => s.states.filter((at) => !s.terminal.includes(at)))),
    gates: new Set(
      shapes.flatMap((s) => s.edges.filter((e) => e.tool === 'review.submit').map((e) => e.from)),
    ),
    said: new Map((shell.rows ?? []).flatMap((row) => Object.entries(row.states ?? {}))),
  };
  WORDS.set(shell, words);
  return words;
}
/** The state words of the shell's own read, shared as its rows are. */
export const useStateWords = (): StateWords => stateWords(useShell());

const RAILED = new Set(RAIL.flatMap((section) => section.ids));

/**
 * Whether the rail draws a row at all: the layout lists it and its owner did not hide it. A row
 * the rail does not draw still serves its record routes and its ui.read.
 */
const shows = (row: UiRowDescription) => RAILED.has(row.id) && row.group !== 'hidden';

/**
 * The rail row an address lights: the row it stands under, and — for a page the rail does
 * not show, a record of the work or the agents and machines behind it — the lead row, where
 * it is reached from, so no page is ever nowhere.
 */
export function holds(row: UiRowDescription, pathname: string, rows: UiRowDescription[]): boolean {
  const under = (other: UiRowDescription) =>
    pathname === other.path || pathname.startsWith(`${other.path}/`);
  return under(row) || (row.group === 'lead' && rows.some((o) => under(o) && !shows(o)));
}

/**
 * The rail's sections in order, each with the rows it draws. The first, unheaded section is
 * always kept, because Home stands in it.
 */
export const railSections = (rows: UiRowDescription[]) =>
  RAIL.map(({ label, ids }) => ({
    label,
    rows: ids.flatMap((id) => rows.filter((row) => row.id === id && shows(row))),
  })).filter((section) => !section.label || section.rows.length > 0);

/** Human readable label for a group name, as a switched-off page names its owner. */
export const humanizeGroup = (group: string) =>
  group
    .replaceAll(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || group;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

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
  rows: UiRowDescription[],
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
