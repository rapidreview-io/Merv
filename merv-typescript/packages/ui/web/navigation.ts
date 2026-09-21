import type { PluginState, Row } from './shell-types';

/**
 * Sidebar navigation model. Sections express what a person is doing
 * (Research, Work, Agents, Feed), not which plugin provided a row.
 * Only rows registered through ui.shell are consumed; nothing is invented.
 * Settings rows are omitted here because the shell renders them in its
 * footer, and the built-in Overview link is likewise the shell's own.
 */
export interface NavSection {
  id: string;
  label: string;
  rows: Row[];
}

/** Known views map to user jobs; unknown views keep their declared group. */
const SECTION_OF_VIEW: Record<string, string> = {
  artifacts: 'research',
  reflections: 'work',
  sessions: 'operations',
  code: 'operations',
  feed: 'activity',
  'legacy-history': 'research',
};

/**
 * Rows the rail does not show. Every one of them is still registered and still
 * serves its record routes and its ui.read: the wave of work is one
 * Work page now, consolidation is the last phase of a reflection, the reference
 * lookup is a control on Paper, and people and connections are Settings.
 */
const HIDDEN = new Set(
  'research tasks experiments reviews consolidation knowledge people connections'.split(' '),
);

/** The one row the shell owns: the current wave of work, framed by its cycle. */
export const WORK: Row = {
  id: 'work',
  label: 'Work',
  group: 'work',
  order: 14,
  path: '/work',
  view: { kind: 'work' },
  status: {},
  readable: false,
};

/**
 * The paper stands with Home and Now rather than inside a section: it is what the
 * project is writing, not one collection among the others.
 */
export const topRows = (rows: Row[]) => rows.filter((row) => row.view.kind === 'paper');

/** An archive with nothing in it is not a place; one that reports records is. */
const shows = (row: Row) =>
  row.view.kind === 'legacy-history' ? !!row.status.count : !HIDDEN.has(row.view.kind);

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
 * Every non-settings row the rail shows lands in exactly one section, and the
 * shell's own Work row joins them wherever the work it opens is registered.
 */
export function buildNavigation(rows: Row[]): NavSection[] {
  const working = rows.some((row) => ['tasks', 'experiments'].includes(row.view.kind));
  const sorted = [...(working ? [WORK] : []), ...rows]
    .filter((row) => row.group !== 'settings' && shows(row) && row.view.kind !== 'paper')
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const sections = new Map<string, NavSection>();
  for (const row of sorted) {
    const id = SECTION_OF_VIEW[row.view.kind] ?? row.group;
    let section = sections.get(id);
    if (!section) {
      section = { id, label: SECTION_LABELS[id] ?? humanizeGroup(row.group), rows: [] };
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
 * the page's own heading, then the project, then the app — each once, so Home, whose
 * heading is the project's name, does not say it twice.
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
