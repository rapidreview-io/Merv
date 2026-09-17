import type { Row } from './shell-types';

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
  claims: 'research',
  paper: 'research',
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
 * lookup is a control on Claims, and people and connections are Settings.
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
    .filter((row) => row.group !== 'settings' && shows(row))
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
