import type { Row } from './shell-types';

/**
 * Sidebar navigation model. Sections express what a person is doing
 * (Research, Work, Operations, Activity), not which plugin provided a row.
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
  research: 'research',
  knowledge: 'research',
  claims: 'research',
  paper: 'research',
  tasks: 'work',
  experiments: 'work',
  reviews: 'work',
  reflections: 'work',
  consolidation: 'work',
  sessions: 'operations',
  people: 'operations',
  connections: 'operations',
  code: 'operations',
  artifacts: 'activity',
  feed: 'activity',
  activity: 'activity',
  'legacy-history': 'research',
};

const SECTION_LABELS: Record<string, string> = {
  research: 'Research',
  work: 'Work',
  operations: 'Operations',
  activity: 'Activity',
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
 * Every non-settings row lands in exactly one section.
 */
export function buildNavigation(rows: Row[]): NavSection[] {
  const sorted = rows
    .filter((row) => row.group !== 'settings')
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
